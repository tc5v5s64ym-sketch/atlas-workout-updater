'use strict';

// P0 AC12 surfacing — barbell loadability snap, gated on the exercise KB.
// Pure module: classify barbell movements, snap their target weight to a loadable
// total, leave non-barbell / already-loadable / unknown lifts untouched.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isBarbellExercise,
  applyBarbellLoadability,
  applyBarbellLoadabilityToExercises,
} = require('../services/barbellLoadabilitySurface');

test('isBarbellExercise: classifies from the exercise KB (category/equipment)', () => {
  // barbell movements (category 'barbell' or equipment includes 'barbell')
  assert.equal(isBarbellExercise('Barbell Bench Press'), true);
  assert.equal(isBarbellExercise('Back Squat'), true);
  assert.equal(isBarbellExercise('Deadlift'), true);
  // not barbell
  assert.equal(isBarbellExercise('Dumbbell Bench Press'), false);
  assert.equal(isBarbellExercise('Leg Press'), false);
  // refuse to guess on an unknown / unmatched name → not barbell (no snap)
  assert.equal(isBarbellExercise('Zorptlift 9000'), false);
  assert.equal(isBarbellExercise(''), false);
  assert.equal(isBarbellExercise(null), false);
});

test('applyBarbellLoadability: snaps a non-loadable BARBELL target + attaches a note', () => {
  const out = applyBarbellLoadability({ exercise: 'Barbell Bench Press', target_weight: 116, target_reps: 5 });
  assert.equal(out.target_weight, 115, '116 → 115 (loadable on a 45 lb bar)');
  assert.match(out.loadability_note, /Rounded 116 → 115 lb/);
  assert.equal(out.target_reps, 5, 'other fields preserved');
});

test('applyBarbellLoadability: passes through an already-loadable barbell target (no note)', () => {
  const input = { exercise: 'Back Squat', target_weight: 225 };
  const out = applyBarbellLoadability(input);
  assert.equal(out.target_weight, 225);
  assert.equal(out.loadability_note, undefined, 'no note when nothing changed');
});

test('applyBarbellLoadability: never snaps a non-barbell lift, even when not on a 5 lb grid', () => {
  const input = { exercise: 'Dumbbell Bench Press', target_weight: 116 };
  const out = applyBarbellLoadability(input);
  assert.equal(out, input, 'non-barbell lift returned unchanged (same object)');
  assert.equal(out.loadability_note, undefined);
});

test('applyBarbellLoadability: ignores missing / non-positive / non-finite target weights', () => {
  for (const w of [undefined, null, 0, -10, NaN, 'heavy']) {
    const input = { exercise: 'Barbell Bench Press', target_weight: w };
    assert.equal(applyBarbellLoadability(input), input, `target_weight=${String(w)} → unchanged`);
  }
  assert.equal(applyBarbellLoadability(null), null, 'a non-object passes through');
});

test('applyBarbellLoadabilityToExercises: maps over the list; non-array passes through', () => {
  const list = [
    { exercise: 'Barbell Bench Press', target_weight: 116 },  // snapped → 115
    { exercise: 'Dumbbell Bench Press', target_weight: 116 }, // untouched
    { exercise: 'Back Squat', target_weight: 225 },           // already loadable
  ];
  const out = applyBarbellLoadabilityToExercises(list);
  assert.equal(out[0].target_weight, 115);
  assert.match(out[0].loadability_note, /Rounded 116 → 115/);
  assert.equal(out[1].target_weight, 116);
  assert.equal(out[1].loadability_note, undefined);
  assert.equal(out[2].target_weight, 225);
  assert.equal(out[2].loadability_note, undefined);

  assert.equal(applyBarbellLoadabilityToExercises(null), null, 'non-array returned as-is');
});
