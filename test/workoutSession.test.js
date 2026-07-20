'use strict';

// WorkoutSession contract — Phase 2 Work item 2 (docs/CANONICAL_CONTRACTS.md).
//
// The in-progress session-truth spine: ordered slots + a derived cursor. Names
// and versions the src/app/activeSession.js model. Pure builder + total validator
// + derived selectors. Read-only; not yet wired.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  buildWorkoutSession,
  validateWorkoutSession,
  currentSlot,
  remainingSlots,
  isComplete,
  SLOT_STATUSES,
  SLOT_SOURCES,
  _resetForTesting,
} = require('../services/workoutSession');

beforeEach(() => _resetForTesting());

const slot = (over = {}) => ({ name: 'Back Squat', lift_code: 'SQ', status: 'pending', source: 'planned', sets_logged: 0, sets_target: 3, ...over });
const valid = () => ({ schema_version: SCHEMA_VERSION, session_id: 's_1', slots: [slot(), slot({ name: 'Bench Press', lift_code: 'BENCH' })] });

describe('buildWorkoutSession', () => {
  it('stamps schema_version, defaults session_id null / slots [] and normalizes slots', () => {
    const s = buildWorkoutSession({ slots: [{ name: 'Deadlift' }] });
    assert.equal(s.schema_version, SCHEMA_VERSION);
    assert.equal(s.session_id, null);
    assert.deepEqual(s.slots[0], { name: 'Deadlift', lift_code: null, status: 'pending', source: 'planned', sets_logged: 0, sets_target: null });
  });
  it('tolerates junk input without throwing', () => {
    assert.deepEqual(buildWorkoutSession(undefined).slots, []);
    assert.equal(buildWorkoutSession(null).session_id, null);
  });
});

describe('validateWorkoutSession', () => {
  it('accepts a well-formed session', () => {
    const r = validateWorkoutSession(valid());
    assert.equal(r.valid, true, r.errors.join(' | '));
  });
  it('accepts an empty (not-yet-planned) session', () => {
    assert.equal(validateWorkoutSession(buildWorkoutSession({ session_id: null })).valid, true);
  });
  it('rejects a non-object, wrong schema_version, and a non-array slots', () => {
    assert.equal(validateWorkoutSession(null).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), schema_version: 2 }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), slots: 'x' }).valid, false);
  });
  it('requires session_id present (null or non-empty string)', () => {
    const noKey = { ...valid() }; delete noKey.session_id;
    assert.equal(validateWorkoutSession(noKey).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), session_id: '' }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), session_id: null }).valid, true);
  });
  it('validates slot status and source against the enums', () => {
    assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ status: 'done' })] }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ source: 'random' })] }).valid, false);
    for (const st of SLOT_STATUSES) assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ status: st })] }).valid, true, `status ${st}`);
    for (const sr of SLOT_SOURCES) assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ source: sr })] }).valid, true, `source ${sr}`);
  });
  it('validates the set tallies (sets_logged int>=0; sets_target null or int>=1)', () => {
    assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ sets_logged: -1 })] }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ sets_logged: 1.5 })] }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ sets_target: 0 })] }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), slots: [slot({ sets_target: null })] }).valid, true);
  });
  it('requires slot lift_code / sets_target to be PRESENT (explicit null)', () => {
    const s1 = slot(); delete s1.lift_code;
    assert.equal(validateWorkoutSession({ ...valid(), slots: [s1] }).valid, false);
    const s2 = slot(); delete s2.sets_target;
    assert.equal(validateWorkoutSession({ ...valid(), slots: [s2] }).valid, false);
  });
  it('allows duplicate slot names (F10 — independent slots)', () => {
    const s = { ...valid(), slots: [slot({ name: 'Bench Press' }), slot({ name: 'Bench Press' })] };
    assert.equal(validateWorkoutSession(s).valid, true);
  });
});

describe('derived selectors (single owner of session-truth cursor)', () => {
  it('currentSlot is the first pending slot; advances as slots complete', () => {
    const s = { ...valid(), slots: [slot({ name: 'A', status: 'completed' }), slot({ name: 'B' }), slot({ name: 'C' })] };
    assert.equal(currentSlot(s).name, 'B');
    const s2 = { ...s, slots: s.slots.map((x) => x.name === 'B' ? { ...x, status: 'completed' } : x) };
    assert.equal(currentSlot(s2).name, 'C');
  });
  it('currentSlot is null when nothing is pending; remainingSlots lists the pending', () => {
    const done = { ...valid(), slots: [slot({ status: 'completed' }), slot({ status: 'skipped' })] };
    assert.equal(currentSlot(done), null);
    assert.equal(remainingSlots(valid()).length, 2);
  });
  it('isComplete: had slots and none pending (all-skipped counts as complete)', () => {
    assert.equal(isComplete(valid()), false);
    assert.equal(isComplete({ ...valid(), slots: [slot({ status: 'completed' })] }), true);
    assert.equal(isComplete(buildWorkoutSession({})), false, 'empty session is not complete');
  });
});
