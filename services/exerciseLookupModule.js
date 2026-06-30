'use strict';

// ExerciseLookupModule — read-only index over the exercise ontology.
// Loads config/coaching/exercises/ lazily on first call and caches the
// result in-process. Exposes pure lookup functions. No Sheets access, no side effects.
//
// Future modules (VolumeModule, FatigueModule, ProgressionModule) call
// these functions instead of reading exercise files directly.

const path = require('node:path');
const fs = require('node:fs');

const EXERCISES_DIR = path.join(__dirname, '..', 'config', 'coaching', 'exercises');

// Loaded lazily on first call; reset only in tests via _resetForTesting().
let _catalog = null;

function _load() {
  if (_catalog) return _catalog;

  const indexPath = path.join(EXERCISES_DIR, '_index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  const byId = new Map();
  const byMovementPattern = new Map();
  const byMuscle = new Map();  // covers both primary and secondary

  for (const entry of index.exercises) {
    const filePath = path.join(EXERCISES_DIR, entry.file);
    const exercise = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    byId.set(exercise.id, exercise);

    // Index by movement pattern
    const pattern = exercise.movement_pattern;
    if (!byMovementPattern.has(pattern)) byMovementPattern.set(pattern, []);
    byMovementPattern.get(pattern).push(exercise);

    // Index by muscle — primary and secondary combined
    const muscles = [
      ...(exercise.primary_muscles || []),
      ...(exercise.secondary_muscles || []),
    ];
    for (const muscle of muscles) {
      const key = muscle.toLowerCase();
      if (!byMuscle.has(key)) byMuscle.set(key, []);
      // Avoid duplicates if a muscle appears in both primary and secondary
      if (!byMuscle.get(key).includes(exercise)) {
        byMuscle.get(key).push(exercise);
      }
    }
  }

  _catalog = { byId, byMovementPattern, byMuscle };
  return _catalog;
}

// Returns the full exercise record for the given id, or null if not found.
function getExerciseById(id) {
  if (typeof id !== 'string' || !id) return null;
  return _load().byId.get(id) ?? null;
}

// Returns all exercises whose movement_pattern matches the given value.
// Returns an empty array if the pattern is unknown.
function getExercisesByMovementPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) return [];
  return (_load().byMovementPattern.get(pattern) ?? []).slice();
}

// Returns all exercises that involve the given muscle (primary or secondary).
// Comparison is case-insensitive.
function getExercisesByMuscle(muscleName) {
  if (typeof muscleName !== 'string' || !muscleName) return [];
  return (_load().byMuscle.get(muscleName.toLowerCase()) ?? []).slice();
}

// Returns every exercise in the catalog.
function getAllExercises() {
  return Array.from(_load().byId.values());
}

// Returns the set of distinct movement patterns present in the catalog.
function getMovementPatterns() {
  return Array.from(_load().byMovementPattern.keys());
}

// Returns true if the given id is present in the catalog.
function hasExercise(id) {
  return getExerciseById(id) !== null;
}

// Test-only: reset the in-memory cache so each test file gets a fresh load.
// Never call in production code.
function _resetForTesting() {
  _catalog = null;
}

module.exports = {
  getExerciseById,
  getExercisesByMovementPattern,
  getExercisesByMuscle,
  getAllExercises,
  getMovementPatterns,
  hasExercise,
  _resetForTesting,
};
