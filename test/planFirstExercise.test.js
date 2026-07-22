'use strict';

// services/planFirstExercise — make the authoritative recommendation LEAD with the
// athlete's requested first exercise ("Plan me a workout but have it start with back
// squats"). 2026-07-22 requirement: the numbers come from the deterministic engine
// (the caller resolves `target` via recommendNextSet) — NEVER fabricated here; when
// history can't support a load the injected entry carries an EXPLICIT unresolved-load
// state, never a silently omitted field. Pure/read-only: it only reorders/annotates
// the recommendation object the route already built.

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyFirstExercise, buildInjectedEntry, normKey } = require('../services/planFirstExercise');

function recResult(exercises) {
  return { intents: [{ recommended: true, exercises }] };
}

test('normKey uppercases and strips non-alphanumerics', () => {
  assert.equal(normKey('Back Squat'), 'BACKSQUAT');
  assert.equal(normKey('back-squat'), 'BACKSQUAT');
  assert.equal(normKey('BSQ01'), 'BSQ01');
  assert.equal(normKey(null), '');
  assert.equal(normKey(undefined), '');
});

test('buildInjectedEntry with a resolved target carries the full structured fields', () => {
  const e = buildInjectedEntry('Back Squat', 'BSQ01', { weight: 225, reps: 5, sets: 3, rir: 2 });
  assert.equal(e.exercise, 'Back Squat');
  assert.equal(e.lift_code, 'BSQ01');
  assert.equal(e.target_weight, 225);
  assert.equal(e.target_reps, 5);
  assert.equal(e.target_sets, 3);
  assert.equal(e.target_rir, 2);
  assert.equal(e.requested_first, true);
  assert.ok(!e.unresolved_load, 'a resolved load is not an unresolved-load entry');
});

test('buildInjectedEntry treats bodyweight (weight 0) as a resolved load, not unresolved', () => {
  const e = buildInjectedEntry('Pull-Up', 'PUL01', { weight: 0, reps: 8, sets: 3, rir: 2 });
  assert.equal(e.target_weight, 0);
  assert.ok(!e.unresolved_load, 'weight 0 is bodyweight — a resolved load');
});

test('buildInjectedEntry with NO resolvable load surfaces an EXPLICIT unresolved-load state', () => {
  const e = buildInjectedEntry('Back Squat', 'BSQ01', null);
  assert.equal(e.unresolved_load, true);
  assert.equal(e.target_weight, null, 'never a fabricated weight');
  assert.equal(e.target_reps, null);
  assert.equal(e.target_sets, null);
  assert.equal(e.target_rir, null);
  assert.equal(e.requested_first, true);
  assert.match(e.reason, /Back Squat/);
  assert.match(e.reason, /history|starting weight/i, 'the reason must explain the load is unresolved');
});

test('applyFirstExercise MOVES an already-present lift to the front (by lift code)', () => {
  const result = recResult([
    { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185 },
    { exercise: 'Back Squat', lift_code: 'BSQ01', target_weight: 225 },
    { exercise: 'Row', lift_code: 'ROW01', target_weight: 155 },
  ]);
  applyFirstExercise(result, { name: 'Back Squat', code: 'BSQ01', target: null });
  const rec = result.intents[0];
  assert.equal(rec.exercises[0].lift_code, 'BSQ01', 'Back Squat now leads');
  assert.equal(rec.exercises.length, 3, 'no exercise added or dropped when moving');
  assert.equal(rec.requested_first_exercise, 'Back Squat');
  // The moved entry keeps its ORIGINAL resolved numbers — untouched.
  assert.equal(rec.exercises[0].target_weight, 225);
});

test('applyFirstExercise MOVES by canonical name when the lift code differs/absent', () => {
  const result = recResult([
    { exercise: 'Bench Press', lift_code: 'BEN01' },
    { exercise: 'Back Squat', lift_code: '' },
  ]);
  applyFirstExercise(result, { name: 'Back Squat', code: null, target: null });
  assert.equal(result.intents[0].exercises[0].exercise, 'Back Squat');
});

test('applyFirstExercise INJECTS a resolved entry at the front when the lift is absent', () => {
  const result = recResult([
    { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185 },
  ]);
  applyFirstExercise(result, { name: 'Back Squat', code: 'BSQ01', target: { weight: 225, reps: 5, sets: 3, rir: 2 } });
  const rec = result.intents[0];
  assert.equal(rec.exercises.length, 2, 'the requested lift was injected');
  assert.equal(rec.exercises[0].exercise, 'Back Squat');
  assert.equal(rec.exercises[0].target_weight, 225);
  assert.ok(!rec.exercises[0].unresolved_load);
  assert.equal(rec.requested_first_exercise, 'Back Squat');
});

test('applyFirstExercise INJECTS an EXPLICIT unresolved-load entry when history cannot set a load', () => {
  const result = recResult([
    { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185 },
  ]);
  applyFirstExercise(result, { name: 'Back Squat', code: 'BSQ01', target: null });
  const first = result.intents[0].exercises[0];
  assert.equal(first.exercise, 'Back Squat');
  assert.equal(first.unresolved_load, true);
  assert.equal(first.target_weight, null, 'no fabricated number');
  assert.match(first.reason, /Back Squat/);
});

test('applyFirstExercise leaves the plan unchanged when the lift already leads', () => {
  const result = recResult([
    { exercise: 'Back Squat', lift_code: 'BSQ01', target_weight: 225 },
    { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 185 },
  ]);
  applyFirstExercise(result, { name: 'Back Squat', code: 'BSQ01', target: null });
  const rec = result.intents[0];
  assert.equal(rec.exercises.length, 2);
  assert.equal(rec.exercises[0].lift_code, 'BSQ01');
  assert.equal(rec.exercises[0].target_weight, 225, 'the leading entry is untouched');
});

test('applyFirstExercise is a no-op with no request / no recommended intent', () => {
  const base = recResult([{ exercise: 'Bench Press', lift_code: 'BEN01' }]);
  assert.equal(applyFirstExercise(base, {}).intents[0].exercises.length, 1);
  assert.equal(applyFirstExercise(base, { name: '   ' }).intents[0].exercises.length, 1);
  // no recommended intent
  const noRec = { intents: [{ recommended: false, exercises: [] }] };
  assert.deepEqual(applyFirstExercise(noRec, { name: 'Back Squat' }), noRec);
  // malformed result
  assert.doesNotThrow(() => applyFirstExercise(null, { name: 'Back Squat' }));
  assert.doesNotThrow(() => applyFirstExercise({}, { name: 'Back Squat' }));
});
