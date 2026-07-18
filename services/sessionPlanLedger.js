'use strict';

// ── Session_Plan_Sets recommendation ledger — pure contract module (F10A) ──────
//
// The SET-LEVEL recommendation ledger defined by docs/SESSION_PLANS_LEDGER_DESIGN.md
// (owner-APPROVED WITH AMENDMENTS, 2026-07-17). Grain = set × revision: one row per
// (plan_item_id, set_index, plan_version). Append-only and immutable per set once
// effective — a revision NEVER mutates a prior row; it appends a new row with
// plan_version+1 and supersedes_key = the superseded row's key.
//
// This module is the PURE builders + deterministic idempotency + the chain-VALIDATING
// selector only — NO Sheets I/O, NO route wiring. The idempotent creation-time
// checkpoint writer is services/sessionPlanSetsStore.js; wiring it to the acceptance /
// revision boundaries is F10B. It mirrors services/sessionPlanEvents.js exactly.
//
// Two truths, never merged (design §0): this ledger stores RECOMMENDATIONS ONLY. A
// performed/actual value lives only in Log_Cleaned and is NEVER copied here or read
// as a plan. A performed set never generates a revision (amendment 1) — a revision
// exists only because Atlas EXPLICITLY issued a new recommendation for a
// not-yet-performed set.
//
// effectiveRecommendation() VALIDATES the revision chain first and FAILS CLOSED
// (amendment 3): duplicate versions, forks, missing/mismatched supersedes_key,
// cross-session/item/set references, and non-contiguous versions all return
// `no_reliable_target` WITH diagnostics — never a silently-selected max-version row.

const crypto = require('crypto');
const { sessionPlanSetsColumns } = require('../config/columns');

// recommendation_source vocabulary — OWNER-APPROVED (design §4), frozen.
//   accepted           — the athlete accepted Atlas's proposed session → ledger v1.
//   engine             — a raw recommendNextSet target Atlas formed, not yet accepted.
//   live_revision      — a post-set adjustment Atlas made mid-session (future sets only).
//   user_endorsed      — a user-requested change Atlas EXPLICITLY endorsed/revised.
//   implicit_unplanned — an independent recommendation for an unannounced exercise (F10C).
const RECOMMENDATION_SOURCES = Object.freeze([
  'accepted', 'engine', 'live_revision', 'user_endorsed', 'implicit_unplanned',
]);
// The only sources a REVISION row may carry (an explicit Atlas recommendation for a
// future set). A performed value can never produce these (amendment 1).
const REVISION_SOURCES = Object.freeze(['live_revision', 'user_endorsed']);
// confidence — the engine-owned honesty flag (design §2 col 14).
const CONFIDENCE = Object.freeze(['reliable', 'no_reliable_target']);

// Field delimiter for the idempotency hash — a NUL (0x00) can never appear in a cell,
// so it is a collision-proof separator. EXPLICIT ESCAPE (never a literal control
// byte) so an editor can't silently normalize it away and re-key every row. Same
// discipline as sessionPlanEvents.KEY_DELIM.
const KEY_DELIM = '\x00';

function _str(v) { return v == null ? '' : String(v).trim(); }
function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _requireLiftCode(value, label) {
  const code = _str(value);
  if (!code || /\s/.test(code)) {
    throw new Error(`sessionPlanLedger: ${label} must be a canonical lift code (non-empty, no spaces), got ${JSON.stringify(value)}`);
  }
  return code;
}

// Deterministic idempotency key over the ROW's identity — server-derived from
// (session_id | plan_version | plan_item_id | set_index), NEVER the timestamp (design
// §2 col 1). Same logical row (retry) → same key; a different version → different key.
function idempotencyKey(fields) {
  const parts = [
    fields.session_id,
    fields.plan_version,
    fields.plan_item_id,
    fields.set_index,
  ].map(_str);
  return crypto.createHash('sha256').update(parts.join(KEY_DELIM)).digest('hex').slice(0, 16);
}

// Order a field object into a row array in the OWNER-APPROVED column order (design §2),
// stamping the deterministic idempotency_key. Missing fields → '' (blank = unset).
function toRow(fields) {
  const withKey = { ...fields, idempotency_key: idempotencyKey(fields) };
  return sessionPlanSetsColumns.map(col => {
    const v = withKey[col];
    return v == null ? '' : String(v);
  });
}

function _requireSession(session) {
  const s = session && typeof session === 'object' ? session : {};
  const session_id = _str(s.session_id);
  const plan_version = _str(s.plan_version);
  const session_date = _str(s.session_date);
  if (!session_id) throw new Error('sessionPlanLedger: session_id is required');
  return { session_id, plan_version, session_date };
}

