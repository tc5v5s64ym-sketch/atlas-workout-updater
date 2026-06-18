'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { classifyDeviation } = require('../services/performanceDeviation');

/* ===== Helpers ===== */

function expected(expectedReps, options = {}) {
  return {
    expectedReps,
    expectedRirRange: options.rirRange ?? { min: 1, max: 2 },
    basis: { sampleSize: options.sampleSize ?? 5, confidence: options.confidence ?? 'high' },
  };
}

function logged(reps) {
  return { reps };
}

/* ===== Null / insufficient expected data ===== */

test('classifyDeviation: null expected → insufficient_data', () => {
  const r = classifyDeviation(logged(8), null);
  assert.equal(r.verdict, 'insufficient_data');
  assert.equal(r.delta, null);
  assert.equal(r.magnitude, null);
});

test('classifyDeviation: undefined expected → insufficient_data', () => {
  const r = classifyDeviation(logged(8), undefined);
  assert.equal(r.verdict, 'insufficient_data');
});

test('classifyDeviation: expected with null expectedReps → insufficient_data', () => {
  const r = classifyDeviation(logged(8), { expectedReps: null, basis: {} });
  assert.equal(r.verdict, 'insufficient_data');
  assert.equal(r.delta, null);
});

test('classifyDeviation: expected with undefined expectedReps → insufficient_data', () => {
  const r = classifyDeviation(logged(8), { basis: {} });
  assert.equal(r.verdict, 'insufficient_data');
});

/* ===== Null / invalid logged data ===== */

test('classifyDeviation: null logged → insufficient_data', () => {
  const r = classifyDeviation(null, expected(10));
  assert.equal(r.verdict, 'insufficient_data');
});

test('classifyDeviation: logged with no reps → insufficient_data', () => {
  const r = classifyDeviation({}, expected(10));
  assert.equal(r.verdict, 'insufficient_data');
});

test('classifyDeviation: logged with zero reps → insufficient_data', () => {
  const r = classifyDeviation(logged(0), expected(10));
  assert.equal(r.verdict, 'insufficient_data');
});

test('classifyDeviation: logged with negative reps → insufficient_data', () => {
  const r = classifyDeviation(logged(-1), expected(10));
  assert.equal(r.verdict, 'insufficient_data');
});

test('classifyDeviation: logged with non-numeric reps → insufficient_data', () => {
  const r = classifyDeviation({ reps: 'heavy' }, expected(10));
  assert.equal(r.verdict, 'insufficient_data');
});

test('classifyDeviation: logged not an object → insufficient_data', () => {
  const r = classifyDeviation(8, expected(10));
  assert.equal(r.verdict, 'insufficient_data');
});

/* ===== on_target (delta in -1..+1) ===== */

test('classifyDeviation: delta 0 → on_target, magnitude null', () => {
  const r = classifyDeviation(logged(10), expected(10));
  assert.equal(r.verdict, 'on_target');
  assert.equal(r.delta, 0);
  assert.equal(r.magnitude, null);
});

test('classifyDeviation: delta +1 → on_target', () => {
  const r = classifyDeviation(logged(11), expected(10));
  assert.equal(r.verdict, 'on_target');
  assert.equal(r.delta, 1);
  assert.equal(r.magnitude, null);
});

test('classifyDeviation: delta -1 → on_target', () => {
  const r = classifyDeviation(logged(9), expected(10));
  assert.equal(r.verdict, 'on_target');
  assert.equal(r.delta, -1);
  assert.equal(r.magnitude, null);
});

/* ===== above_expected ===== */

test('classifyDeviation: delta +2 → above_expected, slight', () => {
  const r = classifyDeviation(logged(12), expected(10));
  assert.equal(r.verdict, 'above_expected');
  assert.equal(r.delta, 2);
  assert.equal(r.magnitude, 'slight');
});

test('classifyDeviation: delta +3 → above_expected, slight', () => {
  const r = classifyDeviation(logged(13), expected(10));
  assert.equal(r.verdict, 'above_expected');
  assert.equal(r.delta, 3);
  assert.equal(r.magnitude, 'slight');
});

