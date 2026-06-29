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

// ── build_strength is FULL-PROFILE by default; upper-only only on explicit intent ──
// Owner contract (2026-06-25): build_strength generates a whole-body strength
// session by default (lower + hinge + push + pull). Upper-only must NEVER be the
// silent default — it is reachable only when an explicit upper-only intent/flag is
// passed (options.upperOnly), so a user (or the coach) has to ask for it. This
// changes which movements populate the session, not how loads/progression/RIR are
// computed. All four patterns are logged and well-rested so nothing is recovery-trimmed.
function fullProfileStrengthRows() {
  return [
    ...makeRows('Bench Press', 'chest',           'BPR01', [185, 188, 190, 193, 195], '2026-03-01'),
    ...makeRows('Barbell Row', 'back',            'ROW01', [155, 158, 160, 163, 165], '2026-03-01'),
    ...makeRows('Back Squat',  'Quads',           'SQT01', [225, 230, 235, 240, 245], '2026-03-01'),
    ...makeRows('Deadlift',    'Posterior Chain', 'DL01',  [275, 285, 295, 305, 315], '2026-03-01'),
  ];
}

test('scoreIntents: build_strength is FULL-PROFILE by default (lower + hinge present, not just upper)', () => {
  const result = scoreIntents(fullProfileStrengthRows(), [], { today: '2026-05-03' });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs && Array.isArray(bs.exercises) && bs.exercises.length, 'build_strength must have exercises');
  const names = bs.exercises.map(e => (e.exercise || '').toLowerCase());
  // Whole body: lower-body compound (squat = lower) + hinge (deadlift) + push (bench) + pull (row).
  assert.ok(names.some(n => n.includes('squat')),    `default session must include lower-body work; got [${names.join(', ')}]`);
  assert.ok(names.some(n => n.includes('deadlift')), `default session must include hinge work; got [${names.join(', ')}]`);
  assert.ok(names.some(n => n.includes('bench')),    `default session must include pressing; got [${names.join(', ')}]`);
  assert.ok(names.some(n => n.includes('row')),      `default session must include pulling; got [${names.join(', ')}]`);
  // It is NOT the silent upper-only session.
  assert.notEqual(bs.focus, 'Upper body — press + pull', 'default must not carry the upper-only focus');
});

test('scoreIntents: build_strength yields an UPPER-ONLY session only on the explicit upperOnly intent', () => {
  const result = scoreIntents(fullProfileStrengthRows(), [], { today: '2026-05-03', upperOnly: true });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs && Array.isArray(bs.exercises) && bs.exercises.length, 'build_strength must have exercises');
  const names = bs.exercises.map(e => (e.exercise || '').toLowerCase());
  // Upper work present…
  assert.ok(names.some(n => n.includes('bench')), `upper-only must include pressing; got [${names.join(', ')}]`);
  assert.ok(names.some(n => n.includes('row')),   `upper-only must include pulling; got [${names.join(', ')}]`);
  // …and explicitly NO lower-body / hinge work.
  assert.ok(!names.some(n => n.includes('squat')),    `upper-only must exclude lower-body; got [${names.join(', ')}]`);
  assert.ok(!names.some(n => n.includes('deadlift')), `upper-only must exclude hinge; got [${names.join(', ')}]`);
  assert.equal(bs.focus, 'Upper body — press + pull', 'explicit upper-only carries the upper focus');
});

test('scoreIntents: full-profile default preserves progression targets (loads/sets unchanged)', () => {
  // The change is which movements populate the session, not how loads/progression
  // are computed — every emitted exercise keeps a positive working weight and ≥1 set.
  const result = scoreIntents(fullProfileStrengthRows(), [], { today: '2026-05-03' });
  const bs = result.intents.find(i => i.id === 'build_strength');
  for (const ex of bs.exercises) {
    assert.ok(ex.target_weight > 0, `${ex.exercise} keeps a working weight`);
    assert.ok(ex.target_sets >= 1, `${ex.exercise} keeps working sets`);
  }
});

// ── The buildIntentSession intents are structured too (build_muscle / fix_blind_spots / balanced) ──
// The live "Back Squat flat + buried + 5-lift overload" was a buildIntentSession
// intent (shown when the goal isn't strength). structureSession now applies the
// same role ordering / per-pattern main ramps / lower-body cap to those intents.
// hypertrophy → build_muscle (a buildIntentSession intent), proving structureSession
// reaches those intents. (The general goal's recommendation now depends on the
// consistent-training gate below, so it's exercised by the blind-spot tests instead.)
for (const goal of ['hypertrophy']) {
  test(`scoreIntents: the recommended ${goal} session ramps both main compounds, orders mains first, and caps the leg pile-up`, () => {
    const rows = [
      ...makeRows('Deadlift',                    'Posterior Chain', 'DL01',  [230, 235, 240, 245, 245], '2026-03-20'),
      ...makeRows('Back Squat',                  'Quads',           'SQT01', [225, 230, 235, 240, 240], '2026-03-18'),
      ...makeRows('Leg Extension',               'Quads',           'LE01',  [50, 55, 55, 60, 60],      '2026-03-15'),
      ...makeRows('Single-Leg Leg Curl',         'Hamstrings',      'LC01',  [55, 60, 60, 60, 60],      '2026-03-15'),
      ...makeRows('Single-Leg Seated Leg Press', 'Glutes',          'LP01',  [60, 65, 70, 70, 70],      '2026-03-15'),
    ];
    const result = scoreIntents(rows, [], { today: '2026-05-03', goal });
    const recId = (result.todays_read && result.todays_read.recommended_intent_id)
      || (result.intents.find(i => i.recommended) || {}).id;
    // structureSession applies to every training intent, so whichever one is
    // recommended must be role-structured (the buildIntentSession intents are
    // covered specifically by the hypertrophy → build_muscle case).
    const intent = result.intents.find(i => i.id === recId);
    assert.ok(intent && Array.isArray(intent.exercises) && intent.exercises.length, 'recommended intent has exercises');
    const names = intent.exercises.map(e => (e.exercise || '').toLowerCase());

    // Both main compounds ramp (different patterns: hinge + squat).
    const dl = intent.exercises.find(e => /deadlift/i.test(e.exercise));
    const sq = intent.exercises.find(e => /squat/i.test(e.exercise));
    assert.ok(dl && Array.isArray(dl.warmup_sets) && dl.warmup_sets.length === 3, 'Deadlift ramps');
    assert.ok(sq && Array.isArray(sq.warmup_sets) && sq.warmup_sets.length === 3, 'Back Squat ramps (was flat before)');

    // Mains before accessories; secondary leg press never ramps.
    const lastMainIdx = Math.max(names.findIndex(n => n.includes('deadlift')), names.findIndex(n => n.includes('squat')));
    const accIdx = names.findIndex(n => n.includes('leg extension') || n.includes('leg curl'));
    if (accIdx !== -1) assert.ok(accIdx > lastMainIdx, 'no accessory before a main compound');
    const legPress = intent.exercises.find(e => /leg press/i.test(e.exercise));
    if (legPress) assert.ok(!legPress.warmup_sets, 'secondary leg press stays flat');

    // Lower-body accessory pile-up capped; the 5-lift overload is gone.
    const legIsolations = names.filter(n => n.includes('leg extension') || n.includes('leg curl'));
    assert.ok(legIsolations.length <= 1, `leg isolations capped to ≤1; got ${legIsolations.length}`);
  });
}

