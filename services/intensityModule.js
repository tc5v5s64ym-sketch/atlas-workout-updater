'use strict';

// IntensityModule — pure read-only functions for e1RM estimation and
// RIR/%1RM conversion. No Sheets access, no side effects.
//
// #1339 — SINGLE-METHOD RULE: `estimateE1RM(weight, reps, rir)` is the one
// engine method for estimated 1RM: reps+RIR → %1RM lookup
// (weight / percentOf1RM(reps, rir)). Every e1RM in the engine answers from
// it; no local Epley copy, no alternate formula, no rep-only figure may
// coexist. An absent or out-of-range RIR is RIR 0 (a to-failure set), which
// reproduces the old rep-only Epley value exactly — so the standardization
// changes nothing where no RIR was ever recorded, and corrects every set
// that carries one. A non-number RIR is a caller bug and throws TypeError.
//
// Atlas logs sets as weight × reps / RIR (slash notation).

const MIN_REPS = 1;
const MIN_RPE = 6;
const MAX_RPE = 10;
const MIN_RIR = 0;
const MAX_RIR = 4; // RIR > 4 means the set is too easy to be informative

// The single engine method for estimated 1RM: reps+RIR → %1RM lookup.
// Rounds to 2 decimal places to avoid floating-point noise in downstream
// comparisons. rir may be null/undefined (absent → 0); a finite number
// outside 0–4 is treated as absent, per the standing fallback policy
// (userStateModule / autoregulationModule); a non-number rir throws.
function estimateE1RM(weight, reps, rir) {
  if (typeof weight !== 'number' || !isFinite(weight) || weight <= 0) {
    throw new RangeError('weight must be a positive finite number');
  }
  if (typeof reps !== 'number' || !isFinite(reps) || reps < MIN_REPS) {
    throw new RangeError(`reps must be a finite number >= ${MIN_REPS}`);
  }
  if (rir !== null && rir !== undefined && typeof rir !== 'number') {
    throw new TypeError('rir must be a number, null, or undefined');
  }
  const r = (typeof rir === 'number' && Number.isFinite(rir) && rir >= MIN_RIR && rir <= MAX_RIR)
    ? rir : MIN_RIR;
  return Math.round((weight / percentOf1RM(reps, r)) * 100) / 100;
}

// Fraction of 1RM represented by performing R reps with rir reps in reserve.
//
// Derivation (Epley-consistent): a set of R reps at RIR rir is equivalent
// to doing (R + rir) reps to failure. The Epley weight for (R+rir) reps
// is e1rm / (1 + (R+rir)/30), so the fraction is 1 / (1 + (R+rir)/30).
function percentOf1RM(reps, rir) {
  if (typeof reps !== 'number' || !isFinite(reps) || reps < MIN_REPS) {
    throw new RangeError('reps must be a finite number >= 1');
  }
  if (typeof rir !== 'number' || !isFinite(rir) || rir < MIN_RIR || rir > MAX_RIR) {
    throw new RangeError(`rir must be ${MIN_RIR}–${MAX_RIR}`);
  }
  return 1 / (1 + (reps + rir) / 30);
}

// RPE variant of percentOf1RM. Atlas logs RIR; RPE is offered for external
// compatibility (RPE = 10 − RIR).
function percentOf1RMByRPE(reps, rpe) {
  if (typeof rpe !== 'number' || !isFinite(rpe) || rpe < MIN_RPE || rpe > MAX_RPE) {
    throw new RangeError(`rpe must be ${MIN_RPE}–${MAX_RPE}`);
  }
  return percentOf1RM(reps, 10 - rpe);
}

// Given an e1RM and a target (reps, RIR), return the target weight.
// Rounds to 2 decimal places.
function targetWeightForRIR(e1rm, targetReps, targetRIR) {
  if (typeof e1rm !== 'number' || !isFinite(e1rm) || e1rm <= 0) {
    throw new RangeError('e1rm must be a positive finite number');
  }
  return Math.round(e1rm * percentOf1RM(targetReps, targetRIR) * 100) / 100;
}

// RPE variant of targetWeightForRIR.
function targetWeightForRPE(e1rm, targetReps, targetRPE) {
  if (typeof targetRPE !== 'number' || !isFinite(targetRPE) || targetRPE < MIN_RPE || targetRPE > MAX_RPE) {
    throw new RangeError(`targetRPE must be ${MIN_RPE}–${MAX_RPE}`);
  }
  return targetWeightForRIR(e1rm, targetReps, 10 - targetRPE);
}

// Estimate the RIR of a performed set given a known e1RM.
// Inverse of percentOf1RM: rir = 30 × (e1rm/weight − 1) − reps.
// Clamped to [0, MAX_RIR] — values outside this range are imprecise.
function estimateRIR(weight, reps, e1rm) {
  if (typeof weight !== 'number' || !isFinite(weight) || weight <= 0) {
    throw new RangeError('weight must be a positive finite number');
  }
  if (typeof reps !== 'number' || !isFinite(reps) || reps < MIN_REPS) {
    throw new RangeError('reps must be a finite number >= 1');
  }
  if (typeof e1rm !== 'number' || !isFinite(e1rm) || e1rm <= 0) {
    throw new RangeError('e1rm must be a positive finite number');
  }
  const raw = 30 * (e1rm / weight - 1) - reps;
  return Math.max(MIN_RIR, Math.min(MAX_RIR, Math.round(raw)));
}

module.exports = {
  estimateE1RM,
  percentOf1RM,
  percentOf1RMByRPE,
  targetWeightForRIR,
  targetWeightForRPE,
  estimateRIR,
};
