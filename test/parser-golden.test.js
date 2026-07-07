/**
 * Parser golden regression tests — Dale's workout shorthand.
 *
 * Purpose: freeze the parser's behaviour for core logging language so
 * future changes cannot silently break it. Tests must match the parser's
 * current intended output; do not change parser code to make tests pass.
 *
 * Run: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkoutText } = require('../services/workoutTextParser');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Compact a log_sets result to [[weight, reps, rir], ...] for readable assertions. */
function sets(result) {
  assert.equal(result.intent, 'log_sets', `expected log_sets intent, got: ${result.intent} (${result.message})`);
  return result.sets.map(s => [s.weight, s.reps, s.rir]);
}

// ---------------------------------------------------------------------------
// Golden cases — happy path
// ---------------------------------------------------------------------------

test('golden: bench single set — slash = reps/RIR', () => {
  // 135 10/5 → 135 lb × 10 reps @ RIR 5
  // Invariant P1: slash never means reps × set-count
  const result = parseWorkoutText('Bench 135 10/5');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(sets(result), [[135, 10, 5]]);
});

test('golden: bench multiple weight groups', () => {
  // Classic warm-up + working sets across three weights
  const result = parseWorkoutText('Bench 135 10/5 185 8/3 225 5/2');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(sets(result), [[135, 10, 5], [185, 8, 3], [225, 5, 2]]);
});

test('golden: incline DB Press — x2 means two total instances of the last set', () => {
  // x2 after a set means that set appears twice in total (one already logged + one copy)
  const result = parseWorkoutText('Incline db press 60 10/2 70 8/2 x2');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(sets(result), [[60, 10, 2], [70, 8, 2], [70, 8, 2]]);
  assert.equal(result.sets.length, 3, 'x2 = 2 total, so one original + one copy = 3 sets total');
});

test('golden: incline bench — bare "incline bench" resolves to Incline Bench Press, not Bench Press', () => {
  // Live-bug: "incline bench" matched bare 'bench' alias → logged as Bench Press (wrong muscle group)
  const result = parseWorkoutText('Incline bench 185 8/2');
  assert.equal(result.canonical_name, 'Incline Bench Press');
  assert.deepEqual(sets(result), [[185, 8, 2]]);
});

test('golden: incline bench press — explicit form resolves to Incline Bench Press', () => {
  const result = parseWorkoutText('Incline bench press 185 8/2 8/3');
  assert.equal(result.canonical_name, 'Incline Bench Press');
  assert.deepEqual(sets(result), [[185, 8, 2], [185, 8, 3]]);
});

test('golden: decline bench — resolves to Decline Bench Press', () => {
  const result = parseWorkoutText('Decline bench 175 8/2');
  assert.equal(result.canonical_name, 'Decline Bench Press');
  assert.deepEqual(sets(result), [[175, 8, 2]]);
});

test('golden: decline bench press — explicit form resolves to Decline Bench Press', () => {
  const result = parseWorkoutText('Decline bench press 175 8/2 8/3');
  assert.equal(result.canonical_name, 'Decline Bench Press');
  assert.deepEqual(sets(result), [[175, 8, 2], [175, 8, 3]]);
});

test('golden: incline/decline guard — flat bench still resolves to Bench Press', () => {
  const result = parseWorkoutText('Flat bench 225 5/2');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(sets(result), [[225, 5, 2]]);
});

test('golden: incline/decline guard — bare "bench" still resolves to Bench Press', () => {
  const result = parseWorkoutText('Bench 225 5/2');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(sets(result), [[225, 5, 2]]);
});

test('golden: incline/decline guard — incline db press still resolves to Incline DB Press', () => {
  // The dumbbell variant must not be hijacked by the new barbell alias
  const result = parseWorkoutText('Incline db press 60 10/2');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(sets(result), [[60, 10, 2]]);
});

test('golden: lat pulldown x3 repeat shorthand — three total sets', () => {
  const result = parseWorkoutText('Lat pulldown 170 8/2 x3');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.deepEqual(sets(result), [[170, 8, 2], [170, 8, 2], [170, 8, 2]]);
});

test('golden: face pulls x3 repeat shorthand', () => {
  const result = parseWorkoutText('Face pulls 50 15/2 x3');
  assert.equal(result.canonical_name, 'Face Pull');
  assert.deepEqual(sets(result), [[50, 15, 2], [50, 15, 2], [50, 15, 2]]);
});

test('golden: "over head press" spacing variant resolves to Overhead Press', () => {
  // Live bug (2026-07-06 flight test): Dale typed "Over head press 95 10/5 120 8/2 x3"
  // and Atlas flagged it unknown_exercise / canonical "Over Head Press". The spaced
  // form must resolve like the joined "overhead press".
  const result = parseWorkoutText('Over head press 95 10/5 120 8/2');
  assert.equal(result.canonical_name, 'Overhead Press');
  assert.deepEqual(sets(result), [[95, 10, 5], [120, 8, 2]]);
});

test('golden: hammers — three sets with implied same weight, varying RIR', () => {
  // Weight is set on the first token; subsequent slash groups inherit it
  const result = parseWorkoutText('Hammers 40 10/1 8/2 8/1');
  assert.equal(result.canonical_name, 'Hammer Curl');
  assert.deepEqual(sets(result), [[40, 10, 1], [40, 8, 2], [40, 8, 1]]);
});

test('golden: knee raises with space-separated reps asks for clarification', () => {
  // "Knee raises 20 15 15" is ambiguous: 20 could be weight or reps.
  // The parser asks rather than guessing.
  const result = parseWorkoutText('Knee raises 20 15 15');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('missing_weight_or_bodyweight_context'));
  assert.match(result.message, /knee raises/i);
  assert.equal(result.partial.exercise, 'Hanging Knee Raises');
  assert.deepEqual(result.partial.sets.map(s => s.reps), [20, 15, 15]);
});

test('golden: squat — five sets across four weights with trailing implied-weight set', () => {
  // 5/1 at the end inherits 240 lb from the previous weight token
  const result = parseWorkoutText('Squat 135 10/4 185 8/4 225 8/2 240 5/2 5/1');
  assert.equal(result.canonical_name, 'Back Squat');
  assert.deepEqual(sets(result), [
    [135, 10, 4],
    [185, 8, 4],
    [225, 8, 2],
    [240, 5, 2],
    [240, 5, 1],
  ]);
});

test('golden: Wd alias resolves to Dips (Weighted)', () => {
  const result = parseWorkoutText('Wd 45 10/1 8/2 8/2');
  assert.equal(result.canonical_name, 'Dips (Weighted)');
  assert.deepEqual(sets(result), [[45, 10, 1], [45, 8, 2], [45, 8, 2]]);
});

test('golden: Kr alias resolves to Hanging Knee Raises — bodyweight repeat format', () => {
  // "15 x3" matches ^(\d+)\s*x(\d+)$ — 3 bodyweight sets of 15 reps
  const result = parseWorkoutText('Kr 15 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hanging Knee Raises');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(s => s.weight === null && s.weight_unit === null));
  assert.deepEqual(result.sets.map(s => [s.reps, s.rir]), [[15, null], [15, null], [15, null]]);
});

// ---------------------------------------------------------------------------
// Unsafe / blocked cases
// ---------------------------------------------------------------------------

test('golden: parseWeightRepsSets — absurd set count rejected', () => {
  // Format: <weight> x <reps> x <sets> — e.g. "225 x 5 x 3"
  // Without the guard, "bench 135 x 5 x 99" would emit 99 rows.
  const result = parseWorkoutText('bench 135 x 5 x 99');
  assert.ok(
    result.sets === undefined || result.sets.length <= 10,
    `expected ≤10 sets or undefined, got ${result.sets?.length}`
  );
  assert.notEqual(result.intent, 'log_sets', 'absurd set count must not produce log_sets');
});

test('golden: parseWeightRepsSets — valid set count parses correctly', () => {
  // Sanity-check that the guard does not break normal input.
  const result = parseWorkoutText('bench 135 x 5 x 3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(sets(result), [[135, 5, null], [135, 5, null], [135, 5, null]]);
});

test('golden: slp 70 x 12 @2 — must not explode into 70 rows', () => {
  // Without the setCount > 10 guard in parseSetsFirst, "70 x 12 @2" would
  // be read as "70 sets × 12 reps @ 2 lb" — 70 rows. Guard must reject it.
  const result = parseWorkoutText('slp 70 x 12 @2');
  assert.ok(
    result.sets === undefined || result.sets.length <= 10,
    `expected ≤10 sets, got ${result.sets?.length}`
  );
  assert.ok(
    !result.sets?.some(s => s.weight === 2),
    'weight must not be 2 (the catastrophic misparse value)'
  );
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('missing_sets'));
});

test('golden: lat pulldown 170 8/2 x99 — xN above cap is rejected', () => {
  // parseDaleShorthand returns null when xN > 10; the whole input clarifies.
  const result = parseWorkoutText('Lat pulldown 170 8/2 x99');
  assert.equal(result.intent, 'needs_clarification');
  assert.equal(result.sets, undefined);
  assert.ok(result.warnings.includes('missing_sets'));
});

