'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTrainingGoal, normalizeTrainingGoal, TRAINING_GOALS } = require('../services/trainingKnowledge');
const { classifyTrainingGoalFromText } = require('../services/trainingGoalClassifier');
const { recommendExercisePrescription } = require('../services/recommendationPolicy');
const trainingKnowledgeData = require('../data/trainingKnowledge.v1.json');

// ---- muscular_endurance is a distinct, first-class goal ----------------------------------------

test('muscular_endurance uses higher reps and shorter rest than hypertrophy', () => {
  const endurance = getTrainingGoal('muscular_endurance');
  const hypertrophy = getTrainingGoal('hypertrophy');

  assert.equal(endurance.id, 'muscular_endurance');
  assert.ok(endurance.preferredRepRange.min > hypertrophy.preferredRepRange.min);
  assert.ok(endurance.restSeconds.targetMax < hypertrophy.restSeconds.targetMax);
  assert.ok(endurance.progressionPriority[0] === 'density');
});

test('muscular_endurance progresses density before load', () => {
  const result = recommendExercisePrescription({
    goal: 'muscular_endurance',
    exerciseName: 'Goblet Squat',
    previousPerformance: { weight: 60, reps: 20, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
  });

  assert.equal(result.progression, 'increase_density_or_reps');
  assert.equal(result.targetRepRange.min >= 15, true);
  assert.ok(result.reasonCodes.includes('goal_muscular_endurance'));
  assert.ok(result.reasonCodes.includes('endurance_density_progress'));
});

test('strength, hypertrophy, endurance, and power remain distinct', () => {
  const strength = getTrainingGoal('strength');
  const hypertrophy = getTrainingGoal('hypertrophy');
  const endurance = getTrainingGoal('muscular_endurance');
  const power = getTrainingGoal('power');

  // Rep emphasis climbs power < strength < hypertrophy < endurance.
  assert.ok(endurance.preferredRepRange.min > hypertrophy.preferredRepRange.min);
  assert.ok(hypertrophy.preferredRepRange.min > strength.preferredRepRange.min);
  assert.ok(power.preferredRepRange.max <= strength.preferredRepRange.max);
  // Power stays fresh (high RIR); endurance is distinct from conditioning.
  assert.ok(power.targetRIR.min >= 3);
  assert.notEqual(endurance.id, getTrainingGoal('conditioning_fat_loss').id);
});

// ---- cold start never invents exact weights ----------------------------------------------------

test('cold start returns weightGuidance and does not invent an exact weight', () => {
  const result = recommendExercisePrescription({
    goal: 'hypertrophy',
    exerciseName: 'Bench Press',
    previousPerformance: {},      // no history
    recentTrends: { fatigueStatus: 'low' },
    // no estimated1RM
  });

  assert.equal(result.recommendedWeight, undefined);
  assert.equal(typeof result.weightGuidance, 'string');
  assert.match(result.weightGuidance, /RIR/);
  assert.ok(result.reasonCodes.includes('cold_start_no_history'));
  assert.equal(result.llmBrief.lockedNumbers.recommendedWeight, undefined);
  assert.equal(typeof result.llmBrief.lockedNumbers.weightGuidance, 'string');
});

// ---- optional constraints modify output without a profile system -------------------------------

test('sessionMinutes constraint trims a set without any profile system', () => {
  const base = recommendExercisePrescription({
    goal: 'hypertrophy',
    exerciseName: 'DB Bench Press',
    previousPerformance: { weight: 70, reps: 10, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
  });

  const constrained = recommendExercisePrescription({
    goal: 'hypertrophy',
    exerciseName: 'DB Bench Press',
    previousPerformance: { weight: 70, reps: 10, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
    constraints: { sessionMinutes: 20 },
  });

  assert.equal(constrained.targetSets, base.targetSets - 1);
  assert.ok(constrained.reasonCodes.includes('constraint_time_capped_volume'));
  assert.ok(constrained.constraintsApplied.includes('constraint_time_capped_volume'));
});

test('pain/injury constraint blocks a load increase', () => {
  const constrained = recommendExercisePrescription({
    goal: 'strength',
    exerciseName: 'Bench Press',
    previousPerformance: { weight: 190, reps: 5, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
    constraints: { painFlags: ['left shoulder'] },
  });

  assert.equal(constrained.progression, 'maintain');
  assert.equal(constrained.recommendedWeight, 190);          // held, not bumped to 195
  assert.ok(constrained.reasonCodes.includes('constraint_pain_no_load_increase'));
  assert.ok(constrained.safetyFlags.includes('respect_pain_or_injury'));
});

test('pain/injury constraint also neutralizes the power small-load option', () => {
  // Power "completed with room" yields maintain_or_small_load_if_speed_crisp — still a load bump.
  // Under pain/injury it must collapse to a plain maintain.
  const constrained = recommendExercisePrescription({
    goal: 'power',
    exerciseName: 'Trap Bar Jump',
    exerciseType: 'power',
    previousPerformance: { weight: 135, reps: 3, sets: 5, rir: 5, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    constraints: { injuryConstraints: ['low back'] },
  });

  assert.equal(constrained.progression, 'maintain');
  assert.equal(constrained.recommendedWeight, 135);          // held, no small-load bump
  assert.ok(constrained.reasonCodes.includes('constraint_pain_no_load_increase'));
  assert.ok(constrained.safetyFlags.includes('respect_pain_or_injury'));
});

// ---- versioned JSON must not drift from the code-level goals -----------------------------------

test('data/trainingKnowledge.v1.json stays in sync with code-level training goals', () => {
  const codeGoals = Object.keys(TRAINING_GOALS).sort();
  assert.ok(trainingKnowledgeData.canonical_goals.includes('muscular_endurance'));
  assert.deepEqual([...trainingKnowledgeData.canonical_goals].sort(), codeGoals);
  assert.deepEqual(Object.keys(trainingKnowledgeData.goals).sort(), codeGoals);

  const me = trainingKnowledgeData.goals.muscular_endurance;
  assert.deepEqual(me.rep_range, [12, 30]);
  assert.deepEqual(me.preferred_rep_range, [15, 25]);
  assert.deepEqual(me.target_rir, [1, 3]);
  assert.deepEqual(me.rest_seconds_target, [30, 60]);
  assert.deepEqual(me.progression_priority, ['density', 'reps', 'sets', 'load']);
  assert.equal(me.failure_policy, 'near_failure_ok_on_safe_work');
  assert.ok(me.reason_codes.includes('goal_muscular_endurance'));
});

// ---- recovery still avoids PR chasing ----------------------------------------------------------

test('recovery still reduces stress and avoids PR chasing', () => {
  const result = recommendExercisePrescription({
    goal: 'recovery',
    exerciseName: 'Bench Press',
    previousPerformance: { weight: 225, reps: 5, sets: 3, rir: 1, completed: true },
    recentTrends: { fatigueStatus: 'high' },
    availableIncrement: 5,
  });

  assert.equal(result.progression, 'reduce_stress');
  assert.equal(result.recommendedWeight < 225, true);
  assert.ok(result.reasonCodes.includes('no_PR_chasing'));
});

// ---- classifier: resistance endurance vs cardio endurance --------------------------------------

test('resistance endurance phrases classify as muscular_endurance', () => {
  assert.equal(classifyTrainingGoalFromText('I want to build muscular endurance').goal, 'muscular_endurance');
  assert.equal(classifyTrainingGoalFromText('I want more endurance in my squats and presses').goal, 'muscular_endurance');
  assert.equal(normalizeTrainingGoal('endurance'), 'muscular_endurance');
});

test('cardio/running endurance is NOT treated as muscular endurance', () => {
  assert.notEqual(classifyTrainingGoalFromText('I want to improve my running endurance').goal, 'muscular_endurance');
  assert.notEqual(classifyTrainingGoalFromText('more stamina for my 10k and cardio').goal, 'muscular_endurance');
});
