'use strict';

// SafetyRulesModule — read-only access to the traffic-light classifier and
// safe defaults from config/coaching/rules/safety.rules.json.
// Loads lazily on first call. No Sheets access, no side effects.
//
// The safety layer is the most conservative module and can override all others.

const path = require('node:path');
const fs = require('node:fs');

const RULES_PATH = path.join(
  __dirname, '..', 'config', 'coaching', 'rules', 'safety.rules.json'
);

let _catalog = null;

function _load() {
  if (_catalog) return _catalog;
  const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

  const byState = new Map();
  for (const entry of data.traffic_light) {
    byState.set(entry.state, entry);
  }

  _catalog = {
    trafficLight: data.traffic_light,
    byState,
    safeDefaults: data.safe_defaults,
  };
  return _catalog;
}

// Returns all traffic-light states in config order (defensive copy).
function getTrafficLight() {
  return _load().trafficLight.slice();
}

// Returns the traffic-light record for the given state ('green'|'yellow'|'red'),
// or null if not found.
function getTrafficLightState(state) {
  if (typeof state !== 'string' || !state) return null;
  return _load().byState.get(state) ?? null;
}

// Returns the safe defaults object:
// { on_uncertainty, never: [...], onboarding_screen, confidence_inversion }
function getSafeDefaults() {
  return _load().safeDefaults;
}

// Test-only: reset the in-memory cache.
function _resetForTesting() {
  _catalog = null;
}

module.exports = {
  getTrafficLight,
  getTrafficLightState,
  getSafeDefaults,
  _resetForTesting,
};
