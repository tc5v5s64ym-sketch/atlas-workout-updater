'use strict';

// ── Session_Plans reader/fold (Decision Desk #952, Option A — PR-C) ────────────
//
// Folds the append-only Session_Plans event ROWS (as sheets.getSheetRows returns
// them — header stripped) into a per-session planned-vs-completed history in the
// exact shape detectDrift's `plannedVsCompleted` argument expects:
//   [{ date:'YYYY-MM-DD'|null, planned:string[], completed:string[] }]  (newest LAST)
//
// PURE: no Sheets I/O — the live capture read + drift wiring are a later slice; this
// module only folds rows it is given, so it stays testable and unwired for now.
//
// Contract (owner):
//   - Fold by (session_id + plan_version + plan_item_id), LAST-WINS: the latest
//     item_outcome for an item decides its final outcome; the latest session_closeout
//     decides the session's closeout_status.
//   - COMPLETION IS DERIVED FROM ITEM OUTCOMES, never from closeout_status. `completed`
//     lists the lift actually PERFORMED: the planned code for a `completed` item, the
//     performed code for a `substituted` item; a `skipped` or still-`planned` item
//     contributes nothing (it was planned-but-not-performed).
//   - Supports finalized / abandoned / partial / substituted / skipped / still-open.
//   - FAIL CLOSED: a malformed event, or two rows sharing an idempotency_key with
//     different content (a corruption the writer's guard prevents but a hand-edit
//     could introduce), marks that whole session `status:'error'` and EXCLUDES it from
//     the drift-shaped output — a corrupt session must never feed a (challenge) signal.
//   - DEDUP: identical duplicate idempotency_key rows collapse (the #958-review
//     authoritative-dedup carry-over) so a doubled write is invisible downstream.

const { sessionPlansColumns } = require('../config/columns');
const { EVENT_TYPES, ITEM_OUTCOMES, CLOSEOUT_STATUSES } = require('./sessionPlanEvents');

const IDX = Object.fromEntries(sessionPlansColumns.map((c, i) => [c, i]));
// Composite-key delimiter for (session_id, plan_version). A NUL can never appear in
// those cells, so it is collision-proof — written as an EXPLICIT ESCAPE (never a
// literal control byte) so the source stays plain UTF-8.
const SEP = '\x00';
const _skey = (sid, ver) => `${sid}${SEP}${ver}`;

// Parse a raw sheet row into a typed event, or flag it malformed. Structural
// validation only — the vocab must match the frozen contract.
function _parseRow(row) {
  if (!Array.isArray(row)) return { malformed: true, sid: null, ver: null };
  const get = (c) => String(row[IDX[c]] == null ? '' : row[IDX[c]]).trim();
  // Read identity FIRST (session_id/plan_version are early columns) so a row
  // truncated AFTER its identity columns is still ATTRIBUTED to its session and
  // marked malformed — otherwise that session would fail OPEN (silently skipped)
  // instead of fail closed (status:'error'). (#959 review.)
  const sid = get('session_id') || null;
  const ver = get('plan_version') || null;
  if (row.length < sessionPlansColumns.length) return { malformed: true, sid, ver };
  const e = {
    idempotency_key: get('idempotency_key'),
    session_id: get('session_id'),
    session_date: get('session_date') || null,
    plan_version: get('plan_version'),
    event_type: get('event_type'),
    plan_item_id: get('plan_item_id'),
    planned_order: get('planned_order'),
    planned_lift_code: get('planned_lift_code'),
    movement_pattern: get('movement_pattern'),
    outcome: get('outcome'),
    performed_lift_code: get('performed_lift_code'),
    closeout_status: get('closeout_status'),
  };
  const bad = () => ({ malformed: true, sid: e.session_id || null, ver: e.plan_version || null });
  if (!e.idempotency_key || !e.session_id || !e.plan_version) return bad();
  if (!EVENT_TYPES.includes(e.event_type)) return bad();
  if (e.event_type === 'plan_accepted') {
    if (!e.plan_item_id || e.outcome !== 'planned' || !e.planned_lift_code) return bad();
  } else if (e.event_type === 'item_outcome') {
    if (!e.plan_item_id || !ITEM_OUTCOMES.includes(e.outcome)) return bad();
    if (e.outcome === 'substituted' && !e.performed_lift_code) return bad();
  } else { // session_closeout
    if (!CLOSEOUT_STATUSES.includes(e.closeout_status)) return bad();
  }
  return { malformed: false, event: e };
}

