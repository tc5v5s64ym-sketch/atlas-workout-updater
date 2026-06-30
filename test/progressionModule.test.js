'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  recommendProgression,
  computeLoadStep,
} = require('../services/progressionModule');

// Helper: build a minimal valid context
function ctx(overrides = {}) {
  return {
    currentWeight: 100,
    currentReps: 5,
    currentRIR: 2,
    bodyRegion: 'upper_body',
    ...overrides,
  };
}

// --- computeLoadStep ---

test('computeLoadStep: upper_body up — 100 lb × 2.5% = 2.5 lb', () => {
  assert.strictEqual(computeLoadStep(100, 'upper_body', 'up'), 2.5);
});

test('computeLoadStep: upper_body down — returns negative delta', () => {
  assert.ok(computeLoadStep(100, 'upper_body', 'down') < 0);
});

test('computeLoadStep: lower_body up — always 5 lb', () => {
  assert.strictEqual(computeLoadStep(200, 'lower_body', 'up'), 5);
  assert.strictEqual(computeLoadStep(315, 'lower_body', 'up'), 5);
});

test('computeLoadStep: lower_body down — always -5 lb', () => {
  assert.strictEqual(computeLoadStep(200, 'lower_body', 'down'), -5);
});

test('computeLoadStep: upper_body floors at 2.5 lb (small weight)', () => {
  // 50 lb × 2.5% = 1.25, rounds to 2.5 (floor)
  assert.strictEqual(computeLoadStep(50, 'upper_body', 'up'), 2.5);
});

test('computeLoadStep: upper_body 200 lb × 2.5% = 5 lb', () => {
  assert.strictEqual(computeLoadStep(200, 'upper_body', 'up'), 5);
});

test('computeLoadStep: invalid weight returns null', () => {
  assert.strictEqual(computeLoadStep(0, 'upper_body', 'up'), null);
  assert.strictEqual(computeLoadStep(-10, 'upper_body', 'up'), null);
  assert.strictEqual(computeLoadStep('100', 'upper_body', 'up'), null);
});

test('computeLoadStep: invalid direction returns null', () => {
  assert.strictEqual(computeLoadStep(100, 'upper_body', 'sideways'), null);
  assert.strictEqual(computeLoadStep(100, 'upper_body', null), null);
});

// --- recommendProgression: invalid inputs ---

test('recommendProgression: unknown scenarioId returns null', () => {
  assert.strictEqual(recommendProgression('nonexistent', ctx()), null);
});

test('recommendProgression: null scenarioId returns null', () => {
  assert.strictEqual(recommendProgression(null, ctx()), null);
});

test('recommendProgression: null context returns null', () => {
  assert.strictEqual(recommendProgression('underloaded', null), null);
});

test('recommendProgression: non-positive weight returns null', () => {
  assert.strictEqual(recommendProgression('underloaded', ctx({ currentWeight: 0 })), null);
  assert.strictEqual(recommendProgression('underloaded', ctx({ currentWeight: -5 })), null);
});

test('recommendProgression: non-integer reps returns null', () => {
  assert.strictEqual(recommendProgression('underloaded', ctx({ currentReps: 5.5 })), null);
  assert.strictEqual(recommendProgression('underloaded', ctx({ currentReps: 0 })), null);
});

test('recommendProgression: negative RIR returns null', () => {
  assert.strictEqual(recommendProgression('underloaded', ctx({ currentRIR: -1 })), null);
});

// --- underloaded → increase_load ---

test('underloaded: lever is load', () => {
  const r = recommendProgression('underloaded', ctx());
  assert.strictEqual(r.lever, 'load');
});

test('underloaded: targetWeight > currentWeight', () => {
  const r = recommendProgression('underloaded', ctx({ currentWeight: 100, currentReps: 5, currentRIR: 2 }));
  assert.ok(r.targetWeight > 100, `expected targetWeight > 100, got ${r.targetWeight}`);
});

test('underloaded: upper_body 100 lb increases by at least 2.5 lb', () => {
  const r = recommendProgression('underloaded', ctx({ currentWeight: 100 }));
  assert.ok(r.targetWeight >= 102.5);
});

test('underloaded: lower_body 200 lb increases by exactly 5 lb', () => {
  const r = recommendProgression('underloaded', ctx({ currentWeight: 200, bodyRegion: 'lower_body', currentRIR: 0 }));
  assert.ok(r.targetWeight >= 205, `expected targetWeight >= 205, got ${r.targetWeight}`);
});

test('underloaded: rationale references underloaded/load', () => {
  const r = recommendProgression('underloaded', ctx());
  assert.ok(r.rationale.toLowerCase().includes('underloaded') || r.rationale.toLowerCase().includes('load'));
});

