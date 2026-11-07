// Issue #1620 — a leading "BW" marker defeats the xN multiplier on the
// older bodyweight paths (Dips / Push-Up / Hanging Knee Raises).
//
// Root: parseBodyweightReps anchors its repeat forms ("15 x3", "15/1 x3") to
// the start of the text, so a leading "BW" falls through to the unanchored
// slash-pair fallback and logs only ONE set of the xN repeat (or, for the
// "15 x3" form, dead-ends at needs_clarification). PR #1619 stripped the
// marker locally inside its new Pull-Up/Chin-Up block only, so those two
// exercises behave correctly; the older paths keep the quirk.
//
// Fix: strip the leading BW marker inside parseBodyweightReps itself (the
// shared seam), so every bodyweight exercise — including the unknown-exercise
// fallback — treats BW-prefixed logs identically. The Pull-Up/Chin-Up
// call-site strip becomes redundant and is removed; behaviour there is
// pinned unchanged below.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkoutText } = require('../services/workoutTextParser');

test('#1620: "Dips BW 10/2 x3" → bodyweight Dips, 3 sets of (10,2)', () => {
  const r = parseWorkoutText('Dips BW 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips');
  assert.equal(r.sets.length, 3);
  assert.ok(r.sets.every(s => s.weight === null && s.weight_unit === null), 'bodyweight → no weight');
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2], [10, 2], [10, 2]]);
});

test('#1620: "push ups BW 10/2 x3" → bodyweight Push-Up, 3 sets of (10,2)', () => {
  const r = parseWorkoutText('push ups BW 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Push-Up');
  assert.equal(r.sets.length, 3);
  assert.ok(r.sets.every(s => s.weight === null), 'bodyweight → no weight');
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2], [10, 2], [10, 2]]);
});

test('#1620: "knee raises BW 10/2 x3" → Hanging Knee Raises, 3 sets of (10,2)', () => {
  const r = parseWorkoutText('knee raises BW 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Hanging Knee Raises');
  assert.equal(r.sets.length, 3);
  assert.ok(r.sets.every(s => s.weight === null && s.weight_unit === null), 'bodyweight → no weight');
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2], [10, 2], [10, 2]]);
});

test('#1620: "Dips BW 15 x3" → 3 sets of 15 (the bare-repeat form, not just slash-repeat)', () => {
  const r = parseWorkoutText('Dips BW 15 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[15, null], [15, null], [15, null]]);
});

test('#1620: "Push ups BW 15 x3" → 3 sets of 15', () => {
  const r = parseWorkoutText('Push ups BW 15 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Push-Up');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[15, null], [15, null], [15, null]]);
});

test('#1620: "Dips BW 10/2 8/1 6/1" → 3 varied sets (mixed pairs, BW prefix harmless)', () => {
  const r = parseWorkoutText('Dips BW 10/2 8/1 6/1');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2], [8, 1], [6, 1]]);
});

test('#1620: "Dips BW 10/2" (no xN) → 1 set (the strip invents no repeat)', () => {
  const r = parseWorkoutText('Dips BW 10/2');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips');
  assert.equal(r.sets.length, 1);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2]]);
});

test('#1620 guard: unknown-exercise fallback already expands — "zottman curls BW 10/2 x3" logs 3 sets, still flagged unknown', () => {
  // The BW marker is absorbed into the unknown name ("Zottman Curls Bw"),
  // so the rest reaching parseBodyweightReps is already clean — this passes
  // on base. Pinned so the seam change does not regress it.
  const r = parseWorkoutText('zottman curls BW 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2], [10, 2], [10, 2]]);
  assert.ok((r.warnings || []).includes('unknown_exercise'), 'still flagged unknown');
  assert.equal(r.needs_catalog_review, true);
});

// ── Guards: the bare forms, the #1619 Pull-Up/Chin-Up fix, and weighted ─────
// ── Dips must be byte-identical before and after this change. ───────────────

test('#1620 guard: "Dips 10/2 x3" (no BW marker) → 3 sets, unchanged', () => {
  const r = parseWorkoutText('Dips 10/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[10, 2], [10, 2], [10, 2]]);
});

test('#1620 guard: "pullups BW 8/2 x3" → Pull-Up, 3 sets (PR #1619 behaviour unchanged)', () => {
  const r = parseWorkoutText('pullups BW 8/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Pull-Up');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[8, 2], [8, 2], [8, 2]]);
});

test('#1620 guard: "chin-ups BW 6/2 x3" → Chin-Up, 3 sets (PR #1619 behaviour unchanged)', () => {
  const r = parseWorkoutText('chin-ups BW 6/2 x3');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Chin-Up');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[6, 2], [6, 2], [6, 2]]);
});

test('#1620 guard: "Dips +25 8/2" → weighted Dips, +25 is the weight (weighted path untouched)', () => {
  const r = parseWorkoutText('Dips +25 8/2');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dips (Weighted)');
  assert.equal(r.sets[0].weight, 25);
});

test('#1620 guard: "Knee raises 20/2 20/2 13/2" → 3 varied sets, unchanged', () => {
  const r = parseWorkoutText('Knee raises 20/2 20/2 13/2');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Hanging Knee Raises');
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets.map(s => [s.reps, s.rir]), [[20, 2], [20, 2], [13, 2]]);
});
