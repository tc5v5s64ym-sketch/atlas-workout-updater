'use strict';

// Issue #1737 — Fable fix 11 (P1): PROPOSE_EDIT — model names the operation
// and row only; values from the athlete or dropped; athlete accepts a card.
//
// The Fable 5.2 re-audit findings (B-01 P1, B-04 P2, B-23 P3, #1706
// NEW-VARIANT): the model's PROPOSE_EDIT sets weight/reps/RIR the athlete
// never stated (athlete said 'really 140'; 410 was written to Log_Cleaned
// on Save), can delete_set an athlete-logged set out of the approved write,
// and a mid-session add_set plants an exercise-less row that blocks closeout.
// The server checks range only and the client applies with no accept step.
//
// The fix: resolveProposeEdit — a model proposal may identify the operation
// and row only. Every value in the resolved edit is extracted
// deterministically from the athlete's own message; model-supplied values
// are discarded, never trusted. An edit with no athlete-stated value is
// dropped (fail closed). These are the resolver-unit proving probes
// B-write-1, B-write-2, B-write-4; the route-level probes A1706-1..3 live in
// test/proposeEdit1737Route.test.js and the accept-gate probe B-plan-1 in
// tests/e2e/app-smoke.spec.js.
//
// Written against the fixed behavior FIRST (failing-first at head 3c20967c:
// the resolver module does not exist yet).

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveProposeEdit, extractAthleteValues } = require('../services/proposeEditResolver');

// Two logged Bench sets, as currentPreviewRowsForChat sends them.
const PREVIEW = [
  { exercise: 'Bench Press', weight: 135, reps: 5, rir: 2 },
  { exercise: 'Bench Press', weight: 135, reps: 5, rir: 2 },
];

test('B-write-1. update_set: model weight 410 is discarded; athlete-stated 140 survives', () => {
  const resolved = resolveProposeEdit(
    { action: 'update_set', index: 0, weight: 410, reps: 12, rir: 0 },
    'really 140',
    PREVIEW,
  );
  assert.deepEqual(resolved, { action: 'update_set', index: 0, weight: 140 });
});

test('B-write-1. update_set: athlete-stated weight x reps replace the model numbers', () => {
  const resolved = resolveProposeEdit(
    { action: 'update_set', index: 0, weight: 410, reps: 12, rir: 0 },
    'change set 1 to 235x5',
    PREVIEW,
  );
  assert.deepEqual(resolved, { action: 'update_set', index: 0, weight: 235, reps: 5 });
});

test('B-write-1. update_set: no athlete-stated value means the edit is dropped', () => {
  assert.equal(
    resolveProposeEdit({ action: 'update_set', index: 0, weight: 410, reps: 12 }, 'yeah that looks right', PREVIEW),
    null,
    'a bare agreement carries no athlete value — nothing to apply',
  );
  assert.equal(
    resolveProposeEdit({ action: 'update_set', index: 0, weight: 410 }, 'make it heavier', PREVIEW),
    null,
    '"heavier" states no number — the model value must not fill the gap',
  );
});

test('B-write-1. update_set: an out-of-range index is dropped', () => {
  assert.equal(
    resolveProposeEdit({ action: 'update_set', index: 7, weight: 410 }, 'really 140', PREVIEW),
    null,
  );
  assert.equal(
    resolveProposeEdit({ action: 'update_set', index: 0, weight: 410 }, 'really 140', []),
    null,
    'no preview rows means no row to edit',
  );
});

test('B-write-1. update_set: malformed model proposals are dropped', () => {
  assert.equal(resolveProposeEdit({ action: 'update_set', weight: 410 }, 'really 140', PREVIEW), null);
  assert.equal(resolveProposeEdit({ action: 'teleport', index: 0 }, 'really 140', PREVIEW), null);
  assert.equal(resolveProposeEdit(null, 'really 140', PREVIEW), null);
});

test('B-write-2. delete_set: identity-only — index validated, no values to smuggle', () => {
  assert.deepEqual(
    resolveProposeEdit({ action: 'delete_set', index: 0 }, 'that set felt off', PREVIEW),
    { action: 'delete_set', index: 0 },
    'delete carries no values; the athlete accept card (B-plan-1) is its guard',
  );
  assert.equal(
    resolveProposeEdit({ action: 'delete_set', index: 5 }, 'delete set 6', PREVIEW),
    null,
    'an index with no row is dropped',
  );
});

test('B-write-4. add_set: dropped when the preview is empty — no exercise to attach', () => {
  assert.equal(
    resolveProposeEdit({ action: 'add_set', weight: 225, reps: 5, rir: 2 }, 'add one at 140x8', []),
    null,
    'an empty preview would plant an exercise-less row that blocks closeout',
  );
});

test('B-write-4. add_set: athlete-stated values survive; model values do not', () => {
  const resolved = resolveProposeEdit(
    { action: 'add_set', weight: 410, reps: 12, rir: 0 },
    'add one at 140x8',
    PREVIEW,
  );
  assert.deepEqual(resolved, { action: 'add_set', weight: 140, reps: 8 });
  assert.equal(
    resolveProposeEdit({ action: 'add_set', weight: 410, reps: 12 }, 'add another set', PREVIEW),
    null,
    'no athlete-stated values — dropped',
  );
});

test('extractAthleteValues reads the correction shorthand the audit pins', () => {
  assert.deepEqual(extractAthleteValues('really 140'), { weight: 140 });
  assert.deepEqual(extractAthleteValues('change set 1 to 235'), { weight: 235 });
  assert.deepEqual(extractAthleteValues('make it 140x8 rir 2'), { weight: 140, reps: 8, rir: 2 });
  assert.deepEqual(extractAthleteValues('that was 8 reps'), { reps: 8 });
  assert.deepEqual(extractAthleteValues('actually 137.5 lb'), { weight: 137.5 });
  assert.deepEqual(extractAthleteValues('yeah that looks right'), {});
});

test('extractAthleteValues drops out-of-range numbers instead of carrying them', () => {
  assert.deepEqual(extractAthleteValues('really 5000'), {}, 'a 5000 lb "correction" is not a weight');
  assert.deepEqual(extractAthleteValues('really 140'), { weight: 140 });
});