test('golden: bare "Press" is ambiguous — parser asks which press', () => {
  // "press" is in AMBIGUOUS_ALIASES — must never silently resolve to OHP, bench, or incline
  const result = parseWorkoutText('Press 135 8/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('ambiguous_exercise_alias'));
  assert.match(result.message, /Which press/i);
});

test('golden: mixed exercises in one input split and log both (no row leak)', () => {
  // Two distinct canonicalized exercises are split on their names and each parsed
  // independently — bench rows stay bench (225), squat rows stay squat (185).
  const result = parseWorkoutText('Bench 225 5/2 squats 185 5/2');
  assert.equal(result.intent, 'log_sets_multi');
  assert.deepEqual(result.exercises.map(e => e.canonical_name), ['Bench Press', 'Back Squat']);
  assert.deepEqual(result.exercises[0].sets.map(s => [s.weight, s.reps, s.rir]), [[225, 5, 2]]);
  assert.deepEqual(result.exercises[1].sets.map(s => [s.weight, s.reps, s.rir]), [[185, 5, 2]]);
});

test('golden: knee raises slash-pair format produces bodyweight sets with reps and RIR', () => {
  // "Knee raises 20/2 20/2 13/2" — slash pairs with no leading weight token.
  // Parser must return intent=log_sets with weight:null on every set.
  const result = parseWorkoutText('Knee raises 20/2 20/2 13/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Hanging Knee Raises');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(s => s.weight === null && s.weight_unit === null),
    'all sets must have null weight for bodyweight exercise');
  assert.deepEqual(result.sets.map(s => [s.reps, s.rir]), [[20, 2], [20, 2], [13, 2]]);
});

test('golden: Atlas parser handles a wider workout phrase matrix safely', () => {
  const cases = [
    {
      input: 'bench 225 5/2 x3',
      intent: 'log_sets',
      canonical: 'Bench Press',
      expectedSets: [[225, 5, 2], [225, 5, 2], [225, 5, 2]],
    },
    {
      input: 'lat pulldown 170 10/2 175 8/2 8/1',
      intent: 'log_sets',
      canonical: 'Lat Pulldown',
      expectedSets: [[170, 10, 2], [175, 8, 2], [175, 8, 1]],
    },
    {
      input: 'face pulls 50 15/2 x3',
      intent: 'log_sets',
      canonical: 'Face Pull',
      expectedSets: [[50, 15, 2], [50, 15, 2], [50, 15, 2]],
    },
    {
      input: 'chin ups 8/2 x3',
      intent: 'log_sets',
      canonical: 'Chin Ups',
      expectedSets: [[null, 8, 2], [null, 8, 2], [null, 8, 2]],
      warning: 'unknown_exercise',
      needsCatalogReview: true,
    },
    {
      input: 'hang cleans 135 3/2 x5',
      intent: 'log_sets',
      canonical: 'Hang Cleans',
      expectedSets: [[135, 3, 2], [135, 3, 2], [135, 3, 2], [135, 3, 2], [135, 3, 2]],
      warning: 'unknown_exercise',
      needsCatalogReview: true,
    },
    {
      input: 'db walking lunges 40s 12/2 x3',
      intent: 'log_sets',
      canonical: 'Db Walking Lunges',
      expectedSets: [[40, 12, 2], [40, 12, 2], [40, 12, 2]],
      warning: 'unknown_exercise',
      needsCatalogReview: true,
      assertSetShape(result) {
        assert.ok(result.sets.every(set => set.load_note === 'per_hand'));
      },
    },
    {
      input: 'backflips 10 x3',
      intent: 'log_sets',
      canonical: 'Backflips',
      expectedSets: [[null, 10, null], [null, 10, null], [null, 10, null]],
      warning: 'unknown_exercise',
      needsCatalogReview: true,
    },
    {
      input: 'press 135 8/2',
      intent: 'needs_clarification',
      warning: 'ambiguous_exercise_alias',
      message: /Which press/i,
    },
    {
      input: 'row 135 8/2',
      intent: 'needs_clarification',
      warning: 'ambiguous_exercise_alias',
      message: /Which row/i,
    },
  ];

  for (const testCase of cases) {
    const result = parseWorkoutText(testCase.input);
    assert.equal(result.intent, testCase.intent, testCase.input);

    if (testCase.intent === 'log_sets') {
      assert.equal(result.canonical_name, testCase.canonical, testCase.input);
      assert.deepEqual(sets(result), testCase.expectedSets, testCase.input);
      if (testCase.warning) {
        assert.ok(result.warnings.includes(testCase.warning), testCase.input);
      } else {
        assert.deepEqual(result.warnings, [], `${testCase.input} should be warning-free`);
      }
      if (testCase.needsCatalogReview) {
        assert.equal(result.needs_catalog_review, true, `${testCase.input} should require catalog review`);
      }
      if (typeof testCase.assertSetShape === 'function') testCase.assertSetShape(result);
      continue;
    }

    assert.equal(result.sets, undefined, `${testCase.input} must not invent rows`);
    assert.ok(result.warnings.includes(testCase.warning), testCase.input);
    assert.match(result.message, testCase.message, testCase.input);
  }
});

test('golden: fuzz-style parser safety invariants hold across mixed workout phrases', () => {
  const samples = [
    'bench 225 5/2 x3',
    'lat pulldown 170 10/2 175 8/2 8/1',
    'face pulls 50 15/2 x3',
    'chin ups 8/2 x3',
    'hang cleans 135 3/2 x5',
    'db walking lunges 40s 12/2 x3',
    'backflips 10 x3',
    'press 135 8/2',
    'row 135 8/2',
  ];

  for (const input of samples) {
    const result = parseWorkoutText(input);
    assert.ok(['log_sets', 'needs_clarification'].includes(result.intent), `${input} produced unexpected intent ${result.intent}`);

    if (result.intent === 'log_sets') {
      assert.ok(result.canonical_name, `${input} should resolve to a canonical exercise`);
      assert.ok(result.sets.length > 0, `${input} should produce at least one set`);
      assert.ok(result.sets.length <= 10, `${input} should stay inside repeat guardrails`);
      if (result.warnings.includes('unknown_exercise')) {
        assert.equal(result.needs_catalog_review, true, `${input} should require catalog review when unknown`);
      }
      for (const set of result.sets) {
        assert.ok(Number.isFinite(set.reps) && set.reps > 0, `${input} has invalid reps`);
        assert.ok(set.weight == null || Number.isFinite(set.weight), `${input} has invalid weight`);
        assert.ok(set.rir == null || Number.isFinite(set.rir), `${input} has invalid RIR`);
      }
      continue;
    }

    assert.equal(result.sets, undefined, `${input} should not create rows when clarification is required`);
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, `${input} should explain why it was blocked`);
  }
});

test('golden: unknown exercises parse with review-needed metadata instead of clarification', () => {
  const cases = [
    ['chin ups 8/2 x3', 'Chin Ups', [[null, 8, 2], [null, 8, 2], [null, 8, 2]]],
    ['hang cleans 135 3/2 x5', 'Hang Cleans', [[135, 3, 2], [135, 3, 2], [135, 3, 2], [135, 3, 2], [135, 3, 2]]],
    ['db walking lunges 40s 12/2 x3', 'Db Walking Lunges', [[40, 12, 2], [40, 12, 2], [40, 12, 2]]],
    ['backflips 10 x3', 'Backflips', [[null, 10, null], [null, 10, null], [null, 10, null]]],
  ];

  for (const [input, canonicalName, expectedSets] of cases) {
    const result = parseWorkoutText(input);
    assert.equal(result.intent, 'log_sets', input);
    assert.equal(result.canonical_name, canonicalName, input);
    assert.equal(result.exercise, canonicalName, input);
    assert.equal(result.needs_catalog_review, true, input);
    assert.ok(result.warnings.includes('unknown_exercise'), input);
    assert.deepEqual(sets(result), expectedSets, input);
  }
});

// ---------------------------------------------------------------------------
// Fail-safe fallback — an unrecognized lift name must never be silently
// relabeled as the previously-active lift (PR 1). The deload-session repro:
// "shrugs 70 12/10" and "db 25 12/4" both came back as Bench Press because the
// active-exercise context was applied before the unknown-exercise path.
// ---------------------------------------------------------------------------

test('failsafe: shrugs resolves to Shrug, never Bench Press', () => {
  const noCtx = parseWorkoutText('shrugs 70 12/10');
  assert.equal(noCtx.canonical_name, 'Shrug');
  assert.deepEqual(sets(noCtx), [[70, 12, 10]]);

  // Even with a stale active-exercise context from a prior lift.
  const withCtx = parseWorkoutText('shrugs 70 12/10', { activeExercise: 'Bench Press' });
  assert.equal(withCtx.canonical_name, 'Shrug');
});

test('failsafe: unknown lift name is echoed + flagged, not absorbed into the active lift', () => {
  const result = parseWorkoutText('db 25 12/4', { activeExercise: 'Bench Press' });
  assert.equal(result.intent, 'log_sets');
  assert.notEqual(result.canonical_name, 'Bench Press');
  assert.equal(result.canonical_name, 'Db');
  assert.equal(result.needs_catalog_review, true);
  assert.ok(result.warnings.includes('unknown_exercise'));
  assert.deepEqual(sets(result), [[25, 12, 4]]);
});

