'use strict';

// F10S6 (b)+(c) — the two NL grammar gaps from the July 18 owner smoke test
// (docs/ATLAS_V1_EXECUTION_PLAN.md, owner insertion 2026-07-18). Red-first.
//
//  (b) "Romanian Deadlift 245 x 6 @3" must log — WEIGHT x REPS [@ RIR]. The surface
//      syntax collides with the EXISTING sets-first claim ("3 x 8 @ 135" = 3 sets of
//      8 @ 135 lb), so the new reading engages ONLY where sets-first rejects (first
//      number > 10 → it is a load, not a set count) and only for a plausible RIR
//      (≤ 6); anything else still refuses to a clarification — never a guess.
//  (c) "Front Squat 185 7/2 x3 instead of Back Squat" must log AND carry the
//      substitution directive in one turn (`substitution.for`), instead of dying as
//      unattributable_trailing_sets. This is F10S2's entry path — the client binds
//      the directive to the original slot (the F10S2 PR).
//
// The protected `225 5/2` contract is untouched (guarded again here alongside the
// golden suite).

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkoutText } = require('../services/workoutTextParser');

const sets = (r) => {
  assert.equal(r.intent, 'log_sets', `expected log_sets, got ${r.intent} (${r.message || ''})`);
  return r.sets.map(s => [s.weight, s.reps, s.rir]);
};

// ── (b) weight x reps [@ rir] ───────────────────────────────────────────────────

test('SMOKE (b): "Romanian Deadlift 245 x 6 @3" logs one set 245×6 @ RIR 3', () => {
  const r = parseWorkoutText('Romanian Deadlift 245 x 6 @3');
  assert.deepEqual(sets(r), [[245, 6, 3]]);
  assert.equal(r.exercise, 'RDL');
});

test('(b) bare "245 x 6" logs one set with no RIR (never a fabricated 0)', () => {
  const r = parseWorkoutText('Romanian Deadlift 245 x 6');
  assert.deepEqual(sets(r), [[245, 6, null]]);
});

test('(b) spacing/casing variants parse the same', () => {
  assert.deepEqual(sets(parseWorkoutText('RDL 245x6 @3')), [[245, 6, 3]]);
  assert.deepEqual(sets(parseWorkoutText('Overhead Press 95 X 8 @ 3')), [[95, 8, 3]]);
});

test('(b) the EXISTING sets-first claim is untouched: "3 x 8 @ 135" is 3 sets of 8 @ 135 lb', () => {
  assert.deepEqual(sets(parseWorkoutText('Bench Press 3 x 8 @ 135')), [[135, 8, null], [135, 8, null], [135, 8, null]]);
});

test('(b) the EXISTING W x R x S claim is untouched: "225 x 5 x 3" is 3 sets of 225×5', () => {
  assert.deepEqual(sets(parseWorkoutText('Bench Press 225 x 5 x 3')), [[225, 5, null], [225, 5, null], [225, 5, null]]);
});

test('(b) an implausible RIR (>6) refuses to a clarification — never guessed as RIR or weight', () => {
  const r = parseWorkoutText('Bench Press 245 x 6 @ 135');
  assert.equal(r.intent, 'needs_clarification');
});

test('(b) a trailing set-multiplier after @rir is NOT silently truncated to one set', () => {
  // "225 x 5 @2 x3" (3 sets intended) must not log a single set — it stays a
  // clarification until that compound form is deliberately added to the grammar.
  const r = parseWorkoutText('Bench Press 225 x 5 @2 x3');
  assert.equal(r.intent, 'needs_clarification');
});

test('(b) MULTIPLE W x R [@rir] groups all log — never a silent partial claim (Codex P1)', () => {
  assert.deepEqual(sets(parseWorkoutText('Bench Press 245 x 6 @3 225 x 5 @2')), [[245, 6, 3], [225, 5, 2]]);
  assert.deepEqual(sets(parseWorkoutText('Bench Press 225 x 5 225 x 5')), [[225, 5, null], [225, 5, null]]);
});

test('(b) a group plus unclaimable residue refuses — sets are never partially dropped', () => {
  const r = parseWorkoutText('Bench Press 245 x 6 @3 plus some more');
  assert.notEqual(r.intent, 'log_sets', 'residue after the group → clarification, not a partial log');
});

// ── (c) the one-turn "instead of" substitution clause ───────────────────────────

test('SMOKE (c): "Front Squat 185 7/2 x3 instead of Back Squat" logs 3 sets AND carries the substitution', () => {
  const r = parseWorkoutText('Front Squat 185 7/2 x3 instead of Back Squat');
  assert.deepEqual(sets(r), [[185, 7, 2], [185, 7, 2], [185, 7, 2]]);
  assert.equal(r.raw_name, 'Front Squat');
  assert.deepEqual(r.substitution, { for: 'Back Squat' }, 'the replaced (planned) exercise rides on the result');
  assert.equal(r.raw_text.includes('instead of Back Squat'), true, 'raw_text keeps what the lifter typed');
});

test('(c) the clause composes with other set grammars ("instead of" + slash notation)', () => {
  const r = parseWorkoutText('Leg Press 400 10/2 instead of Back Squat');
  assert.deepEqual(sets(r), [[400, 10, 2]]);
  assert.deepEqual(r.substitution, { for: 'Back Squat' });
});

test('(c) an unparseable remainder keeps the ORIGINAL full-text behavior (no half-applied strip)', () => {
  const r = parseWorkoutText('Front Squat instead of Back Squat');
  assert.notEqual(r.intent, 'log_sets', 'no sets → not silently logged');
  assert.equal(r.substitution, undefined, 'no directive without a clean log');
});

test('(c) a normal log with no clause carries NO substitution field', () => {
  const r = parseWorkoutText('Bench Press 225 5/2');
  assert.equal(r.substitution, undefined);
});

// ── the protected contract stays frozen ─────────────────────────────────────────

test('the `225 5/2` slash contract is byte-for-byte unchanged', () => {
  const r = parseWorkoutText('Bench Press 225 5/2');
  assert.deepEqual(sets(r), [[225, 5, 2]]);
});
