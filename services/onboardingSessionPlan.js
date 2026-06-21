'use strict';

// Onboarding session-template builder — PR-O2 (Roadmap Step 387).
//
// Pure / deterministic. No I/O, no LLM, no Sheets writes, no schema, no route.
// Emits the spec §3 full-body calibration plan (docs/ONBOARDING_WORKING_WEIGHT_SPEC.md):
// three sessions, 8 reps @ 2 RIR across the major movement patterns
// (squat / horizontal push / horizontal pull / hinge, widening to a vertical
// push + one arm isolation), selecting a lift variant per pattern from the
// available equipment.
//
// Every number is engine-owned — the builder invents none:
//   - buildWorkingWeightProtocol (services/analytics.js) — the 70% start hint or
//     "Start conservative", and the work-up instruction. F1–F3.
//   - buildWarmupRamp (services/sessionBuilder.js) — 50/70/85% ramp, offered ONLY
//     once a working weight exists for the lift (never at `none`). F7.
//   - calibrationStatusFor (services/onboardingState.js, PR-O1) — the per-lift
//     graduated/calibrating label derived from the existing lift_confidence ladder.
//
// Trust contract (spec §6):
//   - A user-stated reference SEEDS the start hint only; it never raises confidence.
//     calibration_status comes solely from lift_confidence (the ladder via PR-O1).
//   - A warm-up ramp is emitted only when a working weight is known (F7), so a
//     cold-start lift (no logged working weight) gets a calibration start hint, not
//     a ramp built on a number that does not exist.
//   - PER-LIFT ONLY (owner call 4): each slot carries its own calibration_status;
//     there is no majority/session gate. A graduated squat and a calibrating
//     deadlift stay distinguishable within the same plan.
//
// This module is unwired (no route, no caller in index.js). The voice gate (PR-O3)
// and UX (PR-O4) consume its output later.

const { buildWorkingWeightProtocol } = require('./analytics');
const { buildWarmupRamp } = require('./sessionBuilder');
const { calibrationStatusFor, GRADUATED } = require('./onboardingState');

const TARGET_REPS = 8;
const TARGET_RIR = 2;

// Equipment a full gym supports. Variant selection prefers barbell first, then
// dumbbell, machine, bodyweight — matching the spec §3 example lifts.
const DEFAULT_EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'bodyweight'];

// Per-pattern lift variants, ordered by equipment preference. The first variant
// whose equipment is available is chosen; if none is available the pattern is
// unsupported and dropped (spec §5: "Calibrate only the lifts the equipment
// supports; unsupported lifts simply stay `none` until trainable").
const PATTERN_VARIANTS = {
  squat: [
    { exercise: 'Back Squat', equipment: 'barbell' },
    { exercise: 'Goblet Squat', equipment: 'dumbbell' },
    { exercise: 'Bodyweight Squat', equipment: 'bodyweight' },
  ],
  horizontal_push: [
    { exercise: 'Bench Press', equipment: 'barbell' },
    { exercise: 'Dumbbell Bench Press', equipment: 'dumbbell' },
    { exercise: 'Chest Press', equipment: 'machine' },
    { exercise: 'Push-Up', equipment: 'bodyweight' },
  ],
  horizontal_pull: [
    { exercise: 'Barbell Row', equipment: 'barbell' },
    { exercise: 'Dumbbell Row', equipment: 'dumbbell' },
    { exercise: 'Lat Pulldown', equipment: 'machine' },
    { exercise: 'Inverted Row', equipment: 'bodyweight' },
  ],
  hinge: [
    { exercise: 'Romanian Deadlift', equipment: 'barbell' },
    { exercise: 'Dumbbell RDL', equipment: 'dumbbell' },
    { exercise: 'Back Extension', equipment: 'machine' },
    { exercise: 'Hip Hinge', equipment: 'bodyweight' },
  ],
  vertical_push: [
    { exercise: 'Overhead Press', equipment: 'barbell' },
    { exercise: 'Dumbbell Shoulder Press', equipment: 'dumbbell' },
    { exercise: 'Machine Shoulder Press', equipment: 'machine' },
    { exercise: 'Pike Push-Up', equipment: 'bodyweight' },
  ],
  isolation: [
    { exercise: 'Barbell Curl', equipment: 'barbell' },
    { exercise: 'Dumbbell Curl', equipment: 'dumbbell' },
    { exercise: 'Cable Curl', equipment: 'machine' },
  ],
};

