'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateE1RM,
  percentOf1RM,
  percentOf1RMByRPE,
  targetWeightForRIR,
  targetWeightForRPE,
  estimateRIR,
} = require('../services/intensityModule');

// --- estimateE1RM (the single engine method, #1339) ---

test('estimateE1RM: RIR 0 — 100lb × 10 reps → 133.33', () => {
  // 100 × (1 + 10/30) = 100 × 1.333... = 133.33
  assert.strictEqual(estimateE1RM(100, 10), 133.33);
  assert.strictEqual(estimateE1RM(100, 10, 0), 133.33);
});

test('estimateE1RM: RIR 0 — 225lb × 5 reps → 262.5', () => {
  // 225 × (1 + 5/30) = 225 × 1.1667 = 262.5
  assert.strictEqual(estimateE1RM(225, 5), 262.5);
});

test('estimateE1RM: 1 rep — Epley still adds 1/30 (no exact passthrough)', () => {
  // 200 × (1 + 1/30) = 206.67 — Epley inflates even at 1 rep
  assert.strictEqual(estimateE1RM(200, 1), 206.67);
});

test('estimateE1RM: RIR honored — 225lb × 6 @ RIR 2 → 285', () => {
  // 225 / percentOf1RM(6, 2) = 225 × (1 + 8/30) = 285
  assert.strictEqual(estimateE1RM(225, 6, 2), 285);
});

test('estimateE1RM: absent RIR is RIR 0', () => {
  assert.strictEqual(estimateE1RM(225, 6, null), 270);
  assert.strictEqual(estimateE1RM(225, 6, undefined), 270);
});

test('estimateE1RM: out-of-range RIR is treated as absent (RIR 0)', () => {
  // Standing fallback policy: an RIR outside 0–4 carries no information.
  assert.strictEqual(estimateE1RM(225, 6, 5), 270);
  assert.strictEqual(estimateE1RM(225, 6, -1), 270);
});

test('estimateE1RM: non-number RIR throws TypeError', () => {
  assert.throws(() => estimateE1RM(100, 5, 'brzycki'), TypeError);
});

test('estimateE1RM: no upper reps cap — the single method serves every logged rep count', () => {
  // 100 × (1 + 25/30) = 183.33; per-module caps (userState/autoregulation)
  // stay in the calling module, not in the method.
  assert.strictEqual(estimateE1RM(100, 25), 183.33);
});

test('estimateE1RM: throws on zero weight', () => {
  assert.throws(() => estimateE1RM(0, 5), RangeError);
});

test('estimateE1RM: throws on negative weight', () => {
  assert.throws(() => estimateE1RM(-50, 5), RangeError);
});

test('estimateE1RM: throws on reps below minimum', () => {
  assert.throws(() => estimateE1RM(100, 0), RangeError);
});

// --- percentOf1RM ---

test('percentOf1RM: RIR 0 at 1 rep is the maximum (closest to 1RM)', () => {
  // 1/(1+(1+0)/30) = 1/(1+1/30) = 30/31 ≈ 0.9677
  const pct = percentOf1RM(1, 0);
  assert.ok(pct > 0.96 && pct < 0.97, `expected ~0.967, got ${pct}`);
});

test('percentOf1RM: 5 reps at RIR 2 → correct fraction', () => {
  // 1/(1+(5+2)/30) = 1/(1+7/30) = 30/37 ≈ 0.8108
  const pct = percentOf1RM(5, 2);
  const expected = 30 / 37;
  assert.ok(Math.abs(pct - expected) < 0.0001, `expected ${expected}, got ${pct}`);
});

test('percentOf1RM: more reps = lower percentage', () => {
  assert.ok(percentOf1RM(5, 0) > percentOf1RM(10, 0));
});

test('percentOf1RM: more RIR = lower percentage', () => {
  assert.ok(percentOf1RM(5, 0) > percentOf1RM(5, 2));
});

test('percentOf1RM: throws on reps < 1', () => {
  assert.throws(() => percentOf1RM(0, 0), RangeError);
});

test('percentOf1RM: throws on RIR out of range', () => {
  assert.throws(() => percentOf1RM(5, 5), RangeError);
  assert.throws(() => percentOf1RM(5, -1), RangeError);
});

// --- percentOf1RMByRPE ---