test('failsafe: a genuinely unknown lift with context is flagged, never relabeled', () => {
  const result = parseWorkoutText('zercher curl 40 10/2', { activeExercise: 'Bench Press' });
  assert.equal(result.canonical_name, 'Zercher Curl');
  assert.ok(result.warnings.includes('unknown_exercise'));
});

test('failsafe: bare continuation sets still inherit the active exercise', () => {
  // No leading name — these are follow-up sets of the lift in progress.
  for (const input of ['205 5/3', 'another 205 5/3', 'same 185 8/2', 'then 200 6/2']) {
    const result = parseWorkoutText(input, { activeExercise: 'Bench Press' });
    assert.equal(result.canonical_name, 'Bench Press', input);
    assert.ok(!(result.warnings || []).includes('unknown_exercise'), input);
  }
});

test('failsafe: filler strip does not over-match real lift names', () => {
  // "and" inside "andover" must not be stripped to "over".
  const result = parseWorkoutText('andover press 95 8/2');
  assert.equal(result.canonical_name, 'Andover Press');
  assert.ok(result.warnings.includes('unknown_exercise'));
});

// ---------------------------------------------------------------------------
// Substitution / explanatory prose — performed exercise wins over skipped/
// mentioned exercise when each lives in its own blank-line paragraph.
// ---------------------------------------------------------------------------

test('substitution: leg press wins over back squat mentioned in explanatory prose', () => {
  const input = [
    "All squat racks are taken and there's a line. I'm swapping back squats for leg press today.",
    '',
    'Leg Press',
    '360 10/2',
    '360 10/2',
    '360 10/1',
  ].join('\n');
  const result = parseWorkoutText(input);
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent} (${result.message})`);
  assert.equal(result.canonical_name, 'Leg Press');
  assert.deepEqual(sets(result), [[360, 10, 2], [360, 10, 2], [360, 10, 1]]);
  assert.notEqual(result.canonical_name, 'Back Squat', 'must not log Back Squat');
});

test('substitution: rdl wins over deadlift mentioned in explanatory prose', () => {
  const input = [
    'The deadlift platform is occupied and there are 5 people waiting.',
    '',
    'Romanian Deadlift',
    '245lbs 7/2',
    '245lbs 7/2',
    '245lbs 7/2',
  ].join('\n');
  const result = parseWorkoutText(input);
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent} (${result.message})`);
  assert.equal(result.canonical_name, 'RDL');
  assert.deepEqual(sets(result), [[245, 7, 2], [245, 7, 2], [245, 7, 2]]);
  assert.notEqual(result.canonical_name, 'Deadlift', 'must not log Deadlift');
});

test('substitution: back squat still logs normally without substitution context', () => {
  const result = parseWorkoutText('Back Squat 360 10/2 10/2 10/1');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Back Squat');
  assert.deepEqual(sets(result), [[360, 10, 2], [360, 10, 2], [360, 10, 1]]);
});

test('substitution: leg press logs normally without substitution context', () => {
  const result = parseWorkoutText('Leg Press 360 10/2 10/2 10/1');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Leg Press');
  assert.deepEqual(sets(result), [[360, 10, 2], [360, 10, 2], [360, 10, 1]]);
});

test('substitution: explanatory prose + x-notation sets — leg press wins, sets preserved', () => {
  // "Skipped squat rack." ends with a period → IS_PROSE → discarded by extractSetParagraphs.
  // "Leg Press\n360x10x3" has no slash token but no terminal punctuation → kept.
  // parseWeightRepsSets resolves 360x10x3 → 3 sets of 10 reps @ weight 360, RIR null.
  const input = ['Skipped squat rack.', '', 'Leg Press', '360x10x3'].join('\n');
  const result = parseWorkoutText(input);
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent} (${result.message})`);
  assert.equal(result.canonical_name, 'Leg Press');
  assert.equal(result.sets.length, 3, 'x3 = 3 sets');
  assert.deepEqual(
    result.sets.map(s => [s.weight, s.reps]),
    [[360, 10], [360, 10], [360, 10]]
  );
  assert.notEqual(result.canonical_name, 'Back Squat', 'prose must not steal ownership');
});

test('substitution: exercise name only in prose paragraph + sets in next paragraph → needs_clarification (intentional safe failure)', () => {
  // Known limitation of the IS_PROSE heuristic: if the exercise name lives
  // only in a punctuated prose sentence ("Leg press today felt great.") and
  // the sets sit in a separate blank-line paragraph with no exercise header,
  // the prose paragraph is stripped and the exercise is lost. The result is
  // needs_clarification — no wrong row is written. This test pins that
  // behavior as intentional so a future change can't silently regress it to
  // logging the wrong lift.
  const input = ['Leg press today felt great.', '', '360 10/2 10/2 10/1'].join('\n');
  const result = parseWorkoutText(input);
  assert.notEqual(result.intent, 'log_sets', 'must not silently log a set with a missing exercise name');
  assert.ok(
    result.intent === 'needs_clarification' || result.intent === 'unknown',
    `expected needs_clarification or unknown, got: ${result.intent}`
  );
});

test('substitution: exercise header on its own paragraph still resolves when sets follow after blank line', () => {
  // "Leg Press\n\n360 10/2\n..." — header alone in first paragraph, sets in second.
  // extractSetParagraphs must keep the short header (no terminal punctuation) and
  // join it with the set paragraph rather than discarding it.
  const input = ['Leg Press', '', '360 10/2', '360 10/2', '360 10/1'].join('\n');
  const result = parseWorkoutText(input);
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent} (${result.message})`);
  assert.equal(result.canonical_name, 'Leg Press');
  assert.deepEqual(sets(result), [[360, 10, 2], [360, 10, 2], [360, 10, 1]]);
});

// ---------------------------------------------------------------------------
// Substitution wiring — skip-notation "prescribed" metadata
// ---------------------------------------------------------------------------

test('substitution wiring: deadlift skipped inline → RDL logged, prescribed extracted', () => {
  const result = parseWorkoutText('Deadlift skipped - platform busy. Romanian Deadlift 245lbs 7/2 x3');
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent}`);
  assert.equal(result.canonical_name, 'RDL');
  assert.deepEqual(sets(result), [[245, 7, 2], [245, 7, 2], [245, 7, 2]]);
  assert.notEqual(result.canonical_name, 'Deadlift', 'Deadlift must not be logged');
  assert.ok(Array.isArray(result.prescribed), 'prescribed should be present');
  assert.equal(result.prescribed.length, 1);
  assert.equal(result.prescribed[0].exercise, 'Deadlift');
  assert.equal(result.prescribed[0].reason, 'platform busy');
});

test('substitution wiring: back squat skipped inline → leg press logged, prescribed extracted', () => {
  const result = parseWorkoutText('Back Squat skipped - racks taken. Leg Press 360 10/2 x3');
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent}`);
  assert.equal(result.canonical_name, 'Leg Press');
  assert.notEqual(result.canonical_name, 'Back Squat', 'Back Squat must not be logged');
  assert.ok(Array.isArray(result.prescribed), 'prescribed should be present');
  assert.equal(result.prescribed[0].exercise, 'Back Squat');
  assert.equal(result.prescribed[0].reason, 'racks taken');
});

test('substitution wiring: plain RDL with no skip notation has no prescribed', () => {
  const result = parseWorkoutText('RDL 245 7/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.ok(!result.prescribed || result.prescribed.length === 0, 'prescribed must be absent for plain log');
});

test('substitution wiring: "Today I skipped deadlift" prose does not extract bogus prescribed name', () => {
  // Lead "Today I" contains no exercise → catalog guard rejects it → no prescribed.
  const result = parseWorkoutText('Today I skipped deadlift. RDL 245 7/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.ok(!result.prescribed || result.prescribed.length === 0, 'bogus prose lead must not produce prescribed');
});

test('substitution wiring: "Bench felt great so I skipped deadlift" must not extract Bench as prescribed', () => {
  // Lead "Bench felt great so I" contains Bench but has extra words after it.
  // The strict equality guard (lead must be exactly the exercise alias) rejects it.
  // Must not produce prescribed: Bench — safer to emit nothing.
  const result = parseWorkoutText('Bench felt great so I skipped deadlift. RDL 245 7/2 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.ok(!result.prescribed || result.prescribed.length === 0, 'exercise in prose lead must not produce prescribed');
});

// ---------------------------------------------------------------------------
// RDL normalization — singular AND plural forms resolve to canonical 'RDL'
// (owner live evidence: "RDLs" parsed as an unknown exercise → muscle group
// Unknown on save, because the parser's RDL alias list had no plural forms).
// ---------------------------------------------------------------------------

test('golden: RDL singular resolves to canonical RDL with no unknown_exercise warning', () => {
  const result = parseWorkoutText('RDL 225 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.equal(result.exercise, 'RDL');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'), 'RDL must be a known exercise');
  assert.ok(!result.needs_catalog_review, 'RDL must not be flagged for catalog review');
});

test('golden: RDLs plural normalizes to canonical RDL (no unknown_exercise / catalog review)', () => {
  const result = parseWorkoutText('RDLs 225 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL', 'the plural must normalize to the same canonical as the singular');
  assert.equal(result.exercise, 'RDL');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'),
    'the plural must not be treated as an unknown exercise (the muscle-group-Unknown repro)');
  assert.ok(!result.needs_catalog_review, 'the plural must not be flagged for catalog review');
  assert.deepEqual(sets(result), [[225, 8, 2]]);
});

test('golden: "Romanian Deadlifts" (full plural name) normalizes to canonical RDL', () => {
  const result = parseWorkoutText('Romanian Deadlifts 225 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'RDL');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'));
});

