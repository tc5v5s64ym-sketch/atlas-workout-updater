'use strict';

// Golden fixtures for services/planMatcher.js
// Pure data — no I/O, no Sheets, no LLM.
//
// Verifies that inferPrescribedPairs produces the correct prescribed pairs
// for buildSubstitutionPreviews to classify.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { inferPrescribedPairs } = require('../services/planMatcher');

// ─── required scenarios (PR 341) ──────────────────────────────────────────────

describe('inferPrescribedPairs — required scenarios', () => {
  it('1. Planned Deadlift + logged RDL → substitution pair inferred', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Deadlift');
    assert.strictEqual(pairs[0].logged_exercise, 'Romanian Deadlift');
  });

  it('2. Planned Back Squat + logged Leg Press → substitution pair inferred', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'Back Squat' }],
      [{ name: 'Leg Press' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Back Squat');
    assert.strictEqual(pairs[0].logged_exercise, 'Leg Press');
  });

  it('3. Planned Bench + logged Bench → no pair (exact match, not a substitution)', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'Bench Press' }],
      [{ name: 'Bench Press' }]
    );
    assert.strictEqual(pairs.length, 0);
  });

  it('4. No active plan → no pairs inferred', () => {
    const pairs = inferPrescribedPairs(
      [],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 0);
  });
});

// ─── case-insensitive exact matching ──────────────────────────────────────────

describe('inferPrescribedPairs — case-insensitive exact matching', () => {
  it('Bench Press (plan) vs bench press (logged) → no pair', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'Bench Press' }],
      [{ name: 'bench press' }]
    );
    assert.strictEqual(pairs.length, 0);
  });

  it('DEADLIFT vs deadlift → no pair', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'DEADLIFT' }],
      [{ name: 'deadlift' }]
    );
    assert.strictEqual(pairs.length, 0);
  });
});

// ─── string shorthand ─────────────────────────────────────────────────────────

describe('inferPrescribedPairs — string shorthand inputs', () => {
  it('accepts plain strings', () => {
    const pairs = inferPrescribedPairs(
      ['Deadlift'],
      ['Romanian Deadlift']
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Deadlift');
  });
});

// ─── lift_code passthrough ────────────────────────────────────────────────────

describe('inferPrescribedPairs — lift_code passthrough', () => {
  it('includes lift_code when present in plan', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift', lift_code: 'dl01' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].lift_code, 'dl01');
  });

  it('omits lift_code when absent in plan', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.ok(!('lift_code' in pairs[0]));
  });
});

// ─── multiple exercises ───────────────────────────────────────────────────────

describe('inferPrescribedPairs — multiple exercises', () => {
  it('exact match first, then infers substitution for the unmatched', () => {
    // Plan: Deadlift + Bench Press
    // Logged: Bench Press + Romanian Deadlift
    // → Bench is exact → no pair; Deadlift → RDL → pair
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }, { name: 'Bench Press' }],
      [{ name: 'Bench Press' }, { name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Deadlift');
    assert.strictEqual(pairs[0].logged_exercise, 'Romanian Deadlift');
  });

  it('two substitutions inferred when both planned exercises are swapped', () => {
    // Plan: Deadlift + Back Squat
    // Logged: Romanian Deadlift + Leg Press
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }, { name: 'Back Squat' }],
      [{ name: 'Romanian Deadlift' }, { name: 'Leg Press' }]
    );
    assert.strictEqual(pairs.length, 2);
    const dl = pairs.find(p => p.exercise === 'Deadlift');
    const sq = pairs.find(p => p.exercise === 'Back Squat');
    assert.ok(dl, 'Deadlift pair missing');
    assert.ok(sq, 'Back Squat pair missing');
    assert.strictEqual(dl.logged_exercise, 'Romanian Deadlift');
    assert.strictEqual(sq.logged_exercise, 'Leg Press');
  });

  it('logged exercises are not double-claimed', () => {
    // Plan: Deadlift + Good Morning (both hinge)
    // Logged: Romanian Deadlift only
    // → only one pair should be emitted
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }, { name: 'Good Morning' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
  });

  it('broad-region fallback claims first matching lift in plan order — documents why mid-session must send only current step', () => {
    // Plan: [Deadlift, Back Squat] — Deadlift=hinge→lower, Back Squat=squat→lower.
    // Only Leg Press logged (squat pattern → lower region).
    // Fine-grained pass: Deadlift (hinge) vs Leg Press (squat) → miss.
    // Region fallback: Deadlift (lower) vs Leg Press (lower) → CLAIMS Leg Press.
    // Back Squat never gets a turn; Leg Press is already claimed.
    // Result: Deadlift → Leg Press (wrong attribution — user substituted Back Squat).
    // The fix lives in app.js: mid-session sends only exercises[activePlannedSession.index],
    // not the full plan, so only one planned lift competes per logged set.
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }, { name: 'Back Squat' }],
      [{ name: 'Leg Press' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Deadlift', 'region fallback attributes to first plan lift in order');
    assert.strictEqual(pairs[0].logged_exercise, 'Leg Press');
  });

  it('broad-region fallback triggers when no same-pattern logged exercise exists', () => {
    // Plan: [Deadlift, Good Morning] — both hinge.
    // Only Hip Thrust logged (hip_isolation → lower broad region, not hinge).
    // Fine-grained pass misses both. Region fallback claims Deadlift (first in plan).
    // Documents: when mid-session sends the full plan, plan order determines which
    // lift gets attributed. The fix (app.js sends only exercises[index]) avoids this.
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }, { name: 'Good Morning' }],
      [{ name: 'Hip Thrust' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Deadlift', 'first planned lift claims via region fallback');
    assert.strictEqual(pairs[0].logged_exercise, 'Hip Thrust');
  });
});

// ─── no plausible match ───────────────────────────────────────────────────────

describe('inferPrescribedPairs — no plausible cross-pattern match', () => {
  it('does not pair Deadlift (hinge) with Bicep Curl (arm_isolation)', () => {
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }],
      [{ name: 'Bicep Curl' }]
    );
    assert.strictEqual(pairs.length, 0, 'cross-region pairing must not be forced');
  });
});

// ─── defensive inputs ─────────────────────────────────────────────────────────

describe('inferPrescribedPairs — defensive inputs', () => {
  it('null planExercises → []', () => {
    assert.deepStrictEqual(inferPrescribedPairs(null, [{ name: 'RDL' }]), []);
  });

  it('null loggedExercises → []', () => {
    assert.deepStrictEqual(inferPrescribedPairs([{ name: 'Deadlift' }], null), []);
  });

  it('null inside planExercises is filtered out', () => {
    const pairs = inferPrescribedPairs(
      [null, { name: 'Deadlift' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].exercise, 'Deadlift');
  });

  it('empty name in plan is filtered out', () => {
    const pairs = inferPrescribedPairs(
      [{ name: '' }, { name: 'Deadlift' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
  });

  it('both arrays empty → []', () => {
    assert.deepStrictEqual(inferPrescribedPairs([], []), []);
  });
});