// ── Full session by default (owner directive 2026-06-25) ──────────────────────
// The non-abbreviated intents must produce a COMPLETE, multi-pattern session for a
// lifter with a rich training history — blind spots / hypertrophy / balance days
// are full workouts, not 2-3 exercise gap days. The explicitly-abbreviated intents
// (recovery_pump / short_session / test_progress) stay small by design.
test('scoreIntents: non-abbreviated intents build a full multi-pattern session for a rich history', () => {
  const mk = (ex, mg, code, ws, start, step) => ws.map((w, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i * step);
    return [d.toISOString().split('T')[0], `S-${ex}-${i}`, ex, ex, mg, code, '1', String(w), '8', '2', '', ''];
  });
  // ~6 weeks, weekly cadence, ~5 lifts/session spanning push/pull/lower/hinge/core.
  const rows = [
    ...mk('Bench Press', 'Chest', 'BEN01', [185, 188, 190, 192, 195, 198], '2026-04-01', 7),
    ...mk('Overhead Press', 'Shoulders', 'OHP01', [95, 98, 100, 102, 105, 108], '2026-04-01', 7),
    ...mk('Barbell Row', 'Back', 'BOR01', [155, 158, 160, 162, 165, 168], '2026-04-03', 7),
    ...mk('Lat Pulldown', 'Back', 'LPD01', [120, 122, 125, 128, 130, 132], '2026-04-03', 7),
    ...mk('Back Squat', 'Quads', 'SQT01', [225, 230, 235, 240, 245, 250], '2026-04-05', 7),
    ...mk('Romanian Deadlift', 'Hamstrings', 'RDL01', [185, 190, 195, 200, 205, 210], '2026-04-05', 7),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-13' });
  const byId = id => result.intents.find(i => i.id === id);

  // The buildIntentSession intents (hypertrophy / balance / blind-spots) are full,
  // multi-pattern sessions — not a narrow gap-only day.
  for (const id of ['build_muscle', 'balanced', 'fix_blind_spots']) {
    const intent = byId(id);
    assert.ok(intent && Array.isArray(intent.exercises), `${id} exists with exercises`);
    assert.ok(intent.exercises.length >= 4, `${id} is a full session (≥4 exercises), got ${intent.exercises.length}`);
    const muscles = new Set(intent.exercises.map(e => e.muscle_group).filter(Boolean));
    assert.ok(muscles.size >= 3, `${id} spans ≥3 muscle groups, got [${[...muscles].join(', ')}]`);
  }

  // The explicitly-abbreviated intents stay small by design (focused modes).
  assert.ok((byId('recovery_pump').exercises || []).length <= 4, 'recovery_pump stays ≤4');
  assert.ok((byId('short_session').exercises || []).length <= 3, 'short_session stays ≤3');
  assert.ok((byId('test_progress').exercises || []).length <= 3, 'test_progress stays ≤3');
});

// ── fix_blind_spots is gated on a consistent-training baseline ─────────────────
// Owner insight (2026-06-21): missing the gym for a week makes EVERY pattern read
// "overdue", which used to make fix_blind_spots win (+20 per fresh pattern). A
// layoff / all-green-fatigue slow week is not a blind-spot day.
function intentScore(result, id) {
  const i = result.intents.find(x => x.id === id);
  return i ? i.score : null;
}

test('scoreIntents: a layoff does NOT recommend fix_blind_spots (everything overdue ≠ blind spot)', () => {
  const mk = (ex, mg, code, ws, start, step) => ws.map((w, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i * step);
    return [d.toISOString().split('T')[0], `${ex}-${i}`, ex, ex, mg, code, '1', String(w), '8', '2', '', ''];
  });
  // Trained consistently through April, then ~18 days off.
  const rows = [
    ...mk('Bench Press', 'Chest', 'BEN01', [185, 190, 195, 200], '2026-04-01', 4),
    ...mk('Back Squat', 'Quads', 'SQT01', [225, 230, 235, 240], '2026-04-02', 4),
    ...mk('Barbell Row', 'Back', 'BOR01', [155, 160, 165, 170], '2026-04-03', 4),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-05' });
  const recId = result.todays_read && result.todays_read.recommended_intent_id;
  assert.notEqual(recId, 'fix_blind_spots', 'a layoff must not be framed as a blind-spot day');
  // The overdue bonus is withheld — score stays at the base, not 40 + 20×patterns.
  assert.ok(intentScore(result, 'fix_blind_spots') <= 60,
    `fix_blind_spots must not be boosted by a uniform layoff; got ${intentScore(result, 'fix_blind_spots')}`);
});

test('scoreIntents: consistent training with genuinely neglected LOADED patterns still credits fix_blind_spots', () => {
  const mk = (ex, mg, code, ws, start, step) => ws.map((w, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i * step);
    return [d.toISOString().split('T')[0], `${ex}-${i}`, ex, ex, mg, code, '1', String(w), '8', '2', '', ''];
  });
  // Contrast: pressing + pulling trained hard every 2 days right up to today
  // (recently trained → recovering/ready). The genuine blind spots are LOADED
  // compounds neglected for ~3.5 weeks: Back Squat (lower) + RDL (hinge) → fresh.
  const rows = [
    ...mk('Bench Press', 'Chest', 'BEN01', [185, 188, 190, 192, 195, 198, 200, 202], '2026-04-20', 2),
    ...mk('Barbell Row', 'Back', 'BOR01', [155, 158, 160, 162, 165, 168, 170, 172], '2026-04-21', 2),
    ...mk('Back Squat', 'Quads', 'SQT01', [225, 230, 235], '2026-04-01', 5),
    ...mk('Romanian Deadlift', 'Hamstrings', 'RDL01', [185, 190, 195], '2026-04-02', 5),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-06' });
  const fbs = result.intents.find(i => i.id === 'fix_blind_spots');
  // The gate must NOT zero out a real blind spot when training is consistent — the
  // overdue bonus applies (two fresh loaded patterns → base + 20×2), so it clears 60.
  assert.ok(fbs.score > 60, `consistent training must still credit overdue patterns; got ${fbs.score}`);
  // …and the credited patterns are the actually-neglected loaded ones (lower / hinge),
  // not an artifact of unrelated patterns reading fresh.
  const why = (fbs.why_today || []).join(' ');
  assert.ok(/Lower body|Hinge/.test(why), `the neglected loaded pattern must be the one surfaced; got "${why}"`);
});

