'use strict';

// FatigueRulesModule — read-only access to recovery priors, readiness inputs,
// and deload triggers from config/coaching/rules/fatigue.rules.json.
// Loads lazily on first call. No Sheets access, no side effects.

const path = require('node:path');
const fs = require('node:fs');

const RULES_PATH = path.join(
  __dirname, '..', 'config', 'coaching', 'rules', 'fatigue.rules.json'
);

let _catalog = null;

function _load() {
  if (_catalog) return _catalog;
  const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

  const byKey = new Map();
  for (const input of data.readiness_inputs.inputs) {
    byKey.set(input.key, input);
  }

  _catalog = {
    recoveryPriors: data.recovery_priors_hours,
    readinessInputs: data.readiness_inputs.inputs,
    byKey,
    deloadTriggers: data.deload_triggers,
  };
  return _catalog;
}

// Returns the recovery-rate priors object:
// { small_muscles: [min, max], large_compound: [min, max], heavy_eccentric_or_to_failure: [min, max] }
function getRecoveryPriors() {
  return _load().recoveryPriors;
}

// Returns all readiness inputs in config order (defensive copy).
function getReadinessInputs() {
  return _load().readinessInputs.slice();
}

// Returns the readiness input record for the given key, or null if not found.
function getReadinessInputByKey(key) {
  if (typeof key !== 'string' || !key) return null;
  return _load().byKey.get(key) ?? null;
}

// Returns the deload triggers object:
// { planned_every_weeks: [min, max], autoregulated_any_two: [...] }
function getDeloadTriggers() {
  return _load().deloadTriggers;
}

// Test-only: reset the in-memory cache.
function _resetForTesting() {
  _catalog = null;
}

module.exports = {
  getRecoveryPriors,
  getReadinessInputs,
  getReadinessInputByKey,
  getDeloadTriggers,
  _resetForTesting,
};
