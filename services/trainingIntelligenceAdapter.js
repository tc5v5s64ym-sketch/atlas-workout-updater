'use strict';

// Training Intelligence Adapter (PR 484 wiring slice 1).
//
// Pure bridges from LIVE app data to the Training-Intelligence engine
// vocabularies, so the deterministic engines (stimulusGovernor, fatigueRouter,
// recoveryDeloadSelection, objectiveScorer — PRs 480–485) can be fed from real
// signals in a later wiring slice without each call site re-deriving the mapping.
//
//   profileForGoal(goal)         training goal  → governor/scorer PROFILE
//   modalityCategoryFor(name)    exercise name  → governor/router MODALITY_CATEGORY
//
// PURE: no I/O, no LLM, no Sheets, NO write path, NO schema change. Read-only
// vocabulary mapping. Not yet wired into any surface (that is the next slice).

const { normalizeTrainingGoal } = require('./trainingKnowledge');
const { modalityFor } = require('./exerciseModality');
const { PROFILES } = require('./stimulusGovernorRules');

// Map a persisted/derived TRAINING_GOALS key onto a governor/scorer PROFILE.
// The engine PROFILES (strength | hypertrophy | general_fitness | cardio |
// bodyweight) are a SMALLER set than TRAINING_GOALS; this is the documented
// projection. `bodyweight` is equipment-driven (never a goal), so no goal maps to
// it here — modality, not goal, surfaces bodyweight.
const GOAL_TO_PROFILE = Object.freeze({
  strength: 'strength',
  power: 'strength',                  // power is strength-adjacent (heavy, low-rep, CNS)
  hypertrophy: 'hypertrophy',
  mixed: 'hypertrophy',              // powerbuilding leans hypertrophy for stimulus rules
  conditioning_fat_loss: 'cardio',
  muscular_endurance: 'general_fitness',
  general_health: 'general_fitness',
  recovery: 'general_fitness',       // a state, not a stimulus profile → safe default
});

/**
 * Project a training goal onto a governor/scorer PROFILE. Accepts raw aliases
 * (normalized via normalizeTrainingGoal). Unknown/empty → 'general_fitness'.
 * @param {string} goal
 * @returns {string} one of PROFILES
 */
function profileForGoal(goal) {
  const normalized = normalizeTrainingGoal(goal); // always a TRAINING_GOALS key
  const profile = GOAL_TO_PROFILE[normalized] || 'general_fitness';
  // Defensive: never emit a profile outside the engine vocabulary.
  return PROFILES.includes(profile) ? profile : 'general_fitness';
}

// Map an exercise's modality (exerciseModality.exercise_type) onto the coarse
// governor/router MODALITY_CATEGORY.
const TYPE_TO_CATEGORY = Object.freeze({
  cardio_steady: 'cardio',
  cardio_interval: 'cardio',
  circuit: 'circuit',
  timed_hold: 'timed',
  mobility: 'timed',                 // duration-based, no RIR
  bodyweight: 'bodyweight',
  // compound | isolation | machine | power | unknown → resistance (default)
});

/**
 * Coarse modality category for an exercise name. Bodyweight load variants
 * (added-load / assisted) still read as the `bodyweight` category, since the
 * governor's RIR rules treat them as bodyweight (reps/RIR). Default: resistance.
 * @param {string} name
 * @returns {string} one of MODALITY_CATEGORIES
 */
function modalityCategoryFor(name) {
  const m = modalityFor(name);
  // exercise_type wins (a circuit's load_type is 'bodyweight' but it is a circuit).
  const byType = TYPE_TO_CATEGORY[m.exercise_type];
  if (byType) return byType;
  // Resistance-typed lifts (compound/isolation/machine/power/unknown): a bodyweight
  // load still reads as the bodyweight category for the governor's RIR rules.
  if (m.load_type === 'bodyweight' || m.load_type === 'added_load_bodyweight' || m.load_type === 'assisted_bodyweight') return 'bodyweight';
  if (m.load_type === 'cardio_machine' || m.load_type === 'locomotion') return 'cardio';
  if (m.load_type === 'timed') return 'timed';
  return 'resistance';
}

module.exports = { profileForGoal, modalityCategoryFor, GOAL_TO_PROFILE };
