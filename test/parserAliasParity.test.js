'use strict';

// Shadow-parity guard for the parser-alias migration (Remediation PR-14).
//
// PR-14 moved the parser's three hardcoded alias tables (EXERCISE_ALIASES,
// AMBIGUOUS_ALIASES, CONTEXTUAL_ALIASES) out of services/workoutTextParser.js and
// into data/parser_aliases.v1.json, which the parser now loads at module load.
// This test is the committed parity anchor: it holds an INDEPENDENT frozen copy of
// the pre-migration tables and asserts the JSON-sourced tables are byte-identical
// (content AND order — order is load-bearing: EXERCISE_ALIASES ties break by
// insertion order under the length-sort, and CONTEXTUAL_ALIASES is longest-first by
// list order with no runtime sort). It also asserts end-to-end resolution parity:
// every alias resolves through canonicalizeExerciseName exactly as before.
//
// If this test fails, the data file drifted from the frozen contract — reconcile
// deliberately (and update this frozen reference in the same change).

const test = require('node:test');
const assert = require('node:assert');
const parser = require('../services/workoutTextParser');
const { canonicalizeExerciseName, EXERCISE_ALIASES, AMBIGUOUS_ALIASES, CONTEXTUAL_ALIASES } = parser;

// ── FROZEN pre-migration reference (verbatim from the old hardcoded tables) ──────
const FROZEN_EXERCISE_ALIASES = [
  ['Incline DB Press', ['incline dumbbell press', 'incline db press', 'incline db bench', 'dumbbell incline press']],
  ['Incline Bench Press', ['incline bench press', 'incline barbell bench', 'incline bench', 'ibp']],
  ['Decline Bench Press', ['decline bench press', 'decline barbell bench', 'decline bench']],
  ['Bench Press', ['bench press', 'barbell bench', 'flat bench', 'bb bench', 'bench', 'bp']],
  ['Back Squat', ['back squat', 'bb squat', 'squats', 'squat', 'bs']],
  ['Deadlift', ['deadlift', 'dead', 'dl']],
  ['RDL', ['romanian deadlifts', 'romanian deadlift', 'romanian dls', 'romanian dl', 'rdls', 'rdl']],
  ['Overhead Press', ['overhead press', 'over head press', 'military press', 'standing press', 'strict press', 'overhead', 'ohp']],
  ['Lat Pulldown', ['lat pulldown', 'lat pull down', 'pulldown', 'cable pulldown']],
  ['Seated Row', ['seated row', 'seated rows', 'cable row', 'cable rows', 'machine row', 'machine rows']],
  // RECONCILED 2026-07-31 (owner gym session, build 2964ba8). 'barbell row' and its
  // variants were absent from every parser table, so Atlas could RECOMMEND a Barbell
  // Row substitute (services/substitutionRecommender.js) and then fail to recognize
  // the name — canonicalizeExerciseName returned null, messageNamesALift went false,
  // and coachResponseGrounding.resolveTurnExercises fell back to the WHOLE plan,
  // leaking a stale Seated Row / Bench Press prescription into the answer.
  // Added as aliases of the EXISTING Bent-Over Row because the exercise catalog
  // (truth source B) already resolves 'barbell row' → 'Bent-Over Row'; minting a new
  // canonical would have forked the taxonomy and tripped the Exercise Truth Audit.
  ['Bent-Over Row', ['bent-over row', 'bent over row', 'bent row', 'reverse-grip row', 'reverse row', 'bor', 'barbell row', 'barbell rows', 'bb row', 'bb rows']],
  ['Hammer Curl', ['hammer curls', 'hammer curl', 'hammers', 'hammer']],
  ['Bicep Curl', ['bicep curls', 'biceps curls', 'bicep curl', 'biceps curl']],
  ['Face Pull', ['face pulls', 'face pull']],
  ['Single-Leg Leg Curl', ['single-leg leg curl', 'single leg leg curl', 'sl leg curl']],
  ['Leg Curl', ['hamstring curl', 'leg curls', 'ham curls', 'leg curl']],
  ['Leg Extension', ['leg extension', 'leg extensions', 'leg ext', 'knee extension']],
  ['Shrug', ['shrugs', 'shrug', 'db shrugs', 'dumbbell shrugs', 'barbell shrugs']],
  ['Single-Leg Seated Leg Press', ['seated single leg press', 'single-leg press', 'single leg press', 'slp']],
  ['Leg Press', ['leg press', 'machine leg press']],
  ['Pull-Up', ['pull-up', 'pull up', 'pullup', 'pullups', 'pull-ups']],
  ['Chin-Up', ['chin-up', 'chin up', 'chinup', 'chinups', 'chin-ups']],
  ['Hip Thrust', ['hip thrust', 'hip thrusts', 'barbell hip thrust']],
  ['Hanging Knee Raises', ['hanging knee raises', 'captains chair', 'captain chair', 'knee raises', 'kr']],
  ['Lateral Raises', ['lateral raises', 'lateral raise', 'side raises', 'laterals', 'lateral']],
  ['Dips (Weighted)', ['weighted dips', 'dips', 'dip', 'wd']],
  ['Push-Up', ['push-up', 'push up', 'pushups', 'push ups', 'push-ups', 'pushup']],
  ['Cable Tricep Pushdown', ['cable tricep pushdown', 'cable tricep pushdowns', 'tricep pushdown', 'tricep pushdowns', 'tricep pulldown', 'tricep pulldowns', 'tricep pull', 'tricep pulls', 'cable triceps', 'cable tricep']],
];

