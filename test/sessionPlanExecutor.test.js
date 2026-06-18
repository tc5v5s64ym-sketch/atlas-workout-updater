'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { computePlanState } = require('../services/sessionPlanExecutor');

/* ===== Shape ===== */

test('computePlanState: returns object with planned, completed, remaining, isComplete', () => {
  const s = computePlanState(['Bench', 'Rows'], []);
  assert.ok('planned'    in s);
  assert.ok('completed'  in s);
  assert.ok('remaining'  in s);
  assert.ok('isComplete' in s);
});

/* ===== Empty / guard cases ===== */

test('computePlanState: empty planned and completed → all arrays empty, isComplete false', () => {
  const s = computePlanState([], []);
  assert.deepEqual(s.planned,   []);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, false);
});

test('computePlanState: null planned → treated as empty', () => {
  const s = computePlanState(null, []);
  assert.deepEqual(s.planned, []);
  assert.equal(s.isComplete, false);
});

test('computePlanState: null completed → treated as empty', () => {
  const s = computePlanState(['Bench'], null);
  assert.deepEqual(s.remaining, ['Bench']);
  assert.equal(s.isComplete, false);
});

test('computePlanState: non-string entries in planned are silently dropped', () => {
  const s = computePlanState([null, 42, 'Bench', undefined, ''], []);
  assert.deepEqual(s.planned,   ['Bench']);
  assert.deepEqual(s.remaining, ['Bench']);
});

test('computePlanState: non-string entries in completed are silently dropped', () => {
  const s = computePlanState(['Bench'], [null, 42, undefined, '']);
  assert.deepEqual(s.remaining, ['Bench']);
});

test('computePlanState: whitespace-only strings are dropped from both lists', () => {
  const s = computePlanState(['   ', 'Bench'], ['   ']);
  assert.deepEqual(s.planned, ['Bench']);
  assert.equal(s.isComplete, false);
});

/* ===== Core behaviour ===== */

test('computePlanState: no completions → all planned are remaining', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows', 'Face Pull'], []);
  assert.deepEqual(s.remaining, ['Lat Pulldown', 'Rows', 'Face Pull']);
  assert.equal(s.isComplete, false);
});

test('computePlanState: all exercises completed → remaining is empty, isComplete true', () => {
  const s = computePlanState(['Bench', 'Rows'], ['Bench', 'Rows']);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

test('computePlanState: one of two exercises completed → remaining contains the other', () => {
  const s = computePlanState(['Bench', 'Rows'], ['Bench']);
  assert.deepEqual(s.remaining, ['Rows']);
  assert.equal(s.isComplete, false);
});

/* ===== Acceptance scenario (PR 357) ===== */

test('acceptance: plan=[Lat Pulldown, Rows], completed=[Rows] → Lat Pulldown remains, isComplete false', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows'], ['Rows']);
  assert.deepEqual(s.remaining, ['Lat Pulldown']);
  assert.deepEqual(s.completed, ['Rows']);
  assert.equal(s.isComplete, false);
});

test('acceptance: completing Lat Pulldown after Rows → session is complete', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows'], ['Rows', 'Lat Pulldown']);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

/* ===== Case-insensitivity ===== */

test('computePlanState: matching is case-insensitive', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows'], ['lat pulldown']);
  assert.deepEqual(s.remaining, ['Rows']);
});

test('computePlanState: mixed-case completed matches planned regardless of casing', () => {
  const s = computePlanState(['Bench Press', 'Deadlift'], ['BENCH PRESS', 'deadlift']);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

/* ===== Ordering preservation ===== */

test('computePlanState: remaining preserves the original planned order', () => {
  const s = computePlanState(['Squat', 'Bench', 'Deadlift', 'Rows'], ['Bench']);
  assert.deepEqual(s.remaining, ['Squat', 'Deadlift', 'Rows']);
});

/* ===== Extras in completed (user-added exercises not in plan) ===== */

test('computePlanState: completed may include exercises not in planned (added work) — remaining unaffected', () => {
  const s = computePlanState(['Bench', 'Rows'], ['Bench', 'Shrugs']);
  assert.deepEqual(s.remaining, ['Rows']);
  assert.ok(s.completed.includes('Shrugs'));
});

/* ===== isComplete edge cases ===== */

test('computePlanState: empty planned list is NOT isComplete even with non-empty completed', () => {
  const s = computePlanState([], ['Bench', 'Rows']);
  assert.equal(s.isComplete, false);
});

test('computePlanState: single exercise plan, not yet done → isComplete false', () => {
  const s = computePlanState(['Deadlift'], []);
  assert.equal(s.isComplete, false);
});

test('computePlanState: single exercise plan, completed → isComplete true', () => {
  const s = computePlanState(['Deadlift'], ['Deadlift']);
  assert.equal(s.isComplete, true);
});
