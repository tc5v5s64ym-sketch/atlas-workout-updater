'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { computeExpectedPerformance } = require('../services/expectedPerformance');

/* ===== Helpers ===== */

// Build a raw Log_Cleaned row (12-column contract).
// col indices: 0=date, 1=session, 5=liftCode, 7=weight, 8=reps, 9=rir
function row(date, session, liftCode, weight, reps, rir = '') {
  const r = new Array(12).fill('');
  r[0] = date;
  r[1] = session;
  r[5] = liftCode;
  r[7] = String(weight);
  r[8] = String(reps);
  r[9] = rir === null ? '' : String(rir);
  return r;
}

const BENCH = 'BEN01';
const SQUAT = 'SQU01';
const HDR   = ['date_clean', 'session_id', 'exercise', 'canonical_exercise',
               'muscle_group', 'lift_code', 'set_number', 'weight', 'reps',
               'rir', 'notes', 'volume_calc'];

/* ===== Null / invalid inputs ===== */

test('computeExpectedPerformance: null liftCode returns null', () => {
  const r = computeExpectedPerformance(null, [row('2026-01-01', 'S1', BENCH, 185, 8, 2)], 185);
  assert.equal(r, null);
});

test('computeExpectedPerformance: empty rows returns null', () => {
  assert.equal(computeExpectedPerformance(BENCH, [], 185), null);
});

test('computeExpectedPerformance: null rows returns null', () => {
  assert.equal(computeExpectedPerformance(BENCH, null, 185), null);
});

test('computeExpectedPerformance: zero todayWeight returns null', () => {
  assert.equal(computeExpectedPerformance(BENCH, [row('2026-01-01', 'S1', BENCH, 185, 8, 2)], 0), null);
});

test('computeExpectedPerformance: non-numeric todayWeight returns null', () => {
  assert.equal(computeExpectedPerformance(BENCH, [row('2026-01-01', 'S1', BENCH, 185, 8, 2)], 'heavy'), null);
});

test('computeExpectedPerformance: header-only rows returns null', () => {
  assert.equal(computeExpectedPerformance(BENCH, [HDR], 185), null);
});

test('computeExpectedPerformance: wrong lift code returns null', () => {
  const rows = [row('2026-01-01', 'S1', SQUAT, 185, 8, 2)];
  assert.equal(computeExpectedPerformance(BENCH, rows, 185), null);
});

/* ===== Insufficient data ===== */

test('computeExpectedPerformance: fewer than 3 sessions returns null', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8, 2),
    row('2026-01-08', 'S2', BENCH, 185, 9, 2),
  ];
  assert.equal(computeExpectedPerformance(BENCH, rows, 185), null);
});

test('computeExpectedPerformance: 3 sessions in window returns result (meets minimum)', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  2),
    row('2026-01-08', 'S2', BENCH, 185, 9,  2),
    row('2026-01-15', 'S3', BENCH, 185, 10, 2),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.notEqual(r, null);
  assert.equal(r.basis.sampleSize, 3);
  assert.equal(r.basis.confidence, 'medium');
});

/* ===== Weight window ===== */

test('computeExpectedPerformance: excludes rows outside ±10% window', () => {
  // Today: 185 → window [166.5, 203.5]
  const rows = [
    row('2026-01-01', 'S1', BENCH, 135, 10, 2),  // below window
    row('2026-01-08', 'S2', BENCH, 225, 5,  2),  // above window
    row('2026-01-15', 'S3', BENCH, 185, 8,  2),  // in window
  ];
  // Only 1 session in window → insufficient data
  assert.equal(computeExpectedPerformance(BENCH, rows, 185), null);
});

test('computeExpectedPerformance: includes rows within ±10% window (180–200 for today=190)', () => {
  // Today: 190 → window [171, 209]; 185 and 195 both qualify
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 10, 2),
    row('2026-01-08', 'S2', BENCH, 190, 9,  2),
    row('2026-01-15', 'S3', BENCH, 195, 8,  2),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 190);
  assert.notEqual(r, null);
  assert.equal(r.basis.sampleSize, 3);
});

