'use strict';

// Barbell Row referent defect — owner gym session 2026-07-31 (build 2964ba8).
//
// THE REPORTED FAILURE. The accepted plan contained Seated Row. The machine was busy,
// so the athlete accepted ATLAS'S OWN suggested substitute — Barbell Row — and then
// asked "How much should I lift for barbell rows?". Production recorded:
//   • intent classified correctly (progression_review, conf 0.9, target_lift extracted)
//   • discussion_referent → null
//   • engine_decision → absent (listed in the trace's missing stages)
//   • the visible answer was grounded in the STALE Seated Row / Bench Press plan
//
// THE ROOT CAUSE. `services/substitutionRecommender.js` offers 'Barbell Row' as the
// primary substitute for 'Seated Row', but 'Barbell Row' has NO entry in the parser
// alias table (`data/parser_aliases.v1.json`). Atlas can therefore suggest a lift it
// cannot afterwards recognize by name. The consequence chain:
//
//   canonicalizeExerciseName('barbell rows') → null
//     → coachResponseGrounding.messageNamesALift(...) → false
//       → resolveTurnExercises() SKIPS its fail-closed "named a lift we could not map
//         → return []" branch
//         → falls back to planLiftNames(context) = THE WHOLE PLAN
//           → the stale Seated Row + Bench Press leak into the grounded answer
//
// It is NOT a plural gap: 'seated row' AND 'seated rows' both canonicalize correctly.
// Singular 'barbell row' fails identically to the plural. The entry is simply absent.
//
// TWO CORRECTIONS TO THE REPORTED EXPECTATION.
//
// (1) ROW01 is SEATED ROW's code (`services/exerciseEnrichment.js` maps 'seated row'
//     and 'seated rows' → ROW01; `services/analytics.js` notes ROW01 and SR01 both
//     resolve to "Seated Row"). Asserting barbell rows → ROW01 would re-create the
//     very conflation this fixes.
//
// (2) The canonical for a barbell row is "Bent-Over Row", NOT a new "Barbell Row".
//     The exercise CATALOG (truth source B) already resolves 'barbell row' →
//     'Bent-Over Row', and the parser already carries that canonical. Minting a
//     separate 'Barbell Row' canonical forked the taxonomy and immediately tripped
//     the Exercise Truth Audit (A↔B disagreement on 'barbell row'/'barbell rows'/
//     'bb row'). The fix therefore EXTENDS the existing Bent-Over Row aliases so the
//     parser agrees with the catalog — no new canonical, no new lift code, no split
//     history.

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeExerciseName } = require('../services/workoutTextParser');
const grounding = require('../services/coachResponseGrounding');
const { generateLiftCode, hasCuratedLiftCode } = require('../services/exerciseEnrichment');
const { resolveLiftName } = require('../services/sessionQuestionAnswer');

const QUESTION = 'How much should I lift for barbell rows?';

// The exact conversation state: the accepted plan still carries Seated Row, and the
// athlete has accepted Barbell Row as the substitute.
const PLAN_BEFORE_SUB = { current_plan: [{ name: 'Seated Row' }, { name: 'Bench Press' }] };
// The recommender names the substitute 'Barbell Row' (services/substitutionRecommender.js),
// so that is exactly what lands in the plan when the athlete accepts it.
const PLAN_AFTER_SUB = { current_plan: [{ name: 'Barbell Row' }, { name: 'Bench Press' }] };

// ── 1. The name Atlas itself suggests must be recognizable ───────────────────

test('1a. a barbell row canonicalizes to the catalog\'s Bent-Over Row — singular and plural', () => {
  for (const s of ['barbell row', 'barbell rows', 'Barbell Row', 'Barbell Rows', 'bb row', 'bb rows']) {
    const c = canonicalizeExerciseName(s);
    assert.ok(c && c.canonicalName, `${JSON.stringify(s)} must canonicalize, got ${JSON.stringify(c)}`);
    assert.equal(c.canonicalName, 'Bent-Over Row',
      `${JSON.stringify(s)} → Bent-Over Row (the catalog's canonical), not a forked "Barbell Row"`);
  }
});

