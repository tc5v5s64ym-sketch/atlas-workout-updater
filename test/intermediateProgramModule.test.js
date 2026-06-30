'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNextSession531,
  suggestNextCycleMaxes,
  computeTrainingMax,
  _resetForTesting,
} = require('../services/intermediateProgramModule');

before(() => _resetForTesting());

// Standard training maxes used as fixtures
const TM = Object.freeze({ SQUAT: 225, BENCH: 155, DEADLIFT: 275, OHP: 115 });

// --- null/invalid guards ---

describe('buildNextSession531 — null guards', () => {
  it('returns null for null state', () => assert.strictEqual(buildNextSession531(null), null));
  it('returns null for non-object state', () => assert.strictEqual(buildNextSession531('str'), null));
  it('returns null when sessionCount is missing', () =>
    assert.strictEqual(buildNextSession531({ trainingMaxes: TM }), null));
  it('returns null when trainingMaxes is missing', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 0 }), null));
  it('returns null for negative sessionCount', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: -1, trainingMaxes: TM }), null));
  it('returns null when main lift TM is missing', () => {
    const result = buildNextSession531({ sessionCount: 0, trainingMaxes: { BENCH: 155 } });
    assert.strictEqual(result, null);
  });
  it('returns null when main lift TM is zero', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 0, trainingMaxes: { SQUAT: 0, BENCH: 155, DEADLIFT: 275, OHP: 115 } }), null));
});

// --- week 1 (5s week), day 1 (Squat) ---

describe('buildNextSession531 — week 1, day 1 (Squat, 5s week)', () => {
  let r;
  before(() => { r = buildNextSession531({ sessionCount: 0, trainingMaxes: TM }); });

  it('returns a result', () => assert.ok(r));
  it('programId is 531-intermediate', () => assert.strictEqual(r.programId, '531-intermediate'));
  it('sessionLabel is Squat', () => assert.strictEqual(r.sessionLabel, 'Squat'));
  it('weekInCycle is 1', () => assert.strictEqual(r.weekInCycle, 1));
  it('weekLabel is 5s week', () => assert.strictEqual(r.weekLabel, '5s week'));
  it('dayInWeek is 1', () => assert.strictEqual(r.dayInWeek, 1));
  it('isDeload is false', () => assert.strictEqual(r.isDeload, false));
  it('isCycleBoundary is false for session 0', () => assert.strictEqual(r.isCycleBoundary, false));

  it('mainLift liftCode is SQUAT', () => assert.strictEqual(r.mainLift.liftCode, 'SQUAT'));
  it('mainLift trainingMax is 225', () => assert.strictEqual(r.mainLift.trainingMax, 225));
  it('mainLift has 3 sets', () => assert.strictEqual(r.mainLift.sets.length, 3));

  // 65% × 225 = 146.25 → round5 = 145
  it('set 1 weight is 145 lb', () => assert.strictEqual(r.mainLift.sets[0].weight, 145));
  it('set 1 reps is 5', () => assert.strictEqual(r.mainLift.sets[0].reps, 5));
  it('set 1 repsScheme is fixed', () => assert.strictEqual(r.mainLift.sets[0].repsScheme, 'fixed'));

  // 75% × 225 = 168.75 → round5 = 170
  it('set 2 weight is 170 lb', () => assert.strictEqual(r.mainLift.sets[1].weight, 170));
  it('set 2 reps is 5, fixed', () => {
    assert.strictEqual(r.mainLift.sets[1].reps, 5);
    assert.strictEqual(r.mainLift.sets[1].repsScheme, 'fixed');
  });

  // 85% × 225 = 191.25 → round5 = 190
  it('set 3 weight is 190 lb', () => assert.strictEqual(r.mainLift.sets[2].weight, 190));
  it('set 3 repsScheme is amrap', () => assert.strictEqual(r.mainLift.sets[2].repsScheme, 'amrap'));

  // Supplemental: DEADLIFT @ 50% TM → 50% × 275 = 137.5 → round5 = 140
  it('supplemental liftCode is DEADLIFT', () => assert.strictEqual(r.supplemental.liftCode, 'DEADLIFT'));
  it('supplemental has 3 sets', () => assert.strictEqual(r.supplemental.sets.length, 3));
  it('supplemental set weight is 140 lb', () => assert.strictEqual(r.supplemental.sets[0].weight, 140));
});

