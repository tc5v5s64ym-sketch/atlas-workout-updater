'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const coach = require('../services/coach');
const polish = require('../services/coachPolish');

const origIsConfigured = coach.isConfigured;
const origCallGemini = coach.callGemini;
function restore() { coach.isConfigured = origIsConfigured; coach.callGemini = origCallGemini; }

test('numbersPreserved flags any introduced/changed number', () => {
  assert.equal(polish.numbersPreserved('190 lb, 3 sets of 5-6', 'keep 190 for 3 sets, 5-6 reps'), true);
  assert.equal(polish.numbersPreserved('190 lb, 3 sets', 'push to 225 lb'), false);
});

test('numbersPreserved rejects a reordered range (same digits, reversed meaning)', () => {
  // #1711 audit case A: "strength 1-6, hypertrophy 8-15" reworded as
  // "strength 8-15, hypertrophy 1-6" reuses only old digits yet reverses the meaning.
  assert.equal(polish.numbersPreserved(
    'Strength: 1-6 reps. Hypertrophy: 8-15 reps.',
    'For strength use 8-15 reps; for hypertrophy use 1-6.'), false);
  assert.equal(polish.numbersPreserved(
    'Bench: 190 lb for 3 sets of 5-6 reps at RIR 1-2.',
    'Bench: 190 lb for 5-6 sets of 3 reps at RIR 1-2.'), false);
});

test('numbersPreserved rejects spelled-out numbers not in the original', () => {
  // #1711 audit case B: "ninety" carries no digit token, so a set-membership
  // check over digits is vacuously true.
  assert.equal(polish.numbersPreserved(
    'Deadlift: 195 lb for 2 sets of 3-5 reps at RIR 1-2.',
    'Do ninety sets of deadlift next.'), false);
  assert.equal(polish.numbersPreserved('Bench 190 lb.', 'Do twenty-five reps at 190 lb.'), false);
});

test('numbersPreserved accepts spelled-out numbers that match in value and order', () => {
  assert.equal(polish.numbersPreserved(
    'Bench 195 lb for 2 sets.',
    'Bench one hundred ninety-five lb for two sets.'), true);
  assert.equal(polish.numbersPreserved(
    'Do 25 reps.', 'Do twenty-five reps.'), true);
});

test('numbersPreserved rejects a dropped number', () => {
  assert.equal(polish.numbersPreserved(
    'Bench: 190 lb for 3 sets of 5-6 reps at RIR 1-2.',
    'Bench at 190 lb for 3 sets of 5-6 reps.'), false);
});

test('extractNumberSequence parses digits, hyphenated and compound word numbers in order', () => {
  assert.deepEqual(
    polish.extractNumberSequence('Do twenty-five reps at 190 lb, then one hundred twenty seconds rest.'),
    ['25', '190', '120']);
  assert.deepEqual(
    polish.extractNumberSequence('Strength ~1–6, hypertrophy 8–15.'),
    ['1', '6', '8', '15']);
  assert.deepEqual(
    polish.extractNumberSequence('five and six reps'), ['5', '6']);
  assert.deepEqual(
    polish.extractNumberSequence('twenty twenty'), ['20', '20']);
  assert.deepEqual(
    polish.extractNumberSequence('one two three'), ['1', '2', '3']);
  assert.deepEqual(
    polish.extractNumberSequence('one hundred and twenty'), ['120']);
});

test('polishSmeAnswer rejects the reversed SME rep ranges', async () => {
  const { buildTrainingSMEAnswer } = require('../services/trainingSME');
  const sme = buildTrainingSMEAnswer({
    question: 'strength vs hypertrophy reps',
    depth: 'compare_options',
    cards: ['strength_training', 'hypertrophy_training'],
  });
  coach.isConfigured = () => true;
  coach.callGemini = async () => 'For strength use 8-15 reps; for hypertrophy use 1-6.';
  try {
    assert.equal(await polish.polishSmeAnswer(sme.answer), sme.answer);
  } finally { restore(); }
});

