const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseWorkoutText, splitMultiExerciseSegments } = require('../services/workoutTextParser');

// --- splitMultiExerciseSegments ---

test('splitMultiExerciseSegments: splits the real way-2 inline paste on recognized names', () => {
  const input = 'Deadlift 135 10/4 185 10/2 245 6/1 5/1 4/2 bench 135 10/5 185 10/2 230 5/1 5/0 4/2';
  assert.deepEqual(splitMultiExerciseSegments(input), [
    'Deadlift 135 10/4 185 10/2 245 6/1 5/1 4/2',
    'bench 135 10/5 185 10/2 230 5/1 5/0 4/2'
  ]);
});

test('splitMultiExerciseSegments: returns null for a single exercise (nothing to split)', () => {
  assert.equal(splitMultiExerciseSegments('Bench 225 5/2 5/2 5/2'), null);
});

// --- parseWorkoutText: the way-2 flow ---

test('parseWorkoutText: inline multi-exercise → log_sets_multi with per-exercise sets', () => {
  const r = parseWorkoutText('Deadlift 135 10/4 185 10/2 245 6/1 5/1 4/2 bench 135 10/5 185 10/2 230 5/1 5/0 4/2');
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(r.exercises.map(e => e.canonical_name), ['Deadlift', 'Bench Press']);
  assert.deepEqual(r.exercises[0].sets.map(s => [s.weight, s.reps, s.rir]),
    [[135, 10, 4], [185, 10, 2], [245, 6, 1], [245, 5, 1], [245, 4, 2]]);
  assert.deepEqual(r.exercises[1].sets.map(s => [s.weight, s.reps, s.rir]),
    [[135, 10, 5], [185, 10, 2], [230, 5, 1], [230, 5, 0], [230, 4, 2]]);
});

test('parseWorkoutText: never mis-logs — a chunk with no sets falls back to clarification', () => {
  const r = parseWorkoutText('Bench 225 5/2 and then some squats');
  assert.equal(r.intent, 'needs_clarification');
  assert.ok((r.warnings || []).includes('multiple_exercises_in_input'));
  assert.equal(r.exercises, undefined);
  assert.equal(r.sets, undefined);
});

test('parseWorkoutText: a single exercise is unaffected (still log_sets)', () => {
  const r = parseWorkoutText('Bench 225 5/2 5/2 5/2');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Bench Press');
  assert.equal(r.sets.length, 3);
});

test('parseWorkoutText: three inline exercises all log, each with its own weight', () => {
  const r = parseWorkoutText('Deadlift 315 5/2 Bench 225 5/2 Seated Row 120 10/2');
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(r.exercises.map(e => e.canonical_name), ['Deadlift', 'Bench Press', 'Seated Row']);
  assert.deepEqual(r.exercises.map(e => e.sets[0].weight), [315, 225, 120]);
});

// --- client wiring (app.js source guard) ---

test('app.js rowsFromBackendParsedWorkout flattens a log_sets_multi result into rows', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const fn = appSrc.slice(
    appSrc.indexOf('function rowsFromBackendParsedWorkout('),
    appSrc.indexOf('function rowsFromBackendParsedWorkout(') + 1200
  );
  assert.match(fn, /intent === 'log_sets_multi'/, 'must handle the multi-exercise intent');
  assert.match(fn, /parsed\.exercises/, 'must flatten parsed.exercises into rows');
});
