'use strict';

// InteractionTrace shadow — Phase 3 ("shadow the packet and the trace", H-14).
//
// Mints ONE turn id at the first trusted boundary of a coach turn and opens the
// InteractionTrace (the ratified read-only contract in services/interactionTrace.js)
// in shadow. This is the origin of the turn spine that later Phase-3 concerns
// thread through the remaining stages (session_snapshot → engine_decision → …→
// rendered_output → write_proof) and that Phase 4 makes the live route consume.
//
// Staged exactly like ATLAS_INTENT_ROUTER / ATLAS_COACH_ENGINE:
//   ATLAS_INTERACTION_TRACE unset (default) → fully inert: nothing is minted,
//     recorded, or logged, and the served response is byte-identical.
//   ATLAS_INTERACTION_TRACE=shadow → each coach turn mints a turn id and records
//     a turn-start trace to a log-only, in-memory ring buffer.
//
// LOG-ONLY by design: it writes NO Sheet (a new telemetry tab would be an
// owner-reserved schema change). Best-effort throughout — shadow persistence must
// NEVER block, fail, or alter the coach response (Constitution). Pure except for
// the clock (new Date) and Math.random used to mint a unique id.
//
// Public API:
//   isShadowEnabled()                 → boolean
//   mintTurnId(now?)                  → 'turn:<iso>_<seq>_<rand>'
//   observeTurnStart({...})           → record | null (null when disabled/failed)
//   getShadowLog()                    → record[]  (newest last; for diagnostics/tests)
//   _resetForTesting()

const { buildInteractionTrace, validateInteractionTrace } = require('./interactionTrace');

const MAX_LOG = 200;
let _seq = 0;
const _log = [];

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

// Open the trace for a turn at the first trusted boundary. `intent` is the first
// stage knowable on the coach route (facts arrive already parsed; the route
// classifies the turn's intent). Best-effort; never throws.
function observeTurnStart(params) {
  if (!isShadowEnabled()) return null;
  const p = params && typeof params === 'object' ? params : {};
  try {
    const startedAt = typeof p.asOf === 'string' && p.asOf ? p.asOf : new Date().toISOString();
    const trace = buildInteractionTrace({
      turn_id: p.turnId,
      started_at: startedAt,
      stages: [{ stage: 'intent', status: 'ok', ref: null }],
    });
    const v = validateInteractionTrace(trace);
    const record = {
      trace,
      valid: v.valid,
      errors: v.errors,
      intent_type: p.intentType != null ? p.intentType : null,
      source: p.source != null ? p.source : null,
    };
    try {
      console.log(`[interaction-trace] ${JSON.stringify({
        turn_id: trace.turn_id, valid: v.valid, intent_type: record.intent_type, source: record.source,
      })}`);
    } catch { /* log-only best-effort */ }
    _push(record);
    return record;
  } catch {
    return null; // shadow must never surface a failure
  }
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
  observeTurnStart,
  getShadowLog,
  _resetForTesting,
};