test('percentOf1RMByRPE: RPE 8 at 5 reps matches RIR 2 at 5 reps', () => {
  // RPE 8 = RIR 2
  assert.strictEqual(percentOf1RMByRPE(5, 8), percentOf1RM(5, 2));
});

test('percentOf1RMByRPE: RPE 10 at 1 rep is the highest percentage', () => {
  const pct = percentOf1RMByRPE(1, 10);
  assert.ok(pct > 0.96, `expected > 0.96, got ${pct}`);
});

test('percentOf1RMByRPE: throws on RPE below 6', () => {
  assert.throws(() => percentOf1RMByRPE(5, 5), RangeError);
});

test('percentOf1RMByRPE: throws on RPE above 10', () => {
  assert.throws(() => percentOf1RMByRPE(5, 11), RangeError);
});

// --- targetWeightForRIR ---

test('targetWeightForRIR: e1RM 200, 5 reps, RIR 0 → weight at 5RM', () => {
  // percentOf1RM(5,0) = 1/(1+5/30) = 30/35 = 0.8571...
  // 200 × 30/35 = 171.43
  const result = targetWeightForRIR(200, 5, 0);
  assert.ok(Math.abs(result - 171.43) < 0.01, `expected ~171.43, got ${result}`);
});

test('targetWeightForRIR: e1RM 300, 3 reps, RIR 2 → ~240', () => {
  // percentOf1RM(3, 2) = 1/(1+5/30) = 30/35 ≈ 0.8571
  // 300 × 0.8571 ≈ 257.14
  const result = targetWeightForRIR(300, 3, 2);
  assert.ok(result > 255 && result < 260, `expected ~257.14, got ${result}`);
});

test('targetWeightForRIR: throws on invalid e1RM', () => {
  assert.throws(() => targetWeightForRIR(0, 5, 2), RangeError);
});

// --- targetWeightForRPE ---

test('targetWeightForRPE: RPE 8 at 5 reps matches RIR 2 at 5 reps', () => {
  const byRPE = targetWeightForRPE(200, 5, 8);
  const byRIR = targetWeightForRIR(200, 5, 2);
  assert.strictEqual(byRPE, byRIR);
});

test('targetWeightForRPE: throws with a clear RPE-specific message on out-of-range RPE', () => {
  assert.throws(
    () => targetWeightForRPE(200, 5, 5),
    (err) => err instanceof RangeError && /targetRPE/.test(err.message)
  );
});

// --- estimateRIR ---

test('estimateRIR: 100lb × 10 reps with e1RM 133.33 → RIR 0', () => {
  // 10 reps to failure at 100lb gives e1RM 133.33 (Epley).
  // estimateRIR(100, 10, 133.33) = round(30*(133.33/100 - 1) - 10) = round(10-10) = 0
  const e1rm = estimateE1RM(100, 10);
  const rir = estimateRIR(100, 10, e1rm);
  assert.strictEqual(rir, 0);
});

test('estimateRIR: 100lb × 5 reps with e1RM from 10-rep set → RIR 5, clamped to 4', () => {
  // e1RM(100, 10) = 133.33
  // rir for 100lb × 5 reps = round(30*(133.33/100 - 1) - 5) = round(10-5) = 5
  // clamped to MAX_RIR = 4
  const e1rm = estimateE1RM(100, 10);
  const rir = estimateRIR(100, 5, e1rm);
  assert.strictEqual(rir, 4); // clamped from 5
});

test('estimateRIR: roundtrip — e1RM from set, then RIR ≈ 0', () => {
  // Any set logged at max effort (RIR 0) should estimate back to RIR 0
  const weight = 185;
  const reps = 8;
  const e1rm = estimateE1RM(weight, reps); // assumes RIR 0 (to failure)
  const rir = estimateRIR(weight, reps, e1rm);
  assert.strictEqual(rir, 0);
});

test('estimateRIR: throws on invalid inputs', () => {
  assert.throws(() => estimateRIR(0, 5, 200), RangeError);
  assert.throws(() => estimateRIR(100, 0, 200), RangeError);
  assert.throws(() => estimateRIR(100, 5, 0), RangeError);
});

// --- no second formula (#1339) ---

test('single method: no formula catalog is exported', () => {
  const intensity = require('../services/intensityModule');
  assert.ok(!('FORMULAS' in intensity), 'FORMULAS is retired: one method only');
  assert.ok(!('DEFAULT_FORMULA' in intensity), 'DEFAULT_FORMULA is retired: one method only');
});
