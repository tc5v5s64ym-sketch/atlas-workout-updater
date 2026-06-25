/* Canonical Active Workout Session — the single authoritative model for the
 * in-progress workout (P0 Active Workout State Unification).
 *
 * See docs/ACTIVE_SESSION_STATE_DIAGNOSIS.md. The live-gym repro showed Atlas had
 * seven divergent holders of "the active workout" (composer, next-up router, coach
 * context, queue, preview/save, completion) that fell out of sync after mid-session
 * changes. This module is the ONE object every consumer derives from. Accepted
 * modifications MUTATE it deterministically (the LLM only explains the change; this
 * state owns it).
 *
 * PURE / UMD: no DOM, no I/O, no LLM, no Sheets, no writes. Every operation returns
 * a NEW session and never mutates its input, so the browser IIFEs (public/app.js,
 * public/coach-conversation.js) and the Node test suite run the IDENTICAL logic —
 * the same pattern as public/coachVoiceTemplates.js.
 *
 * Session shape:
 *   { exercises: [ { name, liftCode, status, source } ] }
 *     status: 'pending' | 'completed' | 'skipped'
 *     source: 'planned' | 'substituted' | 'inserted'
 *
 * The "cursor" is DERIVED, not stored: the current exercise is always the first
 * `pending` entry in order. That is the single fact the composer prefill and the
 * next-up router both read, so they can never disagree again.
 *
 * Scope note (PR 2): createActiveSession + replaceExercise/skipExercise/
 * markCompleted + the selectors. correctIdentity (PR 4) and insertExercise (PR 5)
 * land in later slices of the same lane.
 */
(function (root) {
  'use strict';

  const STATUS = { PENDING: 'pending', COMPLETED: 'completed', SKIPPED: 'skipped' };

  function norm(s) {
    return String(s == null ? '' : s).trim();
  }
  function lc(s) {
    return norm(s).toLowerCase();
  }

  // Accept a bare name string or a { name, liftCode } record; return a normalized
  // { name, liftCode } or null when there is no usable name.
  function toEntry(ref) {
    if (ref && typeof ref === 'object') {
      const name = norm(ref.name || ref.exercise || ref.exercise_name);
      if (!name) return null;
      return { name, liftCode: norm(ref.liftCode || ref.lift_code) };
    }
    const name = norm(ref);
    return name ? { name, liftCode: '' } : null;
  }

  // Does an exercise entry match a target ref? Name (exact, case-insensitive) →
  // liftCode → bidirectional substring (alias-ish), mirroring the identity ladder
  // the client already uses (resolveCompletedIdentity). Pure.
  function entryMatches(entry, ref) {
    const t = toEntry(ref);
    if (!entry || !t) return false;
    if (lc(entry.name) === lc(t.name)) return true;
    if (t.liftCode && entry.liftCode && lc(entry.liftCode) === lc(t.liftCode)) return true;
    const a = lc(entry.name), b = lc(t.name);
    if (a && b && (a.includes(b) || b.includes(a))) return true;
    return false;
  }

  function cloneExercises(exercises) {
    return exercises.map(e => ({ name: e.name, liftCode: e.liftCode, status: e.status, source: e.source }));
  }

  /**
   * createActiveSession({ exercises }) → session
   * exercises: ordered list of name strings or { name, liftCode } records.
   * Every entry starts `pending` / `planned`. Blank entries are dropped.
   */
  function createActiveSession({ exercises = [] } = {}) {
    const list = (Array.isArray(exercises) ? exercises : [])
      .map(toEntry)
      .filter(Boolean)
      .map(e => ({ name: e.name, liftCode: e.liftCode, status: STATUS.PENDING, source: 'planned' }));
    return { exercises: list };
  }

  // ── Mutations (pure — return a NEW session) ─────────────────────────────────

  /**
   * replaceExercise(session, targetName, substitute) → session
   * Swap the target's slot IN PLACE (order preserved) for the substitute, marked
   * pending + source 'substituted'. No-op when the target is not found or the
   * substitute is blank / resolves to the same name. (AC 2.)
   */
  function replaceExercise(session, targetName, substitute) {
    const sub = toEntry(substitute);
    if (!sub) return session;
    const exercises = cloneExercises(session.exercises);
    const idx = exercises.findIndex(e => entryMatches(e, targetName));
    if (idx === -1) return session;
    if (lc(exercises[idx].name) === lc(sub.name)) return session;
    exercises[idx] = { name: sub.name, liftCode: sub.liftCode, status: STATUS.PENDING, source: 'substituted' };
    return { ...session, exercises };
  }

  /**
   * skipExercise(session, name) → session
   * Mark a pending exercise skipped so it stops showing as the current/next move
   * and drops out of `remaining`, without claiming it as completed. (AC: skip.)
   */
  function skipExercise(session, name) {
    const exercises = cloneExercises(session.exercises);
    const idx = exercises.findIndex(e => e.status === STATUS.PENDING && entryMatches(e, name));
    if (idx === -1) return session;
    exercises[idx] = { ...exercises[idx], status: STATUS.SKIPPED };
    return { ...session, exercises };
  }

  /**
   * markCompleted(session, nameOrRef) → session
   * Mark the first matching PENDING exercise completed. The current-exercise/
   * next-up selectors then advance automatically (the next pending entry). No-op
   * when nothing pending matches (inserting an unplanned completed exercise is
   * insertExercise's job — PR 5). (AC 5/6/11.)
   */
  function markCompleted(session, nameOrRef) {
    const exercises = cloneExercises(session.exercises);
    const idx = exercises.findIndex(e => e.status === STATUS.PENDING && entryMatches(e, nameOrRef));
    if (idx === -1) return session;
    exercises[idx] = { ...exercises[idx], status: STATUS.COMPLETED };
    return { ...session, exercises };
  }

  // ── Selectors (every consumer derives from these — no parallel state) ───────

  // The current exercise = the first PENDING entry, in order. Composer prefill and
  // the next-up router BOTH read this, so they can never disagree. null when done.
  function currentExercise(session) {
    if (!session || !Array.isArray(session.exercises)) return null;
    return session.exercises.find(e => e.status === STATUS.PENDING) || null;
  }

  // Next-up router: the next exercise to do = the current pending entry. (After a
  // completion the cursor has advanced, so this returns the following pending lift.)
  function nextUp(session) {
    return currentExercise(session);
  }

  // All still-to-do (pending) exercises, in order.
  function remaining(session) {
    if (!session || !Array.isArray(session.exercises)) return [];
    return session.exercises.filter(e => e.status === STATUS.PENDING);
  }

  // Everything logged this session, in plan/insert order (for recap + write rows).
  function completedExercises(session) {
    if (!session || !Array.isArray(session.exercises)) return [];
    return session.exercises.filter(e => e.status === STATUS.COMPLETED);
  }

  // True when the session had a plan and nothing pending remains.
  function isComplete(session) {
    if (!session || !Array.isArray(session.exercises) || !session.exercises.length) return false;
    return remaining(session).length === 0;
  }

  const exported = {
    STATUS,
    createActiveSession,
    replaceExercise,
    skipExercise,
    markCompleted,
    currentExercise,
    nextUp,
    remaining,
    completedExercises,
    isComplete,
    // exposed for the later slices (identity correction PR4 / insert PR5) and tests
    entryMatches,
    toEntry,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.activeSession = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
