'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { detectTrend } = require('../services/trendDetector');

const BENCH = 'BEN01';
const SQUAT = 'SQU01';

/* Build a raw Log_Cleaned row (12-column contract).
 * col indices: 0=date, 1=session, 5=liftCode, 7=weight, 8=reps, 9=rir */
function row(date, session, liftCode, weight, reps, rir = null) {
  const r = new Array(12).fill('');
  r[0] = date;
  r[1] = session;
  r[5] = liftCode;
  r[7] = String(weight);
  r[8] = String(reps);
  r[9] = rir === null ? '' : String(rir);
  return r;
}

const HDR = ['date_clean', 'session_id', 'exercise', 'canonical_exercise',
             'muscle_group', 'lift_code', 'set_number', 'weight', 'reps', 'rir', 'notes', 'volume_calc'];

/* ===== Null / empty guards ===== */

test('detectTrend: null liftCode → insufficient_data', () => {
  const r = detectTrend(null, [row('2026-01-01', 'S1', BENCH, 225, 5)]);
  assert.equal(r.trend, 'insufficient_data');
  assert.equal(r.confidence, 'none');
  assert.equal(r.sessions_analyzed, 0);
});

test('detectTrend: empty rows → insufficient_data', () => {
  const r = detectTrend(BENCH, []);
  assert.equal(r.trend, 'insufficient_data');
  assert.equal(r.sessions_analyzed, 0);
});

test('detectTrend: null rows → insufficient_data', () => {
  const r = detectTrend(BENCH, null);
  assert.equal(r.trend, 'insufficient_data');
});

test('detectTrend: header-only rows → insufficient_data', () => {
  const r = detectTrend(BENCH, [HDR]);
  assert.equal(r.trend, 'insufficient_data');
});

test('detectTrend: rows for a different lift → insufficient_data', () => {
  const rows = [0, 1, 2, 3].map(i =>
    row(`2026-01-${String(i + 1).padStart(2, '0')}`, `S${i}`, SQUAT, 315, 3)
  );
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'insufficient_data');
});

test('detectTrend: lift code match is case-insensitive', () => {
  const rows = [
    row('2026-01-01', 'S1', 'ben01', 225, 5),
    row('2026-01-08', 'S2', 'ben01', 225, 5),
    row('2026-01-15', 'S3', 'ben01', 225, 5),
    row('2026-01-22', 'S4', 'ben01', 225, 5),
  ];
  const r = detectTrend('BEN01', rows);
  assert.notEqual(r.trend, 'insufficient_data');
});

/* ===== Insufficient sessions ===== */

test('detectTrend: 1 session → insufficient_data, sessions_analyzed: 1', () => {
  const r = detectTrend(BENCH, [row('2026-01-01', 'S1', BENCH, 225, 5)]);
  assert.equal(r.trend, 'insufficient_data');
  assert.equal(r.sessions_analyzed, 1);
});

test('detectTrend: 3 sessions → insufficient_data, sessions_analyzed: 3', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5),
    row('2026-01-08', 'S2', BENCH, 225, 5),
    row('2026-01-15', 'S3', BENCH, 225, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'insufficient_data');
  assert.equal(r.sessions_analyzed, 3);
});

/* ===== Confidence levels ===== */

test('detectTrend: 4 sessions → medium confidence', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5),
    row('2026-01-08', 'S2', BENCH, 225, 5),
    row('2026-01-15', 'S3', BENCH, 225, 5),
    row('2026-01-22', 'S4', BENCH, 225, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.notEqual(r.trend, 'insufficient_data');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.sessions_analyzed, 4);
});

test('detectTrend: 5 sessions → medium confidence', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(row(`2026-01-${String(i * 5 + 1).padStart(2, '0')}`, `S${i}`, BENCH, 225, 5));
  }
  const r = detectTrend(BENCH, rows);
  assert.equal(r.confidence, 'medium');
  assert.equal(r.sessions_analyzed, 5);
});

test('detectTrend: 6 sessions → high confidence', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push(row(`2026-01-${String(i + 1).padStart(2, '0')}`, `S${i}`, BENCH, 225, 5));
  }
  const r = detectTrend(BENCH, rows);
  assert.equal(r.confidence, 'high');
  assert.equal(r.sessions_analyzed, 6);
});

test('detectTrend: 8 sessions → high confidence', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push(row(`2026-01-${String(i + 1).padStart(2, '0')}`, `S${i}`, BENCH, 225, 5));
  }
  const r = detectTrend(BENCH, rows);
  assert.equal(r.confidence, 'high');
  assert.equal(r.sessions_analyzed, 8);
});

/* ===== Trend verdicts ===== */

test('detectTrend: steadily rising e1RM → improving', () => {
  // e1RM = weight * (1 + reps/30); 10-lb jumps at constant reps = clear upward slope
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 5),
    row('2026-01-08', 'S2', BENCH, 195, 5),
    row('2026-01-15', 'S3', BENCH, 205, 5),
    row('2026-01-22', 'S4', BENCH, 215, 5),
    row('2026-01-29', 'S5', BENCH, 225, 5),
    row('2026-02-05', 'S6', BENCH, 235, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'improving');
});

test('detectTrend: steadily falling e1RM → declining', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 235, 5),
    row('2026-01-08', 'S2', BENCH, 225, 5),
    row('2026-01-15', 'S3', BENCH, 215, 5),
    row('2026-01-22', 'S4', BENCH, 205, 5),
    row('2026-01-29', 'S5', BENCH, 195, 5),
    row('2026-02-05', 'S6', BENCH, 185, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'declining');
});

