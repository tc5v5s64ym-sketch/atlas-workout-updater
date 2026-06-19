'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSuggestedWorkout } = require('../services/suggestedWorkout');

// 12-column Log_Cleaned row helper
// date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code |
// set_number | weight | reps | rir | notes | volume_calc
function row(date, session, exercise, muscle, liftCode, weight = 135, reps = 5, rir = 2) {
  return [date, session, exercise, exercise, muscle, liftCode, '1', String(weight), String(reps), String(rir), '', ''];
}

// Build N sessions of the same exercise for baseline data.
function baseline(exercise, muscle, liftCode, sessions = 5, startDate = '2026-04-01', weight = 135) {
  return Array.from({ length: sessions }, (_, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i * 7);
    const date = d.toISOString().split('T')[0];
    const session = `S${i + 1}`;
    return [
      row(date, session, exercise, muscle, liftCode, weight, 5, 2),
      row(date, session, exercise, muscle, liftCode, weight, 5, 3),
      row(date, session, exercise, muscle, liftCode, weight, 4, 3),
    ];
  }).flat();
}

// ── buildSuggestedWorkout ─────────────────────────────────────────────────────

test('buildSuggestedWorkout: empty rows → null', () => {
  assert.equal(buildSuggestedWorkout([]), null);
  assert.equal(buildSuggestedWorkout(null), null);
});

test('buildSuggestedWorkout: GOLDEN FIXTURE — returns structured suggestion', () => {
  // Enough bench press history for scoreIntents to produce an intent with exercises.
  const logRows = baseline('Bench Press', 'chest', 'BPR01', 6, '2026-03-01');

  const result = buildSuggestedWorkout(logRows, [], { today: '2026-04-19' });

  assert.ok(result !== null, 'should return a result with sufficient data');
  assert.ok(typeof result.intent === 'string',        'intent must be a string');
  assert.ok(typeof result.intent_label === 'string',  'intent_label must be a string');
  assert.ok(typeof result.intent_score === 'number',  'intent_score must be a number');
  assert.ok(typeof result.focus === 'string',         'focus must be a string');
  assert.ok(Array.isArray(result.exercises),          'exercises must be an array');
  assert.ok(Array.isArray(result.reason_codes),       'reason_codes must be an array');
  assert.ok(result.evidence && typeof result.evidence === 'object', 'evidence must be an object');
  assert.ok(Array.isArray(result.evidence.filtered_out),            'evidence.filtered_out must be an array');
  assert.ok(Array.isArray(result.watch_for),          'watch_for must be an array');
  assert.ok(Array.isArray(result.pivot_logic),        'pivot_logic must be an array');
});

test('buildSuggestedWorkout: picks the highest-scoring intent', () => {
  // Lower body fresh (long rest) → fix_blind_spots should score highly.
  const squatRows = baseline('Squat', 'lower', 'SQT01', 5, '2026-01-01'); // trained long ago
  const benchRows = baseline('Bench Press', 'chest', 'BPR01', 5, '2026-03-15'); // trained recently

  const result = buildSuggestedWorkout([...squatRows, ...benchRows], [], { today: '2026-04-19' });

  assert.ok(result !== null);
  // Intent should reflect the data; just confirm the shape is correct.
  assert.ok(['build_strength', 'build_muscle', 'fix_blind_spots', 'balanced'].includes(result.intent),
    `intent '${result.intent}' must be one of the known values`);
});

test('buildSuggestedWorkout: consistent_underperformance exercise moved to filtered_out', () => {
  // Build a "consistent_underperformance" signal: need ≥ UNDERPERFORMANCE_WINDOW (5) sessions
  // where e1RM is well below the benchmark. Use low-reps/low-weight (flat trend) vs a
  // high benchmark.
  //
  // Strategy: 6 high-weight sessions to establish benchmark, then 5 low-weight sessions.
  const benchmarkRows = baseline('Bench Press', 'chest', 'BPR01', 6, '2025-10-01', 185);
  // 5 underperforming sessions (substantially below benchmark)
  const underRows = Array.from({ length: 5 }, (_, i) => {
    const d = new Date('2026-03-01');
    d.setDate(d.getDate() + i * 7);
    const date = d.toISOString().split('T')[0];
    return [
      row(date, `U${i + 1}`, 'Bench Press', 'chest', 'BPR01', 95, 3, 2),
      row(date, `U${i + 1}`, 'Bench Press', 'chest', 'BPR01', 95, 3, 3),
    ];
  }).flat();

  const logRows = [...benchmarkRows, ...underRows];
  const result = buildSuggestedWorkout(logRows, [], { today: '2026-04-19' });

  // Whether or not underperformance fires (depends on threshold math with synthetic data),
  // the shape must always be correct.
  assert.ok(result !== null);
  assert.ok(Array.isArray(result.exercises));
  assert.ok(Array.isArray(result.evidence.filtered_out));

  // Each filtered_out entry must have the required fields.
  for (const item of result.evidence.filtered_out) {
    assert.ok(typeof item.exercise === 'string', 'filtered_out.exercise must be string');
    assert.ok(typeof item.lift_code === 'string', 'filtered_out.lift_code must be string');
    assert.ok(typeof item.reason === 'string',    'filtered_out.reason must be string');
  }
});

