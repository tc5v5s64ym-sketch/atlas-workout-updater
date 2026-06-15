const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionSummary,
  computeMuscleGroupVolume,
  computeExerciseProgress,
  detectRecentPrs,
  recommendNextSet,
  detectStalls,
  suggestDeloads,
  computeFatigueStatus,
  buildMuscleGroupReadiness,
  scoreIntents,
  buildProgressSummary,
  buildWeeklyReport,
  recoveryFraction,
  effortIntensityBySession,
  roundLoad
} = require('../services/analytics');

test('roundLoad snaps a computed load to the nearest rackable 5 lb increment', () => {
  assert.equal(roundLoad(166.5), 165); // 185 × 0.9 → rackable, not 167
  assert.equal(roundLoad(157.5), 160); // 175 × 0.9 → half rounds up
  assert.equal(roundLoad(180), 180);   // already on the grid
  assert.equal(roundLoad(172.4), 170);
  assert.equal(roundLoad(173), 175);
  assert.equal(roundLoad(100, 10), 100);
  assert.equal(roundLoad(104, 10), 100);
});

test('roundLoad is defensive about bad input', () => {
  assert.equal(roundLoad(null), null);
  assert.equal(roundLoad('nope'), null);
  assert.equal(roundLoad(undefined), null);
  // A non-positive step falls back to the 5 lb default rather than dividing by zero.
  assert.equal(roundLoad(166.5, 0), 165);
});

test('deload holds working weight (185 stall → 185, volume-first)', () => {
  // Volume-first deload: hold the working weight, cut sets — not a weight reduction.
  const stallRows = [];
  for (let s = 1; s <= 5; s += 1) {
    stallRows.push(['2026-05-0' + s, 'S' + s, 'Overhead Press', 'Overhead Press', 'Shoulders', 'OHP01', '1', '185', '5', '2', '']);
  }
  const deloads = suggestDeloads(stallRows, 4);
  assert.equal(deloads.length, 1);
  assert.equal(deloads[0].suggested_deload_weight, 185);
  assert.equal(deloads[0].suggested_deload_weight % 5, 0, 'deload weight must be rackable');
});

const logRows = [
  ['2026-06-02', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '5', '2', 'solid'],
  ['2026-06-02', 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '185', '5', '2', 'solid'],
  ['2026-06-04', 'S2', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '225', '5', '2', 'solid'],
  ['2026-06-09', 'S3', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '195', '5', '2', 'solid'],
  ['2026-06-09', 'S3', 'Lat Pulldown', 'Lat Pulldown', 'Back', 'LPD01', '1', '160', '8', '3', 'solid']
];

const effortRows = [
  ['2026-06-02', 'S1', '45:00', '300', '380', '120', '160', 'Home', ''],
  ['2026-06-09', 'S3', '60:00', '500', '620', '150', '178', 'Gym', '']
];

const stallRows = [
  ['2026-05-20', 'A', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '200', '5', '2', ''],
  ['2026-05-27', 'B', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '200', '5', '2', ''],
  ['2026-06-03', 'C', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '200', '5', '2', ''],
  ['2026-06-10', 'D', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '200', '5', '2', '']
];

function assertNoNonFinite(value, path = 'value') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} should be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNonFinite(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoNonFinite(item, `${path}.${key}`);
    }
  }
}

test('analytics valid-input characterization', () => {
  const summary = buildSessionSummary(logRows, effortRows, 'S1');
  assert.equal(summary.session_id, 'S1');
  assert.equal(summary.date, '2026-06-02');
  assert.deepEqual(summary.exercises, ['Bench Press']);
  assert.equal(summary.total_sets, 2);
  assert.equal(summary.total_volume, 1850);
  assert.equal(summary.top_set.weight, 185);

  const volume = computeMuscleGroupVolume(logRows, 30);
  assert.deepEqual(volume, [
    { muscle_group: 'Chest', volume: 2825, set_count: 3 },
    { muscle_group: 'Quads', volume: 1125, set_count: 1 },
    { muscle_group: 'Back', volume: 1280, set_count: 1 }
  ]);

  const progress = computeExerciseProgress(logRows, 'BEN01');
  assert.equal(progress.sessions.length, 2);
  assert.deepEqual(progress.best_weight_over_time.map(item => item.best_weight), [185, 195]);
  assert.deepEqual(progress.estimated_1rm_over_time.map(item => item.estimated_1rm), [215.83, 227.5]);
  assert.equal(progress.recent_trend, 'up');

  const prs = detectRecentPrs(logRows);
  const benchPr = prs.find(item => item.liftCode === 'BEN01');
  assert.equal(benchPr.bestWeightSet.weight, 195);
  assert.equal(benchPr.bestEstimated1RMSet.estimated_1rm, 227.5);

  const recommendation = recommendNextSet(logRows, 'BEN01', { today: '2026-06-10' });
  assert.equal(recommendation.next_target.weight, 200);
  assert.equal(recommendation.next_target.reps, 5);
  assert.equal(recommendation.sessions_analyzed, 2);
  assert.equal(recommendation.days_since_last_session, 1);

  const stalls = detectStalls(stallRows, 3);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].last_best_weight, 200);

  const deloads = suggestDeloads(stallRows, 4);
  assert.equal(deloads.length, 1);
  assert.equal(deloads[0].suggested_deload_weight, 200);

  const fatigue = computeFatigueStatus(logRows, '2026-06-10T12:00:00Z');
  assert.equal(fatigue.recent_volume, 3380);
  assert.equal(fatigue.baseline_weekly_volume, 617);
  assert.equal(fatigue.status, 'high');

  const readiness = buildMuscleGroupReadiness(logRows, { today: '2026-06-10', effortRows });
  assert.equal(readiness.length, 5);
  assert.equal(readiness.find(item => item.pattern === 'push').status, 'fatigued');
  assert.equal(readiness.find(item => item.pattern === 'pull').status, 'recovering');

  const intents = scoreIntents(logRows, effortRows, { today: '2026-06-10' });
  assert.equal(intents.today, '2026-06-10');
  assert.equal(intents.intents.length, 8);
  assert.ok(intents.todays_read.recommended_intent_id);

  const progressSummary = buildProgressSummary(logRows, { today: '2026-06-10', weeks: 8 });
  assert.equal(progressSummary.total_sessions, 3);
  assert.equal(progressSummary.total_sets, 5);
  assert.equal(progressSummary.total_volume, 5230);
  assert.equal(progressSummary.current_week_sessions, 1);

  const report = buildWeeklyReport(logRows, { today: '2026-06-10', days: 7 });
  assert.equal(report.period_start, '2026-06-04');
  assert.equal(report.period_end, '2026-06-10');
  assert.equal(report.sessions_count, 2);
  assert.equal(report.total_sets, 3);
  assert.equal(report.total_volume, 3380);

  assert.equal(Number(recoveryFraction(3, 2, 1).toFixed(6)), 0.765808);

  const intensity = effortIntensityBySession(effortRows);
  assert.equal(intensity.get('S1'), 0);
  assert.equal(intensity.get('S3'), 1);
});

