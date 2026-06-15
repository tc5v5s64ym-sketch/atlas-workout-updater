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
