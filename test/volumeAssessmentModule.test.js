'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyMuscleVolume,
  assessSessionVolume,
  assessWeeklyVolume,
} = require('../services/volumeAssessmentModule');
const { _resetForTesting } = require('../services/volumeModule');

beforeEach(() => _resetForTesting());

// Landmarks used in these tests (from config/coaching/volume/landmarks.json):
//   quadriceps:      mev=8,  mav=12, mrv=20
//   pectoralis major: mev=8, mav=12, mrv=20
//   gluteus maximus: mev=0,  mav=6,  mrv=16
//   triceps brachii: mev=4,  mav=10, mrv=18

// --- classifyMuscleVolume: invalid inputs ---

test('classifyMuscleVolume: null muscle → null', () => {
  assert.strictEqual(classifyMuscleVolume(null, 10), null);
});

test('classifyMuscleVolume: empty-string muscle → null', () => {
  assert.strictEqual(classifyMuscleVolume('', 10), null);
});

test('classifyMuscleVolume: non-string muscle → null', () => {
  assert.strictEqual(classifyMuscleVolume(42, 10), null);
  assert.strictEqual(classifyMuscleVolume(undefined, 10), null);
});

test('classifyMuscleVolume: negative weeklySets → null', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', -1), null);
});

test('classifyMuscleVolume: NaN weeklySets → null', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', NaN), null);
});

test('classifyMuscleVolume: non-number weeklySets → null', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', '10'), null);
  assert.strictEqual(classifyMuscleVolume('quadriceps', null), null);
});

test('classifyMuscleVolume: unknown muscle → null', () => {
  assert.strictEqual(classifyMuscleVolume('invisible muscle', 10), null);
});

// --- classifyMuscleVolume: zone transitions (quadriceps mev=8, mav=12, mrv=20) ---

test('classifyMuscleVolume: 0 sets → below_mev', () => {
  const r = classifyMuscleVolume('quadriceps', 0);
  assert.strictEqual(r.zone, 'below_mev');
});

test('classifyMuscleVolume: 7 sets → below_mev (just under mev=8)', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', 7).zone, 'below_mev');
});

test('classifyMuscleVolume: 8 sets → mev_to_mav (at mev)', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', 8).zone, 'mev_to_mav');
});

test('classifyMuscleVolume: 10 sets → mev_to_mav (between mev and mav)', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', 10).zone, 'mev_to_mav');
});

test('classifyMuscleVolume: 12 sets → mav_to_mrv (at mav)', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', 12).zone, 'mav_to_mrv');
});

test('classifyMuscleVolume: 16 sets → mav_to_mrv (between mav and mrv)', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', 16).zone, 'mav_to_mrv');
});

test('classifyMuscleVolume: 20 sets → mav_to_mrv (at mrv)', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', 20).zone, 'mav_to_mrv');
});

test('classifyMuscleVolume: 21 sets → above_mrv (just over mrv=20)', () => {
  assert.strictEqual(classifyMuscleVolume('quadriceps', 21).zone, 'above_mrv');
});

// --- classifyMuscleVolume: distance arithmetic ---

test('classifyMuscleVolume: distanceToMav = mav − weeklySets', () => {
  const r = classifyMuscleVolume('quadriceps', 9);
  // mav=12, weeklySets=9 → distanceToMav = 3
  assert.strictEqual(r.distanceToMav, 3);
});

test('classifyMuscleVolume: distanceToMav negative when above MAV', () => {
  const r = classifyMuscleVolume('quadriceps', 16);
  // mav=12, weeklySets=16 → distanceToMav = -4
  assert.strictEqual(r.distanceToMav, -4);
});

test('classifyMuscleVolume: distanceToMrv = mrv − weeklySets', () => {
  const r = classifyMuscleVolume('quadriceps', 14);
  // mrv=20, weeklySets=14 → distanceToMrv = 6
  assert.strictEqual(r.distanceToMrv, 6);
});

test('classifyMuscleVolume: distanceToMrv negative when above MRV', () => {
  const r = classifyMuscleVolume('quadriceps', 25);
  // mrv=20, weeklySets=25 → distanceToMrv = -5
  assert.strictEqual(r.distanceToMrv, -5);
});

