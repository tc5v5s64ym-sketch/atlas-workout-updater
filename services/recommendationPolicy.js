'use strict';

const {
  getTrainingGoal,
  normalizeTrainingGoal,
  REASON_CODES,
} = require('./trainingKnowledge');
const { applyConstraints } = require('./recommendationConstraints');

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function roundToIncrement(value, increment = 5) {
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value / increment) * increment;
}

function inferMovementRegion({ movementRegion, exerciseName = '' } = {}) {
  if (movementRegion) return movementRegion;
  const text = exerciseName.toLowerCase();
  if (/(squat|deadlift|leg|lunge|calf|hamstring|quad|glute|rdl)/.test(text)) return 'lower';
  if (/(bench|press|row|curl|tricep|lat|pulldown|shoulder|chest|back|face pull)/.test(text)) return 'upper';
  return 'unknown';
}

function inferExerciseType({ exerciseType, exerciseName = '' } = {}) {
  if (exerciseType) return exerciseType;
  const text = exerciseName.toLowerCase();
  if (/(curl|raise|extension|fly|face pull|pushdown)/.test(text)) return 'isolation';
  if (/(jump|throw|clean|snatch|swing|speed)/.test(text)) return 'power';
  if (/(bench|squat|deadlift|press|row|pullup|pulldown|lunge|rdl)/.test(text)) return 'compound';
  return 'unknown';
}

function getLoadIncrement({ movementRegion, availableIncrement, previousWeight } = {}) {
  if (Number.isFinite(availableIncrement) && availableIncrement > 0) return availableIncrement;
  if (previousWeight && previousWeight <= 50) return 2.5;
  if (movementRegion === 'lower') return 5;
  return 5; // Most gyms in the current Atlas context have 5 lb jumps; override if microplates exist.
}

function shouldReduceForFatigue(recentTrends = {}) {
  return recentTrends.fatigueStatus === 'high'
    || recentTrends.painFlag === true
    || recentTrends.performanceDrop === true
    || recentTrends.sleepStatus === 'poor'
    || recentTrends.failedLastTarget === true;
}

function shouldMaintainForModerateFatigue(recentTrends = {}) {
  return recentTrends.fatigueStatus === 'moderate'
    || recentTrends.recentPR === true
    || recentTrends.rirTrend === 'falling';
}

function previousCompletedWithRoom(previous = {}, policy) {
  if (!previous || !previous.completed) return false;
  if (!Number.isFinite(previous.reps)) return false;
  if (!Number.isFinite(previous.rir)) return true;
  return previous.rir >= policy.targetRIR.min;
}

function estimateWeightFrom1RM(estimated1RM, percent) {
  if (!Number.isFinite(estimated1RM) || !Number.isFinite(percent)) return undefined;
  return estimated1RM * (percent / 100);
}

function chooseBasePrescription({ goal, exerciseName, exerciseType, movementRegion, estimated1RM, previousPerformance }) {
  const policy = getTrainingGoal(goal);
  const isAccessory = exerciseType === 'isolation' || exerciseType === 'machine';
  const isMixedAccessory = policy.id === 'mixed' && isAccessory;

  const repRange = isMixedAccessory && policy.accessoryRepRange
    ? policy.accessoryRepRange
    : (policy.id === 'mixed' && !isAccessory && policy.mainLiftRepRange ? policy.mainLiftRepRange : policy.preferredRepRange);

  const targetSets = isAccessory
    ? clamp(policy.sessionSetsMainLift.targetMin, 2, policy.sessionSetsMainLift.targetMax)
    : policy.sessionSetsMainLift.targetMin;

  let recommendedWeight;
  if (previousPerformance && Number.isFinite(previousPerformance.weight)) {
    recommendedWeight = previousPerformance.weight;
  } else if (estimated1RM) {
    const midPercent = (policy.loadPercent1RM.min + policy.loadPercent1RM.max) / 2;
    recommendedWeight = roundToIncrement(estimateWeightFrom1RM(estimated1RM, midPercent), getLoadIncrement({ movementRegion }));
  }

  return {
    exerciseName,
    goal: policy.id,
    targetSets,
    targetRepRange: { ...repRange },
    allowedRepRange: { ...policy.repRange },
    targetRIR: { ...policy.targetRIR },
    restSeconds: { ...policy.restSeconds },
    recommendedWeight,
    exerciseOrder: policy.exerciseOrder,
    failurePolicy: policy.failurePolicy,
    progressionPriority: [...policy.progressionPriority],
    reasonCodes: [...policy.reasonCodes, REASON_CODES.LLM_NUMBERS_LOCKED],
  };
}

