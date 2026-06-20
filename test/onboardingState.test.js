'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBenchmark } = require('../services/exerciseBenchmark');
const {
  CALIBRATING,
  GRADUATED,
  calibrationStatusFor,
  isGraduated,
  onboardingStateForLifts,
} = require('../services/onboardingState');

// 12-column Log_Cleaned row:
// date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code |
// set_number | weight | reps | rir | notes | volume_calc
function row(date, session, liftCode, weight = 135, reps = 5, rir = 2) {
  return [date, session, 'Bench Press', 'Bench Press', 'chest', liftCode,
    '1', String(weight), String(reps), String(rir), '', ''];
}

// N distinct sessions (one working set each) for a single lift code.
function sessions(liftCode, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = new Date('2026-04-01');
    d.setDate(d.getDate() + i * 7);
    rows.push(row(d.toISOString().split('T')[0], `S${i + 1}`, liftCode));
  }
  return rows;
}

// ── Fixture F4 (end-to-end): the calibration_status is driven by the REAL
//    exerciseBenchmark confidence ladder, not a re-encoded threshold. ──────────
test('F4 — ladder drives graduation: 0/1/2 → calibrating, 3 → graduated, 5 → graduated', () => {
  const cases = [
    { n: 0, confidence: 'none',   status: CALIBRATING },
    { n: 1, confidence: 'low',    status: CALIBRATING },
    { n: 2, confidence: 'low',    status: CALIBRATING },
    { n: 3, confidence: 'medium', status: GRADUATED },   // graduation point
    { n: 5, confidence: 'high',   status: GRADUATED },
  ];
  for (const { n, confidence, status } of cases) {
    const bench = computeBenchmark('BP01', sessions('BP01', n));
    assert.equal(bench.confidence, confidence, `ladder confidence at ${n} sessions`);
    assert.equal(calibrationStatusFor(bench.confidence), status, `status at ${n} sessions`);
  }
});

test('calibrationStatusFor maps each ladder label directly', () => {
  assert.equal(calibrationStatusFor('none'), CALIBRATING);
  assert.equal(calibrationStatusFor('low'), CALIBRATING);
  assert.equal(calibrationStatusFor('medium'), GRADUATED);
  assert.equal(calibrationStatusFor('high'), GRADUATED);
});

test('calibrationStatusFor is case-insensitive and safe on unknown/missing', () => {
  assert.equal(calibrationStatusFor('MEDIUM'), GRADUATED);
  assert.equal(calibrationStatusFor(' High '), GRADUATED);
  assert.equal(calibrationStatusFor(null), CALIBRATING);       // safe default
  assert.equal(calibrationStatusFor(undefined), CALIBRATING);
  assert.equal(calibrationStatusFor('garbage'), CALIBRATING);
});

test('isGraduated boolean matches the mapping', () => {
  assert.equal(isGraduated('high'), true);
  assert.equal(isGraduated('medium'), true);
  assert.equal(isGraduated('low'), false);
  assert.equal(isGraduated('none'), false);
});

test('accepts a confidence_factors object (PR 370 shape)', () => {
  assert.equal(calibrationStatusFor({ confidence_factors: { lift_confidence: 'high' } }), GRADUATED);
  assert.equal(calibrationStatusFor({ lift_confidence: 'low' }), CALIBRATING);
});

// ── Owner call 4: per-lift only — never majority-gated. ──────────────────────
test('onboardingStateForLifts keeps each lift distinct (calibrated squat + unknown deadlift)', () => {
  const state = onboardingStateForLifts([
    { name: 'Squat',    lift_code: 'SQ01', lift_confidence: 'medium' },
    { name: 'Deadlift', lift_code: 'DL01', lift_confidence: 'none' },
  ]);

  assert.equal(state.per_lift.length, 2);
  const squat = state.per_lift.find(l => l.lift_code === 'SQ01');
  const dead  = state.per_lift.find(l => l.lift_code === 'DL01');
  assert.equal(squat.calibration_status, GRADUATED);
  assert.equal(dead.calibration_status, CALIBRATING);

  // No majority collapse: both buckets are populated, no single session flag wins.
  assert.equal(state.graduated_count, 1);
  assert.equal(state.calibrating_count, 1);
  assert.equal(state.all_graduated, false);
  assert.equal(state.any_calibrating, true);
});

test('onboardingStateForLifts reads confidence_factors and reports each lift', () => {
  const state = onboardingStateForLifts([
    { name: 'Row', lift_code: 'ROW01', confidence_factors: { lift_confidence: 'high' } },
  ]);
  assert.equal(state.per_lift[0].calibration_status, GRADUATED);
  assert.equal(state.all_graduated, true);
  assert.equal(state.any_calibrating, false);
});

test('onboardingStateForLifts handles empty / non-array input', () => {
  for (const input of [[], null, undefined, 42]) {
    const state = onboardingStateForLifts(input);
    assert.deepEqual(state.per_lift, []);
    assert.equal(state.all_graduated, false);     // empty is not "all graduated"
    assert.equal(state.any_calibrating, false);
  }
});

test('missing confidence on a lift defaults to none → calibrating', () => {
  const state = onboardingStateForLifts([{ name: 'Curl', lift_code: 'CU01' }]);
  assert.equal(state.per_lift[0].lift_confidence, 'none');
  assert.equal(state.per_lift[0].calibration_status, CALIBRATING);
});
