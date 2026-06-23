'use strict';

// Exercise Modality Schema — Training Profile Taxonomy §3 (PR 478).
//
// PURE DATA / derivation. Given an exercise name, return the modality "lens" the
// engine should use to interpret a logged row: what kind of exercise it is, how
// load is applied, its dominant fatigue cost, how effort is measured, and what
// "progress" means for it.
//
// This module is REFERENCE-ONLY for now — it reads nothing and writes nothing:
// no I/O, no LLM, no Sheets, NO write path, and NO `Log_Cleaned` (12-col) schema
// change. It is metadata the engine can later consult to decide how to read a
// row; wiring is a separate, owner-gated slice (see docs/TRAINING_PROFILE_TAXONOMY.md).
//
// It EXTENDS the existing `EXERCISE_TYPES` (services/trainingKnowledge.js) with
// cardio/timed/circuit kinds and reuses the existing resistance classifiers
// (liftRole / liftCost) rather than re-deriving them.

const { classifyLiftRole } = require('./liftRole');
const { costFor } = require('./liftCost');

// ─── Controlled vocabularies (Taxonomy §3 enums) ──────────────────────────────

// Extends today's compound|isolation|machine|bodyweight|power|unknown.
const EXERCISE_TYPES = Object.freeze([
  'compound', 'isolation', 'machine', 'bodyweight', 'power',
  'cardio_steady', 'cardio_interval', 'circuit', 'timed_hold', 'mobility', 'unknown',
]);

const LOAD_TYPES = Object.freeze([
  'external_weight', 'bodyweight', 'added_load_bodyweight', 'assisted_bodyweight',
  'cardio_machine', 'locomotion', 'timed', 'none',
]);

const FATIGUE_CLASSES = Object.freeze([
  'high_cns', 'moderate_systemic', 'local', 'metabolic', 'aerobic', 'anaerobic',
]);

const EFFORT_METRICS = Object.freeze([
  'rir', 'rpe', 'hr', 'hr_zone', 'pace', 'duration', 'distance', 'rounds', 'completion',
]);

const PROGRESSION_METRICS = Object.freeze([
  'load', 'reps', 'total_volume', 'density', 'duration', 'distance',
  'pace', 'hr_at_pace', 'rounds', 'leverage', 'assistance',
]);

// ─── Name-pattern detectors (most specific first) ─────────────────────────────
// Each detector returns the full modality record when it matches. Order matters:
// circuits/intervals/holds/cardio are checked before the resistance default so a
// non-resistance modality is never mis-read as a weighted lift.

const CIRCUIT_RE = /\bamrap\b|\bemom\b|\bcircuit\b|\bmetcon\b|\bwod\b|\btabata\b/i;
const INTERVAL_RE = /\binterval|\bsprints?\b|\bfartlek\b|\bhiit\b/i;
const HOLD_RE = /\bplank\b|\bwall\s*sit\b|\bdead\s*hang\b|\bhollow\s*hold\b|\bl-?sit\b|\bhold\b|\biso(?:metric)?\s*hold\b/i;
const CARDIO_MACHINE_RE = /\bellipt|treadmill|stair\s*master|stairmaster|stair\s*climber|stationary\s*bike|exercise\s*bike|assault\s*bike|air\s*dyne|airdyne|spin\s*bike|\bspin\b|rowing\s*machine|row\s*erg|\berg\b|ski\s*erg|arc\s*trainer|\bcycling\b|\bcycle\b/i;
const LOCOMOTION_RE = /\brun(?:ning)?\b|\bjog(?:ging)?\b|\bwalk(?:ing)?\b|\bhike|\bruck|\bswim/i;
const ASSISTED_RE = /\bassisted\b|\bband(?:ed)?\s*assist/i;
const ADDED_LOAD_RE = /\bweighted\b|\+\s*\d|\bw\/\s*\d/i; // "Weighted Dip", "Dips +25", "Pullup w/ 25"
const BODYWEIGHT_RE = /\bpush[\s-]*ups?\b|\bpull[\s-]*ups?\b|\bchin[\s-]*ups?\b|\bsit[\s-]*ups?\b|\bair\s*squats?\b|\bbody\s*weight\b|\bbodyweight\b|\bburpees?\b|\bmountain\s*climbers?\b|\bglute\s*bridge\b|\bnordic\b|\bpistol\s*squat\b|\bhanging\s*leg\s*raise\b/i;
const DIP_PULL_RE = /\bdips?\b|\bpull[\s-]*ups?\b|\bchin[\s-]*ups?\b|\bmuscle[\s-]*ups?\b/i;
const MOBILITY_RE = /\bstretch|\bmobility\b|\bfoam\s*roll|\byoga\b|\bwarm\s*up\b/i;
const MACHINE_RE = /\bmachine\b|\bcable\b|\bpec\s*deck\b|\bsmith\b|\bleg\s*press\b|\bleg\s*extension\b|\bleg\s*curl\b|\blat\s*pull|\bpulldown\b|\bpec\s*fly\b/i;
const POWER_RE = /\bclean\b|\bsnatch\b|\bjerk\b|\bclean\s*&?\s*jerk\b/i;

