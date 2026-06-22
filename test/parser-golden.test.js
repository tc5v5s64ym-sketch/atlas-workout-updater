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

test('golden: mixed exercises in one input are blocked', () => {
  // Two distinct canonicalized exercises detected → clarification required.
  // Prevents silent mixing of bench and squat rows.
  const result = parseWorkoutText('Bench 225 5/2 squats 185 5/2');
  assert.equal(result.intent, 'needs_clarification');
  assert.ok(result.warnings.includes('multiple_exercises_in_input'));
  assert.match(result.message, /mixed exercise/i);
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
