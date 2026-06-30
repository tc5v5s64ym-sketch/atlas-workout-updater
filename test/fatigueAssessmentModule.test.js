'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assessRecovery,
  scoreReadiness,
  checkDeloadTriggers,
} = require('../services/fatigueAssessmentModule');

// --- assessRecovery ---

// small_muscles window: [24, 48]

test('assessRecovery: small_muscles at 12h → likely_underrecovered', () => {
  const r = assessRecovery('small_muscles', 12);
  assert.strictEqual(r.status, 'likely_underrecovered');
});

test('assessRecovery: small_muscles at 24h (at min) → possibly_recovering', () => {
  const r = assessRecovery('small_muscles', 24);
  assert.strictEqual(r.status, 'possibly_recovering');
});

test('assessRecovery: small_muscles at 48h (at max) → recovered', () => {
  const r = assessRecovery('small_muscles', 48);
  assert.strictEqual(r.status, 'recovered');
});

test('assessRecovery: small_muscles at 60h → recovered', () => {
  assert.strictEqual(assessRecovery('small_muscles', 60).status, 'recovered');
});

test('assessRecovery: large_compound at 24h → likely_underrecovered', () => {
  assert.strictEqual(assessRecovery('large_compound', 24).status, 'likely_underrecovered');
});

test('assessRecovery: large_compound at 48h (at min) → possibly_recovering', () => {
  assert.strictEqual(assessRecovery('large_compound', 48).status, 'possibly_recovering');
});

test('assessRecovery: large_compound at 72h (at max) → recovered', () => {
  assert.strictEqual(assessRecovery('large_compound', 72).status, 'recovered');
});

test('assessRecovery: heavy_eccentric at 48h → likely_underrecovered', () => {
  assert.strictEqual(assessRecovery('heavy_eccentric_or_to_failure', 48).status, 'likely_underrecovered');
});

test('assessRecovery: heavy_eccentric at 72h (at min) → possibly_recovering', () => {
  assert.strictEqual(assessRecovery('heavy_eccentric_or_to_failure', 72).status, 'possibly_recovering');
});

test('assessRecovery: heavy_eccentric at 96h (at max) → recovered', () => {
  assert.strictEqual(assessRecovery('heavy_eccentric_or_to_failure', 96).status, 'recovered');
});

test('assessRecovery: hoursLeft = 0 when recovered', () => {
  assert.strictEqual(assessRecovery('small_muscles', 48).hoursLeft, 0);
  assert.strictEqual(assessRecovery('small_muscles', 60).hoursLeft, 0);
});

test('assessRecovery: hoursLeft = minHours - hours when underrecovered', () => {
  // small_muscles min=24, at 12h → hoursLeft = 24 - 12 = 12
  assert.strictEqual(assessRecovery('small_muscles', 12).hoursLeft, 12);
});

test('assessRecovery: hoursLeft = maxHours - hours when possibly_recovering', () => {
  // small_muscles max=48, at 24h → hoursLeft = 48 - 24 = 24
  assert.strictEqual(assessRecovery('small_muscles', 24).hoursLeft, 24);
});

test('assessRecovery: recoveryWindow is returned', () => {
  const r = assessRecovery('small_muscles', 12);
  assert.deepEqual(r.recoveryWindow, [24, 48]);
});

test('assessRecovery: 0h since last session → likely_underrecovered', () => {
  assert.strictEqual(assessRecovery('small_muscles', 0).status, 'likely_underrecovered');
});

test('assessRecovery: invalid hours → null', () => {
  assert.strictEqual(assessRecovery('small_muscles', -1), null);
  assert.strictEqual(assessRecovery('small_muscles', null), null);
  assert.strictEqual(assessRecovery('small_muscles', '24'), null);
});

test('assessRecovery: NaN hours → null (not a bogus result)', () => {
  assert.strictEqual(assessRecovery('small_muscles', NaN), null);
});

test('assessRecovery: unknown muscle category → null', () => {
  assert.strictEqual(assessRecovery('unknown_muscle', 24), null);
  assert.strictEqual(assessRecovery(null, 24), null);
});

// --- scoreReadiness ---

