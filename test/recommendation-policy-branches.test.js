'use strict';

// Coverage follow-up — recommendationPolicy.js progression branches.
//
// recommendationPolicy.js was the lowest-branch-covered service (~79%). The
// uncovered branches are specific goal-policy progression paths in
// applyProgression() plus the estimated-1RM base-weight path. These are pure,
// deterministic functions driven entirely through the public
// recommendExercisePrescription() entry point — no I/O, no stubs. Tests assert
// CURRENT behaviour; the source is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const { recommendExercisePrescription } = require('../services/recommendationPolicy');

// estimateWeightFrom1RM + the chooseBasePrescription estimated-1RM branch:
// with no previous weight but an estimated 1RM, the base weight is derived from
// the 1RM (not invented), so it comes back finite rather than cold-start.
test('estimated 1RM with no previous weight derives a finite recommended weight', () => {
  const r = recommendExercisePrescription({
    goal: 'strength',
    exerciseName: 'Back Squat',
    exerciseType: 'compound',
    estimated1RM: 300
    // no previousPerformance → weight must come from the 1RM estimate
  });
  assert.ok(Number.isFinite(r.recommendedWeight) && r.recommendedWeight > 0,
    'recommended weight is derived from the estimated 1RM');
  assert.equal(r.weightGuidance, undefined, 'a derived weight is not a cold-start guidance string');
});

// Hypertrophy: completed with room, reps BELOW the rep range (not inside, not at
// top), and weekly volume below target → add a set.
test('hypertrophy adds a set when weekly volume is below target and reps are below range', () => {
  const r = recommendExercisePrescription({
    goal: 'hypertrophy',
    exerciseName: 'Bicep Curl',
    previousPerformance: { completed: true, reps: 6, rir: 1, weight: 100 }, // reps 6 < preferred min 8
    recentTrends: { muscleWeeklySetsBelowTarget: true }
  });
  assert.equal(r.progression, 'add_set');
  assert.equal(r.adjustment, 'volume_below_target_and_recovery_ok');
});

// conditioning_fat_loss: completed with room → density before load.
test('conditioning_fat_loss progresses density when completed with room', () => {
  const r = recommendExercisePrescription({
    goal: 'conditioning_fat_loss',
    exerciseName: 'Kettlebell Swing',
    previousPerformance: { completed: true, reps: 12, rir: 2, weight: 80 }
  });
  assert.equal(r.progression, 'increase_density_or_reps');
  assert.equal(r.adjustment, 'density_before_load');
});

// Mixed goal, main-lift (compound): completed with room and at/above the top of
// the main-lift rep range → add load.
test('mixed goal adds load on a main lift at the top of its rep range', () => {
  const r = recommendExercisePrescription({
    goal: 'mixed',
    exerciseName: 'Back Squat',
    exerciseType: 'compound',
    previousPerformance: { completed: true, reps: 6, rir: 1, weight: 225 } // top of mainLiftRepRange {3,6}
  });
  assert.equal(r.progression, 'add_load');
  assert.equal(r.adjustment, 'main_lift_load_progression');
  assert.ok(r.recommendedWeight > 225, 'load steps up from the previous weight');
});

// general_health is handled by no explicit goal branch, so it exercises the
// default fallback: completed with room and inside the rep range → add a rep.
test('general_health falls through to the default rep-progression branch', () => {
  const r = recommendExercisePrescription({
    goal: 'general_health',
    exerciseName: 'Goblet Squat',
    previousPerformance: { completed: true, reps: 10, rir: 2, weight: 100 } // inside preferred {8,12}
  });
  assert.equal(r.progression, 'add_rep');
  assert.equal(r.adjustment, 'sustainable_progress');
});

// An unknown goal string normalizes to general_health and hits the same fallback —
// pins the normalize-to-default behaviour.
test('an unrecognized goal normalizes to general_health and progresses sustainably', () => {
  const r = recommendExercisePrescription({
    goal: 'zumba',
    exerciseName: 'Goblet Squat',
    previousPerformance: { completed: true, reps: 10, rir: 2, weight: 100 }
  });
  assert.equal(r.goal, 'general_health', 'unknown goal defaults to general_health');
  assert.equal(r.progression, 'add_rep');
});
