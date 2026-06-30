'use strict';

// IntensityModule — pure read-only functions for e1RM estimation and
// RIR/%1RM conversion. No Sheets access, no side effects.
//
// Atlas logs sets as weight × reps / RIR (slash notation). The Epley
// formula is the default because it matches the inline usage already in
// analytics.js. Do not change the default formula without a coordinated
// update to analytics.js and the coaching knowledge config.

const FORMULAS = Object.freeze({
  // weight × (1 + reps/30)
  epley: (w, r) => w * (1 + r / 30),
  // weight × (36 / (37 − reps)); clamps reps to 36 to avoid asymptote
  brzycki: (w, r) => w * (36 / (37 - Math.min(r, 36))),
  // weight × reps^0.10
  lombardi: (w, r) => w * Math.pow(r, 0.10),
});

const DEFAULT_FORMULA = 'epley';

const MIN_REPS = 1;
const MAX_REPS = 20; // Epley/Brzycki are unreliable beyond this range
const MIN_RPE = 6;
const MAX_RPE = 10;
const MIN_RIR = 0;
const MAX_RIR = 4; // RIR > 4 means the set is too easy to be informative

// Estimate one-rep max from a performed set.
// Rounds to 2 decimal places to avoid floating-point noise in downstream
// comparisons.
function estimateE1RM(weight, reps, formula) {
  if (typeof weight !== 'number' || !isFinite(weight) || weight <= 0) {
    throw new RangeError('weight must be a positive finite number');
  }
  if (typeof reps !== 'number' || !isFinite(reps) || reps < MIN_REPS || reps > MAX_REPS) {
    throw new RangeError(`reps must be ${MIN_REPS}–${MAX_REPS}`);
  }
  const formulaKey = formula || DEFAULT_FORMULA;
  const fn = FORMULAS[formulaKey];
  if (!fn) throw new TypeError(`Unknown e1RM formula: "${formulaKey}". Valid: ${Object.keys(FORMULAS).join(', ')}`);
  return Math.round(fn(weight, reps) * 100) / 100;
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
  FORMULAS,
  DEFAULT_FORMULA,
  estimateE1RM,
  percentOf1RM,
  percentOf1RMByRPE,
  targetWeightForRIR,
  targetWeightForRPE,
  estimateRIR,
};
