'use strict';

// P0 wiring Sub-PR 2a — deterministic plan-mutation intent classifier.
// The live-gym repro: "skip deadlifts/rdls and do squats" must be recognized as a
// REPLACE so the canonical session mutates (no LLM prose in the loop).

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyMutationIntent, splitTargets, resolvePlanTargets } = require('../public/planMutationIntent');

test('repro: "skip deadlifts/rdls and do squats" → replace deadlift with squats', () => {
  const r = classifyMutationIntent('skip deadlifts/rdls and do squats');
  assert.equal(r.action, 'replace');
  assert.equal(r.target, 'deadlifts/rdls');
  assert.equal(r.substitute, 'squats');
});

test('replace phrasings all classify', () => {
  const cases = [
    ['do squats instead of deadlift', 'deadlift', 'squats'],
    ['squats instead of deadlift', 'deadlift', 'squats'],
    ['swap deadlift for back squat', 'deadlift', 'back squat'],
    ['replace overhead press with db press', 'overhead press', 'db press'],
    ['switch lat pulldown to pull ups', 'lat pulldown', 'pull ups'],
    ["i'll do squats instead of deadlift", 'deadlift', 'squats'],   // lead-in stripped
    ['rack is taken, do squats', 'rack', 'squats'],                  // "X taken, do Y"
    ['skip deadlift and do squats', 'deadlift', 'squats'],
  ];
  for (const [text, target, substitute] of cases) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'replace', `replace: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
    assert.equal(r.substitute, substitute, `substitute: ${text}`);
  }
});

test('skip-only phrasings classify as skip', () => {
  for (const [text, target] of [
    ['skip leg extensions', 'leg extensions'],
    ['drop the single-leg leg curl', 'single-leg leg curl'],
    ['cut deadlift today', 'deadlift'],
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'skip', `skip: ${text}`);
    assert.equal(r.target, target, `skip target: ${text}`);
  }
});

test('non-mutation messages return null (fall through to coach/substitute flow)', () => {
  for (const text of [
    'how many reps?', 'what should I do next?', 'should I skip deadlift?',
    'bench 225 5/2', 'that felt heavy', 'i am tired', '', '   ',
    'squats', 'deadlift',                       // a bare lift name is not a mutation
    'do 3 sets',                                // not an exercise swap
  ]) {
    assert.equal(classifyMutationIntent(text), null, `should be null: "${text}"`);
  }
});

test('a slash-set log is never read as a mutation', () => {
  assert.equal(classifyMutationIntent('skip 225 5/2'), null);
  assert.equal(classifyMutationIntent('back squat 225 5/2 5/2'), null);
});

test('a QUESTION is never a mutation (questions → null), even with swap/skip words', () => {
  for (const q of [
    'should i do squats instead of deadlift?',          // trailing ?
    'should i do squats instead of deadlift',           // leading "should", no ?
    'what if i did squats instead of deadlifts',        // leading "what"
    'do you think i should skip deadlift',              // "do you …"
    'should I skip deadlift?',
    'skip deadlift?',
    'is squat better than deadlift?',
  ]) {
    assert.equal(classifyMutationIntent(q), null, `question should be null: "${q}"`);
  }
  // imperatives are still mutations (not blocked by the question guard)
  assert.equal(classifyMutationIntent('do squats instead of deadlift').action, 'replace');
  assert.equal(classifyMutationIntent('skip deadlift').action, 'skip');
});

// The headline repro must resolve against a REALISTICALLY-named plan, not just the
// classifier in isolation: "skip deadlifts/rdls and do squats" → the compound target
// resolves the pending posterior-chain slot(s), singular-aware.
test('resolvePlanTargets: compound "deadlifts/rdls" resolves realistic plan slots', () => {
  assert.deepEqual(splitTargets('deadlifts/rdls'), ['deadlifts', 'rdls']);
  // bare "Deadlift" slot
  assert.deepEqual(resolvePlanTargets('deadlifts/rdls', [{ name: 'Deadlift' }, { name: 'Overhead Press' }]), ['Deadlift']);
  // realistically-named "Romanian Deadlift" slot (singular substring match)
  assert.deepEqual(resolvePlanTargets('deadlifts/rdls', [{ name: 'Romanian Deadlift' }, { name: 'Seated Row' }]), ['Romanian Deadlift']);
  // both planned → both resolved (compound removal), in plan order
  assert.deepEqual(resolvePlanTargets('deadlifts/rdls', [{ name: 'Deadlift' }, { name: 'Romanian Deadlift' }]), ['Deadlift', 'Romanian Deadlift']);
  // a single lift target
  assert.deepEqual(resolvePlanTargets('squats', [{ name: 'Back Squat' }, { name: 'Leg Curl' }]), ['Back Squat']);
});

test('resolvePlanTargets: never matches a completed/skipped slot (no re-opening), or unknown targets', () => {
  assert.deepEqual(resolvePlanTargets('deadlift', [{ name: 'Deadlift', status: 'completed' }]), []);
  assert.deepEqual(resolvePlanTargets('deadlift', [{ name: 'Deadlift', status: 'skipped' }]), []);
  assert.deepEqual(resolvePlanTargets('deadlift', [{ name: 'Deadlift', status: 'pending' }]), ['Deadlift']);
  assert.deepEqual(resolvePlanTargets('bench', [{ name: 'Deadlift' }, { name: 'Overhead Press' }]), []);
});

test('a drop-set technique mention is not read as a skip', () => {
  assert.equal(classifyMutationIntent('drop set on bench'), null);
  assert.equal(classifyMutationIntent('dropset bench'), null);
  assert.equal(classifyMutationIntent('drop-set the leg press'), null);
  // a genuine "drop X" skip (no "set") still classifies
  assert.equal(classifyMutationIntent('drop the leg curl').action, 'skip');
});