test('analytics functions return safe defaults for empty or missing inputs', () => {
  assert.equal(buildSessionSummary(undefined, undefined, 'MISSING').total_sets, 0);
  assert.deepEqual(computeMuscleGroupVolume(undefined, 30), []);
  assert.equal(computeExerciseProgress(undefined, 'BEN01').sessions.length, 0);
  assert.deepEqual(detectRecentPrs(undefined), []);
  assert.equal(recommendNextSet(undefined, 'BEN01').next_target, null);
  assert.deepEqual(detectStalls(undefined), []);
  assert.deepEqual(suggestDeloads(undefined), []);
  assert.equal(computeFatigueStatus(undefined, '2026-06-10').status, 'no_baseline');
  assert.equal(buildMuscleGroupReadiness(undefined, { today: '2026-06-10' }).length, 5);
  assert.equal(scoreIntents(undefined, undefined, { today: '2026-06-10' }).intents.length, 8);
  assert.equal(buildProgressSummary(undefined, { today: '2026-06-10' }).total_sessions, 0);
  assert.equal(buildWeeklyReport(undefined, { today: '2026-06-10' }).sessions_count, 0);
  assert.equal(recoveryFraction(undefined, 2), null);
  assert.equal(effortIntensityBySession(undefined).size, 0);
});

test('analytics guards invalid dates and non-finite math', () => {
  const malformedRows = [
    null,
    undefined,
    ['not-a-date', 'BAD', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', 'Infinity', '5', '2', ''],
    ['2026-06-10', 'NEG', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '-225', '5', '2', ''],
    ['2026-06-11', 'ZERO', 'Lat Pulldown', 'Lat Pulldown', 'Back', 'LPD01', '1', '160', '0', '2', '']
  ];

  assert.doesNotThrow(() => buildSessionSummary(malformedRows, [null], 'BAD'));
  assert.doesNotThrow(() => computeMuscleGroupVolume(malformedRows, 'not-a-number'));
  assert.doesNotThrow(() => computeExerciseProgress(malformedRows, 'BEN01'));
  assert.doesNotThrow(() => detectRecentPrs(malformedRows));
  assert.doesNotThrow(() => recommendNextSet(malformedRows, 'BEN01', { today: 'not-a-date' }));
  assert.doesNotThrow(() => detectStalls(malformedRows));
  assert.doesNotThrow(() => suggestDeloads(malformedRows));
  assert.doesNotThrow(() => computeFatigueStatus(malformedRows, 'not-a-date'));
  assert.doesNotThrow(() => buildMuscleGroupReadiness(malformedRows, { today: 'not-a-date', effortRows: [null] }));
  assert.doesNotThrow(() => scoreIntents(malformedRows, [null], { today: 'not-a-date' }));
  assert.doesNotThrow(() => buildProgressSummary(malformedRows, { today: 'not-a-date', weeks: 'bad' }));
  assert.doesNotThrow(() => buildWeeklyReport(malformedRows, { today: 'not-a-date', days: 'bad' }));

  assertNoNonFinite(buildProgressSummary(malformedRows, { today: 'not-a-date' }));
  assertNoNonFinite(buildWeeklyReport(malformedRows, { today: 'not-a-date' }));
  assert.equal(recoveryFraction(NaN, 2), null);
  assert.equal(recoveryFraction(-1, 2), null);
  assert.ok(Number.isFinite(recoveryFraction(2, 2, 0)));
  assert.ok(Number.isFinite(recoveryFraction(2, 2, Infinity)));

  const flatIntensity = effortIntensityBySession([
    ['2026-06-01', 'A', '30:00', '100', '150', '120', '150', '', ''],
    ['2026-06-02', 'B', '30:00', '100', '150', '120', '150', '', '']
  ]);
  assert.equal(flatIntensity.get('A'), 0.5);
  assert.equal(flatIntensity.get('B'), 0.5);
});
