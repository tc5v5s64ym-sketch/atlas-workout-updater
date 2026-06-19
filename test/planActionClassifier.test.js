'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { classifyPlanAction } = require('../services/planActionClassifier');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function classify(opts) {
  return classifyPlanAction(opts);
}

// ---------------------------------------------------------------------------
// on_plan — logged exercise matches the current (first remaining) plan step
// ---------------------------------------------------------------------------

test('on_plan: first planned exercise logged, nothing completed', () => {
  const r = classify({
    planned:   ['Bench Press', 'Rows', 'Lat Pulldown'],
    completed: [],
    loggedName: 'Bench Press',
  });
  assert.equal(r.action, 'on_plan');
  assert.equal(r.prescribedExercise, 'Bench Press');
  assert.deepEqual(r.skippedAhead, []);
});

test('on_plan: second planned exercise logged after first is completed', () => {
  const r = classify({
    planned:   ['Bench Press', 'Rows', 'Lat Pulldown'],
    completed: ['Bench Press'],
    loggedName: 'Rows',
  });
  assert.equal(r.action, 'on_plan');
  assert.equal(r.prescribedExercise, 'Rows');
  assert.deepEqual(r.skippedAhead, []);
});

test('on_plan: case-insensitive name match', () => {
  const r = classify({
    planned:   ['Bench Press', 'Lateral Raise'],
    completed: [],
    loggedName: 'bench press',
  });
  assert.equal(r.action, 'on_plan');
  assert.equal(r.prescribedExercise, 'Bench Press');
});

test('on_plan: lift_code match when names differ (e.g. logged "Barbell Row", planned "Rows", same liftCode)', () => {
  const r = classify({
    planned:   [{ name: 'Rows', liftCode: 'barbell_row' }],
    completed: [],
    loggedName: 'Barbell Row',
    loggedLiftCode: 'barbell_row',
  });
  assert.equal(r.action, 'on_plan');
  assert.equal(r.prescribedExercise, 'Rows');
  assert.deepEqual(r.skippedAhead, []);
});

test('on_plan: lift_code match as second step after first completed', () => {
  const r = classify({
    planned:   [
      { name: 'Bench Press', liftCode: 'bench_press' },
      { name: 'Rows',        liftCode: 'barbell_row' },
    ],
    completed: [{ name: 'Bench Press', liftCode: 'bench_press' }],
    loggedName: 'Barbell Row',
    loggedLiftCode: 'barbell_row',
  });
  assert.equal(r.action, 'on_plan');
  assert.equal(r.prescribedExercise, 'Rows');
});

// ---------------------------------------------------------------------------
// reorder — logged exercise is later in the remaining plan
// ---------------------------------------------------------------------------

test('reorder: third exercise logged while first two are still remaining', () => {
  const r = classify({
    planned:   ['Bench Press', 'Rows', 'Lat Pulldown'],
    completed: [],
    loggedName: 'Lat Pulldown',
  });
  assert.equal(r.action, 'reorder');
  assert.equal(r.prescribedExercise, 'Lat Pulldown');
  assert.deepEqual(r.skippedAhead, ['Bench Press', 'Rows']);
});

test('reorder: second exercise logged first (one skipped)', () => {
  const r = classify({
    planned:   ['Bench Press', 'Lat Pulldown', 'Face Pull'],
    completed: [],
    loggedName: 'Lat Pulldown',
  });
  assert.equal(r.action, 'reorder');
  assert.equal(r.prescribedExercise, 'Lat Pulldown');
  assert.deepEqual(r.skippedAhead, ['Bench Press']);
});

test('reorder: lift_code match against later remaining entry', () => {
  const r = classify({
    planned:   [
      { name: 'Bench Press', liftCode: 'bench_press' },
      { name: 'Rows',        liftCode: 'barbell_row' },
      { name: 'Lat Pulldown', liftCode: 'lat_pulldown' },
    ],
    completed: [],
    loggedName: 'Lat Pulldown',
    loggedLiftCode: 'lat_pulldown',
  });
  assert.equal(r.action, 'reorder');
  assert.equal(r.prescribedExercise, 'Lat Pulldown');
  assert.deepEqual(r.skippedAhead, ['Bench Press', 'Rows']);
});

// ---------------------------------------------------------------------------
// substitute — logged exercise fills a remaining plan slot by pattern/region
// ---------------------------------------------------------------------------

test('substitute: Leg Press for Back Squat (same squat pattern)', () => {
  const r = classify({
    planned:   ['Back Squat', 'Rows', 'Lat Pulldown'],
    completed: [],
    loggedName: 'Leg Press',
  });
  assert.equal(r.action, 'substitute');
  assert.equal(r.prescribedExercise, 'Back Squat');
  assert.deepEqual(r.skippedAhead, []);
});

test('substitute: Barbell Row for Seated Row (same horizontal_pull pattern)', () => {
  const r = classify({
    planned:   ['Bench Press', 'Seated Row'],
    completed: ['Bench Press'],
    loggedName: 'Barbell Row',
  });
  assert.equal(r.action, 'substitute');
  assert.equal(r.prescribedExercise, 'Seated Row');
  assert.deepEqual(r.skippedAhead, []);
});

