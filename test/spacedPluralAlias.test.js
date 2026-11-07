'use strict';

// Spaced-plural parser-alias gap — issue #1621 (lane 3).
//
// THE DEFECT. `pull ups` and `chin ups` (spaced plurals) had no entry in
// data/parser_aliases.v1.json, so they logged through the unknown-exercise
// path as 'Pull Ups' / 'Chin Ups' with unknown_exercise set, at both base and
// head of PR #1619 — a pre-existing alias-data gap, deliberately left out of
// that PR's scope (reported by the PR #1619 builder, confirmed by its
// independent review, comment 6508564479 item 2).
//
// THE FIX IS DATA ONLY. One alias each in data/parser_aliases.v1.json
// (mirrored in the frozen parity reference in test/parserAliasParity.test.js,
// per that file's reconcile-in-the-same-change rule), following the PR #1618
// pattern. The catalog already resolves both forms (data/exercise_aliases
// .v1.json: 'pull ups' → pull_up, 'chin ups' → chin_up, alias_type
// pluralization, confidence 1), so the truth audit has a source and no
// taxonomy forks.
//
// SCOPE BOUNDARIES, pinned below rather than left implicit:
//   • Only the two forms in this issue's scope are added. The same-pass
//     sibling scan found other spaced-plural forms that still log unknown
//     (see the PR body for the full list — e.g. 'back squats', 'hamstring
//     curls', 'knee extensions', 'barbell hip thrusts', 'lat pulldowns',
//     'reverse rows', 'hex bar deadlifts'); they are NOT fixed here and one
//     representative ('back squats') is pinned as still unresolved so the
//     boundary is explicit, not accidental.
//   • 'lat pull downs' / 'incline benches' are NOT unknown-exercise gaps:
//     they hit the ambiguous-alias clarification path (contextual 'lat pull' /
//     'incline'), so they are listed separately in the PR body.
//   • The BW-prefix xN issue on the older bodyweight paths is #1620, not
//     this PR: Pull-Up / Chin-Up already strip BW locally (PR #1619), so the
//     BW log forms below pin 3 sets here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkoutText, canonicalizeExerciseName } = require('../services/workoutTextParser');

// ── 1. Both spaced plurals resolve to their canonicals ───────────────────────

test("1a. 'pull ups' canonicalizes to Pull-Up and 'chin ups' to Chin-Up", () => {
  assert.equal(canonicalizeExerciseName('pull ups').canonicalName, 'Pull-Up');
  assert.equal(canonicalizeExerciseName('chin ups').canonicalName, 'Chin-Up');
  // Case is normalized by the parser.
  assert.equal(canonicalizeExerciseName('Pull Ups').canonicalName, 'Pull-Up');
  assert.equal(canonicalizeExerciseName('CHIN UPS').canonicalName, 'Chin-Up');
});

test('1b. the parser agrees with the exercise catalog on the introduced aliases — no A↔B fork', () => {
  const { runAudit, partitionType1 } = require('../services/exerciseTruthAudit');
  const { anchored } = partitionType1(runAudit().type1);
  const introduced = new Set(['pull ups', 'chin ups']);
  const conflicts = anchored.filter((r) => introduced.has(String(r.alias).toLowerCase()));
  assert.deepEqual(conflicts, [],
    `the spaced-plural aliases must agree with the catalog: ${JSON.stringify(conflicts)}`);
});

// ── 2. The log forms parse as resolved lifts ─────────────────────────────────

test("2a. 'pull ups BW 10/2 x3' logs Pull-Up, 3 sets of (BW, 10, 2), no catalog review", () => {
  const r = parseWorkoutText('pull ups BW 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.exercise, 'Pull-Up');
  assert.equal(r.canonical_name, 'Pull-Up');
  assert.ok(!r.needs_catalog_review, 'a catalog lift must not be flagged needs_catalog_review');
  assert.ok(!(r.warnings || []).includes('unknown_exercise'), 'the lift must be resolved, not unknown');
  assert.equal(r.sets.length, 3);
});

test("2b. 'chin ups BW 10/2 x3' logs Chin-Up identically", () => {
  const r = parseWorkoutText('chin ups BW 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.exercise, 'Chin-Up');
  assert.equal(r.canonical_name, 'Chin-Up');
  assert.ok(!r.needs_catalog_review, 'a catalog lift must not be flagged needs_catalog_review');
  assert.ok(!(r.warnings || []).includes('unknown_exercise'), 'the lift must be resolved, not unknown');
  assert.equal(r.sets.length, 3);
});

test('2c. the unweighted forms log identically', () => {
  for (const [input, name] of [['pull ups 10/2 x3', 'Pull-Up'], ['chin ups 10/2 x3', 'Chin-Up']]) {
    const r = parseWorkoutText(input);
    assert.equal(r.intent, 'log_sets', input);
    assert.equal(r.exercise, name, input);
    assert.ok(!r.needs_catalog_review, input);
    assert.equal(r.sets.length, 3, input);
  }
});

test('2d. in a multi-exercise turn the spaced-plural segment is its own lift', () => {
  // At base this logged [unknown 'Pull Ups Bw', Bench Press]: the split matched
  // no alias for the pull-up segment and it went unknown.
  const r = parseWorkoutText('pull ups BW 10/2 x3, bench 185 5/2 x3');
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual((r.exercises || []).map((e) => e.canonical_name), ['Pull-Up', 'Bench Press']);
});

// ── 3. Near neighbours are unchanged ─────────────────────────────────────────

test('3a. every other pull-up / chin-up spelling still resolves to the same canonical', () => {
  for (const [form, name] of [
    ['pull-up', 'Pull-Up'], ['pull up', 'Pull-Up'], ['pullup', 'Pull-Up'],
    ['pullups', 'Pull-Up'], ['pull-ups', 'Pull-Up'],
    ['chin-up', 'Chin-Up'], ['chin up', 'Chin-Up'], ['chinup', 'Chin-Up'],
    ['chinups', 'Chin-Up'], ['chin-ups', 'Chin-Up'],
  ]) {
    assert.equal(canonicalizeExerciseName(form).canonicalName, name, form);
  }
  // The other spaced plural in the table is untouched.
  assert.equal(canonicalizeExerciseName('push ups').canonicalName, 'Push-Up');
  assert.equal(parseWorkoutText('push ups BW 10/2 x3').exercise, 'Push-Up');
});

// ── 4. The deliberate non-fix: sibling spaced plurals stay unresolved ───────

test("4. 'back squats' stays unresolved at the log seam — a sibling gap, listed in the PR body, not fixed here", () => {
  // Note the nuance, pinned here so a later fix does not silently change it:
  // canonicalizeExerciseName('back squats') alone returns a PARTIAL match
  // ({canonicalName: 'Back Squat', rawName: 'squats', rest: 'back'}), yet the
  // full log line still goes unknown. (Do not generalize this into a seam
  // rule: 'bench presses' logs clean as Bench Press despite a partial match
  // with rest 'presses' — the leftover there is a bare plural suffix, not a
  // whole word. The pin is this case only.)
  const r = parseWorkoutText('back squats 185 5/3 x3');
  assert.ok(r.needs_catalog_review || (r.warnings || []).includes('unknown_exercise'),
    "'back squats …' stays on the unknown-exercise path at this seam, exactly as at base");
  assert.notEqual(r.exercise, 'Back Squat');
});
