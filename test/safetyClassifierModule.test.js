'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTrafficLight,
  getSafeDefault,
} = require('../services/safetyClassifierModule');

// --- classifyTrafficLight: invalid inputs ---

test('classifyTrafficLight: null → null', () => {
  assert.strictEqual(classifyTrafficLight(null), null);
});

test('classifyTrafficLight: non-array → null', () => {
  assert.strictEqual(classifyTrafficLight('chest pain'), null);
  assert.strictEqual(classifyTrafficLight(42), null);
});

test('classifyTrafficLight: empty array → green, confidence none', () => {
  const r = classifyTrafficLight([]);
  assert.strictEqual(r.state, 'green');
  assert.strictEqual(r.confidence, 'none');
  assert.deepEqual(r.matchedSignals, []);
});

test('classifyTrafficLight: non-string entries in array are skipped', () => {
  const r = classifyTrafficLight([null, 42, undefined, 'no pain']);
  assert.strictEqual(r.state, 'green');
  assert.strictEqual(r.matchedSignals.length, 1);
});

test('classifyTrafficLight: empty-string signals are skipped', () => {
  const r = classifyTrafficLight(['', '  ', 'no pain']);
  assert.strictEqual(r.state, 'green');
  assert.ok(r.matchedSignals.includes('no pain'));
});

// --- green state signals ---

test('classifyTrafficLight: "no pain" → green', () => {
  assert.strictEqual(classifyTrafficLight(['no pain']).state, 'green');
});

test('classifyTrafficLight: "ordinary DOMS" → green', () => {
  assert.strictEqual(classifyTrafficLight(['ordinary DOMS']).state, 'green');
});

test('classifyTrafficLight: "good readiness" → green', () => {
  assert.strictEqual(classifyTrafficLight(['good readiness']).state, 'green');
});

// --- yellow state signals ---

test('classifyTrafficLight: "minor joint niggle" → yellow', () => {
  assert.strictEqual(classifyTrafficLight(['minor joint niggle']).state, 'yellow');
});

test('classifyTrafficLight: "low readiness" → yellow', () => {
  assert.strictEqual(classifyTrafficLight(['low readiness']).state, 'yellow');
});

test('classifyTrafficLight: "travel fatigue" → yellow', () => {
  assert.strictEqual(classifyTrafficLight(['travel fatigue']).state, 'yellow');
});

// --- red state signals ---

test('classifyTrafficLight: "chest pain" → red', () => {
  // "chest pain" is a substring of the red signal "chest pain/pressure/tightness..."
  assert.strictEqual(classifyTrafficLight(['chest pain']).state, 'red');
});

test('classifyTrafficLight: "fainting" → red', () => {
  // "fainting" is a substring of "fainting or near-fainting"
  assert.strictEqual(classifyTrafficLight(['fainting']).state, 'red');
});

test('classifyTrafficLight: "sudden severe headache" → red', () => {
  assert.strictEqual(classifyTrafficLight(['sudden severe headache']).state, 'red');
});

// --- priority: most severe state wins ---

test('classifyTrafficLight: red overrides yellow when both present', () => {
  const r = classifyTrafficLight(['low readiness', 'chest pain']);
  assert.strictEqual(r.state, 'red');
  assert.ok(r.matchedSignals.includes('low readiness'));
  assert.ok(r.matchedSignals.includes('chest pain'));
});

test('classifyTrafficLight: yellow overrides green when both present', () => {
  const r = classifyTrafficLight(['no pain', 'low readiness']);
  assert.strictEqual(r.state, 'yellow');
});

// --- matched / unmatched signals ---

test('classifyTrafficLight: unrecognized signal goes into unmatchedSignals', () => {
  const r = classifyTrafficLight(['completely unrecognized symptom', 'no pain']);
  assert.ok(r.unmatchedSignals.includes('completely unrecognized symptom'));
  assert.ok(r.matchedSignals.includes('no pain'));
});

test('classifyTrafficLight: all signals unrecognized → green (unmatched signals do not change state)', () => {
  const r = classifyTrafficLight(['absolutely unknown', 'not a real signal']);
  assert.strictEqual(r.state, 'green');
  assert.strictEqual(r.matchedSignals.length, 0);
  assert.strictEqual(r.unmatchedSignals.length, 2);
});

// --- confidence tiers ---

test('classifyTrafficLight: confidence = none with 0 matched signals', () => {
  assert.strictEqual(classifyTrafficLight([]).confidence, 'none');
  assert.strictEqual(classifyTrafficLight(['unrecognized']).confidence, 'none');
});

test('classifyTrafficLight: confidence = low with 1 matched signal', () => {
  assert.strictEqual(classifyTrafficLight(['chest pain']).confidence, 'low');
});

test('classifyTrafficLight: confidence = moderate with 2-3 matched signals', () => {
  const r = classifyTrafficLight(['chest pain', 'fainting']);
  assert.strictEqual(r.confidence, 'moderate');
});

test('classifyTrafficLight: confidence = high with 4+ matched signals', () => {
  const r = classifyTrafficLight([
    'chest pain', 'fainting', 'sudden severe headache', 'numbness',
  ]);
  assert.strictEqual(r.confidence, 'high');
});

// --- result shape ---

test('classifyTrafficLight: result includes meaning and action from config', () => {
  const r = classifyTrafficLight(['chest pain']);
  assert.ok(typeof r.meaning === 'string' && r.meaning.length > 0);
  assert.ok(typeof r.action === 'string' && r.action.length > 0);
  // Red action should reference stopping and medical evaluation
  assert.ok(r.action.toLowerCase().includes('stop') || r.action.toLowerCase().includes('medical'));
});

test('classifyTrafficLight: matching is case-insensitive', () => {
  assert.strictEqual(classifyTrafficLight(['CHEST PAIN']).state, 'red');
  assert.strictEqual(classifyTrafficLight(['Low Readiness']).state, 'yellow');
  assert.strictEqual(classifyTrafficLight(['NO PAIN']).state, 'green');
});

// --- getSafeDefault ---

test('getSafeDefault: "on_uncertainty" → non-empty string', () => {
  const v = getSafeDefault('on_uncertainty');
  assert.ok(typeof v === 'string' && v.length > 0);
  assert.ok(v.toLowerCase().includes('caution'));
});

test('getSafeDefault: "never" → non-empty array including "diagnose"', () => {
  const v = getSafeDefault('never');
  assert.ok(Array.isArray(v) && v.length > 0);
  assert.ok(v.some(s => s.toLowerCase().includes('diagnose')));
});

test('getSafeDefault: "onboarding_screen" → non-empty string', () => {
  const v = getSafeDefault('onboarding_screen');
  assert.ok(typeof v === 'string' && v.length > 0);
});

test('getSafeDefault: "confidence_inversion" → non-empty string', () => {
  const v = getSafeDefault('confidence_inversion');
  assert.ok(typeof v === 'string' && v.length > 0);
});

test('getSafeDefault: unknown field → null', () => {
  assert.strictEqual(getSafeDefault('unknown_field'), null);
  assert.strictEqual(getSafeDefault('provenance'), null); // internal field not exposed
});

test('getSafeDefault: null/non-string → null', () => {
  assert.strictEqual(getSafeDefault(null), null);
  assert.strictEqual(getSafeDefault(42), null);
  assert.strictEqual(getSafeDefault(undefined), null);
});
