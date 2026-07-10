'use strict';

// ── Session_Plans event builders (Decision Desk #952, Option A — PR-A) ─────────
//
// PURE builders for the append-only, event-sourced Session_Plans record — the
// durable ACCEPTED/FINAL plan state that the drift reader (PR-C) will fold into a
// planned-vs-completed history. This slice is the SCHEMA CONTRACT + pure builders +
// idempotency only: NO Sheets I/O, NO route wiring, NO drift detection. The writer
// (PR-B) and its live capture wiring (PR-C) come later.
//
// Three event types (frozen), each an append-only row in `sessionPlansColumns`
// order — prior rows are never mutated:
//   plan_accepted   — one per accepted planned item (outcome = 'planned')
//   item_outcome    — an item's final outcome (completed | skipped | substituted)
//   session_closeout— the session-level closeout marker (closeout_status)
//
// Retry-safety: `idempotency_key` is a deterministic hash of the event's SEMANTIC
// identity (never the timestamp), so a network-retried write produces the identical
// key and the reader/writer can collapse the duplicate; a genuinely different event
// (e.g. an item's outcome later changing planned→completed) hashes differently and
// is a new append that the reader folds last-wins.
//
// Canonical lift CODES only (never free-text lift identity). No loads/reps/RIR/
// progression data in this version. `recordedAt` is an INPUT (the writer stamps it
// at wire time) so these builders stay pure/deterministic and fully testable.

const crypto = require('crypto');
const { sessionPlansColumns } = require('../config/columns');

// event_type + outcome vocabularies are OWNER-FROZEN (Decision Desk #952).
const EVENT_TYPES = Object.freeze(['plan_accepted', 'item_outcome', 'session_closeout']);
const OUTCOMES = Object.freeze(['planned', 'completed', 'skipped', 'substituted']);
// Outcomes an item_outcome event may carry (a resolved outcome, not the initial
// 'planned' state which belongs to plan_accepted).
const ITEM_OUTCOMES = Object.freeze(['completed', 'skipped', 'substituted']);
// closeout_status vocabulary — OWNER-APPROVED (Decision Desk #952, 2026-07-10),
// frozen alongside event_type + outcome. `finalized` = the athlete explicitly closed
// the session (NOT a completion claim, and NOT proof rows were saved — plan
// completion is derived from item outcomes, not this field); `abandoned` = the
// athlete explicitly cancelled/discarded with no intent to continue. Never inferred
// from inactivity/timeout/redeploy/missing data; null on plan_accepted/item_outcome
// events and while a session is still open.
const CLOSEOUT_STATUSES = Object.freeze(['finalized', 'abandoned']);

// Field delimiter for the idempotency hash input. A NUL (0x00) can never appear in
// the joined string fields, so it is a collision-proof separator (a|b vs a + |b can
// never alias). Written as an EXPLICIT ESCAPE, never a literal control byte, so the
// source stays plain UTF-8 and the delimiter can't be silently normalized away by
// an editor/formatter — which would re-key every event and break dedup.
const KEY_DELIM = '\x00';

function _str(v) {
  return v == null ? '' : String(v).trim();
}

// A canonical lift code: a non-empty token (letters/digits, uppercased by the
// caller's catalog). We only assert non-empty + no whitespace here — the catalog
// owns the code space; free-text lift NAMES must never be passed as the contract.
function _requireLiftCode(value, label) {
  const code = _str(value);
  if (!code || /\s/.test(code)) {
    throw new Error(`sessionPlanEvents: ${label} must be a canonical lift code (non-empty, no spaces), got ${JSON.stringify(value)}`);
  }
  return code;
}

// Deterministic idempotency key over the event's semantic identity — NEVER the
// timestamp. Same logical event (retry) → same key; a different outcome/substitute
// → different key (a new fold-last-wins append).
function idempotencyKey(fields) {
  const parts = [
    fields.event_type,
    fields.session_id,
    fields.plan_version,
    fields.plan_item_id,
    fields.outcome,
    fields.performed_lift_code,
    fields.closeout_status
  ].map(_str);
  return crypto.createHash('sha256').update(parts.join(KEY_DELIM)).digest('hex').slice(0, 16);
}

// Order a field object into a row array in the OWNER-APPROVED column order, so the
// row layout can never drift from the contract. Missing fields become '' (a blank
// cell reads as unset).
function toRow(fields) {
  const key = idempotencyKey(fields);
  const withKey = { ...fields, idempotency_key: key };
  return sessionPlansColumns.map(col => {
    const v = withKey[col];
    return v == null ? '' : String(v);
  });
}

