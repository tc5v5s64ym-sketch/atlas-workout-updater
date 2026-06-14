'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRAINING_GOALS,
  GLOBAL_RULES,
  normalizeTrainingGoal,
  getTrainingGoal,
  assertValidKnowledgeBase,
} = require('../services/trainingKnowledge');

const {
  classifyTrainingGoalFromText,
  resolveTrainingGoal,
} = require('../services/trainingGoalClassifier');

test('knowledge base validates all goal presets', () => {
  assert.equal(assertValidKnowledgeBase(), true);
  assert.ok(Object.keys(TRAINING_GOALS).includes('strength'));
  assert.ok(Object.keys(TRAINING_GOALS).includes('hypertrophy'));
  assert.ok(Object.keys(TRAINING_GOALS).includes('recovery'));
});

test('strength, hypertrophy, power, and recovery have different prescription constraints', () => {
  assert.deepEqual(getTrainingGoal('strength').preferredRepRange, { min: 3, max: 5 });
  assert.deepEqual(getTrainingGoal('hypertrophy').preferredRepRange, { min: 8, max: 15 });
  assert.equal(getTrainingGoal('power').targetRIR.min >= 3, true);
  assert.equal(getTrainingGoal('recovery').loadMultiplier < 1, true);
});

test('aliases normalize to canonical goals', () => {
  assert.equal(normalizeTrainingGoal('build muscle'), 'hypertrophy');
  assert.equal(normalizeTrainingGoal('get stronger'), 'strength');
  assert.equal(normalizeTrainingGoal('fat loss'), 'conditioning_fat_loss');
  assert.equal(normalizeTrainingGoal('powerbuilding'), 'mixed');
});

test('classifier maps natural language intent to goals', () => {
  assert.equal(classifyTrainingGoalFromText('I want to get stronger on bench').goal, 'strength');
  assert.equal(classifyTrainingGoalFromText('I want to build muscle and get a pump').goal, 'hypertrophy');
  assert.equal(classifyTrainingGoalFromText('I am cooked and need an easy day').goal, 'recovery');
  assert.equal(classifyTrainingGoalFromText('Need explosive power for lacrosse').goal, 'power');
});

test('powerbuilding classifies as mixed, not power (longer phrase wins over substring)', () => {
  assert.equal(classifyTrainingGoalFromText('I want to do some powerbuilding today').goal, 'mixed');
  assert.equal(resolveTrainingGoal({ sessionText: 'powerbuilding' }).goal, 'mixed');
  // The bare "power" intent must still resolve to power.
  assert.equal(classifyTrainingGoalFromText('Need explosive power for lacrosse').goal, 'power');
});

test('explicit goal beats text and user profile', () => {
  const resolved = resolveTrainingGoal({
    explicitGoal: 'hypertrophy',
    userProfileGoal: 'strength',
    sessionText: 'I am cooked',
  });
  assert.equal(resolved.goal, 'hypertrophy');
  assert.equal(resolved.source, 'explicitGoal');
});

test('global rules prevent LLM-vibe programming', () => {
  assert.equal(GLOBAL_RULES.llmMustNotInventPrescriptionNumbers, true);
  assert.equal(GLOBAL_RULES.preserveFiveSecondLog, true);
  assert.equal(GLOBAL_RULES.oneLeverAtATime, true);
});
