'use strict';

// EvidenceTiersModule — read-only access to the knowledge-trustworthiness
// ranking from config/coaching/evidence-tiers.json.
// Loads lazily on first call. No Sheets access, no side effects.

const path = require('node:path');
const fs = require('node:fs');

const TIERS_PATH = path.join(
  __dirname, '..', 'config', 'coaching', 'evidence-tiers.json'
);

let _catalog = null;

function _load() {
  if (_catalog) return _catalog;
  const data = JSON.parse(fs.readFileSync(TIERS_PATH, 'utf8'));

  const byTier = new Map();
  for (const tier of data.tiers) {
    byTier.set(tier.tier, tier);
  }

  _catalog = {
    tiers: data.tiers,
    byTier,
    excluded: data.excluded,
  };
  return _catalog;
}

// Returns all tier records in config order (defensive copy).
function getAllTiers() {
  return _load().tiers.slice();
}

// Returns the tier record for the given tier number (1–5), or null if not found.
function getTier(tierNumber) {
  if (typeof tierNumber !== 'number' || !Number.isInteger(tierNumber)) return null;
  return _load().byTier.get(tierNumber) ?? null;
}

// Returns the excluded-sources descriptor object.
function getExcluded() {
  return _load().excluded;
}

// Test-only: reset the in-memory cache.
function _resetForTesting() {
  _catalog = null;
}

module.exports = {
  getAllTiers,
  getTier,
  getExcluded,
  _resetForTesting,
};
