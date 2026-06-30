'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getScenario,
  getAllScenarios,
  getAllScenarioIds,
  getLeverOrder,
  getIncrements,
  getPlateauRule,
  _resetForTesting,
} = require('../services/progressionRulesModule');

beforeEach(() => _resetForTesting());

// Known scenario ids from the decision table
const KNOWN_IDS = [
  'underloaded',
  'on_target',
  'normal_variability',
  'likely_fatigue',
  'injury_signal',
  'candidate_plateau',
];

// --- getScenario ---

test('getScenario: returns correct record for each known scenario id', () => {
  for (const id of KNOWN_IDS) {
    const scenario = getScenario(id);
    assert.ok(scenario, `should return a scenario for id '${id}'`);
    assert.strictEqual(scenario.id, id);
  }
});

test('getScenario: returned object has required schema fields', () => {
  const scenario = getScenario('underloaded');
  assert.ok('id' in scenario);
  assert.ok('when' in scenario);
  assert.ok('interpretation' in scenario);
  assert.ok('default_action' in scenario);
});

test('getScenario: underloaded → default_action is increase_load', () => {
  assert.strictEqual(getScenario('underloaded').default_action, 'increase_load');
});

test('getScenario: on_target → default_action is maintain_or_add_reps', () => {
  assert.strictEqual(getScenario('on_target').default_action, 'maintain_or_add_reps');
});

test('getScenario: normal_variability → default_action is hold_progression', () => {
  assert.strictEqual(getScenario('normal_variability').default_action, 'hold_progression');
});

test('getScenario: likely_fatigue → default_action is hold_or_reduce_load', () => {
  assert.strictEqual(getScenario('likely_fatigue').default_action, 'hold_or_reduce_load');
});

test('getScenario: injury_signal → default_action is swap_exercise_or_reduce_rom', () => {
  assert.strictEqual(getScenario('injury_signal').default_action, 'swap_exercise_or_reduce_rom');
});

test('getScenario: candidate_plateau → default_action is change_variant_reps_or_volume', () => {
  assert.strictEqual(getScenario('candidate_plateau').default_action, 'change_variant_reps_or_volume');
});

test('getScenario: returns null for unknown id', () => {
  assert.strictEqual(getScenario('nonexistent_scenario'), null);
});

test('getScenario: returns null for empty string', () => {
  assert.strictEqual(getScenario(''), null);
});

test('getScenario: returns null for non-string inputs', () => {
  assert.strictEqual(getScenario(null), null);
  assert.strictEqual(getScenario(undefined), null);
  assert.strictEqual(getScenario(42), null);
});

// --- getAllScenarios ---

test('getAllScenarios: returns an array', () => {
  assert.ok(Array.isArray(getAllScenarios()));
});

test('getAllScenarios: returns 6 scenarios matching the decision table', () => {
  assert.strictEqual(getAllScenarios().length, 6);
});

test('getAllScenarios: every scenario has id, when, interpretation, default_action', () => {
  for (const s of getAllScenarios()) {
    assert.ok(typeof s.id === 'string' && s.id.length > 0, `scenario missing id`);
    assert.ok(typeof s.when === 'string' && s.when.length > 0, `${s.id}: missing when`);
    assert.ok(typeof s.interpretation === 'string', `${s.id}: missing interpretation`);
    assert.ok(typeof s.default_action === 'string', `${s.id}: missing default_action`);
  }
});

test('getAllScenarios: preserves decision-table order', () => {
  const ids = getAllScenarios().map(s => s.id);
  assert.deepEqual(ids, KNOWN_IDS);
});

test('getAllScenarios: returns a copy (push does not mutate the catalog)', () => {
  const first = getAllScenarios();
  first.push({ id: 'injected' });
  const second = getAllScenarios();
  assert.strictEqual(second.length, 6);
});

// --- getAllScenarioIds ---

test('getAllScenarioIds: returns all 6 known ids', () => {
  assert.deepEqual(getAllScenarioIds(), KNOWN_IDS);
});

test('getAllScenarioIds: each id is a string', () => {
  for (const id of getAllScenarioIds()) {
    assert.strictEqual(typeof id, 'string');
  }
});

// --- getLeverOrder ---

test('getLeverOrder: returns [load, reps, sets]', () => {
  assert.deepEqual(getLeverOrder(), ['load', 'reps', 'sets']);
});

test('getLeverOrder: returns an array of 3 elements', () => {
  assert.strictEqual(getLeverOrder().length, 3);
});

test('getLeverOrder: returns a copy (mutation does not affect the catalog)', () => {
  const first = getLeverOrder();
  first[0] = 'tampered';
  assert.strictEqual(getLeverOrder()[0], 'load');
});

// --- getIncrements ---

test('getIncrements: returns object with upper_body_pct and lower_body_lb', () => {
  const inc = getIncrements();
  assert.ok(inc, 'should return an object');
  assert.ok('upper_body_pct' in inc);
  assert.ok('lower_body_lb' in inc);
});

test('getIncrements: upper_body_pct is a two-element numeric range', () => {
  const { upper_body_pct } = getIncrements();
  assert.ok(Array.isArray(upper_body_pct), 'upper_body_pct should be an array');
  assert.strictEqual(upper_body_pct.length, 2);
  assert.ok(upper_body_pct[0] > 0 && upper_body_pct[1] > upper_body_pct[0]);
});

test('getIncrements: lower_body_lb is a two-element numeric range', () => {
  const { lower_body_lb } = getIncrements();
  assert.ok(Array.isArray(lower_body_lb), 'lower_body_lb should be an array');
  assert.strictEqual(lower_body_lb.length, 2);
  assert.ok(lower_body_lb[0] > 0 && lower_body_lb[1] > lower_body_lb[0]);
});

test('getIncrements: upper_body_pct values match the config (2.5 and 5)', () => {
  const { upper_body_pct } = getIncrements();
  assert.strictEqual(upper_body_pct[0], 2.5);
  assert.strictEqual(upper_body_pct[1], 5);
});

test('getIncrements: lower_body_lb values match the config (5 and 10)', () => {
  const { lower_body_lb } = getIncrements();
  assert.strictEqual(lower_body_lb[0], 5);
  assert.strictEqual(lower_body_lb[1], 10);
});

// --- getPlateauRule ---

test('getPlateauRule: returns object with ignore_single_session_if and flag_plateau_if', () => {
  const rule = getPlateauRule();
  assert.ok(rule, 'should return an object');
  assert.ok('ignore_single_session_if' in rule);
  assert.ok('flag_plateau_if' in rule);
});

test('getPlateauRule: both fields are non-empty strings', () => {
  const rule = getPlateauRule();
  assert.ok(typeof rule.ignore_single_session_if === 'string' && rule.ignore_single_session_if.length > 0);
  assert.ok(typeof rule.flag_plateau_if === 'string' && rule.flag_plateau_if.length > 0);
});

test('getPlateauRule: flag_plateau_if references session count (>=3)', () => {
  const rule = getPlateauRule();
  assert.ok(rule.flag_plateau_if.includes('3'), 'plateau rule should reference a session count');
});

// --- Cross-function consistency ---

test('getAllScenarioIds() and getAllScenarios() ids agree', () => {
  const fromIds = getAllScenarioIds();
  const fromScenarios = getAllScenarios().map(s => s.id);
  assert.deepEqual(fromIds, fromScenarios);
});

test('every getAllScenarioIds() entry is retrievable via getScenario()', () => {
  for (const id of getAllScenarioIds()) {
    const s = getScenario(id);
    assert.ok(s, `getScenario('${id}') should return a scenario`);
    assert.strictEqual(s.id, id);
  }
});
