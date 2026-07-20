'use strict';

// AthleteContext — canonical contract (Phase 2 Work item 2; charter row in
// docs/CANONICAL_CONTRACTS.md).
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON and
// the canonical goal vocabulary. No LLM, no Sheets, no write path, no route.
//
// The durable athlete profile the Brain reads: training goal, training level,
// population, and equipment profile. This names and versions the shape that lives
// today as `StateSnapshot.profile` in services/stateAssembly.js
// (profile_goal / training_level / population), plus equipment_profile. It is
// ratified read-only here and is NOT yet wired into production (hence its staged
// entry in config/wiring-allowlist.json); Phase 5e plumbs the fields from their
// defined sources and closes finding H-07.
//
// Vocabulary ownership:
//   • profile_goal is validated against services/trainingKnowledge.js
//     TRAINING_GOALS (the single owner) — loaded here, never copied.
//   • training_level is a closed enum in the contract JSON.
//   • population and equipment_profile are nullable and shape-only in v1 (no
//     authoritative source/enum yet — see the contract _meta notes); a later
//     schema_version closes them once Phase 5e's readers exist.
//
// Nullable fields follow the explicit-null rule: each must be PRESENT (own
// property) with value null or valid — an omitted key is rejected.
//
// Public API:
//   buildAthleteContext(params)      → context object (does NOT validate)
//   validateAthleteContext(context)  → { valid, errors[] }  (total, never throws)
//   SCHEMA_VERSION, TRAINING_LEVELS, CANONICAL_GOALS

const path = require('node:path');
const fs   = require('node:fs');

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'athlete-context.contract.json');

const SCHEMA_VERSION = 1;

let _contract = null;
let _goals = null;

function _loadContract() {
  if (!_contract) _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}
function _loadGoals() {
  if (!_goals) {
    const { TRAINING_GOALS } = require('./trainingKnowledge'); // single owner of the goal vocabulary
    _goals = Object.freeze(Object.keys(TRAINING_GOALS));
  }
  return _goals;
}
function _resetForTesting() { _contract = null; _goals = null; }

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble an AthleteContext. Sets schema_version and defaults every nullable
 * field to null. Does NOT validate.
 */
function buildAthleteContext(params) {
  const p = _isPlainObject(params) ? params : {};
  return {
    schema_version:    SCHEMA_VERSION,
    profile_goal:      p.profile_goal != null ? p.profile_goal : null,
    training_level:    p.training_level != null ? p.training_level : null,
    population:        p.population != null ? p.population : null,
    equipment_profile: p.equipment_profile != null ? p.equipment_profile : null,
  };
}

// ─── validator (total; never throws) ────────────────────────────────────────────

function validateAthleteContext(context) {
  if (!_isPlainObject(context)) return { valid: false, errors: ['context: must be an object'] };

  let contract, goals;
  try { contract = _loadContract(); goals = new Set(_loadGoals()); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }
  const levels = new Set(contract.training_levels);

  const errors = [];
  const _has = (k) => Object.prototype.hasOwnProperty.call(context, k);

  if (context.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  // Every nullable field must be PRESENT (explicit-null rule); value null or valid.
  // `!== null` is strict so an explicit `undefined` value is rejected too.
  if (!_has('profile_goal')) errors.push('profile_goal: must be present (null or a canonical training goal)');
  else if (context.profile_goal !== null && !goals.has(context.profile_goal)) errors.push(`profile_goal: '${context.profile_goal}' is not a canonical training goal`);

  if (!_has('training_level')) errors.push('training_level: must be present (null or a known training level)');
  else if (context.training_level !== null && !levels.has(context.training_level)) errors.push(`training_level: '${context.training_level}' is not a known training level`);

  if (!_has('population')) errors.push('population: must be present (null or a non-empty string)');
  else if (context.population !== null && !_isNonEmptyString(context.population)) errors.push('population: must be a non-empty string or null');

  if (!_has('equipment_profile')) errors.push('equipment_profile: must be present (null or an object)');
  else if (context.equipment_profile !== null && !_isPlainObject(context.equipment_profile)) errors.push('equipment_profile: must be a plain object or null');

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  buildAthleteContext,
  validateAthleteContext,
  get TRAINING_LEVELS() { return [..._loadContract().training_levels]; },
  get CANONICAL_GOALS() { return [..._loadGoals()]; },
  _resetForTesting,
};
