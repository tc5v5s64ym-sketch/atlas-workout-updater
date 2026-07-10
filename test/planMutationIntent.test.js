'use strict';

// P0 wiring Sub-PR 2a — deterministic plan-mutation intent classifier.
// The live-gym repro: "skip deadlifts/rdls and do squats" must be recognized as a
// REPLACE so the canonical session mutates (no LLM prose in the loop).

const test = require('node:test');
const assert = require('node:assert/strict');

// PR-08: the module is now an ES module — load it via dynamic import (Node 20 CI
// has no require(esm)).
let classifyMutationIntent, splitTargets, resolvePlanTargets, cleanName;
test.before(async () => {
  ({ classifyMutationIntent, splitTargets, resolvePlanTargets, cleanName } = await import('../src/app/planMutationIntent.js'));
});

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

// PR-11 Bug 2 — the live repro: "Swap next workout for dips" meant "make dips the
// next exercise", but the parser read "next workout" as a lift NAME (matching no
// slot), fell through to the LLM, and the LLM removed Dips. A positional reference
// must resolve to the current/next slot, and a destination-only swap must be a
// substitution INTO the current slot — never a removal.
test('positional swap: "swap next workout for dips" is a positional replace, not a named target', () => {
  const r = classifyMutationIntent('swap next workout for dips');
  assert.equal(r && r.action, 'replace');
  assert.equal(r.substitute, 'dips');
  assert.equal(r.positional, true, 'target is positional (current/next slot), not a lift named "next workout"');
});

test('destination-only swaps ("swap to/for X", "sub in X") are positional replaces', () => {
  for (const text of ['swap to dips', 'swap for dips', 'switch to incline bench', 'sub in leg curls', 'replace with dips']) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'replace', `replace: ${text}`);
    assert.equal(r.positional, true, `positional: ${text}`);
    assert.ok(r.substitute && r.substitute.length, `substitute captured: ${text}`);
  }
});

test('"replace next exercise/lift/one with X" is a positional replace', () => {
  for (const text of ['replace next exercise with dips', 'replace the next one with dips', 'replace next lift with dips']) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'replace', `replace: ${text}`);
    assert.equal(r.substitute, 'dips', `substitute: ${text}`);
    assert.equal(r.positional, true, `positional: ${text}`);
  }
});

test('"remove X" / "take out X" / "get rid of X" classify as skip (removal)', () => {
  for (const [text, target] of [['remove dips', 'dips'], ['take out leg extensions', 'leg extensions'], ['get rid of curls', 'curls'], ['delete deadlift', 'deadlift']]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'skip', `skip: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
    assert.ok(!r.positional, `named removal is not positional: ${text}`);
  }
});

test('named swaps stay named (source + destination), never positional', () => {
  const r = classifyMutationIntent('swap bench for dips');
  assert.equal(r.action, 'replace');
  assert.equal(r.target, 'bench');
  assert.equal(r.substitute, 'dips');
  assert.ok(!r.positional, 'a named source is not a positional swap');
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

// ── ADD-2 (PR10 regression addendum §2): negation-style skip ─────────────────
// "no RDLs for me today" must classify as a skip (it was only getting a coach reply).
test('ADD-2: negation-style "no X" classifies as a skip', () => {
  for (const [text, target] of [
    ['no RDLs for me today', 'rdls'],
    ['no more curls', 'curls'],
    ['no rdls', 'rdls'],
    ['no leg press today', 'leg press'],
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'skip', `skip: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
  }
});

test('ADD-2: a leading reason clause before "no X" still classifies as skip', () => {
  const r = classifyMutationIntent('My lower back is a bit sore so no RDLs for me today');
  assert.equal(r && r.action, 'skip');
  assert.equal(r.target, 'rdls', 'reason peeled, RDL captured');
  // comma connector too
  assert.equal(classifyMutationIntent('legs are cooked, no leg press today').target, 'leg press');
});

test('ADD-2: cleanName strips stacked session-scope fillers ("for me today")', () => {
  assert.equal(cleanName('rdls for me today'), 'rdls');
  assert.equal(cleanName('leg press for the rest of the session'), 'leg press');
  assert.equal(cleanName('curls right now'), 'curls');
});

// A negation that is a real REFUSAL to skip must never classify as a skip.
test('ADD-2: "no X" lane stays conservative on non-skips', () => {
  // A bare "no" with nothing after is not a skip.
  assert.equal(classifyMutationIntent('no'), null);
  // A genuine negation of an intent still returns null (the reason-lane guard).
  assert.equal(classifyMutationIntent("my back is sore but i won't skip rdls"), null);
});