test('1a-bis. the parser agrees with the exercise catalog — no A↔B fork', () => {
  const { runAudit, partitionType1 } = require('../services/exerciseTruthAudit');
  const { anchored } = partitionType1(runAudit().type1);
  // Scoped to the aliases THIS change introduces. Other row aliases (cable row,
  // machine row, seated row(s)) carry pre-existing, separately-allowlisted A↔B
  // residuals that are out of scope here.
  const introduced = new Set(['barbell row', 'barbell rows', 'bb row', 'bb rows']);
  const conflicts = anchored.filter(r => introduced.has(String(r.alias).toLowerCase()));
  assert.deepEqual(conflicts, [],
    `the barbell-row aliases must agree with the catalog: ${JSON.stringify(conflicts)}`);
});

// THE DEFECT GENERALIZED — and where this PR deliberately stops.
//
// The barbell-row failure is one instance of a class: the recommender can suggest a
// name no parser table knows, and the athlete's follow-up then resolves to the WRONG
// lift instead of failing closed. Three names were in that state on main:
//
//   'Incline Press'  the DEFAULT substitute for Bench Press, and known to NO truth
//                    source (the catalog's name is 'Incline DB Press')
//   'Good Morning'   a real exercise-catalog canonical the parser simply lacked
//   'Chest Fly'      the coaching KB's canonical is 'Cable Fly'
//
// ONLY the first is fixed here, by renaming the recommendation to the catalog's real
// 'Incline DB Press' (owner ruling 3, 2026-07-31). It is the DEFAULT for Bench Press —
// the most common lift in the program — so it is the one case where the class defect
// sits on a hot path.
//
// 'Good Morning' and 'Chest Fly' are LEFT UNPARSEABLE, exactly as they are on main.
// That is a deliberate scope boundary, not an oversight, and the history is worth
// recording because two attempts to fix them here both made things worse:
//
//   • Adding a bare 'good morning' parser alias created a NEW defect on a more common
//     path — findExerciseInText matches a start-of-message alias ahead of any later
//     lift, so "Good morning, how much for bench?" returned Good Morning's load for a
//     BENCH question (Codex #1209, round 2).
//   • Restricting it to plural/qualified forms did not close the case either: Atlas
//     recommends context-aware (/api/suggest-substitute forwards the plan as `avoid`),
//     and on that route Good Morning IS announced, after which the bare singular
//     resolves to the preceding lift and answers with DEADLIFT's load (round 3).
//
// Both fixes traded one wrong-lift path for another, because the real defect is not
// the missing vocabulary — it is that an unresolvable name INHERITS the preceding lift
// instead of failing closed. That is a change to shared parser matching semantics
// affecting every alias, so it is its own PR, logged in BACKLOG.md.
//
// The invariant below is therefore stated honestly: NOT "every substitute is
// recognizable" (that was never true and this PR does not make it true), but "the
// unparseable set never GROWS, and no DEFAULT recommendation is ever unparseable".
//
// Measured against main rather than asserted — replaying main's own alias table over
// main's own substitution map yields FOUR unparseable substitutes:
//     ["Barbell Row", "Chest Fly", "Good Morning", "Incline Press"]
// This PR retires two of them (Barbell Row by alias, Incline Press by rename) and
// leaves the other two exactly as they were. So the set is strictly smaller, and the
// two that remain are unchanged rather than newly broken.
const SUBSTITUTES_UNPARSEABLE_ON_MAIN = ['Chest Fly', 'Good Morning'];

test('1b. the unparseable-substitute set never grows', () => {
  const { SUBSTITUTION_MAP } = require('../services/substitutionRecommender');
  const names = new Set();
  for (const [from, tos] of Object.entries(SUBSTITUTION_MAP || {})) {
    names.add(from);
    for (const t of (tos || [])) names.add(t);
  }
  assert.ok(names.size > 0, 'the substitution map exposes its lifts');
  const unparseable = [...names].filter((n) => {
    const c = canonicalizeExerciseName(n);
    return !(c && c.canonicalName);
  }).sort();
  assert.deepEqual(unparseable, SUBSTITUTES_UNPARSEABLE_ON_MAIN,
    'this PR must not leave MORE substitutes unrecognizable than main did. Two are '
    + 'knowingly left (their fix is the fail-closed matcher guard, see BACKLOG.md); a '
    + `THIRD appearing here is a new instance of the 2026-07-31 defect. Got: ${unparseable.join(', ')}`);
});

