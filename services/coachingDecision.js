'use strict';

// CoachingDecision — contract #3 of the One-Brain coaching engine.
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON,
// no LLM, no Sheets, no write path, no route.
//
// The single object the Brain emits for every intent: a stable envelope + a
// payload typed by decision_type. The output-LLM may word ONLY values present
// in `explanation_inputs` — so "the LLM explains, never decides, never invents
// a number" becomes a schema invariant (rule 4) rather than a guideline.
//
// Spec: docs/COACHING_CONTRACTS_SPEC.md §3
// Architecture: docs/COACHING_ENGINE_ARCHITECTURE.md
//
// Public API:
//   buildCoachingDecision(params)      → decision object (does NOT validate)
//   validateCoachingDecision(decision) → { valid, errors[] }  (total, never throws)
//   SCHEMA_VERSION, DECISION_TYPES, CAVEAT_KEYS

const path = require('node:path');
const fs   = require('node:fs');

const manifest = require('./capabilityManifest'); // pure data reader (no Brain decision module)

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'decision.contract.json');

const SCHEMA_VERSION = 1;

let _contract = null;

function _load() {
  if (_contract) return _contract;
  _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}

function _resetForTesting() { _contract = null; }

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble a CoachingDecision. Sets schema_version, defaults status='answered',
 * missing_info=[], and empty-but-present sub-objects. Does NOT validate.
 */