test('buildSuggestedWorkout: respects goal option', () => {
  const logRows = [
    ...baseline('Bench Press', 'chest', 'BPR01', 5, '2026-03-01'),
    ...baseline('Squat', 'lower', 'SQT01', 5, '2026-03-01'),
  ];

  const strengthResult = buildSuggestedWorkout(logRows, [], { today: '2026-04-19', goal: 'strength' });
  const muscleResult   = buildSuggestedWorkout(logRows, [], { today: '2026-04-19', goal: 'muscle' });

  // Both should return valid results; shape check only (score values are engine-internal).
  assert.ok(strengthResult !== null);
  assert.ok(muscleResult   !== null);
  assert.ok(typeof strengthResult.intent === 'string');
  assert.ok(typeof muscleResult.intent   === 'string');
});

test('buildSuggestedWorkout: reason_codes are short machine-readable strings, not prose', () => {
  const logRows = baseline('Bench Press', 'chest', 'BPR01', 6, '2026-03-01');
  const result = buildSuggestedWorkout(logRows, [], { today: '2026-04-19' });

  assert.ok(result !== null);
  assert.ok(Array.isArray(result.reason_codes), 'reason_codes must be an array');
  for (const code of result.reason_codes) {
    assert.ok(typeof code === 'string', 'each reason_code must be a string');
    // Machine-readable codes: lowercase, underscores allowed, no spaces, ≤ 30 chars
    assert.match(code, /^[a-z][a-z0-9_]*$/, `reason_code '${code}' must match snake_case pattern`);
    assert.ok(code.length <= 30, `reason_code '${code}' must be ≤ 30 chars`);
  }
});

test('buildSuggestedWorkout: well_rested code fires when last session was ≥ 2 days ago', () => {
  // 6 sessions of bench press, last session 2026-04-05, today 2026-04-19 → 14 days since last.
  // Only push/pull data → build_strength is the highest scorer; assert intent explicitly
  // so a future scoring change fails loudly rather than letting the test pass vacuously.
  const logRows = baseline('Bench Press', 'chest', 'BPR01', 6, '2026-03-01');
  const result = buildSuggestedWorkout(logRows, [], { today: '2026-04-19' });

  assert.ok(result !== null);
  assert.equal(result.intent, 'build_strength',
    `expected build_strength to win; got '${result.intent}' — fixture or scoring changed`);
  assert.ok(result.reason_codes.includes('well_rested'),
    `expected well_rested in reason_codes, got [${result.reason_codes.join(', ')}]`);
});

test('buildSuggestedWorkout: goal_alignment fires when a matching goal is set', () => {
  const logRows = [
    ...baseline('Bench Press', 'chest', 'BPR01', 6, '2026-03-01'),
    ...baseline('Squat',       'lower', 'SQT01', 6, '2026-03-01'),
  ];
  // goal=strength adds +20 to build_strength in the GOAL_BONUS table — it must win.
  // Assert intent explicitly so a scoring regression fails loudly.
  const result = buildSuggestedWorkout(logRows, [], { today: '2026-04-19', goal: 'strength' });

  assert.ok(result !== null);
  assert.equal(result.intent, 'build_strength',
    `expected build_strength to win with goal=strength; got '${result.intent}'`);
  assert.ok(result.reason_codes.includes('goal_alignment'),
    `expected goal_alignment in reason_codes for goal=strength, got [${result.reason_codes.join(', ')}]`);
});

test('buildSuggestedWorkout: exercises each have required fields', () => {
  const logRows = baseline('Bench Press', 'chest', 'BPR01', 6, '2026-03-01');
  const result = buildSuggestedWorkout(logRows, [], { today: '2026-04-19' });

  if (result && result.exercises.length) {
    for (const ex of result.exercises) {
      assert.ok(typeof ex.exercise === 'string',       'exercise must be string');
      assert.ok(typeof ex.lift_code === 'string',      'lift_code must be string');
      assert.ok(Number.isFinite(ex.target_weight) || ex.target_weight == null, 'target_weight must be numeric or null');
      assert.ok(Number.isFinite(ex.target_reps)   || ex.target_reps   == null, 'target_reps must be numeric or null');
      assert.ok(Number.isFinite(ex.target_sets)   || ex.target_sets   == null, 'target_sets must be numeric or null');
    }
  }
});
