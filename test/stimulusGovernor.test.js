'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { gradeStimulus } = require('../services/stimulusGovernor');
const { PROGRESSION_VERDICTS, FATIGUE_SIGNALS, governorRuleFor } = require('../services/stimulusGovernorRules');

// ---------------------------------------------------------------------------
// PR 482 — Profile-aware Stimulus Governor (Taxonomy §5). Applies the PR 481
// rules to a logged effort → { effort_interpretation, progression_verdict,
// fatigue_signal }. Pure, unwired. Goldens pin the profile×modality grading.
// ---------------------------------------------------------------------------

function grade(o) { return gradeStimulus(o); }

test('strength: RIR 0 on a heavy compound blocks progression (hold + high fatigue)', () => {
  const r = grade({ profile: 'strength', modalityCategory: 'resistance', rir: 0, is_heavy_compound: true });
  assert.equal(r.progression_verdict, 'hold');
  assert.equal(r.fatigue_signal, 'high');
  assert.equal(r.effort_interpretation, 'rir');
});

test('strength: RIR 0 on an isolation is acceptable → earns +load', () => {
  const r = grade({ profile: 'strength', modalityCategory: 'resistance', rir: 0, is_heavy_compound: false });
  assert.equal(r.progression_verdict, '+load');
  assert.equal(r.fatigue_signal, 'elevated');
});

test('hypertrophy: RIR 0 on a heavy compound is cautioned (hold + elevated), not blocked-as-high', () => {
  const r = grade({ profile: 'hypertrophy', modalityCategory: 'resistance', rir: 0, is_heavy_compound: true });
  assert.equal(r.progression_verdict, 'hold');
  assert.equal(r.fatigue_signal, 'elevated');
});

test('general_fitness: RIR 0 on an accessory is NOT rewarded (hold) — consistency over max effort', () => {
  const r = grade({ profile: 'general_fitness', modalityCategory: 'resistance', rir: 0, is_heavy_compound: false });
  assert.equal(r.progression_verdict, 'hold');
});

test('under-target reserve earns the modality progress verdict', () => {
  assert.equal(grade({ profile: 'strength', modalityCategory: 'resistance', rir: 4, target_rir: 2 }).progression_verdict, '+load');
  assert.equal(grade({ profile: 'bodyweight', modalityCategory: 'bodyweight', rir: 4, target_rir: 2 }).progression_verdict, '+reps');
});

test('at-target reserve holds (the load engine owns any increment)', () => {
  const r = grade({ profile: 'strength', modalityCategory: 'resistance', rir: 2, target_rir: 2 });
  assert.equal(r.progression_verdict, 'hold');
  assert.equal(r.fatigue_signal, 'none');
});

test('bodyweight strict-strength RIR 0 is fine → +reps', () => {
  const r = grade({ profile: 'bodyweight', modalityCategory: 'bodyweight', rir: 0, is_heavy_compound: false });
  assert.equal(r.progression_verdict, '+reps');
  assert.equal(r.effort_interpretation, 'reps_rir');
});

test('cardio is judged by metric trend, not RIR (RIR irrelevant)', () => {
  assert.equal(grade({ profile: 'cardio', modalityCategory: 'cardio', metric_trend: 'improved' }).progression_verdict, '+duration');
  assert.equal(grade({ profile: 'cardio', modalityCategory: 'cardio', metric_trend: 'steady' }).progression_verdict, 'hold');
  const declined = grade({ profile: 'cardio', modalityCategory: 'cardio', metric_trend: 'declined' });
  assert.equal(declined.progression_verdict, 'back_off');
  assert.equal(declined.fatigue_signal, 'elevated');
  // A logged RIR on a cardio modality is ignored (RIR irrelevant).
  assert.equal(grade({ profile: 'cardio', modalityCategory: 'cardio', rir: 0, metric_trend: 'improved' }).effort_interpretation, 'hr_zone_pace');
});

test('circuits earn +rounds on improvement (density, not RIR)', () => {
  assert.equal(grade({ profile: 'bodyweight', modalityCategory: 'circuit', metric_trend: 'improved' }).progression_verdict, '+rounds');
});

test('no RIR on a RIR-relevant modality → hold (not gradeable), never a fabricated push', () => {
  const r = grade({ profile: 'strength', modalityCategory: 'resistance', rir: null });
  assert.equal(r.progression_verdict, 'hold');
  assert.equal(r.fatigue_signal, 'none');
});

test('every emitted verdict + fatigue signal is in the controlled vocabularies', () => {
  const cases = [
    { profile: 'strength', modalityCategory: 'resistance', rir: 0, is_heavy_compound: true },
    { profile: 'hypertrophy', modalityCategory: 'resistance', rir: 4, target_rir: 1 },
    { profile: 'general_fitness', modalityCategory: 'timed', metric_trend: 'declined' },
    { profile: 'cardio', modalityCategory: 'cardio', metric_trend: 'improved' },
    { profile: 'bodyweight', modalityCategory: 'circuit', metric_trend: 'steady' },
  ];
  for (const c of cases) {
    const r = grade(c);
    assert.ok(PROGRESSION_VERDICTS.includes(r.progression_verdict), `verdict ${r.progression_verdict} out of vocab`);
    assert.ok(FATIGUE_SIGNALS.includes(r.fatigue_signal), `fatigue ${r.fatigue_signal} out of vocab`);
    assert.ok(r.rule && governorRuleFor(c.profile, c.modalityCategory), 'rule attached for traceability');
    assert.ok(r.allowed_verdicts === undefined || true); // rule carries allowed_verdicts
    assert.ok(r.rule.allowed_verdicts.includes(r.progression_verdict), 'verdict must be allowed for the modality');
  }
});

test('unknown profile or modality returns null', () => {
  assert.equal(grade({ profile: 'nope', modalityCategory: 'resistance', rir: 2 }), null);
  assert.equal(grade({ profile: 'strength', modalityCategory: 'nope', rir: 2 }), null);
  assert.equal(grade({}), null);
});
