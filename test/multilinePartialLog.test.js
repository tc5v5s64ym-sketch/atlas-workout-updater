const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkoutText } = require('../services/workoutTextParser');

// Multi-line partial-log (owner decision 2026-07-02) — the 07-02 live lost-sets bug
// (IMG_5441/5442): a paste with one exercise per line in slash notation dead-ended
// on the generic multi-exercise ask, fell to the coach LLM (which read it back
// fluently while buffering NOTHING), and "log it" then found no sets. Contract now:
// when the collapsed whole-text parse dead-ends on a multi-exercise blob, the parser
// re-parses per line — resolved lines log as log_sets_multi, unresolved lines are
// returned in `unresolved` with each line's own SPECIFIC ask. One ambiguous lift
// never discards its clean siblings, and set notation never sinks into chat.

const names = r => r.exercises.map(e => e.canonical_name);
const setsOf = (r, name) => r.exercises.find(e => e.canonical_name === name).sets;

test('owner live repro 07-02: five-exercise slash paste partial-logs 4, asks about Rows', () => {
  const r = parseWorkoutText(
    'Bench 135 10/5 185 8/2\nRows 150 10/2 ×3\nDips 10/2 ×3\nBicep curls 30 12/2 ×3\nKR 15/2 ×3', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press', 'Dips', 'Bicep Curl', 'Hanging Knee Raises']);
  // Multi-set line and ×N repeats both resolve with correct numbers.
  assert.deepEqual(setsOf(r, 'Bench Press').map(s => [s.weight, s.reps, s.rir]),
    [[135, 10, 5], [185, 8, 2]]);
  assert.equal(setsOf(r, 'Dips').length, 3);
  assert.equal(setsOf(r, 'Hanging Knee Raises').length, 3);
  // The ambiguous line surfaces its own specific ask — never the generic copy,
  // never silently dropped.
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].line, /^Rows 150/);
  assert.match(r.unresolved[0].message, /which row/i);
  assert.ok(r.warnings.includes('unresolved_lines'));
});

test('unicode ×N and ascii xN parse identically', () => {
  const uni = parseWorkoutText('Bench 135 10/2 ×3\nDips 10/2 ×3', {});
  const ascii = parseWorkoutText('Bench 135 10/2 x3\nDips 10/2 x3', {});
  assert.equal(uni.intent, 'log_sets_multi');
  assert.deepEqual(names(uni), names(ascii));
  assert.equal(setsOf(uni, 'Bench Press').length, 3);
});

test('expanded one-set-per-line paste merges repeated lines into one entry per exercise', () => {
  const r = parseWorkoutText(
    'Bench Press 135 10/5 185 8/2\nRows 150 10/2\nRows 150 10/2\nRows 150 10/2\n' +
    'Dips 10/2\nDips 10/2\nDips 10/2\nKR 15/2\nKR 15/2\nKR 15/2', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press', 'Dips', 'Hanging Knee Raises']);
  assert.equal(setsOf(r, 'Dips').length, 3, 'three Dips lines merge into one 3-set entry');
  assert.equal(setsOf(r, 'Hanging Knee Raises').length, 3);
  assert.equal(r.unresolved.length, 3, 'each unresolved Rows line is reported');
  assert.ok(r.unresolved.every(u => /which row/i.test(u.message)));
});

test('two-line paste with one ambiguous name partial-logs the clean line', () => {
  const r = parseWorkoutText('Bench 135 10/5\nRows 150 10/2 x3', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press']);
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].message, /which row/i);
});

test('all-clean multi-line paste returns plain log_sets_multi with no unresolved key', () => {
  const r = parseWorkoutText('Bench 135 10/5\nDips 10/2 x3', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press', 'Dips']);
  assert.equal(r.unresolved, undefined);
  assert.ok(!r.warnings.includes('unresolved_lines'));
});

test('a bare-name header line sets context for following bare set lines', () => {
  const r = parseWorkoutText('Bench 135 10/5\nDips\n10/2 x3', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press', 'Dips']);
  assert.equal(setsOf(r, 'Dips').length, 3);
  assert.equal(r.unresolved, undefined);
});

test('a header whose sets never arrive is surfaced unresolved, not silently dropped', () => {
  const r = parseWorkoutText('Bench 135 10/5\nDips 10/2 x3\nDeadlift', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press', 'Dips']);
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].message, /could not find sets for deadlift/i);
});

test('an unknown-but-parseable lift still partial-logs with its unknown_exercise warning', () => {
  const r = parseWorkoutText('Bench 135 10/5\nCurls 35 15/2 x3', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press', 'Curls']);
  const curls = r.exercises.find(e => e.canonical_name === 'Curls');
  assert.ok((curls.warnings || []).includes('unknown_exercise'));
});

// --- Guardrails: currently-succeeding and deliberately-blocked paths are unchanged ---

test('single-exercise multi-line input stays on the whole-text path (no behavior change)', () => {
  const r = parseWorkoutText('Bench Press 135 10/5\n185 8/2', {});
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Bench Press');
  assert.equal(r.sets.length, 2);
  assert.equal(r.unresolved, undefined);
});

test('same-line inline stacking keeps the G1 refuse-to-merge guardrail (no partial-log inline)', () => {
  const r = parseWorkoutText('Weighted Dips 50 11/1 x3 Dumbbell Side Bend 70 15/1 x3', {});
  assert.equal(r.intent, 'needs_clarification');
  assert.ok((r.warnings || []).includes('unattributable_trailing_sets'));
});

test('a G1-stacked LINE inside a multi-line paste is unresolved for that line only', () => {
  const r = parseWorkoutText('Bench 135 10/5\nWeighted Dips 50 11/1 x3 Dumbbell Side Bend 70 15/1 x3', {});
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(names(r), ['Bench Press']);
  assert.equal(r.unresolved.length, 1);
  assert.ok(r.unresolved[0].warnings.includes('unattributable_trailing_sets'));
});