test('golden: lowercase "rdls" normalizes to canonical RDL', () => {
  const result = parseWorkoutText('rdls 225 8/2');
  assert.equal(result.canonical_name, 'RDL');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'));
});

test('golden: RDL plural aliases do not swallow plain Deadlift (no cross-contamination)', () => {
  // The 'romanian deadlift(s)' aliases are longer/more specific than 'deadlift',
  // so a plain Deadlift must never resolve to RDL.
  const dead = parseWorkoutText('Deadlift 315 5/2');
  assert.equal(dead.canonical_name, 'Deadlift', 'plain Deadlift must stay Deadlift, not RDL');
  const dl = parseWorkoutText('dl 315 5/2');
  assert.equal(dl.canonical_name, 'Deadlift', 'the "dl" alias must stay Deadlift, not RDL');
});

// ---------------------------------------------------------------------------
// Dumbbell / per-hand multi-group notation for Incline DB Press
// ---------------------------------------------------------------------------

test('dumbbell: multi-group slash notation — two weights, reps/RIR each, per-hand preserved', () => {
  // "incline 65s 8/2" → contextual alias stripped; 60s 10/3 and 65s 8/2 parsed
  // as separate per-hand dumbbell groups via parseDumbbellGroups.
  const result = parseWorkoutText('Incline DB Press 60s 10/3, incline 65s 8/2');
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent} (${result.message})`);
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.equal(result.sets.length, 2, 'two sets');
  assert.deepEqual(sets(result), [[60, 10, 3], [65, 8, 2]]);
  assert.ok(result.sets.every(s => s.load_note === 'per_hand'), 'load_note per_hand on all sets');
});

test('dumbbell: multi-group xREPS @RIR notation — two weights, per-hand preserved', () => {
  const result = parseWorkoutText('Incline dumbbell press 55s x10 @3, incline 60s x8 @2');
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent} (${result.message})`);
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.equal(result.sets.length, 2, 'two sets');
  assert.deepEqual(sets(result), [[55, 10, 3], [60, 8, 2]]);
  assert.ok(result.sets.every(s => s.load_note === 'per_hand'), 'load_note per_hand on all sets');
});

test('dumbbell: existing comma-list notation still works — no regression', () => {
  // parseDumbbellList handles "NNNs REPS,REPS,REPS" (no RIR); must still fire.
  const result = parseWorkoutText('Incline DB Press 65s 10,10,9');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(sets(result), [[65, 10, null], [65, 10, null], [65, 9, null]]);
});

test('dumbbell: existing single-weight xN repeat notation still works — no regression', () => {
  // parseDumbbellSlashRepeats handles the anchored "NNNs REPS/RIR xN" form.
  const result = parseWorkoutText('Incline DB Press 60s 10/2 x2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.equal(result.sets.length, 2, 'x2 = 2 total sets');
  assert.deepEqual(sets(result), [[60, 10, 2], [60, 10, 2]]);
});

test('dumbbell: contextual alias safety — "incline felt weird" must not create a log row', () => {
  // "incline" alone triggers the contextual alias path and asks for clarification,
  // not a log row.
  const result = parseWorkoutText('incline felt weird');
  assert.notEqual(result.intent, 'log_sets', 'must not log without set data');
  assert.equal(result.intent, 'needs_clarification');
});

// ---------------------------------------------------------------------------
// Reorder / coach-message safety — stale activeExercise must not propagate
// after the user sends a non-parse message (reorder, equipment note, question).
//
// Regression for: user logged Deadlift, then said "leg extension is taken,
// gonna do laterals first" (routed to coach → activeExercise cleared to null),
// then logged "15 12/2 x3" — which silently attached to Deadlift.
// ---------------------------------------------------------------------------

test('reorder safety: bare shorthand with no activeExercise context asks for clarification', () => {
  // Simulates the state AFTER a coach/reorder message cleared activeExercise.
  // The parser must refuse to guess rather than attach to a stale lift.
  const result = parseWorkoutText('15 12/2 x3', { activeExercise: null });
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('missing_exercise'), 'must warn missing_exercise');
  assert.match(result.message, /which exercise/i);
});

test('reorder safety: bare shorthand with no context never attaches to a previously logged exercise', () => {
  // The exact symptom: "15 12/2 x3" must not become Deadlift just because
  // Deadlift was logged earlier in the same session.
  const result = parseWorkoutText('15 12/2 x3');
  assert.notEqual(result.intent, 'log_sets', 'must not silently log without an exercise name');
  assert.equal(result.intent, 'needs_clarification');
});

test('reorder safety: continuation shorthand still works when activeExercise is correctly set', () => {
  // Existing happy-path behavior must not regress: after parsing "Deadlift 245 7/2 x3"
  // the frontend sets activeExercise = "Deadlift", and bare follow-ups must inherit it.
  const result = parseWorkoutText('15 12/2 x3', { activeExercise: 'Deadlift' });
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Deadlift');
  assert.deepEqual(result.sets.map(s => [s.weight, s.reps, s.rir]), [[15, 12, 2], [15, 12, 2], [15, 12, 2]]);
});

// ---------------------------------------------------------------------------
// Step 374 — Planned exercise names are always loggable.
//
// Any name Atlas can prescribe in a session plan must parse back to the same
// canonical name when the user logs it later.  These tests lock the round-trip
// so a plan-prescribed name never returns unknown_exercise.
// ---------------------------------------------------------------------------

test('step-374: Single-Leg Leg Curl resolves to its own canonical name — not to Leg Curl', () => {
  // Regression: previously the "leg curl" alias matched inside "single-leg leg curl"
  // via word-boundary regex, silently collapsing the name to "Leg Curl".  The plan
  // slot stayed remaining because the name never matched.
  const result = parseWorkoutText('Single-Leg Leg Curl 60 12/2');
  assert.equal(result.canonical_name, 'Single-Leg Leg Curl');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'), 'must not fire unknown_exercise');
  assert.deepEqual(sets(result), [[60, 12, 2]]);
});

// ---------------------------------------------------------------------------
// Bicep Curl recognition — BUG-20260629 live-test follow-up
//
// "bicep curls 30 12/2" parsed its SETS correctly but the exercise was flagged
// unknown_exercise (Bicep Curl was absent from EXERCISE_ALIASES), so the lifter
// got the "I don't recognize 'Bicep Curls'" advisory and it saved with muscle
// group Unknown. Added the explicit bicep forms. Bare "curl"/"curls" stays
// unaliased so unknown "X curl" lifts (Zercher/Jefferson) are still preserved.
// ---------------------------------------------------------------------------

test('bicep curls resolves to Bicep Curl (plural) and does not flag unknown_exercise', () => {
  const result = parseWorkoutText('bicep curls 30 12/2');
  assert.equal(result.canonical_name, 'Bicep Curl');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'), 'must not fire unknown_exercise');
  assert.deepEqual(sets(result), [[30, 12, 2]]);
});

test('bicep curl resolves to Bicep Curl (singular)', () => {
  const result = parseWorkoutText('bicep curl 30 12/2');
  assert.equal(result.canonical_name, 'Bicep Curl');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'));
  assert.deepEqual(sets(result), [[30, 12, 2]]);
});

test('biceps curls (with the "s") also resolves to Bicep Curl', () => {
  const result = parseWorkoutText('biceps curls 35 10/1 x3');
  assert.equal(result.canonical_name, 'Bicep Curl');
  assert.deepEqual(sets(result), [[35, 10, 1], [35, 10, 1], [35, 10, 1]]);
});

test('unknown "X curl" lifts (e.g. zercher curl) keep their typed name — bare curl is not aliased to Bicep Curl', () => {
  // Guard: an unknown "X curl" must keep its typed name. Bare curl/curls is
  // intentionally unaliased so Zercher/Jefferson Curl are not hijacked.
  const result = parseWorkoutText('zercher curl 40 10/2', { activeExercise: 'Bench Press' });
  assert.equal(result.canonical_name, 'Zercher Curl');
});

test('leg curls / hammer curls still win over the bicep forms (regression guard)', () => {
  assert.equal(parseWorkoutText('leg curls 60 12/2').canonical_name, 'Leg Curl');
  assert.equal(parseWorkoutText('hammer curls 35 10/2').canonical_name, 'Hammer Curl');
});