test('1b-bis. no morning greeting can steal the referent from the lift asked about', () => {
  // Guards the round-2 regression at its root: with no bare 'good morning' alias there
  // is nothing for a start-of-message match to latch onto.
  const greeting = canonicalizeExerciseName('Good morning, how much for bench?');
  assert.equal(greeting && greeting.canonicalName, 'Bench Press');
  assert.equal(resolveLiftName('Good morning, how much for bench?', [], {}), 'Bench Press',
    'the deterministic chat lane must answer about Bench Press, not Good Morning');
});

test('1c. the DEFAULT substitute for every lift is recognizable', () => {
  const { recommendSubstitute, SUBSTITUTION_MAP } = require('../services/substitutionRecommender');
  for (const from of Object.keys(SUBSTITUTION_MAP || {})) {
    const rec = recommendSubstitute(from);
    const name = rec && (rec.recommendation || rec.name);
    if (!name) continue;
    const c = canonicalizeExerciseName(String(name));
    assert.ok(c && c.canonicalName,
      `recommendSubstitute(${JSON.stringify(from)}) → ${JSON.stringify(name)} must be recognizable`);
  }
});

// ── 2. The question names a lift, so the whole-plan fallback must not fire ───

test('2a. the question is recognized as naming a lift', () => {
  assert.equal(grounding.messageNamesALift(QUESTION), true,
    'a named-lift question must be seen as naming a lift');
  assert.equal(grounding.messageNamesALift('How much should I lift for barbell row?'), true);
});

test('2b. REGRESSION: no stale Seated Row or Bench prescription can be returned', () => {
  // Before the fix this returned ["Seated Row","Bench Press"] — the exact symptom.
  const resolved = grounding.resolveTurnExercises(QUESTION, PLAN_BEFORE_SUB);
  assert.equal(resolved.includes('Seated Row'), false, 'stale Seated Row must never leak');
  assert.equal(resolved.includes('Bench Press'), false, 'stale Bench Press must never leak');
});

test('2c. with the substitution reflected in the plan, the turn resolves to Barbell Row', () => {
  const resolved = grounding.resolveTurnExercises(QUESTION, PLAN_AFTER_SUB);
  assert.deepEqual(resolved, ['Barbell Row'],
    'the engine must receive Barbell Row — not Seated Row, not Bench Press');
  assert.equal(resolved.includes('Seated Row'), false);
  assert.equal(resolved.includes('Bench Press'), false);
});

// ── 3. Lift-code identity: Barbell Row is NOT Seated Row ────────────────────

test('3a. a barbell row never carries Seated Row\'s or Bench\'s lift code', () => {
  const seated = generateLiftCode('Seated Row');
  assert.equal(seated, 'ROW01', 'ROW01 is Seated Row (pre-existing mapping)');
  for (const n of ['Barbell Row', 'barbell rows', 'Bent-Over Row']) {
    const code = liftCodeFor(n);
    assert.notEqual(code, seated, `${n} must not share Seated Row's ROW01 — that conflation is the defect`);
    assert.notEqual(code, 'SR01', `${n} must not be Seated Row`);
    assert.notEqual(code, 'BEN01', `${n} must not be Bench Press`);
  }
});

// Codex #1209 P1: aliasing only unified the PARSER. generateLiftCode derives the code
// from the name it is handed, so the raw recommender string 'Barbell Row' yields BRX01
// while the canonical 'Bent-Over Row' yields BOR01 — and the Log_Cleaned history lookup
// in /api/suggest-substitute would miss every BOR01 row. The route now canonicalizes
// first; this pins that every alias collapses to ONE code, so history is genuinely shared.
function liftCodeFor(name) {
  const c = canonicalizeExerciseName(name);
  return generateLiftCode((c && c.canonicalName) || name);
}