// ── fix_blind_spots brief ↔ exercise consistency (coverage from the FINAL list) ──
// The brief must only name patterns that survive structureSession (role-order +
// density cap + lower-body cap + dose). Coverage is recomputed from the final
// exercise list, not buildIntentSession's pre-structure coveredPatterns, so a
// capped/dropped accessory can never leave a coarse pattern in the brief with no
// matching exercise.
test('scoreIntents: every pattern named in the fix_blind_spots brief has a matching exercise in the final session', () => {
  const mk = (ex, mg, code, ws, start, step) => ws.map((w, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i * step);
    return [d.toISOString().split('T')[0], `${ex}-${i}`, ex, ex, mg, code, '1', String(w), '8', '2', '', ''];
  });
  // Same consistent-training contrast as the credit test: pressing + pulling trained
  // right up to today; Back Squat (lower) + RDL (hinge) neglected → fresh blind spots.
  const rows = [
    ...mk('Bench Press', 'Chest', 'BEN01', [185, 188, 190, 192, 195, 198, 200, 202], '2026-04-20', 2),
    ...mk('Barbell Row', 'Back', 'BOR01', [155, 158, 160, 162, 165, 168, 170, 172], '2026-04-21', 2),
    ...mk('Back Squat', 'Quads', 'SQT01', [225, 230, 235], '2026-04-01', 5),
    ...mk('Romanian Deadlift', 'Hamstrings', 'RDL01', [185, 190, 195], '2026-04-02', 5),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-06' });
  const fbs = result.intents.find(i => i.id === 'fix_blind_spots');
  assert.ok(fbs, 'fix_blind_spots intent must exist');

  // Coarse patterns present in the FINAL prescribed exercises.
  const PLABEL = { lower: 'Lower body', push: 'Pressing', pull: 'Pulling', hinge: 'Hinge', core: 'Core' };
  const labelToPattern = Object.fromEntries(Object.entries(PLABEL).map(([k, v]) => [v, k]));

  // Every pattern the brief surfaces (data_points / focus) must be schedulable: it
  // had at least one exercise that made it into the final session. We check via the
  // reason_codes (pattern_overdue) ↔ a prescribed exercise of that coarse pattern.
  const overduePatterns = (fbs.reason_codes || [])
    .filter(c => /_overdue$/.test(c))
    .map(c => c.replace(/_overdue$/, ''));
  // A non-empty brief is required for this fixture to be meaningful.
  assert.ok(overduePatterns.length > 0, `fixture must surface overdue patterns; got [${fbs.reason_codes.join(', ')}]`);

  // For each surfaced pattern, the final session must actually contain an exercise of
  // that pattern (the lower/hinge mains for this fixture). We assert by code identity.
  const codeToPattern = { SQT01: 'lower', RDL01: 'hinge', BEN01: 'push', BOR01: 'pull' };
  const finalPatterns = new Set((fbs.exercises || []).map(ex => codeToPattern[ex.lift_code]).filter(Boolean));
  for (const p of overduePatterns) {
    assert.ok(finalPatterns.has(p),
      `brief names ${p} as overdue but no ${p} exercise survived into the final session [${[...finalPatterns].join(', ')}]`);
  }
  // Sanity: the data_point labels are all real patterns (no stale label).
  for (const dp of (fbs.data_points || [])) {
    assert.ok(labelToPattern[dp.label], `data_point label "${dp.label}" must be a known pattern`);
  }
});

// ── Blind spots are a STIMULUS MODIFIER on a COMPLETE session, not the whole session ──
// Owner planning hierarchy (2026-06-25): goal → readiness → structure → blind spots.
// The "Fix Blind Spots" pick must build a full, structured session that EMPHASIZES
// the overdue patterns — not a 2-3 exercise blind-spot-only day. Same fixture as the
// brief↔exercise test: pressing + pulling trained right up to today (staples), lower
// + hinge neglected (overdue). The session must include the overdue work AND the
// recently-trained staples, woven into one complete workout.
test('scoreIntents: fix_blind_spots builds a FULL session emphasizing overdue patterns (not a blind-spot-only day)', () => {
  const mk = (ex, mg, code, ws, start, step) => ws.map((w, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i * step);
    return [d.toISOString().split('T')[0], `${ex}-${i}`, ex, ex, mg, code, '1', String(w), '8', '2', '', ''];
  });
  const rows = [
    ...mk('Bench Press', 'Chest', 'BEN01', [185, 188, 190, 192, 195, 198, 200, 202], '2026-04-20', 2),
    ...mk('Barbell Row', 'Back', 'BOR01', [155, 158, 160, 162, 165, 168, 170, 172], '2026-04-21', 2),
    ...mk('Back Squat', 'Quads', 'SQT01', [225, 230, 235], '2026-04-01', 5),
    ...mk('Romanian Deadlift', 'Hamstrings', 'RDL01', [185, 190, 195], '2026-04-02', 5),
  ];
  const result = scoreIntents(rows, [], { today: '2026-05-06' });
  const fbs = result.intents.find(i => i.id === 'fix_blind_spots');
  assert.ok(fbs && Array.isArray(fbs.exercises), 'fix_blind_spots intent must exist with exercises');

  const codeToPattern = { SQT01: 'lower', RDL01: 'hinge', BEN01: 'push', BOR01: 'pull' };
  const present = new Set(fbs.exercises.map(ex => codeToPattern[ex.lift_code]).filter(Boolean));

  // The overdue patterns are emphasized (present), AND at least one recently-trained
  // staple pattern is woven in — proving the session is COMPLETE, not gap-only.
  assert.ok(present.has('lower') || present.has('hinge'), 'an overdue pattern is in the session');
  assert.ok(present.has('push') || present.has('pull'),
    `a recently-trained staple must be woven into the blind-spot session (got patterns [${[...present].join(', ')}])`);
  // It is a fuller session than the old gap-only behavior (which produced only the
  // 2 overdue mains). With staples woven in it spans 3+ exercises across 3+ patterns.
  assert.ok(fbs.exercises.length >= 3, `expected a full session, got ${fbs.exercises.length} exercises`);
  assert.ok(present.size >= 3, `expected coverage across 3+ patterns, got [${[...present].join(', ')}]`);
});

