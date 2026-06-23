'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assessRecoveryDeload,
  RECOVERY_DECISIONS,
  DELOAD_STYLES,
} = require('../services/recoveryDeloadSelection');

// ---------------------------------------------------------------------------
// PR 485 — Recovery & Deload SELECTION engine (Session Planning Engine §10).
// Pins the §10.5 decision ladder + §10.7 fixtures. Selection/rationale only —
// no prescription numbers (those stay in computePrescription / DELOAD_SPEC).
// Pure, fixture-protected, unwired.
// ---------------------------------------------------------------------------

const decide = (s) => assessRecoveryDeload(s).decision;

// §10.7 fixtures — convergence-based (no deload after one bad session).
test('single_bad_session_no_deload: one bad session → normal, NOT a deload', () => {
  const r = assessRecoveryDeload({ rir0_main_sessions: 1 });
  assert.equal(r.decision, 'normal');
  assert.equal(r.deload_candidate, false);
});

test('local_fatigue_micro_adjustment: one local signal → micro_adjustment', () => {
  assert.equal(decide({ local_fatigue_signal: true }), 'micro_adjustment');
});

test('repeated_rir0_main_lift_deload: 2 consecutive RIR 0 on main lifts → deload candidate', () => {
  const r = assessRecoveryDeload({ rir0_main_sessions: 2, profile: 'strength' });
  assert.equal(r.decision, 'deload');
  assert.equal(r.deload_candidate, true);
});

test('high_soreness_plus_poor_sleep_recovery_reload: stacked soreness + poor sleep → recovery_reload', () => {
  const r = assessRecoveryDeload({ high_soreness: true, subjective_fatigue: true });
  assert.equal(r.decision, 'recovery_reload');
  assert.equal(r.deload_candidate, false);
});

test('repeated performance decline + subjective fatigue → deload (§10.5 #4)', () => {
  assert.equal(decide({ performance_decline: true, subjective_fatigue: true }), 'deload');
  // Performance decline ALONE (no subjective/soreness) is not yet a deload.
  assert.notEqual(decide({ performance_decline: true }), 'deload');
});

test('readiness red for 3 planned days → deload candidate', () => {
  assert.equal(decide({ readiness_red_days: 3 }), 'deload');
  assert.notEqual(decide({ readiness_red_days: 2 }), 'deload'); // below threshold
});

// §10.4 profile-aware styling (descriptors only, no numbers).
test('a deload is styled by profile (selection descriptors, never prescription numbers)', () => {
  for (const profile of ['strength', 'hypertrophy', 'general_fitness', 'cardio', 'bodyweight']) {
    const r = assessRecoveryDeload({ rir0_main_sessions: 2, profile });
    assert.equal(r.deload_style.profile, profile);
    assert.deepEqual(r.deload_style.focus, DELOAD_STYLES[profile]);
    // Guard the "no numbers" contract: no load/volume figures in the style text.
    for (const line of r.deload_style.focus) {
      assert.doesNotMatch(line, /\d/, `deload style must carry no numbers: ${line}`);
    }
  }
  // Strength deload preserves main-lift feel + cuts accessory volume first.
  const strength = assessRecoveryDeload({ rir0_main_sessions: 2, profile: 'strength' });
  assert.ok(strength.deload_style.focus.join(' ').match(/accessory volume first/));
});

test('a deload for an unknown profile still triggers, with a null style', () => {
  const r = assessRecoveryDeload({ rir0_main_sessions: 2, profile: 'made_up' });
  assert.equal(r.decision, 'deload');
  assert.equal(r.deload_style, null);
});

// §10.5 #5 — pain override is separate from the deload decision.
test('major pain → pain_override (pivot/stop), independent of the fatigue decision', () => {
  const r = assessRecoveryDeload({ pain_major: true, pain_pattern: 'hinge', local_fatigue_signal: true });
  assert.deepEqual(r.pain_override, { pattern: 'hinge', action: 'pivot_or_stop' });
  // Pain alone does not force a deload — the fatigue decision stands on its own.
  assert.equal(r.decision, 'micro_adjustment');
  assert.equal(assessRecoveryDeload({ pain_major: true, pain_pattern: 'knee' }).deload_candidate, false);
});

// §10.5 #6/#7 — taper and complete rest override a generic deload.
test('test date approaching → taper (not a generic deload), even with deload signals', () => {
  assert.equal(decide({ test_date_approaching: true, rir0_main_sessions: 2 }), 'taper');
});

test('illness / injury flare → complete_rest (highest-priority context)', () => {
  assert.equal(decide({ illness_or_injury_flare: true, rir0_main_sessions: 2 }), 'complete_rest');
});

test('every decision is in the RECOVERY_DECISIONS vocabulary; empty input is safe', () => {
  const cases = [{}, { rir0_main_sessions: 5 }, { local_fatigue_signal: true }, { high_soreness: true, effort_drift: true }];
  for (const c of cases) {
    const r = assessRecoveryDeload(c);
    assert.ok(RECOVERY_DECISIONS.includes(r.decision), `decision ${r.decision} out of vocab`);
    assert.equal(typeof r.rationale, 'string');
    assert.ok(Array.isArray(r.converged_signals));
  }
  assert.equal(assessRecoveryDeload({}).decision, 'normal');
  assert.ok(Object.isFrozen(RECOVERY_DECISIONS));
});