// The four core compounds map the big patterns (S1). The widen slots (S2/S3) add
// a vertical push + one isolation, per spec §3.
const CORE_PATTERNS = ['squat', 'horizontal_push', 'horizontal_pull', 'hinge'];
const WIDEN_PATTERNS = ['vertical_push', 'isolation'];

const SESSIONS = [
  { session: 1, focus: 'Map the big patterns', patterns: CORE_PATTERNS },
  { session: 2, focus: 'Confirm and nudge', patterns: [...CORE_PATTERNS, ...WIDEN_PATTERNS] },
  { session: 3, focus: 'Cross into medium', patterns: [...CORE_PATTERNS, ...WIDEN_PATTERNS] },
];

function normalizeEquipment(available) {
  const list = Array.isArray(available) ? available : DEFAULT_EQUIPMENT;
  return new Set(list.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
}

// First variant whose equipment is supported, or null when the pattern can't be
// trained with what's available.
function selectVariant(pattern, equipmentSet) {
  const variants = PATTERN_VARIANTS[pattern] || [];
  return variants.find((v) => equipmentSet.has(v.equipment)) || null;
}

function positiveNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Build one slot for a pattern. `state` is the optional per-pattern signal:
//   { lift_confidence, reference, working_weight }
// - calibration_status comes from lift_confidence via PR-O1 (missing → calibrating).
// - A graduated lift with a known working weight gets a warm-up ramp + working_weight
//   (F7); the start-hint protocol is omitted (it's no longer calibrating).
// - Otherwise the slot is calibrating: a start hint from buildWorkingWeightProtocol
//   (reference → 70% hint, else "Start conservative"), no ramp.
function buildSlot(pattern, variant, state) {
  const s = state && typeof state === 'object' ? state : {};
  const calibration_status = calibrationStatusFor(s.lift_confidence);
  const workingWeight = positiveNumber(s.working_weight);

  const slot = {
    pattern,
    exercise: variant.exercise,
    equipment: variant.equipment,
    target_reps: TARGET_REPS,
    target_rir: TARGET_RIR,
    calibration_status,
  };

  // Ramp only when a working weight genuinely exists (F7). Graduation alone does
  // not synthesize a number — without a working weight we stay in calibration.
  if (calibration_status === GRADUATED && workingWeight != null) {
    slot.working_weight = workingWeight;
    slot.warmup_sets = buildWarmupRamp(workingWeight);
    slot.protocol = null;
  } else {
    slot.working_weight = null;
    slot.warmup_sets = [];
    slot.protocol = buildWorkingWeightProtocol({
      targetReps: TARGET_REPS,
      targetRir: TARGET_RIR,
      referenceWeight: positiveNumber(s.reference),
    });
  }

  return slot;
}

// Build the three-session onboarding calibration template.
//
// Options:
//   availableEquipment — string[] of equipment on hand (default: full gym). A
//                        pattern with no supported variant is dropped and listed
//                        in `unsupported_patterns`.
//   lifts              — optional per-pattern state keyed by pattern id, e.g.
//                        { squat: { lift_confidence:'medium', working_weight:225 },
//                          horizontal_push: { reference: 185 } }. Anything omitted
//                        is treated as a cold lift (none → calibrating, no working
//                        weight, "Start conservative").
//
// Returns a pure object; no state is persisted.
function buildOnboardingSessionPlan({ availableEquipment, lifts } = {}) {
  const equipmentSet = normalizeEquipment(availableEquipment);
  const liftState = lifts && typeof lifts === 'object' ? lifts : {};

  // Resolve a variant per pattern once; unsupported patterns are dropped everywhere.
  const variantByPattern = {};
  const unsupported = [];
  for (const pattern of Object.keys(PATTERN_VARIANTS)) {
    const variant = selectVariant(pattern, equipmentSet);
    if (variant) variantByPattern[pattern] = variant;
    else unsupported.push(pattern);
  }

  const sessions = SESSIONS.map(({ session, focus, patterns }) => ({
    session,
    focus,
    target_reps: TARGET_REPS,
    target_rir: TARGET_RIR,
    slots: patterns
      .filter((p) => variantByPattern[p])
      .map((p) => buildSlot(p, variantByPattern[p], liftState[p])),
  }));

  return {
    shape: 'full_body_calibration',
    available_equipment: Array.from(equipmentSet),
    unsupported_patterns: unsupported,
    sessions,
  };
}

module.exports = {
  buildOnboardingSessionPlan,
  DEFAULT_EQUIPMENT,
  PATTERN_VARIANTS,
  CORE_PATTERNS,
  WIDEN_PATTERNS,
};