// --- classifyMuscleVolume: result shape ---

test('classifyMuscleVolume: result contains muscle, weeklySets, zone, landmarks, distances', () => {
  const r = classifyMuscleVolume('quadriceps', 10);
  assert.strictEqual(r.muscle, 'quadriceps');
  assert.strictEqual(r.weeklySets, 10);
  assert.strictEqual(typeof r.zone, 'string');
  assert.strictEqual(r.landmarks.mev, 8);
  assert.strictEqual(r.landmarks.mav, 12);
  assert.strictEqual(r.landmarks.mrv, 20);
  assert.strictEqual(typeof r.distanceToMav, 'number');
  assert.strictEqual(typeof r.distanceToMrv, 'number');
});

test('classifyMuscleVolume: case-insensitive muscle lookup (VolumeModule normalises)', () => {
  // getVolumeLandmarks normalises to lowercase; our function passes through unchanged
  const r = classifyMuscleVolume('Quadriceps', 10);
  assert.ok(r !== null);
  assert.strictEqual(r.zone, 'mev_to_mav');
});

test('classifyMuscleVolume: gluteus maximus mev=0 → 0 sets is mev_to_mav', () => {
  // mev=0, mav=6, mrv=16 — zero sets meets the mev
  assert.strictEqual(classifyMuscleVolume('gluteus maximus', 0).zone, 'mev_to_mav');
});

// --- assessSessionVolume: invalid inputs ---

test('assessSessionVolume: non-array → null', () => {
  assert.strictEqual(assessSessionVolume(null), null);
  assert.strictEqual(assessSessionVolume('bench-press'), null);
  assert.strictEqual(assessSessionVolume(42), null);
});

// --- assessSessionVolume: empty / no-op ---

test('assessSessionVolume: empty array → empty sets, empty tracked and untracked', () => {
  const r = assessSessionVolume([]);
  assert.deepEqual(r.muscleSets, {});
  assert.deepEqual(r.trackedMuscles, []);
  assert.deepEqual(r.untrackedMuscles, []);
});

// --- assessSessionVolume: set counting ---

test('assessSessionVolume: back-squat 3 sets → quadriceps and gluteus maximus in muscleSets', () => {
  const r = assessSessionVolume([{ exerciseId: 'back-squat', sets: 3 }]);
  assert.strictEqual(r.muscleSets['quadriceps'], 3);
  assert.strictEqual(r.muscleSets['gluteus maximus'], 3);
});

test('assessSessionVolume: unknown exercise → empty result', () => {
  const r = assessSessionVolume([{ exerciseId: 'machine-chest-press', sets: 3 }]);
  assert.deepEqual(r.muscleSets, {});
  assert.deepEqual(r.trackedMuscles, []);
  assert.deepEqual(r.untrackedMuscles, []);
});

test('assessSessionVolume: two exercises accumulate shared primary muscle', () => {
  // back-squat + leg-extension both hit quadriceps as primary
  const r = assessSessionVolume([
    { exerciseId: 'back-squat', sets: 3 },
    { exerciseId: 'leg-extension', sets: 4 },
  ]);
  assert.strictEqual(r.muscleSets['quadriceps'], 7);
});

// --- assessSessionVolume: tracked vs untracked ---

test('assessSessionVolume: muscles with landmarks appear in trackedMuscles', () => {
  const r = assessSessionVolume([{ exerciseId: 'bench-press', sets: 3 }]);
  // pectoralis major, anterior deltoid, triceps brachii — all have landmarks
  assert.ok(r.trackedMuscles.includes('pectoralis major'));
  assert.ok(r.trackedMuscles.includes('anterior deltoid'));
  assert.ok(r.trackedMuscles.includes('triceps brachii'));
  assert.deepEqual(r.untrackedMuscles, []);
});

test('assessSessionVolume: invalid entries in array are skipped (VolumeModule handles)', () => {
  const r = assessSessionVolume([null, { exerciseId: 'back-squat', sets: 3 }]);
  assert.strictEqual(r.muscleSets['quadriceps'], 3);
});

// --- assessWeeklyVolume: invalid inputs ---

