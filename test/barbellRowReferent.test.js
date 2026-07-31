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
const { generateLiftCode } = require('../services/exerciseEnrichment');

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

// The defect generalized: the recommender offered a lift the parser could not name.
// This guard enumerates every lift the recommender can suggest and asserts none is
// unrecognizable — EXCEPT a frozen, documented list of three that carry the identical
// defect but need an owner taxonomy decision before they can be fixed:
//
//   • Good Morning  — no entry anywhere; a clean add once named canonically.
//   • Chest Fly     — no entry; bare "fly"/"flies" would also need an ambiguity call.
//   • Incline Press — "incline press" already exists as a CONTEXTUAL alias of
//                     "Incline DB Press". Promoting it to a full alias would decide
//                     that a barbell incline and a dumbbell incline are the same lift.
//                     That is a taxonomy judgment, not a parser fix.
//
// The list is SHRINK-ONLY in spirit: a NEW unrecognizable substitute fails this test,
// so the class of defect the owner hit cannot silently reappear.
const KNOWN_UNPARSEABLE_SUBSTITUTES = ['Chest Fly', 'Good Morning', 'Incline Press'];

test('1b. no NEW unrecognizable substitute can be added (Barbell Row is fixed)', () => {
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

  assert.equal(unparseable.includes('Barbell Row'), false,
    'Barbell Row — the lift the owner actually hit — must be recognizable');
  assert.equal(canonicalizeExerciseName('Barbell Row').canonicalName, 'Bent-Over Row',
    'the recommender\'s suggested name resolves to the catalog canonical');
  assert.deepEqual(unparseable, KNOWN_UNPARSEABLE_SUBSTITUTES,
    'a NEW unrecognizable substitute means Atlas can suggest a lift it cannot discuss — '
    + `the exact defect from the 2026-07-31 session. Got: ${unparseable.join(', ')}`);
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
    const code = generateLiftCode(n);
    assert.notEqual(code, seated, `${n} must not share Seated Row's ROW01 — that conflation is the defect`);
    assert.notEqual(code, 'SR01', `${n} must not be Seated Row`);
    assert.notEqual(code, 'BEN01', `${n} must not be Bench Press`);
  }
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
  const bare = canonicalizeExerciseName('row');
  assert.ok(bare && bare.ambiguous === true);
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
