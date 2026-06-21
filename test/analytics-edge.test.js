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

// Step 384: the deload-suggestions surface (suggestDeloads → /api/coaching/insights)
// must not flag a flat ACCESSORY whose primary muscle is already covered by other
// lifts — the live Shrugs / Dumbbell-Curl false-positive. The coverage-aware
// downgrade (annotateStallsForDeload), previously wired only into scoreIntents,
// now also gates this surface. A genuinely stalled MAIN compound still surfaces.
test('Step 384: suggestDeloads excludes a covered flat accessory but keeps a stalled compound', () => {
  const r = (date, session, name, muscle, code, weight, reps, set) =>
    [date, session, name, name, muscle, code, String(set), String(weight), String(reps), '2', ''];
  const setsFor = (date, session, name, muscle, code, weight, reps, count) =>
    Array.from({ length: count }, (_, i) => r(date, session, name, muscle, code, weight, reps, i + 1));

  const rows = [
    // Shrugs: flat across 4 sessions → a stall; primary muscle = traps.
    ...setsFor('2026-06-08', 'A1', 'Shrugs', 'Traps', 'SHR01', 135, 12, 3),
    ...setsFor('2026-06-10', 'A2', 'Shrugs', 'Traps', 'SHR01', 135, 12, 3),
    ...setsFor('2026-06-12', 'A3', 'Shrugs', 'Traps', 'SHR01', 135, 12, 3),
    ...setsFor('2026-06-14', 'A4', 'Shrugs', 'Traps', 'SHR01', 135, 12, 3),
    // Deadlift in the recent window covers traps (0.5/set × 6 sets = 3.0 eff ≥ 2).
    // Only 2 sessions, so Deadlift itself is never flagged as a stall.
    ...setsFor('2026-06-13', 'D1', 'Deadlift', 'Back', 'DL01', 405, 5, 3),
    ...setsFor('2026-06-14', 'D2', 'Deadlift', 'Back', 'DL01', 405, 5, 3),
    // Bench Press: flat across 4 sessions → a stall; a MAIN compound, never downgraded.
    ...setsFor('2026-06-08', 'B1', 'Bench Press', 'Chest', 'BEN01', 200, 5, 1),
    ...setsFor('2026-06-10', 'B2', 'Bench Press', 'Chest', 'BEN01', 200, 5, 1),
    ...setsFor('2026-06-12', 'B3', 'Bench Press', 'Chest', 'BEN01', 200, 5, 1),
    ...setsFor('2026-06-14', 'B4', 'Bench Press', 'Chest', 'BEN01', 200, 5, 1),
  ];

  const codes = suggestDeloads(rows, 4).map(d => d.liftCode);
  assert.ok(codes.includes('BEN01'), 'a stalled main compound must still surface a deload suggestion');
  assert.ok(!codes.includes('SHR01'),
    'a flat accessory whose muscle is covered by other lifts must NOT surface a deload suggestion');
  assert.ok(!codes.includes('DL01'), 'a lift with too few sessions is not a stall and must not appear');
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

// ── ME-7: stall detection counts reps via e1RM, not just top weight ───────────
// Expected verdicts are hand-reasoned from the rule, not generated by the code:
// a stall is "best e1RM over the window did not exceed the first session's best
// e1RM". e1RM = weight × (1 + reps/30).

test('stall detection: same weight with rising reps (205×5 → 205×6 → 205×7) is NOT a stall', () => {
  // e1RM rises 239.17 → 246.00 → 252.83 — real progress, even though the weight
  // never moved. The old top-weight rule wrongly flagged this as a stall.
  const rows = [
    ['2026-05-01', 'A', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '5', '2', ''],
    ['2026-05-08', 'B', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '6', '2', ''],
    ['2026-05-15', 'C', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '7', '2', '']
  ];
  assert.deepEqual(detectStalls(rows, 3), []);
});

test('stall detection: same weight with flat OR falling reps is still a stall', () => {
  // Flat: 205×5 ×3 → e1RM constant → stall.
  const flat = [
    ['2026-05-01', 'A', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '5', '2', ''],
    ['2026-05-08', 'B', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '5', '2', ''],
    ['2026-05-15', 'C', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '5', '2', '']
  ];
  const flatStalls = detectStalls(flat, 3);
  assert.equal(flatStalls.length, 1);
  assert.equal(flatStalls[0].liftCode, 'SQ01');
  assert.equal(flatStalls[0].last_best_weight, 205); // shape unchanged: real weight, not e1RM
  assert.equal(flatStalls[0].sessions_stalled, 3);

  // Falling: 205×7 → 205×6 → 205×5. The first session's e1RM (252.83) is the
  // window's peak, so nothing exceeds it → stall.
  const falling = [
    ['2026-05-01', 'A', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '7', '2', ''],
    ['2026-05-08', 'B', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '6', '2', ''],
    ['2026-05-15', 'C', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '205', '5', '2', '']
  ];
  const fallingStalls = detectStalls(falling, 3);
  assert.equal(fallingStalls.length, 1);
  assert.equal(fallingStalls[0].last_best_weight, 205);
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

// ── ME-8: buildWeeklyReport handles object-shaped rows ───────────────────────
test('buildWeeklyReport: object-shaped rows produce same totals as array-shaped rows', () => {
  const today = '2026-06-10';
  const arrayRows = [
    ['2026-06-09', 'S1', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '1', '225', '5', '2', '', ''],
    ['2026-06-09', 'S1', 'Back Squat', 'Back Squat', 'Quads', 'SQ01', '2', '225', '5', '2', '', ''],
    ['2026-06-10', 'S2', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '185', '8', '1', '', ''],
  ];
  const objectRows = [
    { date_clean: '2026-06-09', session_id: 'S1', exercise: 'Back Squat', canonical_exercise: 'Back Squat', muscle_group: 'Quads', lift_code: 'SQ01', set_number: '1', weight: '225', reps: '5', rir: '2', notes: '', volume_calc: '' },
    { date_clean: '2026-06-09', session_id: 'S1', exercise: 'Back Squat', canonical_exercise: 'Back Squat', muscle_group: 'Quads', lift_code: 'SQ01', set_number: '2', weight: '225', reps: '5', rir: '2', notes: '', volume_calc: '' },
    { date_clean: '2026-06-10', session_id: 'S2', exercise: 'Bench Press', canonical_exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BEN01', set_number: '1', weight: '185', reps: '8', rir: '1', notes: '', volume_calc: '' },
  ];

  const fromArray = buildWeeklyReport(arrayRows, { today, days: 7 });
  const fromObject = buildWeeklyReport(objectRows, { today, days: 7 });

  assert.equal(fromObject.sessions_count, 2, 'sessions_count from object rows');
  assert.equal(fromObject.total_sets, 3, 'total_sets from object rows');
  assert.equal(fromObject.total_volume, 225 * 5 * 2 + 185 * 8, 'total_volume from object rows');
  assert.ok(fromObject.top_exercises.length > 0, 'top_exercises populated from object rows');
  assert.ok(fromObject.top_exercises.some(e => e.exercise === 'Back Squat'), 'Back Squat in top exercises');
  assert.ok(Object.keys(fromObject.muscle_group_volume).includes('Quads'), 'Quads in muscle_group_volume');

  assert.equal(fromObject.sessions_count, fromArray.sessions_count, 'sessions_count matches array');
  assert.equal(fromObject.total_sets, fromArray.total_sets, 'total_sets matches array');
  assert.equal(fromObject.total_volume, fromArray.total_volume, 'total_volume matches array');
});

// ── PR 367: reason_codes — direct scoreIntents assertions ─────────────────────
// These tests verify reason_codes on specific intents regardless of which intent
// wins the scoring — avoids vacuous guards.

function makeRows(exercise, muscle, liftCode, weights, startDate = '2026-03-01') {
  return weights.map((w, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i * 7);
    return [d.toISOString().split('T')[0], `S${i + 1}`, exercise, exercise, muscle, liftCode, '1', String(w), '5', '2', '', ''];
  });
}

test('scoreIntents: fix_blind_spots reason_codes carry *_overdue codes for neglected patterns', () => {
  // Squat trained ~173 days before today, bench ~49 days before today.
  // All session dates are strictly before today='2026-04-19' so the readiness model
  // sees both patterns as overdue ("fresh") rather than recently trained.
  const rows = [
    ...makeRows('Squat',       'lower', 'SQT01', [225, 230, 235, 240, 245], '2025-10-01'),
    ...makeRows('Bench Press', 'chest', 'BPR01', [185, 190, 195, 200, 205], '2026-02-01'),
  ];
  const result = scoreIntents(rows, [], { today: '2026-04-19' });
  const fbs = result.intents.find(i => i.id === 'fix_blind_spots');
  assert.ok(fbs, 'fix_blind_spots intent must exist');
  assert.ok(Array.isArray(fbs.reason_codes), 'fix_blind_spots must have reason_codes array');
  const hasOverdue = fbs.reason_codes.some(c => c.endsWith('_overdue'));
  assert.ok(hasOverdue,
    `expected an *_overdue code in fix_blind_spots.reason_codes, got [${fbs.reason_codes.join(', ')}]`);
});

test('scoreIntents: recovery_pump reason_codes carry multiple_trending_down when 2+ lifts decline', () => {
  // Weights decreasing across sessions → e1rm_trend should be 'down' for both lifts.
  const rows = [
    ...makeRows('Bench Press',    'chest',     'BPR01', [200, 190, 180, 170, 160]),
    ...makeRows('Overhead Press', 'shoulders', 'OHP01', [120, 110, 100,  90,  80]),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-01' });
  const rp = result.intents.find(i => i.id === 'recovery_pump');
  assert.ok(rp, 'recovery_pump intent must exist');
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs, 'build_strength intent must exist');
  // The fixture has clearly declining weights — the engine must emit multiple_trending_down.
  assert.ok(bs.reason_codes.includes('multiple_trending_down'),
    `expected multiple_trending_down in build_strength, got [${bs.reason_codes.join(', ')}]`);
  assert.ok(rp.reason_codes.includes('multiple_trending_down'),
    `expected multiple_trending_down in recovery_pump when compounds decline, got [${rp.reason_codes.join(', ')}]`);
});

// ── PR 368: trend-aware scoring ───────────────────────────────────────────────

test('scoreIntents PR 368: build_strength score is lower when 2+ push/pull compounds trend down', () => {
  // Baseline: ascending bench + OHP → upward trend → build_strength scores high.
  const ascRows = [
    ...makeRows('Bench Press',    'chest',     'BPR01', [160, 170, 180, 190, 200]),
    ...makeRows('Overhead Press', 'shoulders', 'OHP01', [ 80,  90, 100, 110, 120]),
  ];
  // Declining: same lifts, weights falling → downward trend.
  const descRows = [
    ...makeRows('Bench Press',    'chest',     'BPR01', [200, 190, 180, 170, 160]),
    ...makeRows('Overhead Press', 'shoulders', 'OHP01', [120, 110, 100,  90,  80]),
  ];
  const ascResult  = scoreIntents(ascRows,  [], { today: '2026-05-01' });
  const descResult = scoreIntents(descRows, [], { today: '2026-05-01' });

  const ascBS  = ascResult.intents.find(i  => i.id === 'build_strength');
  const descBS = descResult.intents.find(i => i.id === 'build_strength');

  assert.ok(ascBS  && descBS, 'build_strength must exist in both results');

  // Declining fixture must produce the multiple_trending_down code — assert unconditionally
  // so any regression that stops emitting the code fails loudly.
  assert.ok(descBS.reason_codes.includes('multiple_trending_down'),
    `expected multiple_trending_down in declining build_strength, got [${descBS.reason_codes.join(', ')}]`);
  assert.ok(descBS.score < ascBS.score,
    `expected lower build_strength score on declining data (${descBS.score}) vs ascending (${ascBS.score})`);
});

test('scoreIntents PR 368: recovery_pump score is boosted when multiple compounds decline', () => {
  // Flat baseline: constant weights → no trend adjustment.
  const flatRows = [
    ...makeRows('Bench Press',    'chest',     'BPR01', [185, 185, 185, 185, 185]),
    ...makeRows('Overhead Press', 'shoulders', 'OHP01', [110, 110, 110, 110, 110]),
  ];
  // Declining: same lifts, weights falling → downward trend.
  const descRows = [
    ...makeRows('Bench Press',    'chest',     'BPR01', [200, 190, 180, 170, 160]),
    ...makeRows('Overhead Press', 'shoulders', 'OHP01', [120, 110, 100,  90,  80]),
  ];
  const flatResult = scoreIntents(flatRows, [], { today: '2026-05-01' });
  const descResult = scoreIntents(descRows, [], { today: '2026-05-01' });

  const flatRP = flatResult.intents.find(i => i.id === 'recovery_pump');
  const descRP = descResult.intents.find(i => i.id === 'recovery_pump');
  assert.ok(flatRP && descRP, 'recovery_pump must exist in both results');

  // Declining fixture must produce multiple_trending_down — assert unconditionally.
  assert.ok(descRP.reason_codes.includes('multiple_trending_down'),
    `expected multiple_trending_down in declining recovery_pump, got [${descRP.reason_codes.join(', ')}]`);
  assert.ok(descRP.score > flatRP.score,
    `expected higher recovery_pump score on declining data (${descRP.score}) vs flat (${flatRP.score})`);
});

// ── PR 369: readiness-aware dose ──────────────────────────────────────────────

test('scoreIntents PR 369: build_strength exercises for a fatigued pattern have target_sets reduced', () => {
  // Bench press trained TODAY (daysSince=0 → recovery=0 → fatigued push).
  // Squat trained 10 days ago (daysSince=10 → recovery ≈ 0.99 → fresh lower).
  // today is '2026-05-01'; bench session must be on the same date.
  const benchToday = [
    ['2026-05-01', 'ST1', 'Bench Press', 'Bench Press', 'chest', 'BPR01', '1', '185', '5', '2', '', ''],
    ['2026-05-01', 'ST1', 'Bench Press', 'Bench Press', 'chest', 'BPR01', '2', '185', '5', '3', '', ''],
    ['2026-05-01', 'ST1', 'Bench Press', 'Bench Press', 'chest', 'BPR01', '3', '185', '4', '3', '', ''],
  ];
  const rows = [
    ...makeRows('Bench Press', 'chest', 'BPR01', [165, 170, 175, 180, 185], '2026-03-15'),
    ...makeRows('Squat',       'lower', 'SQT01', [225, 230, 235, 240, 245], '2026-03-15'),
    ...benchToday,
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-01' });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs, 'build_strength must exist');

  // Any push exercise in build_strength must have a reduced dose.
  const pushExercises = bs.exercises.filter(ex => ex.lift_code === 'BPR01');
  assert.ok(pushExercises.length > 0, 'build_strength must include a push exercise for this fixture');
  for (const ex of pushExercises) {
    assert.equal(ex.readiness_note, 'volume_reduced_fatigued',
      `expected readiness_note 'volume_reduced_fatigued' on fatigued push exercise, got '${ex.readiness_note}'`);
    assert.ok(ex.target_sets <= 2,
      `expected target_sets ≤ 2 for fatigued push, got ${ex.target_sets}`);
  }
});

test('scoreIntents PR 369: non-fatigued exercises carry no readiness_note', () => {
  // Squat trained 10 days ago → fresh lower (no dose reduction needed).
  const rows = [
    ...makeRows('Squat', 'lower', 'SQT01', [225, 230, 235, 240, 245], '2026-03-15'),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-01' });
  const balanced = result.intents.find(i => i.id === 'balanced');
  assert.ok(balanced, 'balanced intent must exist');

  for (const ex of balanced.exercises) {
    assert.ok(ex.readiness_note == null || ex.readiness_note !== 'volume_reduced_fatigued',
      `non-fatigued exercise '${ex.exercise}' must not carry volume_reduced_fatigued note`);
  }
});

// ── Return-after-layoff make-up-volume cap ────────────────────────────────────

test('scoreIntents layoff: training intents cap make-up volume + flag after a layoff', () => {
  // Last session 2026-04-12 (makeRows start + 4×7d); today 2026-05-03 → 21-day
  // gap → 'significant' layoff (volume_factor 0.66). All sessions are well before
  // today so patterns read as rested (not fatigued — the layoff cap, not the
  // fatigue dose, is what fires).
  const rows = [
    ...makeRows('Bench Press', 'chest', 'BPR01', [165, 170, 175, 180, 185], '2026-03-15'),
    ...makeRows('Squat',       'lower', 'SQT01', [225, 230, 235, 240, 245], '2026-03-15'),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-03' });

  const training = result.intents.filter(i =>
    ['build_strength', 'build_muscle', 'fix_blind_spots', 'balanced'].includes(i.id) &&
    Array.isArray(i.exercises) && i.exercises.length > 0);
  assert.ok(training.length > 0, 'expected at least one training intent with exercises');

  for (const intent of training) {
    assert.ok(intent.reason_codes.includes('returning_from_layoff'),
      `${intent.id} must carry the returning_from_layoff reason_code`);
    for (const ex of intent.exercises) {
      assert.equal(ex.readiness_note, 'returning_from_layoff',
        `${intent.id}/${ex.exercise} must be flagged returning_from_layoff`);
      assert.ok(ex.target_sets <= 3, `make-up volume should be capped, got ${ex.target_sets}`);
      assert.ok(ex.target_sets >= 2, 'never below the floor of 2');
    }
    assert.ok(intent.watch_for.some(w => /returning after/i.test(w)),
      `${intent.id} watch_for must mention the layoff`);
  }
});

test('scoreIntents layoff: non-training intents do NOT carry the layoff cut (gates coach volume_reduced)', () => {
  // Same 21-day-layoff fixture. The coach plan route derives volume_reduced from
  // whether the RECOMMENDED intent's reason_codes include returning_from_layoff —
  // so the cut must be present ONLY on the four training intents, never on
  // recovery_pump / short_session / test_progress / deload_reset (which the engine
  // intentionally skips). This is what stops the coach over-claiming "I pulled
  // volume back" on a recovery plan.
  const rows = [
    ...makeRows('Bench Press', 'chest', 'BPR01', [165, 170, 175, 180, 185], '2026-03-15'),
    ...makeRows('Squat',       'lower', 'SQT01', [225, 230, 235, 240, 245], '2026-03-15'),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-03' });
  for (const id of ['recovery_pump', 'short_session', 'test_progress', 'deload_reset']) {
    const intent = result.intents.find(i => i.id === id);
    if (!intent) continue; // not all intents are always present
    assert.ok(!(intent.reason_codes || []).includes('returning_from_layoff'),
      `${id} must NOT carry returning_from_layoff (engine does not cut its volume)`);
  }
});

test('scoreIntents layoff: normal cadence does NOT trigger the layoff cap', () => {
  // Last session 2026-04-12; today 2026-04-15 → 3-day gap → no layoff.
  const rows = [
    ...makeRows('Bench Press', 'chest', 'BPR01', [165, 170, 175, 180, 185], '2026-03-15'),
    ...makeRows('Squat',       'lower', 'SQT01', [225, 230, 235, 240, 245], '2026-03-15'),
  ];
  const result = scoreIntents(rows, [], { today: '2026-04-15' });
  for (const intent of result.intents) {
    assert.ok(!(intent.reason_codes || []).includes('returning_from_layoff'),
      `${intent.id} must not carry returning_from_layoff at normal cadence`);
    for (const ex of (intent.exercises || [])) {
      assert.notEqual(ex.readiness_note, 'returning_from_layoff',
        `${intent.id}/${ex.exercise} must not be layoff-flagged at normal cadence`);
    }
  }
});

// ── PR 370: confidence_factors ────────────────────────────────────────────────

test('scoreIntents PR 370: each exercise carries a confidence_factors object with required fields', () => {
  // Include a stall fixture so deload_reset fires and its exercises are also inspected.
  // Bench + OHP stalled at the same weight for 4 sessions, far in the past → fully rested.
  const stallBench = Array.from({ length: 4 }, (_, i) => {
    const d = new Date('2026-01-07'); d.setDate(d.getDate() + i * 7);
    return [d.toISOString().split('T')[0], `SB${i+1}`, 'Bench Press', 'Bench Press', 'chest', 'BPR01', '1', '185', '5', '2', '', ''];
  });
  const stallOhp = Array.from({ length: 4 }, (_, i) => {
    const d = new Date('2026-01-07'); d.setDate(d.getDate() + i * 7);
    return [d.toISOString().split('T')[0], `SO${i+1}`, 'Overhead Press', 'Overhead Press', 'shoulders', 'OHP01', '1', '135', '5', '2', '', ''];
  });
  const rows = [
    ...makeRows('Bench Press', 'chest', 'BPR01', [165, 170, 175, 180, 185], '2026-03-01'),
    ...makeRows('Squat',       'lower', 'SQT01', [225, 230, 235, 240, 245], '2026-03-01'),
    ...stallBench,
    ...stallOhp,
  ];
  const result = scoreIntents(rows, [], { today: '2026-04-19' });

  for (const intent of result.intents) {
    for (const ex of intent.exercises) {
      const cf = ex.confidence_factors;
      assert.ok(cf && typeof cf === 'object',
        `intent '${intent.id}' exercise '${ex.exercise}' must have confidence_factors object`);
      // sessions and data_age_days may be null for stall-sourced entries with no matching rec.
      assert.ok(cf.sessions === null || (Number.isFinite(cf.sessions) && cf.sessions >= 0),
        `confidence_factors.sessions must be non-negative or null, got ${cf.sessions}`);
      assert.ok(cf.data_age_days === null || Number.isFinite(cf.data_age_days),
        `confidence_factors.data_age_days must be numeric or null, got ${cf.data_age_days}`);
      assert.ok(cf.trend === null || typeof cf.trend === 'string',
        `confidence_factors.trend must be a string or null, got ${cf.trend}`);
      assert.ok(cf.lift_confidence === null || typeof cf.lift_confidence === 'string',
        `confidence_factors.lift_confidence must be a string or null, got ${cf.lift_confidence}`);
    }
  }
});

test('scoreIntents PR 370: confidence_factors reflect data quality — sessions count and trend populated', () => {
  // 6 sessions of bench with a steadily increasing weight → rising e1RM trend.
  // Asserts that confidence_factors expose the actual engine values without
  // locking in specific confidence ratings (those depend on recency vs. real clock).
  const rows = makeRows('Bench Press', 'chest', 'BPR01', [155, 160, 165, 170, 175, 180], '2026-03-05');
  const result = scoreIntents(rows, [], { today: '2026-04-19' });

  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs, 'build_strength must exist');

  const benchEx = bs.exercises.find(ex => ex.lift_code === 'BPR01');
  assert.ok(benchEx, 'Bench Press must be in build_strength exercises');

  const cf = benchEx.confidence_factors;
  // sessions must reflect the full 6-session history.
  assert.equal(cf.sessions, 6,
    `expected sessions=6 for this fixture, got ${cf.sessions}`);
  // trend must be 'up' — weights increased every session so e1RM trend is up.
  assert.equal(cf.trend, 'up',
    `expected trend='up' for steadily increasing weights, got '${cf.trend}'`);
  // lift_confidence must be one of the four valid engine values.
  assert.ok(['high', 'medium', 'low', 'none'].includes(cf.lift_confidence),
    `lift_confidence '${cf.lift_confidence}' must be a valid confidence value`);
  // data_age_days must be a non-negative number (computed vs. real clock, so just shape-check).
  assert.ok(Number.isFinite(cf.data_age_days) && cf.data_age_days >= 0,
    `data_age_days must be a non-negative number, got ${cf.data_age_days}`);
});

// ─── Issue #402: same-day / yesterday exclusion + lift-code dedup ─────────────
// Uses makeRows() defined above. startDate '2026-05-21' + 4 weekly steps = '2026-06-18'
// (yesterday for today='2026-06-19').

test('#402: exercise trained yesterday is excluded from recommendations', () => {
  const rows = [
    // Seated Row (ROW01): 5 weekly sessions; last one lands on 2026-06-18 (yesterday)
    ...makeRows('Seated Row', 'Back', 'ROW01', [185, 187, 188, 189, 190], '2026-05-21'),
    // Bench Press: older history so push pattern is available for intents to fire
    ...makeRows('Bench Press', 'Chest', 'BEN01', [185, 190, 195, 200, 205], '2026-04-01'),
  ];

  const result = scoreIntents(rows, [], { today: '2026-06-19' });
  assert.ok(Array.isArray(result.intents) && result.intents.length > 0,
    'scoreIntents must return at least one intent');

  for (const intent of result.intents) {
    const exercises = intent.exercises || [];
    const hasSeatedRow = exercises.some(ex =>
      (ex.exercise || '').toLowerCase().includes('seated row') || ex.lift_code === 'ROW01'
    );
    assert.ok(!hasSeatedRow,
      `Intent "${intent.id}" must not recommend Seated Row (trained yesterday); got: [${exercises.map(e => e.exercise).join(', ')}]`
    );
  }
});

test('#402: same exercise under multiple lift codes appears at most once per intent', () => {
  const rows = [
    // ROW01 sessions — older (2026-04-10 to 2026-04-24)
    ...makeRows('Seated Row', 'Back', 'ROW01', [185, 187, 188], '2026-04-10'),
    // SR01 sessions — same exercise name, more recent but still well outside recency window
    ...makeRows('Seated Row', 'Back', 'SR01', [190, 192, 193], '2026-05-15'),
    // Bench Press to give intents variety
    ...makeRows('Bench Press', 'Chest', 'BEN01', [185, 190, 195, 200, 205], '2026-04-01'),
  ];

  const result = scoreIntents(rows, [], { today: '2026-06-19' });
  assert.ok(Array.isArray(result.intents) && result.intents.length > 0,
    'scoreIntents must return at least one intent');

  for (const intent of result.intents) {
    const exercises = intent.exercises || [];
    const seatedRowCount = exercises.filter(ex =>
      (ex.exercise || '').toLowerCase() === 'seated row'
    ).length;
    assert.ok(seatedRowCount <= 1,
      `Intent "${intent.id}" must include Seated Row at most once; found ${seatedRowCount} entries`
    );
  }
});

// ── Major-lift ramp coverage + role ordering on the live build_strength path ──
// The build_strength intent builds via exForPatterns (recency order, no ramp).
// orderByRole + attachMainCompoundWarmups now (a) put main compounds before
// accessories and (b) ramp EVERY main compound per movement pattern — so a second
// main of a different pattern (Back Squat after Deadlift) also ramps, not just the
// lead (the live "Back Squat buried + flat after leg extension" bug).
test('scoreIntents: build_strength ramps every main compound per pattern and orders mains before accessories', () => {
  // strength goal + rested legs → strengthPatterns includes lower/hinge/push/pull.
  // Accessories logged most recently so recency order would interleave them.
  const rows = [
    ...makeRows('Deadlift',      'Posterior Chain', 'DL01',  [275, 285, 295, 305, 315], '2026-03-01'),
    ...makeRows('Back Squat',    'Quads',           'SQT01', [225, 230, 235, 240, 245], '2026-03-01'),
    ...makeRows('Leg Extension', 'Quads',           'LE01',  [50, 55, 55, 60, 60],      '2026-03-08'),
    ...makeRows('Lateral Raise', 'Shoulders',       'LR01',  [15, 15, 20, 20, 20],      '2026-03-08'),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-03', goal: 'strength' });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs && Array.isArray(bs.exercises) && bs.exercises.length, 'build_strength must have exercises');

  const byName = n => bs.exercises.find(ex => (ex.exercise || '').toLowerCase().includes(n));
  const dl = byName('deadlift');
  const sq = byName('squat');
  assert.ok(dl && sq, 'both Deadlift and Back Squat must be present');

  // Both main compounds carry an ascending ramp (different patterns: hinge vs squat).
  for (const main of [dl, sq]) {
    assert.ok(Array.isArray(main.warmup_sets) && main.warmup_sets.length === 3,
      `${main.exercise} must carry a 3-step ramp`);
    const w = main.warmup_sets.map(s => s.weight);
    assert.ok(w[0] < w[1] && w[1] < w[2] && w[2] < main.target_weight,
      `${main.exercise} ramp must ascend into the working weight; got ${w} → ${main.target_weight}`);
    main.warmup_sets.forEach(s => assert.equal(s.priming, true));
    assert.ok(main.target_sets >= 1 && main.target_weight > 0, 'working sets preserved');
  }

  // Accessories stay flat and never sit before a main compound.
  const names = bs.exercises.map(e => (e.exercise || '').toLowerCase());
  const lastMainIdx = Math.max(names.findIndex(n => n.includes('deadlift')), names.findIndex(n => n.includes('squat')));
  const accessoryIdx = names.findIndex(n => n.includes('leg extension') || n.includes('lateral raise'));
  if (accessoryIdx !== -1) {
    assert.ok(accessoryIdx > lastMainIdx, 'no accessory may sit before a main compound');
    assert.ok(!bs.exercises[accessoryIdx].warmup_sets, 'accessories stay flat');
  }
});

// ── Lower-body volume budget on the live build_strength path ───────────────────
// The reported overload: Deadlift + Back Squat + leg press + leg ext + leg curl
// all stacked in one strength session. With 2+ main lower-body compounds, the
// lower-body accessories must be capped so the day isn't a silent high-volume leg
// session.
test('scoreIntents: build_strength caps lower-body accessories when 2+ main lower compounds are present', () => {
  const rows = [
    ...makeRows('Deadlift',                    'Posterior Chain', 'DL01',  [230, 235, 240, 245, 245], '2026-03-01'),
    ...makeRows('Back Squat',                  'Quads',           'SQT01', [225, 230, 235, 240, 240], '2026-03-01'),
    ...makeRows('Single-Leg Seated Leg Press', 'Glutes',          'LP01',  [60, 65, 70, 70, 70],      '2026-03-15'),
    ...makeRows('Leg Extension',               'Quads',           'LE01',  [50, 55, 55, 60, 60],      '2026-03-15'),
    ...makeRows('Single-Leg Leg Curl',         'Hamstrings',      'LC01',  [55, 60, 60, 60, 60],      '2026-03-15'),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-03', goal: 'strength' });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs && Array.isArray(bs.exercises), 'build_strength must exist');
  const names = bs.exercises.map(e => (e.exercise || '').toLowerCase());

  // Both heavy compounds survive; the leg-isolation pile-up is reduced to ≤1.
  assert.ok(names.some(n => n.includes('deadlift')) && names.some(n => n.includes('squat')),
    'both main compounds kept');
  const legIsolations = names.filter(n => n.includes('leg extension') || n.includes('leg curl'));
  assert.ok(legIsolations.length <= 1, `lower-body accessories capped to ≤1; got ${legIsolations.length}`);
  // The full 5-lower-lift overload must not survive intact.
  const lowerLifts = names.filter(n => /deadlift|squat|leg press|leg extension|leg curl/.test(n));
  assert.ok(lowerLifts.length < 5, `double-heavy-leg overload trimmed; got ${lowerLifts.length} lower lifts`);
});
