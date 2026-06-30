'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  assessExpectedPerformance,
  detectLiftPlateaus,
  assessLift,
} = require('../services/expectedPerformanceModule');

// ─── Shared helpers ──────────────────────────────────────────────────────────

function entry(overrides) {
  return {
    date_clean:         '2026-01-01',
    session_id:         'S1',
    canonical_exercise: 'Back Squat',
    exercise:           'Back Squat',
    lift_code:          'SQUAT',
    weight:             200,
    reps:               5,
    rir:                2,
    notes:              '',
    ...overrides,
  };
}

// 3 sessions at 200 lb, same reps → flat e1RM (stall) + enough data for expected perf.
function flatSquatEntries() {
  return [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 5 }),
  ];
}

// 3 sessions at 200 lb with improving reps → e1RM rises (no stall).
function improvingSquatEntries() {
  return [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 3 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 4 }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 5 }),
  ];
}

// ─── assessExpectedPerformance ───────────────────────────────────────────────

test('assessExpectedPerformance: returns null for empty liftCode', () => {
  assert.equal(assessExpectedPerformance('', flatSquatEntries(), 200), null);
});

test('assessExpectedPerformance: returns null for null liftCode', () => {
  assert.equal(assessExpectedPerformance(null, flatSquatEntries(), 200), null);
});

test('assessExpectedPerformance: returns null when logEntries is not an array', () => {
  assert.equal(assessExpectedPerformance('SQUAT', null, 200), null);
  assert.equal(assessExpectedPerformance('SQUAT', 'not-array', 200), null);
});

test('assessExpectedPerformance: returns null for targetWeight of zero', () => {
  assert.equal(assessExpectedPerformance('SQUAT', flatSquatEntries(), 0), null);
});

test('assessExpectedPerformance: returns null for NaN targetWeight', () => {
  assert.equal(assessExpectedPerformance('SQUAT', flatSquatEntries(), NaN), null);
});

test('assessExpectedPerformance: returns null when fewer than 3 sessions match the weight window', () => {
  const entries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200 }),
    // This entry is outside the ±10% window around target=200 (range [180,220]).
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 250 }),
  ];
  assert.equal(assessExpectedPerformance('SQUAT', entries, 200), null);
});

test('assessExpectedPerformance: returns expected shape when 3 sessions match', () => {
  const result = assessExpectedPerformance('SQUAT', flatSquatEntries(), 200);
  assert.ok(result !== null, 'should return a non-null result');
  assert.equal(typeof result.expectedReps, 'number');
  assert.ok(result.expectedReps >= 1);
  assert.ok(result.basis != null);
  assert.equal(result.basis.sampleSize, 3);
  assert.ok(result.basis.weightWindow != null);
  assert.equal(typeof result.basis.confidence, 'string');
});

test('assessExpectedPerformance: confidence is high with 5+ sessions', () => {
  const entries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-22', session_id: 'S4', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-29', session_id: 'S5', weight: 200, reps: 5 }),
  ];
  const result = assessExpectedPerformance('SQUAT', entries, 200);
  assert.ok(result !== null);
  assert.equal(result.basis.confidence, 'high');
});

test('assessExpectedPerformance: excludes warm-up entries (only 2 working sessions → null)', () => {
  const entries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 5 }),
    // Third session is a warm-up — excluded by isWarmupNote.
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 10, notes: 'warm-up' }),
  ];
  assert.equal(assessExpectedPerformance('SQUAT', entries, 200), null);
});

test('assessExpectedPerformance: lift code matching is case-insensitive', () => {
  const result = assessExpectedPerformance('squat', flatSquatEntries(), 200);
  assert.ok(result !== null);
});

// ─── detectLiftPlateaus ───────────────────────────────────────────────────────

test('detectLiftPlateaus: returns empty array for empty input', () => {
  assert.deepEqual(detectLiftPlateaus([]), []);
});

test('detectLiftPlateaus: returns empty array for null/undefined input', () => {
  assert.deepEqual(detectLiftPlateaus(null), []);
  assert.deepEqual(detectLiftPlateaus(undefined), []);
});

test('detectLiftPlateaus: returns empty array when fewer than minSessions per lift', () => {
  const entries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1' }),
    entry({ date_clean: '2026-01-08', session_id: 'S2' }),
  ]; // 2 sessions, default minSessions = 3
  assert.deepEqual(detectLiftPlateaus(entries), []);
});

test('detectLiftPlateaus: detects stall when e1RM is flat across sessions', () => {
  const stalls = detectLiftPlateaus(flatSquatEntries());
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].liftCode, 'SQUAT');
  assert.equal(stalls[0].sessions_stalled, 3);
});