function applyProgression({ prescription, policy, previousPerformance = {}, recentTrends = {}, movementRegion, exerciseType, availableIncrement }) {
  const result = {
    ...prescription,
    progression: 'maintain',
    adjustment: 'none',
    reasonCodes: [...prescription.reasonCodes],
  };

  const increment = getLoadIncrement({ movementRegion, availableIncrement, previousWeight: previousPerformance.weight });
  const completedWithRoom = previousCompletedWithRoom(previousPerformance, policy);
  const atOrAboveTopRep = Number.isFinite(previousPerformance.reps)
    && previousPerformance.reps >= result.targetRepRange.max;
  const insideRepRange = Number.isFinite(previousPerformance.reps)
    && previousPerformance.reps >= result.targetRepRange.min
    && previousPerformance.reps < result.targetRepRange.max;

  if (policy.id === 'recovery' || shouldReduceForFatigue(recentTrends)) {
    const loadMultiplier = policy.id === 'recovery' ? policy.loadMultiplier : 0.9;
    result.progression = 'reduce_stress';
    result.adjustment = recentTrends.painFlag ? 'change_exercise_or_reduce_range' : 'reduce_load_or_volume';
    result.targetSets = Math.max(1, Math.floor(result.targetSets * (policy.volumeMultiplier || 0.67)));
    if (Number.isFinite(previousPerformance.weight)) {
      result.recommendedWeight = roundToIncrement(previousPerformance.weight * loadMultiplier, increment);
    }
    result.targetRIR = policy.id === 'recovery' ? { ...policy.targetRIR } : { min: 3, max: 5 };
    result.reasonCodes.push(REASON_CODES.FATIGUE_HIGH_REDUCE_STRESS, REASON_CODES.NO_PR_CHASING);
    return result;
  }

  if (policy.id === 'power') {
    result.progression = completedWithRoom ? 'maintain_or_small_load_if_speed_crisp' : 'maintain_until_speed_crisp';
    result.adjustment = 'protect_speed_and_quality';
    result.targetRIR = { ...policy.targetRIR };
    result.reasonCodes.push(REASON_CODES.POWER_SPEED_QUALITY, REASON_CODES.AVOID_FAILURE_DEFAULT);
    return result;
  }

  if (previousPerformance.completed === false) {
    result.progression = 'repeat_or_reduce';
    result.adjustment = 'missed_previous_target';
    result.reasonCodes.push(REASON_CODES.MISSED_TARGET_MAINTAIN_OR_REDUCE);
    return result;
  }

  if (shouldMaintainForModerateFatigue(recentTrends)) {
    result.progression = 'maintain';
    result.adjustment = 'fatigue_moderate_or_recent_PR';
    result.reasonCodes.push(REASON_CODES.FATIGUE_MODERATE_MAINTAIN_OR_SMALL_STEP);
    return result;
  }

  if (policy.id === 'strength') {
    if (completedWithRoom && atOrAboveTopRep && Number.isFinite(previousPerformance.weight)) {
      result.progression = 'add_load';
      result.adjustment = 'smallest_available_load_jump';
      result.recommendedWeight = previousPerformance.weight + increment;
      result.reasonCodes.push(REASON_CODES.LOAD_PROGRESS_AFTER_TOP_RANGE, REASON_CODES.HEAVY_LOAD_BIAS);
    } else if (completedWithRoom && insideRepRange) {
      result.progression = 'add_rep';
      result.adjustment = 'build_to_top_of_strength_range';
      result.reasonCodes.push(REASON_CODES.REP_PROGRESS_AFTER_SUCCESS);
    }
    return result;
  }

  if (policy.id === 'hypertrophy') {
    if (completedWithRoom && insideRepRange) {
      result.progression = 'add_rep';
      result.adjustment = 'rep_progression_first';
      result.reasonCodes.push(REASON_CODES.REP_PROGRESS_AFTER_SUCCESS);
      return result;
    }
    if (completedWithRoom && atOrAboveTopRep && Number.isFinite(previousPerformance.weight)) {
      result.progression = 'add_load';
      result.adjustment = 'top_of_rep_range_reached';
      result.recommendedWeight = previousPerformance.weight + increment;
      result.reasonCodes.push(REASON_CODES.LOAD_PROGRESS_AFTER_TOP_RANGE);
      return result;
    }
    if (recentTrends.muscleWeeklySetsBelowTarget === true) {
      result.progression = 'add_set';
      result.adjustment = 'volume_below_target_and_recovery_ok';
      result.targetSets += 1;
      result.reasonCodes.push(REASON_CODES.VOLUME_PROGRESS_IF_RECOVERABLE);
      return result;
    }
    return result;
  }

  if (policy.id === 'conditioning_fat_loss') {
    if (completedWithRoom) {
      result.progression = 'increase_density_or_reps';
      result.adjustment = 'density_before_load';
      result.reasonCodes.push(REASON_CODES.DENSITY_PROGRESS_IF_RECOVERABLE);
    }
    return result;
  }

  if (policy.id === 'muscular_endurance') {
    if (completedWithRoom) {
      result.progression = 'increase_density_or_reps';
      result.adjustment = 'endurance_density_before_load';
      result.reasonCodes.push(REASON_CODES.ENDURANCE_DENSITY_PROGRESS, REASON_CODES.DENSITY_PROGRESS_IF_RECOVERABLE);
    }
    return result;
  }

  if (policy.id === 'mixed') {
    const type = (exerciseType && exerciseType !== 'unknown')
      ? exerciseType
      : inferExerciseType({ exerciseName: prescription.exerciseName });
    if (type === 'isolation' && completedWithRoom && insideRepRange) {
      result.progression = 'add_rep';
      result.adjustment = 'accessory_rep_progression';
      result.reasonCodes.push(REASON_CODES.REP_PROGRESS_AFTER_SUCCESS);
    } else if (completedWithRoom && atOrAboveTopRep && Number.isFinite(previousPerformance.weight)) {
      result.progression = 'add_load';
      result.adjustment = 'main_lift_load_progression';
      result.recommendedWeight = previousPerformance.weight + increment;
      result.reasonCodes.push(REASON_CODES.LOAD_PROGRESS_AFTER_TOP_RANGE);
    }
    return result;
  }

  if (completedWithRoom && insideRepRange) {
    result.progression = 'add_rep';
    result.adjustment = 'sustainable_progress';
    result.reasonCodes.push(REASON_CODES.REP_PROGRESS_AFTER_SUCCESS);
  }
  return result;
}

