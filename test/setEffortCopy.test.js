'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeSetSequence,
  assessNextMoveConflict,
  EFFORT_REASON_CODES,
} = require('../services/setEffortSignals');
const { effortNote, rerouteNote } = require('../services/setEffortCopy');
const { REASON_CODES } = require('../services/trainingKnowledge');

// Sets are [weight, reps, rir]. These tests pin the DETERMINISTIC engine-backed
// coach copy (PR 477 wiring) — the floor the lifter sees regardless of the LLM.

// 1 — warmup/feeder is ignored, never scolded as sandbagging.
test('setEffortCopy: warmup feeder produces no sandbag callout', () => {
  const a = analyzeSetSequence(
    [[135, 10, 5], [185, 10, 2], [235, 6, 2]],
    { exerciseName: 'Bench Press' }
  );
  // Engine flags the warmup, but the copy stays silent on a clean on-target session.
  assert.ok(a.reason_codes.includes(EFFORT_REASON_CODES.WARMUP_FEEDER_IGNORED));
  assert.equal(effortNote(a), null);
});

// 2 — bench redline + same-load rep drop → progression hold / pressing-yellow copy.
test('setEffortCopy: bench redline + rep drop holds progression (pressing yellow)', () => {
  const a = analyzeSetSequence(
    [[135, 10, 5], [185, 10, 2], [235, 6, 2], [235, 6, 0], [235, 4, 1]],
    { exerciseName: 'Bench Press' }
  );
  assert.equal(a.progression_verdict, 'block');
  assert.equal(effortNote(a), 'You went to zero and reps dropped after. Pressing is yellow now.');
});

test('setEffortCopy: compound RIR 0 without a rep drop still does not earn weight', () => {
  const a = analyzeSetSequence([[225, 5, 0]], { exerciseName: 'Bench Press' });
  assert.equal(a.progression_verdict, 'block');
  assert.equal(effortNote(a), 'That counted, but it does not earn more weight.');
});

// 3 — bench redline before Weighted Dips with Seated Row queued → suggest Row first.
test('setEffortCopy: reroute suggests the pull first when one is queued', () => {
  const a = analyzeSetSequence(
    [[235, 6, 2], [235, 6, 0], [235, 4, 1]],
    { exerciseName: 'Bench Press' }
  );
  const conflict = assessNextMoveConflict(a, ['Weighted Dips', 'Seated Row']);
  const line = rerouteNote(conflict);
  assert.match(line, /Seated Row/);
  assert.match(line, /in first/);
  assert.match(line, /Weighted Dips/);
});

// 4 — bench redline before another press, no pull queued → cap / optional copy.
test('setEffortCopy: reroute caps the next press when no pull is queued', () => {
  const a = analyzeSetSequence(
    [[235, 6, 2], [235, 6, 0], [235, 4, 1]],
    { exerciseName: 'Bench Press' }
  );
  const conflict = assessNextMoveConflict(a, ['Incline Bench Press']);
  const line = rerouteNote(conflict);
  assert.match(line, /cap Incline Bench Press/);
  assert.match(line, /optional/);
});

test('setEffortCopy: no conflict → no reroute line', () => {
  const a = analyzeSetSequence([[225, 5, 0]], { exerciseName: 'Bench Press' });
  // A single redline before an UNRELATED pull is not a conflict.
  assert.equal(rerouteNote(assessNextMoveConflict(a, ['Seated Row'])), null);
  assert.equal(rerouteNote(assessNextMoveConflict(a, [])), null);
});

// 5 — a high-RIR work set is worded as under-dosed.
test('setEffortCopy: high-RIR work set produces bump copy', () => {
  const a = analyzeSetSequence(
    [[20, 15, 5], [20, 15, 5], [20, 15, 5]],
    { exerciseName: 'Lateral Raise' }
  );
  assert.equal(a.progression_verdict, 'bump');
  assert.equal(effortNote(a), 'Too much left in the tank. Bump coming.');
});

// 6 — isolation RIR 0 is caution-only, NOT a heavy-compound progression block.
test('setEffortCopy: isolation RIR 0 is caution-only, not a compound block', () => {
  const iso = analyzeSetSequence([[30, 12, 0]], { exerciseName: 'Cable Fly' });
  assert.equal(iso.progression_verdict, 'caution');
  const isoLine = effortNote(iso);
  assert.match(isoLine, /no need to grind/);
  // It must NOT use the heavy-compound "does not earn more weight" block copy.
  assert.notEqual(isoLine, 'That counted, but it does not earn more weight.');

  // Same RIR 0 on a heavy compound DOES get the block copy — severity by role.
  const compound = analyzeSetSequence([[225, 5, 0]], { exerciseName: 'Bench Press' });
  assert.equal(effortNote(compound), 'That counted, but it does not earn more weight.');
});

// Defensive — malformed input never throws.
test('setEffortCopy: null / empty inputs return null without throwing', () => {
  assert.equal(effortNote(null), null);
  assert.equal(effortNote(undefined), null);
  assert.equal(rerouteNote(null), null);
  assert.equal(rerouteNote({ conflict: false }), null);
});

// Reason-code registry consistency — every engine code is centrally registered.
test('setEffortCopy: EFFORT_REASON_CODES are all registered in REASON_CODES', () => {
  const registered = new Set(Object.values(REASON_CODES));
  for (const code of Object.values(EFFORT_REASON_CODES)) {
    assert.ok(registered.has(code), `reason code ${code} must be registered centrally`);
  }
});
