'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeExpectationVerdict } = require('../services/analytics');

// ─── structural guarantees ──────────────────────────────────────────────────

describe('computeExpectationVerdict — structure', () => {
  it('returns null when no actualRir and not swapped', () => {
    assert.strictEqual(computeExpectationVerdict(), null);
    assert.strictEqual(computeExpectationVerdict({}), null);
    assert.strictEqual(computeExpectationVerdict({ actualRir: null }), null);
    assert.strictEqual(computeExpectationVerdict({ actualRir: undefined }), null);
    assert.strictEqual(computeExpectationVerdict({ actualRir: 'nope' }), null);
  });

  it('swap always returns a verdict even without actualRir', () => {
    const v = computeExpectationVerdict({ swapped: true });
    assert.ok(v, 'swap should return a verdict, not null');
    assert.strictEqual(v.outcome, 'swap');
  });

  it('non-swap result has all required fields', () => {
    const v = computeExpectationVerdict({ actualRir: 2, prescribedRir: 2 });
    assert.ok('outcome'       in v);
    assert.ok('why'           in v);
    assert.ok('prescribedRir' in v);
    assert.ok('actualRir'     in v);
    assert.ok('rirDelta'      in v);
  });

  it('swap result carries null for numeric fields', () => {
    const v = computeExpectationVerdict({ swapped: true });
    assert.strictEqual(v.prescribedRir, null);
    assert.strictEqual(v.actualRir, null);
    assert.strictEqual(v.rirDelta, null);
  });

  it('outcome is one of the four canonical values', () => {
    const VALID = new Set(['beat', 'met', 'fell_short', 'swap']);
    const cases = [
      { actualRir: 1, prescribedRir: 2 },
      { actualRir: 2, prescribedRir: 2 },
      { actualRir: 4, prescribedRir: 2 },
      { swapped: true },
    ];
    for (const c of cases) {
      const v = computeExpectationVerdict(c);
      assert.ok(VALID.has(v.outcome), `unexpected outcome "${v.outcome}" for ${JSON.stringify(c)}`);
    }
  });
});

// ─── golden fixtures: beat ──────────────────────────────────────────────────