// ---------------------------------------------------------------------------
// Push-Up bodyweight parsing — BUG-20260629-002910/-003028/-003118/-003208
//
// "Push ups 40 40 40" was routing through parseUnknownExercise (Push-Up was not
// in EXERCISE_ALIASES), then parseDaleShorthand matched the rest as weight=40,
// reps=40, rir=40. rir=40 violated the bounds guard and rejected the ENTIRE
// session with a 400 — and repeat "Log it" calls kept reloading the bad row.
// ---------------------------------------------------------------------------

test('golden: Push-Up bare space-separated reps — the live-bug input', () => {
  // "Push ups 40 40 40" must parse as 3 × 40 bodyweight reps, NOT weight=40/reps=40/rir=40.
  const result = parseWorkoutText('Push ups 40 40 40');
  assert.equal(result.intent, 'log_sets', `expected log_sets, got: ${result.intent}`);
  assert.equal(result.canonical_name, 'Push-Up');
  assert.equal(result.sets.length, 3, 'three sets');
  assert.ok(result.sets.every(s => s.weight === null && s.weight_unit === null),
    'all sets must have null weight for bodyweight exercise');
  assert.deepEqual(result.sets.map(s => [s.reps, s.rir]), [[40, null], [40, null], [40, null]]);
});

test('golden: Push-Up aliases all resolve correctly', () => {
  const aliases = ['pushups', 'pushup', 'push-up', 'push-ups', 'push up', 'push ups', 'Push-Up'];
  for (const alias of aliases) {
    const result = parseWorkoutText(`${alias} 20 20 20`);
    assert.equal(result.intent, 'log_sets', `${alias}: expected log_sets`);
    assert.equal(result.canonical_name, 'Push-Up', `${alias}: expected Push-Up canonical`);
  }
});

test('golden: Push-Up x3 repeat format — bodyweight sets', () => {
  const result = parseWorkoutText('Push ups 20 x3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Push-Up');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(s => s.weight === null));
  assert.deepEqual(result.sets.map(s => [s.reps, s.rir]), [[20, null], [20, null], [20, null]]);
});

test('golden: Push-Up single bare rep — "push ups 20" logs one bodyweight set', () => {
  // BUG-20260629 "missed rows": a lone bare rep on an unambiguously-bodyweight lift
  // (Push-Up never carries load → 20 can only be reps) used to dead-end at
  // "missing sets" instead of logging one set.
  const result = parseWorkoutText('Push ups 20');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Push-Up');
  assert.equal(result.sets.length, 1);
  assert.equal(result.sets[0].weight, null);
  assert.deepEqual([result.sets[0].reps, result.sets[0].rir], [20, null]);
});

test('golden: multi-exercise paste with a trailing bare Push-Up rep keeps every row', () => {
  // The "missed rows" core: in a multi-exercise block the parse is all-clean-or-drop,
  // so a single unresolved segment used to discard the whole block. A bare Push-Up
  // rep must resolve so its weighted siblings are not lost.
  const result = parseWorkoutText('incline bench 95 10/2\ncable rows 80 12/2\noverhead press 65 8/2\npush ups 20');
  assert.equal(result.intent, 'log_sets_multi');
  assert.equal(result.exercises.length, 4);
  const names = result.exercises.map(e => e.canonical_name || e.exercise);
  assert.deepEqual(names, ['Incline Bench Press', 'Seated Row', 'Overhead Press', 'Push-Up']);
  const pushUp = result.exercises[3];
  assert.equal(pushUp.sets.length, 1);
  assert.deepEqual([pushUp.sets[0].weight, pushUp.sets[0].reps], [null, 20]);
});

test('golden: knee-raises bare numbers still clarify (ambiguity preserved, not auto-logged)', () => {
  // Guard the boundary of the fix: Hanging Knee Raises CAN be weighted, so a bare
  // number stays ambiguous (weight vs reps) and must keep asking — the Push-Up fix
  // must not leak into ambiguous-bodyweight lifts.
  const result = parseWorkoutText('Knee raises 15');
  assert.notEqual(result.intent, 'log_sets');
});

test('golden: Push-Up slash-pair format — bodyweight sets with RIR', () => {
  const result = parseWorkoutText('Push ups 15/1 12/2 10/3');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Push-Up');
  assert.equal(result.sets.length, 3);
  assert.ok(result.sets.every(s => s.weight === null));
  assert.deepEqual(result.sets.map(s => [s.reps, s.rir]), [[15, 1], [12, 2], [10, 3]]);
});

test('golden: parseBodyweightReps bare-tokens guard — integers >100 do not route to bodyweight path', () => {
  // Values > 100 exceed the reps plausibility range, so the bare-tokens branch is
  // skipped and the text falls through to parseDaleShorthand (weight/reps/rir path).
  // This guards against a 3-digit weight being silently dropped from the row.
  const result = parseWorkoutText('Push ups 150 150 150');
  // parseDaleShorthand interprets as weight=150, reps=150, rir=150 (all three match).
  // The server's bounds guard will reject reps=150, but the parser does not silence it.
  if (result.intent === 'log_sets') {
    // weight=150 means the bodyweight bare-tokens path was NOT taken — that is correct.
    const w = result.sets && result.sets[0] && result.sets[0].weight;
    assert.ok(w !== null, 'values >100 must not be interpreted as bodyweight reps (weight should not be null)');
  }
  // Either needs_clarification or log_sets with weight≠null is acceptable here.
  assert.ok(
    result.intent === 'needs_clarification' || (result.intent === 'log_sets' && result.sets[0].weight !== null),
    `must not produce log_sets with weight=null for values >100`
  );
});

test('golden: cable tricep pushdown — live-bug "tricep pulls" resolves correctly', () => {
  // BUG-20260629-003720: "Tricep pulls" fell through to parseUnknownExercise
  const result = parseWorkoutText('Tricep pulls 50 15/2');
  assert.equal(result.canonical_name, 'Cable Tricep Pushdown');
  assert.deepEqual(sets(result), [[50, 15, 2]]);
  assert.ok(!(result.warnings || []).includes('unknown_exercise'), 'must not be flagged as unknown');
});

test('golden: cable tricep pushdown — "tricep pushdowns" alias', () => {
  const result = parseWorkoutText('Tricep pushdowns 50 15/2 12/3');
  assert.equal(result.canonical_name, 'Cable Tricep Pushdown');
  assert.deepEqual(sets(result), [[50, 15, 2], [50, 12, 3]]);
});

test('golden: cable tricep pushdown — "cable tricep" shorthand', () => {
  const result = parseWorkoutText('Cable tricep 50 15/2 x3');
  assert.equal(result.canonical_name, 'Cable Tricep Pushdown');
  assert.deepEqual(sets(result), [[50, 15, 2], [50, 15, 2], [50, 15, 2]]);
});

test('golden: cable tricep pushdown — "tricep pulldowns" alias', () => {
  const result = parseWorkoutText('Tricep pulldowns 50 12/2');
  assert.equal(result.canonical_name, 'Cable Tricep Pushdown');
  assert.deepEqual(sets(result), [[50, 12, 2]]);
});

test('step-374: single leg leg curl (no hyphen) also resolves to Single-Leg Leg Curl', () => {
  const result = parseWorkoutText('single leg leg curl 55 10/2 x3');
  assert.equal(result.canonical_name, 'Single-Leg Leg Curl');
  assert.deepEqual(sets(result), [[55, 10, 2], [55, 10, 2], [55, 10, 2]]);
});

test('step-374: plain Leg Curl still resolves to Leg Curl (regression guard)', () => {
  const result = parseWorkoutText('Leg Curl 60 12/2');
  assert.equal(result.canonical_name, 'Leg Curl');
  assert.deepEqual(sets(result), [[60, 12, 2]]);
});

test('step-374: Leg Extension resolves to Leg Extension', () => {
  const result = parseWorkoutText('Leg Extension 70 15/2 x3');
  assert.equal(result.canonical_name, 'Leg Extension');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'));
  assert.deepEqual(sets(result), [[70, 15, 2], [70, 15, 2], [70, 15, 2]]);
});

test('step-374: leg ext shorthand resolves to Leg Extension', () => {
  const result = parseWorkoutText('leg ext 70 12/2');
  assert.equal(result.canonical_name, 'Leg Extension');
  assert.deepEqual(sets(result), [[70, 12, 2]]);
});

test('step-374: Pull-Up resolves to Pull-Up', () => {
  const result = parseWorkoutText('Pull-Up 25 5/2 x3');
  assert.equal(result.canonical_name, 'Pull-Up');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'));
  assert.deepEqual(sets(result), [[25, 5, 2], [25, 5, 2], [25, 5, 2]]);
});

test('step-374: pullup (no hyphen) resolves to Pull-Up', () => {
  const result = parseWorkoutText('pullup 25 5/2');
  assert.equal(result.canonical_name, 'Pull-Up');
  assert.deepEqual(sets(result), [[25, 5, 2]]);
});

