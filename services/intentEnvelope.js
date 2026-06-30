'use strict';

// IntentEnvelope — contract #1 of the One-Brain coaching engine.
//
// Pure / deterministic. No I/O at call time (the vocabulary is a static JSON
// file lazy-loaded once), no LLM, no Sheets, no write path, no route.
//
// The single object every input source produces. Produced by the Intent Router,
// consumed by the Coach Orchestrator. Every source — button, chat, voice, API,
// wearable, schedule — collapses to this one validated shape, so the Orchestrator
// cannot tell a button from a sentence (no per-button coaching lane).
//
// Spec: docs/COACHING_CONTRACTS_SPEC.md §1
// Architecture: docs/COACHING_ENGINE_ARCHITECTURE.md
//
// Public API:
//   buildIntentEnvelope({ type, constraints?, source, asOf, actor?, raw_input?, extraction? })
//                                   → envelope object (does NOT validate; pair with validate)
//   validateIntentEnvelope(env)     → { valid: boolean, errors: string[] }  (total, never throws)
//   SCHEMA_VERSION                  → the contract version this module emits

const path = require('node:path');
const fs   = require('node:fs');

const VOCAB_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'intent.vocabulary.json');

const SCHEMA_VERSION = 1;

// Strict ISO-8601 date-time: YYYY-MM-DDThh:mm:ss[.sss](Z|±hh:mm).
// Tighter than Date.parse, which also accepts "June 30 2026" / bare "2026-06-30".
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

let _vocab = null;

function _loadVocab() {
  if (_vocab) return _vocab;
  _vocab = Object.freeze(JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8')));
  return _vocab;
}

function _resetForTesting() { _vocab = null; }

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Assemble an IntentEnvelope. Sets schema_version; passes the rest through.
 * Does NOT validate — call validateIntentEnvelope on the result.
 * Optional fields are omitted (not set to undefined) when not provided, so the
 * envelope shape stays clean for downstream consumers.
 */
function buildIntentEnvelope(params) {
  const p = params && typeof params === 'object' ? params : {};
  const env = {
    schema_version: SCHEMA_VERSION,
    type:           p.type,
    constraints:    p.constraints != null && typeof p.constraints === 'object' ? p.constraints : {},
    source:         p.source,
    asOf:           p.asOf,
    actor:          p.actor != null ? p.actor : 'user',
  };
  if (p.raw_input  != null) env.raw_input  = p.raw_input;
  if (p.extraction != null) env.extraction = p.extraction;
  return env;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function _isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function _isInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

// Validate a single constraint value against its key spec. Pushes errors.
function _validateConstraintValue(key, spec, value, errors) {
  switch (spec.type) {
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        errors.push(`constraints.${key}: must be one of ${spec.values.join(', ')}`);
      }
      break;
    case 'integer':
      if (!_isInteger(value) || value < spec.min || value > spec.max) {
        errors.push(`constraints.${key}: must be an integer in [${spec.min}, ${spec.max}]`);
      }
      break;
    case 'string':
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`constraints.${key}: must be a non-empty string`);
      }
      break;
    case 'string_array':
      if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) {
        errors.push(`constraints.${key}: must be an array of strings`);
      } else if (spec.values) {
        const bad = value.filter(x => !spec.values.includes(x));
        if (bad.length) errors.push(`constraints.${key}: invalid value(s) ${bad.join(', ')}`);
      }
      break;
    case 'int_map':
      if (!_isPlainObject(value)) {
        errors.push(`constraints.${key}: must be an object`);
      } else {
        for (const [k, v] of Object.entries(value)) {
          if (!spec.keys.includes(k)) {
            errors.push(`constraints.${key}: unknown sub-key '${k}'`);
          } else if (!_isInteger(v) || v < spec.min || v > spec.max) {
            errors.push(`constraints.${key}.${k}: must be an integer in [${spec.min}, ${spec.max}]`);
          }
        }
      }
      break;
    case 'object':
      if (!_isPlainObject(value)) {
        errors.push(`constraints.${key}: must be an object`);
      } else {
        for (const req of spec.required || []) {
          if (value[req] == null) errors.push(`constraints.${key}: missing required field '${req}'`);
        }
        if (key === 'signal' && value.kind != null && !spec.kind_values.includes(value.kind)) {
          errors.push(`constraints.signal.kind: must be one of ${spec.kind_values.join(', ')}`);
        }
      }
      break;
    default:
      errors.push(`constraints.${key}: unrecognized spec type '${spec.type}'`);
  }
}

