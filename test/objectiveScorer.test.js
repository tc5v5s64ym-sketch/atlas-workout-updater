'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreObjectives, featuresFor } = require('../services/objectiveScorer');
const { SESSION_OBJECTIVES, combineObjectiveScore } = require('../services/objectiveScoring');

// ---------------------------------------------------------------------------
// PR 480 — Pure Session Objective Scorer (Session Planning Engine §3/§4).
// Derives the nine term sub-scores per objective from a normalized snapshot and
// selects via the PR 479 contract. These goldens pin the spec-specified
// SELECTIONS so the deterministic feature rules can't silently drift.
// ---------------------------------------------------------------------------

function select(snapshot) {
  return scoreObjectives(snapshot).selected.objective;
}

test('strength profile, recovered, no deload → strength_progression', () => {
  assert.equal(select({
    profile: { strength: 0.8, hypertrophy: 0.5, general_fitness: 0.4, cardio: 0.2, bodyweight: 0.3 },
    goals: { primary: 'strength' },
    equipment: 'full_gym', time_min: 60,
    readiness: { recovery_fit: 0.85 }, fatigue: { systemic: 0.2 },
    adherence: { matches_cadence: 0.7 },
  }), 'strength_progression');
});

test('high cardio profile + intensity intent + recovered → cardio_intervals', () => {
  assert.equal(select({
    profile: { cardio: 0.7, general_fitness: 0.6, strength: 0.3 },
    goals: { primary: 'cardio' }, cardio_intent: 'intervals',
    equipment: 'full_gym', time_min: 45,
    readiness: { recovery_fit: 0.9 }, fatigue: { systemic: 0.2 },
    adherence: { matches_cadence: 0.6 },
  }), 'cardio_intervals');
});

test('§8: intervals intent but low recovery + recent hard quality → downgrades to cardio_base', () => {
  const snapshot = {
    profile: { cardio: 0.7, general_fitness: 0.6, strength: 0.3 },
    goals: { primary: 'cardio' }, cardio_intent: 'intervals',
    equipment: 'full_gym', time_min: 45,
    readiness: { recovery_fit: 0.25, recent_hard_quality: true }, fatigue: { systemic: 0.7 },
    adherence: { matches_cadence: 0.6 },
  };
  const { ranked, selected } = scoreObjectives(snapshot);
  assert.equal(selected.objective, 'cardio_base');
  // The flip is recovery-driven: cardio_base out-scores cardio_intervals here.
  const base = ranked.find(r => r.objective === 'cardio_base').score;
  const intervals = ranked.find(r => r.objective === 'cardio_intervals').score;
  assert.ok(base > intervals, `cardio_base (${base}) should beat cardio_intervals (${intervals}) under poor recovery`);
});

test('cardio profile, no intensity intent → cardio_base (safe default)', () => {
  assert.equal(select({
    profile: { cardio: 0.7 }, goals: { primary: 'cardio' },
    equipment: 'full_gym', time_min: 45,
    readiness: { recovery_fit: 0.9 }, fatigue: { systemic: 0.2 },
    adherence: { matches_cadence: 0.6 },
  }), 'cardio_base');
});

test('deload trigger active → deload wins over any training objective', () => {
  assert.equal(select({
    profile: { strength: 0.8 }, goals: { primary: 'strength' },
    deload_active: true,
    readiness: { recovery_fit: 0.3 }, fatigue: { systemic: 0.8 },
  }), 'deload');
});

test('poor sleep + elevated fatigue (short of a deload) → recovery_reload', () => {
  assert.equal(select({
    profile: { general_fitness: 0.6, strength: 0.5 }, goals: { primary: 'general_fitness' },
    poor_sleep: true, elevated_fatigue: true,
    readiness: { recovery_fit: 0.25 }, fatigue: { systemic: 0.7 },
    adherence: { matches_cadence: 0.6 },
  }), 'recovery_reload');
});

test('scoreObjectives ranks all ten objectives; selected is the top of the ranking', () => {
  const { ranked, selected } = scoreObjectives({
    profile: { strength: 0.8 }, goals: { primary: 'strength' },
    readiness: { recovery_fit: 0.8 }, fatigue: { systemic: 0.2 },
  });
  assert.equal(ranked.length, SESSION_OBJECTIVES.length);
  assert.equal(new Set(ranked.map(r => r.objective)).size, 10);
  assert.equal(selected.objective, ranked[0].objective);
  assert.equal(selected.score, ranked[0].score);
});

test('every objective produces a valid score for an empty snapshot (no throw)', () => {
  const { ranked, selected } = scoreObjectives({});
  assert.equal(ranked.length, 10);
  assert.ok(selected && typeof selected.score === 'number');
  for (const o of SESSION_OBJECTIVES) {
    const f = featuresFor(o, {});
    const score = combineObjectiveScore(f);
    assert.ok(Number.isFinite(score), `${o} must score finite on an empty snapshot`);
  }
});

test('featuresFor returns null for an unknown objective', () => {
  assert.equal(featuresFor('not_an_objective', {}), null);
});
