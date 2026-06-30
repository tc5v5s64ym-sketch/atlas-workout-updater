'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getRecoveryPriors,
  getReadinessInputs,
  getReadinessInputByKey,
  getDeloadTriggers,
  _resetForTesting,
} = require('../services/fatigueRulesModule');

beforeEach(() => _resetForTesting());

// Known readiness input keys from config
const KNOWN_KEYS = ['sleep', 'soreness', 'stress', 'motivation', 'recent_load', 'hrv'];

// --- getRecoveryPriors ---

test('getRecoveryPriors: returns object with the three window fields', () => {
  const p = getRecoveryPriors();
  assert.ok(p, 'should return an object');
  assert.ok('small_muscles' in p);
  assert.ok('large_compound' in p);
  assert.ok('heavy_eccentric_or_to_failure' in p);
});

test('getRecoveryPriors: small_muscles is a two-element range with max > min', () => {
  const { small_muscles } = getRecoveryPriors();
  assert.ok(Array.isArray(small_muscles));
  assert.strictEqual(small_muscles.length, 2);
  assert.ok(small_muscles[0] > 0 && small_muscles[1] > small_muscles[0]);
});

test('getRecoveryPriors: large_compound is a two-element range with max > min', () => {
  const { large_compound } = getRecoveryPriors();
  assert.ok(Array.isArray(large_compound));
  assert.strictEqual(large_compound.length, 2);
  assert.ok(large_compound[0] > 0 && large_compound[1] > large_compound[0]);
});

test('getRecoveryPriors: heavy_eccentric_or_to_failure is a two-element range with max > min', () => {
  const { heavy_eccentric_or_to_failure } = getRecoveryPriors();
  assert.ok(Array.isArray(heavy_eccentric_or_to_failure));
  assert.strictEqual(heavy_eccentric_or_to_failure.length, 2);
  assert.ok(heavy_eccentric_or_to_failure[0] > 0 && heavy_eccentric_or_to_failure[1] > heavy_eccentric_or_to_failure[0]);
});

test('getRecoveryPriors: values match config (24–48 / 48–72 / 72–96)', () => {
  const p = getRecoveryPriors();
  assert.deepEqual(p.small_muscles, [24, 48]);
  assert.deepEqual(p.large_compound, [48, 72]);
  assert.deepEqual(p.heavy_eccentric_or_to_failure, [72, 96]);
});

test('getRecoveryPriors: windows are ordered (small < large < heavy)', () => {
  const { small_muscles, large_compound, heavy_eccentric_or_to_failure } = getRecoveryPriors();
  assert.ok(small_muscles[1] <= large_compound[0], 'small upper bound should be <= large lower bound');
  assert.ok(large_compound[1] <= heavy_eccentric_or_to_failure[0], 'large upper bound should be <= heavy lower bound');
});

// --- getReadinessInputs ---

test('getReadinessInputs: returns an array', () => {
  assert.ok(Array.isArray(getReadinessInputs()));
});

test('getReadinessInputs: returns 6 inputs matching the config', () => {
  assert.strictEqual(getReadinessInputs().length, 6);
});

test('getReadinessInputs: every entry has key, type, and weight_hint', () => {
  for (const inp of getReadinessInputs()) {
    assert.ok(typeof inp.key === 'string' && inp.key.length > 0, 'missing key');
    assert.ok(typeof inp.type === 'string' && inp.type.length > 0, `${inp.key}: missing type`);
    assert.ok(typeof inp.weight_hint === 'string' && inp.weight_hint.length > 0, `${inp.key}: missing weight_hint`);
  }
});

test('getReadinessInputs: contains all 6 known keys in order', () => {
  const keys = getReadinessInputs().map(i => i.key);
  assert.deepEqual(keys, KNOWN_KEYS);
});

test('getReadinessInputs: type values are subjective | derived | wearable', () => {
  const valid = new Set(['subjective', 'derived', 'wearable']);
  for (const inp of getReadinessInputs()) {
    assert.ok(valid.has(inp.type), `${inp.key}: unexpected type '${inp.type}'`);
  }
});

test('getReadinessInputs: weight_hint values are high | medium | low', () => {
  const valid = new Set(['high', 'medium', 'low']);
  for (const inp of getReadinessInputs()) {
    assert.ok(valid.has(inp.weight_hint), `${inp.key}: unexpected weight_hint '${inp.weight_hint}'`);
  }
});

