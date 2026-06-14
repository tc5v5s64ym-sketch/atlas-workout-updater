'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLiftHistory } = require('../services/recommendationHistoryAdapter');

// 11-column Log_Cleaned array row (volume_calc derived by analytics).
function row(date, session, name, muscle, code, weight, reps, rir) {
  return [date, session, name, name, muscle, code, '1', String(weight), String(reps), String(rir), ''];
}

test('maps the most recent working set into previousPerformance', () => {
  const rows = [row('2026-06-10', 'S1', 'Bench Press', 'Chest', 'BEN01', 225, 5, 2)];
  const history = buildLiftHistory(rows, 'BEN01');

  assert.equal(history.previousPerformance.weight, 225);
  assert.equal(history.previousPerformance.reps, 5);
  assert.equal(history.previousPerformance.rir, 2);
  assert.equal(history.previousPerformance.completed, true);
  assert.ok(['low', 'high'].includes(history.recentTrends.fatigueStatus));
  // raw is kept for debugging/tests but is an internal detail.
  assert.ok(history.raw && typeof history.raw === 'object');
});

test('cold start: empty rows return empty previousPerformance/recentTrends', () => {
  const history = buildLiftHistory([], 'BEN01');
  assert.deepEqual(history.previousPerformance, {});
  assert.deepEqual(history.recentTrends, {});
});

test('unknown lift returns no previousPerformance (cold start for that lift)', () => {
  const rows = [row('2026-06-10', 'S1', 'Bench Press', 'Chest', 'BEN01', 225, 5, 2)];
  const history = buildLiftHistory(rows, 'ZZ99');
  assert.deepEqual(history.previousPerformance, {});
});

test('missing liftCode is handled safely', () => {
  const rows = [row('2026-06-10', 'S1', 'Bench Press', 'Chest', 'BEN01', 225, 5, 2)];
  const history = buildLiftHistory(rows, '');
  assert.deepEqual(history.previousPerformance, {});
});
