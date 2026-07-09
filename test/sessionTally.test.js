'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// PR-08 pattern: src/app pure modules are ES modules — dynamic import.
let buildSessionTally;
test.before(async () => { ({ buildSessionTally } = await import('../src/app/sessionTally.js')); });

// Targeted validation sweep (2026-07-09): the coach chat context carried no
// structured record of what was logged this session, so counts/weights were
// inferred from the capped 8-turn transcript — fabricating weights (S1: 225 vs
// 185), undercounting sets once logging exceeded the window (S2: 2 vs 3 rows),
// and losing substitution identity (S4). buildSessionTally turns the authoritative
// per-set buffer into a deterministic tally the coach reads instead of guessing.

test('counts sets per exercise and the working-set total', () => {
  const t = buildSessionTally([
    { exercise: 'Back Squat', weight: 185, reps: 8, rir: 2 },
    { exercise: 'Back Squat', weight: 185, reps: 8, rir: 2 },
    { exercise: 'Back Squat', weight: 185, reps: 7, rir: 1 },
  ], ['Back Squat']);
  assert.equal(t.exercises.length, 1);
  assert.equal(t.exercises[0].sets, 3);
  assert.equal(t.total_working_sets, 3);
  assert.deepEqual(t.exercises[0].per_set.map(s => [s.weight, s.reps, s.rir]), [[185, 8, 2], [185, 8, 2], [185, 7, 1]]);
});

test('multi-exercise: each exercise keeps its own count and weights (no cross-attribution)', () => {
  // The exact S2 shape — 3× Seated Row @190, 2× Lat Pulldown @130.
  const t = buildSessionTally([
    { exercise: 'Seated Row', weight: 190, reps: 10, rir: 2 },
    { exercise: 'Seated Row', weight: 190, reps: 10, rir: 2 },
    { exercise: 'Seated Row', weight: 190, reps: 10, rir: 2 },
    { exercise: 'Lat Pulldown', weight: 130, reps: 12, rir: 2 },
    { exercise: 'Lat Pulldown', weight: 130, reps: 12, rir: 2 },
  ], ['Seated Row', 'Lat Pulldown']);
  const row = t.exercises.find(e => e.exercise === 'Seated Row');
  const pull = t.exercises.find(e => e.exercise === 'Lat Pulldown');
  assert.equal(row.sets, 3, 'rows count exact regardless of transcript window');
  assert.equal(pull.sets, 2);
  assert.equal(t.total_working_sets, 5);
  assert.ok(row.per_set.every(s => s.weight === 190), 'rows keep 190');
  assert.ok(pull.per_set.every(s => s.weight === 130), 'pulldowns keep 130');
});

test('planned flag: an off-plan accessory is planned:false, a plan lift is planned:true', () => {
  const t = buildSessionTally([
    { exercise: 'RDL', weight: 185, reps: 8, rir: 2 },
    { exercise: 'Face Pull', weight: 30, reps: 15, rir: 3 },
  ], ['RDL', 'Back Squat']);
  assert.equal(t.exercises.find(e => e.exercise === 'RDL').planned, true);
  assert.equal(t.exercises.find(e => e.exercise === 'Face Pull').planned, false);
});

test('substitute variant keeps its own identity and count (does not become the plan lift)', () => {
  // S4 shape — plan says Back Squat, user logged 2× Front Squat.
  const t = buildSessionTally([
    { exercise: 'Front Squat', weight: 185, reps: 5, rir: 2 },
    { exercise: 'Front Squat', weight: 185, reps: 5, rir: 2 },
  ], ['Back Squat']);
  assert.equal(t.exercises.length, 1);
  assert.equal(t.exercises[0].exercise, 'Front Squat');
  assert.equal(t.exercises[0].sets, 2);
  assert.equal(t.exercises[0].planned, false, 'a variant not literally in the plan is off-plan/extra');
});

test('empty or nameless log → null (coach then says it has nothing logged yet)', () => {
  assert.equal(buildSessionTally([], ['X']), null);
  assert.equal(buildSessionTally([{ exercise: '' }], []), null);
  assert.equal(buildSessionTally(null, null), null);
});

test('planned is null when no plan names are supplied (freestyle)', () => {
  const t = buildSessionTally([{ exercise: 'Bench Press', weight: 135, reps: 8, rir: 2 }], []);
  assert.equal(t.exercises[0].planned, null);
  assert.equal(t.total_working_sets, 1);
});

test('coerces string/blank numbers and is case-insensitive on the plan match', () => {
  const t = buildSessionTally([
    { exercise: 'Bench Press', weight: '135', reps: '8', rir: '' },
  ], ['bench press']);
  assert.deepEqual(t.exercises[0].per_set[0], { weight: 135, reps: 8, rir: null });
  assert.equal(t.exercises[0].planned, true);
});
