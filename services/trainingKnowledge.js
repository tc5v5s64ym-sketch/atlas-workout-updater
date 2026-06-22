'use strict';

/**
 * Atlas Training Knowledge v1
 *
 * Purpose:
 * Convert the pasted training/research material into deterministic policy data.
 * Atlas should use this file to decide prescription constraints.
 * The LLM may explain the decision, but should not invent numbers when these rules apply.
 */

const TRAINING_GOALS = Object.freeze({
  strength: Object.freeze({
    id: 'strength',
    label: 'Strength',
    primaryAdaptation: 'max_force_output',
    description: 'Improve maximal force production on key lifts.',
    repRange: Object.freeze({ min: 1, max: 6 }),
    preferredRepRange: Object.freeze({ min: 3, max: 5 }),
    loadPercent1RM: Object.freeze({ min: 80, max: 95 }),
    targetRIR: Object.freeze({ min: 1, max: 3 }),
    failurePolicy: 'avoid_default_failure_on_compounds',
    weeklyMuscleSets: Object.freeze({ min: 6, targetMin: 8, targetMax: 14, max: 18 }),
    sessionSetsMainLift: Object.freeze({ min: 2, targetMin: 3, targetMax: 5, max: 6 }),
    restSeconds: Object.freeze({ min: 120, targetMin: 150, targetMax: 240, max: 300 }),
    exerciseOrder: 'main_lifts_first',
    progressionPriority: Object.freeze(['load', 'reps', 'sets', 'technique']),
    progressionTriggers: Object.freeze({
      addLoadWhen: 'all_target_sets_completed_at_or_above_top_rep_range_with_target_RIR',
      maintainWhen: 'target_completed_but_RIR_low_or_form_questionable',
      reduceWhen: 'missed_target_or_fatigue_high_or_pain_flagged',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 2.5, lower: 5, default: 2.5 }),
    reasonCodes: Object.freeze(['goal_strength', 'heavy_load_bias', 'main_lift_first', 'avoid_failure_default']),
  }),

  hypertrophy: Object.freeze({
    id: 'hypertrophy',
    label: 'Hypertrophy',
    primaryAdaptation: 'muscle_growth',
    description: 'Build muscle using sufficient effort and recoverable weekly volume.',
    repRange: Object.freeze({ min: 5, max: 30 }),
    preferredRepRange: Object.freeze({ min: 8, max: 15 }),
    loadPercent1RM: Object.freeze({ min: 30, max: 85 }),
    targetRIR: Object.freeze({ min: 0, max: 3 }),
    failurePolicy: 'near_failure_enough_select_failure_on_safe_later_sets',
    weeklyMuscleSets: Object.freeze({ min: 8, targetMin: 10, targetMax: 20, max: 24 }),
    sessionSetsMainLift: Object.freeze({ min: 2, targetMin: 3, targetMax: 5, max: 6 }),
    restSeconds: Object.freeze({ min: 60, targetMin: 90, targetMax: 180, max: 240 }),
    exerciseOrder: 'highest_priority_muscle_or_biggest_skill_lift_first',
    progressionPriority: Object.freeze(['reps', 'sets', 'load', 'range_of_motion', 'technique']),
    progressionTriggers: Object.freeze({
      addRepsWhen: 'inside_rep_range_and_previous_sets_completed_with_target_RIR',
      addLoadWhen: 'top_of_rep_range_reached_across_sets_with_clean_form',
      addSetWhen: 'volume_below_target_and_recovery_good',
      maintainWhen: 'near_top_of_volume_or_recovery_uncertain',
      reduceWhen: 'volume_exceeds_recovery_or_performance_drops',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 2.5, lower: 5, default: 2.5 }),
    reasonCodes: Object.freeze(['goal_hypertrophy', 'volume_and_effort_bias', 'rep_progression_first']),
  }),

  power: Object.freeze({
    id: 'power',
    label: 'Power',
    primaryAdaptation: 'rate_of_force_development',
    description: 'Produce force quickly; prioritize speed, freshness, and rep quality.',
    repRange: Object.freeze({ min: 1, max: 5 }),
    preferredRepRange: Object.freeze({ min: 2, max: 4 }),
    loadPercent1RM: Object.freeze({ min: 30, max: 70 }),
    targetRIR: Object.freeze({ min: 3, max: 6 }),
    failurePolicy: 'never_chase_failure_for_power',
    weeklyMuscleSets: Object.freeze({ min: 4, targetMin: 6, targetMax: 12, max: 16 }),
    sessionSetsMainLift: Object.freeze({ min: 3, targetMin: 3, targetMax: 6, max: 8 }),
    totalQualityRepSetBudget: Object.freeze({ maxRepsTimesSets: 24 }),
    restSeconds: Object.freeze({ min: 90, targetMin: 120, targetMax: 240, max: 300 }),
    exerciseOrder: 'power_work_first_after_warmup',
    progressionPriority: Object.freeze(['speed', 'quality', 'load', 'sets']),
    progressionTriggers: Object.freeze({
      addLoadWhen: 'speed_and_technique_stay_crisp_at_current_load',
      maintainWhen: 'speed_slowed_or_fatigue_visible',
      stopSetWhen: 'bar_speed_or_explosive_intent_drops',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 2.5, lower: 5, default: 2.5 }),
    reasonCodes: Object.freeze(['goal_power', 'speed_intent_bias', 'avoid_grinding_reps']),
  }),

  conditioning_fat_loss: Object.freeze({
    id: 'conditioning_fat_loss',
    label: 'Conditioning / Fat Loss Support',
    primaryAdaptation: 'work_capacity_and_muscle_retention',
    description: 'Maintain strength and muscle while increasing training density and energy output.',
    repRange: Object.freeze({ min: 8, max: 20 }),
    preferredRepRange: Object.freeze({ min: 10, max: 15 }),
    loadPercent1RM: Object.freeze({ min: 40, max: 75 }),
    targetRIR: Object.freeze({ min: 1, max: 4 }),
    failurePolicy: 'avoid_failure_when_recovery_or_calories_are_limited',
    weeklyMuscleSets: Object.freeze({ min: 6, targetMin: 8, targetMax: 16, max: 20 }),
    sessionSetsMainLift: Object.freeze({ min: 2, targetMin: 3, targetMax: 4, max: 5 }),
    restSeconds: Object.freeze({ min: 45, targetMin: 60, targetMax: 120, max: 180 }),
    exerciseOrder: 'protect_primary_lift_quality_then_density',
    progressionPriority: Object.freeze(['density', 'reps', 'sets', 'load']),
    progressionTriggers: Object.freeze({
      increaseDensityWhen: 'work_completed_with_stable_performance_and_recovery_good',
      addRepsWhen: 'inside_rep_range_and_RIR_target_met',
      maintainWhen: 'calorie_deficit_or_fatigue_present',
      reduceWhen: 'main_lift_quality_falls_or_recovery_poor',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 2.5, lower: 5, default: 2.5 }),
    reasonCodes: Object.freeze(['goal_conditioning_fat_loss', 'density_bias', 'preserve_strength_bias']),
  }),

  muscular_endurance: Object.freeze({
    id: 'muscular_endurance',
    label: 'Muscular Endurance',
    primaryAdaptation: 'local_muscular_endurance',
    description: 'Improve a muscle’s ability to sustain high-rep resistance work: more reps, shorter rest, more density.',
    repRange: Object.freeze({ min: 12, max: 30 }),
    preferredRepRange: Object.freeze({ min: 15, max: 25 }),
    loadPercent1RM: Object.freeze({ min: 30, max: 60 }),
    targetRIR: Object.freeze({ min: 1, max: 3 }),
    failurePolicy: 'near_failure_ok_on_safe_work',
    weeklyMuscleSets: Object.freeze({ min: 6, targetMin: 8, targetMax: 16, max: 20 }),
    sessionSetsMainLift: Object.freeze({ min: 2, targetMin: 3, targetMax: 4, max: 5 }),
    restSeconds: Object.freeze({ min: 20, targetMin: 30, targetMax: 60, max: 90 }),
    exerciseOrder: 'circuit_or_density_friendly',
    progressionPriority: Object.freeze(['density', 'reps', 'sets', 'load']),
    progressionTriggers: Object.freeze({
      increaseDensityWhen: 'work_completed_with_stable_performance_and_short_rest_held',
      addRepsWhen: 'inside_rep_range_and_RIR_target_met',
      addLoadWhen: 'top_of_rep_range_held_with_short_rest_and_clean_form',
      maintainWhen: 'recovery_uncertain_or_form_degrading',
      reduceWhen: 'performance_drops_or_form_degrades',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 2.5, lower: 5, default: 2.5 }),
    reasonCodes: Object.freeze(['goal_muscular_endurance', 'high_rep_bias', 'endurance_density_bias']),
  }),

  general_health: Object.freeze({
    id: 'general_health',
    label: 'General Health',
    primaryAdaptation: 'broad_resistance_training_health',
    description: 'Build sustainable strength, muscle, confidence, and physical capacity.',
    repRange: Object.freeze({ min: 6, max: 15 }),
    preferredRepRange: Object.freeze({ min: 8, max: 12 }),
    loadPercent1RM: Object.freeze({ min: 50, max: 80 }),
    targetRIR: Object.freeze({ min: 2, max: 4 }),
    failurePolicy: 'do_not_require_failure',
    weeklyMuscleSets: Object.freeze({ min: 4, targetMin: 6, targetMax: 12, max: 16 }),
    sessionSetsMainLift: Object.freeze({ min: 2, targetMin: 2, targetMax: 4, max: 5 }),
    restSeconds: Object.freeze({ min: 60, targetMin: 90, targetMax: 150, max: 240 }),
    exerciseOrder: 'safe_compounds_then_accessories',
    progressionPriority: Object.freeze(['consistency', 'technique', 'reps', 'load']),
    progressionTriggers: Object.freeze({
      addRepsWhen: 'technique_clean_and_RIR_target_met',
      addLoadWhen: 'top_of_rep_range_clean_for_multiple_sessions',
      maintainWhen: 'consistency_or_technique_is_the_priority',
      reduceWhen: 'pain_or_high_fatigue_present',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 2.5, lower: 5, default: 2.5 }),
    reasonCodes: Object.freeze(['goal_general_health', 'sustainable_progress_bias']),
  }),

  recovery: Object.freeze({
    id: 'recovery',
    label: 'Recovery / Reduced Stress',
    primaryAdaptation: 'fatigue_management',
    description: 'Keep the habit and movement pattern while reducing fatigue cost.',
    repRange: Object.freeze({ min: 6, max: 15 }),
    preferredRepRange: Object.freeze({ min: 8, max: 12 }),
    loadPercent1RM: Object.freeze({ min: 40, max: 65 }),
    targetRIR: Object.freeze({ min: 4, max: 6 }),
    failurePolicy: 'no_failure',
    volumeMultiplier: 0.5,
    loadMultiplier: 0.6,
    weeklyMuscleSets: Object.freeze({ min: 2, targetMin: 4, targetMax: 8, max: 10 }),
    sessionSetsMainLift: Object.freeze({ min: 1, targetMin: 2, targetMax: 3, max: 4 }),
    restSeconds: Object.freeze({ min: 60, targetMin: 90, targetMax: 180, max: 240 }),
    exerciseOrder: 'lowest_joint_cost_first',
    progressionPriority: Object.freeze(['movement_quality', 'recovery', 'consistency']),
    progressionTriggers: Object.freeze({
      maintainWhen: 'fatigue_high_or_returning_from_time_off',
      reduceLoadWhen: 'joint_pain_or_performance_drop',
      reduceVolumeWhen: 'systemic_fatigue_or_poor_sleep',
      changeExerciseWhen: 'movement_aggravates_symptom_or_motivation_low',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 0, lower: 0, default: 0 }),
    reasonCodes: Object.freeze(['goal_recovery', 'reduce_stress_bias', 'no_PR_chasing']),
  }),

  mixed: Object.freeze({
    id: 'mixed',
    label: 'Mixed Strength + Hypertrophy',
    primaryAdaptation: 'strength_skill_plus_muscle_growth',
    description: 'Use a strength-biased main lift and hypertrophy-biased accessories.',
    repRange: Object.freeze({ min: 3, max: 15 }),
    preferredRepRange: Object.freeze({ min: 5, max: 12 }),
    mainLiftRepRange: Object.freeze({ min: 3, max: 6 }),
    accessoryRepRange: Object.freeze({ min: 8, max: 15 }),
    loadPercent1RM: Object.freeze({ min: 60, max: 90 }),
    targetRIR: Object.freeze({ min: 1, max: 3 }),
    failurePolicy: 'avoid_failure_on_main_lift_selectively_allow_accessory_failure',
    weeklyMuscleSets: Object.freeze({ min: 8, targetMin: 10, targetMax: 18, max: 22 }),
    sessionSetsMainLift: Object.freeze({ min: 2, targetMin: 3, targetMax: 5, max: 6 }),
    restSeconds: Object.freeze({ min: 90, targetMin: 120, targetMax: 210, max: 300 }),
    exerciseOrder: 'main_strength_lift_then_hypertrophy_accessories',
    progressionPriority: Object.freeze(['load_on_main_lift', 'reps_on_accessories', 'sets_if_recovery_good']),
    progressionTriggers: Object.freeze({
      addLoadWhen: 'main_lift_top_range_completed_with_RIR_available',
      addRepsWhen: 'accessory_work_inside_rep_range_with_RIR_available',
      maintainWhen: 'recent_PR_or_fatigue_moderate',
      reduceWhen: 'fatigue_high_or_missed_targets',
    }),
    defaultLoadJumpPercent: Object.freeze({ upper: 2.5, lower: 5, default: 2.5 }),
    reasonCodes: Object.freeze(['goal_mixed', 'main_lift_strength_accessory_hypertrophy']),
  }),
});

