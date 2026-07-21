'use strict';

// InteractionTrace shadow — Phase 3 ("shadow the packet and the trace", H-14).
//
// Mints ONE turn id at the first trusted boundary of a coach turn and carries it
// through EVERY stage of the turn, assembling the InteractionTrace (the ratified
// read-only contract in services/interactionTrace.js) in shadow. This is the turn
// spine that Phase 4 makes the live route consume.
//
// Concern 1 opened the trace at the `intent` stage only. Concern 2 (this file)
// threads the same minted turn id through the remaining stages the coach route
// actually passes through — session_snapshot → engine_decision → coaching_strategy
// → model_response → validator_result → rendered_output — and emits ONE spanning
// trace per turn. The stages the read-only coach route legitimately does not run
// (parser — the client parses; knowledge_retrieval — not wired until Phase 6;
// write_proof — this route never writes) are simply absent, and surface as the
// `missing` list: the raw material for the Phase 3 nightly divergence report.
//
// Staged exactly like ATLAS_INTENT_ROUTER / ATLAS_COACH_ENGINE:
//   ATLAS_INTERACTION_TRACE unset (default) → fully inert: nothing is minted,
//     recorded, or logged, and the served response is byte-identical.
//   ATLAS_INTERACTION_TRACE=shadow → each coach turn mints a turn id, records a
//     stage entry as it passes each boundary, and logs the spanning trace to a
//     log-only, in-memory ring buffer when the response finishes.
//
// LOG-ONLY by design: it writes NO Sheet (a new telemetry tab would be an
// owner-reserved schema change). Best-effort throughout — shadow persistence must
// NEVER block, fail, or alter the coach response (Constitution). Pure except for
// the clock (new Date) and Math.random used to mint a unique id.
//
// Public API:
//   isShadowEnabled()                 → boolean
//   mintTurnId(now?)                  → 'turn:<iso>_<seq>_<rand>'
//   beginTurn({...})                  → recorder (inert when disabled)
//     recorder.enabled                → boolean
//     recorder.turnId                 → the minted (or supplied) turn id
//     recorder.stage(name,status,ref) → record one stage; chainable; no-op when disabled/finished
//     recorder.finish()               → assemble+validate+log the spanning trace; record | null
//   getShadowLog()                    → record[]  (newest last; for diagnostics/tests)
//   _resetForTesting()

const {
  buildInteractionTrace,
  validateInteractionTrace,
  missingStages,
} = require('./interactionTrace');

const MAX_LOG = 200;
let _seq = 0;
const _log = [];

function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function isShadowEnabled() {
  return process.env.ATLAS_INTERACTION_TRACE === 'shadow';
}

// A unique, sortable, trace-id-formatted turn id. The `turn:` prefix matches the
// trace-id format Drift Guard 4 recognizes, so a future live-proven capability can
// cite this id as evidence. `new Date`/`Math.random` are production-only (never a
// workflow script), so they are safe here.
function mintTurnId(now) {
  const d = now instanceof Date ? now : new Date();
  _seq = (_seq + 1) % 1000000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `turn:${d.toISOString()}_${_seq}_${rand}`;
}

function _push(record) {
  _log.push(record);
  if (_log.length > MAX_LOG) _log.shift();
}

// One line per turn — a stable, single-line JSON record prefixed `[interaction-trace]`
// so the nightly divergence report can parse it out of the deployment log stream.
// Carries only synthetic/structural fields (turn id, timestamp, stage names+statuses,
// the missing-stage list) — never workout data, prose, or secrets.
function _logTurn(record) {
  try {
    console.log(`[interaction-trace] ${JSON.stringify({
      turn_id: record.trace.turn_id,
      started_at: record.trace.started_at,
      valid: record.valid,
      intent_type: record.intent_type,
      source: record.source,
      stages: record.trace.stages.map((s) => ({ stage: s.stage, status: s.status })),
      missing: record.missing,
    })}`);
  } catch (_) { /* log-only best-effort */ }
}

// A canonical stage status: only 'skipped'/'error' pass through; anything else
// (incl. undefined) normalizes to 'ok'. Keeps a caller typo from producing an
// invalid trace that would look like a real mis-thread in the divergence report.
function _normStatus(status) {
  return (status === 'skipped' || status === 'error') ? status : 'ok';
}

// Open the trace for a turn at the first trusted boundary and return a recorder the
// coach route threads the minted turn id through, stage by stage. Inert (all methods
// no-op, finish → null) when shadow is disabled, so the route can call it
// unconditionally and gate only the response-finished hook on `recorder.enabled`.
// Best-effort; never throws.
function beginTurn(params) {
  const enabled = isShadowEnabled();
  const p = params && typeof params === 'object' ? params : {};
  const turnId = _isNonEmptyString(p.turnId) ? p.turnId : mintTurnId();
  const startedAt = (typeof p.asOf === 'string' && p.asOf) ? p.asOf : new Date().toISOString();
  const intentType = p.intentType != null ? p.intentType : null;
  const source = p.source != null ? p.source : null;

  const stages = [];
  const seen = new Set();
  let finished = false;

  const recorder = {
    enabled,
    turnId,
    // Record one stage of the turn. Entries are pushed in call order; the contract
    // validator (run at finish) rejects an out-of-canonical-order or duplicate span,
    // so a genuine mis-thread surfaces as `valid:false` instead of being hidden.
    // First write per stage wins (a later duplicate is ignored, not appended).
    stage(name, status, ref) {
      if (!enabled || finished) return recorder;
      try {
        if (!_isNonEmptyString(name) || seen.has(name)) return recorder;
        seen.add(name);
        stages.push({ stage: name, status: _normStatus(status), ref: ref != null ? ref : null });
      } catch (_) { /* best-effort — a shadow stage must never surface */ }
      return recorder;
    },
    // Assemble the spanning trace from every stage recorded, validate it against the
    // ratified contract, log it, and push it to the ring buffer. Idempotent (a second
    // call is a no-op). Returns the record, or null when disabled/failed.
    finish() {
      if (!enabled || finished) return null;
      finished = true;
      try {
        const trace = buildInteractionTrace({ turn_id: turnId, started_at: startedAt, stages });
        const v = validateInteractionTrace(trace);
        const record = {
          trace,
          valid: v.valid,
          errors: v.errors,
          intent_type: intentType,
          source,
          missing: missingStages(trace),
        };
        _logTurn(record);
        _push(record);
        return record;
      } catch (_) {
        return null; // shadow must never surface a failure
      }
    },
  };
  return recorder;
}

// Read-only snapshot (newest last) — for a future diagnostics endpoint and tests.
function getShadowLog() {
  return _log.slice();
}

function _resetForTesting() {
  _seq = 0;
  _log.length = 0;
}

module.exports = {
  isShadowEnabled,
  mintTurnId,
  beginTurn,
  getShadowLog,
  _resetForTesting,
};