test('scoreReadiness: null input → score=null, tier=null, confidence=low', () => {
  const r = scoreReadiness(null);
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.tier, null);
  assert.strictEqual(r.confidence, 'low');
  assert.deepEqual(r.inputsUsed, []);
});

test('scoreReadiness: empty object → score=null (no valid inputs)', () => {
  const r = scoreReadiness({});
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.tier, null);
});

test('scoreReadiness: all inputs at best values → high tier', () => {
  // sleep=10, soreness=0, stress=0, motivation=10, recent_load=0, hrv=10
  const r = scoreReadiness({ sleep: 10, soreness: 0, stress: 0, motivation: 10, recent_load: 0, hrv: 10 });
  assert.strictEqual(r.tier, 'high');
  assert.strictEqual(r.score, 100);
});

test('scoreReadiness: all inputs at worst values → low tier', () => {
  // sleep=0, soreness=10, stress=10, motivation=0, recent_load=10, hrv=0
  const r = scoreReadiness({ sleep: 0, soreness: 10, stress: 10, motivation: 0, recent_load: 10, hrv: 0 });
  assert.strictEqual(r.tier, 'low');
  assert.strictEqual(r.score, 0);
});

test('scoreReadiness: mid-range inputs → moderate tier', () => {
  const r = scoreReadiness({ sleep: 5, soreness: 5, stress: 5, motivation: 5, recent_load: 5, hrv: 5 });
  assert.strictEqual(r.tier, 'moderate');
  assert.strictEqual(r.score, 50);
});

test('scoreReadiness: high-weight inputs (sleep) matter more than low-weight (hrv)', () => {
  // sleep weight=high(3), hrv weight=low(1)
  // sleep=10 only vs hrv=10 only — sleep should score higher
  const sleepOnly = scoreReadiness({ sleep: 10 });
  const hrvOnly = scoreReadiness({ hrv: 10 });
  // Both should score 100 (single fully-positive input) — same proportional score
  // but the confidence of sleep-only should still be 'low' (1 input)
  assert.strictEqual(sleepOnly.score, 100);
  assert.strictEqual(hrvOnly.score, 100);
  // The weight difference shows up when combined with bad inputs
  const highSleepBadHrv = scoreReadiness({ sleep: 10, hrv: 0 });
  const badSleepHighHrv = scoreReadiness({ sleep: 0, hrv: 10 });
  // sleep has weight 3, hrv has weight 1 → sleep dominates more
  assert.ok(highSleepBadHrv.score > badSleepHighHrv.score,
    `expected sleep(10)+hrv(0)=${highSleepBadHrv.score} > sleep(0)+hrv(10)=${badSleepHighHrv.score}`);
});

test('scoreReadiness: invalid values are skipped (treated as absent)', () => {
  const r = scoreReadiness({ sleep: -1, soreness: 11, stress: 'high', motivation: 8 });
  assert.ok(r.inputsUsed.includes('motivation'));
  assert.ok(!r.inputsUsed.includes('sleep'));
  assert.ok(!r.inputsUsed.includes('soreness'));
  assert.ok(!r.inputsUsed.includes('stress'));
});

test('scoreReadiness: NaN values are skipped and do not poison score', () => {
  const r = scoreReadiness({ sleep: NaN, motivation: 8 });
  assert.ok(!r.inputsUsed.includes('sleep'), 'NaN sleep should be skipped');
  assert.ok(r.inputsUsed.includes('motivation'));
  assert.ok(typeof r.score === 'number' && !Number.isNaN(r.score), 'score must not be NaN');
});

test('scoreReadiness: inputsUsed and inputsAbsent are disjoint and complete', () => {
  const r = scoreReadiness({ sleep: 8, motivation: 7 });
  const all = [...r.inputsUsed, ...r.inputsAbsent];
  assert.strictEqual(all.length, 6);
  assert.ok(r.inputsUsed.includes('sleep'));
  assert.ok(r.inputsUsed.includes('motivation'));
  assert.ok(r.inputsAbsent.includes('soreness'));
});

