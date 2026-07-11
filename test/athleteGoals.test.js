'use strict';

// Soul Plan PR-B8a — Structured goals reader.
//
// The one identity fact the training log can't derive: what the lifter is
// training TOWARD. Owner-ratified storage (D8) is a Constraints-tab row with
// kind `goal` and a `target` cell like "bench_press 215" (lift_code + weight,
// optional trailing reps). readAthleteGoals is a pure, read-only parser over the
// already-fetched Constraints rows — it NEVER writes, never throws, and skips any
// malformed row rather than fabricating a goal. Goals are hand-seeded owner data;
// the app never creates them (POST /api/constraints rejects a `goal` kind).

const test = require('node:test');
const assert = require('node:assert/strict');
const { readAthleteGoals } = require('../services/athleteGoals');

// A Constraints row is either a positional array [date, kind, target, rule, note]
// or an object with those keys — readAthleteGoals must accept both (getSheetRows
// returns either shape), mirroring the route's constraint mapping.
const arrRow = (date, kind, target, rule = '', note = '') => [date, kind, target, rule, note];

test('parses a valid goal row (array shape): lift_code + target_weight from the target cell', () => {
  const out = readAthleteGoals([arrRow('2026-07-11', 'goal', 'bench_press 215', '', 'chasing this')]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    lift_code: 'bench_press',
    target_weight: 215,
    target_reps: null,
    set_date: '2026-07-11',
    note: 'chasing this',
  });
});

test('parses a valid goal row (object shape) and an optional trailing target_reps', () => {
  const out = readAthleteGoals([
    { date: '2026-06-01', kind: 'goal', target: 'back_squat 315 3', rule: '', note: '' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].lift_code, 'back_squat');
  assert.equal(out[0].target_weight, 315);
  assert.equal(out[0].target_reps, 3);
  assert.equal(out[0].set_date, '2026-06-01');
  assert.equal(out[0].note, null, 'an empty note cell is null, never ""');
});

test('returns ONLY goal-kind rows — injury / equipment / preference constraints are ignored', () => {
  const out = readAthleteGoals([
    arrRow('2026-07-01', 'injury', 'left knee', 'avoid', 'no deep flexion'),
    arrRow('2026-07-02', 'goal', 'bench_press 215', '', ''),
    arrRow('2026-07-03', 'equipment', 'barbell', 'substitute', ''),
    arrRow('2026-07-04', 'preference', 'mornings', 'limit', ''),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].lift_code, 'bench_press');
});

test('degrade-to-skip: malformed goal rows are dropped, never fabricated', () => {
  const out = readAthleteGoals([
    arrRow('2026-07-01', 'goal', ''),                 // empty target
    arrRow('2026-07-01', 'goal', 'bench_press'),      // no weight token
    arrRow('2026-07-01', 'goal', 'bench_press heavy'),// unparseable weight
    arrRow('2026-07-01', 'goal', 'bench_press 0'),    // non-positive weight
    arrRow('2026-07-01', 'goal', 'bench_press -5'),   // negative weight
    arrRow('2026-07-01', 'goal', '225 225'),          // numeric lift_code
    null,                                              // null row
    'nope',                                            // string row
    42,                                                // number row
    { kind: 'goal' },                                  // object row, no target
  ]);
  assert.deepEqual(out, [], 'no malformed row may produce a goal');
});

test('a non-numeric trailing reps token is dropped to null, but the goal still stands', () => {
  const out = readAthleteGoals([arrRow('2026-07-01', 'goal', 'deadlift 405 heavy')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].target_weight, 405);
  assert.equal(out[0].target_reps, null, 'unparseable reps → null, goal is not rejected');
});

test('kind match is case/whitespace tolerant; empty / non-array input returns []', () => {
  assert.equal(readAthleteGoals([arrRow('2026-07-01', ' Goal ', 'bench_press 215')]).length, 1);
  assert.deepEqual(readAthleteGoals([]), []);
  assert.deepEqual(readAthleteGoals(null), []);
  assert.deepEqual(readAthleteGoals(undefined), []);
  assert.deepEqual(readAthleteGoals('rows'), []);
});

test('is pure and never throws on hostile input', () => {
  assert.doesNotThrow(() => readAthleteGoals([{}, [], null, { target: {} }, { kind: 'goal', target: 42 }]));
});
