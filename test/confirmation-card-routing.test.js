/**
 * Confirmation card routing regression tests — PR 358b.
 *
 * Root cause of the original failure
 * -----------------------------------
 * The "Deadlift / Rows produced no confirmation card" report was investigated
 * by tracing every code path from the submit handler through to buildReadback.
 *
 * Finding: the structural guarantee that every successfully parsed mid-session
 * log routes to a confirmation card was ALREADY in place before PR 358b.
 * The mid-session branch in app.js submit handler is:
 *
 *   if (logRows.length && !file && !manualEffort && !sessionCompiledAwaitingPreview) {
 *     emitSetLogged(logRows, ...);
 *     return;                          ← hard return; preview/write unreachable
 *   }
 *
 * emitSetLogged dispatches atlas:set-logged with a byExercise array.
 * handleSetLogged (coach-conversation.js) iterates ALL exercises unconditionally:
 *
 *   for (const ex of exercises) {
 *     bubble.insertBefore(buildReadback(ex.exercise, ex.sets, ...), body);
 *   }
 *
 * There is no exercise-specific conditional that would skip Deadlift or Rows.
 *
 * The original failures were most likely a TEST/DOCUMENTATION GAP, not a code
 * defect. These tests close that gap at the nearest testable boundary:
 *
 *   parseWorkoutText(input).intent === 'log_sets'
 *     → logRows populated
 *       → emitSetLogged fires
 *         → atlas:set-logged dispatched
 *           → buildReadback called for every exercise
 *
 * Why "Rows" as bare input produces no card (CORRECT behavior)
 * -------------------------------------------------------------
 * "rows" and "row" are AMBIGUOUS_ALIASES — the parser cannot decide between
 * Seated Row, Bent-Over Row, Cable Row, etc. It returns needs_clarification,
 * which routes to the coach rather than emitSetLogged. No confirmation card
 * is the CORRECT outcome for ambiguous input; the user must specify the variant.
 * Use "Barbell Row", "Bent-Over Row", "Seated Row", or "Cable Row" instead.
 *
 * Run: npm test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkoutText } = require('../services/workoutTextParser');

// ---------------------------------------------------------------------------
// Structural guarantee helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a parse result is log_sets with at least one set.
 * This is the necessary condition for the confirmation card to render:
 * log_sets → logRows populated → emitSetLogged → atlas:set-logged → buildReadback.
 */
function assertRoutesToCard(result, label) {
  assert.equal(
    result.intent, 'log_sets',
    `${label}: expected log_sets (card-eligible), got ${result.intent}: ${result.message || ''}`
  );
  assert.ok(
    Array.isArray(result.sets) && result.sets.length > 0,
    `${label}: expected non-empty sets array`
  );
  assert.ok(
    result.sets.every(s => Number.isFinite(s.reps) && s.reps > 0),
    `${label}: every set must have valid reps`
  );
}

// ---------------------------------------------------------------------------
// Original failure: Deadlift
// ---------------------------------------------------------------------------

test('card-routing: Deadlift 315 5/2 → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Deadlift 315 5/2');
  assertRoutesToCard(result, 'Deadlift 315 5/2');
  assert.equal(result.canonical_name, 'Deadlift');
  assert.deepEqual(
    result.sets.map(s => [s.weight, s.reps, s.rir]),
    [[315, 5, 2]]
  );
});

test('card-routing: Deadlift multiple sets → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Deadlift 315 5/2 5/1 345 3/1');
  assertRoutesToCard(result, 'Deadlift multiple sets');
  assert.equal(result.canonical_name, 'Deadlift');
  assert.equal(result.sets.length, 3);
});

// ---------------------------------------------------------------------------
// Original failure: Rows
// ---------------------------------------------------------------------------

test('card-routing: "rows" bare is ambiguous → needs_clarification (correct: no card)', () => {
  // "rows" without a variant qualifier cannot resolve unambiguously.
  // needs_clarification routes to the coach; no confirmation card is CORRECT.
  // The user must enter a specific variant (see test below).
  const result = parseWorkoutText('rows 135 8/1');
  assert.equal(result.intent, 'needs_clarification', '"rows" must stay ambiguous');
  assert.ok(result.warnings.includes('ambiguous_exercise_alias'));
  assert.match(result.message, /which row/i);
});

test('card-routing: Bent-Over Row 135 8/1 x3 → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Bent-Over Row 135 8/1 x3');
  assertRoutesToCard(result, 'Bent-Over Row');
  assert.equal(result.canonical_name, 'Bent-Over Row');
  assert.equal(result.sets.length, 3);
});

test('card-routing: Seated Row 135 8/1 x3 → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Seated Row 135 8/1 x3');
  assertRoutesToCard(result, 'Seated Row');
  assert.equal(result.canonical_name, 'Seated Row');
  assert.equal(result.sets.length, 3);
});

test('card-routing: Barbell Row 135 8/1 → log_sets with unknown_exercise → confirmation card path', () => {
  // "Barbell Row" is not in EXERCISE_ALIASES. The parser flags it as unknown
  // but still returns log_sets — it is card-eligible. The enrichment pipeline
  // downstream maps it to a planned exercise ("Rows") via lift_code.
  const result = parseWorkoutText('Barbell Row 135 8/1');
  assertRoutesToCard(result, 'Barbell Row');
  assert.ok(
    result.warnings.includes('unknown_exercise'),
    'Barbell Row is unknown — must flag for catalog review'
  );
  assert.equal(result.needs_catalog_review, true);
  assert.equal(result.sets.length, 1);
  assert.deepEqual(result.sets.map(s => [s.weight, s.reps, s.rir]), [[135, 8, 1]]);
});

