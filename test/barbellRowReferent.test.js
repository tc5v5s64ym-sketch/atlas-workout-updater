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

// The defect generalized (Codex #1209 P1). The recommender offered names that NO
// truth source knew — 'Incline Press' (the DEFAULT substitute for Bench Press) and
// 'Chest Fly' were absent from the catalog, the coaching KB, and the parser alike.
// Any athlete who accepted one and then asked about it would hit the identical stale
// answer, on the most common lift in the program.
//
// Fixed at both ends rather than allowlisted: the recommender now names lifts that
// exist ('Incline DB Press', 'Cable Fly' — the coaching KB's own canonical for
// config/coaching/exercises/cable-chest-fly.json), and 'Good Morning' (a real catalog
// canonical) gained its plural and qualified parser aliases.
//
// ONE documented exception remains — 'Good Morning' — and it is NOT the rationalized
// allowlist Codex rejected earlier. Codex #1209 (c4128d6) then showed that making the
// BARE phrase a strong alias costs more than it buys: findExerciseInText matches an
// alias at the START of a message before any later lift, so "Good morning, how much for
// bench?" canonicalized to Good Morning and sessionQuestionAnswer.resolveLiftName
// returned Good Morning's load for a BENCH question. isConversationalAside correctly
// refuses to swallow that message (it carries real coaching content), so nothing else
// catches it. A morning greeting is far more frequent in a gym session than the Good
// Morning lift, so the greeting must win.
//
// The bare alias is therefore removed; 'good mornings' and 'barbell good morning' stay
// (both verified unambiguous). Three properties keep this honest rather than convenient:
//   • the exception is exactly one name, asserted by equality — a new unparseable
//     substitute still fails this test;
//   • 'Good Morning' is never a DEFAULT substitute (test 1c stays absolute, empty
//     allowlist) — it is a secondary candidate for Deadlift / Romanian Deadlift only,
//     verified below, so the hot path Codex flagged is genuinely unaffected;
//   • renaming the recommender's emission was rejected: 'Good Morning' is also a KEY in
//     SUBSTITUTION_MAP, so emitting 'Barbell Good Morning' would make the accepted
//     substitute unkeyable on the next lookup — trading this gap for a worse one.
// The real repair is a matcher-level greeting/lift-name collision guard, logged to
// BACKLOG.md as its own concern rather than widened into this PR.
const SUBSTITUTE_PARSE_EXCEPTIONS = ['Good Morning'];

test('1b. every recommendable substitute is recognizable — one documented exception', () => {
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
  assert.deepEqual(unparseable, SUBSTITUTE_PARSE_EXCEPTIONS,
    'Atlas must never suggest a substitute it cannot then recognize by name — '
    + `the exact defect from the 2026-07-31 session. Got: ${unparseable.join(', ') || '(none)'}`);
});

// The exception is bounded on both sides: the bare phrase does not resolve, but the
// plural and qualified forms DO, so an athlete who accepts the substitute can still
// discuss it in the wording they would naturally use.
test('1b-bis. the Good Morning exception is bounded — plural and qualified forms resolve', () => {
  for (const usable of ['good mornings', 'barbell good morning', 'good mornings 135 8/2']) {
    const c = canonicalizeExerciseName(usable);
    assert.equal(c && c.canonicalName, 'Good Morning', `${usable} must resolve`);
  }
  // …and the greeting must never hijack a question about another lift.
  const greeting = canonicalizeExerciseName('Good morning, how much for bench?');
  assert.equal(greeting && greeting.canonicalName, 'Bench Press',
    'a morning greeting must not steal the referent from the lift actually asked about');
  assert.equal(resolveLiftName('Good morning, how much for bench?', [], {}), 'Bench Press',
    'the deterministic chat lane must answer about Bench Press, not Good Morning');
});

// KNOWN EXPOSURE — recorded honestly rather than asserted away (Codex #1209 P1, round 2).
//
// An earlier version of this test asserted "Good Morning is never a DEFAULT substitute"
// and passed. That claim was TOO NARROW and I reported it to the owner as if it bounded
// the exception: it only ever checked the CONTEXT-FREE default. Atlas also recommends
// context-aware, passing the rest of the plan as `avoid` (index.js /api/suggest-substitute
// → recommendSubstitute(current, { avoid })), and on that route Good Morning IS announced
// to the athlete. The follow-up then resolves to the WRONG LIFT — not to nothing:
//
//   recommendSubstitute('Deadlift', { avoid: ['Romanian Deadlift'] }) → 'Good Morning'
//   resolveLiftName('how much for good morning?', <that exchange>) → 'Deadlift'
//
// A Deadlift load answered for a Good Morning question is the same defect class this PR
// exists to fix, on a much heavier lift. It is pending an owner ruling (the prior ruling
// rested on the narrower claim above), so this test pins the REAL current behavior —
// including the failure — so nothing can quietly claim the exception is bounded.
test('1b-ter. KNOWN: Good Morning is context-free-safe but reachable via `avoid`', () => {
  const { recommendSubstitute, SUBSTITUTION_MAP } = require('../services/substitutionRecommender');

  // Still true, and still worth pinning: no lift defaults to it.
  for (const from of Object.keys(SUBSTITUTION_MAP || {})) {
    const rec = recommendSubstitute(from);
    assert.notEqual(rec && (rec.recommendation || rec.name), 'Good Morning',
      `recommendSubstitute(${JSON.stringify(from)}) must not DEFAULT to the one unparseable name`);
  }

  // …but the context-aware route DOES announce it. This is the exposure.
  const ctxAware = recommendSubstitute('Deadlift', { avoid: ['Romanian Deadlift'] });
  assert.equal(ctxAware && ctxAware.recommendation, 'Good Morning',
    'documents the reachable path: with RDL avoided, Atlas announces Good Morning');

  // And the bare-singular follow-up resolves to the WRONG lift rather than failing closed.
  const exchange = [{ text: 'swap deadlift, rack is taken' }, { text: 'Try Good Morning instead.' }];
  assert.equal(resolveLiftName('how much for good morning?', exchange, {}), 'Deadlift',
    'KNOWN FAILURE pending owner ruling — the bare singular answers with Deadlift\'s load');
  // The plural an athlete may equally well type is fine, which is why this is narrow.
  assert.equal(resolveLiftName('how much for good mornings?', exchange, {}), 'Good Morning');
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
  // …and must NOT also offer "bent-over" (Codex #1209 P2). Both labels resolve to the
  // SAME canonical, so listing both asks the athlete to choose between one lift and
  // itself. 'barbell' is kept because it is the owner's own wording from the session
  // that surfaced this defect.
  assert.doesNotMatch(c.message, /bent[- ]over/i,
    'barbell and bent-over are one canonical — the prompt must not present them as a choice');
  const bare = canonicalizeExerciseName('row');
  assert.ok(bare && bare.ambiguous === true);
  assert.equal(bare.message, c.message, '"row" and "rows" must ask the identical question');
});

// The clarification's remaining labels are NOT all distinct: 'seated', 'cable', and
// 'machine' all canonicalize to Seated Row. That collapse PRE-DATES this PR (none of
// those labels is touched here) and narrowing it is an owner-facing taxonomy decision,
// so it is logged to BACKLOG.md rather than widened into this change. This test pins
// the current truth so the backlog item cannot silently rot.
test('4b-bis. KNOWN: seated/cable/machine still collapse to one canonical (pre-existing)', () => {
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
