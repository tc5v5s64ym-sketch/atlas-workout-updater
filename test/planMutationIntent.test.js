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

test('wrong-target guard: an EXACT name match outranks a substring match (single-token target)', () => {
  const plan = [
    { name: 'Single-Leg Seated Leg Press', status: 'pending' },
    { name: 'Leg Extension', status: 'pending' },
    { name: 'Leg Press', status: 'pending' },
  ];
  // The athlete named "leg press" EXACTLY — that slot must rank first: the live
  // caller (tryApplyPlanMutation / tryProposeImplicitSubstitution) mutates
  // targetNames[0], so plan order alone would skip/swap the single-leg variant
  // the athlete never named. The fuzzy match still resolves — ranked after.
  assert.deepEqual(resolvePlanTargets('leg press', plan), ['Leg Press', 'Single-Leg Seated Leg Press']);
  // Order-independent: the exact slot ranks first wherever it sits in the plan.
  assert.deepEqual(resolvePlanTargets('leg press', plan.slice().reverse()), ['Leg Press', 'Single-Leg Seated Leg Press']);
  // The singular tier still counts as exact ("deadlifts" names the "Deadlift" slot).
  assert.deepEqual(
    resolvePlanTargets('deadlifts', [{ name: 'Romanian Deadlift', status: 'pending' }, { name: 'Deadlift', status: 'pending' }]),
    ['Deadlift', 'Romanian Deadlift']);
  // NO exact match → plan order unchanged (the documented slice(0,1) compromise).
  assert.deepEqual(resolvePlanTargets('press', [{ name: 'Bench Press' }, { name: 'Overhead Press' }]), ['Bench Press', 'Overhead Press']);
  // COMPOUND targets keep plan order — the caller acts on ALL matches, so there
  // is no single wrong pick to guard (and the pinned compound expectations hold).
  assert.deepEqual(
    resolvePlanTargets('deadlifts/rdls', [{ name: 'Romanian Deadlift' }, { name: 'Deadlift' }]),
    ['Romanian Deadlift', 'Deadlift']);
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

// ── F-SB1-C: a conversational "no" is a correction, never a skip ───────────────
// Stage B workout 1 (2026-08-01), owner session FR-20260801152350-nngk9o6f. The owner
// typed "No I'm looking for a substitute for bench press". The "no X" lane captured the
// WHOLE clause as the skip target — looksLikeExercise accepts any 2–60 char string — the
// downstream resolver matched it to the Bench Press slot, and the lift was silently
// dropped ("Skipped Bench Press. Next up: Dumbbell Side Bend."). He asked for a swap and
// the plan lost the exercise.
test('F-SB1-C: the owner\'s exact turn is an implicit substitution ON bench press, never a skip', () => {
  // Curly apostrophe, exactly as a mobile keyboard produced it.
  for (const text of [
    'No I’m looking for a substitute for bench press',
    "No I'm looking for a substitute for bench press",
    'i am looking for a substitute for bench press',
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'substitute', `must request a swap, not a skip: ${text}`);
    assert.equal(r.target, 'bench press', 'the NAMED lift is what gets replaced');
    assert.equal(r.implicit, true, 'the engine picks the substitute — the athlete named none');
  }
});

// Codex P1 (PR #1238): returning null was not enough. `checkAndSuggestSubstitute` sends no
// `intent`, so /api/suggest-substitute's constraint gate ("busy"/"taken") refuses a message
// like this one and the athlete gets generic coach prose. Classifying it routes the turn to
// tryProposeImplicitSubstitution, which DOES send `intent:'substitute'`.
test('F-SB1-C: "<substitute noun> for|to X" names the lift being REPLACED, not the replacement', () => {
  for (const [text, target] of [
    ['give me an alternative to squats', 'squats'],
    ['suggest a replacement for rdls', 'rdls'],
    ['substitute for bench press', 'bench press'],
    ['i need a substitute for leg press', 'leg press'],
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'substitute', `substitute request: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
  }
});

// The noun anchor keeps the destination-only VERB forms untouched.
test('F-SB1-C: destination-only swaps still name a destination', () => {
  for (const text of ['swap to dips', 'swap for dips', 'switch to incline bench', 'sub in leg curls', 'replace with dips']) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'replace', `still a destination-only replace: ${text}`);
    assert.equal(r.target, '__current__', `the CURRENT slot is the target: ${text}`);
  }
});

test('F-SB1-C: a conversational "no" never becomes a plan mutation', () => {
  for (const text of [
    'no i want to keep squats',            // the opposite of a skip
    "no that's not what i meant",
    'no thanks',
    'no you misread me',
    'no we already did that one',
    'no it was the other lift',
    'no wait, i still need to do rdls',    // "rdls" appears but the intent is to KEEP it
  ]) {
    assert.equal(classifyMutationIntent(text), null, `must not mutate: ${text}`);
  }
});

// The guard must not cost the lane the owner finds it EXISTS for (2026-07-07).
test('F-SB1-C: the noun-phrase "no X" skip still classifies', () => {
  for (const [text, target] of [
    ['no RDLs for me today', 'rdls'],
    ['no more curls', 'curls'],
    ['no leg press today', 'leg press'],
    ['no bench press', 'bench press'],
    ['no single leg seated leg press', 'single leg seated leg press'],
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'skip', `still a skip: ${text}`);
    assert.equal(r.target, target, `target: ${text}`);
  }
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

// ── Production bug (2026-07-11): decline + replacement request → IMPLICIT SUBSTITUTION.
// Active exercise Back Squat; athlete typed "I don't want to do squats, give me
// something else." The decline lane greedily captured "squats, give me something else"
// and emitted { action: 'skip' }, so Atlas SKIPPED Back Squat instead of substituting
// it. A decline (or explicit swap) that asks for an UNNAMED replacement must classify
// as an implicit substitution (engine picks the sub) and must NEVER create a literal
// "something else" exercise. A plain decline with no replacement request stays a skip.
test('production bug: decline + "give me something else" → implicit substitution, not skip', () => {
  const r = classifyMutationIntent("I don't want to do squats, give me something else.");
  assert.equal(r && r.action, 'substitute', 'implicit substitution, not skip');
  assert.equal(r.implicit, true);
  assert.equal(r.target, 'squats');
  assert.ok(!r.substitute || !/something/.test(String(r.substitute)), 'no literal "something else" substitute');
});

test('decline + replacement-request variants all classify as implicit substitution', () => {
  for (const text of [
    "I don't want to do squats, give me something different",
    "I don't want to do squats, give me another exercise",
    "I don't want to do squats, give me an alternative",
    "I don't want to do squats, what else can I do",
    "i don't want to do squats give me something else",     // no comma
  ]) {
    const r = classifyMutationIntent(text);
    assert.equal(r && r.action, 'substitute', `substitute: ${text}`);
    assert.equal(r.implicit, true, `implicit: ${text}`);
    assert.equal(r.target, 'squats', `target squats: ${text}`);
  }
});

test('explicit "replace X with something else" is implicit substitution, never a literal "something else" slot', () => {
  const r = classifyMutationIntent('Replace back squats with something else');
  assert.equal(r && r.action, 'substitute');
  assert.equal(r.implicit, true);
  assert.equal(r.target, 'back squats');
  assert.ok(!r.substitute || !/something/.test(String(r.substitute)), 'no phantom "something else"');
  // destination-only vague swap → positional implicit substitution (current slot)
  const p = classifyMutationIntent('swap to something else');
  assert.equal(p && p.action, 'substitute');
  assert.equal(p.positional, true);
});

test('control: explicit NAMED substitution is unchanged (a real substitute stays a replace)', () => {
  const r = classifyMutationIntent('Swap back squats for leg press');
  assert.equal(r && r.action, 'replace');
  assert.equal(r.target, 'back squats');
  assert.equal(r.substitute, 'leg press');
});

test('control: true skip and bare/plain decline still skip (unchanged)', () => {
  const skip = classifyMutationIntent('Skip back squats');
  assert.equal(skip && skip.action, 'skip');
  assert.equal(skip.target, 'back squats');
  // PR-I2 governed decline with no replacement request stays a skip — case 5 unchanged.
  const today = classifyMutationIntent("I don't want to do squats today");
  assert.equal(today && today.action, 'skip');
  assert.equal(today.target, 'squats');
  const bare = classifyMutationIntent("I don't want to do squats");
  assert.equal(bare && bare.action, 'skip');
  assert.equal(bare.target, 'squats');
});
