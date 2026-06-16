// services/deloadFatigueScore.js
//
// The exposure-based fatigue score, per docs/DELOAD_SPEC.md ("FATIGUE DETECTION"
// and "DELOAD TRIGGER CRITERIA"). Pure and standalone — it reads a normalized
// view of a lifter's recent training and returns a 0-100 fatigue score plus a
// per-signal breakdown. It decides nothing on its own: the escalation ladder
// (a later PR) maps this score to an action.
//
// WHAT COMES FROM THE SPEC vs WHAT IS A DESIGN CHOICE
// ---------------------------------------------------
// The spec defines the SIGNALS (A–F) and the escalation BANDS (<50 / 50-75 /
// 75-90 / >90). It does NOT prescribe how many points each signal is worth.
// The SIGNAL_WEIGHTS below are therefore a deliberate, documented design choice,
// constrained by the spec's hard rules:
//   - "High Fatigue Exposure (F) ... alone cannot trigger a deload" → F is
//     capped well below the 50 'normal coaching' ceiling, so F by itself can
//     never reach the offer/recommend bands.
//   - Stagnation (A) "must NOT" fire on rep progress at a fixed weight → the
//     progress test credits a higher e1RM/volume, so same-weight-more-reps is
//     progress, never a stall.
//   - A lone signal stays modest; reaching the deload bands (offer is 75-90,
//     recommend is >90 per the spec's escalation ladder) requires several
//     signals stacking — matching the spec's "conditional on genuine fatigue,
//     not a naive stall" stance.
// Every weight is pinned by hand-computed golden fixtures, so tuning a weight is
// a one-line change with a visible test delta.

// Max point contribution of each signal. Sum is clamped to 100.
const SIGNAL_WEIGHTS = Object.freeze({
  A_STAGNATION: 30,
  B_REGRESSION: 30,
  C_RIR_DRIFT: 20,
  D_MULTI_LIFT: 20,
  E_RECOVERY: 25,
  F_FATIGUE_EXPOSURE: 12 // capped below 50 — F alone can never trigger
});

// Stagnation thresholds: how many trailing exposures with no progress count as a
// stall, by focus. Low frequency (1-3x/week) requires MORE stalled exposures —
// the spec: low-frequency lifters "require more stalled exposures" and naturally
// accumulate less fatigue.
const STAGNATION_BASE_THRESHOLD = Object.freeze({
  strength: 3,      // spec: "No progress for 3+ exposures"
  hypertrophy: 4,   // spec: "No rep/load/volume progress for 4+ exposures"
  power: 4,
  endurance: 4
});
const LOW_FREQUENCY_THRESHOLD_BONUS = 2; // spec: strength low-freq is "4-6 exposures"
const LOW_FREQUENCY_MAX_PER_WEEK = 3;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Epley estimated 1RM from a top set. Captures load AND reps in one number, so
// "same weight, more reps" reads as a real strength gain (the anti-false-stall
// guard). Returns null for unusable input.
function estimateE1rm(weight, reps) {
  const w = Number(weight);
  const r = Number(reps);
  if (!isFiniteNumber(w) || !isFiniteNumber(r) || w <= 0 || r <= 0) return null;
  return w * (1 + r / 30);
}

// Top-set volume proxy. Used alongside e1RM so a hypertrophy "more volume at the
// same load" also counts as progress.
function exposureVolume(exposure) {
  const w = Number(exposure.weight);
  const r = Number(exposure.reps);
  const sets = isFiniteNumber(Number(exposure.sets)) && Number(exposure.sets) > 0 ? Number(exposure.sets) : 1;
  if (!isFiniteNumber(w) || !isFiniteNumber(r)) return null;
  return w * r * sets;
}

// The stagnation threshold for a lift given focus + training frequency.
function stagnationThreshold(focus, frequencyPerWeek) {
  const key = String(focus == null ? '' : focus).trim().toLowerCase();
  const base = STAGNATION_BASE_THRESHOLD[key] != null ? STAGNATION_BASE_THRESHOLD[key] : 4;
  const lowFreq = isFiniteNumber(frequencyPerWeek) && frequencyPerWeek > 0 && frequencyPerWeek <= LOW_FREQUENCY_MAX_PER_WEEK;
  return lowFreq ? base + LOW_FREQUENCY_THRESHOLD_BONUS : base;
}

