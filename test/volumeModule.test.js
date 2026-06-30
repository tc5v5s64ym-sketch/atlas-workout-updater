'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getVolumeLandmarks,
  getAllVolumeLandmarks,
  computeExerciseSets,
  computeSessionSets,
  computeWeeklySets,
  volumeZone,
  _resetForTesting,
} = require('../services/volumeModule');

beforeEach(() => _resetForTesting());

// --- computeExerciseSets ---

test('computeExerciseSets: back-squat 3 sets → 3 each to quadriceps and gluteus maximus', () => {
  const result = computeExerciseSets('back-squat', 3);
  assert.strictEqual(result['quadriceps'], 3);
  assert.strictEqual(result['gluteus maximus'], 3);
  // secondary muscles (hamstrings, adductors) must NOT appear
  assert.strictEqual(result['hamstrings'], undefined);
  assert.strictEqual(result['adductors'], undefined);
});

test('computeExerciseSets: bench-press 4 sets → 4 each to pectoralis major, anterior deltoid, triceps brachii', () => {
  const result = computeExerciseSets('bench-press', 4);
  assert.strictEqual(result['pectoralis major'], 4);
  assert.strictEqual(result['anterior deltoid'], 4);
  assert.strictEqual(result['triceps brachii'], 4);
});

test('computeExerciseSets: skull-crusher normalises "triceps brachii (long head)" → "triceps brachii"', () => {
  const result = computeExerciseSets('skull-crusher', 3);
  assert.strictEqual(result['triceps brachii'], 3);
  // parenthetical variant must not remain as a separate key
  assert.ok(!Object.keys(result).some(k => k.includes('(')));
});

test('computeExerciseSets: leg-extension normalises "quadriceps (…)" → "quadriceps"', () => {
  const result = computeExerciseSets('leg-extension', 3);
  assert.strictEqual(result['quadriceps'], 3);
  assert.ok(!Object.keys(result).some(k => k.includes('(')));
});

test('computeExerciseSets: incline-bench-press normalises "pectoralis major (upper/clavicular head)" → "pectoralis major"', () => {
  const result = computeExerciseSets('incline-bench-press', 3);
  assert.strictEqual(result['pectoralis major'], 3);
  assert.ok(!Object.keys(result).some(k => k.includes('(')));
});

test('computeExerciseSets: unknown exercise returns empty object', () => {
  assert.deepEqual(computeExerciseSets('machine-chest-press', 3), {});
});

test('computeExerciseSets: non-string exercise id returns empty object', () => {
  assert.deepEqual(computeExerciseSets(null, 3), {});
  assert.deepEqual(computeExerciseSets(undefined, 3), {});
  assert.deepEqual(computeExerciseSets('', 3), {});
});

test('computeExerciseSets: non-positive sets returns empty object', () => {
  assert.deepEqual(computeExerciseSets('back-squat', 0), {});
  assert.deepEqual(computeExerciseSets('back-squat', -1), {});
});

// --- computeSessionSets ---

test('computeSessionSets: back-squat 3 sets → 3 each to quadriceps and gluteus maximus', () => {
  const result = computeSessionSets([{ exerciseId: 'back-squat', sets: 3 }]);
  assert.strictEqual(result['quadriceps'], 3);
  assert.strictEqual(result['gluteus maximus'], 3);
});

test('computeSessionSets: two exercises accumulate sets for the shared quadriceps', () => {
  // back-squat (primary: quadriceps) + leg-extension (primary: quadriceps) = 6 quad sets
  const result = computeSessionSets([
    { exerciseId: 'back-squat', sets: 3 },
    { exerciseId: 'leg-extension', sets: 3 },
  ]);
  assert.strictEqual(result['quadriceps'], 6);
  assert.strictEqual(result['gluteus maximus'], 3);
});

test('computeSessionSets: push + pull session accumulates distinct muscles without overlap', () => {
  const result = computeSessionSets([
    { exerciseId: 'bench-press', sets: 3 },
    { exerciseId: 'pull-up', sets: 3 },
  ]);
  assert.strictEqual(result['pectoralis major'], 3);
  assert.strictEqual(result['latissimus dorsi'], 3);
  assert.strictEqual(result['biceps brachii'], 3);
  // secondary muscles of pull-up (mid-back, posterior deltoid) must NOT appear
  assert.strictEqual(result['mid-back'], undefined);
});

