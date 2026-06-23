'use strict';

// Exercise Knowledge Base — schema, controlled vocabularies, and validator.
//
// PURE. No I/O. This module defines the contract for the two KB data structures
// (data/exercise_catalog.v1.json + data/exercise_aliases.v1.json) and validates
// them. It is the single source of truth for the allowed enum values, so the
// resolver, the build step, and the tests can all agree.
//
// REFERENCE-ONLY: nothing here touches Google Sheets, the parser grammar, the
// write path, or the trust loop. `exercise_id` is a NEW snake_case identifier for
// recognition; it is distinct from the Sheets/enrichment `lift_code` (BEN01…).
// See docs/EXERCISE_KB_WIRING.md for how the two relate.

// ── Controlled vocabularies ───────────────────────────────────────────────────

const EXERCISE_TYPES = Object.freeze([
  'main_lift', 'accessory', 'isolation', 'bodyweight',
  'conditioning', 'olympic', 'strongman', 'rehabilitation', 'mobility',
]);

// Owner-specified generic taxonomy for the KB. NOTE: this is intentionally NOT
// the engine's services/movementPattern.js VALID_PATTERNS set (which is Atlas's
// internal 14-pattern vocabulary). The wiring plan maps KB → engine patterns.
const MOVEMENT_PATTERNS = Object.freeze([
  'squat', 'hinge', 'lunge',
  'horizontal_push', 'horizontal_pull', 'vertical_push', 'vertical_pull',
  'carry', 'rotation', 'anti_rotation', 'flexion', 'extension',
  'locomotion', 'conditioning',
]);

const DIFFICULTIES = Object.freeze(['beginner', 'intermediate', 'advanced']);

const ALIAS_TYPES = Object.freeze([
  'common_name', 'abbreviation', 'misspelling', 'pluralization',
  'commercial_gym_name', 'bodybuilding_name', 'crossfit_name', 'british_name',
  'shorthand', 'equipment_variant',
]);

// Muscle taxonomy — aligned to services/muscleCoverage.js TAXONOMY (17) so the KB
// is usable by the existing engine without a second muscle vocabulary.
const MUSCLES = Object.freeze([
  'chest', 'front_delts', 'side_delts', 'rear_delts', 'traps',
  'lats', 'upper_back', 'lower_back', 'biceps', 'triceps', 'forearms',
  'quads', 'hamstrings', 'glutes', 'calves', 'abs', 'obliques',
]);

const EQUIPMENT = Object.freeze([
  'barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band',
  'smith_machine', 'ez_bar', 'trap_bar', 'sled', 'medicine_ball', 'sandbag',
  'plate', 'bench', 'box', 'rings', 'trx', 'treadmill', 'bike', 'rower',
  'elliptical', 'jump_rope', 'stairmaster', 'ski_erg', 'none',
]);

const CATALOG_FIELDS = Object.freeze([
  'exercise_id', 'name', 'category', 'exercise_type', 'movement_pattern',
  'primary_muscles', 'secondary_muscles', 'equipment', 'difficulty',
  'fatigue_score', 'skill_score', 'substitution_group',
  'is_unilateral', 'is_bodyweight', 'is_machine', 'atlas_tags',
]);

const ID_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

