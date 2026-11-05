const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkoutText } = require('../services/workoutTextParser');

// G1 (#1565), ruled 2026-11-04: the structural boundary fix. The refuse-to-merge
// guard (hasUnattributableTrailingSets) detects a stacked second exercise by its
// SHAPE — a name-like word run between two set-groups — with no alias-catalog
// dependency. But its set-token recognizer (looksLikeSetToken) knew only bare,
// slash, and xN tokens, so the compact weight-x-reps notation escaped it: the
// second lift's sets were silently dropped, or (weight x reps x count) hijacked
// the whole entry under the first lift while the real sets vanished. This suite
// pins the compact notation closed on both sides of the boundary (trailing and
// leading), plus the guard's clarification copy, which must never claim a log
// that did not happen. Splitting a stacked entry into two logged exercises is
// still a separate follow-up (see the pinned stance in parserStackedBoundary):
// this fix makes the boundary DETECTION notation-complete and keeps refuse as
// the outcome for an unrecognized second lift.

function expectRefusal(result, label) {
  assert.notEqual(result.intent, 'log_sets', `${label}: must not log a single merged exercise`);
  assert.notEqual(result.intent, 'log_sets_multi', `${label}: refuse, do not split`);
  assert.equal(result.intent, 'needs_clarification', `${label}: must ask, got ${result.intent}`);
  assert.ok((result.warnings || []).includes('unattributable_trailing_sets'),
    `${label}: expected the refuse-to-merge warning, got [${(result.warnings || []).join(', ')}]`);
  assert.ok(!(result.sets || []).length, `${label}: a refusal must carry no sets`);
}

// --- trailing compact forms: the G1 repro cases ---

test('G1 structural: compact trailing set is refused, not silently dropped', () => {
  expectRefusal(
    parseWorkoutText('Dips 100 10/3 Dumbbell Side Bend 70x15'),
    'compact trailing 70x15');
});

test('G1 structural: compact weight x reps x count trailing set is refused, not hijacked into the first lift', () => {
  const r = parseWorkoutText('Dips 100 10/3 Dumbbell Side Bend 70x15x3');
  expectRefusal(r, 'compact trailing 70x15x3');
  assert.ok(!(r.sets || []).some(s => s.weight === 70), 'the 70lb Side Bend sets must not be attributed to Dips');
});

test('G1 structural: unicode multiply trailing set is refused, not silently dropped', () => {
  expectRefusal(
    parseWorkoutText('Dips 100 10/3 Dumbbell Side Bend 70×15'),
    'unicode trailing 70×15');
});

test('G1 structural: decimal-weight and capital-X compact trailing sets are refused', () => {
  expectRefusal(
    parseWorkoutText('Dips 100 10/3 Dumbbell Side Bend 70.5x15'),
    'decimal trailing 70.5x15');
  expectRefusal(
    parseWorkoutText('Dips 100 10/3 Dumbbell Side Bend 70X15'),
    'capital-X trailing 70X15');
});

test('G1 structural: lowercase unknown second-lift name with compact sets is refused', () => {
  expectRefusal(
    parseWorkoutText('Dips 100 10/3 dumbbell side bend 70x15'),
    'lowercase trailing name');
});

test('G1 structural: unrecognized leading exercise with compact trailing sets is refused', () => {
  expectRefusal(
    parseWorkoutText('Zzqx Press 185 5/2 Dumbbell Side Bend 70x15'),
    'unknown-lead compact trailing');
});

test('G1 structural: unknown-lead WxR-first order before a recognized lift is refused', () => {
  // Pre-review gap (N6): the token-order path where the compact set precedes the
  // recognized name AND an unknown name precedes the compact set. The leading
  // guard must fire on the single compact token in the pre-text.
  expectRefusal(
    parseWorkoutText('Zzqx Press 70x15 Bench 225 5/2'),
    'unknown-lead WxR-first');
});

// --- leading compact forms: the same blindness on the other side of the boundary ---

test('G1 structural: leading compact set before a recognized lift is refused, not silently dropped', () => {
  expectRefusal(
    parseWorkoutText('70x15 Bench 225 5/2'),
    'leading compact 70x15');
});

test('G1 structural: leading compact weight x reps x count before a recognized lift is refused', () => {
  expectRefusal(
    parseWorkoutText('70x15x3 Bench 225 5/2'),
    'leading compact 70x15x3');
});

// --- the guard's clarification copy must not claim a log that did not happen ---

test('G1 structural: refusal copy never claims sets were logged', () => {
  for (const input of [
    'Dips 100 10/3 Dumbbell Side Bend 70x15',
    'Weighted Dips 50 11/1 x3 Dumbbell Side Bend 70 15/1 x3',
    '70x15 Bench 225 5/2',
  ]) {
    const r = parseWorkoutText(input);
    assert.equal(r.intent, 'needs_clarification', `expected refusal for ${JSON.stringify(input)}`);
    assert.ok(!/I logged sets for/i.test(r.message || ''),
      `refusal copy must not claim a log for ${JSON.stringify(input)}: ${JSON.stringify(r.message)}`);
  }
});

// --- non-regressions: compact notation that must keep logging cleanly ---

test('G1 structural: single-exercise compact forms still log (no name-run, no boundary)', () => {
  const a = parseWorkoutText('Dips 70x15x3');
  assert.equal(a.intent, 'log_sets');
  assert.equal(a.sets.length, 3);
  assert.ok(a.sets.every(s => s.weight === 70 && s.reps === 15), 'single WxRxN must stay 3x 70x15');

  const b = parseWorkoutText('Bench 225x6');
  assert.equal(b.intent, 'log_sets');
  assert.deepEqual(b.sets.map(s => [s.weight, s.reps]), [[225, 6]]);
});

test('G1 structural: already-closed shapes keep their behavior', () => {
  // Slash and bare trailing forms still refuse.
  expectRefusal(
    parseWorkoutText('Weighted Dips 50 11/1 x3 Dumbbell Side Bend 70 15/1 x3'),
    'slash trailing');
  expectRefusal(
    parseWorkoutText('Dips 100 10 Dumbbell Side Bend 70 15'),
    'bare trailing');
  // Spaced compact form still refuses.
  expectRefusal(
    parseWorkoutText('Dips 100 10/3 Dumbbell Side Bend 70 x 15'),
    'spaced trailing');
  // Natural-language notation between sets still logs (no name-run boundary).
  const n = parseWorkoutText('Bench 225 5/2 then 245 5/2');
  assert.equal(n.intent, 'log_sets');
  assert.equal(n.sets.length, 2);
  // A recognized second lift still splits cleanly.
  const m = parseWorkoutText('Deadlift 245 6/2 5/2 bench 185 8/2');
  assert.equal(m.intent, 'log_sets_multi');
});