function buildLLMBrief(prescription) {
  return {
    instruction: 'Explain the prescription in one or two concise coaching sentences. Do not change sets, reps, weight, RIR, rest, or progression decision.',
    lockedNumbers: {
      targetSets: prescription.targetSets,
      targetRepRange: prescription.targetRepRange,
      targetRIR: prescription.targetRIR,
      restSeconds: prescription.restSeconds,
      recommendedWeight: prescription.recommendedWeight,
      weightGuidance: prescription.weightGuidance,
      progression: prescription.progression,
      adjustment: prescription.adjustment,
    },
    reasonCodes: prescription.reasonCodes,
    safetyFlags: prescription.safetyFlags || [],
  };
}

function recommendExercisePrescription(input = {}) {
  const goal = normalizeTrainingGoal(input.goal);
  const policy = getTrainingGoal(goal);
  const movementRegion = inferMovementRegion(input);
  const exerciseType = inferExerciseType(input);

  const basePrescription = chooseBasePrescription({
    goal,
    exerciseName: input.exerciseName || input.exercise || 'Unknown Exercise',
    exerciseType,
    movementRegion,
    estimated1RM: input.estimated1RM,
    previousPerformance: input.previousPerformance || {},
  });

  const progressed = applyProgression({
    prescription: basePrescription,
    policy,
    previousPerformance: input.previousPerformance || {},
    recentTrends: input.recentTrends || {},
    movementRegion,
    exerciseType,
    availableIncrement: input.availableIncrement,
  });

  // Cold start: no real load anchor (no previous weight, no estimated 1RM). Never invent a number —
  // hand back rep/set/RIR work plus an explicit weightGuidance string instead of a made-up weight.
  if (!Number.isFinite(progressed.recommendedWeight)) {
    progressed.recommendedWeight = undefined;
    progressed.weightGuidance = `Choose a load that lands near your target RIR (${progressed.targetRIR.min}-${progressed.targetRIR.max}); log it so Atlas can anchor next time.`;
    if (!progressed.reasonCodes.includes(REASON_CODES.COLD_START_NO_HISTORY)) {
      progressed.reasonCodes.push(REASON_CODES.COLD_START_NO_HISTORY);
    }
  }

  // Optional constraints (time, equipment, pain/injury, frequency, experience) nudge the plan when
  // present. Pure pass-through — no profile system, no persistence, no extra I/O.
  const constrained = applyConstraints(progressed, input.constraints, {
    previousPerformance: input.previousPerformance || {},
  });

  return {
    ...constrained,
    movementRegion,
    exerciseType,
    safetyFlags: constrained.safetyFlags || [],
    llmBrief: buildLLMBrief(constrained),
  };
}

module.exports = {
  recommendExercisePrescription,
  inferMovementRegion,
  inferExerciseType,
  buildLLMBrief,
};
