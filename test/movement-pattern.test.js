'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { patternFor, VALID_PATTERNS } = require('../services/movementPattern');

// Full catalog fixture (from COACH_PLAN.md §PR 1.3).
// Each entry is [liftName, expectedPattern].
// Hand-computed — not generated from the module under test.
const FIXTURES = [
  // === COMPOUND — squat pattern ===
  ['Back Squat',           'squat'],
  ['Leg Press',            'squat'],
  ['Linear Leg Press',     'squat'],
  ['Seated Leg Press',     'squat'],
  ['Single-Leg Leg Press', 'squat'],

  // === COMPOUND — hinge pattern ===
  ['Deadlift',             'hinge'],
  ['Romanian Deadlift',    'hinge'],

  // === COMPOUND — horizontal push ===
  ['Bench Press',          'horizontal_push'],
  ['Machine Bench Press',  'horizontal_push'],
  ['Incline DB Press',     'horizontal_push'],
  ['Incline Dumbbell Press', 'horizontal_push'],
  ['Dips',                 'horizontal_push'],
  ['Weighted Dips',        'horizontal_push'],
  ['Cable Crossover',      'horizontal_push'],

  // === COMPOUND — vertical push ===
  ['Overhead Press',       'vertical_push'],

  // === COMPOUND — horizontal pull ===
  ['Barbell Row',          'horizontal_pull'],
  ['Bent Over Row',        'horizontal_pull'],
  ['Reverse Bent Over Row', 'horizontal_pull'],
  ['Seated Row',           'horizontal_pull'],

  // === COMPOUND — vertical pull ===
  ['Lat Pulldown',         'vertical_pull'],

  // === ISOLATION — knee ===
  ['Leg Curl',             'knee_isolation'],
  ['Single-Leg Leg Curl',  'knee_isolation'],
  ['Leg Extension',        'knee_isolation'],

  // === ISOLATION — delt ===
  ['Face Pull',            'delt_isolation'],
  ['Lateral Raise',        'delt_isolation'],
  ['Lateral Raises',       'delt_isolation'],

  // === ISOLATION — arm ===
  ['Dumbbell Curl',        'arm_isolation'],
  ['Hammer Curls',         'arm_isolation'],

  // === TRUNK ===
  ['Dumbbell Side Bend',   'trunk'],
  ['Hanging Knee Raises',  'trunk'],

  // === OTHER (no clean category) ===
  ['Shrugs',               'other'],
];

/* ===== structural guarantees ===== */

test('every fixture lift returns a pattern that is in VALID_PATTERNS', () => {
  for (const [lift, _expected] of FIXTURES) {
    const { pattern, needsReview } = patternFor(lift);
    assert.ok(
      VALID_PATTERNS.has(pattern),
      `${lift}: "${pattern}" is not in VALID_PATTERNS`
    );
    assert.equal(needsReview, false, `${lift}: expected needsReview=false`);
  }
});

test('every fixture matches its expected pattern (golden fixtures)', () => {
  for (const [lift, expected] of FIXTURES) {
    const { pattern } = patternFor(lift);
    assert.equal(
      pattern, expected,
      `${lift}: expected ${expected}, got ${pattern}`
    );
  }
});

/* ===== required spot-checks from COACH_PLAN.md ===== */

test('Bench Press = horizontal_push', () => {
  assert.equal(patternFor('Bench Press').pattern, 'horizontal_push');
});

test('Overhead Press = vertical_push', () => {
  assert.equal(patternFor('Overhead Press').pattern, 'vertical_push');
});

test('Barbell Row = horizontal_pull', () => {
  assert.equal(patternFor('Barbell Row').pattern, 'horizontal_pull');
});

test('Lat Pulldown = vertical_pull', () => {
  assert.equal(patternFor('Lat Pulldown').pattern, 'vertical_pull');
});

test('Back Squat = squat', () => {
  assert.equal(patternFor('Back Squat').pattern, 'squat');
});

test('Romanian Deadlift = hinge', () => {
  assert.equal(patternFor('Romanian Deadlift').pattern, 'hinge');
});

/* ===== unknown / edge cases ===== */

test('unknown lift returns needsReview=true with pattern=other', () => {
  const result = patternFor('Sled Push');
  assert.equal(result.needsReview, true);
  assert.equal(result.pattern, 'other');
});

test('empty string returns needsReview=true', () => {
  assert.equal(patternFor('').needsReview, true);
});

test('null / undefined input returns needsReview=true', () => {
  assert.equal(patternFor(null).needsReview, true);
  assert.equal(patternFor(undefined).needsReview, true);
});

/* ===== disambiguation — specificity matters ===== */

test('Deadlift ≠ Romanian Deadlift: standard deadlift = hinge', () => {
  assert.equal(patternFor('Deadlift').pattern, 'hinge');
  assert.equal(patternFor('Romanian Deadlift').pattern, 'hinge');
  // Both are hinge — the disambiguation matters for cost tier (PR 3.x), not pattern
});

test('Leg Curl is knee_isolation, not matched by generic curl rule', () => {
  assert.equal(patternFor('Leg Curl').pattern, 'knee_isolation');
  assert.equal(patternFor('Single-Leg Leg Curl').pattern, 'knee_isolation');
});

test('Lat Pulldown is vertical_pull, not confused with lateral raise', () => {
  assert.equal(patternFor('Lat Pulldown').pattern, 'vertical_pull');
  assert.equal(patternFor('Lateral Raise').pattern, 'delt_isolation');
});

test('Dips are horizontal_push (bench family), not vertical_push', () => {
  assert.equal(patternFor('Dips').pattern, 'horizontal_push');
  assert.equal(patternFor('Weighted Dips').pattern, 'horizontal_push');
});

test('Hanging Knee Raises = trunk', () => {
  assert.equal(patternFor('Hanging Knee Raises').pattern, 'trunk');
});

test('Dumbbell Side Bend = trunk', () => {
  assert.equal(patternFor('Dumbbell Side Bend').pattern, 'trunk');
});

test('Hammer Curls (plural) = arm_isolation', () => {
  assert.equal(patternFor('Hammer Curls').pattern, 'arm_isolation');
});

test('Lateral Raises (plural) = delt_isolation', () => {
  assert.equal(patternFor('Lateral Raises').pattern, 'delt_isolation');
});

/* ===== VALID_PATTERNS export ===== */

test('VALID_PATTERNS contains all 14 expected patterns', () => {
  const expected = [
    'squat', 'hinge', 'horizontal_push', 'vertical_push',
    'horizontal_pull', 'vertical_pull',
    'knee_isolation', 'hip_isolation', 'arm_isolation',
    'delt_isolation', 'calf_isolation', 'trunk', 'carry', 'other',
  ];
  for (const p of expected) {
    assert.ok(VALID_PATTERNS.has(p), `VALID_PATTERNS missing "${p}"`);
  }
  assert.equal(VALID_PATTERNS.size, 14);
});
