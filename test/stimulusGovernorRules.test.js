'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROFILES,
  MODALITY_CATEGORIES,
  PROGRESSION_VERDICTS,
  FATIGUE_SIGNALS,
  governorRuleFor,
} = require('../services/stimulusGovernorRules');

// ---------------------------------------------------------------------------
// PR 481 — Stimulus Governor Fixtures (Training Profile Taxonomy §5).
// Pin the profile×modality RIR/effort rules + output vocabularies BEFORE the
// governor that applies them ships (PR 482), so any rule change is test-gated.
// ---------------------------------------------------------------------------

test('controlled vocabularies are pinned and frozen', () => {
  assert.deepEqual(PROFILES, ['strength', 'hypertrophy', 'general_fitness', 'cardio', 'bodyweight']);
  assert.deepEqual(MODALITY_CATEGORIES, ['resistance', 'bodyweight', 'cardio', 'timed', 'circuit']);
  assert.deepEqual(PROGRESSION_VERDICTS, ['+load', '+reps', '+rounds', '+duration', 'hold', 'back_off']);
  assert.deepEqual(FATIGUE_SIGNALS, ['none', 'elevated', 'high']);
  for (const v of [PROFILES, MODALITY_CATEGORIES, PROGRESSION_VERDICTS, FATIGUE_SIGNALS]) {
    assert.ok(Object.isFrozen(v));
  }
});

// §5 table, row by row (resistance modality where RIR is relevant).
test('§5: strength — RIR 0 on a heavy compound blocks progression', () => {
  const r = governorRuleFor('strength', 'resistance');
  assert.equal(r.effort_interpretation, 'rir');
  assert.equal(r.rir_relevant, true);
  assert.deepEqual(r.rir_band, [1, 3]);
  assert.equal(r.rir0_blocks_progression, true);
  assert.equal(r.rir0_caution, false);
  assert.ok(r.allowed_verdicts.includes('+load'));
});

test('§5: hypertrophy — RIR 0 cautioned on heavy compounds, ok on isolation, not blocked', () => {
  const r = governorRuleFor('hypertrophy', 'resistance');
  assert.deepEqual(r.rir_band, [0, 3]);
  assert.equal(r.rir0_blocks_progression, false);
  assert.equal(r.rir0_caution, true);
  assert.equal(r.rir0_ok_isolation, true);
});

test('§5: general_fitness — rewards consistency over maximal effort; RIR 0 not needed', () => {
  const r = governorRuleFor('general_fitness', 'resistance');
  assert.deepEqual(r.rir_band, [2, 4]);
  assert.equal(r.reward_consistency, true);
  assert.equal(r.rir0_blocks_progression, false);
});

test('§5: cardio modality makes RIR irrelevant regardless of profile', () => {
  for (const profile of PROFILES) {
    const r = governorRuleFor(profile, 'cardio');
    assert.equal(r.rir_relevant, false, `${profile}+cardio: RIR must be irrelevant`);
    assert.equal(r.effort_interpretation, 'hr_zone_pace');
    assert.equal(r.rir_band, null);
    assert.equal(r.rir0_blocks_progression, false);
    assert.deepEqual(r.allowed_verdicts, ['+duration', 'hold', 'back_off']);
  }
});

test('§5: bodyweight — reps/RIR read; RIR 0 fine on strict-strength sets; +reps reachable', () => {
  const r = governorRuleFor('bodyweight', 'bodyweight');
  assert.equal(r.effort_interpretation, 'reps_rir');
  assert.equal(r.rir_relevant, true);
  assert.equal(r.rir0_blocks_progression, false);
  assert.ok(r.allowed_verdicts.includes('+reps'));
});

test('§5: circuits judged by rounds/density, not RIR', () => {
  const r = governorRuleFor('bodyweight', 'circuit');
  assert.equal(r.effort_interpretation, 'rounds_density');
  assert.equal(r.rir_relevant, false);
  assert.deepEqual(r.allowed_verdicts, ['+rounds', 'hold', 'back_off']);
});

test('timed holds read duration, not RIR', () => {
  const r = governorRuleFor('general_fitness', 'timed');
  assert.equal(r.effort_interpretation, 'duration_rpe');
  assert.equal(r.rir_relevant, false);
  assert.deepEqual(r.allowed_verdicts, ['+duration', 'hold', 'back_off']);
});

test('a strength lifter doing cardio is judged by the cardio rule (profile + modality)', () => {
  const r = governorRuleFor('strength', 'cardio');
  assert.equal(r.rir_relevant, false);
  assert.equal(r.effort_interpretation, 'hr_zone_pace');
});

test('every allowed_verdict is in the PROGRESSION_VERDICTS vocabulary', () => {
  for (const profile of PROFILES) {
    for (const modality of MODALITY_CATEGORIES) {
      const r = governorRuleFor(profile, modality);
      assert.ok(r, `${profile}×${modality} must resolve`);
      for (const v of r.allowed_verdicts) {
        assert.ok(PROGRESSION_VERDICTS.includes(v), `${profile}×${modality}: ${v} out of vocab`);
      }
    }
  }
});

test('unknown profile or modality returns null', () => {
  assert.equal(governorRuleFor('nope', 'resistance'), null);
  assert.equal(governorRuleFor('strength', 'nope'), null);
  assert.equal(governorRuleFor(null, null), null);
});