// Per-lift signal analysis over a lift's chronological exposures (oldest→newest,
// one entry per session the lift was trained). Returns the raw signal readings;
// scoring happens in computeFatigueScore.
function analyzeLift(lift, frequencyPerWeek) {
  const exposures = Array.isArray(lift && lift.exposures) ? lift.exposures : [];
  const result = {
    lift_code: lift && lift.lift_code,
    stalled: false,
    stalledCount: 0,
    threshold: stagnationThreshold(lift && lift.focus, frequencyPerWeek),
    regressed: false,
    regressionPct: 0,
    rirDrift: false,
    rirDriftAmount: 0
  };
  if (exposures.length < 2) return result;

  // --- A: stagnation. Walk forward tracking the best e1RM/volume seen BEFORE the
  // current exposure; an exposure "progresses" if it beats either. The trailing
  // run of non-progressing exposures is the stall length.
  let maxE1rm = -Infinity;
  let maxVolume = -Infinity;
  let trailingStall = 0;
  for (const ex of exposures) {
    const e1rm = estimateE1rm(ex.weight, ex.reps);
    const vol = exposureVolume(ex);
    const progressed =
      (e1rm != null && e1rm > maxE1rm + 1e-9) ||
      (vol != null && vol > maxVolume + 1e-9);
    if (progressed) {
      trailingStall = 0;
    } else {
      trailingStall += 1;
    }
    if (e1rm != null && e1rm > maxE1rm) maxE1rm = e1rm;
    if (vol != null && vol > maxVolume) maxVolume = vol;
  }
  result.stalledCount = trailingStall;
  result.stalled = trailingStall >= result.threshold;

  // --- B: regression. Worst of (a) e1RM dropped ≥5% from the peak, or (b) the
  // newest exposure does fewer reps than an earlier set at the SAME weight.
  const latest = exposures[exposures.length - 1];
  const latestE1rm = estimateE1rm(latest.weight, latest.reps);
  if (latestE1rm != null && maxE1rm > 0) {
    const dropPct = (maxE1rm - latestE1rm) / maxE1rm;
    if (dropPct >= 0.05) {
      result.regressed = true;
      result.regressionPct = dropPct;
    }
  }
  if (!result.regressed) {
    const latestW = Number(latest.weight);
    const latestR = Number(latest.reps);
    for (let i = 0; i < exposures.length - 1; i++) {
      const w = Number(exposures[i].weight);
      const r = Number(exposures[i].reps);
      if (isFiniteNumber(w) && w === latestW && isFiniteNumber(r) && isFiniteNumber(latestR) && latestR < r) {
        result.regressed = true; // same load, fewer reps than before
        break;
      }
    }
  }

  // --- C: RIR drift. Across the trailing run of exposures at STABLE performance
  // (same weight and reps), RIR is falling — stable output, rising effort = the
  // spec's 225×5 @3→@2→@1→@0 pattern. Drift amount = first RIR − last RIR.
  const trailingStable = [];
  for (let i = exposures.length - 1; i >= 0; i--) {
    const ex = exposures[i];
    if (Number(ex.weight) === Number(latest.weight) && Number(ex.reps) === Number(latest.reps) && isFiniteNumber(Number(ex.rir))) {
      trailingStable.unshift(ex);
    } else {
      break;
    }
  }
  if (trailingStable.length >= 3) {
    let monotoneDown = true;
    for (let i = 1; i < trailingStable.length; i++) {
      if (Number(trailingStable[i].rir) > Number(trailingStable[i - 1].rir)) { monotoneDown = false; break; }
    }
    const drift = Number(trailingStable[0].rir) - Number(trailingStable[trailingStable.length - 1].rir);
    if (monotoneDown && drift >= 2) {
      result.rirDrift = true;
      result.rirDriftAmount = drift;
    }
  }

  return result;
}

// Count distinct recovery reports (signal E). Repeated reports matter; the spec
// warns Atlas must never deload off "one low day", so a single report is minor.
function countRecoveryReports(recoveryReports) {
  if (!Array.isArray(recoveryReports)) return 0;
  const cleaned = recoveryReports
    .map(r => String(r == null ? '' : r).trim().toLowerCase())
    .filter(Boolean);
  return new Set(cleaned).size;
}