// --- week 2 (3s week), day 1 ---

describe('buildNextSession531 — session 4: week 2, day 1 (Squat, 3s week)', () => {
  let r;
  before(() => { r = buildNextSession531({ sessionCount: 4, trainingMaxes: TM }); });

  it('weekInCycle is 2', () => assert.strictEqual(r.weekInCycle, 2));
  it('weekLabel is 3s week', () => assert.strictEqual(r.weekLabel, '3s week'));
  it('dayInWeek is 1 (Squat)', () => assert.strictEqual(r.sessionLabel, 'Squat'));

  // 70% × 225 = 157.5 → round5 = 160
  it('set 1 weight is 160 lb', () => assert.strictEqual(r.mainLift.sets[0].weight, 160));
  it('set 1 reps is 3', () => assert.strictEqual(r.mainLift.sets[0].reps, 3));

  // 90% × 225 = 202.5 → round5 = 205 (Math.round(40.5) = 41)
  it('set 3 weight is 205 lb', () => assert.strictEqual(r.mainLift.sets[2].weight, 205));
  it('set 3 repsScheme is amrap', () => assert.strictEqual(r.mainLift.sets[2].repsScheme, 'amrap'));
});

// --- week 3 (5/3/1 week), day 1 ---

describe('buildNextSession531 — session 8: week 3, day 1 (Squat, 5/3/1 week)', () => {
  let r;
  before(() => { r = buildNextSession531({ sessionCount: 8, trainingMaxes: TM }); });

  it('weekInCycle is 3', () => assert.strictEqual(r.weekInCycle, 3));
  it('weekLabel is 5/3/1 week', () => assert.strictEqual(r.weekLabel, '5/3/1 week'));

  // 75% × 225 = 168.75 → 170
  it('set 1 weight 170 lb, 5 reps fixed', () => {
    assert.strictEqual(r.mainLift.sets[0].weight, 170);
    assert.strictEqual(r.mainLift.sets[0].reps, 5);
  });

  // 95% × 225 = 213.75 → round5 = 215
  it('set 3 weight is 215 lb, 1 rep amrap', () => {
    assert.strictEqual(r.mainLift.sets[2].weight, 215);
    assert.strictEqual(r.mainLift.sets[2].reps, 1);
    assert.strictEqual(r.mainLift.sets[2].repsScheme, 'amrap');
  });
});

// --- week 4 (deload week) ---

describe('buildNextSession531 — session 12: week 4, day 1 (Squat, Deload week)', () => {
  let r;
  before(() => { r = buildNextSession531({ sessionCount: 12, trainingMaxes: TM }); });

  it('weekInCycle is 4', () => assert.strictEqual(r.weekInCycle, 4));
  it('isDeload is true', () => assert.strictEqual(r.isDeload, true));

  // 40% × 225 = 90
  it('set 1 weight is 90 lb', () => assert.strictEqual(r.mainLift.sets[0].weight, 90));
  it('set 2 weight is 115 lb (50% × 225 = 112.5 → 115)', () => assert.strictEqual(r.mainLift.sets[1].weight, 115));
  it('set 3 weight is 135 lb (60% × 225 = 135)', () => assert.strictEqual(r.mainLift.sets[2].weight, 135));
  it('all deload sets are fixed reps', () => {
    for (const s of r.mainLift.sets) {
      assert.strictEqual(s.repsScheme, 'fixed');
    }
  });
});

// --- day rotation ---

