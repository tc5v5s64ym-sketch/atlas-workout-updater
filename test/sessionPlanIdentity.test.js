'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCompletedIdentity } = require('../public/sessionPlanIdentity');

test('resolveCompletedIdentity: lift_code match returns planned canonical name', () => {
  const plan = {
    exercises: [
      { name: 'Rows', canonicalName: 'Barbell Row', liftCode: 'barbell_row' },
    ],
  };
  const row = { exercise: 'Rows', canonical_exercise: 'Seated Row', lift_code: 'barbell_row' };
  assert.equal(resolveCompletedIdentity('Rows', row, plan), 'Barbell Row');
});

test('resolveCompletedIdentity: canonical enrichment match returns planned canonical name', () => {
  const plan = {
    exercises: [
      { name: 'Rows', canonicalName: 'Barbell Row', liftCode: 'barbell_row' },
    ],
  };
  const row = { exercise: 'Barbell Row', canonical_exercise: 'Barbell Row' };
  assert.equal(resolveCompletedIdentity('Barbell Row', row, plan), 'Barbell Row');
});

test('resolveCompletedIdentity: raw plan display-name match works when enrichment is missing', () => {
  // Regression: the mid-session dry-run enrichment call is best-effort. If it
  // fails, raw "Rows" still has to resolve to the canonical plan identity so
  // plan completion can close out instead of announcing a stale next exercise.
  const plan = {
    exercises: [
      { name: 'Rows', canonicalName: 'Barbell Row', liftCode: 'barbell_row' },
    ],
  };
  assert.equal(resolveCompletedIdentity('Rows', null, plan), 'Barbell Row');
});

test('resolveCompletedIdentity: raw canonical-name match works when enrichment is missing', () => {
  const plan = {
    exercises: [
      { name: 'Rows', canonicalName: 'Barbell Row', liftCode: 'barbell_row' },
    ],
  };
  assert.equal(resolveCompletedIdentity('Barbell Row', null, plan), 'Barbell Row');
});

test('resolveCompletedIdentity: unmatched raw name falls back unchanged', () => {
  const plan = {
    exercises: [
      { name: 'Rows', canonicalName: 'Barbell Row', liftCode: 'barbell_row' },
    ],
  };
  assert.equal(resolveCompletedIdentity('Face Pull', null, plan), 'Face Pull');
});