/* ===== Warm-up exclusion ===== */

test('computeExpectedPerformance: excludes sets with rir >= 4 at the target weight', () => {
  // Three sessions each with a warm-up set (rir=4) at 185 and a working set (rir=2).
  // Expected reps should come from the working sets only.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 15, 4),  // warm-up at 185
    row('2026-01-01', 'S1', BENCH, 185, 8,  2),  // working at 185
    row('2026-01-08', 'S2', BENCH, 185, 15, 4),  // warm-up at 185
    row('2026-01-08', 'S2', BENCH, 185, 8,  2),  // working at 185
    row('2026-01-15', 'S3', BENCH, 185, 15, 4),  // warm-up at 185
    row('2026-01-15', 'S3', BENCH, 185, 9,  2),  // working at 185
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.notEqual(r, null);
  // expectedReps should be from the 8/8/9 working sets, not the 15-rep warm-ups
  assert.equal(r.expectedReps, 8);
  assert.equal(r.basis.sampleSize, 3);
});

test('computeExpectedPerformance: keeps sets with no RIR (cannot classify as warm-up)', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  null),
    row('2026-01-08', 'S2', BENCH, 185, 9,  null),
    row('2026-01-15', 'S3', BENCH, 185, 10, null),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.notEqual(r, null);
  assert.equal(r.expectedReps, 9);
  assert.equal(r.expectedRirRange, null);   // no RIR data → null
});

/* ===== Session grouping (one representative per session) ===== */

test('computeExpectedPerformance: multiple sets per session — keeps highest-reps set', () => {
  // Each session has 3 sets at 185; the session representative should be the
  // highest-reps set (10, 9, 8 respectively across sessions).
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  2),
    row('2026-01-01', 'S1', BENCH, 185, 9,  1),
    row('2026-01-01', 'S1', BENCH, 185, 10, 1),  // ← best in session S1
    row('2026-01-08', 'S2', BENCH, 185, 7,  2),
    row('2026-01-08', 'S2', BENCH, 185, 9,  2),  // ← best in session S2
    row('2026-01-15', 'S3', BENCH, 185, 6,  2),
    row('2026-01-15', 'S3', BENCH, 185, 8,  2),  // ← best in session S3
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.notEqual(r, null);
  assert.equal(r.basis.sampleSize, 3);          // 3 sessions, not 7 sets
  assert.equal(r.expectedReps, 9);              // median of [10, 9, 8]
});

/* ===== Expected reps computation ===== */

test('computeExpectedPerformance: expectedReps is median of recent session reps', () => {
  // 5 sessions: reps = 8, 9, 10, 11, 12 → median = 10
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  2),
    row('2026-01-08', 'S2', BENCH, 185, 9,  2),
    row('2026-01-15', 'S3', BENCH, 185, 10, 2),
    row('2026-01-22', 'S4', BENCH, 185, 11, 1),
    row('2026-01-29', 'S5', BENCH, 185, 12, 1),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.equal(r.expectedReps, 10);
});

test('computeExpectedPerformance: expectedReps rounds to nearest whole rep for even-size array', () => {
  // 4 sessions: reps = 8, 9, 10, 11 → median = (9+10)/2 = 9.5 → rounds to 10
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  2),
    row('2026-01-08', 'S2', BENCH, 185, 9,  2),
    row('2026-01-15', 'S3', BENCH, 185, 10, 2),
    row('2026-01-22', 'S4', BENCH, 185, 11, 1),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.equal(r.expectedReps, 10);
});

/* ===== RIR range ===== */

test('computeExpectedPerformance: expectedRirRange spans min and max RIR in recent sessions', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  3),
    row('2026-01-08', 'S2', BENCH, 185, 9,  2),
    row('2026-01-15', 'S3', BENCH, 185, 10, 1),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.deepEqual(r.expectedRirRange, { min: 1, max: 3 });
});