// Recognition normalization for the KB. Based on services/exerciseEnrichment.js
// normalizeExerciseKey, but DELIBERATELY broader: it also folds hyphens/underscores
// to spaces and trims, so "bent-over row" and "t-bar row" collapse to the same key
// as their spaced forms (better recognition). It is therefore a SUPERSET, not a
// mirror — it diverges from normalizeExerciseKey on hyphenated names. The
// exercise_id ↔ lift_code crosswalk (EXERCISE_KB_WIRING.md step 3) must reconcile
// the two normalizers before the layers compare normalized forms.
function normalizeExerciseText(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/['’‘"“”]/g, '')
    .replace(/[()\[\]{}:;,.\/\\+*?^$|]/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Validation ────────────────────────────────────────────────────────────────

function isIntInRange(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function validateCatalogRecord(rec, i) {
  const errs = [];
  const where = `catalog[${i}]${rec && rec.exercise_id ? ` (${rec.exercise_id})` : ''}`;
  if (!rec || typeof rec !== 'object') return [`${where}: not an object`];

  for (const f of CATALOG_FIELDS) {
    if (!(f in rec)) errs.push(`${where}: missing field "${f}"`);
  }
  if (typeof rec.exercise_id !== 'string' || !ID_RE.test(rec.exercise_id)) {
    errs.push(`${where}: exercise_id must be lower snake_case`);
  }
  if (typeof rec.name !== 'string' || !rec.name.trim()) errs.push(`${where}: name required`);
  if (!EXERCISE_TYPES.includes(rec.exercise_type)) errs.push(`${where}: bad exercise_type "${rec.exercise_type}"`);
  if (!MOVEMENT_PATTERNS.includes(rec.movement_pattern)) errs.push(`${where}: bad movement_pattern "${rec.movement_pattern}"`);
  if (!DIFFICULTIES.includes(rec.difficulty)) errs.push(`${where}: bad difficulty "${rec.difficulty}"`);
  if (typeof rec.substitution_group !== 'string' || !ID_RE.test(rec.substitution_group)) {
    errs.push(`${where}: substitution_group must be lower snake_case`);
  }
  for (const key of ['primary_muscles', 'secondary_muscles']) {
    if (!Array.isArray(rec[key])) { errs.push(`${where}: ${key} must be an array`); continue; }
    for (const m of rec[key]) if (!MUSCLES.includes(m)) errs.push(`${where}: ${key} has unknown muscle "${m}"`);
  }
  if (!Array.isArray(rec.equipment) || rec.equipment.length === 0) {
    errs.push(`${where}: equipment must be a non-empty array`);
  } else {
    for (const e of rec.equipment) if (!EQUIPMENT.includes(e)) errs.push(`${where}: unknown equipment "${e}"`);
  }
  if (!isIntInRange(rec.fatigue_score, 1, 10)) errs.push(`${where}: fatigue_score must be int 1-10`);
  if (!isIntInRange(rec.skill_score, 1, 10)) errs.push(`${where}: skill_score must be int 1-10`);
  for (const b of ['is_unilateral', 'is_bodyweight', 'is_machine']) {
    if (typeof rec[b] !== 'boolean') errs.push(`${where}: ${b} must be boolean`);
  }
  if (!Array.isArray(rec.atlas_tags)) errs.push(`${where}: atlas_tags must be an array`);
  return errs;
}

function validateAliasRecord(a, i, idSet) {
  const errs = [];
  const where = `aliases[${i}]${a && a.alias ? ` ("${a.alias}")` : ''}`;
  if (!a || typeof a !== 'object') return [`${where}: not an object`];
  if (typeof a.alias !== 'string' || !a.alias.trim()) errs.push(`${where}: alias required`);
  else if (a.alias !== a.alias.toLowerCase()) errs.push(`${where}: alias must be lowercase`);
  if (!idSet.has(a.exercise_id)) errs.push(`${where}: exercise_id "${a.exercise_id}" not in catalog`);
  if (!ALIAS_TYPES.includes(a.alias_type)) errs.push(`${where}: bad alias_type "${a.alias_type}"`);
  if (typeof a.confidence !== 'number' || a.confidence <= 0 || a.confidence > 1) {
    errs.push(`${where}: confidence must be in (0, 1]`);
  }
  return errs;
}

// Validate the whole KB. Returns { ok, errors, stats }.
function validateKb({ catalog, aliases }) {
  const errors = [];
  if (!Array.isArray(catalog)) return { ok: false, errors: ['catalog is not an array'], stats: {} };
  if (!Array.isArray(aliases)) return { ok: false, errors: ['aliases is not an array'], stats: {} };

  const idSet = new Set();
  const dupIds = new Set();
  const canonicalNameToId = new Map(); // normalized canonical name -> exercise_id
  catalog.forEach((rec, i) => {
    validateCatalogRecord(rec, i).forEach(e => errors.push(e));
    if (rec && rec.exercise_id) {
      if (idSet.has(rec.exercise_id)) dupIds.add(rec.exercise_id);
      idSet.add(rec.exercise_id);
      if (typeof rec.name === 'string') canonicalNameToId.set(normalizeExerciseText(rec.name), rec.exercise_id);
    }
  });
  for (const d of dupIds) errors.push(`duplicate exercise_id: "${d}"`);

  // Alias uniqueness on the NORMALIZED form. A normalized alias that points at two
  // different exercise_ids is a hard ambiguity error (must be resolved, not guessed).
  const aliasToId = new Map();
  aliases.forEach((a, i) => {
    validateAliasRecord(a, i, idSet).forEach(e => errors.push(e));
    if (a && typeof a.alias === 'string') {
      const norm = normalizeExerciseText(a.alias);
      if (aliasToId.has(norm) && aliasToId.get(norm) !== a.exercise_id) {
        errors.push(`ambiguous alias "${a.alias}" (norm "${norm}") maps to both ${aliasToId.get(norm)} and ${a.exercise_id}`);
      }
      // A canonical name must resolve to its OWN record — an alias may never shadow
      // a different exercise's canonical name.
      if (canonicalNameToId.has(norm) && canonicalNameToId.get(norm) !== a.exercise_id) {
        errors.push(`alias "${a.alias}" (norm "${norm}") shadows the canonical name of ${canonicalNameToId.get(norm)} but maps to ${a.exercise_id}`);
      }
      aliasToId.set(norm, a.exercise_id);
    }
  });

  // Every catalog entry must be reachable by at least one alias.
  const covered = new Set([...aliasToId.values()]);
  for (const id of idSet) if (!covered.has(id)) errors.push(`exercise_id "${id}" has no aliases`);

  return {
    ok: errors.length === 0,
    errors,
    stats: { catalog: catalog.length, aliases: aliases.length, unique_ids: idSet.size, unique_aliases: aliasToId.size },
  };
}

module.exports = {
  EXERCISE_TYPES, MOVEMENT_PATTERNS, DIFFICULTIES, ALIAS_TYPES, MUSCLES, EQUIPMENT,
  CATALOG_FIELDS, ID_RE,
  normalizeExerciseText, validateKb, validateCatalogRecord, validateAliasRecord,
};
