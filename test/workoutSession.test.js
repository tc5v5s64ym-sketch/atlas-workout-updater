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
  fromActiveSession,
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

describe('fromActiveSession (boundary adapter — Codex #1090)', () => {
  // The live client shape src/app/activeSession.js emits.
  const clientSession = {
    exercises: [
      { name: 'Back Squat', liftCode: 'SQ', status: 'completed', source: 'planned' },
      { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'substituted' },
    ],
  };

  it('converts the live client model into a VALID canonical WorkoutSession', () => {
    const ws = fromActiveSession(clientSession, { session_id: 's_9' });
    const r = validateWorkoutSession(ws);
    assert.equal(r.valid, true, r.errors.join(' | '));
    assert.equal(ws.session_id, 's_9');
  });

  it('maps liftCode→lift_code, preserves status/source, and defaults tallies', () => {
    const ws = fromActiveSession(clientSession);
    assert.deepEqual(ws.slots[0], { name: 'Back Squat', lift_code: 'SQ', status: 'completed', source: 'planned', sets_logged: 0, sets_target: null });
    assert.equal(ws.slots[1].source, 'substituted');
    assert.equal(ws.session_id, null);
    // the derived cursor works on the converted session
    assert.equal(currentSlot(ws).name, 'Bench Press');
  });

  it('tolerates an empty / malformed client session', () => {
    assert.equal(validateWorkoutSession(fromActiveSession({})).valid, true);
    assert.equal(validateWorkoutSession(fromActiveSession(null)).valid, true);
    assert.deepEqual(fromActiveSession({ exercises: 'nope' }).slots, []);
  });
});

// D10 — discussion_referent: the canonical key of the lift the conversation is about, set at
// answer time so a bare correction resolves from ONE state read. Optional + nullable: this first
// increment adds the field; a session that predates it still validates.
describe('discussion_referent (D10 — packet referent field)', () => {
  it('the builder defaults it to null and carries a provided referent', () => {
    assert.equal(buildWorkoutSession({ slots: [] }).discussion_referent, null);
    assert.equal(buildWorkoutSession({ discussion_referent: 'BENCHPRESS', slots: [] }).discussion_referent, 'BENCHPRESS');
  });

  it('validates when present as null or a non-empty canonical key', () => {
    assert.equal(validateWorkoutSession({ ...valid(), discussion_referent: 'BENCHPRESS' }).valid, true);
    assert.equal(validateWorkoutSession({ ...valid(), discussion_referent: null }).valid, true);
    assert.equal(validateWorkoutSession(buildWorkoutSession({ session_id: 's', discussion_referent: 'SQUAT', slots: [] })).valid, true);
  });

  it('is OPTIONAL — a session that omits the field (predating D10) still validates', () => {
    const legacy = { ...valid() };
    delete legacy.discussion_referent; // valid() never sets it
    assert.equal(validateWorkoutSession(legacy).valid, true);
  });

  it('rejects a non-string, non-null referent when present', () => {
    assert.equal(validateWorkoutSession({ ...valid(), discussion_referent: 42 }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), discussion_referent: '' }).valid, false);
    assert.equal(validateWorkoutSession({ ...valid(), discussion_referent: {} }).valid, false);
  });

  it('fromActiveSession carries a provided referent through the boundary adapter', () => {
    const ws = fromActiveSession({ exercises: [{ name: 'Bench Press', liftCode: 'BEN01', status: 'pending', source: 'planned' }] }, { session_id: 's', discussion_referent: 'BENCHPRESS' });
    assert.equal(ws.discussion_referent, 'BENCHPRESS');
    assert.equal(validateWorkoutSession(ws).valid, true);
    assert.equal(fromActiveSession({ exercises: [] }).discussion_referent, null, 'defaults to null when not provided');
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
