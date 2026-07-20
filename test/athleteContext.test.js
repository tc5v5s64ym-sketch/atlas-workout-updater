'use strict';

// AthleteContext contract — Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md).
//
// The durable athlete profile (goal / level / population / equipment), naming and
// versioning the StateSnapshot.profile read-model. Pure builder + total validator,
// mirroring the shipped CoachingDecision / ExerciseIdentity contracts. Read-only;
// not yet wired.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  buildAthleteContext,
  validateAthleteContext,
  TRAINING_LEVELS,
  CANONICAL_GOALS,
  _resetForTesting,
} = require('../services/athleteContext');

beforeEach(() => _resetForTesting());

const valid = () => ({
  schema_version: SCHEMA_VERSION,
  profile_goal: 'hypertrophy',
  training_level: 'intermediate',
  population: 'general',
  equipment_profile: { barbell: true },
});

describe('buildAthleteContext', () => {
  it('stamps schema_version and defaults every nullable field to null', () => {
    const c = buildAthleteContext({});
    assert.equal(c.schema_version, SCHEMA_VERSION);
    assert.equal(c.profile_goal, null);
    assert.equal(c.training_level, null);
    assert.equal(c.population, null);
    assert.equal(c.equipment_profile, null);
  });
  it('promotes the StateSnapshot.profile fields (goal/level/population) plus equipment_profile', () => {
    const c = buildAthleteContext({ profile_goal: 'strength', training_level: 'advanced', population: 'youth' });
    assert.equal(c.profile_goal, 'strength');
    assert.equal(c.training_level, 'advanced');
    assert.equal(c.population, 'youth');
    assert.ok('equipment_profile' in c);
  });
  it('tolerates junk input without throwing', () => {
    assert.equal(buildAthleteContext(undefined).schema_version, SCHEMA_VERSION);
    assert.equal(buildAthleteContext(null).profile_goal, null);
  });
});

describe('validateAthleteContext', () => {
  it('accepts a well-formed context', () => {
    const r = validateAthleteContext(valid());
    assert.equal(r.valid, true, r.errors.join(' | '));
  });

  it('accepts an all-null profile (unknown athlete)', () => {
    assert.equal(validateAthleteContext(buildAthleteContext({})).valid, true);
  });

  it('rejects a non-object and a wrong schema_version', () => {
    assert.equal(validateAthleteContext(null).valid, false);
    assert.equal(validateAthleteContext({ ...valid(), schema_version: 2 }).valid, false);
  });

  it('validates profile_goal against the canonical goal vocabulary', () => {
    assert.equal(validateAthleteContext({ ...valid(), profile_goal: 'get_swole' }).valid, false);
    for (const g of CANONICAL_GOALS) {
      assert.equal(validateAthleteContext({ ...valid(), profile_goal: g }).valid, true, `goal ${g}`);
    }
  });

  it('closes the training_level enum', () => {
    assert.equal(validateAthleteContext({ ...valid(), training_level: 'elite' }).valid, false);
    for (const lvl of TRAINING_LEVELS) {
      assert.equal(validateAthleteContext({ ...valid(), training_level: lvl }).valid, true, `level ${lvl}`);
    }
  });

  it('accepts a nullable population string / object equipment_profile, rejects malformed', () => {
    assert.equal(validateAthleteContext({ ...valid(), population: 'older_adult' }).valid, true);
    assert.equal(validateAthleteContext({ ...valid(), population: '' }).valid, false);
    assert.equal(validateAthleteContext({ ...valid(), equipment_profile: [] }).valid, false, 'array is not a plain object');
    assert.equal(validateAthleteContext({ ...valid(), equipment_profile: 'barbell' }).valid, false);
  });

  it('requires each nullable field to be PRESENT (explicit null), not omitted', () => {
    for (const key of ['profile_goal', 'training_level', 'population', 'equipment_profile']) {
      const partial = valid();
      delete partial[key];
      const r = validateAthleteContext(partial);
      assert.equal(r.valid, false, `omitting ${key} must be rejected`);
      assert.ok(r.errors.some((e) => e.startsWith(`${key}:`)), `error should name ${key}`);
    }
    // explicit undefined is rejected too (strict null)
    assert.equal(validateAthleteContext({ ...valid(), training_level: undefined }).valid, false);
  });
});
