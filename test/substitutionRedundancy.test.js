'use strict';

// Context-aware substitution redundancy (live evidence 2026-07-11): Back Squat was
// auto-replaced with Leg Press while the very next planned slot was Single-Leg Seated
// Leg Press — redundant back-to-back movements. This module decides, from existing
// exercise metadata + generic laterality/implement/orientation modifiers (NOT
// hard-coded exercise names), whether a candidate substitute is redundant with an
// already-planned exercise: the same exercise/alias, a unilateral/bilateral variant,
// or an obvious same-movement-family duplicate.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sameMovementFamily, isRedundantWithAny, coreTokens } = require('../services/substitutionRedundancy');

test('same exercise / alias / laterality variant → same family', () => {
  // the live bug: bilateral Leg Press vs the unilateral Single-Leg Seated Leg Press
  assert.equal(sameMovementFamily('Leg Press', 'Single-Leg Seated Leg Press'), true);
  assert.equal(sameMovementFamily('Single-Leg Seated Leg Press', 'Leg Press'), true, 'symmetric');
  // same exercise, different implement/orientation words
  assert.equal(sameMovementFamily('Barbell Row', 'Seated Row'), true);
  assert.equal(sameMovementFamily('Dumbbell Bench Press', 'Bench Press'), true);
  // exact same name / alias
  assert.equal(sameMovementFamily('Leg Press', '45-degree Leg Press'), true);
  assert.equal(sameMovementFamily('Bicep Curl', 'bicep curls'), true);
});

test('genuinely different exercises → NOT same family (a valid distinct substitute is not redundant)', () => {
  // the correct non-redundant substitute for the fixture:
  assert.equal(sameMovementFamily('Goblet Squat', 'Single-Leg Seated Leg Press'), false);
  assert.equal(sameMovementFamily('Goblet Squat', 'Back Squat'), false, 'goblet is a valid distinct sub for back squat');
  // different movements that share a word must not collide
  assert.equal(sameMovementFamily('Leg Press', 'Leg Curl'), false);
  assert.equal(sameMovementFamily('Leg Press', 'Leg Extension'), false);
  assert.equal(sameMovementFamily('Seated Row', 'Overhead Press'), false);
  assert.equal(sameMovementFamily('Back Squat', 'Romanian Deadlift'), false);
});

test('cross-pattern coincidental core words do not read as family', () => {
  // "press" alone must never merge a leg press with a bench/overhead press
  assert.equal(sameMovementFamily('Leg Press', 'Bench Press'), false);
  assert.equal(sameMovementFamily('Leg Press', 'Overhead Press'), false);
});

test('isRedundantWithAny scans the remaining plan (esp. the next slot)', () => {
  const remaining = ['Single-Leg Seated Leg Press', 'Seated Row'];
  assert.equal(isRedundantWithAny('Leg Press', remaining), true, 'Leg Press duplicates the next slot');
  assert.equal(isRedundantWithAny('Goblet Squat', remaining), false, 'Goblet Squat duplicates nothing in the plan');
  assert.equal(isRedundantWithAny('Leg Press', []), false, 'no plan → nothing redundant');
  assert.equal(isRedundantWithAny('Leg Press', null), false, 'garbage → not redundant, never throws');
});

test('coreTokens strips only generic modifiers, never movement-defining words; totality', () => {
  assert.deepEqual(coreTokens('Single-Leg Seated Leg Press'), ['leg', 'press']);
  assert.deepEqual(coreTokens('Leg Press'), ['leg', 'press']);
  // movement-defining qualifiers are preserved (front/goblet/hack define distinct lifts)
  assert.ok(coreTokens('Goblet Squat').includes('goblet'));
  assert.ok(coreTokens('Front Squat').includes('front'));
  // never throws on garbage
  assert.deepEqual(coreTokens(null), []);
  assert.deepEqual(coreTokens(''), []);
});