const FATIGUE_STATUSES = Object.freeze(['low', 'moderate', 'high', 'unknown']);
const EXERCISE_TYPES = Object.freeze(['compound', 'isolation', 'machine', 'bodyweight', 'power', 'unknown']);
const MOVEMENT_REGIONS = Object.freeze(['upper', 'lower', 'full_body', 'unknown']);

const GLOBAL_RULES = Object.freeze({
  oneLeverAtATime: true,
  stimulusNotExhaustion: true,
  progressionRequiresRecovery: true,
  neverIncreaseLoadWhenTechniqueBreaks: true,
  doNotConfuseSorenessWithEffectiveness: true,
  logIsRequiredForProgression: true,
  avoidRandomProgramHopping: true,
  useSmallestAvailableLoadJump: true,
  preserveFiveSecondLog: true,
  llmMustNotInventPrescriptionNumbers: true,
});

const REASON_CODES = Object.freeze({
  GOAL_STRENGTH: 'goal_strength',
  GOAL_HYPERTROPHY: 'goal_hypertrophy',
  GOAL_POWER: 'goal_power',
  GOAL_CONDITIONING_FAT_LOSS: 'goal_conditioning_fat_loss',
  GOAL_MUSCULAR_ENDURANCE: 'goal_muscular_endurance',
  GOAL_GENERAL_HEALTH: 'goal_general_health',
  GOAL_RECOVERY: 'goal_recovery',
  GOAL_MIXED: 'goal_mixed',
  HEAVY_LOAD_BIAS: 'heavy_load_bias',
  REP_PROGRESS_AFTER_SUCCESS: 'rep_progress_after_success',
  LOAD_PROGRESS_AFTER_TOP_RANGE: 'load_progress_after_top_range',
  VOLUME_PROGRESS_IF_RECOVERABLE: 'volume_progress_if_recoverable',
  DENSITY_PROGRESS_IF_RECOVERABLE: 'density_progress_if_recoverable',
  POWER_SPEED_QUALITY: 'power_speed_quality',
  FATIGUE_HIGH_REDUCE_STRESS: 'fatigue_high_reduce_stress',
  FATIGUE_MODERATE_MAINTAIN_OR_SMALL_STEP: 'fatigue_moderate_maintain_or_small_step',
  MISSED_TARGET_MAINTAIN_OR_REDUCE: 'missed_target_maintain_or_reduce',
  FORM_QUALITY_REQUIRED: 'form_quality_required',
  AVOID_FAILURE_DEFAULT: 'avoid_failure_default',
  NO_PR_CHASING: 'no_PR_chasing',
  RECOVERY_GOAL_REDUCE_LOAD_VOLUME: 'recovery_goal_reduce_load_volume',
  ENDURANCE_DENSITY_PROGRESS: 'endurance_density_progress',
  COLD_START_NO_HISTORY: 'cold_start_no_history',
  LLM_NUMBERS_LOCKED: 'llm_numbers_locked',
  // Set-effort signals — the per-set RIR/fatigue vocabulary emitted by
  // services/setEffortSignals.js (Training Intelligence PR 477). Registered
  // centrally here so the codes have one home; the engine module defines the
  // same string values in its own frozen EFFORT_REASON_CODES map (a test pins
  // the two in sync).
  WARMUP_FEEDER_IGNORED: 'warmup_feeder_ignored',
  REDLINE_SET: 'redline_set',
  REP_DROP_AFTER_REDLINE: 'rep_drop_after_redline',
  PRESSING_READINESS_YELLOW: 'pressing_readiness_yellow',
  SAME_PRIME_MOVER_CONFLICT: 'same_prime_mover_conflict',
  REROUTE_PULL_FIRST: 'reroute_pull_first',
  CAP_NEXT_PRESS: 'cap_next_press',
  HIGH_RIR_WORKSET_UNDERDOSED: 'high_rir_workset_underdosed',
});