test('step-374: Chin-Up resolves to Chin-Up', () => {
  const result = parseWorkoutText('Chin-Up 45 8/2');
  assert.equal(result.canonical_name, 'Chin-Up');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'));
  assert.deepEqual(sets(result), [[45, 8, 2]]);
});

test('step-374: Hip Thrust resolves to Hip Thrust', () => {
  const result = parseWorkoutText('Hip Thrust 135 10/2 x3');
  assert.equal(result.canonical_name, 'Hip Thrust');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'));
  assert.deepEqual(sets(result), [[135, 10, 2], [135, 10, 2], [135, 10, 2]]);
});

// ── AC8 phantom-set credibility floor (wired) ────────────────────────────────

test('AC8: the 2026-06-16 phantom-set bug — a question is not logged', () => {
  // "Didn't you suggest 225 5/2 x3" used to parse into a logged, celebrated set
  // named "Didnt You Suggest". It must now be a question, nothing logged.
  const result = parseWorkoutText("Didn't you suggest 225 5/2 x3");
  assert.equal(result.intent, 'question');
  assert.ok((result.warnings || []).includes('logged_nothing_question'));
  assert.notEqual(result.intent, 'log_sets');
});

test('AC8: a bare stat question logs nothing', () => {
  const result = parseWorkoutText('what should I bench today?');
  assert.equal(result.intent, 'question');
});

test('AC8: a real resolved set still logs (never suppressed)', () => {
  const result = parseWorkoutText('Bench 225 5/2');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(sets(result), [[225, 5, 2]]);
});

test('AC8: a resolved set that also asks a question still logs (both-case)', () => {
  // Resolved lift + set tokens wins over the question signal.
  const result = parseWorkoutText('Bench 235 8/2, should I go up?');
  assert.equal(result.intent, 'log_sets');
  assert.equal(result.canonical_name, 'Bench Press');
});

test('AC8: a bare past-tense log is not mistaken for a question', () => {
  // "did" must not trip the question guard — this is a continuation log.
  const result = parseWorkoutText('Squat 315 5/2', { activeExercise: 'Back Squat' });
  assert.equal(result.intent, 'log_sets');
});

test('AC8: a non-question unresolved lift keeps its existing flagged-log path', () => {
  // Rule (b) is intentionally NOT changed here: an unrecognised lift that is not
  // a question still logs as unknown_exercise for catalogue review (deferred).
  const result = parseWorkoutText('zercher thrust 95 8/2');
  assert.equal(result.intent, 'log_sets');
  assert.ok((result.warnings || []).includes('unknown_exercise'));
});

// ---------------------------------------------------------------------------
// Feedback-vs-log classification (2026-06-21 live failure)
//
// Natural-language coaching feedback must NOT be coined into a phantom exercise.
// Live bug: "I don't want to do 11 reps on a workout like seated rows 10/2..."
// was logged as an exercise named "I Don't Want To Do" (0×10). A conversational
// lead (pronouns/negations/verbs, or an overly long phrase) must not log_sets;
// it falls through to a coach question instead. Legit unknown lifts still parse.
// ---------------------------------------------------------------------------

test('feedback: "I don\'t want to do 11 reps..." does not produce a phantom log', () => {
  const result = parseWorkoutText("I don't want to do 11 reps on a workout like seated rows 10/2 across all sets then we should move up after thats proven");
  assert.notEqual(result.intent, 'log_sets', `coaching feedback must not log_sets, got: ${result.intent}`);
  assert.ok(!Array.isArray(result.sets) || result.sets.length === 0, 'no set rows from a feedback sentence');
});

test('feedback: a "we should..." preference sentence does not log', () => {
  const result = parseWorkoutText('we should move up after thats proven 10/2');
  assert.notEqual(result.intent, 'log_sets');
});

test('feedback: an unknown lead that reads as prose creates no 0-weight phantom exercise', () => {
  const result = parseWorkoutText("i think my form felt off 8/2");
  assert.notEqual(result.intent, 'log_sets');
  assert.ok(!Array.isArray(result.sets) || result.sets.length === 0);
});

test('feedback guard does NOT block a genuine unknown lift (short noun-phrase name)', () => {
  // Jefferson Curl isn't in the catalog but is a real lift typed as "name + sets".
  const result = parseWorkoutText('Jefferson Curl 95 8/2');
  assert.equal(result.intent, 'log_sets', `a real unknown lift must still log, got: ${result.intent}`);
});

test('feedback guard does NOT block known logging language', () => {
  assert.equal(parseWorkoutText('Bench 140 15/4 230 4/2').intent, 'log_sets');
  assert.equal(parseWorkoutText('Seated rows 190 11/2 11/2 11/2').intent, 'log_sets');
});

// Live bug (2026-07-06 flight test): "Curls I did 35 12/2 x3 actually" fell through
// to needs_clarification / missing_exercise — the conversational filler ("I did")
// BETWEEN a real (unknown/unaliased) lift name and its sets tripped the prose guard,
// so nothing logged and Dale marked "Bugging out here". Interposed/trailing filler
// around a genuine leading name must not block the log; the prose guard must still
// bail on a lead that is only conversation.
test('feedback: interposed filler between an unknown lift name and its sets still logs', () => {
  const result = parseWorkoutText('Curls I did 35 12/2 x3');
  assert.equal(result.intent, 'log_sets', `got: ${result.intent}`);
  assert.equal(result.canonical_name, 'Curls');
  assert.deepEqual(sets(result), [[35, 12, 2], [35, 12, 2], [35, 12, 2]]);
});

test('feedback: trailing filler after an unknown lift log still logs', () => {
  const result = parseWorkoutText('Curls I did 35 12/2 x3 actually');
  assert.equal(result.intent, 'log_sets', `got: ${result.intent}`);
  assert.equal(result.canonical_name, 'Curls');
  assert.deepEqual(sets(result), [[35, 12, 2], [35, 12, 2], [35, 12, 2]]);
});

test('feedback: filler-stripping still bails when the lead is only conversation', () => {
  // The trailing/interposed strip must NOT rescue a pure-prose lead into a phantom lift.
  assert.notEqual(parseWorkoutText('I did 205 5/3').intent, 'log_sets');
  assert.notEqual(parseWorkoutText("i think my form felt off 8/2").intent, 'log_sets');
});

// ---------------------------------------------------------------------------
// Bare-set attachment to the current planned lift (2026-06-21 live failure)
//
// When a planned workout is open, a bare set sequence with NO exercise name
// should attach to the current/next planned lift (passed as context.activeExercise
// by the app). Without any lift context it must still ask for clarification — and
// never coin a phantom lift.
// ---------------------------------------------------------------------------

test('bare set sequence attaches to the lift in context.activeExercise', () => {
  const r = parseWorkoutText('140 15 230 4/2 4/1 3/1', { activeExercise: 'Bench Press' });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.exercise, 'Bench Press');
});

test('bare set sequence with NO lift context asks for clarification (no phantom lift)', () => {
  const r = parseWorkoutText('140 15 230 4/2 4/1 3/1');
  assert.notEqual(r.intent, 'log_sets', 'must not log without a lift');
  assert.ok(!Array.isArray(r.sets) || r.sets.length === 0 || r.intent === 'needs_clarification');
});

// ---------------------------------------------------------------------------
// Composer placeholder is parse-safe and warm-up-safe if submitted
//
// The compact placeholder marks warm-ups with a "wu" suffix. If the lifter submits
// the whole hint, the "{w}x{r}wu" tokens are NOT valid sets, so the parser logs
// ONLY the working sets — warm-ups never become save-ready. Aliases parse too.
// ---------------------------------------------------------------------------

test('submitting the compact placeholder logs only working sets (wu warm-ups dropped)', () => {
  const r = parseWorkoutText('Bench 140x15wu 190x10wu 230 5/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.exercise, 'Bench Press', 'the "Bench" alias resolves to Bench Press');
  assert.equal(r.sets.length, 3, 'only the 3 working sets log; the 2 wu warm-ups are not save-ready');
  for (const s of r.sets) { assert.equal(s.weight, 230); assert.equal(s.reps, 5); assert.equal(s.rir, 2); }
});

test('a bare "{w}x{r}wu" warm-up token alone is not a loggable set', () => {
  assert.notEqual(parseWorkoutText('140x15wu').intent, 'log_sets');
});

test('a no-RIR placeholder uses a single "{weight} {reps}" token that parses (no fragile xN)', () => {
  // compactPrescription's RIR-less fallback must emit "Bench 230 5", not the
  // non-round-tripping "Bench 230 5 x3" — so the displayed hint never misleads.
  const r = parseWorkoutText('Bench 230 5');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.sets.length, 1);
  assert.equal(r.sets[0].weight, 230);
  assert.equal(r.sets[0].reps, 5);
});

// ---------------------------------------------------------------------------
// Mixed bare-pair + slash notation in one lift log (owner-approved, 2026-06-21)
//
// Warm-up climb written as bare "{weight} {reps}" pairs, then slash working sets
// for the same lift: "Bench 140 15 190 10 230 4/2 4/1 3/1" → 5 sets. The bare
// pairs must NOT mis-segment, and all existing notations must still parse.
// ---------------------------------------------------------------------------

