'use strict';

// EntityResolutionModule — maps raw exercise names / colloquialisms → canonical
// exercise IDs in the Atlas ontology (config/coaching/exercises/).
//
// Prime directive: the engine resolves names; the LLM never maps exercises.
// Safe-ladder position: read-only name resolution (roadmap Phase 4, PR 18).
// Depends on: config/coaching/exercises/_index.json + individual exercise files.
//
// Public API:
//   resolveExercise(rawName)  → { exerciseId, name, confidence, method } | null
//   listExerciseIds()         → [string]
//
// Confidence / method values (highest → lowest priority):
//   'exact'       — rawName matched the exercise ID directly (e.g. 'back-squat')
//   'name'        — matched the canonical display name (e.g. 'Back Squat')
//   'alias'       — matched an alias listed in the exercise JSON
//   'progression' — matched a progression variant listed in the exercise JSON
//
// Returns null when no match is found.

const path = require('node:path');
const fs   = require('node:fs');

const EXERCISES_DIR = path.join(__dirname, '..', 'config', 'coaching', 'exercises');
const INDEX_FILE    = path.join(EXERCISES_DIR, '_index.json');

let _resolveMap = null;

const PRIORITY = { exact: 0, name: 1, alias: 2, progression: 3 };

// Normalize a string: lowercase, collapse hyphens and apostrophes to spaces,
// collapse whitespace. Allows 'low-bar back squat' to match 'low bar back squat'.
function _normalize(str) {
  if (typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/[-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build the resolution map from the exercise ontology. Lazy-built once and cached.
// Returns Map<key, { exerciseId, name, confidence, method }>.
function _buildMap() {
  const map = new Map();

  let index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch {
    return map;
  }

  if (!Array.isArray(index.exercises)) return map;

  function addEntry(key, entry) {
    const existing = map.get(key);
    if (!existing || PRIORITY[entry.method] < PRIORITY[existing.method]) {
      map.set(key, entry);
    }
  }

  for (const meta of index.exercises) {
    if (!meta || typeof meta.id !== 'string' || typeof meta.name !== 'string') continue;

    const { id, name } = meta;

    // 1. Exact exercise-id match.
    addEntry(id, { exerciseId: id, name, confidence: 'exact', method: 'exact' });

    // 2. Canonical display name — both raw-lowercase and normalized forms.
    const nameLower = name.toLowerCase();
    const nameNorm  = _normalize(name);
    addEntry(nameLower, { exerciseId: id, name, confidence: 'name', method: 'name' });
    if (nameNorm !== nameLower) {
      addEntry(nameNorm, { exerciseId: id, name, confidence: 'name', method: 'name' });
    }

    // Load the individual exercise file for aliases and progressions.
    let exercise = null;
    try {
      const file = meta.file || `${id}.json`;
      exercise = JSON.parse(fs.readFileSync(path.join(EXERCISES_DIR, file), 'utf8'));
    } catch {
      continue;
    }

    // 3. Aliases.
    if (Array.isArray(exercise.aliases)) {
      for (const alias of exercise.aliases) {
        if (typeof alias !== 'string' || !alias.trim()) continue;
        addEntry(alias.toLowerCase(), { exerciseId: id, name, confidence: 'alias', method: 'alias' });
        const norm = _normalize(alias);
        if (norm !== alias.toLowerCase()) {
          addEntry(norm, { exerciseId: id, name, confidence: 'alias', method: 'alias' });
        }
      }
    }

    // 4. Progressions — named variants that are not their own exercise in the ontology.
    //    Entries already in the map with a higher-priority method (e.g. name match for
    //    goblet-squat) won't be overwritten, so "goblet squat" → goblet-squat is safe.
    if (Array.isArray(exercise.progressions)) {
      for (const prog of exercise.progressions) {
        if (typeof prog !== 'string' || !prog.trim()) continue;
        addEntry(prog.toLowerCase(), { exerciseId: id, name, confidence: 'progression', method: 'progression' });
        const norm = _normalize(prog);
        if (norm !== prog.toLowerCase()) {
          addEntry(norm, { exerciseId: id, name, confidence: 'progression', method: 'progression' });
        }
      }
    }
  }

  return map;
}

function _getMap() {
  if (!_resolveMap) _resolveMap = _buildMap();
  return _resolveMap;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Resolve a raw exercise name or id to its canonical exercise entry.
// Returns { exerciseId, name, confidence, method } or null if unresolvable.
function resolveExercise(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) return null;

  const map  = _getMap();
  const raw  = rawName.trim();

  // Exact exercise-id match (fastest path).
  const exact = map.get(raw);
  if (exact && exact.method === 'exact') return exact;

  // Lowercase match.
  const lower = raw.toLowerCase();
  const lowerMatch = map.get(lower);
  if (lowerMatch) return lowerMatch;

  // Normalized match (strips hyphens, collapses whitespace).
  const norm = _normalize(raw);
  if (norm !== lower) {
    const normMatch = map.get(norm);
    if (normMatch) return normMatch;
  }

  return null;
}

// Return a sorted list of all canonical exercise IDs in the ontology.
function listExerciseIds() {
  const map = _getMap();
  const ids = new Set();
  for (const entry of map.values()) ids.add(entry.exerciseId);
  return [...ids].sort();
}

// Flush the module-scope cache — for testing only.
function _resetCache() {
  _resolveMap = null;
}

module.exports = { resolveExercise, listExerciseIds, _resetCache };
