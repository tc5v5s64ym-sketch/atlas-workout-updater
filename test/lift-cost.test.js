'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { costFor, COST_TIERS } = require('../services/liftCost');

// Golden fixtures — hand-computed from SESSION_DESIGN.md Rule A cost tiers.
// HIGH: Deadlift, Back Squat, RDL, heavy Barbell/Bent-Over Row.
// MEDIUM: Bench, OHP, Seated Row, Lat Pulldown, Leg Press family, Incline DB, Dips.
// LOW: all isolation / accessories.
const FIXTURES = [
  // ── HIGH ──────────────────────────────────────────────────────────────
  ['Deadlift',              'high'],
  ['Romanian Deadlift',     'high'],
  ['Back Squat',            'high'],
  ['Barbell Row',           'high'],
  ['Bent Over Row',         'high'],
  ['Reverse Bent Over Row', 'high'],

  // ── MEDIUM ────────────────────────────────────────────────────────────
  ['Bench Press',           'medium'],
  ['Machine Bench Press',   'medium'],
  ['Incline DB Press',      'medium'],
  ['Incline Dumbbell Press','medium'],
  ['Overhead Press',        'medium'],
  ['Dips',                  'medium'],
  ['Weighted Dips',         'medium'],
  ['Lat Pulldown',          'medium'],
  ['Seated Row',            'medium'],
  ['Leg Press',             'medium'],
  ['Linear Leg Press',      'medium'],
  ['Seated Leg Press',      'medium'],
  ['Single-Leg Leg Press',  'medium'],

  // ── LOW (isolations) ──────────────────────────────────────────────────
  ['Leg Curl',              'low'],
  ['Single-Leg Leg Curl',   'low'],
  ['Leg Extension',         'low'],
  ['Dumbbell Curl',         'low'],
  ['Hammer Curls',          'low'],
  ['Face Pull',             'low'],
  ['Lateral Raise',         'low'],
  ['Lateral Raises',        'low'],
  ['Cable Crossover',       'low'],
  ['Shrugs',                'low'],
  ['Hanging Knee Raises',   'low'],
  ['Dumbbell Side Bend',    'low'],
];

/* ===== structural guarantees ===== */

test('every fixture returns a cost in COST_TIERS with needsReview=false', () => {
  for (const [lift] of FIXTURES) {
    const result = costFor(lift);
    assert.ok(
      COST_TIERS.has(result.cost),
      `${lift}: "${result.cost}" not in COST_TIERS`
    );
    assert.equal(result.needsReview, false, `${lift}: expected needsReview=false`);
  }
});

test('every fixture matches its expected tier (golden fixtures)', () => {
  for (const [lift, expected] of FIXTURES) {
    const { cost } = costFor(lift);
    assert.equal(cost, expected, `${lift}: expected ${expected}, got ${cost}`);
  }
});

/* ===== critical HIGH-tier spot-checks ===== */

test('Deadlift = high', () => assert.equal(costFor('Deadlift').cost, 'high'));
test('Romanian Deadlift = high', () => assert.equal(costFor('Romanian Deadlift').cost, 'high'));
test('Back Squat = high', () => assert.equal(costFor('Back Squat').cost, 'high'));
test('Barbell Row = high', () => assert.equal(costFor('Barbell Row').cost, 'high'));
test('Bent Over Row = high', () => assert.equal(costFor('Bent Over Row').cost, 'high'));

/* ===== key disambiguation tests ===== */

test('Leg Press is medium, not high (no lower-back load)', () => {
  assert.equal(costFor('Leg Press').cost, 'medium');
  assert.equal(costFor('Single-Leg Leg Press').cost, 'medium');
});

test('Seated Row is medium (machine), Barbell Row is high', () => {
  assert.equal(costFor('Seated Row').cost, 'medium');
  assert.equal(costFor('Barbell Row').cost, 'high');
});

test('Leg Curl is low, not confused with Barbell Row or squat', () => {
  assert.equal(costFor('Leg Curl').cost, 'low');
  assert.equal(costFor('Single-Leg Leg Curl').cost, 'low');
});

test('Lat Pulldown is medium, not confused with Lateral Raise', () => {
  assert.equal(costFor('Lat Pulldown').cost, 'medium');
  assert.equal(costFor('Lateral Raise').cost, 'low');
  assert.equal(costFor('Lateral Raises').cost, 'low');
});

test('Dips are medium (not high)', () => {
  assert.equal(costFor('Dips').cost, 'medium');
  assert.equal(costFor('Weighted Dips').cost, 'medium');
});

test('Hammer Curls (plural) = low', () => {
  assert.equal(costFor('Hammer Curls').cost, 'low');
});

/* ===== unknown / edge cases ===== */

test('unknown lift returns needsReview=true, cost=low (safe default)', () => {
  const result = costFor('Sled Push');
  assert.equal(result.needsReview, true);
  assert.equal(result.cost, 'low');
});

test('null / undefined / empty input returns low + needsReview=true', () => {
  assert.equal(costFor(null).cost, 'low');
  assert.equal(costFor(undefined).cost, 'low');
  assert.equal(costFor('').cost, 'low');
  assert.equal(costFor(null).needsReview, true);
});

/* ===== COST_TIERS export ===== */

test('COST_TIERS contains exactly high, medium, low', () => {
  assert.equal(COST_TIERS.size, 3);
  assert.ok(COST_TIERS.has('high'));
  assert.ok(COST_TIERS.has('medium'));
  assert.ok(COST_TIERS.has('low'));
});
