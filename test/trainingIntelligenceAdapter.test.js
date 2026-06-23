'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { profileForGoal, modalityCategoryFor } = require('../services/trainingIntelligenceAdapter');
const { PROFILES, MODALITY_CATEGORIES } = require('../services/stimulusGovernorRules');

// ---------------------------------------------------------------------------
// PR 484 (wiring slice 1) — Training Intelligence Adapter: pure bridges from
// live app data (training goal, exercise name) to the engine vocabularies, so
// the deterministic engines can be fed from real signals in a later slice.
// ---------------------------------------------------------------------------

test('profileForGoal projects TRAINING_GOALS onto a governor PROFILE', () => {
  assert.equal(profileForGoal('strength'), 'strength');
  assert.equal(profileForGoal('powerlifting'), 'strength'); // alias → strength
  assert.equal(profileForGoal('power'), 'strength');        // power is strength-adjacent
  assert.equal(profileForGoal('hypertrophy'), 'hypertrophy');
  assert.equal(profileForGoal('muscle'), 'hypertrophy');    // alias
  assert.equal(profileForGoal('powerbuilding'), 'hypertrophy'); // mixed → hypertrophy
  assert.equal(profileForGoal('conditioning'), 'cardio');
  assert.equal(profileForGoal('fat_loss'), 'cardio');
  assert.equal(profileForGoal('endurance'), 'general_fitness'); // muscular_endurance
  assert.equal(profileForGoal('health'), 'general_fitness');
  assert.equal(profileForGoal('recovery'), 'general_fitness');  // a state, safe default
});

test('profileForGoal is safe on unknown / empty input → general_fitness, always in-vocab', () => {
  for (const g of ['', '   ', null, undefined, 42, 'totally_made_up']) {
    const p = profileForGoal(g);
    assert.equal(p, 'general_fitness');
    assert.ok(PROFILES.includes(p));
  }
});

test('every profileForGoal result is within the governor PROFILES vocabulary', () => {
  for (const g of ['strength', 'power', 'hypertrophy', 'muscle', 'conditioning', 'fat_loss', 'endurance', 'health', 'recovery', 'powerbuilding', 'mixed']) {
    assert.ok(PROFILES.includes(profileForGoal(g)), `${g} → out-of-vocab`);
  }
});

test('modalityCategoryFor maps an exercise name onto a MODALITY_CATEGORY (exercise_type wins)', () => {
  assert.equal(modalityCategoryFor('Bench Press'), 'resistance');
  assert.equal(modalityCategoryFor('Lateral Raise'), 'resistance');
  assert.equal(modalityCategoryFor('Power Clean'), 'resistance');
  assert.equal(modalityCategoryFor('Pushups'), 'bodyweight');
  assert.equal(modalityCategoryFor('Weighted Dip'), 'bodyweight');     // added-load bodyweight
  assert.equal(modalityCategoryFor('Assisted Pull Up'), 'bodyweight'); // assisted bodyweight
  assert.equal(modalityCategoryFor('Run'), 'cardio');
  assert.equal(modalityCategoryFor('Elliptical'), 'cardio');
  assert.equal(modalityCategoryFor('Plank'), 'timed');
  assert.equal(modalityCategoryFor('Stretching'), 'timed');            // mobility → timed
});

test('a circuit maps to circuit even though its load_type is bodyweight', () => {
  assert.equal(modalityCategoryFor('AMRAP 12 min'), 'circuit');
  assert.equal(modalityCategoryFor('EMOM 10 min'), 'circuit');
});

test('every modalityCategoryFor result is within the MODALITY_CATEGORIES vocabulary', () => {
  for (const n of ['Bench Press', 'Run', 'Plank', 'AMRAP 12', 'Pushups', 'Weighted Dip', 'Cable Fly', 'unknownlift', '']) {
    assert.ok(MODALITY_CATEGORIES.includes(modalityCategoryFor(n)), `${JSON.stringify(n)} → out-of-vocab`);
  }
});