describe('computeExpectationVerdict — beat', () => {
  it('beat: actualRir 1 below target (RIR 1 vs target 2)', () => {
    const v = computeExpectationVerdict({ actualRir: 1, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'beat');
    assert.strictEqual(v.actualRir, 1);
    assert.strictEqual(v.prescribedRir, 2);
    assert.strictEqual(v.rirDelta, -1);
    assert.ok(v.why.includes('1'), 'why should mention actualRir');
  });

  it('beat: actualRir 2 below target (RIR 0 vs target 2)', () => {
    const v = computeExpectationVerdict({ actualRir: 0, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'beat');
    assert.strictEqual(v.actualRir, 0);
    assert.strictEqual(v.rirDelta, -2);
    assert.ok(v.why.toLowerCase().includes('failure'), 'failure case should mention "failure"');
  });

  it('beat: at failure vs high target (RIR 0 vs target 3)', () => {
    const v = computeExpectationVerdict({ actualRir: 0, prescribedRir: 3 });
    assert.strictEqual(v.outcome, 'beat');
    assert.strictEqual(v.rirDelta, -3);
    assert.ok(v.why.toLowerCase().includes('failure'));
  });

  it('beat: RIR 1 vs target 3 (pushed 2 below)', () => {
    const v = computeExpectationVerdict({ actualRir: 1, prescribedRir: 3 });
    assert.strictEqual(v.outcome, 'beat');
    assert.strictEqual(v.rirDelta, -2);
  });
});

// ─── golden fixtures: met ───────────────────────────────────────────────────

describe('computeExpectationVerdict — met', () => {
  it('met: exactly on target (RIR 2 vs target 2)', () => {
    const v = computeExpectationVerdict({ actualRir: 2, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'met');
    assert.strictEqual(v.rirDelta, 0);
    assert.ok(v.why.includes('right on the'), 'exact match why should say "right on the"');
  });

  it('met: one above target (RIR 3 vs target 2) — within tolerance', () => {
    const v = computeExpectationVerdict({ actualRir: 3, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'met');
    assert.strictEqual(v.rirDelta, 1);
    assert.ok(v.why.includes('one above'), 'one-over why should say "one above"');
  });

  it('met: exactly on target 3 (RIR 3 vs target 3)', () => {
    const v = computeExpectationVerdict({ actualRir: 3, prescribedRir: 3 });
    assert.strictEqual(v.outcome, 'met');
    assert.strictEqual(v.rirDelta, 0);
  });

  it('met: one above target 1 (RIR 2 vs target 1)', () => {
    const v = computeExpectationVerdict({ actualRir: 2, prescribedRir: 1 });
    assert.strictEqual(v.outcome, 'met');
    assert.strictEqual(v.rirDelta, 1);
  });
});

// ─── golden fixtures: fell_short ────────────────────────────────────────────

describe('computeExpectationVerdict — fell_short', () => {
  it('fell_short: 2 above target — threshold (RIR 4 vs target 2)', () => {
    const v = computeExpectationVerdict({ actualRir: 4, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'fell_short');
    assert.strictEqual(v.actualRir, 4);
    assert.strictEqual(v.prescribedRir, 2);
    assert.strictEqual(v.rirDelta, 2);
    assert.ok(v.why.includes('tank'), 'fell_short why should mention "tank"');
  });

  it('fell_short: far above target (RIR 7 vs target 2)', () => {
    const v = computeExpectationVerdict({ actualRir: 7, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'fell_short');
    assert.strictEqual(v.rirDelta, 5);
  });

  it('fell_short: RIR 5 vs target 3 (2 above)', () => {
    const v = computeExpectationVerdict({ actualRir: 5, prescribedRir: 3 });
    assert.strictEqual(v.outcome, 'fell_short');
    assert.strictEqual(v.rirDelta, 2);
  });

  it('fell_short: COACH_PERSONALITY example — logged 4 when prescribed 2', () => {
    // "Prescribed 30x8 @ 2 RIR, you logged 30x8 @ 4 RIR — left meat on the bone."
    const v = computeExpectationVerdict({ actualRir: 4, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'fell_short');
    assert.strictEqual(v.rirDelta, 2);
  });
});

// ─── golden fixture: swap ───────────────────────────────────────────────────

describe('computeExpectationVerdict — swap', () => {
  it('swap: swapped=true regardless of RIR values', () => {
    const v = computeExpectationVerdict({ actualRir: 2, prescribedRir: 2, swapped: true });
    assert.strictEqual(v.outcome, 'swap');
    assert.strictEqual(v.actualRir, null);
    assert.strictEqual(v.rirDelta, null);
    assert.ok(v.why.toLowerCase().includes('swap'), 'swap why should mention swap');
  });

  it('swap: no inputs at all, just swapped=true', () => {
    const v = computeExpectationVerdict({ swapped: true });
    assert.strictEqual(v.outcome, 'swap');
    assert.strictEqual(v.prescribedRir, null);
  });
});

// ─── PR 3: substitution intent attached to the swap verdict ──────────────────

describe('computeExpectationVerdict — substitution enrichment (PR 3)', () => {
  const HISTORY = [{ weight: 225, reps: 5, rir: 2 }];

  it('swap still works: outcome and existing fields are preserved', () => {
    const v = computeExpectationVerdict({
      swapped: true,
      prescribedLift: { name: 'Back Squat' },
      loggedLift:     { name: 'Leg Press' },
      history:    HISTORY,
    });
    assert.strictEqual(v.outcome, 'swap');
    assert.strictEqual(v.prescribedRir, null);
    assert.strictEqual(v.actualRir, null);
    assert.strictEqual(v.rirDelta, null);
    assert.ok(v.why.toLowerCase().includes('swap'));
  });

  it('attaches the substitution classification when both lift identities are given', () => {
    const v = computeExpectationVerdict({
      swapped: true,
      prescribedLift: { name: 'Back Squat', lift_code: 'SQ01' },
      loggedLift:     { name: 'Leg Press' },
      history:    HISTORY,
    });
    assert.ok(v.substitution, 'substitution block should be attached');
    assert.strictEqual(v.substitution.classification, 'preserved');
    assert.strictEqual(v.substitution.decision, 'approve');
    assert.strictEqual(v.substitution.reason_code, 'pattern_and_muscle_match');
    assert.strictEqual(v.substitution.prescribed.lift_code, 'SQ01');
    assert.ok(Array.isArray(v.substitution.evidence));
  });

  it('classifies an abandoned swap (heavy main lift → unrelated stimulus)', () => {
    const v = computeExpectationVerdict({
      swapped: true,
      prescribedLift: { name: 'Back Squat' },
      loggedLift:     { name: 'Treadmill' },
      history:    HISTORY,
    });
    assert.strictEqual(v.outcome, 'swap');
    assert.strictEqual(v.substitution.classification, 'abandoned');
    assert.strictEqual(v.substitution.decision, 'warn');
  });

  it('classifies a baseline swap when no history is supplied', () => {
    const v = computeExpectationVerdict({
      swapped: true,
      prescribedLift: { name: 'Back Squat' },
      loggedLift:     { name: 'Leg Press' },
      // no history
    });
    assert.strictEqual(v.substitution.classification, 'baseline');
    assert.strictEqual(v.substitution.decision, 'approve');
  });

  it('substitution is null on a swap when lift identities are missing (back-compat)', () => {
    const v = computeExpectationVerdict({ swapped: true });
    assert.strictEqual(v.outcome, 'swap');
    assert.strictEqual(v.substitution, null);
  });

  it('substitution is null when only one lift identity is provided', () => {
    const v = computeExpectationVerdict({ swapped: true, prescribedLift: { name: 'Back Squat' } });
    assert.strictEqual(v.substitution, null);
  });

  it('non-swap paths are unchanged: no substitution field on a normal verdict', () => {
    const v = computeExpectationVerdict({ actualRir: 2, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'met');
    assert.ok(!('substitution' in v), 'non-swap verdict must not carry a substitution field');
  });

  it('non-swap paths ignore substitution inputs entirely', () => {
    // Even if lift identities are passed, a non-swap verdict never classifies.
    const v = computeExpectationVerdict({
      actualRir: 4,
      prescribedRir: 2,
      prescribedLift: { name: 'Back Squat' },
      loggedLift:     { name: 'Leg Press' },
      history:    HISTORY,
    });
    assert.strictEqual(v.outcome, 'fell_short');
    assert.ok(!('substitution' in v));
  });

  it('still returns null when not swapped and no actualRir, even with lift identities', () => {
    const v = computeExpectationVerdict({
      prescribedLift: { name: 'Back Squat' },
      loggedLift:     { name: 'Leg Press' },
      history:    HISTORY,
    });
    assert.strictEqual(v, null);
  });
});

// ─── default prescribedRir ──────────────────────────────────────────────────

describe('computeExpectationVerdict — prescribedRir defaults', () => {
  it('defaults prescribedRir to 2 when omitted', () => {
    const v = computeExpectationVerdict({ actualRir: 2 });
    assert.strictEqual(v.prescribedRir, 2);
    assert.strictEqual(v.outcome, 'met');
  });

  it('defaults prescribedRir to 2 when null', () => {
    const v = computeExpectationVerdict({ actualRir: 4, prescribedRir: null });
    assert.strictEqual(v.prescribedRir, 2);
    assert.strictEqual(v.outcome, 'fell_short');
    assert.strictEqual(v.rirDelta, 2);
  });

  it('defaults prescribedRir to 2 when NaN', () => {
    const v = computeExpectationVerdict({ actualRir: 1, prescribedRir: NaN });
    assert.strictEqual(v.prescribedRir, 2);
    assert.strictEqual(v.outcome, 'beat');
    assert.strictEqual(v.rirDelta, -1);
  });
});

// ─── rirDelta sign convention ───────────────────────────────────────────────

describe('computeExpectationVerdict — rirDelta sign convention', () => {
  it('rirDelta is negative when actualRir < prescribedRir (pushed harder)', () => {
    const v = computeExpectationVerdict({ actualRir: 1, prescribedRir: 3 });
    assert.ok(v.rirDelta < 0, 'pushing harder gives negative rirDelta');
    assert.strictEqual(v.rirDelta, -2);
  });

  it('rirDelta is zero when exactly on target', () => {
    const v = computeExpectationVerdict({ actualRir: 2, prescribedRir: 2 });
    assert.strictEqual(v.rirDelta, 0);
  });

  it('rirDelta is positive when actualRir > prescribedRir (sandbagged)', () => {
    const v = computeExpectationVerdict({ actualRir: 5, prescribedRir: 2 });
    assert.ok(v.rirDelta > 0, 'sandbagging gives positive rirDelta');
    assert.strictEqual(v.rirDelta, 3);
  });

  it('rirDelta = actualRir − prescribedRir exactly', () => {
    const cases = [
      [1, 2, -1],
      [0, 2, -2],
      [2, 2,  0],
      [3, 2,  1],
      [4, 2,  2],
      [7, 2,  5],
    ];
    for (const [actual, prescribed, expected] of cases) {
      const v = computeExpectationVerdict({ actualRir: actual, prescribedRir: prescribed });
      assert.strictEqual(v.rirDelta, expected, `rirDelta mismatch for actual=${actual}, prescribed=${prescribed}`);
    }
  });
});

// ─── boundary: met/fell_short threshold at rirDelta = 1 vs 2 ───────────────

describe('computeExpectationVerdict — threshold boundaries', () => {
  it('rirDelta=1 is met (just inside tolerance)', () => {
    const v = computeExpectationVerdict({ actualRir: 3, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'met');
    assert.strictEqual(v.rirDelta, 1);
  });

  it('rirDelta=2 is fell_short (just over threshold)', () => {
    const v = computeExpectationVerdict({ actualRir: 4, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'fell_short');
    assert.strictEqual(v.rirDelta, 2);
  });

  it('rirDelta=-1 is beat (one below target)', () => {
    const v = computeExpectationVerdict({ actualRir: 1, prescribedRir: 2 });
    assert.strictEqual(v.outcome, 'beat');
    assert.strictEqual(v.rirDelta, -1);
  });
});