const FROZEN_AMBIGUOUS_ALIASES = {
  press: 'Which press - OHP, bench, or incline?',
  // RECONCILED 2026-07-31: the prompt enumerates the options, and barbell is now one.
  row: 'Which row - barbell, seated, bent-over, cable, or machine?',
  rows: 'Which row - barbell, seated, bent-over, cable, or machine?',
};

const FROZEN_CONTEXTUAL_ALIASES = {
  'Lat Pulldown': ['lat pull', 'lats'],
  'Incline DB Press': ['incline press', 'incline'],
};

// ── structural parity (content + order) ──────────────────────────────────────────

test('parity: EXERCISE_ALIASES matches the frozen table byte-for-byte, in order', () => {
  assert.deepStrictEqual(EXERCISE_ALIASES, FROZEN_EXERCISE_ALIASES);
  // Order is load-bearing (length-sort tie-break) — assert serialized order too.
  assert.strictEqual(JSON.stringify(EXERCISE_ALIASES), JSON.stringify(FROZEN_EXERCISE_ALIASES));
});

test('parity: AMBIGUOUS_ALIASES matches the frozen table', () => {
  assert.deepStrictEqual(AMBIGUOUS_ALIASES, FROZEN_AMBIGUOUS_ALIASES);
});

test('parity: CONTEXTUAL_ALIASES matches the frozen table, in longest-first list order', () => {
  assert.deepStrictEqual(CONTEXTUAL_ALIASES, FROZEN_CONTEXTUAL_ALIASES);
  // No runtime sort — inner-list order IS the longest-first contract.
  assert.strictEqual(JSON.stringify(CONTEXTUAL_ALIASES), JSON.stringify(FROZEN_CONTEXTUAL_ALIASES));
});

// ── resolution parity (end-to-end, the zero-behavior-diff proof) ─────────────────

test('parity: every strong alias resolves to its canonical name', () => {
  for (const [canonical, aliases] of FROZEN_EXERCISE_ALIASES) {
    for (const alias of aliases) {
      const res = canonicalizeExerciseName(alias);
      assert.ok(res && !res.ambiguous, `alias "${alias}" must resolve to a lift`);
      assert.strictEqual(res.canonicalName, canonical,
        `alias "${alias}" must resolve to "${canonical}" (got "${res && res.canonicalName}")`);
    }
  }
});

test('parity: every ambiguous word returns its clarify prompt (never a silent lift)', () => {
  for (const [word, message] of Object.entries(FROZEN_AMBIGUOUS_ALIASES)) {
    const res = canonicalizeExerciseName(word);
    assert.ok(res && res.ambiguous === true, `"${word}" must be ambiguous`);
    assert.strictEqual(res.message, message, `"${word}" must return the exact clarify prompt`);
  }
});

test('parity: contextual aliases never start a lift on their own', () => {
  for (const aliases of Object.values(FROZEN_CONTEXTUAL_ALIASES)) {
    for (const alias of aliases) {
      // A contextual word alone (no anchor exercise active) must not resolve to a
      // lift — findExerciseInText returns null (contextual aliases can't start one).
      const res = canonicalizeExerciseName(alias);
      assert.ok(!res || !res.canonicalName,
        `contextual alias "${alias}" must not stand alone as a lift (got ${JSON.stringify(res)})`);
    }
  }
});
