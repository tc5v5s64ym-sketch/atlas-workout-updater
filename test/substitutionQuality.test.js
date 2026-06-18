'use strict';

// Golden fixtures for services/substitutionQuality.js
// Pure data — no I/O, no Sheets, no LLM.
//
// Verifies scoreSubstitutionQuality returns the correct quality tier
// for substitution pairs the coach must be able to judge.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { scoreSubstitutionQuality } = require('../services/substitutionQuality');

// ─── required scenarios (PR 342) ──────────────────────────────────────────────

describe('scoreSubstitutionQuality — required scenarios', () => {
  it('1. Deadlift → Romanian Deadlift = excellent', () => {
    const r = scoreSubstitutionQuality('Deadlift', 'Romanian Deadlift');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('2. Back Squat → Leg Press = acceptable', () => {
    const r = scoreSubstitutionQuality('Back Squat', 'Leg Press');
    assert.strictEqual(r.quality, 'acceptable');
  });

  it('3. Bench Press → Pec Deck = poor', () => {
    const r = scoreSubstitutionQuality('Bench Press', 'Pec Deck');
    assert.strictEqual(r.quality, 'poor');
  });

  it('4. Unknown exercise pair → unknown', () => {
    // "Jammer Press" and "Landmine Rotation" match no pattern regex.
    const r = scoreSubstitutionQuality('Jammer Press', 'Landmine Rotation');
    assert.strictEqual(r.quality, 'unknown');
  });
});

// ─── excellent tier ───────────────────────────────────────────────────────────

describe('scoreSubstitutionQuality — excellent tier', () => {
  it('hinge → hinge, same HIGH cost: Deadlift → RDL', () => {
    const r = scoreSubstitutionQuality('Deadlift', 'Romanian Deadlift');
    assert.strictEqual(r.quality, 'excellent');
    assert.strictEqual(r.reason, 'same_pattern_same_cost');
  });

  it('hinge → hinge: Good Morning → Deadlift (both HIGH)', () => {
    const r = scoreSubstitutionQuality('Good Morning', 'Deadlift');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('horizontal_push → horizontal_push, same MEDIUM: Bench Press → Incline Press', () => {
    const r = scoreSubstitutionQuality('Bench Press', 'Incline Press');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('horizontal_push → horizontal_push, same MEDIUM: Bench Press → Dips', () => {
    const r = scoreSubstitutionQuality('Bench Press', 'Dips');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('vertical_pull → vertical_pull: Lat Pulldown → Pull-up (both MEDIUM)', () => {
    const r = scoreSubstitutionQuality('Lat Pulldown', 'Pull-up');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('squat → squat: Squat → Goblet Squat (HIGH → MEDIUM one tier, Goblet is MEDIUM)', () => {
    // Goblet Squat is explicitly MEDIUM in liftCost — one tier drop but still compound.
    const r = scoreSubstitutionQuality('Squat', 'Goblet Squat');
    assert.strictEqual(r.quality, 'acceptable');
  });
});

// ─── acceptable tier ──────────────────────────────────────────────────────────

describe('scoreSubstitutionQuality — acceptable tier', () => {
  it('same pattern, HIGH → MEDIUM: Back Squat → Leg Press', () => {
    const r = scoreSubstitutionQuality('Back Squat', 'Leg Press');
    assert.strictEqual(r.quality, 'acceptable');
    assert.strictEqual(r.reason, 'same_pattern_lighter_compound');
  });

  it('same pattern, HIGH → MEDIUM: Deadlift → Leg Press (hinge→squat miss, but squat pattern both)', () => {
    // Deadlift is hinge, Leg Press is squat — different patterns, same 'lower' region.
    const r = scoreSubstitutionQuality('Deadlift', 'Leg Press');
    assert.strictEqual(r.quality, 'acceptable');
    assert.strictEqual(r.reason, 'same_region_different_pattern');
  });

  it('same broad region, different pattern: Lat Pulldown (vertical_pull) → Seated Row (horizontal_pull)', () => {
    const r = scoreSubstitutionQuality('Lat Pulldown', 'Seated Row');
    assert.strictEqual(r.quality, 'acceptable');
    assert.strictEqual(r.reason, 'same_region_different_pattern');
  });

  it('same broad region: Bench Press (horizontal_push) → OHP (vertical_push)', () => {
    const r = scoreSubstitutionQuality('Bench Press', 'Overhead Press');
    assert.strictEqual(r.quality, 'acceptable');
    assert.strictEqual(r.reason, 'same_region_different_pattern');
  });

  it('same broad region: Back Squat (lower) → Hip Thrust (lower)', () => {
    // squat vs hip_isolation — both 'lower' region.
    const r = scoreSubstitutionQuality('Back Squat', 'Hip Thrust');
    assert.strictEqual(r.quality, 'acceptable');
    assert.strictEqual(r.reason, 'same_region_different_pattern');
  });
});

// ─── poor tier ────────────────────────────────────────────────────────────────

describe('scoreSubstitutionQuality — poor tier', () => {
  it('same pattern, MEDIUM → LOW (isolation): Bench Press → Pec Deck', () => {
    const r = scoreSubstitutionQuality('Bench Press', 'Pec Deck');
    assert.strictEqual(r.quality, 'poor');
    assert.strictEqual(r.reason, 'same_pattern_isolation');
  });

  it('same pattern, MEDIUM → LOW: Bench Press → Chest Fly', () => {
    const r = scoreSubstitutionQuality('Bench Press', 'Chest Fly');
    assert.strictEqual(r.quality, 'poor');
    assert.strictEqual(r.reason, 'same_pattern_isolation');
  });

  it('same pattern, HIGH → LOW: Deadlift → Cable Crossover (both horizontal_push? no — hinge → horizontal_push different region)', () => {
    // Deadlift = hinge (lower), Cable Crossover = horizontal_push (push) — different region.
    const r = scoreSubstitutionQuality('Deadlift', 'Cable Crossover');
    assert.strictEqual(r.quality, 'poor');
    assert.strictEqual(r.reason, 'different_region');
  });

  it('completely different region: Deadlift (lower) → Bicep Curl (arm)', () => {
    const r = scoreSubstitutionQuality('Deadlift', 'Bicep Curl');
    assert.strictEqual(r.quality, 'poor');
    assert.strictEqual(r.reason, 'different_region');
  });

  it('completely different region: Back Squat (lower) → Bench Press (push)', () => {
    const r = scoreSubstitutionQuality('Back Squat', 'Bench Press');
    assert.strictEqual(r.quality, 'poor');
    assert.strictEqual(r.reason, 'different_region');
  });

  it('completely different region: OHP (push) → Lat Pulldown (pull)', () => {
    const r = scoreSubstitutionQuality('Overhead Press', 'Lat Pulldown');
    assert.strictEqual(r.quality, 'poor');
    assert.strictEqual(r.reason, 'different_region');
  });
});

// ─── unknown tier ─────────────────────────────────────────────────────────────

describe('scoreSubstitutionQuality — unknown tier', () => {
  it('prescribed is unrecognised → unknown', () => {
    // "Jammer Press" matches no pattern regex.
    const r = scoreSubstitutionQuality('Jammer Press', 'Deadlift');
    assert.strictEqual(r.quality, 'unknown');
    assert.strictEqual(r.reason, 'unrecognized_exercise');
  });

  it('logged is unrecognised → unknown', () => {
    const r = scoreSubstitutionQuality('Deadlift', 'Jammer Press');
    assert.strictEqual(r.quality, 'unknown');
    assert.strictEqual(r.reason, 'unrecognized_exercise');
  });

  it('both unrecognised → unknown', () => {
    const r = scoreSubstitutionQuality('Jammer Press', 'Landmine Rotation');
    assert.strictEqual(r.quality, 'unknown');
  });
});

// ─── object input ─────────────────────────────────────────────────────────────

describe('scoreSubstitutionQuality — object input', () => {
  it('accepts {name} objects', () => {
    const r = scoreSubstitutionQuality({ name: 'Deadlift' }, { name: 'Romanian Deadlift' });
    assert.strictEqual(r.quality, 'excellent');
  });

  it('mixes string and object', () => {
    const r = scoreSubstitutionQuality('Back Squat', { name: 'Leg Press' });
    assert.strictEqual(r.quality, 'acceptable');
  });
});

// ─── result shape ─────────────────────────────────────────────────────────────

describe('scoreSubstitutionQuality — result shape', () => {
  it('result always has quality, reason, prescribed, logged fields', () => {
    const r = scoreSubstitutionQuality('Deadlift', 'Romanian Deadlift');
    assert.ok('quality'    in r, 'quality missing');
    assert.ok('reason'     in r, 'reason missing');
    assert.ok('prescribed' in r, 'prescribed missing');
    assert.ok('logged'     in r, 'logged missing');
  });

  it('prescribed/logged sub-objects include name, pattern, cost', () => {
    const r = scoreSubstitutionQuality('Bench Press', 'Leg Press');
    assert.ok('name'    in r.prescribed, 'prescribed.name missing');
    assert.ok('pattern' in r.prescribed, 'prescribed.pattern missing');
    assert.ok('cost'    in r.prescribed, 'prescribed.cost missing');
    assert.ok('name'    in r.logged,     'logged.name missing');
    assert.ok('pattern' in r.logged,     'logged.pattern missing');
    assert.ok('cost'    in r.logged,     'logged.cost missing');
  });

  it('pattern and cost are populated for known exercises', () => {
    const r = scoreSubstitutionQuality('Deadlift', 'Romanian Deadlift');
    assert.strictEqual(r.prescribed.pattern, 'hinge');
    assert.strictEqual(r.prescribed.cost,    'high');
    assert.strictEqual(r.logged.pattern,     'hinge');
    assert.strictEqual(r.logged.cost,        'high');
  });
});

// ─── defensive inputs ─────────────────────────────────────────────────────────

describe('scoreSubstitutionQuality — defensive inputs', () => {
  it('null prescribed → unknown', () => {
    const r = scoreSubstitutionQuality(null, 'Deadlift');
    assert.strictEqual(r.quality, 'unknown');
    assert.strictEqual(r.reason, 'missing_exercise_name');
  });

  it('null logged → unknown', () => {
    const r = scoreSubstitutionQuality('Deadlift', null);
    assert.strictEqual(r.quality, 'unknown');
    assert.strictEqual(r.reason, 'missing_exercise_name');
  });

  it('empty string prescribed → unknown', () => {
    const r = scoreSubstitutionQuality('', 'Deadlift');
    assert.strictEqual(r.quality, 'unknown');
    assert.strictEqual(r.reason, 'missing_exercise_name');
  });

  it('empty string logged → unknown', () => {
    const r = scoreSubstitutionQuality('Deadlift', '');
    assert.strictEqual(r.quality, 'unknown');
    assert.strictEqual(r.reason, 'missing_exercise_name');
  });

  it('both null → unknown', () => {
    const r = scoreSubstitutionQuality(null, null);
    assert.strictEqual(r.quality, 'unknown');
  });

  it('object with empty name → unknown', () => {
    const r = scoreSubstitutionQuality({ name: '' }, { name: 'Deadlift' });
    assert.strictEqual(r.quality, 'unknown');
  });
});

// ─── existing infrastructure unchanged ───────────────────────────────────────

describe('scoreSubstitutionQuality — existing infrastructure untouched', () => {
  it('classifySubstitution still importable and functional', () => {
    const { classifySubstitution } = require('../services/substitutionIntent');
    const result = classifySubstitution({
      prescribed: { name: 'Deadlift' },
      logged:     { name: 'Romanian Deadlift' },
      history:    [{}],
    });
    assert.strictEqual(result.classification, 'preserved');
  });

  it('inferPrescribedPairs still importable and functional', () => {
    const { inferPrescribedPairs } = require('../services/planMatcher');
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Deadlift');
  });
});