test('3b. every barbell-row alias collapses to ONE lift code — history is genuinely shared', () => {
  const expected = generateLiftCode('Bent-Over Row');
  assert.equal(expected, 'BOR01');
  for (const n of ['Barbell Row', 'barbell row', 'barbell rows', 'bb row', 'bb rows', 'bent over row']) {
    assert.equal(liftCodeFor(n), expected,
      `${n} must resolve to ${expected} so the substitute's history lookup finds its rows`);
  }
  // The raw (un-canonicalized) string is what the bug used — prove it really differs,
  // so this test fails if someone removes the canonicalization step.
  assert.notEqual(generateLiftCode('Barbell Row'), expected,
    'the raw name genuinely yields a different code — canonicalization is load-bearing');
});

test('3c. /api/suggest-substitute canonicalizes before deriving the lift code', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const i = src.indexOf('const canon = canonicalizeExerciseName(rec.recommendation');
  assert.notEqual(i, -1, 'the recommendation is canonicalized on the substitute route');
  const window = src.slice(i, i + 500);
  assert.match(window, /strictVariantGuard:\s*true/,
    'the canonicalization must use the variant guard so a qualified lift never collapses');
  assert.match(window, /hasCuratedLiftCode\(rec\.recommendation\)/,
    'a curated code on the raw name must win over the canonical');
});

// Codex #1209 P1 (round 2). The round-1 fix canonicalized UNCONDITIONALLY, and
// canonicalizeExerciseName matches an alias anywhere in the string — so it silently
// moved three substitutes onto another lift's history. `next_target` is a PRESCRIBED
// LOAD, so this is a load-safety path: a Goblet Squat slot would have been handed Back
// Squat's working weight. This replays the exact derivation the route performs.
function routeLiftCode(name) {
  const canon = canonicalizeExerciseName(name, { strictVariantGuard: true });
  const canonName = (canon && canon.canonicalName) || name;
  return hasCuratedLiftCode(name)
    ? generateLiftCode(name)
    : generateLiftCode(canonName);
}

test('3d. canonicalizing a substitute never moves it onto ANOTHER lift\'s history', () => {
  // The owner-ruled merge (2026-07-31 ruling 1) — this one MUST change.
  assert.equal(routeLiftCode('Barbell Row'), 'BOR01',
    'barbell row must share Bent-Over Row history — the whole point of this PR');
  assert.notEqual(generateLiftCode('Barbell Row'), 'BOR01', 'the merge is genuinely load-bearing');

  // Everything else must keep its own code. Each of these regressed under the
  // unconditional round-1 fix; the codes on the right are what a blanket
  // canonicalization produced.
  const mustNotDrift = [
    ['Dips',         'DIP01', 'DWX01'],   // curated code abandoned for a generated one
    ['Goblet Squat', 'GSX01', 'SQ01'],    // a dumbbell squat handed a barbell squat's load
    ['Hack Squat',   'HSX01', 'SQ01'],    // machine squat handed a barbell squat's load
  ];
  for (const [name, own, drifted] of mustNotDrift) {
    assert.equal(routeLiftCode(name), own, `${name} must keep its own lift code`);
    assert.notEqual(routeLiftCode(name), drifted,
      `${name} must never inherit ${drifted} — that prescribes another lift's load`);
  }
});

test('3e. NO substitute silently changes lift code except the owner-ruled merge', () => {
  const { SUBSTITUTION_MAP } = require('../services/substitutionRecommender');
  const names = new Set();
  for (const [from, tos] of Object.entries(SUBSTITUTION_MAP || {})) {
    names.add(from);
    for (const t of (tos || [])) names.add(t);
  }
  const changed = [...names].filter((n) => routeLiftCode(n) !== generateLiftCode(n)).sort();
  assert.deepEqual(changed, ['Barbell Row'],
    'exactly one substitute may change lift code, and only because the owner ruled that '
    + `barbell row shares Bent-Over Row's history. Got: ${changed.join(', ')}`);
});

// ── 4. Adjacent coverage the owner asked for ────────────────────────────────