// ── e1RM trend uses each session's BEST set, not its first (warm-up) set ───────
// For lifters who log warm-ups first, the per-session FIRST set is a priming set;
// computing the trend from it masks real working-set progression.
test('recommendNextSet: a climbing lift logged warm-up-first reads e1rm_trend "up" (not masked flat)', () => {
  const row = (d, s, sn, w, r, rir) => [d, s, 'Bench Press', 'Bench Press', 'Chest', 'BEN01', String(sn), String(w), String(r), String(rir), '', ''];
  // Each session: flat 135×15 warm-up logged FIRST, then climbing working sets.
  const rows = [
    row('2026-05-01', 'S1', 1, 135, 15, 6), row('2026-05-01', 'S1', 2, 185, 8, 2), row('2026-05-01', 'S1', 3, 205, 5, 2),
    row('2026-05-08', 'S2', 1, 135, 15, 6), row('2026-05-08', 'S2', 2, 195, 8, 2), row('2026-05-08', 'S2', 3, 225, 5, 2),
  ];
  const rec = recommendNextSet(rows, 'BEN01', { today: '2026-05-09' });
  assert.equal(rec.e1rm_trend, 'up', 'working-set progression must not be masked by a flat warm-up logged first');
});

test('recommendNextSet: trend is unaffected for single-working-set-per-session history', () => {
  // Guard: the common case (one set per session, no warm-ups) is unchanged.
  const row = (d, s, w) => [d, s, 'Squat', 'Squat', 'Quads', 'SQ01', '1', String(w), '5', '2', '', ''];
  const rows = [row('2026-05-01', 'A', 225), row('2026-05-08', 'B', 230), row('2026-05-15', 'C', 235)];
  assert.equal(recommendNextSet(rows, 'SQ01', { today: '2026-05-16' }).e1rm_trend, 'up');
});

// ── Bodyweight lifts get a rep-based recommendation, not a false dead-end ──────
// Live-test bug (2026-06-29): logging hanging knee raises returned "No recent
// working sets found for this lift code" and no next card, because recommendNextSet
// filtered working sets on a positive WEIGHT — which a bodyweight movement never
// has. The fix gates on reps and progresses by reps, never load.
test('recommendNextSet: bodyweight lift (no load) gets a rep-based rec, not a false "no working sets"', () => {
  const bw = (d, s, sn, r, rir) => [d, s, 'Hanging Knee Raise', 'Hanging Knee Raise', 'Core', 'HKR01', String(sn), '', String(r), String(rir), '', ''];
  const rows = [
    bw('2026-06-02', 'S1', 1, 12, 2), bw('2026-06-02', 'S1', 2, 12, 2),
    bw('2026-06-09', 'S2', 1, 12, 2), bw('2026-06-09', 'S2', 2, 12, 2)
  ];
  const rec = recommendNextSet(rows, 'HKR01', { today: '2026-06-10' });
  assert.notEqual(rec.recommendation, 'No recent working sets found for this lift code.');
  assert.ok(rec.next_target, 'a bodyweight lift must still render a next-target card');
  assert.equal(rec.next_target.weight, 0, 'bodyweight = no external load');
  assert.equal(rec.next_target.reps, 13, 'RIR 2 leaves room → add a rep');
  assert.match(rec.recommendation, /rep/i);
  assert.doesNotMatch(rec.recommendation, /lb/i, 'must never prescribe a weight bump for a bodyweight lift');
  assert.equal(rec.sessions_analyzed, 2);
});

test('recommendNextSet: a bodyweight lift at failure holds reps instead of inventing load', () => {
  const rows = [['2026-06-09', 'S2', 'Push-Up', 'Push-Up', 'Chest', 'PU01', '1', '', '20', '0', '', '']];
  const rec = recommendNextSet(rows, 'PU01', { today: '2026-06-10' });
  assert.equal(rec.next_target.weight, 0);
  assert.equal(rec.next_target.reps, 20, 'RIR 0 = at failure → hold the rep count');
  assert.match(rec.recommendation, /Hold 20 reps/);
});

test('recommendNextSet: added-load bodyweight (weighted dips) still progresses by load', () => {
  // Guard: a lift logged WITH external load is not treated as bodyweight — the
  // weighted progression path is unchanged.
  const wd = (d, s) => [d, s, 'Weighted Dip', 'Weighted Dip', 'Chest', 'WDIP01', '1', '25', '8', '2', '', ''];
  const rec = recommendNextSet([wd('2026-06-02', 'S1'), wd('2026-06-09', 'S2')], 'WDIP01', { today: '2026-06-10' });
  assert.equal(rec.next_target.weight, 30, 'stable reps at RIR 2 over two sessions → +5 lb bump');
  assert.equal(rec.next_target.reps, 8);
});

// ── Personalized warm-up ramps from logged history (end-to-end) ───────────────
// A lift the lifter logs a consistent warm-up ramp on gets THEIR ramp scaled to
// today's working weight; a lift with no logged ramp history gets the generic one.
test('scoreIntents: a main compound with a logged ramp history shows the lifter\'s own ramp', () => {
  const row = (d, s, code, sn, w, r, rir, ex, mg) =>
    [d, s, ex, ex, mg, code, String(sn), String(w), String(r), rir == null ? '' : String(rir), '', ''];
  const rows = [];
  // Bench: the owner's ramp style (135×15 warm-up, 185×10 transition, 225 working)
  // across 4 sessions → detector learns a 2-step ~0.60/0.82 × 15/10 ramp.
  ['2026-04-22', '2026-04-26', '2026-04-30', '2026-05-04'].forEach((d, i) => {
    rows.push(row(d, `B${i}`, 'BEN01', 1, 135, 15, 6, 'Bench Press', 'Chest'));
    rows.push(row(d, `B${i}`, 'BEN01', 2, 185, 10, 2, 'Bench Press', 'Chest'));
    rows.push(row(d, `B${i}`, 'BEN01', 3, 225, 8, 1, 'Bench Press', 'Chest'));
    rows.push(row(d, `B${i}`, 'BEN01', 4, 225, 5, 2, 'Bench Press', 'Chest'));
  });
  const result = scoreIntents(rows, [], { today: '2026-05-06', goal: 'strength' });
  let bench = null;
  for (const intent of result.intents) {
    const ex = (intent.exercises || []).find(e => /bench/i.test(e.exercise) && Array.isArray(e.warmup_sets) && e.warmup_sets.length);
    if (ex) { bench = ex; break; }
  }
  assert.ok(bench, 'Bench must appear as a ramped main compound');
  // Personalized: 2 steps with the lifter's rep scheme (15, 10) — NOT the generic
  // 3-step 8/5/3. Loads scale to the working weight (~0.60/0.82 of ~225).
  assert.equal(bench.warmup_sets.length, 2, `personalized 2-step ramp; got ${bench.warmup_sets.length}`);
  assert.deepEqual(bench.warmup_sets.map(s => s.reps), [15, 10], 'the lifter\'s own rep scheme, not 8/5/3');
  const w = bench.warmup_sets.map(s => s.weight);
  assert.ok(w[0] < w[1] && w[1] < bench.target_weight, `ascending into the working weight; got ${w} → ${bench.target_weight}`);
  bench.warmup_sets.forEach(s => assert.equal(s.priming, true));
});

