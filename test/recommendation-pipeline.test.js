'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRecommendation } = require('../services/recommendationPipeline');
const { validateCoachExplanation } = require('../services/coachExplanationPolicy');

function row(date, session, name, muscle, code, weight, reps, rir) {
  return [date, session, name, name, muscle, code, '1', String(weight), String(reps), String(rir), ''];
}

// Same history, used for both goals.
const benchRows = [
  row('2026-05-20', 'S1', 'Bench Press', 'Chest', 'BEN01', 185, 10, 2),
  row('2026-05-27', 'S2', 'Bench Press', 'Chest', 'BEN01', 185, 10, 2),
];

test('same history produces different strength vs hypertrophy recommendations', () => {
  const strength = buildRecommendation({ explicitGoal: 'strength', liftCode: 'BEN01', exerciseName: 'Bench Press', logRows: benchRows });
  const hypertrophy = buildRecommendation({ explicitGoal: 'hypertrophy', liftCode: 'BEN01', exerciseName: 'Bench Press', logRows: benchRows });

  assert.ok(strength.recommendation.targetRepRange.max <= 6);
  assert.ok(hypertrophy.recommendation.targetRepRange.min >= 8);
  assert.notDeepEqual(strength.recommendation.targetRepRange, hypertrophy.recommendation.targetRepRange);
  assert.ok(strength.reasonCodes.includes('goal_strength'));
  assert.ok(hypertrophy.reasonCodes.includes('goal_hypertrophy'));
  // Normal history (no NEW PR) must actually progress, not hold — strength adds load, hypertrophy adds reps.
  assert.equal(strength.recommendation.progression, 'add_load');
  assert.equal(hypertrophy.recommendation.progression, 'add_rep');
});

test('a lift with prior history but no new PR still progresses (does not falsely hold)', () => {
  // Most recent session ties earlier work — NOT a new PR, so progression must proceed.
  const rec = buildRecommendation({ explicitGoal: 'strength', liftCode: 'BEN01', exerciseName: 'Bench Press', logRows: benchRows });
  assert.notEqual(rec.recommendation.progression, 'maintain');
});

test('a genuinely new PR last session holds (recentPR gates on the latest session)', () => {
  const justPrd = buildRecommendation({
    explicitGoal: 'strength',
    liftCode: 'BEN01',
    exerciseName: 'Bench Press',
    logRows: [
      row('2026-05-20', 'S1', 'Bench Press', 'Chest', 'BEN01', 185, 5, 2),
      row('2026-05-27', 'S2', 'Bench Press', 'Chest', 'BEN01', 200, 5, 2), // new all-time best, most recent
    ],
  });
  assert.equal(justPrd.recommendation.progression, 'maintain');
  assert.ok(justPrd.reasonCodes.includes('fatigue_moderate_maintain_or_small_step'));
});

test('every recommendation includes reasonCodes, locked numbers, and a validated explanation', () => {
  const rec = buildRecommendation({ explicitGoal: 'strength', liftCode: 'BEN01', exerciseName: 'Bench Press', logRows: benchRows });
  assert.ok(Array.isArray(rec.reasonCodes) && rec.reasonCodes.length > 0);
  assert.ok(rec.llmBrief && rec.llmBrief.lockedNumbers);
  assert.equal(typeof rec.coachExplanation, 'string');
  assert.equal(validateCoachExplanation(rec.coachExplanation, rec.llmBrief.lockedNumbers).valid, true);
  assert.equal(rec.explanationValid, true);
});

test('recovery reduces stress and never chases PRs', () => {
  const rec = buildRecommendation({
    explicitGoal: 'recovery',
    liftCode: 'BEN01',
    exerciseName: 'Bench Press',
    logRows: [row('2026-05-27', 'S1', 'Bench Press', 'Chest', 'BEN01', 225, 5, 1)],
  });
  assert.equal(rec.recommendation.progression, 'reduce_stress');
  assert.ok(rec.recommendation.recommendedWeight < 225);
  assert.ok(rec.reasonCodes.includes('no_PR_chasing'));
});

test('cold start returns weightGuidance and invents no weight', () => {
  const rec = buildRecommendation({ explicitGoal: 'hypertrophy', liftCode: 'ZZ99', exerciseName: 'Mystery Move', logRows: benchRows });
  assert.equal(rec.recommendation.recommendedWeight, undefined);
  assert.equal(typeof rec.weightGuidance, 'string');
  assert.ok(rec.reasonCodes.includes('cold_start_no_history'));
});

test('constraints reach the recommendation (painFlags block a load increase)', () => {
  const rec = buildRecommendation({
    explicitGoal: 'strength',
    liftCode: 'BEN01',
    exerciseName: 'Bench Press',
    logRows: benchRows,
    constraints: { painFlags: ['left shoulder'] },
  });
  assert.notEqual(rec.recommendation.progression, 'add_load');
  assert.ok(rec.reasonCodes.includes('constraint_pain_no_load_increase'));
  assert.ok(rec.safetyFlags.includes('respect_pain_or_injury'));
});

test('the public payload does not leak raw sheet rows / analytics internals', () => {
  const rec = buildRecommendation({ explicitGoal: 'strength', liftCode: 'BEN01', exerciseName: 'Bench Press', logRows: benchRows });
  assert.equal('raw' in rec, false);
});