test('classifyDeviation: delta +4 → above_expected, significant', () => {
  const r = classifyDeviation(logged(14), expected(10));
  assert.equal(r.verdict, 'above_expected');
  assert.equal(r.delta, 4);
  assert.equal(r.magnitude, 'significant');
});

test('classifyDeviation: delta +6 → above_expected, significant', () => {
  const r = classifyDeviation(logged(16), expected(10));
  assert.equal(r.verdict, 'above_expected');
  assert.equal(r.delta, 6);
  assert.equal(r.magnitude, 'significant');
});

/* ===== below_expected ===== */

test('classifyDeviation: delta -2 → below_expected, slight', () => {
  const r = classifyDeviation(logged(8), expected(10));
  assert.equal(r.verdict, 'below_expected');
  assert.equal(r.delta, -2);
  assert.equal(r.magnitude, 'slight');
});

test('classifyDeviation: delta -3 → below_expected, slight', () => {
  const r = classifyDeviation(logged(7), expected(10));
  assert.equal(r.verdict, 'below_expected');
  assert.equal(r.delta, -3);
  assert.equal(r.magnitude, 'slight');
});

test('classifyDeviation: delta -4 → below_expected, significant', () => {
  const r = classifyDeviation(logged(6), expected(10));
  assert.equal(r.verdict, 'below_expected');
  assert.equal(r.delta, -4);
  assert.equal(r.magnitude, 'significant');
});

test('classifyDeviation: delta -6 → below_expected, significant', () => {
  const r = classifyDeviation(logged(4), expected(10));
  assert.equal(r.verdict, 'below_expected');
  assert.equal(r.delta, -6);
  assert.equal(r.magnitude, 'significant');
});

/* ===== Exact threshold boundaries ===== */

test('classifyDeviation: delta exactly +2 is above_expected (inclusive lower bound)', () => {
  assert.equal(classifyDeviation(logged(12), expected(10)).verdict, 'above_expected');
});

test('classifyDeviation: delta exactly -2 is below_expected (inclusive upper bound)', () => {
  assert.equal(classifyDeviation(logged(8), expected(10)).verdict, 'below_expected');
});

test('classifyDeviation: delta exactly +4 is significant (inclusive lower bound)', () => {
  assert.equal(classifyDeviation(logged(14), expected(10)).magnitude, 'significant');
});

test('classifyDeviation: delta exactly -4 is significant (inclusive lower bound)', () => {
  assert.equal(classifyDeviation(logged(6), expected(10)).magnitude, 'significant');
});

/* ===== Plan spec golden test ===== */

test('classifyDeviation: spec golden — bench 185×8 flags below expected when history says 10–12', () => {
  // Plan app-test hold: "Bench 185×8 @2 should flag below expected if history supports 185×10–12 @2"
  const exp = expected(11);   // median of 10–12 range
  const r = classifyDeviation({ reps: 8, weight: 185, rir: 2 }, exp);
  assert.equal(r.verdict, 'below_expected');
  assert.equal(r.delta, -3);
  assert.equal(r.magnitude, 'slight');
});

test('classifyDeviation: spec golden — bench 185×12 flags above expected when history says 10', () => {
  const r = classifyDeviation({ reps: 12, weight: 185, rir: 2 }, expected(10));
  assert.equal(r.verdict, 'above_expected');
  assert.equal(r.delta, 2);
  assert.equal(r.magnitude, 'slight');
});

/* ===== Return shape is always complete ===== */

test('classifyDeviation: all result objects have verdict, delta, magnitude keys', () => {
  const cases = [
    [logged(8),  null],
    [logged(8),  expected(10)],
    [logged(12), expected(10)],
    [logged(6),  expected(10)],
  ];
  for (const [l, e] of cases) {
    const r = classifyDeviation(l, e);
    assert.ok('verdict'   in r, 'missing verdict');
    assert.ok('delta'     in r, 'missing delta');
    assert.ok('magnitude' in r, 'missing magnitude');
  }
});
