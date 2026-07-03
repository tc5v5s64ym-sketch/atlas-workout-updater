'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyStalenessGuard } = require('../services/stalenessGuard');

const CURRENT = Object.freeze({
  nextWeight: 205,
  nextReps: 6,
  recommendation: 'Increase to 205 × 6 reps.',
  reasoning: 'RIR 3 with stable reps over two sessions — 5 lb progression is warranted.',
  confidence: 'high',
});
const LAST_SET = { weight: 200, reps: 5, rir: 3 };

test('staleness: > 10 days overrides to a repeat of the last working weight (barbell)', () => {
  const out = applyStalenessGuard(CURRENT, { daysSinceLastSession: 14, isBodyweight: false, lastSet: LAST_SET });
  assert.equal(out.nextWeight, 200);
  assert.equal(out.nextReps, 5);
  assert.equal(out.recommendation, 'Repeat 200 × 5 to reconfirm this lift.');
  assert.match(out.reasoning, /14 days ago — too long a gap to assume progression/);
  assert.equal(out.confidence, 'medium', 'high downgrades to medium');
});

test('staleness: > 10 days on a bodyweight lift repeats reps only (no weight in the copy)', () => {
  const out = applyStalenessGuard(CURRENT, { daysSinceLastSession: 21, isBodyweight: true, lastSet: LAST_SET });
  assert.equal(out.recommendation, 'Repeat 5 reps to reconfirm this lift.');
  assert.match(out.reasoning, /Repeat last session's reps/);
  assert.equal(out.nextWeight, CURRENT.nextWeight, 'bodyweight path leaves nextWeight untouched');
});

test('staleness: non-high confidence downgrades to low on a long gap', () => {
  const out = applyStalenessGuard({ ...CURRENT, confidence: 'medium' }, { daysSinceLastSession: 12, isBodyweight: false, lastSet: LAST_SET });
  assert.equal(out.confidence, 'low');
});

test('staleness: 7–10 days keeps the advice and appends the age to the reasoning', () => {
  const out = applyStalenessGuard(CURRENT, { daysSinceLastSession: 8, isBodyweight: false, lastSet: LAST_SET });
  assert.equal(out.recommendation, CURRENT.recommendation);
  assert.equal(out.nextWeight, CURRENT.nextWeight);
  assert.equal(out.confidence, 'high');
  assert.equal(out.reasoning, `${CURRENT.reasoning} Based on your last session, 8 days ago.`);
});

test('staleness: a recent or unknown gap changes nothing, and the input is never mutated', () => {
  for (const days of [0, 3, 6, null, undefined]) {
    const out = applyStalenessGuard(CURRENT, { daysSinceLastSession: days, isBodyweight: false, lastSet: LAST_SET });
    assert.deepEqual(out, CURRENT, `days=${days} must be a no-op`);
  }
  const frozen = applyStalenessGuard(CURRENT, { daysSinceLastSession: 14, isBodyweight: false, lastSet: LAST_SET });
  assert.notEqual(frozen, CURRENT, 'returns a copy, never the input object');
  assert.equal(CURRENT.recommendation, 'Increase to 205 × 6 reps.', 'input untouched');
});
