'use strict';

// InteractionTrace — canonical contract (Phase 2 Work item 2; charter row in
// docs/CANONICAL_CONTRACTS.md).
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON.
// No LLM, no Sheets, no write path, no route.
//
// One turn's end-to-end record: a single `turn_id` minted at the first trusted
// boundary and carried through every stage of the turn — parser → intent →
// session_snapshot → engine_decision → knowledge_retrieval → coaching_strategy →
// model_response → validator_result → rendered_output → write_proof. It is
// ratified read-only here and is NOT yet wired (hence its staged entry in
// config/wiring-allowlist.json); Phase 3 assembles it in shadow for every real
// turn and produces the divergence report (finding H-14), unifying today's
// telemetry islands (Flight_Recorder + brainShadow + intentShadow) behind one id.
//
// A turn need not populate every stage; each present entry must name a canonical
// stage exactly once. `ref` is an opaque pointer into that stage's detailed
// record, or null.
//
// Public API:
//   buildInteractionTrace(params)     → trace object (does NOT validate)
//   validateInteractionTrace(trace)   → { valid, errors[] }  (total, never throws)
//   findStage(trace, stage)           → the stage entry, or null
//   missingStages(trace)              → canonical stages with no entry, in order
//   SCHEMA_VERSION, STAGES, STAGE_STATUSES

const path = require('node:path');
const fs   = require('node:fs');

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'interaction-trace.contract.json');

const SCHEMA_VERSION = 1;

let _contract = null;
function _loadContract() {
  if (!_contract) _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}
function _resetForTesting() { _contract = null; }

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble an InteractionTrace. Stamps schema_version, defaults started_at to
 * null and stages to [], and normalizes each stage entry (status→'ok',
 * ref→null). Does NOT validate.
 */
function buildInteractionTrace(params) {
  const p = _isPlainObject(params) ? params : {};
  const stages = (Array.isArray(p.stages) ? p.stages : []).map((s) => {
    const st = _isPlainObject(s) ? s : {};
    return {
      stage:  st.stage,
      status: st.status != null ? st.status : 'ok',
      ref:    st.ref != null ? st.ref : null,
    };
  });
  return {
    schema_version: SCHEMA_VERSION,
    turn_id:        p.turn_id,
    started_at:     p.started_at != null ? p.started_at : null,
    stages,
  };
}

// ─── validator (total; never throws) ────────────────────────────────────────────

function validateInteractionTrace(trace) {
  if (!_isPlainObject(trace)) return { valid: false, errors: ['trace: must be an object'] };

  let contract;
  try { contract = _loadContract(); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }
  const stageNames = new Set(contract.stages);
  const statuses = new Set(contract.stage_statuses);

  const errors = [];
  const _has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  if (trace.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  if (!_isNonEmptyString(trace.turn_id)) errors.push('turn_id: must be a non-empty string');

  // started_at follows the explicit-null rule: present, null or a non-empty string.
  if (!_has(trace, 'started_at')) errors.push('started_at: must be present (null or an ISO-8601 string)');
  else if (trace.started_at !== null && !_isNonEmptyString(trace.started_at)) errors.push('started_at: must be a non-empty string or null');

  if (!Array.isArray(trace.stages)) {
    errors.push('stages: must be an array');
    return { valid: false, errors };
  }

  const seen = new Set();
  trace.stages.forEach((entry, i) => {
    if (!_isPlainObject(entry)) { errors.push(`stages[${i}]: must be an object`); return; }
    if (!stageNames.has(entry.stage)) errors.push(`stages[${i}].stage: must be one of ${[...stageNames].join(', ')}`);
    else if (seen.has(entry.stage)) errors.push(`stages[${i}].stage: duplicate '${entry.stage}' (one entry per stage)`);
    else seen.add(entry.stage);

    if (!statuses.has(entry.status)) errors.push(`stages[${i}].status: must be one of ${[...statuses].join(', ')}`);

    if (!_has(entry, 'ref')) errors.push(`stages[${i}].ref: must be present (null or a non-empty string)`);
    else if (entry.ref !== null && !_isNonEmptyString(entry.ref)) errors.push(`stages[${i}].ref: must be a non-empty string or null`);
  });

  return { valid: errors.length === 0, errors };
}

// ─── derived helpers ─────────────────────────────────────────────────────────────

// The entry for a given stage, or null.
function findStage(trace, stage) {
  if (!_isPlainObject(trace) || !Array.isArray(trace.stages)) return null;
  return trace.stages.find((s) => _isPlainObject(s) && s.stage === stage) || null;
}

// Canonical stages with no entry in this trace, in canonical order — the raw
// material for the Phase 3 divergence report ("where did the turn bypass a stage").
function missingStages(trace) {
  const present = new Set((_isPlainObject(trace) && Array.isArray(trace.stages) ? trace.stages : [])
    .filter(_isPlainObject).map((s) => s.stage));
  return _loadContract().stages.filter((name) => !present.has(name));
}

module.exports = {
  SCHEMA_VERSION,
  buildInteractionTrace,
  validateInteractionTrace,
  findStage,
  missingStages,
  get STAGES() { return [..._loadContract().stages]; },
  get STAGE_STATUSES() { return [..._loadContract().stage_statuses]; },
  _resetForTesting,
};
