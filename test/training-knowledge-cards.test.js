'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CARDS, getCardById, allCardIds } = require('../services/trainingKnowledgeCards');
const { TRAINING_GOALS } = require('../services/trainingKnowledge');

const EXPECTED_IDS = [
  'progressive_overload',
  'strength_training',
  'hypertrophy_training',
  'muscular_endurance',
  'power_training',
  'powerbuilding',
  'training_to_failure',
  'rir_rpe',
  'deloads',
  'warmups_ramp_sets',
  'rest_periods',
  'rep_ranges',
  'training_volume',
  'training_frequency',
  'compound_vs_isolation',
  'machines_vs_free_weights',
  'exercise_substitution',
  'plateaus',
  'pain_vs_soreness',
  'program_splits',
];

const REQUIRED_FIELDS = [
  'id',
  'title',
  'shortAnswer',
  'detailedAnswer',
  'appliesToGoals',
  'whenToUse',
  'whenToAvoid',
  'commonMistakes',
  'atlasDecisionImpact',
  'confidenceLevel',
  'relatedTopics',
];

const ALLOWED_CONFIDENCE = new Set(['high', 'moderate', 'emerging', 'context_dependent']);

test('all 20 expected card ids exist', () => {
  assert.equal(CARDS.length, EXPECTED_IDS.length);
  for (const id of EXPECTED_IDS) {
    assert.ok(getCardById(id), `missing card: ${id}`);
  }
  assert.deepEqual([...allCardIds()].sort(), [...EXPECTED_IDS].sort());
});

test('card ids are unique', () => {
  const ids = allCardIds();
  assert.equal(new Set(ids).size, ids.length);
});

test('every card has all required fields with sane types', () => {
  for (const card of CARDS) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(card, field), `${card.id} missing ${field}`);
    }
    assert.equal(typeof card.id, 'string');
    assert.equal(typeof card.title, 'string');
    assert.equal(typeof card.shortAnswer, 'string');
    assert.equal(typeof card.detailedAnswer, 'string');
    assert.equal(typeof card.atlasDecisionImpact, 'string');
    assert.ok(Array.isArray(card.appliesToGoals) && card.appliesToGoals.length > 0, `${card.id} appliesToGoals`);
    assert.ok(Array.isArray(card.whenToUse) && card.whenToUse.length > 0, `${card.id} whenToUse`);
    assert.ok(Array.isArray(card.whenToAvoid) && card.whenToAvoid.length > 0, `${card.id} whenToAvoid`);
    assert.ok(Array.isArray(card.commonMistakes) && card.commonMistakes.length > 0, `${card.id} commonMistakes`);
    assert.ok(Array.isArray(card.relatedTopics), `${card.id} relatedTopics`);
    // Keep cards compact, not essays.
    assert.ok(card.detailedAnswer.length <= 700, `${card.id} detailedAnswer too long`);
  }
});

test('appliesToGoals only uses canonical goal ids from trainingKnowledge.js', () => {
  const canonical = new Set(Object.keys(TRAINING_GOALS));
  for (const card of CARDS) {
    for (const goal of card.appliesToGoals) {
      assert.ok(canonical.has(goal), `${card.id} references unknown goal: ${goal}`);
    }
  }
});

test('confidenceLevel uses the allowed set', () => {
  for (const card of CARDS) {
    assert.ok(ALLOWED_CONFIDENCE.has(card.confidenceLevel), `${card.id} bad confidenceLevel: ${card.confidenceLevel}`);
  }
});

test('relatedTopics reference real card ids', () => {
  const ids = new Set(allCardIds());
  for (const card of CARDS) {
    for (const rel of card.relatedTopics) {
      assert.ok(ids.has(rel), `${card.id} relatedTopics points at unknown card: ${rel}`);
    }
  }
});

test('rir_rpe brief answer leads with RIR and does not conflate RPE (#449 follow-up)', () => {
  const { getCardById } = require('../services/trainingKnowledgeCards');
  const card = getCardById('rir_rpe');
  // Bare "RIR?" with no active context returns this shortAnswer via the SME.
  assert.match(card.shortAnswer, /reps in reserve/i, 'must define RIR as reps in reserve');
  assert.match(card.shortAnswer, /RIR 0/, 'must anchor RIR 0 = no reps left');
  assert.doesNotMatch(card.shortAnswer, /\bRPE\b/, 'the brief RIR answer must not mix in RPE');
  assert.doesNotMatch(card.shortAnswer, /1\s*[-–]\s*10/, 'must not describe RIR as a 1-10 scale');
});