test('mixed: bare warm-up pairs + slash working sets parse as all 5 sets', () => {
  assert.deepEqual(sets(parseWorkoutText('Bench 140 15 190 10 230 4/2 4/1 3/1')), [
    [140, 15, null],
    [190, 10, null],
    [230, 4, 2],
    [230, 4, 1],
    [230, 3, 1],
  ]);
});

test('mixed: same format attaches to the planned lift when the name is omitted', () => {
  const r = parseWorkoutText('140 15 190 10 230 4/2 4/1 3/1', { activeExercise: 'Bench Press' });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.exercise, 'Bench Press');
  assert.deepEqual(r.sets.map(s => [s.weight, s.reps, s.rir]), [
    [140, 15, null], [190, 10, null], [230, 4, 2], [230, 4, 1], [230, 3, 1],
  ]);
});

test('mixed: consecutive bare pairs do NOT mis-segment ("140 15 190 10" is two sets)', () => {
  assert.deepEqual(sets(parseWorkoutText('Bench 140 15 190 10')), [[140, 15, null], [190, 10, null]]);
});

test('mixed: a single space-separated "{weight} {reps} {rir}" set is unchanged', () => {
  // The whole-text single-set rule must still claim "225 5 2" (one set @RIR 2),
  // not split it into a bare pair that drops the RIR.
  assert.deepEqual(sets(parseWorkoutText('Bench 225 5 2')), [[225, 5, 2]]);
  assert.deepEqual(sets(parseWorkoutText('Bench 185 8')), [[185, 8, null]]);
});

test('mixed: slash-only and xN repeats still parse exactly as before', () => {
  assert.deepEqual(sets(parseWorkoutText('Bench 230 5/2 5/2 5/2')), [[230, 5, 2], [230, 5, 2], [230, 5, 2]]);
  assert.deepEqual(sets(parseWorkoutText('Lat pulldown 170 8/2 x3')), [[170, 8, 2], [170, 8, 2], [170, 8, 2]]);
});

test('mixed: bare-pair support does not turn prose into a log', () => {
  const r = parseWorkoutText('we should move up to 10 reps after 8 felt easy');
  assert.notEqual(r.intent, 'log_sets');
});

// ---------------------------------------------------------------------------
// Added-load bodyweight (486 slice 2b) — "+NN" external load reads as Weight,
// the movement name is unchanged, reps/RIR/xN parse exactly like normal slash.
// ---------------------------------------------------------------------------

test('added-load: "Dips +25 8/2" → Weighted Dips, +25 is the weight', () => {
  const r = parseWorkoutText('Dips +25 8/2');
  assert.equal(r.canonical_name, 'Dips (Weighted)');
  assert.deepEqual(sets(r), [[25, 8, 2]]);
});

test('added-load: "Weighted dips +50 10/2 x3" → 3 sets, +50 weight, xN expands', () => {
  const r = parseWorkoutText('Weighted dips +50 10/2 x3');
  assert.equal(r.canonical_name, 'Dips (Weighted)');
  assert.deepEqual(sets(r), [[50, 10, 2], [50, 10, 2], [50, 10, 2]]);
});

test('added-load: "Pull-ups +25 6/2" → Pull-Up, +25 weight', () => {
  const r = parseWorkoutText('Pull-ups +25 6/2');
  assert.equal(r.canonical_name, 'Pull-Up');
  assert.deepEqual(sets(r), [[25, 6, 2]]);
});

test('added-load: "Chin-ups +10 8/2" → Chin-Up, +10 weight', () => {
  const r = parseWorkoutText('Chin-ups +10 8/2');
  assert.equal(r.canonical_name, 'Chin-Up');
  assert.deepEqual(sets(r), [[10, 8, 2]]);
});

test('added-load: a normal weighted lift is unchanged — "Bench 225 5/2 x3"', () => {
  // No "+" present → the strip is a no-op; behaviour is byte-identical to before.
  assert.deepEqual(sets(parseWorkoutText('Bench 225 5/2 x3')), [[225, 5, 2], [225, 5, 2], [225, 5, 2]]);
});

test('added-load: modality inputs stay NON-slash (parser does not claim them)', () => {
  // The slash/resistance parser must NOT log these — they are modality inputs,
  // recognized additively by services/multiModalityParser.js, not here.
  assert.notEqual(parseWorkoutText('Plank 60 sec x3').intent, 'log_sets');
  assert.notEqual(parseWorkoutText('Elliptical 30 min').intent, 'log_sets');
});

test('added-load: a "+" wedged between digits is NOT stripped (no silent concatenation)', () => {
  // The strip is anchored to a token-leading "+"; "225+25" must never become
  // "22525". Not a current notation — this guards the anchoring so a future
  // weight+addedload style can't be silently mis-parsed into a bogus weight.
  const r = parseWorkoutText('Bench 225+25 5/2');
  if (r.intent === 'log_sets') {
    assert.ok(!r.sets.some(s => s.weight === 22525), 'must never concatenate into 22525');
  }
});

// ---------------------------------------------------------------------------
// Bodyweight dips (Fix B) — bare dips logs as bodyweight; weighted dips preserved.
// ---------------------------------------------------------------------------

test('bodyweight dips: "Dips 10/2 x3" → bodyweight Dips, weight null, 3 sets', () => {
  const r = parseWorkoutText('Dips 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips', 'bare dips is bodyweight Dips, NOT Dips (Weighted)');
  assert.equal(r.sets.length, 3);
  assert.ok(r.sets.every(s => s.weight === null), 'bodyweight → no weight');
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2], [10, 2], [10, 2]]);
});

test('bodyweight dips: "Dip 10/2 x3" (singular alias) also bodyweight', () => {
  const r = parseWorkoutText('Dip 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips');
  assert.ok(r.sets.every(s => s.weight === null));
});

test('bodyweight dips: weighted dips are UNCHANGED — added load still wins', () => {
  // The fix must not regress the added-load path (PR 486 slice 2b).
  const w1 = parseWorkoutText('Dips +25 8/2');
  assert.equal(w1.canonical_name, 'Dips (Weighted)');
  assert.deepEqual(w1.sets.map(s => [s.weight, s.reps, s.rir]), [[25, 8, 2]]);
  const w2 = parseWorkoutText('Weighted dips +50 10/2 x3');
  assert.equal(w2.canonical_name, 'Dips (Weighted)');
  assert.deepEqual(w2.sets.map(s => [s.weight, s.reps, s.rir]), [[50, 10, 2], [50, 10, 2], [50, 10, 2]]);
});

test('bodyweight dips: a multi-line session mixes bodyweight and weighted dips correctly', () => {
  // Each line parses independently (one exercise per line). Bodyweight dips → Dips
  // (weight null); a weighted lift on its own line is unchanged.
  const bw = parseWorkoutText('Dips 10/2 x3');
  const wt = parseWorkoutText('Dips +25 8/2');
  const bench = parseWorkoutText('Bench 225 5/2 x3');
  assert.equal(bw.canonical_name, 'Dips');
  assert.ok(bw.sets.every(s => s.weight === null));
  assert.equal(wt.canonical_name, 'Dips (Weighted)');
  assert.equal(wt.sets[0].weight, 25);
  assert.equal(bench.canonical_name, 'Bench Press');
});

// ---------------------------------------------------------------------------
// Seated Row plural aliases — BUG-20260629 (multiline freestyle "seated rows").
// "seated row" already resolved; the plural "seated rows" fell through to an
// unknown "Seated Rows" and got absorbed into the prior lift in a multi-entry.
// ---------------------------------------------------------------------------

test('seated rows (plural) resolves to Seated Row', () => {
  const result = parseWorkoutText('seated rows 95 10/2');
  assert.equal(result.canonical_name, 'Seated Row');
  assert.ok(!(result.warnings || []).includes('unknown_exercise'), 'must not flag unknown_exercise');
  assert.deepEqual(sets(result), [[95, 10, 2]]);
});

test('seated row (singular) still resolves to Seated Row (regression)', () => {
  const result = parseWorkoutText('seated row 95 10/2');
  assert.equal(result.canonical_name, 'Seated Row');
  assert.deepEqual(sets(result), [[95, 10, 2]]);
});

test('cable rows / machine rows (plural) resolve to Seated Row', () => {
  assert.equal(parseWorkoutText('cable rows 80 12/2').canonical_name, 'Seated Row');
  assert.equal(parseWorkoutText('machine rows 120 10/1').canonical_name, 'Seated Row');
});

