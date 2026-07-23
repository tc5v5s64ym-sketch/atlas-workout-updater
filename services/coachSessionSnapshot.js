'use strict';

// Coach session snapshot — Phase 4 H-08A boundary adapter.
//
// The SINGLE, pure boundary that converts the additive `context.active_session` snapshot the
// chat client forwards (the live src/app/activeSession.js model —
// `{ exercises: [{ name, liftCode, status, source }] }`) into a canonical, validated
// services/workoutSession.js WorkoutSession for the CoachTurnPacket shadow. It exists so the
// conversion happens ONCE at the trusted /api/coach/chat boundary (H-08A) instead of being
// scattered across the individual coaching lanes.
//
// FAIL CLOSED. Returns null when the field is absent, is not the expected shape, or the
// converted session does not validate. It NEVER partially repairs a malformed session and
// NEVER reverse-engineers slot identity / duplicate occurrence / source / status from the
// lossy current_plan / plan_state name arrays — if the authoritative active-session object is
// not present AND valid, there is simply no canonical session this turn. That honest null is
// the divergence report's H-08 signal until the client forwards a real session.
//
// Pure / deterministic — no I/O, no clock, no randomness. Read-only: it builds a value and
// never mutates the request context, the session, or anything else.

const { fromActiveSession, validateWorkoutSession } = require('./workoutSession');

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _nonEmptyString(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

/**
 * Build a canonical, validated WorkoutSession from a chat request context.
 *
 * @param {object} context  the /api/coach/chat request `context` object
 * @returns {object|null}   a valid WorkoutSession, or null when the additive
 *                          `active_session` field is absent, malformed, or fails validation.
 *
 * Carries an authoritative session id ONLY when the active-session object itself supplies a
 * real one — never the plan fingerprint, never invented. discussion_referent is left null in
 * this increment (Phase 4 D10 punch list) unless the same object already carries a canonical
 * value (fromActiveSession would pass it through, but the client sends none yet).
 */
function buildCanonicalSessionSnapshot(context) {
  const ctx = _isPlainObject(context) ? context : {};
  const active = ctx.active_session;
  // The additive field must be the live client session shape: an object with an exercises
  // array. Anything else (absent, a string, an array, no exercises list) → no session.
  if (!_isPlainObject(active) || !Array.isArray(active.exercises)) return null;
  const session = fromActiveSession(active, { session_id: _nonEmptyString(active.session_id) });
  // Fail closed: a malformed slot (invalid status/source, blank name, …) never becomes a
  // half-repaired session — the whole snapshot is dropped to null.
  return validateWorkoutSession(session).valid ? session : null;
}

module.exports = { buildCanonicalSessionSnapshot };
