'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findTrainingKnowledgeCards, buildTrainingSMEAnswer } = require('../services/trainingSME');
const { getCardById } = require('../services/trainingKnowledgeCards');

test('log_only returns no SME explanation', () => {
  const res = buildTrainingSMEAnswer({ question: 'bench 190 6/2' });
  assert.equal(res.depth, 'log_only');
  assert.equal(res.answer, null);
  assert.deepEqual(res.cards, []);
});

test('direct topics retrieve the right knowledge cards', () => {
  assert.equal(findTrainingKnowledgeCards('deloads')[0].id, 'deloads');
  assert.equal(findTrainingKnowledgeCards('training to failure')[0].id, 'training_to_failure');
  assert.equal(findTrainingKnowledgeCards('how should I structure my program split')[0].id, 'program_splits');
});

test('strength vs hypertrophy comparison includes the major differences', () => {
  const res = buildTrainingSMEAnswer({ question: 'explain strength vs hypertrophy' });
  assert.equal(res.depth, 'compare_options');
  assert.ok(res.cards.includes('strength_training'));
  assert.ok(res.cards.includes('hypertrophy_training'));
  assert.match(res.answer, /rep/i);
  assert.match(res.answer, /(load|heavier)/i);
  assert.match(res.answer, /(failure|volume)/i);
});

test('training-to-failure answer: not required for strength/hypertrophy; proximity matters more for hypertrophy', () => {
  const card = getCardById('training_to_failure');
  assert.match(card.detailedAnswer, /not required/i);
  assert.match(card.detailedAnswer, /hypertrophy/i);
  assert.match(card.detailedAnswer, /strength/i);
  assert.match(card.detailedAnswer, /(more for hypertrophy|matters more)/i);

  const res = buildTrainingSMEAnswer({ question: 'explain training to failure' });
  assert.match(res.answer, /not required/i);
});

test('power answer warns against grindy failure reps', () => {
  const res = buildTrainingSMEAnswer({ question: 'go deep on power training' });
  assert.equal(res.depth, 'deep_dive');
  assert.match(res.answer, /grind|grindy/i);
  assert.match(res.answer, /failure/i);
});

test('deload answer includes reducing load, volume, or exercise stress', () => {
  const res = buildTrainingSMEAnswer({ question: 'explain deloads' });
  assert.match(res.answer, /load/i);
  assert.match(res.answer, /volume/i);
  assert.match(res.answer, /(exercise|stress)/i);
});

test('pain vs soreness avoids a diagnosis and recommends caution/escalation for sharp or worsening pain', () => {
  const card = getCardById('pain_vs_soreness');
  assert.match(card.detailedAnswer, /not a (medical )?diagnosis/i);
  assert.match(card.detailedAnswer, /(sharp|worsening)/i);
  assert.match(card.detailedAnswer, /(consult|professional|seek)/i);

  const res = buildTrainingSMEAnswer({ question: 'explain why sharp pain is different from soreness' });
  assert.match(res.answer, /(consult|professional|caution|back off)/i);
});

test('coach_brief is short; teach_me is more detailed', () => {
  const brief = buildTrainingSMEAnswer({ question: 'what about rest periods?' });
  assert.equal(brief.depth, 'coach_brief');
  assert.ok(brief.answer && brief.answer.length > 0);

  const teach = buildTrainingSMEAnswer({ question: 'teach me about rest periods' });
  assert.equal(teach.depth, 'teach_me');
  assert.ok(teach.answer.length > brief.answer.length);
});
