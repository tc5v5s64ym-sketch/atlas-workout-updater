'use strict';

// P0 AC12 surfacing — snap a recommended BARBELL working weight to a loadable total
// and attach a short note, GATED on the lift actually being a barbell movement per
// the exercise KB (data/exercise_catalog.v1.json, via exerciseResolver).
//
// The pure math lives in services/barbellLoadability.js (roundToLoadableBarbell);
// this module only (a) decides whether a named lift is a barbell movement and
// (b) applies the snap to a recommendation exercise's target_weight, leaving a
// `loadability_note` when the value actually changed.
//
// READ-ONLY / deterministic: it informs the recommendation/coach/composer surface
// only — it never touches the write path, schema, or proof fields. Conservative by
// design: a lift that doesn't confidently classify as a barbell movement, or whose
// target is already loadable, passes through UNCHANGED (no snap, no note).

const { roundToLoadableBarbell } = require('./barbellLoadability');
const { resolveExercise } = require('./exerciseResolver');

// True when the named lift loads on a barbell — `category === 'barbell'` or its
// `equipment` list includes `'barbell'`, per the exercise KB. An unknown / unmatched
// name returns false (refuse to guess → no snap).
function isBarbellExercise(name) {
  if (!name) return false;
  const resolved = resolveExercise(String(name));
  const rec = resolved && resolved.record;
  if (!rec) return false;
  if (rec.category === 'barbell') return true;
  return Array.isArray(rec.equipment) && rec.equipment.includes('barbell');
}

// Snap one recommendation exercise's `target_weight` to a loadable barbell total
// when it is a barbell lift. Returns the SAME object when nothing changes; a NEW
// object (with the snapped `target_weight` + a `loadability_note`) when it does.
// `opts` forwards { bar, step } to roundToLoadableBarbell (defaults 45 / 5).
function applyBarbellLoadability(exercise, opts = {}) {
  if (!exercise || typeof exercise !== 'object') return exercise;
  const w = Number(exercise.target_weight);
  if (!Number.isFinite(w) || w <= 0) return exercise;
  if (!isBarbellExercise(exercise.exercise || exercise.name)) return exercise;
  const snap = roundToLoadableBarbell(w, opts);
  if (!snap || snap.weight == null || !snap.rounded) return exercise; // already loadable → untouched
  return { ...exercise, target_weight: snap.weight, loadability_note: snap.note };
}

// Map applyBarbellLoadability over a recommendation's exercises array. A non-array
// input is returned as-is so callers can apply it defensively.
function applyBarbellLoadabilityToExercises(exercises, opts = {}) {
  if (!Array.isArray(exercises)) return exercises;
  return exercises.map(ex => applyBarbellLoadability(ex, opts));
}

module.exports = { isBarbellExercise, applyBarbellLoadability, applyBarbellLoadabilityToExercises };
