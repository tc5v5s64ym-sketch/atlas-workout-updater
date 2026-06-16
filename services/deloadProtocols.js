// services/deloadProtocols.js
//
// The predefined deload protocols, per docs/DELOAD_SPEC.md.
//
// CORE PRINCIPLE (from the spec): the AI decides *if* a deload is needed; this
// module decides *what* the deload is. Atlas must never invent percentages or
// durations — it selects one of these frozen protocols and applies its fixed
// multipliers to the lifter's real working numbers. Every value here is taken
// directly from the spec; changing a number means changing the spec first.
//
// This module is pure and standalone (no I/O, no other-service coupling) so its
// fixtures can pin the spec's worked examples exactly.

// A protocol holds a lift's working weight constant only by NOT setting
// load_multiplier to 1 — these protocols all reduce load AND volume per the
// spec's prescription tables. The values are frozen so nothing downstream can
// mutate a shared protocol object.
const STRENGTH_DELOAD_V1 = Object.freeze({
  id: 'STRENGTH_DELOAD_V1',
  focus: 'strength',
  purpose: 'Reduce fatigue while preserving strength skill.',
  load_multiplier: 0.92,
  set_multiplier: 0.50,
  target_rir: 5,
  // Duration is expressed in training exposures of the lift, not calendar time.
  duration_min_exposures: 1,
  duration_max_exposures: 1,
  // 1 week maximum; at low frequency a single exposure can span a week.
  exit: 'Return immediately to the previous working weight.',
  remove: Object.freeze([]),
  notes: Object.freeze([])
});

const HYPERTROPHY_DELOAD_V1 = Object.freeze({
  id: 'HYPERTROPHY_DELOAD_V1',
  focus: 'hypertrophy',
  purpose: 'Reduce fatigue and muscle damage.',
  load_multiplier: 0.85,
  set_multiplier: 0.50,
  target_rir: 5,
  duration_min_exposures: 1,
  duration_max_exposures: 1,
  exit: 'Return to normal training after one week.',
  remove: Object.freeze(['failure sets', 'drop sets', 'rest-pause', 'intensity techniques']),
  notes: Object.freeze([])
});

const POWER_DELOAD_V1 = Object.freeze({
  id: 'POWER_DELOAD_V1',
  focus: 'power',
  purpose: 'Preserve speed and explosiveness.',
  load_multiplier: 0.90,
  set_multiplier: 0.35,
  target_rir: 4,
  duration_min_exposures: 1,
  duration_max_exposures: 1,
  exit: 'Return to normal training after one week.',
  remove: Object.freeze([]),
  notes: Object.freeze(['Terminate sets when speed declines.'])
});

const ENDURANCE_DELOAD_V1 = Object.freeze({
  id: 'ENDURANCE_DELOAD_V1',
  focus: 'endurance',
  purpose: 'Reduce accumulated fatigue.',
  load_multiplier: 0.80,
  set_multiplier: 0.60,
  target_rir: 5,
  duration_min_exposures: 1,
  duration_max_exposures: 1,
  exit: 'Return to normal training after one week.',
  remove: Object.freeze([]),
  notes: Object.freeze([])
});

const PROTOCOLS = Object.freeze({
  STRENGTH_DELOAD_V1,
  HYPERTROPHY_DELOAD_V1,
  POWER_DELOAD_V1,
  ENDURANCE_DELOAD_V1
});

// Map a training focus to its protocol. Strength is the default fallback for an
// unknown/missing focus — it is the most conservative cut (0.92 load), so an
// unclassified lifter is never over-deloaded. Selection is the engine's job;
// it must always resolve to a real protocol, never null.
const FOCUS_TO_PROTOCOL = Object.freeze({
  strength: STRENGTH_DELOAD_V1,
  hypertrophy: HYPERTROPHY_DELOAD_V1,
  power: POWER_DELOAD_V1,
  endurance: ENDURANCE_DELOAD_V1
});

function selectProtocol(trainingFocus) {
  const key = String(trainingFocus == null ? '' : trainingFocus).trim().toLowerCase();
  return FOCUS_TO_PROTOCOL[key] || STRENGTH_DELOAD_V1;
}

// Round a computed load to the nearest rackable increment (default 5 lb) so a
// multiplier-derived weight reads as a real, loadable number: 225 × 0.92 = 207
// → 205. Mirrors analytics.roundLoad's semantics; kept local so this module
// stays dependency-free for fixtures.
function roundLoad(weight, step = 5) {
  if (weight == null || weight === '') return null;
  const w = Number(weight);
  if (!Number.isFinite(w)) return null;
  const s = Number.isFinite(step) && step > 0 ? step : 5;
  return Math.round(w / s) * s;
}

// Apply a protocol to a lift's real working numbers, producing the deterministic
// prescription. The engine owns these numbers; the coach only ever words them.
//   working_weight → load held at protocol.load_multiplier, rounded to `step`
//   working_sets   → cut by protocol.set_multiplier, rounded, floored at 1
//   target_rir     → straight from the protocol
// A deload is still a real session: at least one working set survives the cut.
// Returns null when there is no usable working weight to scale.
function computePrescription(protocol, { working_weight, working_sets, step = 5 } = {}) {
  if (!protocol || typeof protocol !== 'object') return null;

  // A working weight must be a real positive load. Guard explicitly: Number(null)
  // is 0, which would otherwise sail through as a bogus 0 lb prescription.
  const baseWeight = Number(working_weight);
  if (!Number.isFinite(baseWeight) || baseWeight <= 0) return null;

  const weight = roundLoad(baseWeight * Number(protocol.load_multiplier), step);
  if (weight == null) return null;

  const baseSets = Number(working_sets);
  const target_sets = Number.isFinite(baseSets) && baseSets > 0
    ? Math.max(1, Math.round(baseSets * Number(protocol.set_multiplier)))
    : null;

  return {
    protocol_id: protocol.id,
    weight,
    target_sets,
    target_rir: protocol.target_rir
  };
}

module.exports = {
  STRENGTH_DELOAD_V1,
  HYPERTROPHY_DELOAD_V1,
  POWER_DELOAD_V1,
  ENDURANCE_DELOAD_V1,
  PROTOCOLS,
  selectProtocol,
  computePrescription,
  roundLoad
};