describe('buildNextSession531 — day rotation within a week', () => {
  it('session 0 → day 1 (Squat)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 0, trainingMaxes: TM })?.sessionLabel, 'Squat'));
  it('session 1 → day 2 (OHP)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 1, trainingMaxes: TM })?.sessionLabel, 'OHP'));
  it('session 2 → day 3 (Deadlift)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 2, trainingMaxes: TM })?.sessionLabel, 'Deadlift'));
  it('session 3 → day 4 (Bench)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 3, trainingMaxes: TM })?.sessionLabel, 'Bench'));
  it('session 4 → cycles back to day 1 (Squat)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 4, trainingMaxes: TM })?.sessionLabel, 'Squat'));
});

// --- OHP day: upper-body lift ---

describe('buildNextSession531 — OHP day (session 1)', () => {
  let r;
  before(() => { r = buildNextSession531({ sessionCount: 1, trainingMaxes: TM }); });

  it('mainLift liftCode is OHP', () => assert.strictEqual(r.mainLift.liftCode, 'OHP'));
  it('mainLift trainingMax is 115', () => assert.strictEqual(r.mainLift.trainingMax, 115));

  // 65% × 115 = 74.75 → round5 = 75
  it('set 1 weight is 75 lb', () => assert.strictEqual(r.mainLift.sets[0].weight, 75));
  it('supplemental liftCode is BENCH', () => assert.strictEqual(r.supplemental.liftCode, 'BENCH'));
  // supplemental BENCH TM: 155; 50% × 155 = 77.5 → round5 = 80
  it('supplemental weight is 80 lb', () => assert.strictEqual(r.supplemental.sets[0].weight, 80));
});

// --- cycle boundary ---

describe('buildNextSession531 — cycle boundary', () => {
  it('session 0 is NOT a cycle boundary', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 0, trainingMaxes: TM })?.isCycleBoundary, false));
  it('session 16 IS a cycle boundary (start of cycle 2)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 16, trainingMaxes: TM })?.isCycleBoundary, true));
  it('session 32 IS a cycle boundary (start of cycle 3)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 32, trainingMaxes: TM })?.isCycleBoundary, true));
  it('session 15 is NOT a cycle boundary (last session of cycle 1)', () =>
    assert.strictEqual(buildNextSession531({ sessionCount: 15, trainingMaxes: TM })?.isCycleBoundary, false));
});

// --- supplemental null weight when TM missing ---

describe('buildNextSession531 — supplemental TM missing', () => {
  it('supplemental weight is null when supplemental lift TM not supplied', () => {
    const r = buildNextSession531({ sessionCount: 0, trainingMaxes: { SQUAT: 225 } });
    assert.ok(r);
    assert.strictEqual(r.supplemental.sets[0].weight, null);
  });
});

// --- suggestNextCycleMaxes ---

describe('suggestNextCycleMaxes', () => {
  it('returns null for null input', () => assert.strictEqual(suggestNextCycleMaxes(null), null));
  it('returns null for non-object', () => assert.strictEqual(suggestNextCycleMaxes('x'), null));

  it('adds 10 lb to lower-body lifts (SQUAT, DEADLIFT)', () => {
    const next = suggestNextCycleMaxes(TM);
    assert.strictEqual(next.SQUAT,    225 + 10);
    assert.strictEqual(next.DEADLIFT, 275 + 10);
  });

  it('adds 5 lb to upper-body lifts (BENCH, OHP)', () => {
    const next = suggestNextCycleMaxes(TM);
    assert.strictEqual(next.BENCH, 155 + 5);
    assert.strictEqual(next.OHP,   115 + 5);
  });

  it('ignores non-finite values', () => {
    const next = suggestNextCycleMaxes({ SQUAT: 200, BENCH: Infinity });
    assert.strictEqual(next.SQUAT, 210);
    assert.strictEqual(next.BENCH, undefined);
  });
});

// --- computeTrainingMax ---

describe('computeTrainingMax', () => {
  it('returns null for null', () => assert.strictEqual(computeTrainingMax(null), null));
  it('returns null for zero', () => assert.strictEqual(computeTrainingMax(0), null));
  it('returns null for negative', () => assert.strictEqual(computeTrainingMax(-100), null));
  it('returns null for Infinity', () => assert.strictEqual(computeTrainingMax(Infinity), null));

  it('250 lb 1RM → TM 225 (90% × 250 = 225)', () => assert.strictEqual(computeTrainingMax(250), 225));
  it('135 lb 1RM → TM 120 (90% × 135 = 121.5 → round5 = 120)', () => assert.strictEqual(computeTrainingMax(135), 120));
  it('315 lb 1RM → TM 285 (90% × 315 = 283.5 → round5 = 285)', () => assert.strictEqual(computeTrainingMax(315), 285));
  it('300 lb 1RM → TM 270 (90% × 300 = 270)', () => assert.strictEqual(computeTrainingMax(300), 270));
});
