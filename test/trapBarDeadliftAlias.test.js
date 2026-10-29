'use strict';

// Trap Bar Deadlift parser-alias gap — SC9-RAY-01 investigation, issue #1607
// (design note, option B slice i).
//
// THE DEFECT. The exercise catalog already holds the lift:
// data/exercise_aliases.v1.json resolves 'trap bar deadlift', 'hex bar
// deadlift', 'trap bar dl', 'tbdl', 'trap bar deadlifts' and 'hex bar dl' to
// exercise_id 'trap_bar_deadlift', and data/exercise_catalog.v1.json names it
// 'Trap Bar Deadlift'. But data/parser_aliases.v1.json had NO trap-bar entry
// at all, so the parser could not resolve the name:
//   • standalone, the Soul Corpus log form (Session 9, Ray)
//     'trap bar DL 245 5/3 x3' logged as unknown exercise 'Trap Bar Dl'
//     with needs_catalog_review — the sets parsed, the lift did not;
//   • in a multi-exercise turn the same words were silently logged as plain
//     'Deadlift', because only the inner 'dl' alias matched.
//
// THE FIX IS DATA ONLY. One entry in data/parser_aliases.v1.json (mirrored in
// the frozen parity reference in test/parserAliasParity.test.js, per that
// file's reconcile-in-the-same-change rule). The hyphenated spellings are
// enumerated because the parser's normalizeKey preserves hyphens and this
// table's own convention lists both orthographies ('bent-over row' /
// 'bent over row', 'pull-up' / 'pull up').
//
// SCOPE BOUNDARIES, pinned below rather than left implicit:
//   • Bare 'trap bar' is NOT an alias. It names the implement, not the lift;
//     the catalog does not list it, and corpus prose uses it without logging
//     ('trap bar sits one clean session from 255'). SC15-NADIA-01's
//     'Trap bar 185 5/3 x2' therefore stays unresolved at this seam — that
//     golden keeps failing on its other grounds and its register entry is
//     untouched by this change.
//   • SC9-RAY-01 also keeps failing: bare 'press' ambiguity and the Pull-Up
//     bodyweight path are the other B slices, and plan context is Slice 2.
//     Its known-failures register entry is NOT edited here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkoutText, canonicalizeExerciseName } = require('../services/workoutTextParser');
const { generateLiftCode } = require('../services/exerciseEnrichment');

const FORMS = [
  'trap bar deadlift',
  'trap bar deadlifts',
  'trap-bar deadlift',
  'trap-bar deadlifts',
  'hex bar deadlift',
  'hex-bar deadlift',
  'trap bar dl',
  'trap-bar dl',
  'hex bar dl',
  'hex-bar dl',
  'tbdl',
];

// ── 1. Every justified form resolves to the catalog canonical ───────────────

test('1a. every trap-bar form canonicalizes to Trap Bar Deadlift', () => {
  for (const form of FORMS) {
    const c = canonicalizeExerciseName(form);
    assert.ok(c && c.canonicalName, `"${form}" must canonicalize, got ${JSON.stringify(c)}`);
    assert.equal(c.canonicalName, 'Trap Bar Deadlift', `"${form}" → Trap Bar Deadlift`);
  }
  // Case is normalized by the parser; the corpus writes 'DL' upper-case.
  assert.equal(canonicalizeExerciseName('Trap Bar DL').canonicalName, 'Trap Bar Deadlift');
  assert.equal(canonicalizeExerciseName('TRAP BAR DEADLIFT').canonicalName, 'Trap Bar Deadlift');
});

test('1b. the parser agrees with the exercise catalog on the introduced aliases — no A↔B fork', () => {
  const { runAudit, partitionType1 } = require('../services/exerciseTruthAudit');
  const { anchored } = partitionType1(runAudit().type1);
  const introduced = new Set(FORMS.map((f) => f.replace(/-/g, ' ')));
  const conflicts = anchored.filter((r) => introduced.has(String(r.alias).toLowerCase()));
  assert.deepEqual(conflicts, [],
    `the trap-bar aliases must agree with the catalog: ${JSON.stringify(conflicts)}`);
});

// ── 2. The corpus log form parses as a resolved lift ────────────────────────

