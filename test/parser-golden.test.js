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

test('golden: incline DB — x2 means two total instances of the last set', () => {
  // x2 after a set means that set appears twice in total (one already logged + one copy)
  const result = parseWorkoutText('Incline db 60 10/2 70 8/2 x2');
  assert.equal(result.canonical_name, 'Incline DB Press');
  assert.deepEqual(sets(result), [[60, 10, 2], [70, 8, 2], [70, 8, 2]]);
  assert.equal(result.sets.length, 3, 'x2 = 2 total, so one original + one copy = 3 sets total');
});

test('golden: lats x3 repeat shorthand — three total sets', () => {
  const result = parseWorkoutText('Lats 170 8/2 x3');
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

test('golden: Lats 170 8/2 x99 — xN above cap is rejected', () => {
  // parseDaleShorthand returns null when xN > 10; the whole input clarifies.
  const result = parseWorkoutText('Lats 170 8/2 x99');
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
      input: 'lat pull 170 10/2 175 8/2 8/1',
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
    'lat pull 170 10/2 175 8/2 8/1',
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