// ── ADD-2: lift-code stem resolution so "rdls" reaches the RDL01 slot ─────────
test('ADD-2: resolvePlanTargets resolves a token to a slot by lift-code stem', () => {
  const plan = [{ name: 'Romanian Deadlift', liftCode: 'RDL01' }, { name: 'Seated Row', liftCode: 'ROW01' }];
  // "Romanian Deadlift" has no "rdl" substring — only the code stem RDL01→"rdl" reaches it.
  assert.deepEqual(resolvePlanTargets('rdls', plan), ['Romanian Deadlift']);
  assert.deepEqual(resolvePlanTargets('rdl', plan), ['Romanian Deadlift']);
  // OHP → OHP01
  assert.deepEqual(resolvePlanTargets('ohp', [{ name: 'Overhead Press', liftCode: 'OHP01' }]), ['Overhead Press']);
  // no code + no name match → nothing (unchanged behaviour when liftCode absent)
  assert.deepEqual(resolvePlanTargets('rdls', [{ name: 'Romanian Deadlift' }]), []);
  // a completed/skipped slot is never re-opened by the code tier either
  assert.deepEqual(resolvePlanTargets('rdls', [{ name: 'Romanian Deadlift', liftCode: 'RDL01', status: 'completed' }]), []);
});

// ── PR-I2 (canary find, 2026-07-10): gerund mutation verbs ────────────────────
// The primary Coach's Pick canary typed "Swapping seated row for bent over row";
// the classifier only matched the imperative base verb "swap", so the present
// participle "swapping" fell through to the coach challenge lane instead of
// applying the substitution. A leading gerund mutation verb normalizes to its
// imperative so ALL the existing swap/skip grammar applies unchanged.
test('PR-I2: a leading gerund swap verb classifies like its imperative', () => {
  const r = classifyMutationIntent('Swapping seated row for bent over row');
  assert.equal(r && r.action, 'replace', 'gerund "Swapping X for Y" is a replace');
  assert.equal(r.target, 'seated row');
  assert.equal(r.substitute, 'bent over row');
});

test('PR-I2: gerund forms of every swap/skip verb classify', () => {
  const cases = [
    ['swapping bench for dips', 'replace', 'bench', 'dips'],
    ['switching lat pulldown to pull ups', 'replace', 'lat pulldown', 'pull ups'],
    ['replacing overhead press with db press', 'replace', 'overhead press', 'db press'],
    ['substituting deadlift for squats', 'replace', 'deadlift', 'squats'],
  ];
  for (const [text, action, target, substitute] of cases) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, action, `${action}: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
    assert.equal(r.substitute, substitute, `substitute: ${text}`);
  }
  for (const [text, target] of [
    ['skipping leg extensions', 'leg extensions'],
    ['dropping the leg curl', 'leg curl'],
    ['removing dips', 'dips'],
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'skip', `skip: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
  }
});

test('PR-I2: gerund normalization only fires at the head, never mid-name', () => {
  // "rowing" is not a mutation verb; a bare exercise phrase stays a non-mutation.
  assert.equal(classifyMutationIntent('rowing'), null);
  // A drop-set technique mention is still not a skip even with the gerund lane.
  assert.equal(classifyMutationIntent('dropping into a drop set on bench'), null);
});

// ── PR-I2 (canary find, 2026-07-10): explicit decline-to-do skip ──────────────
// The canary typed "I don't want to do leg extensions"; the classifier had no
// grammar for a declined NAMED exercise, so it fell to the coach, which produced
// an early-stop message. An explicit decline that NAMES a planned exercise is a
// deterministic skip. This is narrow, NAMED-exercise language only — no broad
// sentiment inference (bare fatigue / vague pronouns still route to the coach).
test('PR-I2: an explicit decline naming an exercise classifies as skip', () => {
  for (const [text, target] of [
    ["I don't want to do leg extensions", 'leg extensions'],
    ["i don't want to do squats", 'squats'],
    ["i do not want to do deadlift", 'deadlift'],
    ["i don't want leg extensions", 'leg extensions'],
    ["i'd rather not do leg press", 'leg press'],
    ["i'd rather not do the deadlift", 'deadlift'],
    ["i don't wanna do curls", 'curls'],
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'skip', `skip: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
  }
});

test('PR-I2: decline lane stays conservative — no broad sentiment, no double-negation', () => {
  for (const text of [
    "i don't want to skip squats",     // negation of a skip → keep it (never skip "squats")
    "i don't want to swap bench for dips", // negation of a swap
    "i don't want to do this",         // vague pronoun → not a named exercise
    "i don't want to do anything",     // vague → coach handles the sentiment
    "i don't want to be here",         // pure sentiment, no exercise
    "i am tired",                      // bare fatigue is never a mutation
    "i don't feel like it",            // sentiment, no named target
  ]) {
    assert.equal(classifyMutationIntent(text), null, `should be null: "${text}"`);
  }
});