// ─── Validator ────────────────────────────────────────────────────────────────

/**
 * Validate an IntentEnvelope against the vocabulary contract.
 * Total and pure: returns { valid, errors[] }, never throws, never mutates input.
 * Rules: docs/COACHING_CONTRACTS_SPEC.md §1.4.
 */
function validateIntentEnvelope(env) {
  const errors = [];

  if (!_isPlainObject(env)) {
    return { valid: false, errors: ['envelope: must be an object'] };
  }

  let vocab;
  try {
    vocab = _loadVocab();
  } catch (e) {
    return { valid: false, errors: [`vocabulary load failed: ${e.message}`] };
  }

  // Rule 1 — required fields + enum membership
  if (env.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version: must be ${SCHEMA_VERSION}`);
  }
  if (!vocab.intent_types.includes(env.type)) {
    errors.push(`type: must be one of ${vocab.intent_types.join(', ')}`);
  }
  if (!vocab.sources.includes(env.source)) {
    errors.push(`source: must be one of ${vocab.sources.join(', ')}`);
  }
  if (!vocab.actors.includes(env.actor)) {
    errors.push(`actor: must be one of ${vocab.actors.join(', ')}`);
  }
  if (!_isPlainObject(env.constraints)) {
    errors.push('constraints: must be an object');
  }

  // Rule 3 — asOf is a strict ISO-8601 date-time (not merely Date.parse-able)
  if (typeof env.asOf !== 'string' || !ISO_8601.test(env.asOf) || Number.isNaN(Date.parse(env.asOf))) {
    errors.push('asOf: must be a strict ISO-8601 date-time (e.g. 2026-06-30T14:00:00Z)');
  }

  // Rule 2 — constraint keys all known; each value valid
  if (_isPlainObject(env.constraints)) {
    for (const [key, value] of Object.entries(env.constraints)) {
      const spec = vocab.constraint_keys[key];
      if (!spec) {
        errors.push(`constraints.${key}: unknown constraint key`);
        continue;
      }
      _validateConstraintValue(key, spec, value, errors);
    }
  }

  // Rule 4 — extraction present ⟺ source ∈ extraction_sources
  const hasExtraction = env.extraction != null;
  const isExtractionSource = vocab.extraction_sources.includes(env.source);
  if (hasExtraction && !isExtractionSource) {
    errors.push(`extraction: only allowed for sources ${vocab.extraction_sources.join(', ')}`);
  }
  if (!hasExtraction && isExtractionSource) {
    errors.push(`extraction: required for source '${env.source}'`);
  }
  if (hasExtraction) {
    if (!_isPlainObject(env.extraction)) {
      errors.push('extraction: must be an object');
    } else if (typeof env.extraction.confidence !== 'number' ||
               env.extraction.confidence < 0 || env.extraction.confidence > 1) {
      errors.push('extraction.confidence: must be a number in [0, 1]');
    }
  }

  // Rule 5 — actor=system ⟹ source ∈ system_sources
  if (env.actor === 'system' && !vocab.system_sources.includes(env.source)) {
    errors.push(`actor 'system' requires source ∈ ${vocab.system_sources.join(', ')}`);
  }

  // Rules 6 & 7 — intent-specific required constraints
  if (_isPlainObject(env.constraints)) {
    if (vocab.signal_required_intents.includes(env.type) && env.constraints.signal == null) {
      errors.push(`type '${env.type}' requires constraints.signal`);
    }
    if (vocab.readiness_required_intents.includes(env.type) && env.constraints.readiness_inputs == null) {
      errors.push(`type '${env.type}' requires constraints.readiness_inputs`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  buildIntentEnvelope,
  validateIntentEnvelope,
  _resetForTesting,
};