// ---------------------------------------------------------------------------
// Original failure: Lat Pulldown
// ---------------------------------------------------------------------------

test('card-routing: Lat Pulldown 170 8/2 x3 → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Lat Pulldown 170 8/2 x3');
  assertRoutesToCard(result, 'Lat Pulldown');
  assert.equal(result.canonical_name, 'Lat Pulldown');
  assert.equal(result.sets.length, 3);
  assert.deepEqual(
    result.sets.map(s => [s.weight, s.reps, s.rir]),
    [[170, 8, 2], [170, 8, 2], [170, 8, 2]]
  );
});

// ---------------------------------------------------------------------------
// Original failure: Lateral Raise
// ---------------------------------------------------------------------------

test('card-routing: Lateral Raise 30 15/2 x3 → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Lateral Raise 30 15/2 x3');
  assertRoutesToCard(result, 'Lateral Raise');
  assert.equal(result.canonical_name, 'Lateral Raises');
  assert.equal(result.sets.length, 3);
  assert.deepEqual(
    result.sets.map(s => [s.weight, s.reps, s.rir]),
    [[30, 15, 2], [30, 15, 2], [30, 15, 2]]
  );
});

test('card-routing: Laterals 25 15/2 x3 → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Laterals 25 15/2 x3');
  assertRoutesToCard(result, 'Laterals');
  assert.equal(result.canonical_name, 'Lateral Raises');
  assert.equal(result.sets.length, 3);
});

// ---------------------------------------------------------------------------
// Bench (control case — always worked)
// ---------------------------------------------------------------------------

test('card-routing: Bench 225 5/2 → log_sets → confirmation card path', () => {
  const result = parseWorkoutText('Bench 225 5/2');
  assertRoutesToCard(result, 'Bench 225 5/2');
  assert.equal(result.canonical_name, 'Bench Press');
  assert.deepEqual(result.sets.map(s => [s.weight, s.reps, s.rir]), [[225, 5, 2]]);
});

// ---------------------------------------------------------------------------
// Early-exit guards don't intercept workout text
// ---------------------------------------------------------------------------

test('card-routing: looksLikeSessionRequest rejects text with digits — workout text is safe', () => {
  // looksLikeSessionRequest requires specific question phrases AND rejects any
  // input containing digits. Since all workout logging text contains weights,
  // it can never match — workout text always bypasses this early exit.
  //
  // This test verifies the parser-level contract; the guard itself lives in
  // public/app.js (browser-only, not testable here) but the key invariant is:
  //   digits in input → looksLikeSessionRequest = false → routing continues
  //
  // We verify via the parser: digits-containing workout text → log_sets.
  const exercisesWithWeights = [
    ['Deadlift 315 5/2', 'Deadlift'],
    ['Bench 225 5/2', 'Bench Press'],
    ['Lat Pulldown 170 8/2 x3', 'Lat Pulldown'],
    ['Lateral Raise 30 15/2 x3', 'Lateral Raises'],
    ['Bent-Over Row 135 8/1', 'Bent-Over Row'],
  ];
  for (const [input, canonical] of exercisesWithWeights) {
    const result = parseWorkoutText(input);
    assert.equal(result.intent, 'log_sets', `${input} must parse as log_sets`);
    assert.equal(result.canonical_name, canonical, `${input} must resolve to ${canonical}`);
  }
});

// ---------------------------------------------------------------------------
// Mixed multi-exercise: parser signals clarification (no silent split)
// ---------------------------------------------------------------------------

test('card-routing: mixed exercises in single input split into per-exercise results (no row mixing)', () => {
  // Mixed-exercise input is split on the recognized names and parsed per exercise,
  // so each lift keeps its own sets (no silent row mixing) and the client renders
  // one combined confirm card from all of them.
  const result = parseWorkoutText('Deadlift 315 5/2 Bench 225 5/2');
  assert.equal(result.intent, 'log_sets_multi');
  assert.deepEqual(result.exercises.map(e => e.canonical_name), ['Deadlift', 'Bench Press']);
  assert.deepEqual(result.exercises[0].sets.map(s => [s.weight, s.reps, s.rir]), [[315, 5, 2]]);
  assert.deepEqual(result.exercises[1].sets.map(s => [s.weight, s.reps, s.rir]), [[225, 5, 2]]);
});

// ---------------------------------------------------------------------------
// Structural invariant: every log_sets result has non-empty sets
// ---------------------------------------------------------------------------

test('card-routing: all confirmation-card exercises produce ≥1 valid set', () => {
  // Belt-and-suspenders: a log_sets result with empty sets[] would populate
  // byExercise with an empty sets array, making buildReadback render a blank
  // card. Verify no such edge case exists for the named exercises.
  const inputs = [
    'Deadlift 315 5/2',
    'Bench 225 5/2',
    'Lat Pulldown 170 8/2 x3',
    'Lateral Raise 30 15/2 x3',
    'Bent-Over Row 135 8/1 x3',
    'Seated Row 120 10/2 x3',
  ];
  for (const input of inputs) {
    const result = parseWorkoutText(input);
    assert.equal(result.intent, 'log_sets', input);
    assert.ok(result.sets.length >= 1, `${input}: must produce ≥1 set`);
    for (const s of result.sets) {
      assert.ok(Number.isFinite(s.reps) && s.reps > 0, `${input}: reps must be valid`);
      assert.ok(s.weight == null || Number.isFinite(s.weight), `${input}: weight must be null or a number`);
    }
  }
});
