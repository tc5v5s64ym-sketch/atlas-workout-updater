'use strict';

// ProgressionRulesModule — read-only access to the progression decision table
// and related config from config/coaching/rules/progression.rules.json.
// Loads lazily on first call. No Sheets access, no side effects.
//
// Future modules (ProgressionModule) call these functions instead of reading
// the rules file directly.

const path = require('node:path');
const fs = require('node:fs');

const RULES_PATH = path.join(
  __dirname, '..', 'config', 'coaching', 'rules', 'progression.rules.json'
);

let _catalog = null;

function _load() {
  if (_catalog) return _catalog;
  const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));

  const byId = new Map();
  for (const scenario of data.decision_table) {
    byId.set(scenario.id, scenario);
  }

  _catalog = {
    scenarios: data.decision_table,
    byId,
    leverOrder: data.lever_order.order,
    increments: data.increment_defaults,
    plateauRule: data.one_bad_session_vs_plateau,
  };
  return _catalog;
}

// Returns the scenario record for the given id, or null if not found.
function getScenario(id) {
  if (typeof id !== 'string' || !id) return null;
  return _load().byId.get(id) ?? null;
}

// Returns all scenario records in decision-table order.
function getAllScenarios() {
  return _load().scenarios.slice();
}

// Returns an array of all scenario ids in decision-table order.
function getAllScenarioIds() {
  return _load().scenarios.map(s => s.id);
}

// Returns the lever priority order: ["load", "reps", "sets"].
// Cheapest-to-most-expensive progression lever.
function getLeverOrder() {
  return _load().leverOrder.slice();
}

// Returns increment defaults: { upper_body_pct: [min, max], lower_body_lb: [min, max] }.
function getIncrements() {
  return _load().increments;
}

// Returns the plateau detection config:
// { ignore_single_session_if, flag_plateau_if }.
function getPlateauRule() {
  return _load().plateauRule;
}

// Test-only: reset the in-memory cache.
function _resetForTesting() {
  _catalog = null;
}

module.exports = {
  getScenario,
  getAllScenarios,
  getAllScenarioIds,
  getLeverOrder,
  getIncrements,
  getPlateauRule,
  _resetForTesting,
};
