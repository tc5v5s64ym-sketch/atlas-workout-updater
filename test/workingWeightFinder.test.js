'use strict';

// #1342 — in-session working-weight finder (Corpus V2 §F.8), pure engine.
// Failing-first: these pin the corpus S4/S11 finder turns and the entry
// guards. The engine is pure; the route tests prove the emission.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateWorkingWeightFinder,
  substitutionIsFinderEntry,
} = require('../services/workingWeightFinder');

const SUB_FIXTURE = { classification: 'substituted', prescribed: { name: 'Bench Press' }, logged: { name: 'Machine Chest Press' } };
const SUB_INTENT = { classification: 'preserved', decision: 'approve', quality: 'acceptable', prescribed: 'Bench Press', logged: 'Machine Chest Press' };
const SUB_S11 = { classification: 'substituted', prescribed: { name: 'Cable Row' }, logged: { name: 'Plate-Loaded Row' } };

test('S4 turn 2: criterion hit at 140, overshoot at 150, no baseline yet', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [
      { weight: 120, reps: 10, rir: 4 },
      { weight: 140, reps: 8, rir: 2 },
      { weight: 150, reps: 8, rir: 0 },
    ],
    hasHistory: false,
  });
  assert.ok(f, 'finder active');
  assert.deepEqual(f.criterion, { reps: 8, rir: 2 });
  assert.equal(f.status, 'overshot');
  assert.deepEqual(f.working_weight, { weight: 140, reps: 8, rir: 2 });
  assert.deepEqual(f.overshoot, { weight: 150, reps: 8, rir: 0 });
  assert.equal(f.baseline, null, 'one criterion set is not repeatable yet');
  assert.equal(f.sets_evaluated, 3);
});

test('S4 turn 3: confirmation sets complete the baseline 140 8/2 x3', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: null,
    todaySets: [{ weight: 140, reps: 8, rir: 2 }, { weight: 140, reps: 8, rir: 2 }],
    priorSets: [
      { weight: 120, reps: 10, rir: 4 },
      { weight: 140, reps: 8, rir: 2 },
      { weight: 150, reps: 8, rir: 0 },
    ],
    hasHistory: false,
  });
  assert.ok(f, 'finder continues on forwarded priors without a new substitution');
  assert.equal(f.status, 'baselined');
  assert.deepEqual(f.working_weight, { weight: 140, reps: 8, rir: 2 });
  assert.deepEqual(f.overshoot, { weight: 150, reps: 8, rir: 0 }, 'the earlier overshoot stays on the record');
  assert.deepEqual(f.baseline, { exercise: 'Machine Chest Press', weight: 140, reps: 8, rir: 2, sets: 3 });
});

test('S11 turn 3: self-run finder baselines 230 10/2 x2 in one block', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Plate-Loaded Row',
    substitution: SUB_S11,
    todaySets: [
      { weight: 205, reps: 10, rir: 3 },
      { weight: 230, reps: 10, rir: 2 },
      { weight: 230, reps: 10, rir: 2 },
    ],
    hasHistory: false,
  });
  assert.ok(f, 'finder active');
  assert.equal(f.status, 'baselined');
  assert.deepEqual(f.working_weight, { weight: 230, reps: 10, rir: 2 });
  assert.equal(f.overshoot, null);
  assert.deepEqual(f.baseline, { exercise: 'Plate-Loaded Row', weight: 230, reps: 10, rir: 2, sets: 2 });
});

test('finding: ascending with no criterion hit yet, no overshoot', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [{ weight: 120, reps: 10, rir: 4 }],
    hasHistory: false,
  });
  assert.equal(f.status, 'finding');
  assert.equal(f.working_weight, null);
  assert.equal(f.overshoot, null);
  assert.equal(f.baseline, null);
});

test('identified: one criterion hit, awaiting confirmation', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [{ weight: 120, reps: 10, rir: 4 }, { weight: 140, reps: 8, rir: 2 }],
    hasHistory: false,
  });
  assert.equal(f.status, 'identified');
  assert.deepEqual(f.working_weight, { weight: 140, reps: 8, rir: 2 });
  assert.equal(f.baseline, null);
});