// A positive 1-based integer (set_index / target_set_count / plan_version).
function _requirePosInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`sessionPlanLedger: ${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Build the accepted-plan ledger (plan_version = 1) for one session: one row per
// (item, set_index) for set_index 1..target_set_count. source = 'accepted',
// supersedes_key = '' (v1 has no predecessor). A `no_reliable_target` item carries
// blank targets and confidence 'no_reliable_target'; otherwise 'reliable'.
//
// items: [{ plan_item_id, planned_lift_code, target_set_count, target_weight,
//           target_reps, target_rir, confidence? }]
function buildAcceptedRows(session, items, opts = {}) {
  const { session_id, session_date } = _requireSession(session);
  // Accepted plan is always ledger v1 (design §4). Ignore any caller plan_version.
  const version = 1;
  const recorded_at = _str(opts.recordedAt);
  const list = Array.isArray(items) ? items : [];
  const rows = [];
  list.forEach((item, i) => {
    const it = item && typeof item === 'object' ? item : {};
    const plan_item_id = _str(it.plan_item_id);
    if (!plan_item_id) throw new Error(`sessionPlanLedger: plan_item_id is required (item index ${i})`);
    const planned_lift_code = _requireLiftCode(it.planned_lift_code, 'planned_lift_code');
    const target_set_count = _requirePosInt(it.target_set_count, 'target_set_count');
    const reliable = _str(it.confidence) !== 'no_reliable_target';
    for (let set_index = 1; set_index <= target_set_count; set_index += 1) {
      rows.push(toRow({
        session_id,
        session_date,
        plan_version: version,
        plan_item_id,
        planned_lift_code,
        set_index,
        target_set_count,
        target_weight: reliable ? _numOrBlank(it.target_weight) : '',
        target_reps: reliable ? _numOrBlank(it.target_reps) : '',
        target_rir: reliable ? _numOrBlank(it.target_rir) : '',
        recommendation_source: 'accepted',
        supersedes_key: '',
        confidence: reliable ? 'reliable' : 'no_reliable_target',
        closeout_write_id: '',
        recorded_at,
      }));
    }
  });
  return rows;
}

// A number written verbatim (bodyweight 0 is preserved), or '' when absent/invalid.
function _numOrBlank(v) {
  if (v === 0 || v === '0') return '0';
  const n = _num(v);
  return n == null ? '' : String(n);
}

// Build a single EXPLICIT revision row (a future-set-only Atlas recommendation —
// amendment 1). Requires source ∈ REVISION_SOURCES, plan_version ≥ 2, and a non-empty
// supersedes_key (the key of the row this revision replaces — the prior row is NEVER
// mutated). The caller (F10B) supplies plan_version and supersedes_key from the
// current chain; deriveRevision() below computes them from the ledger.
function buildRevisionRow(session, revision, opts = {}) {
  const { session_id, session_date } = _requireSession(session); // the revision carries its own plan_version
  const r = revision && typeof revision === 'object' ? revision : {};
  const plan_item_id = _str(r.plan_item_id);
  if (!plan_item_id) throw new Error('sessionPlanLedger: plan_item_id is required');
  const planned_lift_code = _requireLiftCode(r.planned_lift_code, 'planned_lift_code');
  const set_index = _requirePosInt(r.set_index, 'set_index');
  const plan_version = _requirePosInt(r.plan_version, 'plan_version');
  if (plan_version < 2) throw new Error('sessionPlanLedger: a revision must have plan_version ≥ 2 (v1 is the accepted plan)');
  const source = _str(r.recommendation_source);
  if (!REVISION_SOURCES.includes(source)) {
    throw new Error(`sessionPlanLedger: a revision recommendation_source must be one of ${REVISION_SOURCES.join('|')} (a performed value never revises — amendment 1), got ${JSON.stringify(r.recommendation_source)}`);
  }
  const supersedes_key = _str(r.supersedes_key);
  if (!supersedes_key) throw new Error('sessionPlanLedger: a revision requires supersedes_key (the key of the row it replaces)');
  const reliable = _str(r.confidence) !== 'no_reliable_target';
  return toRow({
    session_id,
    session_date,
    plan_version,
    plan_item_id,
    planned_lift_code,
    set_index,
    target_set_count: _requirePosInt(r.target_set_count, 'target_set_count'),
    target_weight: reliable ? _numOrBlank(r.target_weight) : '',
    target_reps: reliable ? _numOrBlank(r.target_reps) : '',
    target_rir: reliable ? _numOrBlank(r.target_rir) : '',
    recommendation_source: source,
    supersedes_key,
    confidence: reliable ? 'reliable' : 'no_reliable_target',
    closeout_write_id: '',
    recorded_at: _str(opts.recordedAt),
  });
}

// ── Reading / folding ──────────────────────────────────────────────────────────

const IDX = Object.fromEntries(sessionPlanSetsColumns.map((c, i) => [c, i]));

// Parse a raw sheet row (header stripped) into a typed ledger record, or flag it
// malformed. Structural validation only.
function parseRow(row) {
  if (!Array.isArray(row)) return { malformed: true };
  const get = (c) => String(row[IDX[c]] == null ? '' : row[IDX[c]]).trim();
  const rec = {
    idempotency_key: get('idempotency_key'),
    session_id: get('session_id'),
    session_date: get('session_date') || null,
    plan_version: get('plan_version'),
    plan_item_id: get('plan_item_id'),
    planned_lift_code: get('planned_lift_code'),
    set_index: get('set_index'),
    target_set_count: get('target_set_count'),
    target_weight: get('target_weight'),
    target_reps: get('target_reps'),
    target_rir: get('target_rir'),
    recommendation_source: get('recommendation_source'),
    supersedes_key: get('supersedes_key'),
    confidence: get('confidence'),
    closeout_write_id: get('closeout_write_id'),
    recorded_at: get('recorded_at'),
  };
  const version = Number(rec.plan_version);
  const setIdx = Number(rec.set_index);
  if (row.length < sessionPlanSetsColumns.length) return { malformed: true, rec };
  if (!rec.idempotency_key || !rec.session_id || !rec.plan_item_id) return { malformed: true, rec };
  if (!Number.isInteger(version) || version < 1) return { malformed: true, rec };
  if (!Number.isInteger(setIdx) || setIdx < 1) return { malformed: true, rec };
  if (!RECOMMENDATION_SOURCES.includes(rec.recommendation_source)) return { malformed: true, rec };
  if (!CONFIDENCE.includes(rec.confidence)) return { malformed: true, rec };
  rec.version = version;
  rec.setIndex = setIdx;
  return { malformed: false, rec };
}

function _parseAll(ledgerRows) {
  const recs = [];
  let malformed = false;
  for (const row of (Array.isArray(ledgerRows) ? ledgerRows : [])) {
    const p = parseRow(row);
    if (p.malformed) { malformed = true; continue; }
    recs.push(p.rec);
  }
  return { recs, malformed };
}

// Validate the revision chain for one (plan_item_id, set_index) against the FULL row
// set (cross-references must resolve globally). Returns { ok:true, chain } (chain =
// records ordered v1..vN) or { ok:false, diagnostics:{ reason, keys } }. Fail closed —
// never guess (amendment 3).
function validateChain(recs, plan_item_id, set_index) {
  const id = _str(plan_item_id);
  const si = Number(set_index);
  const byKey = new Map();
  for (const r of recs) if (r.idempotency_key) byKey.set(r.idempotency_key, r);

  const chain = recs.filter(r => r.plan_item_id === id && r.setIndex === si);
  if (!chain.length) return { ok: false, diagnostics: { reason: 'no_matching_row', keys: [] } };

  // Duplicate versions — two rows sharing the same version.
  const byVersion = new Map();
  for (const r of chain) {
    if (byVersion.has(r.version)) {
      return { ok: false, diagnostics: { reason: 'duplicate_version', keys: [byVersion.get(r.version).idempotency_key, r.idempotency_key] } };
    }
    byVersion.set(r.version, r);
  }

  // Forks — two rows whose supersedes_key points at the same predecessor.
  const bySupersedes = new Map();
  for (const r of chain) {
    if (!r.supersedes_key) continue;
    if (bySupersedes.has(r.supersedes_key)) {
      return { ok: false, diagnostics: { reason: 'fork', keys: [bySupersedes.get(r.supersedes_key).idempotency_key, r.idempotency_key] } };
    }
    bySupersedes.set(r.supersedes_key, r);
  }

  // Per-version structural checks: v1 has no supersedes; v>1 supersedes the immediately
  // prior version of the SAME (session, item, set) and that key resolves.
  const maxVersion = Math.max(...chain.map(r => r.version));
  for (let v = 1; v <= maxVersion; v += 1) {
    const r = byVersion.get(v);
    if (!r) return { ok: false, diagnostics: { reason: 'non_contiguous_version', keys: [], missingVersion: v } }; // gap
    if (v === 1) {
      if (r.supersedes_key) return { ok: false, diagnostics: { reason: 'v1_has_supersedes', keys: [r.idempotency_key] } };
      continue;
    }
    if (!r.supersedes_key) return { ok: false, diagnostics: { reason: 'missing_supersedes', keys: [r.idempotency_key] } };
    const prior = byKey.get(r.supersedes_key);
    if (!prior) return { ok: false, diagnostics: { reason: 'dangling_supersedes', keys: [r.idempotency_key], supersedes_key: r.supersedes_key } };
    // Cross-session/item/set reference.
    if (prior.session_id !== r.session_id || prior.plan_item_id !== r.plan_item_id || prior.setIndex !== r.setIndex) {
      return { ok: false, diagnostics: { reason: 'cross_reference', keys: [r.idempotency_key, prior.idempotency_key] } };
    }
    // Must supersede the immediately-prior version.
    if (prior.version !== v - 1) {
      return { ok: false, diagnostics: { reason: 'non_immediate_supersedes', keys: [r.idempotency_key, prior.idempotency_key] } };
    }
  }

  const ordered = [];
  for (let v = 1; v <= maxVersion; v += 1) ordered.push(byVersion.get(v));
  return { ok: true, chain: ordered };
}

function _targetFromRec(rec) {
  return {
    plan_item_id: rec.plan_item_id,
    set_index: rec.setIndex,
    plan_version: rec.version,
    recommendation_source: rec.recommendation_source,
    confidence: rec.confidence,
    target_set_count: _num(rec.target_set_count),
    target_weight: _num(rec.target_weight),
    target_reps: _num(rec.target_reps),
    target_rir: _num(rec.target_rir),
  };
}

// The ONE authoritative selector (design §3). Validates the chain for
// (plan_item_id, set_index), then folds to the highest-plan_version row. Returns a
// reliable target, an honest no_reliable_target flag, or — on ANY malformed history —
// no_reliable_target WITH diagnostics (never a silently-chosen max-version row).
//
//   → { target_weight, target_reps, target_rir, target_set_count, plan_version,
//       recommendation_source, confidence:'reliable', plan_item_id, set_index }
//   → { confidence:'no_reliable_target', reason:'flagged'|'no_matching_row', ... }
//   → { confidence:'no_reliable_target', reason:'malformed_chain', diagnostics }
function effectiveRecommendation(ledgerRows, plan_item_id, set_index) {
  const { recs } = _parseAll(ledgerRows);
  const v = validateChain(recs, plan_item_id, set_index);
  if (!v.ok) {
    if (v.diagnostics && v.diagnostics.reason === 'no_matching_row') {
      return { confidence: 'no_reliable_target', reason: 'no_matching_row', plan_item_id: _str(plan_item_id), set_index: Number(set_index) };
    }
    return { confidence: 'no_reliable_target', reason: 'malformed_chain', diagnostics: v.diagnostics, plan_item_id: _str(plan_item_id), set_index: Number(set_index) };
  }
  const effective = v.chain[v.chain.length - 1]; // highest version
  const target = _targetFromRec(effective);
  if (effective.confidence === 'no_reliable_target') {
    return { confidence: 'no_reliable_target', reason: 'flagged', plan_item_id: target.plan_item_id, set_index: target.set_index, plan_version: target.plan_version, recommendation_source: target.recommendation_source };
  }
  return target;
}

// The per-set effective targets for an item (the FINAL effective plan), ordered by
// set_index, plus the effective target_set_count (from the highest-version rows).
// Each entry is an effectiveRecommendation result. A malformed set fails closed
// independently (its entry carries diagnostics).
function effectivePlan(ledgerRows, plan_item_id) {
  const { recs } = _parseAll(ledgerRows);
  const id = _str(plan_item_id);
  const setIndexes = [...new Set(recs.filter(r => r.plan_item_id === id).map(r => r.setIndex))].sort((a, b) => a - b);
  return setIndexes.map(si => effectiveRecommendation(ledgerRows, id, si));
}

// The full original+revised chain for an item — every version of every set, grouped
// by set_index, for audit and the F10D closeout diff. Malformed chains are surfaced
// (ok:false + diagnostics) rather than dropped.
function planHistory(ledgerRows, plan_item_id) {
  const { recs } = _parseAll(ledgerRows);
  const id = _str(plan_item_id);
  const setIndexes = [...new Set(recs.filter(r => r.plan_item_id === id).map(r => r.setIndex))].sort((a, b) => a - b);
  return setIndexes.map(si => {
    const v = validateChain(recs, id, si);
    if (!v.ok) return { set_index: si, ok: false, diagnostics: v.diagnostics, versions: recs.filter(r => r.plan_item_id === id && r.setIndex === si).map(_targetFromRec) };
    return { set_index: si, ok: true, versions: v.chain.map(_targetFromRec) };
  });
}

module.exports = Object.freeze({
  RECOMMENDATION_SOURCES,
  REVISION_SOURCES,
  CONFIDENCE,
  idempotencyKey,
  toRow,
  parseRow,
  buildAcceptedRows,
  buildRevisionRow,
  validateChain,
  effectiveRecommendation,
  effectivePlan,
  planHistory,
});
