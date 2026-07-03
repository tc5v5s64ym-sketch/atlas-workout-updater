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

// --- Owner live repro (2026-07-03): reason clause + compound skip ---
// "My legs are fried right now I think I'll skip single leg press and leg
// extensions" fell to the chat LLM (which debated the fatigue claim); the plan
// never mutated and the pin/composer stayed on the skipped lift.

test('repro: a leading reason clause no longer defeats the classifier', () => {
  const r = classifyMutationIntent("My legs are fried right now I think I'll skip single leg press and leg extensions");
  assert.equal(r && r.action, 'skip');
  assert.equal(r.target, 'single leg press and leg extensions');
});

test('reason-clause tolerance covers the intent-marker variants', () => {
  for (const [text, action] of [
    ["shoulder's cranky today, I'm gonna swap bench for db press", 'replace'],
    ["long day, i'll drop leg extensions", 'skip'],
    ["low on time so let's cut deadlift today", 'skip'],
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, action, `${action}: ${text}`);
  }
});

test('negated or question-form intent never classifies (reason-clause lane stays conservative)', () => {
  for (const text of [
    "i don't think i'll skip leg extensions",
    "my legs are tired but i won't skip leg press",
    "i'm tired, should i skip leg extensions",
    "legs are fried — do you think i'll skip leg press",
    'my legs are fried right now',                       // reason with no intent
  ]) {
    assert.equal(classifyMutationIntent(text), null, `should be null: "${text}"`);
  }
});

test('repro: "single leg press" resolves "Single-Leg Seated Leg Press" (token-subset tier)', () => {
  const plan = [
    { name: 'Romanian Deadlift', status: 'completed' },
    { name: 'Single-Leg Seated Leg Press', status: 'pending' },
    { name: 'Leg Extension', status: 'pending' },
    { name: 'Hammer Curls', status: 'pending' },
  ];
  const names = resolvePlanTargets('single leg press and leg extensions', plan);
  assert.deepEqual(names, ['Single-Leg Seated Leg Press', 'Leg Extension']);
});

test('token-subset tier: every word must be present, and it needs two words', () => {
  const plan = [
    { name: 'Single-Leg Seated Leg Press', status: 'pending' },
    { name: 'Leg Extension', status: 'pending' },
  ];
  // Both words present in the slot name (not a substring) → subset tier matches.
  assert.deepEqual(resolvePlanTargets('single press', plan), ['Single-Leg Seated Leg Press']);
  // One word missing → no match from any tier.
  assert.deepEqual(resolvePlanTargets('seated curl', plan), []);
  // (Single generic words still go through the PRE-EXISTING substring tier —
  // that behavior is owned by tryApplyPlanMutation's slice(0,1) compromise,
  // unchanged here.)
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

test('a curly apostrophe lead-in is stripped (mobile autocorrect) — substitute is clean', () => {
  // "Let's" with a curly ’ (U+2019) must strip like the straight form, not glue the
  // lead-in onto the captured substitute (live-gym v48 repro).
  const r = classifyMutationIntent('Let’s do rdls instead of deadlifts');
  assert.equal(r && r.action, 'replace');
  assert.equal(r.target, 'deadlifts');
  assert.equal(r.substitute, 'rdls', 'lead-in "let’s" stripped, substitute is just "rdls"');
  assert.equal(classifyMutationIntent("Let's do rdls instead of deadlifts").substitute, 'rdls');
});

test('a drop-set technique mention is not read as a skip', () => {
  assert.equal(classifyMutationIntent('drop set on bench'), null);
  assert.equal(classifyMutationIntent('dropset bench'), null);
  assert.equal(classifyMutationIntent('drop-set the leg press'), null);
  // a genuine "drop X" skip (no "set") still classifies
  assert.equal(classifyMutationIntent('drop the leg curl').action, 'skip');
});
