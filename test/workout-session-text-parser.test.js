'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkoutSessionText, splitSessionLines } = require('../services/workoutSessionTextParser');

function setTriples(exercise) {
  return exercise.sets.map(set => [set.weight, set.reps, set.rir]);
}

test('session parser previews a multi-line missed workout without writing', () => {
  const result = parseWorkoutSessionText(`
Bench 225 5/2 x3
Lat pull 170 10/2 175 8/2 8/1
Chin ups 8/2 x3
DB walking lunges 40s 12/2 x3
`);

  assert.equal(result.intent, 'log_session');
  assert.equal(result.sheet_written, false);
  assert.equal(result.no_write_confirmed, true);
  assert.equal(result.total_exercises, 4);
  assert.equal(result.total_sets, 12);
  assert.deepEqual(result.exercises.map(exercise => exercise.canonical_name), [
    'Bench Press',
    'Lat Pulldown',
    'Chin Ups',
    'Db Walking Lunges',
  ]);

  assert.deepEqual(setTriples(result.exercises[0]), [[225, 5, 2], [225, 5, 2], [225, 5, 2]]);
  assert.deepEqual(setTriples(result.exercises[1]), [[170, 10, 2], [175, 8, 2], [175, 8, 1]]);
  assert.deepEqual(setTriples(result.exercises[2]), [[null, 8, 2], [null, 8, 2], [null, 8, 2]]);
  assert.deepEqual(setTriples(result.exercises[3]), [[40, 12, 2], [40, 12, 2], [40, 12, 2]]);

  assert.equal(result.exercises[2].needs_catalog_review, true);
  assert.equal(result.exercises[3].needs_catalog_review, true);
  assert.ok(result.warnings.includes('unknown_exercise'));
});

test('session parser ignores blank lines and preserves original line numbers', () => {
  const result = parseWorkoutSessionText(`

- Bench 225 5/2 x3

* Face pulls 50 15/2 x3
`);

  assert.equal(result.intent, 'log_session');
  assert.equal(result.total_exercises, 2);
  assert.deepEqual(result.exercises.map(exercise => exercise.line_number), [3, 5]);
  assert.deepEqual(result.exercises.map(exercise => exercise.canonical_name), ['Bench Press', 'Face Pull']);
});

test('session parser returns line-numbered clarification for ambiguous lines', () => {
  const result = parseWorkoutSessionText(`
Bench 225 5/2 x3
Press 100 5/2
Lat pull 170 10/2 x3
`);

  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.sheet_written, false);
  assert.equal(result.no_write_confirmed, true);
  assert.ok(result.warnings.includes('session_line_needs_clarification'));
  assert.equal(result.line_errors.length, 1);
  assert.equal(result.line_errors[0].line_number, 3);
  assert.equal(result.line_errors[0].raw_text, 'Press 100 5/2');
  assert.ok(result.line_errors[0].warnings.includes('ambiguous_exercise_alias'));
  assert.match(result.line_errors[0].message, /Which press/i);
  assert.equal(result.partial.total_exercises, 2);
  assert.equal(result.partial.total_sets, 6);
});

test('session parser does not guess mixed exercises on one line', () => {
  const result = parseWorkoutSessionText('Bench 225 5/2 squat 185 5/2');

  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.line_errors.length, 1);
  assert.equal(result.line_errors[0].line_number, 1);
  assert.ok(result.line_errors[0].warnings.includes('multiple_exercises_in_input'));
  assert.equal(result.partial.total_exercises, 0);
  assert.equal(result.partial.total_sets, 0);
});

test('splitSessionLines strips simple bullets without changing source line numbers', () => {
  const lines = splitSessionLines(`
• Chin ups 8/2 x3
- Hang cleans 135 3/2 x5
* Backflips 10 x3
`);

  assert.deepEqual(lines, [
    { line_number: 2, raw_text: 'Chin ups 8/2 x3' },
    { line_number: 3, raw_text: 'Hang cleans 135 3/2 x5' },
    { line_number: 4, raw_text: 'Backflips 10 x3' },
  ]);
});