test('bare "rows" stays ambiguous — asks which row, never silently picks one', () => {
  const result = parseWorkoutText('rows 95 10/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.match(result.message, /which row/i);
});

// ---------------------------------------------------------------------------
// Weight-unit normalization (owner decision 2026-07-04): the log stores POUNDS
// only. kg is converted to lb on input; redundant lb/# markers are stripped.
// ---------------------------------------------------------------------------

test('unit: kilograms convert to pounds (100kg → 220.5 lb)', () => {
  // 100 * 2.20462 = 220.462 → rounded to 0.1 lb = 220.5
  const result = parseWorkoutText('Bench 100kg 5/2');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(sets(result), [[220.5, 5, 2]]);
  assert.equal(result.sets[0].weight_unit, 'lb'); // stored unit is always lb
});

test('unit: kg accepts spaced, plural, and decimal forms', () => {
  assert.deepEqual(sets(parseWorkoutText('Deadlift 180 kg 3/2')), [[396.8, 3, 2]]); // 180kg
  assert.deepEqual(sets(parseWorkoutText('Bench 100kgs 5/2')), [[220.5, 5, 2]]);    // plural
  assert.deepEqual(sets(parseWorkoutText('Curl 20kg 12/2')), [[44.1, 12, 2]]);      // light
});

test('unit: multi-set kg converts every set independently', () => {
  // 100kg → 220.5, 90kg → 198.4
  assert.deepEqual(sets(parseWorkoutText('Bench 100kg 5/2 90kg 5/2')), [[220.5, 5, 2], [198.4, 5, 2]]);
});

test('unit: explicit pound markers (lb, lbs, spaced, #) are stripped, number kept', () => {
  const expected = [[225, 5, 2]];
  assert.deepEqual(sets(parseWorkoutText('Bench 225lb 5/2')), expected);   // glued
  assert.deepEqual(sets(parseWorkoutText('Bench 225lbs 5/2')), expected);  // plural
  assert.deepEqual(sets(parseWorkoutText('Bench 225 lb 5/2')), expected);  // spaced (was dropped pre-fix)
  assert.deepEqual(sets(parseWorkoutText('Bench 225# 5/2')), expected);    // hash
  assert.deepEqual(sets(parseWorkoutText('Bench 225 # 5/2')), expected);   // spaced hash
});

test('unit: kg converts on the multi-line rescue path (one exercise per line)', () => {
  // The multi-line paste dead-ends the single-blob parse and re-parses per line;
  // that path must also see converted units (regression: it previously used raw input).
  const result = parseWorkoutText('Bench 100kg 5/2\nSquat 140kg 5/2');
  assert.equal(result.intent, 'log_sets_multi');
  assert.deepEqual(result.exercises.map(e => e.canonical_name), ['Bench Press', 'Back Squat']);
  assert.deepEqual(result.exercises[0].sets.map(s => [s.weight, s.reps, s.rir]), [[220.5, 5, 2]]);
  assert.deepEqual(result.exercises[1].sets.map(s => [s.weight, s.reps, s.rir]), [[308.6, 5, 2]]);
});

test('unit: a number-adjacent hashtag is left intact (# strip is pounds-only)', () => {
  // "225#" is pounds; "#pr" is a tag — the strip must not fuse the number into the tag.
  const result = parseWorkoutText('Bench 225 5/2 #pr');
  assert.deepEqual(sets(result), [[225, 5, 2]]);
  // Numeric tag: stripping "2 #" would corrupt the RIR (5/2 → 5/21). Must stay 5/2.
  assert.deepEqual(sets(parseWorkoutText('Bench 225 5/2 #1')), [[225, 5, 2]]);
  assert.deepEqual(sets(parseWorkoutText('Bench 225 5/2 #3')), [[225, 5, 2]]);
  // Genuine bare-pound markers still strip.
  assert.deepEqual(sets(parseWorkoutText('Bench 225# 5/2')), [[225, 5, 2]]);
});

test('unit: normalization does NOT disturb dumbbell "s" notation or bare numbers', () => {
  // "60s" is dumbbell 60/hand — must stay 60, not be treated as a pound marker.
  assert.deepEqual(sets(parseWorkoutText('Bench 60s 10/3')), [[60, 10, 3]]);
  assert.deepEqual(sets(parseWorkoutText('Bench 60s 10/3 65s 8/2')), [[60, 10, 3], [65, 8, 2]]);
  // bare lb number unchanged
  assert.deepEqual(sets(parseWorkoutText('Bench 225 5/2')), [[225, 5, 2]]);
});

// ---------------------------------------------------------------------------
// PR-06 — parser (source A) canonicals are FROZEN and unchanged by the
// exercise-truth reconciliation.
//
// PR-06 reconciled the catalog + coaching JSON to Dale's history convention but
// changed NO parser code (INVARIANT P2). These pins prove the parser's user-facing
// canonical output for the reconciled/anchored alias families is exactly what it was
// before — the parser is the history anchor the JSON was aligned to. If a future PR
// (PR-14) regenerates the parser table from the catalog, these must still hold or be
// updated deliberately alongside the audit allowlist.
// ---------------------------------------------------------------------------

test('golden PR-06: reconciled aliases still resolve to the frozen parser canonical', () => {
  const cases = [
    ['cable row 100 10/2', 'Seated Row'],
    ['machine row 100 10/2', 'Seated Row'],
    ['seated row 100 10/2', 'Seated Row'],
    ['leg curl 100 10/2', 'Leg Curl'],
    ['hamstring curl 100 10/2', 'Leg Curl'],
    ['tricep pushdown 50 12/1', 'Cable Tricep Pushdown'],
    ['rdl 225 8/2', 'RDL'],
    ['romanian deadlift 225 8/2', 'RDL'],
    ['deadlift 315 5/2', 'Deadlift'],
    ['dips 45 8/1', 'Dips (Weighted)'],
    ['weighted dips 45 8/1', 'Dips (Weighted)'],
    ['hanging knee raises 0 12/1', 'Hanging Knee Raises'],
    ['lateral raise 20 15/1', 'Lateral Raises'],
    ['laterals 20 15/1', 'Lateral Raises'],
    ['incline db press 70 8/2', 'Incline DB Press'],
    ['barbell shrugs 225 12/1', 'Shrug'],
    ['bent over row 185 8/2', 'Bent-Over Row'],
  ];
  for (const [text, expected] of cases) {
    const r = parseWorkoutText(text);
    assert.equal(r.canonical_name, expected, `"${text}" → ${r.canonical_name} (expected ${expected})`);
  }
});

// ---------------------------------------------------------------------------
// PARSE-1 (audit 2026-07-07) — a variant qualifier before a base-lift alias must
// NOT silently collapse to the base lift. `front squat` is not `Back Squat`.
// findExerciseInText's anywhere-match used to discard the leading qualifier; the
// fix rejects an anywhere-match when a name-like word immediately precedes the
// alias, so the input falls to the unknown-exercise path (typed name preserved,
// needs_catalog_review) instead of corrupting the wrong lift's history.
// ---------------------------------------------------------------------------

test('PARSE-1: variant qualifiers do not collapse to the base lift (never silent)', () => {
  const bases = ['Back Squat', 'Bench Press', 'Deadlift'];
  const cases = [
    ['front squat 225 5/2', /front squat/i],
    ['goblet squats 60 12/2 x3', /goblet squat/i],
    ['close grip bench 185 8/2', /close grip bench/i],
    ['stiff leg deadlift 275 8/2', /stiff leg deadlift/i],
  ];
  for (const [text, namePattern] of cases) {
    const r = parseWorkoutText(text);
    // Never the silent base lift.
    assert.ok(!bases.includes(r.canonical_name),
      `"${text}" must not collapse to a base lift — got ${r.canonical_name}`);
    if (r.intent === 'log_sets') {
      // Unknown-exercise path: the typed variant name is preserved and flagged.
      assert.match(r.canonical_name, namePattern,
        `"${text}" should preserve the typed variant name — got ${r.canonical_name}`);
      assert.ok((r.warnings || []).includes('unknown_exercise'),
        `"${text}" should carry the unknown_exercise warning`);
      assert.equal(r.needs_catalog_review, true,
        `"${text}" should be flagged needs_catalog_review`);
    } else {
      // A clarification ask is also acceptable — anything but a silent base-lift log.
      assert.equal(r.intent, 'needs_clarification',
        `"${text}" must be unknown-exercise or a clarification, got ${r.intent}`);
    }
  }
});

test('PARSE-1: front squat preserves its sets on the unknown-exercise path', () => {
  const r = parseWorkoutText('front squat 225 5/2');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Front Squat');
  assert.deepEqual(sets(r), [[225, 5, 2]]);
  assert.equal(r.needs_catalog_review, true);
});

test('PARSE-1 guard: legitimate mid-text + at-start matches still resolve (no over-rejection)', () => {
  // Continuation/filler words before an alias are NOT variant qualifiers — keep resolving.
  assert.equal(parseWorkoutText('then bench 185 5/2').canonical_name, 'Bench Press');
  assert.equal(parseWorkoutText('did squat 315 5/1').canonical_name, 'Back Squat');
  assert.equal(parseWorkoutText('today bench 185 5/2').canonical_name, 'Bench Press');
  // At-start base-lift logging is untouched.
  assert.equal(parseWorkoutText('bench 185 5/2').canonical_name, 'Bench Press');
  assert.equal(parseWorkoutText('squat 315 5/1').canonical_name, 'Back Squat');
  // Registered compound aliases (at-start) still win over the bare base.
  assert.equal(parseWorkoutText('incline bench 185 8/2').canonical_name, 'Incline Bench Press');
  assert.equal(parseWorkoutText('bent over row 185 8/2').canonical_name, 'Bent-Over Row');
});
