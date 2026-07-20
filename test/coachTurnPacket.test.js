'use strict';

// CoachTurnPacket contract — Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md).
//
// The assembled truth of one coach turn, keyed by the InteractionTrace turn_id and
// embedding the other six contracts' facts. Pure builder + total validator that
// DELEGATES to each sibling contract's validator (the one-Brain property). Read-only;
// not yet wired (Phase 3 assembles it in shadow, Phase 4 route consumes it).

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  buildCoachTurnPacket,
  validateCoachTurnPacket,
  _resetForTesting,
} = require('../services/coachTurnPacket');
const { buildWorkoutSession } = require('../services/workoutSession');
const { buildSafetyDecision } = require('../services/safetyDecision');
const { buildCloseoutTransaction } = require('../services/closeoutTransaction');

beforeEach(() => _resetForTesting());

// valid embedded facts (each validates under its own contract)
const athlete = () => ({ schema_version: 1, profile_goal: 'strength', training_level: 'intermediate', population: 'general', equipment_profile: { barbell: true, dumbbells: true } });
const session = () => buildWorkoutSession({ session_id: 's1', slots: [{ name: 'Bench Press', lift_code: 'BENCH', status: 'pending', sets_logged: 0, sets_target: 3 }] });
const exercise = () => ({ schema_version: 1, exercise_id: 'conventional-deadlift', canonical_name: 'Conventional Deadlift', lift_code: 'DL', muscle_group: 'Posterior Chain', movement_pattern: 'hinge', aliases: ['Deadlift'] });
const decision = () => ({
  schema_version: 1, intent: { type: 'best_workout', constraints: {}, source: 'button' },
  decision_type: 'workout', status: 'answered',
  confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
  safety: { level: 'green', flags: [], blocking: false },
  payload: { session_label: 'Upper', blocks: [{ exercise: 'Bench', lift_code: 'BENCH', sets: 3, reps: 5, target_weight: 185, target_rir: 2 }] },
  missing_info: [], explanation_inputs: { blocks: [{ target_weight: 185, reps: 5, target_rir: 2 }] },
  provenance: { modules_run: ['confidence'], skipped: [], state_asOf: null, engine_version: '1' },
});
// SafetyDecision consistent with decision().safety = { level: 'green', blocking: false }
const safety = () => buildSafetyDecision({ state: 'green', confidence: 'none', signals: [], reason: null });
const closeout = () => buildCloseoutTransaction({
  session_id: 's1', session_date: '2026-07-20', test_mode: true, log_rows: [], effort_row: null,
  seal: { count: 0, already_sealed: 0 },
  proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true, log_rows_written: null, logAppendedRange: null },
});

const fullPacket = () => buildCoachTurnPacket({
  turn_id: 't_abc', athlete: athlete(), session: session(), exercises: [exercise()],
  decision: decision(), safety: safety(), closeout: closeout(),
});

describe('buildCoachTurnPacket', () => {
  it('stamps schema_version, passes turn_id, defaults embedded facts null / exercises []', () => {
    const p = buildCoachTurnPacket({ turn_id: 't1' });
    assert.equal(p.schema_version, SCHEMA_VERSION);
    assert.equal(p.turn_id, 't1');
    assert.equal(p.athlete, null);
    assert.equal(p.session, null);
    assert.deepEqual(p.exercises, []);
    assert.equal(p.decision, null);
    assert.equal(p.safety, null);
    assert.equal(p.closeout, null);
  });
  it('tolerates junk input without throwing', () => {
    assert.deepEqual(buildCoachTurnPacket(undefined).exercises, []);
    assert.equal(buildCoachTurnPacket(null).turn_id, undefined);
  });
});

