'use strict';

// STATUS (2026-07 architecture audit): DARK — no runtime consumer; wire-in-vs-
// retire decision filed in BACKLOG.md (dark-module disposition item). NOTE the
// near-name trap: this taxonomy LOOKUP is NOT the manifest's 'movement_patterns'
// capability — that slot (services/movementPatternModule.js#classifyPattern,
// status 'missing') is an unbuilt CLASSIFIER placeholder, like equipmentModule.
// The live movement-pattern map consumers use is services/movementPattern.js.

// MovementPatternsModule — read-only access to the movement-pattern taxonomy
// from config/coaching/movement-patterns/patterns.json.
// Loads lazily on first call. No Sheets access, no side effects.

const path = require('node:path');
const fs = require('node:fs');

const PATTERNS_PATH = path.join(
  __dirname, '..', 'config', 'coaching', 'movement-patterns', 'patterns.json'
);

let _catalog = null;

function _load() {
  if (_catalog) return _catalog;
  const data = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf8'));

  const byId = new Map();
  const byFamily = new Map();
  const familyOrder = [];

  for (const pattern of data.patterns) {
    byId.set(pattern.id, pattern);

    if (!byFamily.has(pattern.family)) {
      byFamily.set(pattern.family, []);
      familyOrder.push(pattern.family);
    }
    byFamily.get(pattern.family).push(pattern);
  }

  _catalog = {
    patterns: data.patterns,
    byId,
    byFamily,
    familyOrder,
  };
  return _catalog;
}

// Returns all pattern records in config order (defensive copy).
function getAllPatterns() {
  return _load().patterns.slice();
}

// Returns all pattern ids in config order.
function getAllPatternIds() {
  return _load().patterns.map(p => p.id);
}

// Returns the pattern record for the given id, or null if not found.
function getPattern(id) {
  if (typeof id !== 'string' || !id) return null;
  return _load().byId.get(id) ?? null;
}

// Returns all patterns belonging to the given family (defensive copy), or [] if none.
function getPatternsByFamily(family) {
  if (typeof family !== 'string' || !family) return [];
  return (_load().byFamily.get(family) ?? []).slice();
}

// Returns all distinct family names in first-appearance order.
function getFamilies() {
  return _load().familyOrder.slice();
}

// Test-only: reset the in-memory cache.
function _resetForTesting() {
  _catalog = null;
}

module.exports = {
  getAllPatterns,
  getAllPatternIds,
  getPattern,
  getPatternsByFamily,
  getFamilies,
  _resetForTesting,
};
