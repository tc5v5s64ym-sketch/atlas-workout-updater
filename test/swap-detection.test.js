'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { detectSwap, buildWorkingWeightProtocol } = require('../services/analytics');

// ─── detectSwap ──────────────────────────────────────────────────────────────

describe('detectSwap — same exercise (no swap)', () => {
  it('identical names → swapped: false', () => {
    const r = detectSwap('Bench Press', 'Bench Press');
    assert.strictEqual(r.swapped, false);
  });

  it('case-insensitive — "bench press" vs "Bench Press" is not a swap', () => {
    assert.strictEqual(detectSwap('Bench Press', 'bench press').swapped, false);
    assert.strictEqual(detectSwap('DEADLIFT', 'deadlift').swapped, false);
  });

  it('leading/trailing whitespace stripped before comparison', () => {
    assert.strictEqual(detectSwap('  Squat  ', 'Squat').swapped, false);
    assert.strictEqual(detectSwap('OHP', '  OHP  ').swapped, false);
  });

  it('preserves original casing in returned fields', () => {
    const r = detectSwap('Bench Press', 'bench press');
    assert.strictEqual(r.prescribedExercise, 'Bench Press');
    assert.strictEqual(r.loggedExercise,     'bench press');
  });
});

describe('detectSwap — different exercise (swap detected)', () => {
  it('Bench Press → Dips is a swap', () => {
    const r = detectSwap('Bench Press', 'Dips');
    assert.strictEqual(r.swapped, true);
    assert.strictEqual(r.prescribedExercise, 'Bench Press');
    assert.strictEqual(r.loggedExercise,     'Dips');
  });

  it('Deadlift → Romanian Deadlift is a swap', () => {
    const r = detectSwap('Deadlift', 'Romanian Deadlift');
    assert.strictEqual(r.swapped, true);
  });

  it('Squat → Leg Press is a swap', () => {
    assert.strictEqual(detectSwap('Back Squat', 'Leg Press').swapped, true);
  });

  it('OHP → Seated DB Press is a swap', () => {
    assert.strictEqual(detectSwap('Overhead Press', 'Seated DB Press').swapped, true);
  });

  it('case difference alone does not mask a real swap', () => {
    assert.strictEqual(detectSwap('Bench Press', 'DIPS').swapped, true);
  });
});

describe('detectSwap — null / missing inputs', () => {
  it('null prescribed → swapped: false', () => {
    assert.strictEqual(detectSwap(null, 'Bench Press').swapped, false);
  });

  it('null logged → swapped: false', () => {
    assert.strictEqual(detectSwap('Bench Press', null).swapped, false);
  });

  it('both null → swapped: false', () => {
    assert.strictEqual(detectSwap(null, null).swapped, false);
  });

  it('undefined inputs → swapped: false', () => {
    assert.strictEqual(detectSwap(undefined, undefined).swapped, false);
  });

  it('empty string → swapped: false (treated as missing)', () => {
    assert.strictEqual(detectSwap('', 'Bench Press').swapped, false);
    assert.strictEqual(detectSwap('Bench Press', '').swapped, false);
  });

  it('non-string inputs → swapped: false', () => {
    assert.strictEqual(detectSwap(42, 'Bench Press').swapped, false);
    assert.strictEqual(detectSwap('Bench Press', true).swapped, false);
  });

  it('null inputs produce null fields (not "null" strings)', () => {
    const r = detectSwap(null, 'Dips');
    assert.strictEqual(r.prescribedExercise, null);
    assert.strictEqual(r.loggedExercise,     'Dips');
  });
});

describe('detectSwap — return shape', () => {
  it('always has swapped, prescribedExercise, loggedExercise', () => {
    for (const [a, b] of [['Bench Press', 'Bench Press'], ['Bench Press', 'Dips'], [null, 'Dips']]) {
      const r = detectSwap(a, b);
      assert.ok('swapped'            in r, 'missing swapped');
      assert.ok('prescribedExercise' in r, 'missing prescribedExercise');
      assert.ok('loggedExercise'     in r, 'missing loggedExercise');
    }
  });
});

// ─── buildWorkingWeightProtocol ──────────────────────────────────────────────

describe('buildWorkingWeightProtocol — return shape', () => {
  it('has instruction, targetReps, targetRir, startHint', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2 });
    assert.ok('instruction' in r, 'missing instruction');
    assert.ok('targetReps'  in r, 'missing targetReps');
    assert.ok('targetRir'   in r, 'missing targetRir');
    assert.ok('startHint'   in r, 'missing startHint');
  });

  it('instruction is a non-empty string', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2 });
    assert.ok(typeof r.instruction === 'string' && r.instruction.length > 0);
  });
});

