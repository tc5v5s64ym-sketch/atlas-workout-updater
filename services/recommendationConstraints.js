'use strict';

/**
 * Optional, deterministic constraint pass-through for the recommendation engine.
 *
 * These fields are NOT a user-profile system. They are per-request hints that, when present, nudge
 * an already-computed prescription (volume, load-progression safety, reason codes). When absent,
 * the prescription is returned unchanged. No persistence, no schema, no I/O.
 */

const CONSTRAINT_REASON_CODES = Object.freeze({
  TIME_CAPPED_VOLUME: 'constraint_time_capped_volume',
  PAIN_NO_LOAD_INCREASE: 'constraint_pain_no_load_increase',
  EQUIPMENT_LIMITED: 'constraint_equipment_limited',
  LOW_FREQUENCY_PRIORITIZE_COMPOUNDS: 'constraint_low_frequency_prioritize_compounds',
  BEGINNER_BIAS_TECHNIQUE: 'constraint_beginner_bias_technique',
});

const SHORT_SESSION_MINUTES = 30;
const LOW_FREQUENCY_DAYS = 2;

function hasItems(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function applyConstraints(prescription, constraints, { previousPerformance = {} } = {}) {
  if (!constraints || typeof constraints !== 'object') return prescription;

  const result = {
    ...prescription,
    reasonCodes: [...(prescription.reasonCodes || [])],
    safetyFlags: [...(prescription.safetyFlags || [])],
    constraintsApplied: [...(prescription.constraintsApplied || [])],
  };

  const note = (code, flag) => {
    if (!result.reasonCodes.includes(code)) result.reasonCodes.push(code);
    if (!result.constraintsApplied.includes(code)) result.constraintsApplied.push(code);
    if (flag && !result.safetyFlags.includes(flag)) result.safetyFlags.push(flag);
  };

  // Pain / injury: never push load into pain. Neutralize ANY load-increase variant — the explicit
  // add_load progressions and the power "small load if speed is crisp" option — back to maintain.
  if (hasItems(constraints.painFlags) || hasItems(constraints.injuryConstraints)) {
    if (/add_load|small_load/.test(result.progression || '')) {
      result.progression = 'maintain';
      result.adjustment = 'constraint_pain_hold_load';
      if (Number.isFinite(previousPerformance.weight)) {
        result.recommendedWeight = previousPerformance.weight;
      }
    }
    note(CONSTRAINT_REASON_CODES.PAIN_NO_LOAD_INCREASE, 'respect_pain_or_injury');
  }

  // Short session: trim a set to fit the time box (never below one working set).
  if (Number.isFinite(constraints.sessionMinutes) && constraints.sessionMinutes <= SHORT_SESSION_MINUTES) {
    if (Number.isFinite(result.targetSets) && result.targetSets > 1) {
      result.targetSets -= 1;
    }
    note(CONSTRAINT_REASON_CODES.TIME_CAPPED_VOLUME);
  }

  // Limited equipment: flag so load/exercise selection stays feasible downstream.
  if (typeof constraints.equipmentTier === 'string'
      && /^(minimal|bodyweight|home|limited)$/i.test(constraints.equipmentTier.trim())) {
    note(CONSTRAINT_REASON_CODES.EQUIPMENT_LIMITED);
  }

  // Low training frequency: bias toward compound / priority work.
  if (Number.isFinite(constraints.trainingDaysPerWeek) && constraints.trainingDaysPerWeek <= LOW_FREQUENCY_DAYS) {
    note(CONSTRAINT_REASON_CODES.LOW_FREQUENCY_PRIORITIZE_COMPOUNDS);
  }

  // Beginner: bias technique and consistency over aggressive load chasing.
  if (typeof constraints.experienceLevel === 'string'
      && /^(beginner|novice|new)$/i.test(constraints.experienceLevel.trim())) {
    note(CONSTRAINT_REASON_CODES.BEGINNER_BIAS_TECHNIQUE);
  }

  return result;
}

module.exports = {
  applyConstraints,
  CONSTRAINT_REASON_CODES,
  SHORT_SESSION_MINUTES,
  LOW_FREQUENCY_DAYS,
};