// ---------------------------------------------------------------------------
// add — logged exercise not in plan and can't fill any remaining slot
// ---------------------------------------------------------------------------

test('add: Face Pull for a plan of [Bench Press, Back Squat] (no pattern match)', () => {
  // Face Pull is delt_isolation; Bench Press is horizontal_push; Back Squat is squat.
  // No broad-region overlap that would pair Face Pull with either planned lift.
  const r = classify({
    planned:   ['Bench Press', 'Back Squat'],
    completed: [],
    loggedName: 'Face Pull',
  });
  assert.equal(r.action, 'add');
  assert.equal(r.prescribedExercise, null);
});

test('add: exercise logged when plan is empty', () => {
  const r = classify({
    planned:   [],
    completed: [],
    loggedName: 'Bench Press',
  });
  assert.equal(r.action, 'add');
  assert.equal(r.prescribedExercise, null);
});

test('add: exercise logged when plan is already fully completed', () => {
  const r = classify({
    planned:   ['Bench Press', 'Rows'],
    completed: ['Bench Press', 'Rows'],
    loggedName: 'Face Pull',
  });
  assert.equal(r.action, 'add');
  assert.equal(r.prescribedExercise, null);
});

test('add: exercise logged when remaining list is empty', () => {
  const r = classify({
    planned:   [{ name: 'Bench Press', liftCode: 'bench_press' }],
    completed: [{ name: 'Bench Press', liftCode: 'bench_press' }],
    loggedName: 'Lateral Raise',
  });
  assert.equal(r.action, 'add');
  assert.equal(r.prescribedExercise, null);
});

// ---------------------------------------------------------------------------
// skip — planned exercise explicitly skipped (no sets logged)
// ---------------------------------------------------------------------------

test('skip: planned exercise skipped, skippedName set, loggedName null', () => {
  const r = classify({
    planned:      ['Bench Press', 'Back Squat'],
    completed:    [],
    loggedName:   null,
    skippedName:  'Back Squat',
  });
  assert.equal(r.action, 'skip');
  assert.equal(r.prescribedExercise, 'Back Squat');
  assert.deepEqual(r.skippedAhead, []);
});

test('skip: skippedName wins even when loggedName is absent string', () => {
  const r = classify({
    planned:     ['Deadlift'],
    completed:   [],
    loggedName:  '',
    skippedName: 'Deadlift',
  });
  assert.equal(r.action, 'skip');
  assert.equal(r.prescribedExercise, 'Deadlift');
});

// ---------------------------------------------------------------------------
// Guard / edge cases
// ---------------------------------------------------------------------------

test('guard: null opts → add (no crash)', () => {
  const r = classify(null);
  assert.equal(r.action, 'add');
  assert.equal(r.prescribedExercise, null);
});

test('guard: loggedName is whitespace-only → add', () => {
  const r = classify({
    planned:   ['Bench Press'],
    completed: [],
    loggedName: '   ',
  });
  assert.equal(r.action, 'add');
});

test('guard: no loggedName and no skippedName → add', () => {
  const r = classify({
    planned:   ['Bench Press'],
    completed: [],
  });
  assert.equal(r.action, 'add');
});

test('result always has all three fields', () => {
  const cases = [
    { planned: ['A'], completed: [], loggedName: 'A' },
    { planned: ['A', 'B'], completed: [], loggedName: 'B' },
    { planned: ['Back Squat'], completed: [], loggedName: 'Leg Press' },
    { planned: ['Bench Press'], completed: [], loggedName: 'Face Pull' },
    { planned: ['Deadlift'], completed: [], skippedName: 'Deadlift' },
    { planned: [], completed: [], loggedName: 'Shrugs' },
  ];
  for (const opts of cases) {
    const r = classify(opts);
    assert.ok(['on_plan', 'reorder', 'substitute', 'add', 'skip'].includes(r.action), `action must be one of five values, got: ${r.action}`);
    assert.ok('prescribedExercise' in r, 'must have prescribedExercise');
    assert.ok(Array.isArray(r.skippedAhead), 'skippedAhead must be array');
  }
});

// ---------------------------------------------------------------------------
// Ordering preservation — skippedAhead reflects plan order
// ---------------------------------------------------------------------------

test('reorder: skippedAhead preserves original plan order', () => {
  const r = classify({
    planned:   ['Squat', 'Bench', 'Deadlift', 'Rows', 'Lat Pulldown'],
    completed: [],
    loggedName: 'Rows',
  });
  assert.equal(r.action, 'reorder');
  assert.deepEqual(r.skippedAhead, ['Squat', 'Bench', 'Deadlift']);
});

test('reorder: skippedAhead only includes remaining (not already-completed) exercises', () => {
  // Squat and Bench are already done; user jumps to Rows, skipping only Deadlift.
  const r = classify({
    planned:   ['Squat', 'Bench', 'Deadlift', 'Rows'],
    completed: ['Squat', 'Bench'],
    loggedName: 'Rows',
  });
  assert.equal(r.action, 'reorder');
  assert.equal(r.prescribedExercise, 'Rows');
  assert.deepEqual(r.skippedAhead, ['Deadlift']);
});