function rec(exercise_type, load_type, fatigue_class, effort_metric, effort_alternates, progression_metric) {
  return {
    exercise_type,
    load_type,
    fatigue_class,
    effort_metric,                          // primary
    effort_metric_alternates: effort_alternates.slice(),
    progression_metric,
  };
}

// Resistance fatigue class from the existing role + cost classifiers.
function resistanceFatigue(name, muscleGroup) {
  const role = classifyLiftRole(name, muscleGroup || '');
  const cost = costFor(name).cost;
  if (role === 'accessory') return 'local';
  if (role === 'main' && cost === 'high') return 'high_cns';
  return 'moderate_systemic';
}

function resistanceType(name, muscleGroup) {
  if (POWER_RE.test(name)) return 'power';
  if (MACHINE_RE.test(name)) return 'machine';
  return classifyLiftRole(name, muscleGroup || '') === 'accessory' ? 'isolation' : 'compound';
}

/**
 * Resolve the modality record for an exercise. Pure; name + optional muscle group.
 * Returns a record whose every field is a member of the controlled vocabularies.
 *
 * @param {string} name
 * @param {{ muscleGroup?: string }} [opts]
 * @returns {{exercise_type,load_type,fatigue_class,effort_metric,effort_metric_alternates,progression_metric}}
 */
function modalityFor(name, opts = {}) {
  const n = String(name == null ? '' : name).trim();
  const mg = opts && opts.muscleGroup;
  if (!n) return rec('unknown', 'none', 'local', 'completion', [], 'reps');

  // 1. Circuits (AMRAP/EMOM/metcon) — density-driven.
  if (CIRCUIT_RE.test(n)) return rec('circuit', 'bodyweight', 'metabolic', 'rounds', ['rpe'], 'density');

  // 2. Intervals — anaerobic, rounds → pace.
  if (INTERVAL_RE.test(n)) return rec('cardio_interval', 'locomotion', 'anaerobic', 'hr_zone', ['pace', 'rounds'], 'rounds');

  // 3. Timed holds — duration is the whole point.
  if (HOLD_RE.test(n)) return rec('timed_hold', 'timed', 'local', 'duration', ['rpe'], 'duration');

  // 4. Cardio machines — steady-state aerobic.
  if (CARDIO_MACHINE_RE.test(n)) return rec('cardio_steady', 'cardio_machine', 'aerobic', 'hr_zone', ['rpe', 'duration'], 'duration');

  // 5. Running / walking / locomotion — pace-primary.
  if (LOCOMOTION_RE.test(n)) return rec('cardio_steady', 'locomotion', 'aerobic', 'pace', ['hr_zone', 'duration'], 'pace');

  // 6. Mobility / stretching.
  if (MOBILITY_RE.test(n)) return rec('mobility', 'none', 'local', 'completion', ['duration'], 'duration');

  // 7. Assisted bodyweight (band/machine assist) — progress by REDUCING assistance.
  if (ASSISTED_RE.test(n) && DIP_PULL_RE.test(n)) return rec('bodyweight', 'assisted_bodyweight', 'local', 'rir', ['rpe'], 'assistance');

  // 8. Added-load bodyweight (Weighted Dip, Dips +25) — progress by load.
  if (ADDED_LOAD_RE.test(n) && DIP_PULL_RE.test(n)) return rec('bodyweight', 'added_load_bodyweight', 'moderate_systemic', 'rir', ['rpe'], 'load');

  // 9. Bodyweight calisthenics — progress by reps then leverage.
  if (BODYWEIGHT_RE.test(n) || (DIP_PULL_RE.test(n) && !MACHINE_RE.test(n))) {
    return rec('bodyweight', 'bodyweight', 'local', 'rir', ['rpe'], 'reps');
  }

  // 10. Default: external-weight resistance (today's RIR/weight workflow).
  return rec(resistanceType(n, mg), 'external_weight', resistanceFatigue(n, mg), 'rir', ['rpe'], 'load');
}

// Validate a modality record against the controlled vocabularies (defensive; used
// by tests and any future wiring layer). Returns true iff every field is in-enum.
function isValidModality(m) {
  if (!m || typeof m !== 'object') return false;
  return EXERCISE_TYPES.includes(m.exercise_type)
    && LOAD_TYPES.includes(m.load_type)
    && FATIGUE_CLASSES.includes(m.fatigue_class)
    && EFFORT_METRICS.includes(m.effort_metric)
    && PROGRESSION_METRICS.includes(m.progression_metric)
    && Array.isArray(m.effort_metric_alternates)
    && m.effort_metric_alternates.every(a => EFFORT_METRICS.includes(a));
}

module.exports = {
  modalityFor,
  isValidModality,
  EXERCISE_TYPES,
  LOAD_TYPES,
  FATIGUE_CLASSES,
  EFFORT_METRICS,
  PROGRESSION_METRICS,
};