function normalizeTrainingGoal(goal) {
  if (!goal || typeof goal !== 'string') return 'general_health';
  const normalized = goal.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    muscle: 'hypertrophy',
    muscle_growth: 'hypertrophy',
    bodybuilding: 'hypertrophy',
    build_muscle: 'hypertrophy',
    get_bigger: 'hypertrophy',
    strength_training: 'strength',
    get_stronger: 'strength',
    powerlifting: 'strength',
    explosive: 'power',
    speed: 'power',
    fat_loss: 'conditioning_fat_loss',
    conditioning: 'conditioning_fat_loss',
    work_capacity: 'conditioning_fat_loss',
    lose_weight: 'conditioning_fat_loss',
    endurance: 'muscular_endurance',
    muscle_endurance: 'muscular_endurance',
    stamina: 'muscular_endurance',
    high_reps: 'muscular_endurance',
    high_rep: 'muscular_endurance',
    rep_endurance: 'muscular_endurance',
    health: 'general_health',
    general: 'general_health',
    maintenance: 'general_health',
    deload: 'recovery',
    tired: 'recovery',
    cooked: 'recovery',
    reduced_stress: 'recovery',
    strength_hypertrophy: 'mixed',
    powerbuilding: 'mixed',
  };
  return TRAINING_GOALS[normalized] ? normalized : (aliases[normalized] || 'general_health');
}

function getTrainingGoal(goal) {
  return TRAINING_GOALS[normalizeTrainingGoal(goal)];
}

function assertValidKnowledgeBase() {
  for (const [id, goal] of Object.entries(TRAINING_GOALS)) {
    if (id !== goal.id) throw new Error(`Training goal key/id mismatch for ${id}`);
    if (!goal.repRange || goal.repRange.min > goal.repRange.max) throw new Error(`Invalid repRange for ${id}`);
    if (!goal.targetRIR || goal.targetRIR.min > goal.targetRIR.max) throw new Error(`Invalid targetRIR for ${id}`);
    if (!Array.isArray(goal.progressionPriority) || goal.progressionPriority.length === 0) {
      throw new Error(`Missing progressionPriority for ${id}`);
    }
  }
  return true;
}

module.exports = {
  TRAINING_GOALS,
  FATIGUE_STATUSES,
  EXERCISE_TYPES,
  MOVEMENT_REGIONS,
  GLOBAL_RULES,
  REASON_CODES,
  normalizeTrainingGoal,
  getTrainingGoal,
  assertValidKnowledgeBase,
};