test('computeExpectedPerformance: expectedRirRange null when no session has RIR data', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  null),
    row('2026-01-08', 'S2', BENCH, 185, 9,  null),
    row('2026-01-15', 'S3', BENCH, 185, 10, null),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.equal(r.expectedRirRange, null);
});

test('computeExpectedPerformance: expectedRirRange uses only sessions that have RIR data', () => {
  // Mix of sessions with and without RIR
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8,  null),
    row('2026-01-08', 'S2', BENCH, 185, 9,  2),
    row('2026-01-15', 'S3', BENCH, 185, 10, 1),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.deepEqual(r.expectedRirRange, { min: 1, max: 2 });
});

/* ===== Recency window ===== */

test('computeExpectedPerformance: uses at most 6 most recent sessions', () => {
  // 8 sessions; the oldest 2 should be ignored
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    rows.push(row(`2026-${String(i).padStart(2, '0')}-01`, `S${i}`, BENCH, 185, i + 4, 2));
  }
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.notEqual(r, null);
  assert.equal(r.basis.sampleSize, 6);
  // The 6 most recent sessions have reps 7,8,9,10,11,12 → median of those = (9+10)/2 = 9.5 → 10
  assert.equal(r.expectedReps, 10);
});

/* ===== Confidence ===== */

test('computeExpectedPerformance: confidence high when 5+ sessions', () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) {
    rows.push(row(`2026-0${String(i).padStart(2,'0')}-01`, `S${i}`, BENCH, 185, 8 + i, 2));
  }
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.equal(r.basis.confidence, 'high');
});

test('computeExpectedPerformance: confidence medium when 3–4 sessions', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 8, 2),
    row('2026-01-08', 'S2', BENCH, 185, 9, 2),
    row('2026-01-15', 'S3', BENCH, 185, 10, 2),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.equal(r.basis.confidence, 'medium');
});

/* ===== Weight window metadata ===== */

test('computeExpectedPerformance: basis.weightWindow reflects actual weights used', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 182, 9, 2),
    row('2026-01-08', 'S2', BENCH, 185, 9, 2),
    row('2026-01-15', 'S3', BENCH, 190, 8, 2),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.equal(r.basis.weightWindow.min, 182);
  assert.equal(r.basis.weightWindow.max, 190);
});

/* ===== Plan spec golden test ===== */

test('computeExpectedPerformance: spec golden — bench history at 185 expects ~10-12 reps', () => {
  // Simulates the app-test-hold scenario from the plan: "Bench 185×8 @2 should know
  // 185 historically expects closer to 10–12 reps @2 if data supports it."
  // If the lifter's last 5 bench sessions at 185 were all 10–12 reps, the engine
  // should return an expectedReps in the 10–12 range.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 10, 2),
    row('2026-01-08', 'S2', BENCH, 185, 11, 2),
    row('2026-01-15', 'S3', BENCH, 185, 12, 1),
    row('2026-01-22', 'S4', BENCH, 185, 10, 2),
    row('2026-01-29', 'S5', BENCH, 185, 11, 1),
  ];
  const r = computeExpectedPerformance(BENCH, rows, 185);
  assert.notEqual(r, null);
  assert.ok(r.expectedReps >= 10 && r.expectedReps <= 12,
    `expectedReps ${r.expectedReps} should be in 10–12 range`);
  assert.equal(r.basis.confidence, 'high');
  assert.notEqual(r.expectedRirRange, null);
  assert.ok(r.expectedRirRange.min >= 1 && r.expectedRirRange.max <= 2);
});

/* ===== Lift code case-insensitivity ===== */

test('computeExpectedPerformance: liftCode match is case-insensitive', () => {
  const rows = [
    row('2026-01-01', 'S1', 'ben01', 185, 8,  2),
    row('2026-01-08', 'S2', 'BEN01', 185, 9,  2),
    row('2026-01-15', 'S3', 'Ben01', 185, 10, 2),
  ];
  const r = computeExpectedPerformance('BEN01', rows, 185);
  assert.notEqual(r, null);
  assert.equal(r.basis.sampleSize, 3);
});