test('scoreIntents: a main compound with NO logged ramp history gets the generic ramp', () => {
  // Squat logged as flat working sets only (no warm-up lead-in) → generic 8/5/3.
  const row = (d, s, w) => [d, s, 'Back Squat', 'Back Squat', 'Quads', 'SQT01', '1', String(w), '5', '2', '', ''];
  const rows = ['2026-04-28', '2026-05-01', '2026-05-04'].map((d, i) => row(d + '', `S${i}`, 235 + i * 5));
  const result = scoreIntents(rows, [], { today: '2026-05-06', goal: 'strength' });
  let squat = null;
  for (const intent of result.intents) {
    const ex = (intent.exercises || []).find(e => /squat/i.test(e.exercise) && Array.isArray(e.warmup_sets) && e.warmup_sets.length);
    if (ex) { squat = ex; break; }
  }
  assert.ok(squat, 'Squat must appear as a ramped main compound');
  assert.deepEqual(squat.warmup_sets.map(s => s.reps), [8, 5, 3], 'generic ramp when there is no logged ramp history');
});

// ── Recovery-aware strength density (read ↔ prescription consistency) ──────────
// A movement pattern the readiness model marks 'recovering' must not be STACKED
// with multiple movements in Build Strength — that contradicts the same model's
// "still recovering" read. The prescription is thinned to one movement of that
// pattern (the main compound), and the intent explains the trim.

test('scoreIntents: a recovering push pattern is thinned to one pressing movement (no read/prescription contradiction)', () => {
  // Bench + Weighted Dip + Incline DB Press all last trained 2 days before today
  // (daysSince=2 → recovery≈0.62 → 'recovering' push). A barbell row sits in the
  // same sessions (pull). All on shared dates → 5 sessions < 6 → no #466 profile,
  // so the per-pattern recovery cap is what fires, not the session-volume cap.
  const rows = [
    ...makeRows('Bench Press',     'chest', 'BPR01', [185, 188, 190, 193, 195], '2026-04-01'),
    ...makeRows('Weighted Dip',    'chest', 'DIP01', [ 90,  92,  95,  97, 100], '2026-04-01'),
    ...makeRows('Incline DB Press','chest', 'INC01', [ 60,  62,  64,  66,  68], '2026-04-01'),
    ...makeRows('Barbell Row',     'back',  'ROW01', [155, 158, 160, 163, 165], '2026-04-01'),
  ];
  const today = '2026-05-01'; // last session 2026-04-29 → 2 days ago

  // Precondition: the readiness model really does read push as 'recovering'.
  const readiness = buildMuscleGroupReadiness(rows, { today });
  assert.equal(readiness.find(r => r.pattern === 'push')?.status, 'recovering',
    'fixture must put push in the recovering state for this test to be meaningful');

  const result = scoreIntents(rows, [], { today });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs, 'build_strength must exist');

  // Prescription reflects the recovery read: exactly ONE pressing movement, and it
  // is the main compound (Bench), not the secondary presses.
  const pushCodes = new Set(['BPR01', 'DIP01', 'INC01']);
  const pushInPlan = bs.exercises.filter(ex => pushCodes.has(ex.lift_code));
  assert.equal(pushInPlan.length, 1,
    `recovering push should be thinned to one movement, got [${pushInPlan.map(e => e.exercise).join(', ')}]`);
  assert.equal(pushInPlan[0].lift_code, 'BPR01', 'the surviving press is the main compound (Bench)');

  // The trim is selective — pull is untouched (still prescribed).
  assert.ok(bs.exercises.some(ex => ex.lift_code === 'ROW01'), 'pull work is retained');

  // Text ↔ prescription consistency: the intent EXPLAINS the recovery-driven trim.
  assert.ok(bs.why_today.some(w => /push is still recovering/i.test(w)),
    `expected a why_today line acknowledging push recovery, got [${bs.why_today.join(' | ')}]`);
  assert.ok(bs.reason_codes.includes('recovering_pattern_density_capped'),
    `expected recovering_pattern_density_capped reason code, got [${bs.reason_codes.join(', ')}]`);
});

test('scoreIntents: the density cap is recovery-gated — a fresh push pattern keeps all its movements', () => {
  // Same three presses, but last trained 7 days before today (daysSince=7 →
  // recovery≈0.97 → 'fresh' push). No recovery contradiction → no trim.
  const rows = [
    ...makeRows('Bench Press',     'chest', 'BPR01', [185, 188, 190, 193, 195], '2026-03-27'),
    ...makeRows('Weighted Dip',    'chest', 'DIP01', [ 90,  92,  95,  97, 100], '2026-03-27'),
    ...makeRows('Incline DB Press','chest', 'INC01', [ 60,  62,  64,  66,  68], '2026-03-27'),
  ];
  const today = '2026-05-01'; // last session 2026-04-24 → 7 days ago

  const readiness = buildMuscleGroupReadiness(rows, { today });
  assert.equal(readiness.find(r => r.pattern === 'push')?.status, 'fresh',
    'fixture must put push in the fresh state (not recovering) for the control');

  const result = scoreIntents(rows, [], { today });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs, 'build_strength must exist');

  const pushCodes = new Set(['BPR01', 'DIP01', 'INC01']);
  const pushInPlan = bs.exercises.filter(ex => pushCodes.has(ex.lift_code));
  assert.equal(pushInPlan.length, 3, 'a fresh push pattern is not thinned');
  assert.ok(!bs.reason_codes.includes('recovering_pattern_density_capped'),
    'no recovery cap code when nothing was recovering');
});

