const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseWorkoutText } = require('../services/workoutTextParser');
const { normalizeDisplayBlocks } = require('../public/displayBlockNormalizer.js');

// G1 — the parser must NEVER silently merge a second stacked exercise's set tokens
// into the first lift (the live "Dumbbell Side Bend 70lb sets absorbed into Dips →
// fabricated PR" bug). The approach shipped here is REFUSE-TO-MERGE on structural
// grounds (no alias catalog dependency, no Exercise-KB coupling): when a trailing
// set-group is separated from the first set-group by a pure exercise-name word run,
// the parser surfaces it as unresolved instead of absorbing it. Splitting a stacked
// bubble into two clean exercises is a separate, owner-gated feature (see BACKLOG) —
// this PR is the guardrail, not that feature.

// --- the repro: stacked input must not merge (hard invariant) ---

test('stacked inline entry surfaces the second exercise instead of merging its sets', () => {
  const r = parseWorkoutText('Weighted Dips 50 11/1 x3 Dumbbell Side Bend 70 15/1 x3');
  // It must NOT silently log Dips with the Side Bend sets absorbed.
  assert.notEqual(r.intent, 'log_sets', 'must not log a single merged exercise');
  assert.notEqual(r.intent, 'log_sets_multi', 'this PR refuses to merge; it does not split (that is a separate feature)');
  assert.equal(r.intent, 'needs_clarification');
  assert.ok((r.warnings || []).includes('unattributable_trailing_sets'),
    `expected the refuse-to-merge warning, got [${(r.warnings || []).join(', ')}]`);
  // The phantom-PR value (70) must never appear as a logged Dips set.
  assert.ok(!(r.sets || []).some(s => s.weight === 70), 'the 70lb Side Bend sets must not be attributed to Dips');
});

// --- false-positive guards: notation / annotation / continuation are NOT a new exercise ---

test('a trailing annotation after sets is not treated as a second exercise', () => {
  const r = parseWorkoutText('Bench 225 5/2 felt heavy');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Bench Press');
  assert.equal(r.sets.length, 1);
  assert.equal(r.sets[0].weight, 225);
});

test('a continuation across a filler word is one exercise (not a boundary)', () => {
  const r = parseWorkoutText('Bench 225 5/2 then 245 3/1');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Bench Press');
  assert.equal(r.sets.length, 2);
});

test('natural-language notation between sets is not mistaken for a second exercise', () => {
  // "all around RIR", "lb ... reps RIR", "for" — all contain notation/filler words,
  // so the name-run is never "entirely name-like" and the guard stays silent.
  const a = parseWorkoutText('Bench Press 205 lb 5 reps RIR 2');
  assert.equal(a.intent, 'log_sets');
  assert.equal(a.canonical_name, 'Bench Press');

  const b = parseWorkoutText('Squat 205 for 7, then 6 and 6, all around RIR 2.');
  assert.equal(b.intent, 'log_sets');
  assert.equal(b.canonical_name, 'Back Squat');
  assert.equal(b.sets.length, 3);
});

test('a recognized two-exercise entry still splits normally (alias path unchanged)', () => {
  const r = parseWorkoutText('Deadlift 315 5/2 Bench 225 5/2');
  assert.equal(r.intent, 'log_sets_multi');
  assert.deepEqual(r.exercises.map(e => e.canonical_name), ['Deadlift', 'Bench Press']);
});

// --- consistency: neither intake path silently merges the same stacked input ---

test('backend parser and display-block normalizer agree: no path silently merges a stacked entry', () => {
  const inline = 'Weighted Dips 50 11/1 x3 Dumbbell Side Bend 70 15/1 x3';
  // Inline: the normalizer defers (not a clean header→sets block), so the backend is
  // authoritative — and the backend refuses to merge.
  const norm = normalizeDisplayBlocks(inline);
  assert.equal(norm.isDisplayBlock, false, 'normalizer defers the inline form to the backend parser');
  const backend = parseWorkoutText(inline);
  assert.equal(backend.intent, 'needs_clarification', 'backend refuses to merge the inline form');

  // Multi-line: the normalizer splits structurally into two blocks — also never a
  // merge. Both intake paths converge on "the second exercise is not absorbed."
  const multiline = 'Weighted Dips\n50 11/1\n50 11/1\nDumbbell Side Bend\n70 15/1\n70 15/1';
  const normMulti = normalizeDisplayBlocks(multiline);
  assert.equal(normMulti.isDisplayBlock, true);
  assert.deepEqual(normMulti.blocks.map(b => b.name), ['Weighted Dips', 'Dumbbell Side Bend']);
  assert.ok(normMulti.blocks.every(b => b.sets.length === 2), 'each block keeps only its own sets');
});