// Two events with the same idempotency_key must have identical content (the key
// hashes the identity fields; the non-key fields must also match or the row is
// corrupt). Compares every parsed field (recorded_at is not parsed, so it can't
// cause a false conflict).
function _contentSame(a, b) {
  return Object.keys(a).every(k => String(a[k] == null ? '' : a[k]) === String(b[k] == null ? '' : b[k]));
}

function foldSessionPlans(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const errorSessions = new Set();
  const byKey = new Map();     // idempotency_key -> event (dedup)
  const order = [];            // unique events, in row order (append order = chronological)

  for (const row of list) {
    const p = _parseRow(row);
    if (p.malformed) {
      if (p.sid && p.ver) errorSessions.add(_skey(p.sid, p.ver)); // attribute when identifiable
      continue;
    }
    const e = p.event;
    if (byKey.has(e.idempotency_key)) {
      if (!_contentSame(byKey.get(e.idempotency_key), e)) errorSessions.add(_skey(e.session_id, e.plan_version));
      continue; // identical duplicate -> collapse
    }
    byKey.set(e.idempotency_key, e);
    order.push(e);
  }

  const sessions = new Map(); // skey -> { session_id, plan_version, date, closeout_status, items:Map }
  for (const e of order) {
    const sk = _skey(e.session_id, e.plan_version);
    if (!sessions.has(sk)) sessions.set(sk, { session_id: e.session_id, plan_version: e.plan_version, date: e.session_date, closeout_status: null, items: new Map() });
    const sess = sessions.get(sk);
    if (e.session_date && !sess.date) sess.date = e.session_date;
    if (e.event_type === 'session_closeout') { sess.closeout_status = e.closeout_status; continue; } // last-wins
    const cur = sess.items.get(e.plan_item_id) || { plan_item_id: e.plan_item_id, planned_lift_code: null, movement_pattern: null, outcome: 'planned', performed_lift_code: null };
    if (e.event_type === 'plan_accepted') {
      cur.planned_lift_code = e.planned_lift_code;
      cur.movement_pattern = e.movement_pattern || null;
    } else { // item_outcome — last one in order wins
      cur.outcome = e.outcome;
      cur.performed_lift_code = e.outcome === 'substituted' ? e.performed_lift_code : null;
      if (e.planned_lift_code && !cur.planned_lift_code) cur.planned_lift_code = e.planned_lift_code;
      if (e.movement_pattern && !cur.movement_pattern) cur.movement_pattern = e.movement_pattern;
    }
    sess.items.set(e.plan_item_id, cur);
  }

  const folded = [];
  for (const [sk, sess] of sessions) {
    const itemList = [...sess.items.values()];
    const status = errorSessions.has(sk) ? 'error'
      : sess.closeout_status === 'finalized' ? 'finalized'
      : sess.closeout_status === 'abandoned' ? 'abandoned'
      : 'open';
    const planned = itemList.map(it => it.planned_lift_code).filter(Boolean);
    const completed = itemList
      .map(it => it.outcome === 'completed' ? it.planned_lift_code : it.outcome === 'substituted' ? it.performed_lift_code : null)
      .filter(Boolean);
    folded.push({ session_id: sess.session_id, plan_version: sess.plan_version, date: sess.date, status, items: itemList, planned, completed });
  }
  // Sessions that had ONLY malformed rows still surface as fail-closed error records.
  for (const sk of errorSessions) {
    if (!sessions.has(sk)) {
      const [session_id, plan_version] = sk.split(SEP);
      folded.push({ session_id, plan_version, date: null, status: 'error', items: [], planned: [], completed: [] });
    }
  }
  return folded;
}

// Project the folded sessions into detectDrift's plannedVsCompleted shape. Fail
// closed (error sessions dropped); by default only CLOSED sessions (finalized/
// abandoned have final outcomes) — pass { closedOnly:false } to include open ones.
// Empty-plan sessions are dropped (detectDrift ignores them anyway). Newest LAST:
// preserves the fold's chronological (append) order.
function toPlannedVsCompleted(folded, opts = {}) {
  const closedOnly = !(opts && opts.closedOnly === false);
  return (Array.isArray(folded) ? folded : [])
    .filter(s => s && s.status !== 'error')
    .filter(s => (closedOnly ? (s.status === 'finalized' || s.status === 'abandoned') : true))
    .filter(s => Array.isArray(s.planned) && s.planned.length > 0)
    .map(s => ({ date: s.date, planned: s.planned.slice(), completed: s.completed.slice() }));
}

function readPlannedVsCompleted(rows, opts = {}) {
  return toPlannedVsCompleted(foldSessionPlans(rows), opts);
}

module.exports = { foldSessionPlans, toPlannedVsCompleted, readPlannedVsCompleted };