test('computeSessionSets: unknown exercise is silently skipped', () => {
  const result = computeSessionSets([
    { exerciseId: 'machine-chest-press', sets: 3 },
    { exerciseId: 'bench-press', sets: 4 },
  ]);
  assert.strictEqual(result['pectoralis major'], 4);
});

test('computeSessionSets: entry with non-positive sets is skipped', () => {
  const result = computeSessionSets([
    { exerciseId: 'bench-press', sets: 0 },
    { exerciseId: 'back-squat', sets: 3 },
  ]);
  assert.strictEqual(result['pectoralis major'], undefined);
  assert.strictEqual(result['quadriceps'], 3);
});

test('computeSessionSets: empty array returns empty object', () => {
  assert.deepEqual(computeSessionSets([]), {});
});

test('computeSessionSets: non-array returns empty object', () => {
  assert.deepEqual(computeSessionSets(null), {});
  assert.deepEqual(computeSessionSets({}), {});
  assert.deepEqual(computeSessionSets('bench-press'), {});
});

// --- computeWeeklySets ---

test('computeWeeklySets: aggregates two sessions for the same muscle', () => {
  const session1 = computeSessionSets([{ exerciseId: 'back-squat', sets: 4 }]);
  const session2 = computeSessionSets([{ exerciseId: 'leg-extension', sets: 3 }]);
  const weekly = computeWeeklySets([session1, session2]);
  assert.strictEqual(weekly['quadriceps'], 7); // 4 + 3
  assert.strictEqual(weekly['gluteus maximus'], 4); // session1 only
});

test('computeWeeklySets: three sessions accumulate correctly', () => {
  const s = { exerciseId: 'bench-press', sets: 3 };
  const result = computeWeeklySets([
    computeSessionSets([s]),
    computeSessionSets([s]),
    computeSessionSets([s]),
  ]);
  assert.strictEqual(result['pectoralis major'], 9);
  assert.strictEqual(result['triceps brachii'], 9);
});

test('computeWeeklySets: empty sessions array returns empty object', () => {
  assert.deepEqual(computeWeeklySets([]), {});
});

test('computeWeeklySets: non-array returns empty object', () => {
  assert.deepEqual(computeWeeklySets(null), {});
  assert.deepEqual(computeWeeklySets('week'), {});
});

// --- getVolumeLandmarks ---

test('getVolumeLandmarks: quadriceps returns expected MEV/MAV/MRV shape', () => {
  const lm = getVolumeLandmarks('quadriceps');
  assert.ok(lm, 'should return a landmark object');
  assert.ok(typeof lm.mev === 'number' && lm.mev >= 0);
  assert.ok(typeof lm.mav === 'number' && lm.mav > lm.mev);
  assert.ok(typeof lm.mrv === 'number' && lm.mrv > lm.mav);
});

test('getVolumeLandmarks: case-insensitive lookup', () => {
  const lower = getVolumeLandmarks('quadriceps');
  const upper = getVolumeLandmarks('Quadriceps');
  assert.deepEqual(lower, upper);
});

test('getVolumeLandmarks: parenthetical variant resolves to same landmarks as canonical', () => {
  const canonical = getVolumeLandmarks('quadriceps');
  const variant = getVolumeLandmarks('quadriceps (rectus femoris, vastus lateralis, vastus medialis, vastus intermedius)');
  assert.deepEqual(canonical, variant);
});

test('getVolumeLandmarks: pectoralis major variant resolves to pectoralis major', () => {
  const canonical = getVolumeLandmarks('pectoralis major');
  const variant = getVolumeLandmarks('pectoralis major (upper/clavicular head)');
  assert.deepEqual(canonical, variant);
});

test('getVolumeLandmarks: untracked muscle returns null', () => {
  assert.strictEqual(getVolumeLandmarks('adductors'), null);
  assert.strictEqual(getVolumeLandmarks('brachialis'), null);
  assert.strictEqual(getVolumeLandmarks('serratus anterior'), null);
});

