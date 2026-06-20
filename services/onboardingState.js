'use strict';

// Onboarding calibration-state engine — PR-O1.
//
// Pure / deterministic. No I/O, no LLM, no Sheets writes, no schema, no route.
// Derives a per-lift onboarding `calibration_status` from the EXISTING
// `lift_confidence` ladder produced by services/exerciseBenchmark.js
// (`computeBenchmark` / `resolveWorkingWeight` → confidence ∈
// none | low | medium | high). It re-implements NO thresholds — it consumes the
// ladder's label and maps it to a status the future voice gate (PR-O3) and UX
// (PR-O4) read.
//
// Graduation rule (owner-approved — docs/ONBOARDING_WORKING_WEIGHT_SPEC.md,
// "Owner-approved decisions" §2 / §7):
//   lift_confidence ∈ { medium, high }  → 'graduated'   (≥3 logged sessions: a
//                                          stable workingWeight / repRange /
//                                          rirRange exists)
//   lift_confidence ∈ { none,  low  }  → 'calibrating'  (0–2 logged sessions)
//
// PER-LIFT ONLY (owner call 4): status is computed and reported per lift and is
// NEVER collapsed into a single majority / session-level "we're still learning"
// flag. A calibrated squat and an unknown deadlift must stay distinguishable so
// the voice can say so.
//
// Trust note: an unknown / missing confidence maps to 'calibrating' — the safe
// direction (never claim a graduation Atlas cannot prove from logged sessions).

const CALIBRATING = 'calibrating';
const GRADUATED   = 'graduated';

const GRADUATED_CONFIDENCE = new Set(['medium', 'high']);

// Accepts a raw confidence string, a confidence_factors object (PR 370), or a
// lift object carrying either field. Returns a normalized lowercase confidence
// label, or '' when none can be found.
function normalizeConfidence(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (typeof value === 'object') {
    const c =
      value.lift_confidence != null ? value.lift_confidence :
      value.confidence      != null ? value.confidence :
      (value.confidence_factors && value.confidence_factors.lift_confidence);
    return c == null ? '' : String(c).trim().toLowerCase();
  }
  return '';
}

// 'graduated' iff the lift's confidence is medium/high; otherwise 'calibrating'.
function calibrationStatusFor(confidence) {
  return GRADUATED_CONFIDENCE.has(normalizeConfidence(confidence)) ? GRADUATED : CALIBRATING;
}

function isGraduated(confidence) {
  return calibrationStatusFor(confidence) === GRADUATED;
}

function idOf(lift) {
  if (lift && typeof lift === 'object') {
    return {
      name:      lift.name != null ? lift.name : (lift.exercise != null ? lift.exercise : null),
      lift_code: lift.lift_code != null ? lift.lift_code : (lift.liftCode != null ? lift.liftCode : null),
    };
  }
  return { name: null, lift_code: null };
}

// Per-lift onboarding state. Input: array of lift objects, each carrying a
// confidence signal (lift_confidence | confidence | confidence_factors).
// Output: the per-lift status list plus per-lift-derived counts. There is NO
// majority gate — the convenience booleans are derived from the per-lift list
// and the consuming layer must phrase each lift off its own calibration_status.
function onboardingStateForLifts(lifts) {
  const list = (Array.isArray(lifts) ? lifts : []).map((lift) => {
    const lift_confidence = normalizeConfidence(lift) || 'none';
    const { name, lift_code } = idOf(lift);
    return {
      name,
      lift_code,
      lift_confidence,
      calibration_status: calibrationStatusFor(lift_confidence),
    };
  });

  const graduated   = list.filter(l => l.calibration_status === GRADUATED);
  const calibrating = list.filter(l => l.calibration_status === CALIBRATING);

  return {
    per_lift: list,
    graduated,
    calibrating,
    graduated_count: graduated.length,
    calibrating_count: calibrating.length,
    // Per-lift-derived facts, NOT a session gate. Provided for convenience only;
    // the voice/UX layer keys phrasing off each lift's calibration_status.
    all_graduated: list.length > 0 && calibrating.length === 0,
    any_calibrating: calibrating.length > 0,
  };
}

module.exports = {
  CALIBRATING,
  GRADUATED,
  calibrationStatusFor,
  isGraduated,
  onboardingStateForLifts,
};
