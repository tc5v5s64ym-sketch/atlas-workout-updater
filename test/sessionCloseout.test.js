'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { computeCloseout } = require('../services/sessionCloseout');

// ---------------------------------------------------------------------------
// Plan not complete — returns null
// ---------------------------------------------------------------------------

test('null: empty planned array', () => {
  assert.equal(computeCloseout([], ['Bench Press']), null);
});

test('null: null planned', () => {
  assert.equal(computeCloseout(null, ['Bench Press']), null);
});

test('null: empty completed array', () => {
  assert.equal(computeCloseout(['Bench Press', 'Rows'], []), null);
});

test('null: one planned exercise still remaining', () => {
  const r = computeCloseout(['Bench Press', 'Rows', 'Lat Pulldown'], ['Bench Press', 'Rows']);
  assert.equal(r, null);
});

test('null: no completed overlap at all', () => {
  assert.equal(computeCloseout(['Bench Press'], ['Rows']), null);
});

// ---------------------------------------------------------------------------
// Plan complete — returns closeout object
// ---------------------------------------------------------------------------

test('complete: single exercise plan', () => {
  const r = computeCloseout(['Bench Press'], ['Bench Press']);
  assert.ok(r !== null);
  assert.equal(r.isComplete, true);
  assert.equal(r.exerciseCount, 1);
  assert.deepEqual(r.planNames, ['Bench Press']);
});

test('complete: three-exercise plan, all done (in order)', () => {
  const r = computeCloseout(
    ['Bench Press', 'Rows', 'Lat Pulldown'],
    ['Bench Press', 'Rows', 'Lat Pulldown']
  );
  assert.ok(r !== null);
  assert.equal(r.isComplete, true);
  assert.equal(r.exerciseCount, 3);
  assert.deepEqual(r.planNames, ['Bench Press', 'Rows', 'Lat Pulldown']);
});

test('complete: completed in different order than planned', () => {
  const r = computeCloseout(
    ['Bench Press', 'Rows', 'Lat Pulldown'],
    ['Lat Pulldown', 'Bench Press', 'Rows']
  );
  assert.ok(r !== null);
  assert.equal(r.isComplete, true);
  assert.equal(r.exerciseCount, 3);
});

test('complete: case-insensitive name match', () => {
  const r = computeCloseout(['Bench Press'], ['bench press']);
  assert.ok(r !== null);
  assert.equal(r.isComplete, true);
});

test('complete: extra completed entries beyond the plan are ignored', () => {
  const r = computeCloseout(
    ['Bench Press', 'Rows'],
    ['Bench Press', 'Rows', 'Face Pull', 'Lateral Raise']
  );
  assert.ok(r !== null);
  assert.equal(r.isComplete, true);
  assert.equal(r.exerciseCount, 2);
  assert.deepEqual(r.planNames, ['Bench Press', 'Rows']);
});

// ---------------------------------------------------------------------------
// lift_code identity — computePlanState bridges name mismatches via liftCode
// ---------------------------------------------------------------------------

test('complete: lift_code match bridges name mismatch (Rows ↔ Barbell Row)', () => {
  const planned   = [{ name: 'Rows',        liftCode: 'barbell_row' }];
  const completed = [{ name: 'Barbell Row', liftCode: 'barbell_row' }];
  const r = computeCloseout(planned, completed);
  assert.ok(r !== null);
  assert.equal(r.isComplete, true);
  assert.equal(r.exerciseCount, 1);
  assert.deepEqual(r.planNames, ['Rows']);
});

test('complete: lift_code multi-exercise full plan', () => {
  const planned = [
    { name: 'Bench Press', liftCode: 'bench_press'  },
    { name: 'Rows',        liftCode: 'barbell_row'  },
    { name: 'Lat Pulldown',liftCode: 'lat_pulldown' },
  ];
  const completed = [
    { name: 'Barbell Bench Press', liftCode: 'bench_press'  },
    { name: 'Barbell Row',         liftCode: 'barbell_row'  },
    { name: 'Lat Pulldown',        liftCode: 'lat_pulldown' },
  ];
  const r = computeCloseout(planned, completed);
  assert.ok(r !== null);
  assert.equal(r.isComplete, true);
  assert.equal(r.exerciseCount, 3);
});

test('null: lift_code mismatch, one exercise still remaining', () => {
  const planned = [
    { name: 'Bench Press', liftCode: 'bench_press' },
    { name: 'Rows',        liftCode: 'barbell_row' },
  ];
  const completed = [
    { name: 'Barbell Bench Press', liftCode: 'bench_press' },
    // Rows not yet logged
  ];
  assert.equal(computeCloseout(planned, completed), null);
});

// ---------------------------------------------------------------------------
// Result shape invariant
// ---------------------------------------------------------------------------

test('result shape: isComplete, exerciseCount, planNames always present', () => {
  const r = computeCloseout(['Back Squat', 'Deadlift'], ['Back Squat', 'Deadlift']);
  assert.ok(r !== null);
  assert.equal(typeof r.isComplete, 'boolean');
  assert.equal(r.isComplete, true);
  assert.equal(typeof r.exerciseCount, 'number');
  assert.ok(Array.isArray(r.planNames));
});

test('planNames reflects plan entry names, not logged names', () => {
  const planned   = [{ name: 'Rows', liftCode: 'barbell_row' }];
  const completed = [{ name: 'Barbell Row', liftCode: 'barbell_row' }];
  const r = computeCloseout(planned, completed);
  assert.ok(r !== null);
  // planNames carries the PLAN entry names, not the logged names
  assert.deepEqual(r.planNames, ['Rows']);
});