function buildCoachingDecision(params) {
  const p = params && typeof params === 'object' ? params : {};
  return {
    schema_version:     SCHEMA_VERSION,
    intent:             _isPlainObject(p.intent) ? p.intent : {},
    decision_type:      p.decision_type,
    status:             p.status != null ? p.status : 'answered',
    confidence:         _isPlainObject(p.confidence) ? p.confidence : {},
    safety:             _isPlainObject(p.safety) ? p.safety : { level: 'green', flags: [], blocking: false },
    payload:            _isPlainObject(p.payload) ? p.payload : {},
    missing_info:       Array.isArray(p.missing_info) ? p.missing_info : [],
    explanation_inputs: _isPlainObject(p.explanation_inputs) ? p.explanation_inputs : {},
    provenance:         _isPlainObject(p.provenance) ? p.provenance
                          : { modules_run: [], skipped: [], state_asOf: null, engine_version: null },
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// Deep-collect every finite number that appears as a value anywhere in obj.
function _collectNumbers(obj, acc) {
  if (_isNumber(obj)) { acc.add(obj); return acc; }
  if (Array.isArray(obj)) { for (const v of obj) _collectNumbers(v, acc); return acc; }
  if (_isPlainObject(obj)) { for (const v of Object.values(obj)) _collectNumbers(v, acc); return acc; }
  return acc;
}

// Collect the prescribed numbers a payload asserts, per its decision_type spec.
function _prescribedNumbers(decisionType, payload, contract) {
  const nums = [];
  const spec = contract.payloads[decisionType];
  if (!spec || !_isPlainObject(payload)) return nums;
  if (decisionType === 'workout') {
    const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
    for (const b of blocks) {
      for (const f of spec.block_prescribed_numbers || []) {
        if (_isNumber(b && b[f])) nums.push(b[f]);
      }
    }
  } else {
    for (const f of spec.prescribed_numbers || []) {
      if (_isNumber(payload[f])) nums.push(payload[f]);
    }
  }
  return nums;
}

// ─── validator ────────────────────────────────────────────────────────────────

/**
 * Validate a CoachingDecision against the contract. Total / pure:
 * { valid, errors[] }, never throws, never mutates. Rules: spec §3.4.
 */
function validateCoachingDecision(decision) {
  const errors = [];
  if (!_isPlainObject(decision)) return { valid: false, errors: ['decision: must be an object'] };

  let c;
  try { c = _load(); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }

  const decisionTypes = new Set(c.decision_types);
  const caveatKeys     = new Set(c.caveat_keys);

  // Rule 1 — envelope fields + enums
  if (decision.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  if (!_isPlainObject(decision.intent) || !decision.intent.type) {
    errors.push('intent: must be { type, constraints, source }');
  } else if (!manifest.getIntent(decision.intent.type)) {
    errors.push(`intent.type: '${decision.intent.type}' is not a known intent`);
  }

  if (!decisionTypes.has(decision.decision_type)) {
    errors.push(`decision_type: must be one of ${c.decision_types.join(', ')}`);
  }
  if (!c.statuses.includes(decision.status)) {
    errors.push(`status: must be one of ${c.statuses.join(', ')}`);
  }

  // confidence
  const conf = decision.confidence;
  if (!_isPlainObject(conf)) {
    errors.push('confidence: must be an object');
  } else {
    if (!_isNumber(conf.score) || conf.score < 0 || conf.score > 100) errors.push('confidence.score: must be a number in [0, 100]');
    if (!c.tiers.includes(conf.tier)) errors.push(`confidence.tier: must be one of ${c.tiers.join(', ')}`);
    if (!c.actions.includes(conf.action)) errors.push(`confidence.action: must be one of ${c.actions.join(', ')}`);
    if (!Array.isArray(conf.caveats)) errors.push('confidence.caveats: must be an array');
    else for (const k of conf.caveats) if (!caveatKeys.has(k)) errors.push(`confidence.caveats: unknown caveat '${k}'`);
  }

  // safety
  const safety = decision.safety;
  if (!_isPlainObject(safety)) {
    errors.push('safety: must be an object');
  } else {
    if (!c.safety_levels.includes(safety.level)) errors.push(`safety.level: must be one of ${c.safety_levels.join(', ')}`);
    if (!Array.isArray(safety.flags)) errors.push('safety.flags: must be an array');
    if (typeof safety.blocking !== 'boolean') errors.push('safety.blocking: must be a boolean');
  }

  if (!_isPlainObject(decision.payload)) errors.push('payload: must be an object');
  if (!Array.isArray(decision.missing_info)) errors.push('missing_info: must be an array');
  if (!_isPlainObject(decision.explanation_inputs)) errors.push('explanation_inputs: must be an object');

  // provenance
  const prov = decision.provenance;
  if (!_isPlainObject(prov)) {
    errors.push('provenance: must be an object');
  } else {
    if (!Array.isArray(prov.modules_run)) errors.push('provenance.modules_run: must be an array');
    if (!Array.isArray(prov.skipped))     errors.push('provenance.skipped: must be an array');
  }

  // Bail early if structural shape is broken — later rules assume the shape.
  if (errors.length) return { valid: false, errors };

  const dt = decision.decision_type;
  const payloadSpec = c.payloads[dt];

  // Rule 2 — discriminator integrity (payload conforms to its decision_type)
  for (const f of (payloadSpec.required || [])) {
    if (decision.payload[f] == null) errors.push(`payload: '${dt}' requires field '${f}'`);
  }
  if (dt === 'workout') {
    const blocks = Array.isArray(decision.payload.blocks) ? decision.payload.blocks : [];
    blocks.forEach((b, i) => {
      for (const f of (payloadSpec.block_required || [])) {
        if (!_isPlainObject(b) || b[f] == null) errors.push(`payload.blocks[${i}]: requires '${f}'`);
      }
    });
  }

  // Rule 3 — ask/answer four-way lockstep
  const isClarType = dt === 'clarification_needed';
  const isNeeds    = decision.status === 'needs_clarification';
  const hasMissing = decision.missing_info.length > 0;
  const isAsk      = decision.confidence.action === 'ask';
  if (!(isClarType === isNeeds && isNeeds === hasMissing && hasMissing === isAsk)) {
    errors.push('ask/answer integrity: status==needs_clarification ⟺ decision_type==clarification_needed ⟺ missing_info non-empty ⟺ action==ask must all agree');
  }

  // Rule 4 — trust contract: every prescribed number must appear in explanation_inputs.
  // NOTE: this is a VALUE-based floor (the number appears somewhere in explanation_inputs),
  // not KEY-aware ("this number was emitted under a prescription key"). A small integer like
  // target_rir:2 will usually find an incidental match, so do NOT over-trust it. It still
  // catches the dangerous case — a prescribed number absent everywhere. Key-aware matching is
  // filed in BACKLOG to land BEFORE the orchestrator wires a real number to the LLM (PR-5).
  const explained = _collectNumbers(decision.explanation_inputs, new Set());
  for (const n of _prescribedNumbers(dt, decision.payload, c)) {
    if (!explained.has(n)) {
      errors.push(`trust-contract: prescribed number ${n} is absent from explanation_inputs (the LLM may speak only what the Brain emitted)`);
    }
  }

  // Rule 5 — safety escalation
  if (decision.safety.blocking === true) {
    if (decision.confidence.action === 'act') {
      errors.push('safety escalation: blocking=true forbids action==act (must be act_with_caveat or ask)');
    }
    if (!decision.confidence.caveats.includes(c.safety_flag_caveat)) {
      errors.push(`safety escalation: blocking=true requires caveat '${c.safety_flag_caveat}'`);
    }
  }

  // Rule 6 — progress_readout carries no prescription
  if (dt === 'progress_readout') {
    for (const k of c.prescription_keys) {
      if (decision.payload[k] != null) errors.push(`progress_readout: payload must not carry prescription field '${k}'`);
    }
    if (decision.payload.blocks != null) errors.push('progress_readout: payload must not carry prescription blocks');
  }

  // Rule 7 — provenance accounting: run/skipped disjoint; union ⊆ resolved closure
  const run = decision.provenance.modules_run, skipped = decision.provenance.skipped;
  const overlap = run.filter(x => skipped.includes(x));
  if (overlap.length) errors.push(`provenance: ${overlap.join(', ')} appear in both modules_run and skipped`);
  const resolved = manifest.resolve(decision.intent.type);
  if (resolved && resolved.brain) {
    const planned = new Set(resolved.order.map(d => d.id));
    for (const m of [...run, ...skipped]) {
      if (!planned.has(m)) errors.push(`provenance: '${m}' is not in the manifest plan for intent '${decision.intent.type}'`);
    }
  }

  // Rule 8 — missing_info entries valid + sorted by information_gain desc
  const inputKeys = new Set(manifest.INPUT_KEYS);
  let prevGain = Infinity;
  decision.missing_info.forEach((mi, i) => {
    if (!_isPlainObject(mi)) { errors.push(`missing_info[${i}]: must be an object`); return; }
    if (!inputKeys.has(mi.field)) errors.push(`missing_info[${i}].field: '${mi.field}' not in input-key vocabulary`);
    if (typeof mi.required !== 'boolean') errors.push(`missing_info[${i}].required: must be a boolean`);
    if (typeof mi.question !== 'string' || !mi.question) errors.push(`missing_info[${i}].question: must be a non-empty string`);
    if (!_isNumber(mi.information_gain) || mi.information_gain < 0 || mi.information_gain > 1) {
      errors.push(`missing_info[${i}].information_gain: must be a number in [0, 1]`);
    } else {
      if (mi.information_gain > prevGain) errors.push('missing_info: must be sorted by information_gain descending');
      prevGain = mi.information_gain;
    }
  });

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  buildCoachingDecision,
  validateCoachingDecision,
  get DECISION_TYPES() { return [..._load().decision_types]; },
  get CAVEAT_KEYS() { return [..._load().caveat_keys]; },
  _resetForTesting,
};