test('getReadinessInputs: returns a copy (push does not mutate catalog)', () => {
  const first = getReadinessInputs();
  first.push({ key: 'injected' });
  assert.strictEqual(getReadinessInputs().length, 6);
});

// --- getReadinessInputByKey ---

test('getReadinessInputByKey: returns correct record for each known key', () => {
  for (const key of KNOWN_KEYS) {
    const inp = getReadinessInputByKey(key);
    assert.ok(inp, `should return an input for key '${key}'`);
    assert.strictEqual(inp.key, key);
  }
});

test('getReadinessInputByKey: sleep → subjective, high weight', () => {
  const inp = getReadinessInputByKey('sleep');
  assert.strictEqual(inp.type, 'subjective');
  assert.strictEqual(inp.weight_hint, 'high');
});

test('getReadinessInputByKey: hrv → wearable, low weight', () => {
  const inp = getReadinessInputByKey('hrv');
  assert.strictEqual(inp.type, 'wearable');
  assert.strictEqual(inp.weight_hint, 'low');
});

test('getReadinessInputByKey: recent_load → derived type', () => {
  assert.strictEqual(getReadinessInputByKey('recent_load').type, 'derived');
});

test('getReadinessInputByKey: returns null for unknown key', () => {
  assert.strictEqual(getReadinessInputByKey('unknown_input'), null);
});

test('getReadinessInputByKey: returns null for empty string', () => {
  assert.strictEqual(getReadinessInputByKey(''), null);
});

test('getReadinessInputByKey: returns null for non-string inputs', () => {
  assert.strictEqual(getReadinessInputByKey(null), null);
  assert.strictEqual(getReadinessInputByKey(undefined), null);
  assert.strictEqual(getReadinessInputByKey(42), null);
});

// --- getDeloadTriggers ---

test('getDeloadTriggers: returns object with planned_every_weeks and autoregulated_any_two', () => {
  const d = getDeloadTriggers();
  assert.ok(d, 'should return an object');
  assert.ok('planned_every_weeks' in d);
  assert.ok('autoregulated_any_two' in d);
});

test('getDeloadTriggers: planned_every_weeks is a two-element range', () => {
  const { planned_every_weeks } = getDeloadTriggers();
  assert.ok(Array.isArray(planned_every_weeks));
  assert.strictEqual(planned_every_weeks.length, 2);
  assert.ok(planned_every_weeks[0] > 0 && planned_every_weeks[1] > planned_every_weeks[0]);
});

test('getDeloadTriggers: planned_every_weeks values match config (4 and 6)', () => {
  const { planned_every_weeks } = getDeloadTriggers();
  assert.strictEqual(planned_every_weeks[0], 4);
  assert.strictEqual(planned_every_weeks[1], 6);
});

test('getDeloadTriggers: autoregulated_any_two is an array of 6 trigger strings', () => {
  const { autoregulated_any_two } = getDeloadTriggers();
  assert.ok(Array.isArray(autoregulated_any_two));
  assert.strictEqual(autoregulated_any_two.length, 6);
  for (const trigger of autoregulated_any_two) {
    assert.strictEqual(typeof trigger, 'string');
    assert.ok(trigger.length > 0);
  }
});

test('getDeloadTriggers: autoregulated_any_two includes performance-drop trigger', () => {
  const { autoregulated_any_two } = getDeloadTriggers();
  assert.ok(autoregulated_any_two.some(t => t.toLowerCase().includes('performance')));
});

test('getDeloadTriggers: autoregulated_any_two includes motivation trigger', () => {
  const { autoregulated_any_two } = getDeloadTriggers();
  assert.ok(autoregulated_any_two.some(t => t.toLowerCase().includes('motivation')));
});

// --- Cross-function consistency ---

test('getReadinessInputs() and getReadinessInputByKey() keys agree', () => {
  const fromList = getReadinessInputs().map(i => i.key);
  const fromLookup = fromList.map(k => getReadinessInputByKey(k)?.key);
  assert.deepEqual(fromList, fromLookup);
});

test('every getReadinessInputs() entry is retrievable via getReadinessInputByKey()', () => {
  for (const inp of getReadinessInputs()) {
    const found = getReadinessInputByKey(inp.key);
    assert.ok(found, `getReadinessInputByKey('${inp.key}') should return an input`);
    assert.strictEqual(found.key, inp.key);
  }
});
