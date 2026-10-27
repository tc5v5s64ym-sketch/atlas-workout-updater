'use strict';

// PARSE-6 — AMBIGUOUS_ALIASES only fired at start-of-text. A bare ambiguous
// word ("rows", "press") appearing MID-text never returned the
// { ambiguous: true } "which…?" result: the input fell through to a generic
// missing-exercise ask, or — when the word carried its own sets — to a bogus
// unknown-exercise row ("today rows 95 10/2" logged an exercise called
// "Rows").
//
// The fix lives in findExerciseInText: when NO canonical alias matches
// anywhere in the text, a bare ambiguous token with no digit before it
// returns the ambiguous result. Reaching that point means the word is not
// part of a resolved lift name ("bench press", "seated rows") and no first
// exercise owns the text, so the second-exercise refuse-to-merge guard (G1,
// BUG-20260629) is untouched — its shape (a resolved lift + trailing sets)
// resolves in the alias scan and never reaches the new check.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkoutText, canonicalizeExerciseName } = require('../services/workoutTextParser');

test('PARSE-6: a bare ambiguous alias mid-text returns the which-row ask (resolver level)', () => {
  const hit = canonicalizeExerciseName('did rows today');
  assert.ok(hit && hit.ambiguous === true, `expected ambiguous result, got ${JSON.stringify(hit)}`);
  assert.equal(hit.rawName, 'rows');
  assert.match(hit.message, /Which row/);
});

test('PARSE-6: a bare ambiguous alias mid-text returns the which-press ask (resolver level)', () => {
  const hit = canonicalizeExerciseName('did press today');
  assert.ok(hit && hit.ambiguous === true, `expected ambiguous result, got ${JSON.stringify(hit)}`);
  assert.equal(hit.rawName, 'press');
  assert.match(hit.message, /Which press/);
});

test('PARSE-6: mid-text ambiguous alias surfaces the specific ask end-to-end, not the generic one', () => {
  const result = parseWorkoutText('finished with rows', {});
  assert.equal(result.intent, 'needs_clarification');
  assert.ok((result.warnings || []).includes('ambiguous_exercise_alias'),
    `expected ambiguous_exercise_alias warning, got ${JSON.stringify(result.warnings)}`);
  assert.match(result.message, /Which row/);
});

test('PARSE-6: an ambiguous alias carrying its own sets mid-text asks instead of logging a bogus unknown exercise', () => {
  const result = parseWorkoutText('today rows 95 10/2', {});
  assert.equal(result.intent, 'needs_clarification',
    `expected needs_clarification, got ${result.intent} (${JSON.stringify(result)})`);
  assert.ok((result.warnings || []).includes('ambiguous_exercise_alias'),
    `expected ambiguous_exercise_alias warning, got ${JSON.stringify(result.warnings)}`);
  assert.match(result.message, /Which row/);
});

test('PARSE-6: start-of-text ambiguous behaviour is unchanged', () => {
  const hit = canonicalizeExerciseName('rows 95 10/2');
  assert.ok(hit && hit.ambiguous === true);
  const result = parseWorkoutText('rows 95 10/2', {});
  assert.equal(result.intent, 'needs_clarification');
  assert.ok((result.warnings || []).includes('ambiguous_exercise_alias'));
});

test('PARSE-6: canonical names containing an ambiguous word still resolve (no false ask)', () => {
  for (const [text, canonical] of [
    ['bench press 225 5/5', 'Bench Press'],
    ['leg press 300 10/2', 'Leg Press'],
    ['barbell row 135 8/2', 'Bent-Over Row'],
    ['overhead press 95 5/2', 'Overhead Press'],
    ['seated rows 120 10/2', 'Seated Row'],
  ]) {
    const result = parseWorkoutText(text, {});
    assert.equal(result.intent, 'log_sets', `${text} should log, got ${result.intent}`);
    assert.equal(result.exercise, canonical, `${text} should resolve to ${canonical}`);
  }
});

test('PARSE-6: the second-exercise refuse-to-merge guard is unchanged (no double-ask, no absorb)', () => {
  const result = parseWorkoutText('bench 135 8/2 rows 95 10/2', {});
  assert.equal(result.intent, 'needs_clarification');
  assert.ok((result.warnings || []).includes('unattributable_trailing_sets'),
    `expected unattributable_trailing_sets, got ${JSON.stringify(result.warnings)}`);
  assert.ok(!(result.warnings || []).includes('ambiguous_exercise_alias'),
    'the G1 shape must not be re-asked as a bare ambiguous alias');
});

test('PARSE-6: an ambiguous word that tails an unknown lift NAME does not fire the ask', () => {
  // "Andover Press" / "Zzqx Press" are typed exercise names (catalog-review
  // path), not bare "press" references — the word is preceded by a name-like
  // token, so the unknown-exercise echo owns them (parser-golden / fuzz pins).
  const hit = canonicalizeExerciseName('andover press 95 8/2');
  assert.ok(!hit || hit.ambiguous !== true, `expected no ambiguous result, got ${JSON.stringify(hit)}`);
  const result = parseWorkoutText('andover press 95 8/2', {});
  assert.equal(result.canonical_name, 'Andover Press');
  assert.ok((result.warnings || []).includes('unknown_exercise'));
});

test('PARSE-6: an ambiguous word trailing another exercise\'s set-group does not fire the mid-text ask', () => {
  // Digits before the word: it trails numbers, so the existing paths own it.
  const hit = canonicalizeExerciseName('bench 135 8/2 rows');
  assert.ok(!hit || hit.ambiguous !== true,
    `expected no ambiguous result, got ${JSON.stringify(hit)}`);
});

test('PARSE-6: the digit guard alone suppresses the ask behind an UNRESOLVED set-group', () => {
  // No canonical alias resolves anywhere here, so neither the alias scan nor
  // the name-like-preceding-token guard can be what suppresses the ask — the
  // preceding token is a number. Only the digit guard stands between this
  // input and a mid-text ambiguous result.
  for (const text of ['xyz 95 10/2 rows', 'xyz 95 10/2 press']) {
    const hit = canonicalizeExerciseName(text);
    assert.ok(!hit || hit.ambiguous !== true,
      `${text}: expected no ambiguous result, got ${JSON.stringify(hit)}`);
  }
});