test('getVolumeLandmarks: null and empty string return null', () => {
  assert.strictEqual(getVolumeLandmarks(null), null);
  assert.strictEqual(getVolumeLandmarks(''), null);
  assert.strictEqual(getVolumeLandmarks(undefined), null);
});

// --- getAllVolumeLandmarks ---

test('getAllVolumeLandmarks: returns an array', () => {
  assert.ok(Array.isArray(getAllVolumeLandmarks()));
});

test('getAllVolumeLandmarks: every entry has muscle, mev, mav, mrv', () => {
  for (const lm of getAllVolumeLandmarks()) {
    assert.ok(typeof lm.muscle === 'string' && lm.muscle.length > 0, 'missing muscle');
    assert.ok(typeof lm.mev === 'number', `${lm.muscle}: mev not a number`);
    assert.ok(typeof lm.mav === 'number', `${lm.muscle}: mav not a number`);
    assert.ok(typeof lm.mrv === 'number', `${lm.muscle}: mrv not a number`);
  }
});

test('getAllVolumeLandmarks: all tracked muscles have mav > mev and mrv > mav', () => {
  for (const lm of getAllVolumeLandmarks()) {
    assert.ok(lm.mav >= lm.mev, `${lm.muscle}: mav must be >= mev`);
    assert.ok(lm.mrv > lm.mav, `${lm.muscle}: mrv must be > mav`);
  }
});

test('getAllVolumeLandmarks: 16 muscles tracked', () => {
  assert.strictEqual(getAllVolumeLandmarks().length, 16);
});

// --- volumeZone ---

test('volumeZone: 0 sets → below_mev for quadriceps', () => {
  assert.strictEqual(volumeZone(0, 'quadriceps'), 'below_mev');
});

test('volumeZone: at MEV → mev_to_mav', () => {
  const { mev } = getVolumeLandmarks('quadriceps');
  assert.strictEqual(volumeZone(mev, 'quadriceps'), 'mev_to_mav');
});

test('volumeZone: between MEV and MAV → mev_to_mav', () => {
  const { mev, mav } = getVolumeLandmarks('quadriceps');
  const mid = Math.floor((mev + mav) / 2);
  assert.strictEqual(volumeZone(mid, 'quadriceps'), 'mev_to_mav');
});

test('volumeZone: at MAV → mav_to_mrv', () => {
  const { mav } = getVolumeLandmarks('quadriceps');
  assert.strictEqual(volumeZone(mav, 'quadriceps'), 'mav_to_mrv');
});

test('volumeZone: at MRV → mav_to_mrv', () => {
  const { mrv } = getVolumeLandmarks('quadriceps');
  assert.strictEqual(volumeZone(mrv, 'quadriceps'), 'mav_to_mrv');
});

test('volumeZone: above MRV → above_mrv', () => {
  const { mrv } = getVolumeLandmarks('quadriceps');
  assert.strictEqual(volumeZone(mrv + 1, 'quadriceps'), 'above_mrv');
});

test('volumeZone: untracked muscle returns null', () => {
  assert.strictEqual(volumeZone(10, 'adductors'), null);
});

test('volumeZone: negative sets returns null', () => {
  assert.strictEqual(volumeZone(-1, 'quadriceps'), null);
});

// --- End-to-end: session → weekly → zone ---

test('end-to-end: two squat sessions accumulate to MAV-range quadriceps volume', () => {
  // 3 squat sessions × 4 sets each = 12 quad sets → at MAV for quadriceps (mev=8, mav=12, mrv=20)
  const s = { exerciseId: 'back-squat', sets: 4 };
  const sessions = [
    computeSessionSets([s]),
    computeSessionSets([s]),
    computeSessionSets([s]),
  ];
  const weekly = computeWeeklySets(sessions);
  assert.strictEqual(weekly['quadriceps'], 12);
  assert.strictEqual(volumeZone(weekly['quadriceps'], 'quadriceps'), 'mav_to_mrv');
});