test("2a. 'trap bar DL 245 5/3 x3' logs Trap Bar Deadlift, 3 sets of (245, 5, 3), no catalog review", () => {
  const r = parseWorkoutText('trap bar DL 245 5/3 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.exercise, 'Trap Bar Deadlift');
  assert.equal(r.canonical_name, 'Trap Bar Deadlift');
  assert.ok(!r.needs_catalog_review, 'a catalog lift must not be flagged needs_catalog_review');
  assert.ok(!(r.warnings || []).includes('unknown_exercise'), 'the lift must be resolved, not unknown');
  assert.equal(r.sets.length, 3);
  for (const s of r.sets) {
    assert.deepEqual([s.weight, s.reps, s.rir], [245, 5, 3]);
  }
});

test('2b. every other justified form logs identically', () => {
  for (const form of FORMS) {
    const r = parseWorkoutText(`${form} 245 5/3 x3`);
    assert.equal(r.intent, 'log_sets', form);
    assert.equal(r.exercise, 'Trap Bar Deadlift', form);
    assert.ok(!r.needs_catalog_review, form);
    assert.equal(r.sets.length, 3, form);
    for (const s of r.sets) {
      assert.deepEqual([s.weight, s.reps, s.rir], [245, 5, 3], form);
    }
  }
});

test('2c. in a multi-exercise turn the trap-bar segment is Trap Bar Deadlift, not plain Deadlift', () => {
  // At base this logged [Deadlift, Bench Press]: the split matched only the
  // inner 'dl' alias and silently put trap-bar work in conventional history.
  const r = parseWorkoutText('trap bar DL 245 5/3 x3, bench 185 5/2 x3');
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual((r.exercises || []).map((e) => e.canonical_name), ['Trap Bar Deadlift', 'Bench Press']);
});

// ── 3. Near neighbours are unchanged ────────────────────────────────────────

test('3a. plain DL / deadlift forms still resolve to Deadlift — never to Trap Bar Deadlift', () => {
  for (const [input, name] of [['DL 245 5/3 x3', 'Deadlift'], ['deadlift 245 5/3 x3', 'Deadlift'], ['dead 245 5/3 x3', 'Deadlift']]) {
    const r = parseWorkoutText(input);
    assert.equal(r.intent, 'log_sets', input);
    assert.equal(r.exercise, name, input);
    assert.ok(!r.needs_catalog_review, input);
    assert.equal(r.sets.length, 3, input);
  }
  assert.equal(canonicalizeExerciseName('dl').canonicalName, 'Deadlift');
  assert.equal(canonicalizeExerciseName('deadlift').canonicalName, 'Deadlift');
});

test('3b. the rest of the deadlift family is unchanged', () => {
  assert.equal(parseWorkoutText('RDL 185 8/2 x3').exercise, 'RDL');
  assert.equal(parseWorkoutText('romanian deadlift 185 8/2 x3').exercise, 'RDL');
  assert.equal(canonicalizeExerciseName('rdl').canonicalName, 'RDL');
});

test('3c. trap-bar work carries its own lift code, never conventional Deadlift\'s', () => {
  const deadliftCode = generateLiftCode('Deadlift');
  assert.equal(deadliftCode, 'DL01', 'pre-existing conventional Deadlift code');
  for (const form of FORMS) {
    const c = canonicalizeExerciseName(form);
    const code = generateLiftCode((c && c.canonicalName) || form);
    assert.equal(code, generateLiftCode('Trap Bar Deadlift'), `${form} must share the Trap Bar Deadlift code`);
    assert.notEqual(code, deadliftCode, `${form} must not inherit DL01 — that is another lift's history`);
  }
});

// ── 4. The deliberate non-alias: bare 'trap bar' ────────────────────────────

test("4. bare 'trap bar' stays unresolved — the implement alone does not start the lift", () => {
  const c = canonicalizeExerciseName('trap bar');
  assert.ok(!c || !c.canonicalName, `bare 'trap bar' must not canonicalize, got ${JSON.stringify(c)}`);
  const r = parseWorkoutText('Trap bar 185 5/3 x2');
  assert.ok(r.needs_catalog_review || (r.warnings || []).includes('unknown_exercise'),
    "SC15-NADIA-01's bare 'Trap bar …' log stays unresolved at this seam, exactly as at base");
  assert.notEqual(r.exercise, 'Trap Bar Deadlift');
});
