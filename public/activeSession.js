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
const _exports = (function () {
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
  // the client already uses (resolveCompletedIdentity). Pure. NOTE: the substring
  // tier is intentionally loose; to pick a *slot to mutate*, use findMatchIndex
  // below, which refuses to guess when the loose tier is ambiguous.
  function entryMatches(entry, ref) {
    const t = toEntry(ref);
    if (!entry || !t) return false;
    if (lc(entry.name) === lc(t.name)) return true;
    if (t.liftCode && entry.liftCode && lc(entry.liftCode) === lc(t.liftCode)) return true;
    const a = lc(entry.name), b = lc(t.name);
    if (a && b && (a.includes(b) || b.includes(a))) return true;
    return false;
  }

  // Pick the index of the single exercise a mutation should act on — SAFELY. A
  // mutation (replace/skip/complete) must never silently hit the wrong slot when a
  // loose name overlaps two lifts ("Row" → "Seated Row" AND "Barbell Row";
  // "Press" → "Overhead Press" AND "Bench Press"). Tiers over the candidate set
  // (optionally pending-only):
  //   1. exact name (case-insensitive) — first match
  //   2. liftCode                       — first match
  //   3. bidirectional substring        — ONLY when exactly one entry matches
  // Returns -1 when nothing matches OR the only matches are an ambiguous substring
  // (>1) — the caller no-ops rather than guess, so the wiring layer can disambiguate.
  function findMatchIndex(exercises, ref, pendingOnly) {
    const t = toEntry(ref);
    if (!t) return -1;
    const cand = exercises
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !pendingOnly || e.status === STATUS.PENDING);

    const exact = cand.filter(({ e }) => lc(e.name) === lc(t.name));
    if (exact.length) return exact[0].i;

    if (t.liftCode) {
      const byCode = cand.filter(({ e }) => e.liftCode && lc(e.liftCode) === lc(t.liftCode));
      if (byCode.length) return byCode[0].i;
    }

    const sub = cand.filter(({ e }) => {
      const a = lc(e.name), b = lc(t.name);
      return a && b && (a.includes(b) || b.includes(a));
    });
    return sub.length === 1 ? sub[0].i : -1; // ambiguous (or none) → no guess
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
   * pending + source 'substituted'. Only a PENDING slot can be replaced — replacing
   * an already completed/skipped slot would silently re-open finished work, so that
   * is a no-op (guard, PR-565 review). Also no-op when the target is not found or
   * the substitute is blank / resolves to the same name. (AC 2.)
   */
  function replaceExercise(session, targetName, substitute) {
    const sub = toEntry(substitute);
    if (!sub) return session;
    const exercises = cloneExercises(session.exercises);
    const idx = findMatchIndex(exercises, targetName, true); // pending-only: never re-open a finished slot
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
    const idx = findMatchIndex(exercises, name, true);
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
    const idx = findMatchIndex(exercises, nameOrRef, true);
    if (idx === -1) return session;
    exercises[idx] = { ...exercises[idx], status: STATUS.COMPLETED };
    return { ...session, exercises };
  }

  /**
   * correctIdentity(session, { from, to }) → session
   * Relabel a mis-logged exercise ("sorry, that was lat pulls" — the card said
   * Deadlift but it was Lat Pulldown). Finds the entry currently identified as
   * `from` and gives it the `to` identity, preserving its status (a logged set
   * stays logged). Two cases:
   *   - `to` matches a DIFFERENT existing entry (the real exercise was already in
   *     the plan): reconcile by STATUS PRECEDENCE — give the `to` entry the
   *     more-done of the two statuses and drop the mislabel, so the mislabel can
   *     never DOWNGRADE a finished `to` (PR-565 review). But when BOTH are already
   *     completed they are two separately-logged sets — collapsing would orphan
   *     one, so relabel the `from` in place instead (keep both logged entries).
   *   - otherwise: relabel the `from` entry in place.
   * No-op when `from` isn't found, `to` is blank, or it already is `to`. (AC 7.)
   */
  function correctIdentity(session, { from, to } = {}) {
    const target = toEntry(to);
    if (!target) return session;
    const exercises = cloneExercises(session.exercises);
    const fromIdx = findMatchIndex(exercises, from, false);
    if (fromIdx === -1) return session;
    if (lc(exercises[fromIdx].name) === lc(target.name)) return session; // already corrected

    const rank = { [STATUS.PENDING]: 0, [STATUS.SKIPPED]: 1, [STATUS.COMPLETED]: 2 };
    const relabelInPlace = () => {
      exercises[fromIdx] = {
        ...exercises[fromIdx],
        name: target.name,
        liftCode: target.liftCode || exercises[fromIdx].liftCode,
      };
      return { ...session, exercises };
    };

    const existingIdx = exercises.findIndex((e, i) => i !== fromIdx && lc(e.name) === lc(target.name));
    if (existingIdx !== -1) {
      const fromStatus = exercises[fromIdx].status;
      const toStatus = exercises[existingIdx].status;
      // Two separately-logged completions → keep both (don't orphan a logged set).
      if (fromStatus === STATUS.COMPLETED && toStatus === STATUS.COMPLETED) {
        return relabelInPlace();
      }
      // Reconcile onto the planned `to`, but never downgrade it: keep the more-done
      // status, then drop the mislabel so there's no duplicate identity.
      const merged = rank[fromStatus] >= rank[toStatus] ? fromStatus : toStatus;
      exercises[existingIdx] = { ...exercises[existingIdx], status: merged };
      exercises.splice(fromIdx, 1);
      return { ...session, exercises };
    }
    return relabelInPlace();
  }

  /**
   * insertExercise(session, ref, opts) → session
   * Add an unplanned accessory / finisher (Hammer Curls, Hanging Knee Raises) into
   * the live queue as a pending, source:'inserted' entry — so an exercise the
   * lifter does off-plan is REPRESENTED in the session (and its recap/write rows),
   * not silently buffered. Position:
   *   - default: appended to the end of the queue (a finisher).
   *   - opts.after = name/ref: inserted immediately AFTER that entry (when found).
   * The caller logs it via markCompleted(...) next (insert → complete). No-op when
   * ref is blank. (AC 8/9/10.)
   */
  function insertExercise(session, ref, opts = {}) {
    const e = toEntry(ref);
    if (!e) return session;
    const exercises = cloneExercises(session.exercises);
    const entry = { name: e.name, liftCode: e.liftCode, status: STATUS.PENDING, source: 'inserted' };
    let at = exercises.length;
    if (opts && opts.after != null) {
      const afterIdx = findMatchIndex(exercises, opts.after, false);
      if (afterIdx !== -1) at = afterIdx + 1;
    }
    exercises.splice(at, 0, entry);
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

  // True when at least one exercise was actually logged. Lets the recap/save layer
  // tell a real completed session from an all-skipped one (isComplete is true for
  // both — "nothing pending"), so an all-skipped session isn't saved as a workout
  // (PR-565 review).
  function hasLoggedWork(session) {
    return completedExercises(session).length > 0;
  }

  // Recap reconciliation (ADD-4): a planned slot the lifter SUBSTITUTED with a
  // more-specific variant is satisfied — not "still remaining". Drop a remaining
  // name when a completed name is a strict SUPERSET variant of it, i.e. the
  // completed name is "<modifier> <slot>" ("Incline Dumbbell Flyes" satisfies a
  // suggested "Dumbbell Flyes"; "Barbell Row" satisfies "Row"). Directional and
  // word-boundary-anchored on purpose:
  //   - a base movement never satisfies a MORE-specific slot (flat "Bench Press"
  //     must NOT complete an "Incline Bench Press" slot),
  //   - the match is a trailing whole-phrase (the base is the tail of the variant),
  //     so it never fires mid-word.
  // Read-only: names in, filtered remaining out. Does not touch the session, the
  // written rows, or the save payload — only what the recap narrates as remaining.
  function reconcileSubstitutedRemaining(completedNames, remainingNames) {
    const completed = (Array.isArray(completedNames) ? completedNames : []).map(lc).filter(Boolean);
    const satisfied = r => completed.some(c =>
      c !== r && c.endsWith(r) && c[c.length - r.length - 1] === ' ');
    return (Array.isArray(remainingNames) ? remainingNames : [])
      .filter(name => !satisfied(lc(name)));
  }

  const exported = {
    STATUS,
    createActiveSession,
    replaceExercise,
    skipExercise,
    markCompleted,
    correctIdentity,
    insertExercise,
    currentExercise,
    nextUp,
    remaining,
    completedExercises,
    isComplete,
    hasLoggedWork,
    reconcileSubstitutedRemaining,
    // exposed for the later slices (identity correction PR4 / insert PR5) and tests
    entryMatches,
    findMatchIndex,
    toEntry,
  };

  return exported;
})();

export const {
  STATUS,
  createActiveSession,
  replaceExercise,
  skipExercise,
  markCompleted,
  correctIdentity,
  insertExercise,
  currentExercise,
  nextUp,
  remaining,
  completedExercises,
  isComplete,
  hasLoggedWork,
  reconcileSubstitutedRemaining,
  entryMatches,
  findMatchIndex,
  toEntry,
} = _exports;