// ── Recovery-aware density extends to the buildIntentSession intents ───────────
// build_muscle / fix_blind_spots / balanced now thin a recovering pattern too,
// but at the HIGHER hypertrophy cap (2 movements) — hypertrophy tolerates more
// volume on a recovering pattern than a strength day (which caps at 1).

test('scoreIntents: build_muscle thins a recovering push pattern to TWO movements (hypertrophy cap), not one and not three', () => {
  // Same recovering-push fixture as the build_strength density test: three presses
  // + a row, all last trained 2 days before today → push reads 'recovering'.
  const rows = [
    ...makeRows('Bench Press',     'chest', 'BPR01', [185, 188, 190, 193, 195], '2026-04-01'),
    ...makeRows('Weighted Dip',    'chest', 'DIP01', [ 90,  92,  95,  97, 100], '2026-04-01'),
    ...makeRows('Incline DB Press','chest', 'INC01', [ 60,  62,  64,  66,  68], '2026-04-01'),
    ...makeRows('Barbell Row',     'back',  'ROW01', [155, 158, 160, 163, 165], '2026-04-01'),
  ];
  const today = '2026-05-01';

  // Precondition: push really is recovering (the cap only fires on a recovering read).
  const readiness = buildMuscleGroupReadiness(rows, { today });
  assert.equal(readiness.find(r => r.pattern === 'push')?.status, 'recovering',
    'fixture must put push in the recovering state for this test to be meaningful');

  const result = scoreIntents(rows, [], { today });
  const bm = result.intents.find(i => i.id === 'build_muscle');
  assert.ok(bm, 'build_muscle must exist');

  const pushCodes = new Set(['BPR01', 'DIP01', 'INC01']);
  const pushInPlan = bm.exercises.filter(ex => pushCodes.has(ex.lift_code));
  assert.equal(pushInPlan.length, 2,
    `recovering push should be thinned to the hypertrophy cap (2), got [${pushInPlan.map(e => e.exercise).join(', ')}]`);
  // The kept presses lead with the main compound (Bench), not dropped for it.
  assert.ok(pushInPlan.some(ex => ex.lift_code === 'BPR01'), 'the main compound (Bench) survives the trim');
  // Pull is untouched.
  assert.ok(bm.exercises.some(ex => ex.lift_code === 'ROW01'), 'pull work is retained');
  // The trim is surfaced honestly in both the reason codes and the why copy.
  assert.ok(bm.reason_codes.includes('recovering_pattern_density_capped'),
    `expected recovering_pattern_density_capped reason code, got [${bm.reason_codes.join(', ')}]`);
  assert.ok(bm.why_today.some(w => /still recovering/i.test(w) && /movements/i.test(w)),
    `expected a why_today line acknowledging the recovery trim, got [${bm.why_today.join(' | ')}]`);

  // balanced runs the same parameterized cap — lock it in too (reviewer note #543).
  const bal = result.intents.find(i => i.id === 'balanced');
  assert.ok(bal, 'balanced must exist');
  const balPush = bal.exercises.filter(ex => pushCodes.has(ex.lift_code));
  assert.equal(balPush.length, 2, `balanced recovering push should also cap at 2, got ${balPush.length}`);
  assert.ok(bal.reason_codes.includes('recovering_pattern_density_capped'),
    'balanced carries the recovery cap reason code');
  assert.ok(bal.why_today.some(w => /still recovering/i.test(w) && /movements/i.test(w)),
    'balanced explains the recovery trim in why_today');
});

test('scoreIntents: the buildIntentSession density cap is recovery-gated — a fresh push keeps all THREE presses', () => {
  // Three presses last trained 7 days before today → push reads 'fresh'. No
  // recovery contradiction → no trim in build_muscle either (control for the above).
  const rows = [
    ...makeRows('Bench Press',     'chest', 'BPR01', [185, 188, 190, 193, 195], '2026-03-27'),
    ...makeRows('Weighted Dip',    'chest', 'DIP01', [ 90,  92,  95,  97, 100], '2026-03-27'),
    ...makeRows('Incline DB Press','chest', 'INC01', [ 60,  62,  64,  66,  68], '2026-03-27'),
  ];
  const today = '2026-05-01';

  const readiness = buildMuscleGroupReadiness(rows, { today });
  assert.equal(readiness.find(r => r.pattern === 'push')?.status, 'fresh',
    'fixture must put push in the fresh state (not recovering) for the control');

  const result = scoreIntents(rows, [], { today });
  const bm = result.intents.find(i => i.id === 'build_muscle');
  assert.ok(bm, 'build_muscle must exist');

  const pushCodes = new Set(['BPR01', 'DIP01', 'INC01']);
  const pushInPlan = bm.exercises.filter(ex => pushCodes.has(ex.lift_code));
  assert.equal(pushInPlan.length, 3, 'a fresh push pattern is not thinned in build_muscle');
  assert.ok(!bm.reason_codes.includes('recovering_pattern_density_capped'),
    'no recovery cap code when nothing was recovering');
});

// ── Recovery trim must not collapse the session below the learned norm ─────────
// A single recovering pattern should reduce ITS density, then the day is
// backfilled with rested patterns toward the lifter's profile target (median ~5,
// p75 6) — it should not shrink to 3 exercises unless global fatigue warrants it.

// Session of [name, muscle, code, weight] rows (3 sets each) on a given date.
function densitySession(date, lifts) {
  const rows = [];
  for (const [name, muscle, code, w] of lifts) {
    for (let s = 1; s <= 3; s++) {
      rows.push([date, `${date}-S`, name, name, muscle, code, String(s), String(w), '5', '2', '', '']);
    }
  }
  return rows;
}

// Eight weekly "full" 5-exercise history sessions (push/pull/lower/hinge/core) so
// buildSessionVolumeProfile learns a ~5-exercise norm.
function densityHistory() {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date('2026-02-07'); d.setDate(d.getDate() + i * 7);
    rows.push(...densitySession(d.toISOString().slice(0, 10), [
      ['Bench Press',       'chest',            'BPR01', 185],
      ['Seated Row',        'back',             'ROW01', 155],
      ['Leg Press',         'quads',            'LEG01', 300],
      ['Romanian Deadlift', 'posterior chain',  'RDL01', 185],
      ['Cable Crunch',      'abs',              'CRU01',  60],
    ]));
  }
  return rows;
}

