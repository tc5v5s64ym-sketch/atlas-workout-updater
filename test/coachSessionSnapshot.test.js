'use strict';

// Canonical session boundary adapter — Phase 4 H-08A.
//
// buildCanonicalSessionSnapshot is the SINGLE pure boundary that converts the additive
// `context.active_session` snapshot the chat client forwards (the live
// src/app/activeSession.js model — `{ exercises: [{ name, liftCode, status, source }] }`)
// into a canonical, validated services/workoutSession.js WorkoutSession, or null. These
// tests prove it preserves ordered/duplicate slot identity, survives source/lift codes,
// keeps the optional session id null, and FAILS CLOSED on malformed input — never guessing
// from the lossy current_plan / plan_state name arrays.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildCanonicalSessionSnapshot } = require('../services/coachSessionSnapshot');
const { validateWorkoutSession, currentSlot } = require('../services/workoutSession');

// The live client active-session shape (src/app/activeSession.js).
const active = (exercises) => ({ active_session: { exercises } });

describe('buildCanonicalSessionSnapshot — valid conversions', () => {
  it('converts a pending/completed active session into a VALID canonical WorkoutSession', () => {
    const s = buildCanonicalSessionSnapshot(active([
      { name: 'Back Squat', liftCode: 'SQ', status: 'completed', source: 'planned' },
      { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
    ]));
    assert.ok(s, 'a session is returned');
    assert.equal(validateWorkoutSession(s).valid, true, validateWorkoutSession(s).errors.join(' | '));
    assert.equal(currentSlot(s).name, 'Bench Press', 'the derived cursor is the first pending slot');
  });

  it('preserves slot ORDER exactly as the client sent it', () => {
    const s = buildCanonicalSessionSnapshot(active([
      { name: 'Overhead Press', liftCode: 'OHP', status: 'pending', source: 'planned' },
      { name: 'Deadlift', liftCode: 'DL', status: 'pending', source: 'planned' },
      { name: 'Pull-up', liftCode: 'PU', status: 'pending', source: 'planned' },
    ]));
    assert.deepEqual(s.slots.map((x) => x.name), ['Overhead Press', 'Deadlift', 'Pull-up']);
  });

  it('keeps DUPLICATE exercise names as independent, separate slots (F10)', () => {
    const s = buildCanonicalSessionSnapshot(active([
      { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
      { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
    ]));
    assert.equal(s.slots.length, 2, 'two independent slots, not collapsed');
    assert.equal(s.slots[0].name, 'Bench Press');
    assert.equal(s.slots[1].name, 'Bench Press');
  });

  it('completes ONLY the correct duplicate occurrence (identity by position, not by name)', () => {
    const s = buildCanonicalSessionSnapshot(active([
      { name: 'Bench Press', liftCode: 'BENCH', status: 'completed', source: 'planned' },
      { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
    ]));
    assert.equal(s.slots[0].status, 'completed');
    assert.equal(s.slots[1].status, 'pending');
    // the cursor points at the SECOND Bench Press slot, not the first
    assert.equal(currentSlot(s), s.slots[1]);
  });

  it('preserves substituted and inserted slot SOURCES through the boundary', () => {
    const s = buildCanonicalSessionSnapshot(active([
      { name: 'Incline Press', liftCode: 'INCP', status: 'pending', source: 'substituted' },
      { name: 'Hammer Curl', liftCode: 'HC', status: 'completed', source: 'inserted' },
    ]));
    assert.equal(s.slots[0].source, 'substituted');
    assert.equal(s.slots[1].source, 'inserted');
  });

  it('preserves lift codes (liftCode → lift_code) and defaults the set tallies', () => {
    const s = buildCanonicalSessionSnapshot(active([
      { name: 'Back Squat', liftCode: 'SQ01', status: 'pending', source: 'planned' },
    ]));
    assert.equal(s.slots[0].lift_code, 'SQ01');
    assert.equal(s.slots[0].sets_logged, 0);
    assert.equal(s.slots[0].sets_target, null);
  });

  it('leaves the optional session id null when the client supplies none', () => {
    const s = buildCanonicalSessionSnapshot(active([
      { name: 'Back Squat', liftCode: 'SQ', status: 'pending', source: 'planned' },
    ]));
    assert.equal(s.session_id, null);
    assert.equal(s.discussion_referent, null, 'discussion_referent stays null in this PR');
  });

  it('carries a REAL authoritative session id only when the active-session object supplies one', () => {
    const s = buildCanonicalSessionSnapshot({ active_session: { session_id: '20260723-PM-01', exercises: [
      { name: 'Back Squat', liftCode: 'SQ', status: 'pending', source: 'planned' },
    ] } });
    assert.equal(s.session_id, '20260723-PM-01');
    assert.equal(validateWorkoutSession(s).valid, true);
  });
});

describe('buildCanonicalSessionSnapshot — fails closed (never repairs, never guesses)', () => {
  it('returns null when the active_session field is absent', () => {
    assert.equal(buildCanonicalSessionSnapshot({}), null);
    assert.equal(buildCanonicalSessionSnapshot(null), null);
    assert.equal(buildCanonicalSessionSnapshot(undefined), null);
  });

  it('returns null when active_session is not the expected shape', () => {
    assert.equal(buildCanonicalSessionSnapshot({ active_session: 'nope' }), null);
    assert.equal(buildCanonicalSessionSnapshot({ active_session: [] }), null);
    assert.equal(buildCanonicalSessionSnapshot({ active_session: { exercises: 'nope' } }), null);
    assert.equal(buildCanonicalSessionSnapshot({ active_session: {} }), null);
  });

  it('returns null when a slot carries an invalid status/source (no partial repair)', () => {
    assert.equal(buildCanonicalSessionSnapshot(active([
      { name: 'Bench Press', liftCode: 'B', status: 'done', source: 'planned' },
    ])), null, 'invalid status fails closed');
    assert.equal(buildCanonicalSessionSnapshot(active([
      { name: 'Bench Press', liftCode: 'B', status: 'pending', source: 'random' },
    ])), null, 'invalid source fails closed');
  });

  it('returns null when a slot name is blank (no fabricated identity)', () => {
    assert.equal(buildCanonicalSessionSnapshot(active([
      { name: '', liftCode: 'B', status: 'pending', source: 'planned' },
    ])), null);
  });

  it('NEVER reverse-engineers a session from current_plan / plan_state when active_session is malformed', () => {
    const context = {
      current_plan: [{ name: 'Bench Press', sets: 3, reps: 5 }, { name: 'Back Squat', sets: 3, reps: 5 }],
      plan_state: { planned: ['Bench Press', 'Back Squat'], completed: ['Bench Press'], remaining: ['Back Squat'], isComplete: false },
      active_session: { exercises: 'malformed' },
    };
    assert.equal(buildCanonicalSessionSnapshot(context), null, 'no fallback to the lossy name arrays');
  });

  it('NEVER reverse-engineers a session from current_plan / plan_state when active_session is absent', () => {
    const context = {
      current_plan: [{ name: 'Bench Press', sets: 3, reps: 5 }],
      plan_state: { planned: ['Bench Press'], completed: [], remaining: ['Bench Press'], isComplete: false },
    };
    assert.equal(buildCanonicalSessionSnapshot(context), null);
  });

  it('is pure — never mutates the input context', () => {
    const context = active([{ name: 'Back Squat', liftCode: 'SQ', status: 'pending', source: 'planned' }]);
    const snapshot = JSON.stringify(context);
    buildCanonicalSessionSnapshot(context);
    assert.equal(JSON.stringify(context), snapshot, 'the request context is untouched');
  });
});