function _requireSession(session) {
  const s = session && typeof session === 'object' ? session : {};
  const session_id = _str(s.session_id);
  const plan_version = _str(s.plan_version);
  const session_date = _str(s.session_date);
  if (!session_id) throw new Error('sessionPlanEvents: session_id is required');
  if (!plan_version) throw new Error('sessionPlanEvents: plan_version is required');
  return { session_id, plan_version, session_date };
}

// Build the plan_accepted events for an accepted plan — one row per item, in the
// item's planned order. outcome = 'planned' (the item is accepted, not yet done).
// items: [{ plan_item_id, planned_order, planned_lift_code, movement_pattern }]
function buildPlanAcceptedEvents(session, items, opts = {}) {
  const { session_id, plan_version, session_date } = _requireSession(session);
  const list = Array.isArray(items) ? items : [];
  const recorded_at = _str(opts.recordedAt);
  return list.map((item, i) => {
    const it = item && typeof item === 'object' ? item : {};
    const plan_item_id = _str(it.plan_item_id);
    if (!plan_item_id) throw new Error(`sessionPlanEvents: plan_item_id is required (item index ${i})`);
    const fields = {
      session_id,
      session_date,
      plan_version,
      event_type: 'plan_accepted',
      plan_item_id,
      planned_order: it.planned_order == null ? '' : String(it.planned_order),
      planned_lift_code: _requireLiftCode(it.planned_lift_code, 'planned_lift_code'),
      movement_pattern: _str(it.movement_pattern),
      outcome: 'planned',
      performed_lift_code: '',
      closeout_status: '',
      recorded_at
    };
    return toRow(fields);
  });
}

// Build a single item_outcome event. outcome ∈ completed|skipped|substituted;
// performed_lift_code is REQUIRED (and only meaningful) when outcome==='substituted'.
function buildItemOutcomeEvent(session, item, opts = {}) {
  const { session_id, plan_version, session_date } = _requireSession(session);
  const it = item && typeof item === 'object' ? item : {};
  const plan_item_id = _str(it.plan_item_id);
  if (!plan_item_id) throw new Error('sessionPlanEvents: plan_item_id is required');
  const outcome = _str(it.outcome);
  if (!ITEM_OUTCOMES.includes(outcome)) {
    throw new Error(`sessionPlanEvents: item_outcome.outcome must be one of ${ITEM_OUTCOMES.join('|')}, got ${JSON.stringify(it.outcome)}`);
  }
  let performed_lift_code = '';
  if (outcome === 'substituted') {
    performed_lift_code = _requireLiftCode(it.performed_lift_code, 'performed_lift_code (substituted)');
  } else if (it.performed_lift_code != null && _str(it.performed_lift_code)) {
    throw new Error('sessionPlanEvents: performed_lift_code is only valid when outcome is substituted');
  }
  const fields = {
    session_id,
    session_date,
    plan_version,
    event_type: 'item_outcome',
    plan_item_id,
    planned_order: it.planned_order == null ? '' : String(it.planned_order),
    planned_lift_code: _requireLiftCode(it.planned_lift_code, 'planned_lift_code'),
    movement_pattern: _str(it.movement_pattern),
    outcome,
    performed_lift_code,
    closeout_status: '',
    recorded_at: _str(opts.recordedAt)
  };
  return toRow(fields);
}

// Build the session-level session_closeout event. closeout_status ∈
// finalized|abandoned. Carries no item identity (session-scoped).
function buildSessionCloseoutEvent(session, closeoutStatus, opts = {}) {
  const { session_id, plan_version, session_date } = _requireSession(session);
  const closeout_status = _str(closeoutStatus);
  if (!CLOSEOUT_STATUSES.includes(closeout_status)) {
    throw new Error(`sessionPlanEvents: closeout_status must be one of ${CLOSEOUT_STATUSES.join('|')}, got ${JSON.stringify(closeoutStatus)}`);
  }
  const fields = {
    session_id,
    session_date,
    plan_version,
    event_type: 'session_closeout',
    plan_item_id: '',
    planned_order: '',
    planned_lift_code: '',
    movement_pattern: '',
    outcome: '',
    performed_lift_code: '',
    closeout_status,
    recorded_at: _str(opts.recordedAt)
  };
  return toRow(fields);
}

module.exports = Object.freeze({
  EVENT_TYPES,
  OUTCOMES,
  ITEM_OUTCOMES,
  CLOSEOUT_STATUSES,
  idempotencyKey,
  toRow,
  buildPlanAcceptedEvents,
  buildItemOutcomeEvent,
  buildSessionCloseoutEvent
});