describe('buildWorkingWeightProtocol — without referenceWeight', () => {
  it('startHint is null when no referenceWeight', () => {
    assert.strictEqual(buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2 }).startHint, null);
  });

  it('instruction says "Start conservative"', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2 });
    assert.ok(r.instruction.startsWith('Start conservative'), `got: ${r.instruction}`);
  });

  it('instruction mentions target reps and RIR', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 5, targetRir: 3 });
    assert.ok(r.instruction.includes('5'), 'should mention targetReps');
    assert.ok(r.instruction.includes('3'), 'should mention targetRir');
  });

  it('instruction ends with baseline note', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2 });
    assert.ok(r.instruction.includes('baseline'), `got: ${r.instruction}`);
  });

  it('targetReps and targetRir are passed through', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 5, targetRir: 1 });
    assert.strictEqual(r.targetReps, 5);
    assert.strictEqual(r.targetRir,  1);
  });
});

describe('buildWorkingWeightProtocol — with referenceWeight', () => {
  it('startHint is 70% of referenceWeight rounded to nearest 5', () => {
    // 200 × 0.7 = 140 → already a multiple of 5
    assert.strictEqual(buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2, referenceWeight: 200 }).startHint, 140);
  });

  it('rounds to nearest 5 correctly', () => {
    // 225 × 0.7 = 157.5 → nearest 5 = 160
    assert.strictEqual(buildWorkingWeightProtocol({ targetReps: 5, targetRir: 2, referenceWeight: 225 }).startHint, 160);
    // 135 × 0.7 = 94.5 → nearest 5 = 95
    assert.strictEqual(buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2, referenceWeight: 135 }).startHint, 95);
    // 315 × 0.7 = 220.5 → nearest 5 = 220
    assert.strictEqual(buildWorkingWeightProtocol({ targetReps: 3, targetRir: 1, referenceWeight: 315 }).startHint, 220);
  });

  it('instruction mentions startHint weight', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2, referenceWeight: 200 });
    assert.ok(r.instruction.includes('140'), `startHint not in instruction: ${r.instruction}`);
  });

  it('instruction says "Start around X lbs"', () => {
    const r = buildWorkingWeightProtocol({ targetReps: 8, targetRir: 2, referenceWeight: 200 });
    assert.ok(r.instruction.startsWith('Start around'), `got: ${r.instruction}`);
  });
});

describe('buildWorkingWeightProtocol — defaults', () => {
  it('defaults to targetReps=8, targetRir=2 when omitted', () => {
    const r = buildWorkingWeightProtocol();
    assert.strictEqual(r.targetReps, 8);
    assert.strictEqual(r.targetRir,  2);
  });

  it('defaults to targetReps=8, targetRir=2 when null', () => {
    const r = buildWorkingWeightProtocol({ targetReps: null, targetRir: null });
    assert.strictEqual(r.targetReps, 8);
    assert.strictEqual(r.targetRir,  2);
  });

  it('ignores non-positive referenceWeight', () => {
    assert.strictEqual(buildWorkingWeightProtocol({ referenceWeight: 0 }).startHint,  null);
    assert.strictEqual(buildWorkingWeightProtocol({ referenceWeight: -10 }).startHint, null);
  });

  it('ignores non-numeric referenceWeight', () => {
    assert.strictEqual(buildWorkingWeightProtocol({ referenceWeight: 'nope' }).startHint, null);
    assert.strictEqual(buildWorkingWeightProtocol({ referenceWeight: null }).startHint,   null);
  });

  it('targetReps floors at 1', () => {
    assert.strictEqual(buildWorkingWeightProtocol({ targetReps: 0 }).targetReps, 1);
    assert.strictEqual(buildWorkingWeightProtocol({ targetReps: -5 }).targetReps, 1);
  });

  it('targetRir floors at 0 (failure target is valid)', () => {
    assert.strictEqual(buildWorkingWeightProtocol({ targetRir: 0 }).targetRir, 0);
    assert.strictEqual(buildWorkingWeightProtocol({ targetRir: -1 }).targetRir, 0);
  });
});

// ─── integration: detectSwap feeds computeExpectationVerdict ─────────────────

describe('detectSwap → computeExpectationVerdict integration', () => {
  const { computeExpectationVerdict } = require('../services/analytics');

  it('swap detected → computeExpectationVerdict with swapped=true → outcome swap', () => {
    const { swapped } = detectSwap('Bench Press', 'Dips');
    const verdict = computeExpectationVerdict({ swapped, actualRir: 2, prescribedRir: 2 });
    assert.strictEqual(verdict.outcome, 'swap');
  });

  it('no swap → computeExpectationVerdict with swapped=false → normal outcome', () => {
    const { swapped } = detectSwap('Bench Press', 'Bench Press');
    const verdict = computeExpectationVerdict({ swapped, actualRir: 4, prescribedRir: 2 });
    assert.strictEqual(verdict.outcome, 'fell_short');
  });
});
