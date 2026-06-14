'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { recommendExercisePrescription } = require('../services/recommendationPolicy');

test('same exercise/history produces different strength vs hypertrophy recommendations', () => {
  const shared = {
    exerciseName: 'Bench Press',
    previousPerformance: { weight: 185, reps: 10, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
  };

  const strength = recommendExercisePrescription({ ...shared, goal: 'strength' });
  const hypertrophy = recommendExercisePrescription({ ...shared, goal: 'hypertrophy' });

  assert.equal(strength.targetRepRange.max <= 5, true);
  assert.equal(hypertrophy.targetRepRange.min >= 8, true);
  assert.notDeepEqual(strength.targetRepRange, hypertrophy.targetRepRange);
  assert.ok(strength.reasonCodes.includes('goal_strength'));
  assert.ok(hypertrophy.reasonCodes.includes('goal_hypertrophy'));
});

test('hypertrophy goal prefers adding reps before load when still inside rep range', () => {
  const result = recommendExercisePrescription({
    goal: 'hypertrophy',
    exerciseName: 'DB Bench Press',
    previousPerformance: { weight: 70, reps: 10, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
  });

  assert.equal(result.progression, 'add_rep');
  assert.equal(result.recommendedWeight, 70);
  assert.ok(result.reasonCodes.includes('rep_progress_after_success'));
});

test('hypertrophy goal adds load only after top of rep range is reached cleanly', () => {
  const result = recommendExercisePrescription({
    goal: 'hypertrophy',
    exerciseName: 'DB Bench Press',
    previousPerformance: { weight: 70, reps: 15, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
  });

  assert.equal(result.progression, 'add_load');
  assert.equal(result.recommendedWeight, 75);
});

test('strength goal prioritizes load progression when reps and RIR support it', () => {
  const result = recommendExercisePrescription({
    goal: 'strength',
    exerciseName: 'Bench Press',
    previousPerformance: { weight: 190, reps: 5, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
  });

  assert.equal(result.progression, 'add_load');
  assert.equal(result.recommendedWeight, 195);
  assert.ok(result.reasonCodes.includes('heavy_load_bias'));
});

test('mixed goal honors explicit exerciseType for accessory rep progression', () => {
  // "Pec Deck" is not recognized by the name-based type regex, so the mixed branch must
  // use the explicit exerciseType to keep accessory rep progression instead of stalling.
  const result = recommendExercisePrescription({
    goal: 'mixed',
    exerciseName: 'Pec Deck',
    exerciseType: 'isolation',
    previousPerformance: { weight: 100, reps: 10, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
    availableIncrement: 5,
  });

  assert.equal(result.progression, 'add_rep');
  assert.equal(result.recommendedWeight, 100);
  assert.ok(result.reasonCodes.includes('rep_progress_after_success'));
});

test('recovery goal reduces stress and never chases PRs', () => {
  const result = recommendExercisePrescription({
    goal: 'recovery',
    exerciseName: 'Bench Press',
    previousPerformance: { weight: 225, reps: 5, sets: 3, rir: 1, completed: true },
    recentTrends: { fatigueStatus: 'high' },
    availableIncrement: 5,
  });

  assert.equal(result.progression, 'reduce_stress');
  assert.equal(result.recommendedWeight < 225, true);
  assert.equal(result.targetRIR.min >= 4, true);
  assert.ok(result.reasonCodes.includes('no_PR_chasing'));
});

test('power goal protects speed and does not prescribe failure work', () => {
  const result = recommendExercisePrescription({
    goal: 'power',
    exerciseName: 'Box Jump',
    exerciseType: 'power',
    previousPerformance: { weight: 0, reps: 3, sets: 5, rir: 5, completed: true },
    recentTrends: { fatigueStatus: 'low' },
  });

  assert.equal(result.targetRIR.min >= 3, true);
  assert.equal(result.failurePolicy, 'never_chase_failure_for_power');
  assert.ok(result.reasonCodes.includes('power_speed_quality'));
});

test('high fatigue overrides aggressive progression even when last workout was completed', () => {
  const result = recommendExercisePrescription({
    goal: 'strength',
    exerciseName: 'Bench Press',
    previousPerformance: { weight: 225, reps: 5, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'high' },
    availableIncrement: 5,
  });

  assert.equal(result.progression, 'reduce_stress');
  assert.notEqual(result.recommendedWeight, 230);
  assert.ok(result.reasonCodes.includes('fatigue_high_reduce_stress'));
});

test('LLM brief locks prescription numbers and prevents invention', () => {
  const result = recommendExercisePrescription({
    goal: 'strength',
    exerciseName: 'Bench Press',
    previousPerformance: { weight: 190, reps: 5, sets: 3, rir: 2, completed: true },
    recentTrends: { fatigueStatus: 'low' },
  });

  assert.equal(result.llmBrief.lockedNumbers.recommendedWeight, result.recommendedWeight);
  assert.equal(result.llmBrief.lockedNumbers.targetSets, result.targetSets);
  assert.match(result.llmBrief.instruction, /Do not change/);
});