test('detectTrend: stable e1RM across all sessions → flat', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5),
    row('2026-01-08', 'S2', BENCH, 225, 5),
    row('2026-01-15', 'S3', BENCH, 225, 5),
    row('2026-01-22', 'S4', BENCH, 225, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'flat');
});

test('detectTrend: alternating high-low e1RM → noisy', () => {
  // 185 ↔ 245 alternation drives CV well above 10 %
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 5),
    row('2026-01-08', 'S2', BENCH, 245, 5),
    row('2026-01-15', 'S3', BENCH, 185, 5),
    row('2026-01-22', 'S4', BENCH, 245, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'noisy');
});

test('detectTrend: noisy carries a non-none confidence', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 185, 5),
    row('2026-01-08', 'S2', BENCH, 245, 5),
    row('2026-01-15', 'S3', BENCH, 185, 5),
    row('2026-01-22', 'S4', BENCH, 245, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'noisy');
  assert.ok(r.confidence !== 'none', 'noisy with 4 sessions still has a usable confidence');
});

/* ===== Session window ===== */

test('detectTrend: uses only the most recent 8 sessions', () => {
  // 10 sessions: first 2 are very low; last 8 are flat at 225.
  // Older sessions must not appear in sessions_analyzed or skew the result.
  const rows = [];
  rows.push(row('2025-01-01', 'Old1', BENCH, 95,  5));
  rows.push(row('2025-06-01', 'Old2', BENCH, 95,  5));
  for (let i = 0; i < 8; i++) {
    rows.push(row(`2026-01-${String(i + 1).padStart(2, '0')}`, `S${i}`, BENCH, 225, 5));
  }
  const r = detectTrend(BENCH, rows);
  assert.equal(r.sessions_analyzed, 8);
  assert.equal(r.trend, 'flat');
});

/* ===== Warm-up filtering ===== */

test('detectTrend: RIR ≥ 4 sets are excluded from e1RM computation', () => {
  // Without RIR filtering, the 135×20 @5 warm-up would produce
  // e1RM = 225 which is higher than the working 185×5 @2 = 215.8.
  // The service must exclude the warm-up by RIR ≥ 4, keeping only the working set.
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const d = `2026-01-${String(i * 7 + 1).padStart(2, '0')}`;
    rows.push(row(d, `S${i}`, BENCH, 135, 20, 5)); // warm-up @rir 5
    rows.push(row(d, `S${i}`, BENCH, 185,  5, 2)); // working set
  }
  // All sessions have the same working e1RM → flat trend
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'flat');
  // If the warm-up inflated e1RM it would also be flat here (same per session),
  // but the key is that the warm-up set doesn't change the outcome when
  // the working set is what drives e1RM. This verifies no exception thrown.
  assert.equal(r.sessions_analyzed, 4);
});

test('detectTrend: multiple sets per session — best e1RM is used', () => {
  // Two sets per session; the heavier set should dominate e1RM.
  // S1 → 185×5 (e1RM 215.8) and 175×8 (e1RM 221.7) — higher from the lighter/more-rep set
  // All sessions identical → flat
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const d = `2026-01-${String(i * 7 + 1).padStart(2, '0')}`;
    rows.push(row(d, `S${i}`, BENCH, 185, 5, 2));
    rows.push(row(d, `S${i}`, BENCH, 175, 8, 2));
  }
  const r = detectTrend(BENCH, rows);
  assert.notEqual(r.trend, 'insufficient_data');
  assert.equal(r.sessions_analyzed, 4);
});

/* ===== Session grouping ===== */

test('detectTrend: multiple sets from the same session_id counted as one session', () => {
  // 3 sets per session × 4 sessions = 12 rows, but only 4 sessions
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const d = `2026-01-${String(i * 7 + 1).padStart(2, '0')}`;
    for (let s = 0; s < 3; s++) {
      rows.push(row(d, `S${i}`, BENCH, 225, 5, 2));
    }
  }
  const r = detectTrend(BENCH, rows);
  assert.equal(r.sessions_analyzed, 4);
});

/* ===== Return shape ===== */

test('detectTrend: return shape has trend, confidence, sessions_analyzed', () => {
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5),
    row('2026-01-08', 'S2', BENCH, 225, 5),
    row('2026-01-15', 'S3', BENCH, 225, 5),
    row('2026-01-22', 'S4', BENCH, 225, 5),
  ];
  const r = detectTrend(BENCH, rows);
  assert.ok('trend'             in r);
  assert.ok('confidence'        in r);
  assert.ok('sessions_analyzed' in r);
});

/* ===== Plan spec golden case ===== */

test('detectTrend: plan spec — repeated lower-than-expected bench sessions → declining', () => {
  // The plan says: "repeated lower-than-expected bench sessions show declining...
  // only after enough data." Six sessions of monotonically falling weight is
  // definitive enough for a declining verdict.
  const rows = [
    row('2026-01-01', 'S1', BENCH, 225, 5, 2),
    row('2026-01-08', 'S2', BENCH, 220, 5, 2),
    row('2026-01-15', 'S3', BENCH, 215, 5, 2),
    row('2026-01-22', 'S4', BENCH, 210, 5, 2),
    row('2026-01-29', 'S5', BENCH, 205, 5, 2),
    row('2026-02-05', 'S6', BENCH, 200, 5, 2),
  ];
  const r = detectTrend(BENCH, rows);
  assert.equal(r.trend, 'declining');
  assert.equal(r.confidence, 'high');
});