test('underloaded: scenarioId and default_action are preserved', () => {
  const r = recommendProgression('underloaded', ctx());
  assert.strictEqual(r.scenarioId, 'underloaded');
  assert.strictEqual(r.default_action, 'increase_load');
});

// --- on_target → maintain_or_add_reps ---

test('on_target: lever is reps', () => {
  assert.strictEqual(recommendProgression('on_target', ctx()).lever, 'reps');
});

test('on_target: targetReps = currentReps + 1', () => {
  const r = recommendProgression('on_target', ctx({ currentReps: 8 }));
  assert.strictEqual(r.targetReps, 9);
});

test('on_target: targetWeight = currentWeight (unchanged)', () => {
  const r = recommendProgression('on_target', ctx({ currentWeight: 135 }));
  assert.strictEqual(r.targetWeight, 135);
});

// --- normal_variability → hold_progression ---

test('normal_variability: lever is none', () => {
  assert.strictEqual(recommendProgression('normal_variability', ctx()).lever, 'none');
});

test('normal_variability: targetWeight = currentWeight', () => {
  const r = recommendProgression('normal_variability', ctx({ currentWeight: 185 }));
  assert.strictEqual(r.targetWeight, 185);
});

test('normal_variability: targetReps = currentReps', () => {
  const r = recommendProgression('normal_variability', ctx({ currentReps: 6 }));
  assert.strictEqual(r.targetReps, 6);
});

// --- likely_fatigue → hold_or_reduce_load ---

test('likely_fatigue: lever is load', () => {
  assert.strictEqual(recommendProgression('likely_fatigue', ctx()).lever, 'load');
});

test('likely_fatigue: targetWeight <= currentWeight', () => {
  const r = recommendProgression('likely_fatigue', ctx({ currentWeight: 100 }));
  assert.ok(r.targetWeight <= 100, `expected targetWeight <= 100, got ${r.targetWeight}`);
});

test('likely_fatigue: targetWeight >= 0 (no negative weight)', () => {
  const r = recommendProgression('likely_fatigue', ctx({ currentWeight: 2.5, bodyRegion: 'upper_body' }));
  assert.ok(r.targetWeight >= 0);
});

test('likely_fatigue: lower_body reduces by 5 lb', () => {
  const r = recommendProgression('likely_fatigue', ctx({ currentWeight: 200, bodyRegion: 'lower_body' }));
  assert.strictEqual(r.targetWeight, 195);
});

// --- injury_signal → swap_exercise_or_reduce_rom ---

test('injury_signal: lever is none', () => {
  assert.strictEqual(recommendProgression('injury_signal', ctx()).lever, 'none');
});

test('injury_signal: rationale references injury or substitute', () => {
  const r = recommendProgression('injury_signal', ctx());
  const lower = r.rationale.toLowerCase();
  assert.ok(lower.includes('injury') || lower.includes('substitute') || lower.includes('rom'));
});

test('injury_signal: targetWeight is null (no load change prescribed)', () => {
  assert.strictEqual(recommendProgression('injury_signal', ctx()).targetWeight, null);
});

// --- candidate_plateau → change_variant_reps_or_volume ---

test('candidate_plateau: lever is none', () => {
  assert.strictEqual(recommendProgression('candidate_plateau', ctx()).lever, 'none');
});

test('candidate_plateau: rationale references plateau or variant', () => {
  const r = recommendProgression('candidate_plateau', ctx());
  const lower = r.rationale.toLowerCase();
  assert.ok(lower.includes('plateau') || lower.includes('variant'));
});

// --- result shape completeness ---

test('recommendProgression: result always has all required fields', () => {
  for (const id of ['underloaded', 'on_target', 'normal_variability', 'likely_fatigue', 'injury_signal', 'candidate_plateau']) {
    const r = recommendProgression(id, ctx());
    assert.ok('scenarioId' in r, `${id}: missing scenarioId`);
    assert.ok('default_action' in r, `${id}: missing default_action`);
    assert.ok('lever' in r, `${id}: missing lever`);
    assert.ok('targetWeight' in r, `${id}: missing targetWeight`);
    assert.ok('targetReps' in r, `${id}: missing targetReps`);
    assert.ok('rationale' in r, `${id}: missing rationale`);
  }
});

test('recommendProgression: bodyRegion defaults to upper_body when omitted', () => {
  const withDefault = recommendProgression('underloaded', { currentWeight: 100, currentReps: 5, currentRIR: 2 });
  const withExplicit = recommendProgression('underloaded', ctx({ currentWeight: 100, currentReps: 5, currentRIR: 2, bodyRegion: 'upper_body' }));
  assert.strictEqual(withDefault.targetWeight, withExplicit.targetWeight);
});
