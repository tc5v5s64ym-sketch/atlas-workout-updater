'use strict';

// ExerciseIdentity contract — Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md).
//
// The immutable identity of an exercise; every name/alias and stored
// representation is a projection. Pure builder + total validator, mirroring the
// shipped CoachingDecision contract. Read-only; not yet wired.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  buildExerciseIdentity,
  validateExerciseIdentity,
  MOVEMENT_PATTERNS,
  _resetForTesting,
} = require('../services/exerciseIdentity');

beforeEach(() => _resetForTesting());

const valid = () => ({
  schema_version: SCHEMA_VERSION,
  exercise_id: 'back-squat',
  canonical_name: 'Back Squat',
  lift_code: 'SQ',
  muscle_group: 'Quads',
  movement_pattern: 'squat',
  aliases: ['Barbell Back Squat', 'High-Bar Squat'],
});

describe('buildExerciseIdentity', () => {
  it('stamps schema_version and defaults nullable projections + aliases', () => {
    const id = buildExerciseIdentity({ exercise_id: 'bench-press', canonical_name: 'Bench Press' });
    assert.equal(id.schema_version, SCHEMA_VERSION);
    assert.equal(id.exercise_id, 'bench-press');
    assert.equal(id.canonical_name, 'Bench Press');
    assert.equal(id.lift_code, null);
    assert.equal(id.muscle_group, null);
    assert.equal(id.movement_pattern, null);
    assert.deepEqual(id.aliases, []);
  });
  it('passes through provided projections and aliases', () => {
    const id = buildExerciseIdentity(valid());
    assert.equal(id.movement_pattern, 'squat');
    assert.deepEqual(id.aliases, ['Barbell Back Squat', 'High-Bar Squat']);
  });
  it('tolerates junk input without throwing', () => {
    assert.equal(buildExerciseIdentity(undefined).schema_version, SCHEMA_VERSION);
    assert.deepEqual(buildExerciseIdentity(null).aliases, []);
  });
});

describe('validateExerciseIdentity', () => {
  it('accepts a well-formed identity', () => {
    const r = validateExerciseIdentity(valid());
    assert.equal(r.valid, true, r.errors.join(' | '));
  });

  it('accepts null projections (identity with no lift_code/muscle_group/pattern yet)', () => {
    const r = validateExerciseIdentity(buildExerciseIdentity({ exercise_id: 'ab-wheel', canonical_name: 'Ab Wheel Rollout' }));
    assert.equal(r.valid, true, r.errors.join(' | '));
  });

  it('rejects a non-object', () => {
    assert.equal(validateExerciseIdentity(null).valid, false);
    assert.equal(validateExerciseIdentity('back-squat').valid, false);
  });

  it('rejects a wrong schema_version', () => {
    const r = validateExerciseIdentity({ ...valid(), schema_version: 2 });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('schema_version')));
  });

  it('requires a non-empty kebab-case exercise_id', () => {
    assert.equal(validateExerciseIdentity({ ...valid(), exercise_id: '' }).valid, false);
    assert.equal(validateExerciseIdentity({ ...valid(), exercise_id: 'Back Squat' }).valid, false);
    assert.equal(validateExerciseIdentity({ ...valid(), exercise_id: 'Back_Squat' }).valid, false);
    assert.equal(validateExerciseIdentity({ ...valid(), exercise_id: 'back-squat' }).valid, true);
  });

  it('requires a non-empty canonical_name', () => {
    const r = validateExerciseIdentity({ ...valid(), canonical_name: '   ' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('canonical_name')));
  });

  it('rejects an unknown movement_pattern but accepts a known one', () => {
    assert.equal(validateExerciseIdentity({ ...valid(), movement_pattern: 'jumping' }).valid, false);
    assert.equal(validateExerciseIdentity({ ...valid(), movement_pattern: 'hinge' }).valid, true);
    // every enum member is accepted
    for (const p of MOVEMENT_PATTERNS) {
      assert.equal(validateExerciseIdentity({ ...valid(), movement_pattern: p }).valid, true, `pattern ${p}`);
    }
  });

  it('rejects duplicate aliases and an alias echoing the canonical_name', () => {
    assert.equal(validateExerciseIdentity({ ...valid(), aliases: ['A', 'A'] }).valid, false);
    assert.equal(validateExerciseIdentity({ ...valid(), aliases: ['back squat'] }).valid, false, 'canonical_name is not its own alias');
    assert.equal(validateExerciseIdentity({ ...valid(), aliases: [123] }).valid, false);
  });

  it('rejects a malformed nullable projection', () => {
    assert.equal(validateExerciseIdentity({ ...valid(), lift_code: '' }).valid, false);
    assert.equal(validateExerciseIdentity({ ...valid(), muscle_group: 42 }).valid, false);
  });
});
