'use strict';

// VolumeModule — pure read-only functions for per-muscle set counting and
// MEV/MAV/MRV landmark classification. No Sheets access, no side effects.
//
// Volume is counted from primary muscles only. Secondary muscles provide
// indirect stimulus but are excluded from direct set counts per the RP
// practitioner convention used here.
//
// Muscle names from the exercise ontology may include parenthetical
// qualifiers (e.g. "quadriceps (rectus femoris, ...)"). These are
// normalised to the base name before landmark lookup.

const path = require('node:path');
const fs = require('node:fs');
const { getExerciseById } = require('./exerciseLookupModule');

const VOLUME_DIR = path.join(__dirname, '..', 'config', 'coaching', 'volume');

let _config = null;

// Strips a trailing parenthetical qualifier and lowercases.
// "Quadriceps (rectus femoris, ...)" → "quadriceps"
function _normalizeMuscle(name) {
  return name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function _load() {
  if (_config) return _config;
  const data = JSON.parse(fs.readFileSync(path.join(VOLUME_DIR, 'landmarks.json'), 'utf8'));

  // Key: normalised muscle name → landmark object (already normalised keys in the JSON)
  const byMuscle = new Map();
  for (const [canonical, landmark] of Object.entries(data.landmarks)) {
    byMuscle.set(canonical.toLowerCase(), { muscle: canonical, ...landmark });
  }

  _config = { data, byMuscle };
  return _config;
}

// Returns the { mev, mav, mrv } landmark for a muscle (after name normalisation),
// or null if the muscle is not volume-tracked.
function getVolumeLandmarks(muscleGroup) {
  if (typeof muscleGroup !== 'string' || !muscleGroup) return null;
  return _load().byMuscle.get(_normalizeMuscle(muscleGroup)) ?? null;
}

// Returns all tracked muscles as an array of { muscle, mev, mav, mrv, ... } objects.
function getAllVolumeLandmarks() {
  return Array.from(_load().byMuscle.values());
}

// Computes direct (primary-only) sets contributed to each muscle by one exercise.
// Returns a plain object { [canonicalMuscle]: sets }.
function computeExerciseSets(exerciseId, numSets) {
  if (typeof exerciseId !== 'string' || !exerciseId) return {};
  if (typeof numSets !== 'number' || numSets <= 0) return {};
  const exercise = getExerciseById(exerciseId);
  if (!exercise) return {};

  const result = {};
  for (const muscle of (exercise.primary_muscles || [])) {
    const key = _normalizeMuscle(muscle);
    result[key] = (result[key] || 0) + numSets;
  }
  return result;
}

// Computes total primary-muscle sets for a session.
// Input: array of { exerciseId: string, sets: number }
// Returns a plain object { [muscle]: totalSets }.
function computeSessionSets(exercises) {
  if (!Array.isArray(exercises)) return {};
  const totals = {};
  for (const entry of exercises) {
    if (!entry || typeof entry !== 'object') continue;
    const { exerciseId, sets } = entry;
    const contribution = computeExerciseSets(exerciseId, sets);
    for (const [muscle, count] of Object.entries(contribution)) {
      totals[muscle] = (totals[muscle] || 0) + count;
    }
  }
  return totals;
}

// Aggregates multiple session set maps (output of computeSessionSets) into weekly totals.
// Input: array of plain objects { [muscle]: sets }
// Returns a plain object { [muscle]: totalSets }.
function computeWeeklySets(sessions) {
  if (!Array.isArray(sessions)) return {};
  const totals = {};
  for (const session of sessions) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) continue;
    for (const [muscle, count] of Object.entries(session)) {
      if (typeof count === 'number' && count > 0) {
        totals[muscle] = (totals[muscle] || 0) + count;
      }
    }
  }
  return totals;
}

// Classifies weekly set count against landmarks for a muscle.
// Returns one of:
//   'below_mev'  — sets < MEV (insufficient for adaptation)
//   'mev_to_mav' — MEV ≤ sets < MAV (effective range)
//   'mav_to_mrv' — MAV ≤ sets ≤ MRV (high stimulus, still recoverable)
//   'above_mrv'  — sets > MRV (likely to impair recovery)
//   null          — no landmark for this muscle or invalid input
function volumeZone(weeklySets, muscleGroup) {
  if (typeof weeklySets !== 'number' || weeklySets < 0) return null;
  const landmarks = getVolumeLandmarks(muscleGroup);
  if (!landmarks) return null;
  const { mev, mav, mrv } = landmarks;
  if (weeklySets < mev) return 'below_mev';
  if (weeklySets < mav) return 'mev_to_mav';
  if (weeklySets <= mrv) return 'mav_to_mrv';
  return 'above_mrv';
}

// Test-only: reset the in-memory cache.
function _resetForTesting() {
  _config = null;
}

module.exports = {
  getVolumeLandmarks,
  getAllVolumeLandmarks,
  computeExerciseSets,
  computeSessionSets,
  computeWeeklySets,
  volumeZone,
  _resetForTesting,
};