describe('validateCoachTurnPacket', () => {
  it('accepts a fully-assembled packet', () => {
    const r = validateCoachTurnPacket(fullPacket());
    assert.equal(r.valid, true, r.errors.join(' | '));
  });
  it('accepts a minimal packet: just a turn_id, everything else null / empty', () => {
    assert.equal(validateCoachTurnPacket(buildCoachTurnPacket({ turn_id: 't1' })).valid, true);
  });
  it('rejects a non-object, wrong schema_version, and a missing turn_id', () => {
    assert.equal(validateCoachTurnPacket(null).valid, false);
    assert.equal(validateCoachTurnPacket({ ...fullPacket(), schema_version: 2 }).valid, false);
    assert.equal(validateCoachTurnPacket({ ...fullPacket(), turn_id: '' }).valid, false);
  });
  it('requires each embedded fact present (explicit-null): an omitted key is rejected', () => {
    const noSession = { ...fullPacket() }; delete noSession.session;
    assert.equal(validateCoachTurnPacket(noSession).valid, false);
    const noCloseout = { ...fullPacket() }; delete noCloseout.closeout;
    assert.equal(validateCoachTurnPacket(noCloseout).valid, false);
  });

  it('DELEGATES to each sibling validator — an invalid embedded fact fails the packet (one Brain)', () => {
    // a WorkoutSession with a bad slot status
    const badSession = { ...fullPacket(), session: buildWorkoutSession({ session_id: 's1', slots: [{ name: 'X', status: 'nope' }] }) };
    const r1 = validateCoachTurnPacket(badSession);
    assert.equal(r1.valid, false);
    assert.ok(r1.errors.some((e) => e.startsWith('session.')), 'sub-error surfaced under session.*');
    // an invalid ExerciseIdentity in the list
    const badExercise = { ...fullPacket(), exercises: [{ ...exercise(), exercise_id: 'Not Kebab Case' }] };
    const r2 = validateCoachTurnPacket(badExercise);
    assert.equal(r2.valid, false);
    assert.ok(r2.errors.some((e) => e.startsWith('exercises[0].')), 'sub-error surfaced under exercises[0].*');
    // an invalid embedded SafetyDecision (unknown state)
    const badSafety = { ...fullPacket(), safety: { ...safety(), state: 'amber' }, decision: null };
    assert.equal(validateCoachTurnPacket(badSafety).valid, false);
  });

  it('enforces the single-safety-verdict consistency (H-12) when safety and decision are both present', () => {
    // STATE disagreement: a valid yellow verdict against a green decision.safety.level
    const stateMismatch = {
      ...fullPacket(),
      safety: buildSafetyDecision({ state: 'yellow', blocking: false, confidence: 'low', signals: ['low readiness'], reason: null }),
    };
    assert.equal(validateCoachTurnPacket(stateMismatch).valid, false);

    // BLOCKING disagreement, isolated: both facts individually valid, same state
    // ('yellow', which may block either way), but blocking differs.
    const yellowDecision = { ...decision(), safety: { level: 'yellow', flags: [], blocking: false } };
    const blockingMismatch = buildCoachTurnPacket({
      ...fullPacket(),
      decision: yellowDecision,
      safety: buildSafetyDecision({ state: 'yellow', blocking: true, confidence: 'low', signals: ['low readiness'], reason: null }),
    });
    const r = validateCoachTurnPacket(blockingMismatch);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('safety consistency')), 'a safety-consistency error is surfaced');

    // AGREEMENT (yellow non-blocking on both) passes
    const agree = buildCoachTurnPacket({
      ...fullPacket(),
      decision: yellowDecision,
      safety: buildSafetyDecision({ state: 'yellow', blocking: false, confidence: 'low', signals: ['low readiness'], reason: null }),
    });
    assert.equal(validateCoachTurnPacket(agree).valid, true, validateCoachTurnPacket(agree).errors.join(' | '));
    // and the canonical green/green full packet passes
    assert.equal(validateCoachTurnPacket(fullPacket()).valid, true);
  });
  it('does not apply the safety/decision consistency rule when either is absent', () => {
    assert.equal(validateCoachTurnPacket({ ...fullPacket(), decision: null }).valid, true);
    assert.equal(validateCoachTurnPacket({ ...fullPacket(), safety: null }).valid, true);
  });

  it('enforces one session per packet: session.session_id must match closeout.session_id (Codex #1095)', () => {
    // mismatched non-null ids → rejected (facts tied to a different session than the write proof)
    const mismatch = buildCoachTurnPacket({
      ...fullPacket(),
      session: buildWorkoutSession({ session_id: 'session-A', slots: [{ name: 'Bench', status: 'pending' }] }),
      closeout: buildCloseoutTransaction({ session_id: 'session-B', session_date: '2026-07-20', test_mode: true, proof: { sheet_write: 'skipped', sheet_written: false, no_write_confirmed: true } }),
    });
    const r = validateCoachTurnPacket(mismatch);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('session consistency')), 'a session-consistency error is surfaced');
    // matching ids (the base fixture uses s1 for both) → valid
    assert.equal(validateCoachTurnPacket(fullPacket()).valid, true);
    // a null session_id (unknown) does not trigger the check — only non-null ids are compared
    const nullSid = buildCoachTurnPacket({
      ...fullPacket(),
      session: buildWorkoutSession({ slots: [{ name: 'Bench', status: 'pending' }] }),
    });
    assert.equal(validateCoachTurnPacket(nullSid).valid, true, validateCoachTurnPacket(nullSid).errors.join(' | '));
  });
});