// Signal F: high fatigue exposure. Modest, hard-capped (a long hard block nudges
// the score but, per the spec, can never trigger a deload on its own).
function scoreFatigueExposure(fatigueExposure) {
  if (!fatigueExposure || typeof fatigueExposure !== 'object') return 0;
  const hardSets = Number(fatigueExposure.hard_sets);
  const failureSets = Number(fatigueExposure.failure_sets);
  const blockLen = Number(fatigueExposure.block_length_sessions);

  let pts = 0;
  if (isFiniteNumber(hardSets)) pts += hardSets >= 20 ? 4 : hardSets >= 12 ? 2 : 0;
  if (isFiniteNumber(failureSets)) pts += failureSets >= 4 ? 4 : failureSets >= 2 ? 2 : 0;
  if (isFiniteNumber(blockLen)) pts += blockLen >= 8 ? 4 : blockLen >= 5 ? 2 : 0;
  return clamp(pts, 0, SIGNAL_WEIGHTS.F_FATIGUE_EXPOSURE);
}

// Compute the 0-100 fatigue score from a normalized training view:
//   {
//     lifts: [{ lift_code, focus, exposures: [{ weight, reps, rir, sets? }] }],
//     frequency_per_week,                 // for the low-frequency adjustment
//     recovery_reports: ['sore', ...],    // signal E
//     fatigue_exposure: { hard_sets, failure_sets, block_length_sessions } // F
//   }
// Returns { score, signals: { A,B,C,D,E,F }, lifts: [<per-lift analysis>] }.
function computeFatigueScore(input = {}) {
  const lifts = Array.isArray(input.lifts) ? input.lifts : [];
  const frequencyPerWeek = input.frequency_per_week;

  const analyses = lifts.map(lift => analyzeLift(lift, frequencyPerWeek));

  // A — stagnation: scale by how far the worst-stalled lift is past its
  // threshold. At threshold = 20; +5 per extra exposure; capped at 30.
  let A = 0;
  for (const a of analyses) {
    if (a.stalled) {
      const over = a.stalledCount - a.threshold;
      A = Math.max(A, clamp(20 + over * 5, 0, SIGNAL_WEIGHTS.A_STAGNATION));
    }
  }

  // B — regression: worst across lifts. e1RM drop ≥5% scales 20→30 over the
  // 5%→15% band; a same-weight-fewer-reps regression with <5% e1RM loss is 15.
  let B = 0;
  for (const a of analyses) {
    if (!a.regressed) continue;
    let b;
    if (a.regressionPct >= 0.05) {
      b = clamp(20 + Math.floor(a.regressionPct * 100 - 5), 20, SIGNAL_WEIGHTS.B_REGRESSION);
    } else {
      b = 15; // same load, fewer reps, but e1RM held within 5%
    }
    B = Math.max(B, b);
  }

  // C — RIR drift: worst across lifts. drift 2 → 16, drift 3 → 20 (capped).
  let C = 0;
  for (const a of analyses) {
    if (a.rirDrift) C = Math.max(C, clamp(8 + a.rirDriftAmount * 4, 0, SIGNAL_WEIGHTS.C_RIR_DRIFT));
  }

  // D — multiple-lift stagnation: ≥2 lifts stalled at once. 2 → 10, 3 → 20.
  const stalledLifts = analyses.filter(a => a.stalled).length;
  const D = stalledLifts >= 2
    ? clamp(10 + (stalledLifts - 2) * 10, 0, SIGNAL_WEIGHTS.D_MULTI_LIFT)
    : 0;

  // E — recovery signals: repeated reports. 1 → 4 (minor), 2 → 17, 3+ → capped 25.
  const reports = countRecoveryReports(input.recovery_reports);
  const E = reports === 0 ? 0 : reports === 1 ? 4 : clamp(8 + (reports - 1) * 9, 0, SIGNAL_WEIGHTS.E_RECOVERY);

  // F — high fatigue exposure (capped; alone cannot trigger).
  const F = scoreFatigueExposure(input.fatigue_exposure);

  const signals = { A, B, C, D, E, F };
  const score = clamp(A + B + C + D + E + F, 0, 100);

  return { score, signals, lifts: analyses };
}

module.exports = {
  SIGNAL_WEIGHTS,
  STAGNATION_BASE_THRESHOLD,
  estimateE1rm,
  stagnationThreshold,
  analyzeLift,
  countRecoveryReports,
  scoreFatigueExposure,
  computeFatigueScore
};