test('entry gate: history present means no finder (a benchmark exists)', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [{ weight: 120, reps: 10, rir: 4 }, { weight: 140, reps: 8, rir: 2 }],
    hasHistory: true,
  });
  assert.equal(f, null);
});

test('entry gate: unknown history (read failed) fails closed — no finder', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [{ weight: 140, reps: 8, rir: 2 }],
    hasHistory: null,
  });
  assert.equal(f, null);
});

test('entry gate: no substitution and no priors means no finder', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Bicep Curl',
    substitution: null,
    todaySets: [{ weight: 40, reps: 10, rir: 2 }, { weight: 40, reps: 10, rir: 2 }],
    hasHistory: false,
  });
  assert.equal(f, null);
});

test('entry gate: same lift prescribed and logged is not a swap', () => {
  assert.equal(substitutionIsFinderEntry({ classification: 'substituted', prescribed: { name: 'Bench Press' }, logged: { name: 'Bench Press' } }), false);
  const f = evaluateWorkingWeightFinder({
    exercise: 'Bench Press',
    substitution: { classification: 'substituted', prescribed: { name: 'Bench Press' }, logged: { name: 'Bench Press' } },
    todaySets: [{ weight: 185, reps: 8, rir: 2 }],
    hasHistory: false,
  });
  assert.equal(f, null);
});

test('entry gate: abandoned objective and warned swaps never enter the finder', () => {
  assert.equal(substitutionIsFinderEntry({ classification: 'abandoned', decision: 'warn', prescribed: 'Bench Press', logged: 'Machine Chest Press' }), false);
  assert.equal(substitutionIsFinderEntry({ classification: 'changed', decision: 'warn', prescribed: 'Bench Press', logged: 'Machine Chest Press' }), false);
  // ...but the real approved-preserved shape does.
  assert.equal(substitutionIsFinderEntry(SUB_INTENT), true);
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_INTENT,
    todaySets: [{ weight: 140, reps: 8, rir: 2 }],
    hasHistory: false,
  });
  assert.ok(f, 'intent-shape substitution enters');
  assert.equal(f.status, 'identified');
});

test('overshoot: failure before target reps is still past the criterion load', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [{ weight: 160, reps: 6, rir: 0 }],
    hasHistory: false,
  });
  assert.equal(f.status, 'overshot');
  assert.deepEqual(f.overshoot, { weight: 160, reps: 6, rir: 0 });
  assert.equal(f.working_weight, null);
});

test('unjudged sets (no RIR, no weight) are skipped, never counted', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [{ weight: 140, reps: 8, rir: null }, { weight: null, reps: 8, rir: 2 }, { weight: 140, reps: 8, rir: 2 }],
    hasHistory: false,
  });
  assert.equal(f.sets_evaluated, 1);
  assert.equal(f.status, 'identified');
});

test('array-shaped sets [weight, reps, rir] evaluate identically', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [[120, 10, 4], [140, 8, 2], [150, 8, 0]],
    hasHistory: false,
  });
  assert.equal(f.status, 'overshot');
  assert.deepEqual(f.working_weight, { weight: 140, reps: 8, rir: 2 });
});

test('a second criterion hit at a heavier load does not move the working weight', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Machine Chest Press',
    substitution: SUB_FIXTURE,
    todaySets: [{ weight: 140, reps: 8, rir: 2 }, { weight: 145, reps: 8, rir: 2 }],
    hasHistory: false,
  });
  assert.deepEqual(f.working_weight, { weight: 140, reps: 8, rir: 2 });
  assert.equal(f.baseline, null, 'confirmation must repeat the SAME load');
  assert.equal(f.status, 'identified');
});

test('criterion honors an explicit target (10 @ 2, not the 8 @ 2 default)', () => {
  const f = evaluateWorkingWeightFinder({
    exercise: 'Plate-Loaded Row',
    substitution: SUB_S11,
    todaySets: [{ weight: 230, reps: 8, rir: 2 }],
    hasHistory: false,
    targetReps: 10,
    targetRir: 2,
  });
  assert.equal(f.status, 'finding', '8 reps does not meet a 10-rep criterion');
});