test('polishSmeAnswer rejects a spelled-out set count', async () => {
  coach.isConfigured = () => true;
  coach.callGemini = async () => 'Do ninety sets of deadlift next.';
  const original = 'Deadlift: 195 lb for 2 sets of 3-5 reps at RIR 1-2.';
  try {
    assert.equal(await polish.polishSmeAnswer(original), original);
  } finally { restore(); }
});

test('polishCoachExplanation rejects a word-form sets/reps swap', async () => {
  coach.isConfigured = () => true;
  // Reuses only numbers already present (5, 2, 195) but swaps sets and reps.
  coach.callGemini = async () => 'Do 5 sets, 2 reps at 195 lb.';
  const original = 'Deadlift: 195 lb for 2 sets of 3–5 reps at RIR 1–2 — hold the load and add reps.';
  const locked = { recommendedWeight: 195, targetSets: 2, targetRepRange: { min: 3, max: 5 }, targetRIR: { min: 1, max: 2 } };
  try {
    assert.equal(await polish.polishCoachExplanation(original, locked), original);
  } finally { restore(); }
});

test('degrades to the original when Gemini is unconfigured', async () => {
  coach.isConfigured = () => false;
  const original = 'Bench 190 lb for 3 sets of 5-6 reps at RIR 1-2.';
  assert.equal(await polish.polishSmeAnswer(original), original);
  restore();
});

test('uses the polished text when every number is preserved', async () => {
  coach.isConfigured = () => true;
  coach.callGemini = async () => 'Keep bench at 190 lb — 3 crisp sets of 5-6 reps, leaving 1-2 in the tank.';
  const original = 'Bench: 190 lb for 3 sets of 5-6 reps at RIR 1-2.';
  const out = await polish.polishSmeAnswer(original);
  assert.notEqual(out, original);
  assert.match(out, /190/);
  restore();
});

test('rejects a polish that introduces a new number', async () => {
  coach.isConfigured = () => true;
  coach.callGemini = async () => 'Bench at 225 lb for 3 sets of 5-6 reps.';
  const original = 'Bench: 190 lb for 3 sets of 5-6 reps at RIR 1-2.';
  assert.equal(await polish.polishSmeAnswer(original), original);
  restore();
});

test('degrades to the original when Gemini throws', async () => {
  coach.isConfigured = () => true;
  coach.callGemini = async () => { throw new Error('gemini down'); };
  const original = 'Bench 190 lb for 3 sets.';
  assert.equal(await polish.polishSmeAnswer(original), original);
  restore();
});

test('degrades to the original when Gemini returns empty', async () => {
  coach.isConfigured = () => true;
  coach.callGemini = async () => '   ';
  const original = 'Bench 190 lb.';
  assert.equal(await polish.polishSmeAnswer(original), original);
  restore();
});

test('polishCoachExplanation rejects prescription drift even when numbers are reused', async () => {
  coach.isConfigured = () => true;
  // Reuses only numbers already present (3 and 6) but flips the prescription to 6x3.
  coach.callGemini = async () => 'Do 6×3 on bench at 190 lb.';
  const original = 'Bench 190 lb, 3×6 at RIR 2.';
  const locked = { recommendedWeight: 190, targetSets: 3, targetRepRange: { min: 3, max: 6 }, targetRIR: { min: 1, max: 3 } };
  assert.equal(await polish.polishCoachExplanation(original, locked), original);
  restore();
});

test('polishCoachExplanation returns the polished text when the prescription is intact', async () => {
  coach.isConfigured = () => true;
  coach.callGemini = async () => 'Bench stays at 190 lb — 3×6, leaving 2 in reserve.';
  const original = 'Bench 190 lb, 3×6 at RIR 2.';
  const locked = { recommendedWeight: 190, targetSets: 3, targetRepRange: { min: 3, max: 6 }, targetRIR: { min: 1, max: 3 } };
  const out = await polish.polishCoachExplanation(original, locked);
  assert.notEqual(out, original);
  assert.match(out, /190/);
  restore();
});