test('scoreIntents: a recovering push pattern does NOT collapse Build Strength to 3 — it backfills rested patterns to the learned norm', () => {
  const rows = [
    ...densityHistory(),
    // Rested patterns last trained 3 days ago (ready): pull / lower / hinge / core.
    ...densitySession('2026-04-28', [
      ['Seated Row',        'back',            'ROW01', 158],
      ['Lat Pulldown',      'back',            'LAT01', 120],
      ['Leg Press',         'quads',           'LEG01', 305],
      ['Romanian Deadlift', 'posterior chain', 'RDL01', 188],
      ['Cable Crunch',      'abs',             'CRU01',  62],
    ]),
    // Push last trained 2 days ago (recovering) with THREE pressing movements.
    ...densitySession('2026-04-29', [
      ['Bench Press',        'chest', 'BPR01', 190],
      ['Weighted Dip',       'chest', 'DIP01',  95],
      ['Incline DB Press',   'chest', 'INC01',  65],
    ]),
  ];
  const today = '2026-05-01';

  const readiness = buildMuscleGroupReadiness(rows, { today });
  assert.equal(readiness.find(r => r.pattern === 'push')?.status, 'recovering', 'push must read recovering');
  assert.equal(readiness.find(r => r.pattern === 'pull')?.status, 'ready', 'pull must read ready (not recovering)');
  assert.equal(readiness.find(r => r.pattern === 'lower')?.status, 'ready', 'lower must read ready (backfill source)');

  const result = scoreIntents(rows, [], { today });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs, 'build_strength must exist');

  // Push is still thinned to one movement (the #467 behaviour holds).
  const pushCodes = new Set(['BPR01', 'DIP01', 'INC01']);
  assert.equal(bs.exercises.filter(ex => pushCodes.has(ex.lift_code)).length, 1, 'push thinned to one movement');

  // But the session is NOT collapsed to 3 — it sits near the learned 4–6 norm…
  assert.ok(bs.exercises.length >= 4 && bs.exercises.length <= 6,
    `expected a 4–6 exercise session near the learned norm, got ${bs.exercises.length}`);

  // …because it backfilled with a rested, non-push pattern (legs / hinge / core).
  const backfillCodes = new Set(['LEG01', 'RDL01', 'CRU01']);
  assert.ok(bs.exercises.some(ex => backfillCodes.has(ex.lift_code)),
    'session must backfill with a rested pattern beyond push+pull');
  assert.ok(bs.reason_codes.includes('volume_shifted_to_ready_patterns'),
    `expected volume_shifted_to_ready_patterns reason code, got [${bs.reason_codes.join(', ')}]`);
});

test('scoreIntents: high GLOBAL fatigue does not backfill/pad the Build Strength day (no volume shifting)', () => {
  const rows = [
    ...densityHistory(),
    // A tiny baseline-window session (days 8–28) so fatigue has a baseline to beat.
    ...densitySession('2026-04-10', [['Cable Crunch', 'abs', 'CRU01', 30]]),
    // Heavy recent week (last 7 days) → recent volume ≫ baseline → fatigue 'high'.
    ...densitySession('2026-04-28', [
      ['Seated Row',        'back',            'ROW01', 158],
      ['Lat Pulldown',      'back',            'LAT01', 120],
      ['Leg Press',         'quads',           'LEG01', 305],
      ['Romanian Deadlift', 'posterior chain', 'RDL01', 188],
      ['Cable Crunch',      'abs',             'CRU01',  62],
    ]),
    ...densitySession('2026-04-29', [
      ['Bench Press',      'chest', 'BPR01', 190],
      ['Weighted Dip',     'chest', 'DIP01',  95],
      ['Incline DB Press', 'chest', 'INC01',  65],
    ]),
  ];
  const today = '2026-05-01';

  // Precondition: global fatigue really is high, and a profile exists (so the only
  // reason backfill is withheld is fatigue, not missing data).
  assert.equal(computeFatigueStatus(rows, new Date(today + 'T12:00:00')).status, 'high',
    'fixture must drive global fatigue high');
  assert.equal(buildMuscleGroupReadiness(rows, { today }).find(r => r.pattern === 'push')?.status, 'recovering');

  const result = scoreIntents(rows, [], { today });
  const bs = result.intents.find(i => i.id === 'build_strength');
  assert.ok(bs, 'build_strength must exist');

  assert.equal(bs.exercises.filter(ex => new Set(['BPR01', 'DIP01', 'INC01']).has(ex.lift_code)).length, 1,
    'push still thinned to one movement');
  // build_strength is full-profile by default (push + pull + lower + hinge), so the
  // recovering push is thinned to one but the day still spans the rest of the body —
  // high fatigue does NOT silently drop it to upper-only. What high fatigue DOES do
  // is withhold the backfill: no extra volume is shifted onto rested patterns to pad
  // the day back up to the learned norm.
  assert.ok(!bs.reason_codes.includes('volume_shifted_to_ready_patterns'), 'no backfill under high fatigue');
  assert.ok(bs.reason_codes.includes('high_fatigue'), 'the day carries the global-fatigue reason');
  // The session stays within the learned norm (it is not padded past it).
  assert.ok(bs.exercises.length <= 6,
    `expected a restrained session within the learned norm, got ${bs.exercises.length}`);
});

// Threading fix: scoreIntents' exForPatterns now carries `muscle_group` on every
// recommended exercise, so the session-structuring helpers can classify a
// keyword-less accessory by its muscle group. Prove the field survives end-to-end.
test('scoreIntents threads muscle_group onto recommended exercises (keyword-less accessory)', () => {
  const mk = (name, code, mg, date, w) => ({
    lift_code: code, exercise: name, canonical_exercise: name, muscle_group: mg,
    weight: w, reps: 8, rir: 2, date_clean: date, set_number: 1,
  });
  const rows = [];
  for (const d of ['2026-06-01', '2026-06-04', '2026-06-08', '2026-06-11', '2026-06-15', '2026-06-18']) {
    rows.push(mk('Bench Press', 'BEN01', 'Chest', d, 185));
    rows.push(mk('Barbell Row', 'ROW01', 'Back', d, 135));
    rows.push(mk('Pallof Press', 'PAL01', 'Core', d, 60)); // name matches no role pattern
  }
  const out = scoreIntents(rows, [], { today: '2026-06-20' });
  const exercises = (out.intents || []).flatMap(it => it.exercises || []);
  const pallofs = exercises.filter(e => /pallof/i.test(e.exercise || ''));
  assert.ok(pallofs.length > 0, 'the keyword-less accessory should appear in a recommended intent');
  // The exForPatterns-built intents now carry muscle_group end-to-end (the
  // buildIntentSession path is a separate, out-of-scope builder — see BACKLOG).
  assert.ok(pallofs.some(e => e.muscle_group === 'Core'),
    'the exForPatterns path must thread muscle_group so role classification is not name-only');
});

