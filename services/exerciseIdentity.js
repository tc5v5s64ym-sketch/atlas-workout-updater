'use strict';

// ExerciseIdentity — canonical contract (Phase 2 Work item 2; charter row in
// docs/CANONICAL_CONTRACTS.md).
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON and
// the movement-pattern vocabulary. No LLM, no Sheets, no write path, no route.
//
// The IMMUTABLE identity of an exercise. Every name/alias and every stored
// representation is a PROJECTION of this identity:
//   • canonical_name → Log_Cleaned.canonical_exercise
//   • lift_code      → Log_Cleaned.lift_code
//   • muscle_group   → Log_Cleaned.muscle_group
//   • the Exercise_Catalog row and the KB ontology entry (schemas/exercise.schema.json)
// `exercise_id` is the stable, immutable key; renames change a projection, never
// the identity. This is the shape the Phase 5b registry (H-11) will own; it is
// ratified read-only here and is NOT yet wired into production (hence its staged
// entry in config/wiring-allowlist.json until Phase 5b consumes it).
//
// The movement_pattern enum is owned solely by
// config/coaching/movement-patterns/patterns.json — loaded here, never copied —
// so the vocabulary cannot drift; a contracts-integrity test guards that source
// against the KB ontology's inline enum.
//
// Public API:
//   buildExerciseIdentity(params)       → identity object (does NOT validate)
//   validateExerciseIdentity(identity)  → { valid, errors[] }  (total, never throws)
//   SCHEMA_VERSION, MOVEMENT_PATTERNS

const path = require('node:path');
const fs   = require('node:fs');

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'exercise-identity.contract.json');
const PATTERNS_FILE = path.join(__dirname, '..', 'config', 'coaching', 'movement-patterns', 'patterns.json');

const SCHEMA_VERSION = 1;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // kebab-case, immutable stable key

let _contract = null;
let _patterns = null;

function _loadContract() {
  if (!_contract) _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}
function _loadPatterns() {
  if (!_patterns) {
    const j = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf8'));
    _patterns = Object.freeze((Array.isArray(j.patterns) ? j.patterns : []).map((p) => p.id));
  }
  return _patterns;
}
function _resetForTesting() { _contract = null; _patterns = null; }

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble an ExerciseIdentity. Sets schema_version, defaults the nullable
 * projections to null and aliases to []. Does NOT validate.
 */
function buildExerciseIdentity(params) {
  const p = _isPlainObject(params) ? params : {};
  return {
    schema_version:   SCHEMA_VERSION,
    exercise_id:      p.exercise_id,
    canonical_name:   p.canonical_name,
    lift_code:        p.lift_code != null ? p.lift_code : null,
    muscle_group:     p.muscle_group != null ? p.muscle_group : null,
    movement_pattern: p.movement_pattern != null ? p.movement_pattern : null,
    aliases:          Array.isArray(p.aliases) ? p.aliases : [],
  };
}

// ─── validator (total; never throws) ────────────────────────────────────────────

function validateExerciseIdentity(identity) {
  if (!_isPlainObject(identity)) return { valid: false, errors: ['identity: must be an object'] };

  let patterns;
  try { _loadContract(); patterns = new Set(_loadPatterns()); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }

  const errors = [];

  if (identity.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  if (!_isNonEmptyString(identity.exercise_id)) errors.push('exercise_id: must be a non-empty string');
  else if (!ID_RE.test(identity.exercise_id)) errors.push(`exercise_id: '${identity.exercise_id}' must be kebab-case (the immutable stable key)`);

  if (!_isNonEmptyString(identity.canonical_name)) errors.push('canonical_name: must be a non-empty string');

  // Nullable projections: a non-empty string or null (unset).
  if (identity.lift_code != null && !_isNonEmptyString(identity.lift_code)) errors.push('lift_code: must be a non-empty string or null');
  if (identity.muscle_group != null && !_isNonEmptyString(identity.muscle_group)) errors.push('muscle_group: must be a non-empty string or null');
  if (identity.movement_pattern != null && !patterns.has(identity.movement_pattern)) {
    errors.push(`movement_pattern: '${identity.movement_pattern}' is not a known movement pattern`);
  }

  // Aliases: an array of unique non-empty strings; the canonical_name is the
  // identity, not one of its own aliases.
  if (!Array.isArray(identity.aliases)) {
    errors.push('aliases: must be an array');
  } else {
    const seen = new Set();
    identity.aliases.forEach((a, i) => {
      if (!_isNonEmptyString(a)) { errors.push(`aliases[${i}]: must be a non-empty string`); return; }
      const key = a.trim().toLowerCase();
      if (seen.has(key)) errors.push(`aliases[${i}]: duplicate alias '${a}'`);
      seen.add(key);
    });
    if (_isNonEmptyString(identity.canonical_name) && seen.has(identity.canonical_name.trim().toLowerCase())) {
      errors.push('aliases: must not include canonical_name (it is the identity, not an alias)');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  buildExerciseIdentity,
  validateExerciseIdentity,
  get MOVEMENT_PATTERNS() { return [..._loadPatterns()]; },
  _resetForTesting,
};