test('assessWeeklyVolume: non-array → {}', () => {
  assert.deepEqual(assessWeeklyVolume(null), {});
  assert.deepEqual(assessWeeklyVolume('string'), {});
});

test('assessWeeklyVolume: empty array → {}', () => {
  assert.deepEqual(assessWeeklyVolume([]), {});
});

// --- assessWeeklyVolume: single session ---

test('assessWeeklyVolume: single session with 3 quad sets → below_mev (mev=8)', () => {
  const r = assessWeeklyVolume([{ quadriceps: 3 }]);
  assert.ok('quadriceps' in r);
  assert.strictEqual(r['quadriceps'].zone, 'below_mev');
  assert.strictEqual(r['quadriceps'].weeklySets, 3);
});

test('assessWeeklyVolume: 12 quad sets → mav_to_mrv', () => {
  const r = assessWeeklyVolume([{ quadriceps: 12 }]);
  assert.strictEqual(r['quadriceps'].zone, 'mav_to_mrv');
});

// --- assessWeeklyVolume: accumulation across sessions ---

test('assessWeeklyVolume: two sessions accumulate quad sets', () => {
  // session 1: 5 quad sets, session 2: 6 quad sets → 11 weekly (mev_to_mav)
  const r = assessWeeklyVolume([{ quadriceps: 5 }, { quadriceps: 6 }]);
  assert.strictEqual(r['quadriceps'].weeklySets, 11);
  assert.strictEqual(r['quadriceps'].zone, 'mev_to_mav');
});

test('assessWeeklyVolume: three sessions crossing MAV → mav_to_mrv', () => {
  // 5 + 5 + 5 = 15 quad sets → mav_to_mrv (mav=12)
  const r = assessWeeklyVolume([{ quadriceps: 5 }, { quadriceps: 5 }, { quadriceps: 5 }]);
  assert.strictEqual(r['quadriceps'].weeklySets, 15);
  assert.strictEqual(r['quadriceps'].zone, 'mav_to_mrv');
});

// --- assessWeeklyVolume: landmark distance fields ---

test('assessWeeklyVolume: result includes landmarks and distances', () => {
  const r = assessWeeklyVolume([{ quadriceps: 10 }]);
  const q = r['quadriceps'];
  assert.strictEqual(q.landmarks.mev, 8);
  assert.strictEqual(q.landmarks.mav, 12);
  assert.strictEqual(q.landmarks.mrv, 20);
  assert.strictEqual(q.distanceToMav, 2);   // 12 - 10
  assert.strictEqual(q.distanceToMrv, 10);  // 20 - 10
});

test('assessWeeklyVolume: distanceToMav is negative when above MAV', () => {
  // 16 quad sets: above mav=12, below mrv=20
  const r = assessWeeklyVolume([{ quadriceps: 16 }]);
  assert.strictEqual(r['quadriceps'].distanceToMav, -4);
  assert.ok(r['quadriceps'].distanceToMrv > 0);
});

// --- assessWeeklyVolume: untracked muscles excluded ---

test('assessWeeklyVolume: muscles with no landmarks excluded from result', () => {
  // 'unknown muscle' has no landmark entry; quadriceps does
  const r = assessWeeklyVolume([{ quadriceps: 10, 'unknown muscle': 5 }]);
  assert.ok('quadriceps' in r);
  assert.ok(!('unknown muscle' in r));
});

// --- assessWeeklyVolume: round-trip with assessSessionVolume ---

test('assessWeeklyVolume: round-trip from assessSessionVolume muscleSets', () => {
  // compute session sets, then assess weekly from those
  const session = assessSessionVolume([{ exerciseId: 'back-squat', sets: 4 }]);
  const weekly = assessWeeklyVolume([session.muscleSets]);
  // quadriceps: 4 sets < mev=8 → below_mev
  assert.strictEqual(weekly['quadriceps'].zone, 'below_mev');
  assert.strictEqual(weekly['quadriceps'].weeklySets, 4);
  // gluteus maximus: 4 sets < mav=6 → mev_to_mav (mev=0)
  assert.strictEqual(weekly['gluteus maximus'].zone, 'mev_to_mav');
});