// Consistency completion: capRecoveringPatternDensity ranks which movement to keep
// on a recovering pattern via classifyLiftRole — it must use the exercise's
// muscle_group (now threaded through exForPatterns), not an empty group, so a
// keyword-less accessory is ranked as accessory and dropped before a real lift.
test('capRecoveringPatternDensity roleRank uses the exercise muscle_group (not empty)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'analytics.js'), 'utf8');
  assert.match(
    src,
    /roleRank\s*=\s*ex\s*=>.*classifyLiftRole\(ex && ex\.exercise \|\| '', ex && ex\.muscle_group \|\| ''\)/,
    'capRecoveringPatternDensity must pass ex.muscle_group to classifyLiftRole');
  // Guard against regressing to the empty-group form.
  assert.doesNotMatch(
    src,
    /classifyLiftRole\(ex && ex\.exercise \|\| '', ''\)/,
    'the empty-group classifyLiftRole call must not return');
});

// #402 dedup carve-out: the allRecs name-dedup used to skip ALL single-word names
// (a whitespace proxy for "muscle-group placeholder"), which let a real single-word
// lift logged under two lift codes escape dedup and get double-recommended. The
// carve-out now skips only single-word names that are actual muscle-group labels,
// so real single-word lifts dedup to the most-recently-trained code, while
// multi-word lifts (even ones containing a muscle keyword) are unaffected.
test('#402: real single-word lift logged under two codes dedups to the newest code', () => {
  const mk = (n, c, mg, d, w) => ({
    lift_code: c, exercise: n, canonical_exercise: n, muscle_group: mg,
    weight: w, reps: 8, rir: 2, date_clean: d, set_number: 1,
  });
  const rows = [];
  // "Squat" under an OLDER code SQ01 and a NEWER code SQ02 — same real lift.
  for (const d of ['2026-05-20', '2026-05-27', '2026-06-03']) rows.push(mk('Squat', 'SQ01', 'Quads', d, 225));
  for (const d of ['2026-06-06', '2026-06-10', '2026-06-14']) rows.push(mk('Squat', 'SQ02', 'Quads', d, 245));
  for (const d of ['2026-06-05', '2026-06-09', '2026-06-13']) rows.push(mk('Bench Press', 'BEN01', 'Chest', d, 185));

  const out = scoreIntents(rows, [], { today: '2026-06-16' });
  const squats = (out.intents || []).flatMap(it => it.exercises || []).filter(e => /^squat$/i.test(e.exercise || ''));
  const codes = [...new Set(squats.map(e => e.lift_code))];
  assert.deepEqual(codes, ['SQ02'], 'the older Squat code must be deduped out; only the newest survives');
});

test('#402: a multi-word lift with a muscle keyword still dedups (no regression)', () => {
  const mk = (n, c, mg, d, w) => ({
    lift_code: c, exercise: n, canonical_exercise: n, muscle_group: mg,
    weight: w, reps: 8, rir: 2, date_clean: d, set_number: 1,
  });
  const rows = [];
  // "Leg Press" classifies as a muscle group via its keyword, but it has a space
  // (a real lift) so it must still dedup — guards against a contains-match regression.
  for (const d of ['2026-05-20', '2026-05-27', '2026-06-03']) rows.push(mk('Leg Press', 'LP01', 'Quads', d, 300));
  for (const d of ['2026-06-06', '2026-06-10', '2026-06-14']) rows.push(mk('Leg Press', 'LP02', 'Quads', d, 320));
  for (const d of ['2026-06-05', '2026-06-09', '2026-06-13']) rows.push(mk('Bench Press', 'BEN01', 'Chest', d, 185));

  const out = scoreIntents(rows, [], { today: '2026-06-16' });
  const lp = (out.intents || []).flatMap(it => it.exercises || []).filter(e => /^leg press$/i.test(e.exercise || ''));
  const codes = [...new Set(lp.map(e => e.lift_code))];
  assert.deepEqual(codes, ['LP02'], 'Leg Press must still dedup to the newest code');
});

test('#402: a bare single-word movement name ("Row") dedups (substring residual closed)', () => {
  const mk = (n, c, mg, d, w) => ({
    lift_code: c, exercise: n, canonical_exercise: n, muscle_group: mg,
    weight: w, reps: 8, rir: 2, date_clean: d, set_number: 1,
  });
  const rows = [];
  // "Row" matches the `row` token in the pull muscle-pattern (a substring match),
  // but it is a MOVEMENT, not a muscle label — it must dedup. This is the exact
  // #402 Seated Row family; exact-membership (not classifyMuscleGroup) closes it.
  for (const d of ['2026-05-20', '2026-05-27', '2026-06-03']) rows.push(mk('Row', 'RW01', 'Back', d, 135));
  for (const d of ['2026-06-06', '2026-06-10', '2026-06-14']) rows.push(mk('Row', 'RW02', 'Back', d, 155));
  for (const d of ['2026-06-05', '2026-06-09', '2026-06-13']) rows.push(mk('Bench Press', 'BEN01', 'Chest', d, 185));

  const out = scoreIntents(rows, [], { today: '2026-06-16' });
  const r = (out.intents || []).flatMap(it => it.exercises || []).filter(e => /^row$/i.test(e.exercise || ''));
  const codes = [...new Set(r.map(e => e.lift_code))];
  assert.deepEqual(codes, ['RW02'], 'a bare "Row" must dedup to the newest code, not escape via a substring match');
});

test('#402: a single-word muscle-group LABEL placeholder ("Chest") is NOT collapsed', () => {
  const mk = (n, c, mg, d, w) => ({
    lift_code: c, exercise: n, canonical_exercise: n, muscle_group: mg,
    weight: w, reps: 8, rir: 2, date_clean: d, set_number: 1,
  });
  const rows = [];
  // 'Chest' is a muscle-group label used as a test placeholder — distinct lift
  // codes under it must be preserved (the carve-out's whole purpose).
  for (const d of ['2026-06-03', '2026-06-07']) rows.push(mk('Chest', 'CH01', 'Chest', d, 100));
  for (const d of ['2026-06-10', '2026-06-14']) rows.push(mk('Chest', 'CH02', 'Chest', d, 110));
  for (const d of ['2026-06-05', '2026-06-09', '2026-06-13']) rows.push(mk('Squat', 'SQ02', 'Quads', d, 245));

  const out = scoreIntents(rows, [], { today: '2026-06-16' });
  const chest = (out.intents || []).flatMap(it => it.exercises || []).filter(e => /^chest$/i.test(e.exercise || ''));
  const codes = new Set(chest.map(e => e.lift_code));
  assert.ok(codes.has('CH01') && codes.has('CH02'), 'both Chest placeholder codes must survive (not collapsed)');
});