test('detectLiftPlateaus: no stall when e1RM improves across sessions', () => {
  const stalls = detectLiftPlateaus(improvingSquatEntries());
  assert.equal(stalls.length, 0);
});

test('detectLiftPlateaus: rep gain at the same weight is progress, not a stall', () => {
  const entries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 6 }),
  ];
  assert.equal(detectLiftPlateaus(entries).length, 0);
});

test('detectLiftPlateaus: excludes warm-up sets — only 2 working sessions remain, no stall', () => {
  const entries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 5 }),
    // S3 has only warm-up entries — excluded, leaving 2 sessions < minSessions(3).
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 5, notes: 'warm-up' }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 5, notes: 'wu' }),
  ];
  assert.equal(detectLiftPlateaus(entries).length, 0);
});

test('detectLiftPlateaus: respects opts.minSessions', () => {
  const entries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 5 }),
  ];
  // minSessions=2 → 2 flat sessions qualify as a stall.
  assert.equal(detectLiftPlateaus(entries, { minSessions: 2 }).length, 1);
  // minSessions=3 → only 2 sessions available, no stall.
  assert.equal(detectLiftPlateaus(entries, { minSessions: 3 }).length, 0);
});

test('detectLiftPlateaus: handles multiple lifts independently', () => {
  const entries = [
    // SQUAT: flat e1RM → stall
    entry({ date_clean: '2026-01-01', session_id: 'S1', lift_code: 'SQUAT', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', lift_code: 'SQUAT', weight: 200, reps: 5 }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', lift_code: 'SQUAT', weight: 200, reps: 5 }),
    // BENCH: improving e1RM → no stall
    entry({ date_clean: '2026-01-01', session_id: 'S1', lift_code: 'BENCH', canonical_exercise: 'Bench Press', weight: 150, reps: 3 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', lift_code: 'BENCH', canonical_exercise: 'Bench Press', weight: 150, reps: 4 }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', lift_code: 'BENCH', canonical_exercise: 'Bench Press', weight: 150, reps: 5 }),
  ];
  const stalls = detectLiftPlateaus(entries);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].liftCode, 'SQUAT');
});

test('detectLiftPlateaus: stall object has correct shape and date range', () => {
  const stalls = detectLiftPlateaus(flatSquatEntries());
  assert.equal(stalls.length, 1);
  const s = stalls[0];
  assert.equal(typeof s.liftCode, 'string');
  assert.equal(typeof s.exercise, 'string');
  assert.equal(typeof s.sessions_stalled, 'number');
  assert.equal(typeof s.last_best_weight, 'number');
  assert.equal(s.first_session_date, '2026-01-01');
  assert.equal(s.last_session_date, '2026-01-15');
  assert.equal(s.last_best_weight, 200);
});

test('detectLiftPlateaus: resolves exercise name from entries', () => {
  const stalls = detectLiftPlateaus(flatSquatEntries());
  assert.equal(stalls[0].exercise, 'Back Squat');
});

// ─── assessLift ──────────────────────────────────────────────────────────────

test('assessLift: returns null for invalid liftCode', () => {
  assert.equal(assessLift('', flatSquatEntries(), 200), null);
  assert.equal(assessLift(null, flatSquatEntries(), 200), null);
});

test('assessLift: returns null for non-array logEntries', () => {
  assert.equal(assessLift('SQUAT', null, 200), null);
});

test('assessLift: returns null for non-positive targetWeight', () => {
  assert.equal(assessLift('SQUAT', flatSquatEntries(), 0), null);
  assert.equal(assessLift('SQUAT', flatSquatEntries(), -10), null);
});

test('assessLift: returns correct shape with valid inputs', () => {
  const result = assessLift('SQUAT', flatSquatEntries(), 200);
  assert.ok(result !== null);
  assert.ok('liftCode' in result);
  assert.ok('targetWeight' in result);
  assert.ok('expectedPerformance' in result);
  assert.ok('plateau' in result);
  assert.ok('readiness' in result);
  assert.ok('adjustedExpectedReps' in result);
  assert.ok('readinessAdjustment' in result);
});

test('assessLift: liftCode in result is normalised to uppercase', () => {
  const result = assessLift('squat', flatSquatEntries(), 200);
  assert.ok(result !== null);
  assert.equal(result.liftCode, 'SQUAT');
});

test('assessLift: plateau is null when no stall detected', () => {
  const result = assessLift('SQUAT', improvingSquatEntries(), 200);
  assert.ok(result !== null);
  assert.equal(result.plateau, null);
});

