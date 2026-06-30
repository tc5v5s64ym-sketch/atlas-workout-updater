'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getTrafficLight,
  getTrafficLightState,
  getSafeDefaults,
  _resetForTesting,
} = require('../services/safetyRulesModule');

beforeEach(() => _resetForTesting());

// Known traffic-light states from the config
const KNOWN_STATES = ['green', 'yellow', 'red'];

// --- getTrafficLight ---

test('getTrafficLight: returns an array', () => {
  assert.ok(Array.isArray(getTrafficLight()));
});

test('getTrafficLight: returns 3 states matching the config', () => {
  assert.strictEqual(getTrafficLight().length, 3);
});

test('getTrafficLight: every entry has state, meaning, signals, and action', () => {
  for (const entry of getTrafficLight()) {
    assert.ok(typeof entry.state === 'string' && entry.state.length > 0, 'missing state');
    assert.ok(typeof entry.meaning === 'string' && entry.meaning.length > 0, `${entry.state}: missing meaning`);
    assert.ok(Array.isArray(entry.signals), `${entry.state}: signals should be an array`);
    assert.ok(entry.signals.length > 0, `${entry.state}: signals should be non-empty`);
    assert.ok(typeof entry.action === 'string' && entry.action.length > 0, `${entry.state}: missing action`);
  }
});

test('getTrafficLight: states are in order green → yellow → red', () => {
  const states = getTrafficLight().map(e => e.state);
  assert.deepEqual(states, KNOWN_STATES);
});

test('getTrafficLight: each signals entry is a non-empty string', () => {
  for (const entry of getTrafficLight()) {
    for (const signal of entry.signals) {
      assert.strictEqual(typeof signal, 'string');
      assert.ok(signal.length > 0);
    }
  }
});

test('getTrafficLight: returns a copy (push does not mutate catalog)', () => {
  const first = getTrafficLight();
  first.push({ state: 'injected' });
  assert.strictEqual(getTrafficLight().length, 3);
});

// --- getTrafficLightState ---

test('getTrafficLightState: returns correct record for each known state', () => {
  for (const state of KNOWN_STATES) {
    const entry = getTrafficLightState(state);
    assert.ok(entry, `should return an entry for state '${state}'`);
    assert.strictEqual(entry.state, state);
  }
});

test('getTrafficLightState: green → action is proceed', () => {
  assert.strictEqual(getTrafficLightState('green').action, 'proceed');
});

test('getTrafficLightState: red → action includes stop', () => {
  const { action } = getTrafficLightState('red');
  assert.ok(action.toLowerCase().includes('stop'));
});

test('getTrafficLightState: red → action includes medical evaluation', () => {
  const { action } = getTrafficLightState('red');
  assert.ok(action.toLowerCase().includes('medical'));
});

test('getTrafficLightState: yellow → action references modification (intensity, volume, or ROM)', () => {
  const { action } = getTrafficLightState('yellow');
  const lower = action.toLowerCase();
  assert.ok(lower.includes('intensity') || lower.includes('volume') || lower.includes('rom'));
});

test('getTrafficLightState: green signals include "no pain"', () => {
  const { signals } = getTrafficLightState('green');
  assert.ok(signals.some(s => s.toLowerCase().includes('pain')));
});

test('getTrafficLightState: red signals include chest pain', () => {
  const { signals } = getTrafficLightState('red');
  assert.ok(signals.some(s => s.toLowerCase().includes('chest')));
});

test('getTrafficLightState: returns null for unknown state', () => {
  assert.strictEqual(getTrafficLightState('orange'), null);
});

test('getTrafficLightState: returns null for empty string', () => {
  assert.strictEqual(getTrafficLightState(''), null);
});

test('getTrafficLightState: returns null for non-string inputs', () => {
  assert.strictEqual(getTrafficLightState(null), null);
  assert.strictEqual(getTrafficLightState(undefined), null);
  assert.strictEqual(getTrafficLightState(42), null);
});

// --- getSafeDefaults ---

test('getSafeDefaults: returns object with required fields', () => {
  const d = getSafeDefaults();
  assert.ok(d, 'should return an object');
  assert.ok('on_uncertainty' in d);
  assert.ok('never' in d);
  assert.ok('onboarding_screen' in d);
  assert.ok('confidence_inversion' in d);
});

test('getSafeDefaults: on_uncertainty references caution', () => {
  const { on_uncertainty } = getSafeDefaults();
  assert.ok(typeof on_uncertainty === 'string');
  assert.ok(on_uncertainty.toLowerCase().includes('caution'));
});

test('getSafeDefaults: never is a non-empty array of strings', () => {
  const { never } = getSafeDefaults();
  assert.ok(Array.isArray(never));
  assert.ok(never.length > 0);
  for (const item of never) {
    assert.strictEqual(typeof item, 'string');
    assert.ok(item.length > 0);
  }
});

test('getSafeDefaults: never includes "diagnose"', () => {
  const { never } = getSafeDefaults();
  assert.ok(never.some(n => n.toLowerCase().includes('diagnose')));
});

test('getSafeDefaults: never includes coaching through red-flag symptoms', () => {
  const { never } = getSafeDefaults();
  assert.ok(never.some(n => n.toLowerCase().includes('red')));
});

test('getSafeDefaults: confidence_inversion references caution', () => {
  const { confidence_inversion } = getSafeDefaults();
  assert.ok(typeof confidence_inversion === 'string');
  assert.ok(confidence_inversion.toLowerCase().includes('caution'));
});

// --- Cross-function consistency ---

test('getTrafficLight() and getTrafficLightState() agree on all states', () => {
  const fromList = getTrafficLight().map(e => e.state);
  const fromLookup = fromList.map(s => getTrafficLightState(s)?.state);
  assert.deepEqual(fromList, fromLookup);
});

test('every getTrafficLight() entry is retrievable via getTrafficLightState()', () => {
  for (const entry of getTrafficLight()) {
    const found = getTrafficLightState(entry.state);
    assert.ok(found, `getTrafficLightState('${entry.state}') should return an entry`);
    assert.strictEqual(found.state, entry.state);
  }
});