test('scoreReadiness: confidence = low for 1 input', () => {
  assert.strictEqual(scoreReadiness({ sleep: 8 }).confidence, 'low');
});

test('scoreReadiness: confidence = moderate for 2 inputs', () => {
  assert.strictEqual(scoreReadiness({ sleep: 8, motivation: 7 }).confidence, 'moderate');
});

test('scoreReadiness: confidence = high for 4+ inputs', () => {
  const r = scoreReadiness({ sleep: 8, soreness: 2, stress: 3, motivation: 7 });
  assert.strictEqual(r.confidence, 'high');
});

test('scoreReadiness: score is integer 0-100', () => {
  const r = scoreReadiness({ sleep: 7, soreness: 3, motivation: 8 });
  assert.ok(Number.isInteger(r.score), 'score should be integer');
  assert.ok(r.score >= 0 && r.score <= 100);
});

// --- checkDeloadTriggers ---

test('checkDeloadTriggers: weeksSinceDeload >= 4 → plannedDeloadDue = true', () => {
  assert.strictEqual(checkDeloadTriggers(4, []).plannedDeloadDue, true);
  assert.strictEqual(checkDeloadTriggers(6, []).plannedDeloadDue, true);
});

test('checkDeloadTriggers: weeksSinceDeload < 4 → plannedDeloadDue = false', () => {
  assert.strictEqual(checkDeloadTriggers(3, []).plannedDeloadDue, false);
  assert.strictEqual(checkDeloadTriggers(0, []).plannedDeloadDue, false);
});

test('checkDeloadTriggers: 2 active triggers → deloadWarranted = true, reason = autoregulated', () => {
  const r = checkDeloadTriggers(0, ['performance drop', 'persistent soreness']);
  assert.strictEqual(r.deloadWarranted, true);
  assert.strictEqual(r.reason, 'autoregulated');
});

test('checkDeloadTriggers: 1 active trigger → deloadWarranted = false', () => {
  const r = checkDeloadTriggers(0, ['performance drop']);
  assert.strictEqual(r.deloadWarranted, false);
  assert.strictEqual(r.reason, 'none');
});

test('checkDeloadTriggers: planned + 2 triggers → reason = both', () => {
  const r = checkDeloadTriggers(4, ['performance drop', 'persistent soreness']);
  assert.strictEqual(r.reason, 'both');
  assert.strictEqual(r.deloadWarranted, true);
});

test('checkDeloadTriggers: no triggers, 0 weeks → reason = none', () => {
  const r = checkDeloadTriggers(0, []);
  assert.strictEqual(r.deloadWarranted, false);
  assert.strictEqual(r.reason, 'none');
});

test('checkDeloadTriggers: invalid weeksSinceDeload → null', () => {
  assert.strictEqual(checkDeloadTriggers(-1, []), null);
  assert.strictEqual(checkDeloadTriggers('4', []), null);
  assert.strictEqual(checkDeloadTriggers(null, []), null);
});

test('checkDeloadTriggers: NaN weeksSinceDeload → null (not a bogus result)', () => {
  assert.strictEqual(checkDeloadTriggers(NaN, []), null);
});

test('checkDeloadTriggers: activeTriggerKeys defaults to [] when omitted', () => {
  const r = checkDeloadTriggers(2);
  assert.ok(r !== null);
  assert.deepEqual(r.triggersPresent, []);
  assert.strictEqual(r.autoregulatedTriggersFired, 0);
});

test('checkDeloadTriggers: triggersPresent reflects what was passed', () => {
  const keys = ['performance drop', 'motivation drop'];
  const r = checkDeloadTriggers(2, keys);
  assert.deepEqual(r.triggersPresent, keys);
});

test('checkDeloadTriggers: weeksSinceDeload echoed in result', () => {
  assert.strictEqual(checkDeloadTriggers(5, []).weeksSinceDeload, 5);
});

test('checkDeloadTriggers: autoregulatedTriggersFired = count of activeTriggerKeys', () => {
  const r = checkDeloadTriggers(2, ['a', 'b', 'c']);
  assert.strictEqual(r.autoregulatedTriggersFired, 3);
  assert.strictEqual(r.deloadWarranted, true);
});