test('4a. "barbell row" / "barbell rows" both resolve to Barbell Row in context', () => {
  for (const q of ['how much should I lift for barbell row?', 'how much should I lift for barbell rows?']) {
    assert.deepEqual(grounding.resolveTurnExercises(q, PLAN_AFTER_SUB), ['Barbell Row'], q);
    // …and it must never be Seated Row or Bench.
    assert.equal(grounding.resolveTurnExercises(q, PLAN_BEFORE_SUB).includes('Seated Row'), false, q);
  }
});

test('4b. bare "rows" stays AMBIGUOUS and asks which row — it never guesses', () => {
  const c = canonicalizeExerciseName('rows');
  assert.ok(c && c.ambiguous === true, 'bare "rows" must remain ambiguous, not silently pick one');
  assert.match(c.message, /which row/i);
  // The clarification must now offer barbell, since it is a real option.
  assert.match(c.message, /barbell/i,
    'the disambiguation prompt must list barbell now that Barbell Row exists');
  // …and must never present "barbell" and "bent-over" as SEPARATE choices (Codex #1209
  // P2): both resolve to the same canonical, so offering them as alternatives asks the
  // athlete to choose between one lift and itself.
  //
  // UPDATED 2026-07-31 (owner instruction, row-clarification PR): the prompt now GROUPS
  // athlete wording instead of dropping it — "barbell/bent-over" is one choice worded two
  // ways, not two choices. Dropping "bent-over" was the earlier way to satisfy the same
  // rule; grouping satisfies it while keeping wording the athlete actually uses. The rule
  // itself is unchanged and is asserted directly: whatever words appear, they must not sit
  // in different choice groups. test/rowClarificationDistinctChoices.test.js generalises
  // this over every group by resolving each phrase through the parser.
  const choiceGroups = c.message
    .replace(/^[^—:-]*[—:-]\s*/, '')
    .replace(/\?\s*$/, '')
    .split(/\s*,?\s*\bor\b\s*/i);
  const barbellGroup = choiceGroups.findIndex((g) => /barbell/i.test(g));
  const bentOverGroup = choiceGroups.findIndex((g) => /bent[- ]over/i.test(g));
  assert.ok(barbellGroup !== -1, 'barbell must appear in a choice group');
  if (bentOverGroup !== -1) {
    assert.equal(bentOverGroup, barbellGroup,
      'barbell and bent-over are one canonical — they may share a group, never be separate choices');
  }
  const bare = canonicalizeExerciseName('row');
  assert.ok(bare && bare.ambiguous === true);
  assert.equal(bare.message, c.message, '"row" and "rows" must ask the identical question');
});

// 'seated', 'cable', and 'machine' all canonicalize to Seated Row. When this test was
// written that collapse was a KNOWN defect in the prompt, which offered the three as
// separate choices; it is now fixed (owner instruction 2026-07-31) by grouping them as
// one choice worded three ways. The resolution below is unchanged and is still pinned
// here; the grouping itself is pinned by test/rowClarificationDistinctChoices.test.js.
test('4b-bis. seated/cable/machine are one canonical — now offered as one grouped choice', () => {
  for (const label of ['seated row', 'cable row', 'machine row']) {
    assert.equal(canonicalizeExerciseName(label).canonicalName, 'Seated Row', label);
  }
});

test('4c. a bare follow-up ("how much should I lift?") still falls back to the plan', () => {
  // It names no lift, so the plan fallback is CORRECT here — this pins that the fix
  // narrows only the named-lift path and does not break bare follow-ups.
  const resolved = grounding.resolveTurnExercises('how much should I lift?', PLAN_AFTER_SUB);
  assert.deepEqual(resolved, ['Barbell Row', 'Bench Press'],
    'a bare follow-up still resolves to the active plan');
});

test('4d. the pre-existing row lifts are unchanged', () => {
  assert.equal(canonicalizeExerciseName('seated row').canonicalName, 'Seated Row');
  assert.equal(canonicalizeExerciseName('seated rows').canonicalName, 'Seated Row');
  assert.equal(canonicalizeExerciseName('cable row').canonicalName, 'Seated Row');
  assert.equal(canonicalizeExerciseName('bent over row').canonicalName, 'Bent-Over Row');
  assert.equal(canonicalizeExerciseName('bent-over row').canonicalName, 'Bent-Over Row');
});
