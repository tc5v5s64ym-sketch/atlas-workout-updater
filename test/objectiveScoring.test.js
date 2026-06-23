'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SESSION_OBJECTIVES,
  OBJECTIVE_WEIGHTS,
  FIT_TERMS,
  PENALTY_TERMS,
  combineObjectiveScore,
  explainObjectiveScore,
  selectObjective,
} = require('../services/objectiveScoring');

// ---------------------------------------------------------------------------
// PR 479 — Session Objective Scoring Fixtures (Session Planning Engine §3).
// These goldens FIXTURE-PROTECT the initial deterministic weights + the
// combine/select formula BEFORE the PR 480 scorer (which computes the term
// sub-scores) ships, so any weight change is a visible, test-gated decision.
// ---------------------------------------------------------------------------

test('the ten supported session objectives are pinned', () => {
  assert.deepEqual(SESSION_OBJECTIVES, [
    'strength_progression', 'hypertrophy_volume', 'general_fitness_balanced',
    'cardio_base', 'cardio_intervals', 'bodyweight_strength',
    'circuit_conditioning', 'skill_practice', 'recovery_reload', 'deload',
  ]);
  assert.ok(Object.isFrozen(SESSION_OBJECTIVES));
});

test('the §3 weights are pinned exactly (a change must be deliberate)', () => {
  assert.deepEqual({ ...OBJECTIVE_WEIGHTS }, {
    profile_match: 0.30,
    goal_match: 0.15,
    equipment_fit: 0.10,
    time_fit: 0.10,
    recovery_fit: 0.15,
    adherence_fit: 0.10,
    movement_balance_need: 0.10,
    pain_conflict: -0.10,
    fatigue_conflict: -0.10,
  });
  assert.ok(Object.isFrozen(OBJECTIVE_WEIGHTS));
  // Positive fit-term weights sum to 1.0; the two conflicts are −0.10 penalties.
  const fitSum = FIT_TERMS.reduce((s, t) => s + OBJECTIVE_WEIGHTS[t], 0);
  assert.ok(Math.abs(fitSum - 1.0) < 1e-9, `fit weights must sum to 1.0, got ${fitSum}`);
  assert.deepEqual([...PENALTY_TERMS].sort(), ['fatigue_conflict', 'pain_conflict']);
  for (const p of PENALTY_TERMS) assert.equal(OBJECTIVE_WEIGHTS[p], -0.10);
});

test('combineObjectiveScore applies the weighted sum (hand-computed)', () => {
  // A "perfect, no-conflict" objective scores exactly the fit-weight sum = 1.0.
  const perfect = {
    profile_match: 1, goal_match: 1, equipment_fit: 1, time_fit: 1,
    recovery_fit: 1, adherence_fit: 1, movement_balance_need: 1,
    pain_conflict: 0, fatigue_conflict: 0,
  };
  assert.equal(combineObjectiveScore(perfect), 1.0);

  // Full conflict on both penalties subtracts 0.20.
  assert.equal(combineObjectiveScore({ ...perfect, pain_conflict: 1, fatigue_conflict: 1 }), 0.8);

  // A representative mixed vector, computed by hand:
  //  .30*.7 + .15*.6 + .10*1 + .10*1 + .15*.9 + .10*.6 + .10*.5 - .10*0 - .10*.1
  //  = .21 + .09 + .10 + .10 + .135 + .06 + .05 - 0 - .01 = 0.735
  const base = {
    profile_match: 0.7, goal_match: 0.6, equipment_fit: 1, time_fit: 1,
    recovery_fit: 0.9, adherence_fit: 0.6, movement_balance_need: 0.5,
    pain_conflict: 0, fatigue_conflict: 0.1,
  };
  assert.equal(combineObjectiveScore(base), 0.735);
});

test('missing terms default to 0 and sub-scores clamp to [0,1]', () => {
  assert.equal(combineObjectiveScore({}), 0);
  assert.equal(combineObjectiveScore({ profile_match: 1 }), 0.30); // only one term present
  // Out-of-range / non-numeric inputs are clamped, never trusted.
  assert.equal(combineObjectiveScore({ profile_match: 5 }), 0.30);   // >1 → 1
  assert.equal(combineObjectiveScore({ profile_match: -3 }), 0);     // <0 → 0
  assert.equal(combineObjectiveScore({ profile_match: 'x' }), 0);    // NaN → 0
});

test('explainObjectiveScore exposes signed per-term contributions', () => {
  const c = explainObjectiveScore({ profile_match: 1, fatigue_conflict: 1 });
  assert.equal(c.profile_match, 0.30);
  assert.equal(c.fatigue_conflict, -0.10); // penalty contributes negatively
  // Sum of contributions equals the combined score.
  const total = Object.values(c).reduce((s, v) => s + v, 0);
  assert.equal(Math.round(total * 1e4) / 1e4, combineObjectiveScore({ profile_match: 1, fatigue_conflict: 1 }));
});

// §8 worked fixture: "cardio_intervals blocked by recovery" — the penalty flips
// selection. With good recovery, intervals (higher profile/goal) wins; with low
// recovery + recent hard quality (fatigue_conflict high, recovery_fit low),
// selection flips to cardio_base. Proven at the SCORING layer (feature vectors in;
// PR 480 will compute these features from real inputs).
test('§8: recovery flips cardio_intervals → cardio_base selection', () => {
  const baseFeatures = {
    profile_match: 0.7, goal_match: 0.6, equipment_fit: 1, time_fit: 1,
    recovery_fit: 0.9, adherence_fit: 0.6, movement_balance_need: 0.5,
    pain_conflict: 0, fatigue_conflict: 0.1,
  };

  // Good recovery → intervals scores highest.
  const intervalsFresh = {
    profile_match: 0.8, goal_match: 0.8, equipment_fit: 1, time_fit: 1,
    recovery_fit: 0.9, adherence_fit: 0.6, movement_balance_need: 0.5,
    pain_conflict: 0, fatigue_conflict: 0.1,
  };
  const fresh = selectObjective([
    { objective: 'cardio_base', features: baseFeatures },
    { objective: 'cardio_intervals', features: intervalsFresh },
  ]);
  assert.equal(fresh.objective, 'cardio_intervals');

  // Low recovery + recent hard quality → fatigue_conflict penalty + low
  // recovery_fit flip the winner to cardio_base.
  const intervalsCooked = { ...intervalsFresh, recovery_fit: 0.25, fatigue_conflict: 0.9 };
  const cooked = selectObjective([
    { objective: 'cardio_base', features: baseFeatures },
    { objective: 'cardio_intervals', features: intervalsCooked },
  ]);
  assert.equal(cooked.objective, 'cardio_base');
  assert.ok(cooked.score > combineObjectiveScore(intervalsCooked));
});

test('selectObjective breaks ties by declaration order and is safe on empty input', () => {
  const same = { profile_match: 0.5 };
  // strength_progression precedes deload in SESSION_OBJECTIVES → wins an equal score.
  const pick = selectObjective([
    { objective: 'deload', features: same },
    { objective: 'strength_progression', features: same },
  ]);
  assert.equal(pick.objective, 'strength_progression');
  assert.equal(selectObjective([]), null);
  assert.equal(selectObjective(null), null);
});