test('assessLift: plateau contains stall descriptor when stall detected', () => {
  const result = assessLift('SQUAT', flatSquatEntries(), 200);
  assert.ok(result !== null);
  assert.ok(result.plateau !== null, 'plateau should be present');
  assert.equal(result.plateau.liftCode, 'SQUAT');
  assert.equal(result.plateau.sessions_stalled, 3);
});

test('assessLift: readiness is null when no readinessInputs provided', () => {
  const result = assessLift('SQUAT', flatSquatEntries(), 200);
  assert.ok(result !== null);
  assert.equal(result.readiness, null);
});

test('assessLift: adjustedExpectedReps equals expectedReps when no readiness provided', () => {
  const result = assessLift('SQUAT', flatSquatEntries(), 200);
  assert.ok(result !== null);
  assert.ok(result.expectedPerformance !== null);
  assert.equal(result.adjustedExpectedReps, result.expectedPerformance.expectedReps);
  assert.equal(result.readinessAdjustment, 'none');
});

test('assessLift: high readiness — no rep adjustment, readinessAdjustment = none', () => {
  const highReadiness = { sleep: 10, motivation: 10, hrv: 10, soreness: 0, stress: 0, recent_load: 0 };
  const result = assessLift('SQUAT', flatSquatEntries(), 200, { readinessInputs: highReadiness });
  assert.ok(result !== null);
  assert.ok(result.readiness !== null);
  assert.equal(result.readiness.tier, 'high');
  assert.equal(result.readinessAdjustment, 'none');
  assert.equal(result.adjustedExpectedReps, result.expectedPerformance.expectedReps);
});

test('assessLift: moderate readiness — −1 rep, readinessAdjustment = reduced_1', () => {
  // All inputs at 5/10 → normalised score = 50 → tier 'moderate' (regardless of weights).
  const moderateReadiness = { sleep: 5, motivation: 5, hrv: 5, soreness: 5, stress: 5, recent_load: 5 };
  const result = assessLift('SQUAT', flatSquatEntries(), 200, { readinessInputs: moderateReadiness });
  assert.ok(result !== null);
  assert.ok(result.readiness !== null);
  assert.equal(result.readiness.tier, 'moderate');
  assert.equal(result.readinessAdjustment, 'reduced_1');
  assert.equal(result.adjustedExpectedReps, result.expectedPerformance.expectedReps - 1);
});

test('assessLift: low readiness — −2 reps, readinessAdjustment = reduced_2', () => {
  const lowReadiness = { sleep: 0, motivation: 0, hrv: 0, soreness: 10, stress: 10, recent_load: 10 };
  const result = assessLift('SQUAT', flatSquatEntries(), 200, { readinessInputs: lowReadiness });
  assert.ok(result !== null);
  assert.ok(result.readiness !== null);
  assert.equal(result.readiness.tier, 'low');
  assert.equal(result.readinessAdjustment, 'reduced_2');
  const baseReps = result.expectedPerformance.expectedReps;
  assert.equal(result.adjustedExpectedReps, Math.max(1, baseReps - 2));
});

test('assessLift: adjustedExpectedReps is clamped to minimum of 1', () => {
  // All 3 sessions have 1 rep at target weight → expectedReps = 1.
  // Low readiness wants −2 reps → clamped to 1.
  const singleRepEntries = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 1 }),
    entry({ date_clean: '2026-01-08', session_id: 'S2', weight: 200, reps: 1 }),
    entry({ date_clean: '2026-01-15', session_id: 'S3', weight: 200, reps: 1 }),
  ];
  const lowReadiness = { sleep: 0, motivation: 0, hrv: 0, soreness: 10, stress: 10, recent_load: 10 };
  const result = assessLift('SQUAT', singleRepEntries, 200, { readinessInputs: lowReadiness });
  assert.ok(result !== null);
  assert.ok(result.expectedPerformance !== null);
  assert.equal(result.expectedPerformance.expectedReps, 1);
  assert.equal(result.adjustedExpectedReps, 1);
  assert.equal(result.readinessAdjustment, 'reduced_2');
});

test('assessLift: adjustedExpectedReps is null when expectedPerformance is null', () => {
  // Only 1 session → computeExpectedPerformance returns null (< 3 sessions).
  const singleSession = [
    entry({ date_clean: '2026-01-01', session_id: 'S1', weight: 200, reps: 5 }),
  ];
  const lowReadiness = { sleep: 0, motivation: 0, hrv: 0, soreness: 10, stress: 10, recent_load: 10 };
  const result = assessLift('SQUAT', singleSession, 200, { readinessInputs: lowReadiness });
  assert.ok(result !== null);
  assert.equal(result.expectedPerformance, null);
  assert.equal(result.adjustedExpectedReps, null);
  assert.equal(result.readinessAdjustment, 'none');
});
