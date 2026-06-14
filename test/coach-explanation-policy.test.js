'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTemplatedExplanation, validateCoachExplanation } = require('../services/coachExplanationPolicy');

const LOCKED = { targetSets: 3, targetRepRange: { min: 3, max: 6 }, targetRIR: { min: 1, max: 3 }, recommendedWeight: 190 };

test('the templated explanation always passes its own validator', () => {
  const rec = {
    exerciseName: 'Bench Press',
    targetSets: 3,
    targetRepRange: { min: 3, max: 6 },
    targetRIR: { min: 1, max: 3 },
    recommendedWeight: 190,
    progression: 'add_load',
  };
  const text = buildTemplatedExplanation(rec);
  assert.equal(validateCoachExplanation(text, LOCKED).valid, true);
});

test('rejects a substituted weight (locked 190, explanation says 225)', () => {
  const r = validateCoachExplanation('Go to 225 lb today and send it.', LOCKED);
  assert.equal(r.valid, false);
  assert.ok(r.violations.some((v) => v.type === 'weight'));
});

test('rejects wrong sets x reps (locked 3x6, explanation says 5x10)', () => {
  const r = validateCoachExplanation('Knock out 5x10 today.', LOCKED);
  assert.equal(r.valid, false);
  assert.ok(r.violations.some((v) => v.type === 'sets_reps'));
});

test('rejects "to failure" when locked RIR is >= 1', () => {
  const r = validateCoachExplanation('Take that last set to failure.', LOCKED);
  assert.equal(r.valid, false);
  assert.ok(r.violations.some((v) => v.type === 'failure'));
});

test('accepts harmless context numbers (dates, %, lift codes, rep ranges, compatible RIR)', () => {
  const text = 'Since 2026-06-01 your e1RM is up ~5%. On BEN01, use 190 lb for 3 sets of 4-6 reps, leaving 1-2 reps in the tank.';
  const r = validateCoachExplanation(text, LOCKED);
  assert.equal(r.valid, true, JSON.stringify(r.violations));
});

test('cold start: no weight locked, guidance phrasing validates', () => {
  const rec = {
    exerciseName: 'Bench Press',
    targetSets: 3,
    targetRepRange: { min: 8, max: 15 },
    targetRIR: { min: 0, max: 3 },
    progression: 'add_rep',
    // no recommendedWeight
  };
  const text = buildTemplatedExplanation(rec);
  assert.match(text, /near your target RIR/);
  const r = validateCoachExplanation(text, { targetSets: 3, targetRepRange: { min: 8, max: 15 }, targetRIR: { min: 0, max: 3 }, recommendedWeight: undefined });
  assert.equal(r.valid, true, JSON.stringify(r.violations));
});
