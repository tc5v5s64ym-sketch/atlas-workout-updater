// Atlas single state store — PR-10 (session/plan slice).
//
// Before PR-10 the in-workout memory ("what plan am I in, what's logged, what swap
// is pending") lived as loose top-level `let`s scattered through app.js, read and
// written from ~180 sites. Every "one representation updated, the other not" bug in
// the SESS-* audit family traces to that split. This module is the single home for
// that state: signals own the values, getters hand out the live reference (or a
// snapshot for callers that must not mutate), and every REASSIGNMENT goes through an
// action. No module writes a signal directly — the discipline is what makes the
// state testable in isolation (test/store.test.js) and what the later write-path
// slice (PR-11) extends.
//
// Reactivity note: the pre-PR-10 code advances the UI imperatively (it calls
// renderSessionPin()/renderActiveSessionBanner()/saveSessionSnapshot() itself after
// each mutation) and does not subscribe to these variables. PR-10 preserves that
// exactly — it relocates ownership without changing behavior — so the signals here
// are used as the single source of truth, not (yet) as a reactive render trigger.
// In-place mutation of the plan object / buffers through the live getter reference
// (`getActivePlannedSession().index = …`, `getSessionLog().push(…)`) is therefore
// intentional and behavior-identical; the actions cover the reassignments the old
// `let`s took (`x = []`, `x = {…}`, `x = null`).

import { signal } from './signals-core.js';

// ── session/plan slice (private signals — never exported directly) ──────────────
const _activePlannedSession = signal(null);
const _sessionChromeExpanded = signal(false);
const _coachSuggestionEngaged = signal(false);
const _pendingSubstitution = signal(null);
const _sessionLog = signal([]);
const _sessionCompleted = signal([]);
const _sessionSavedLog = signal([]);

// ── getters (live reference; callers read fields / iterate / spread) ────────────
export function getActivePlannedSession() { return _activePlannedSession.value; }
export function getSessionChromeExpanded() { return _sessionChromeExpanded.value; }
export function getCoachSuggestionEngaged() { return _coachSuggestionEngaged.value; }
export function getPendingSubstitution() { return _pendingSubstitution.value; }
export function getSessionLog() { return _sessionLog.value; }
export function getSessionCompleted() { return _sessionCompleted.value; }
export function getSessionSavedLog() { return _sessionSavedLog.value; }

// ── actions (every reassignment the old top-level `let`s took) ──────────────────
export function setActivePlannedSession(v) { _activePlannedSession.value = v || null; }
export function setSessionChromeExpanded(v) { _sessionChromeExpanded.value = !!v; }
export function setCoachSuggestionEngaged(v) { _coachSuggestionEngaged.value = !!v; }
export function setPendingSubstitution(v) { _pendingSubstitution.value = v || null; }
export function setSessionLog(v) { _sessionLog.value = Array.isArray(v) ? v : []; }
export function setSessionCompleted(v) { _sessionCompleted.value = Array.isArray(v) ? v : []; }
export function setSessionSavedLog(v) { _sessionSavedLog.value = Array.isArray(v) ? v : []; }

// Derived values: none live here yet. The derivations callers actually need
// (remainingPlannedExercises / plannedExerciseOrder / firstUnloggedPlannedLift)
// read the catalog datalist and the activeSession model, so they stay in app.js.
// A `computed` over the session BUFFERS would also be a trap: `sessionLog` /
// `sessionCompleted` are mutated IN PLACE via the live getter (`.push`), which does
// not bump the signal, so such a computed would go stale. Buffer-derived reads are
// therefore plain functions off the getters (e.g. app.js's hasUnsavedSessionState).

// ── whole-slice snapshot (getState pattern) ─────────────────────────────────────
// Returns the LIVE signal references (not a copy) — the store deliberately hands out
// live buffers so app.js can keep its in-place mutation. Read them freely; mutations
// must still go through the actions above, never by writing a field of this object.
export function getState() {
  return {
    activePlannedSession: _activePlannedSession.value,
    sessionChromeExpanded: _sessionChromeExpanded.value,
    coachSuggestionEngaged: _coachSuggestionEngaged.value,
    pendingSubstitution: _pendingSubstitution.value,
    sessionLog: _sessionLog.value,
    sessionCompleted: _sessionCompleted.value,
    sessionSavedLog: _sessionSavedLog.value,
  };
}

// ── persistence seam (mobile PWA resume safety) ─────────────────────────────────
// The ONE place the session snapshot is serialized to / parsed from localStorage.
// app.js keeps only the DOM half (the #log-session-id field and the resume-notice
// banner); the state shape and its storage I/O + validation live here.
//
// Storage KEY is unchanged (`atlas_session_snapshot_v1`) so an in-flight phone can
// still find its snapshot across the deploy; the payload SHAPE version is bumped
// v1 → v2 to carry `pendingSubstitution` (audit SESS-2: a declared swap was dropped
// on reload, stranding the swapped-out lift as pending forever). A v1 snapshot (no
// pendingSubstitution) is still read — the missing field simply restores as null.
const SNAPSHOT_KEY = 'atlas_session_snapshot_v1';
const SNAPSHOT_SHAPE_VERSION = 2;
const SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function storage() {
  // Read the global at call time so browser (real localStorage) and Node tests
  // (which set globalThis.localStorage to a fake) both work.
  try { return (typeof localStorage !== 'undefined' && localStorage) || (globalThis && globalThis.localStorage) || null; }
  catch { return null; }
}

// Persist ONLY an in-progress session (logged sets OR an active plan). `sessionId`
// is the stable server session id (the caller reads it from the DOM). Best-effort:
// a storage failure never throws into the workout flow.
export function persistSessionSnapshot(sessionId) {
  try {
    const store = storage();
    if (!store) return;
    const log = _sessionLog.value;
    const plan = _activePlannedSession.value;
    if (!(Array.isArray(log) && log.length) && !plan) { store.removeItem(SNAPSHOT_KEY); return; }
    const sub = _pendingSubstitution.value;
    store.setItem(SNAPSHOT_KEY, JSON.stringify({
      v: SNAPSHOT_SHAPE_VERSION,
      ts: Date.now(),
      sessionLog: log,
      sessionCompleted: _sessionCompleted.value,
      activePlannedSession: plan,
      ...(sub ? { pendingSubstitution: sub } : {}),
      ...(sessionId ? { sessionId } : {}),
    }));
  } catch { /* storage full / disabled — persistence is best-effort, never fatal */ }
}

// Read + validate a recent snapshot and APPLY it to the slice. Returns a small
// result object so the caller can do the DOM half. Read-only restore — no network.
// `{ resumed: false }` when there is nothing safe to resume (missing / malformed /
// stale / plan-only-no-sets — an empty plan is one tap from re-opening and must not
// silently re-activate guided mode on a fresh freestyle log).
export function hydrateSessionSnapshot() {
  try {
    const store = storage();
    if (!store) return { resumed: false };
    const raw = store.getItem(SNAPSHOT_KEY);
    if (!raw) return { resumed: false };
    const snap = JSON.parse(raw);
    const versionOk = snap && (snap.v === 1 || snap.v === SNAPSHOT_SHAPE_VERSION);
    if (!versionOk || typeof snap.ts !== 'number' || (Date.now() - snap.ts) > SNAPSHOT_MAX_AGE_MS) {
      clearPersistedSnapshot();
      return { resumed: false };
    }
    if (!Array.isArray(snap.sessionLog) || !Array.isArray(snap.sessionCompleted)) { clearPersistedSnapshot(); return { resumed: false }; }
    if (!snap.sessionLog.length) { clearPersistedSnapshot(); return { resumed: false }; }
    setSessionLog(snap.sessionLog);
    setSessionCompleted(snap.sessionCompleted);
    setActivePlannedSession((snap.activePlannedSession && Array.isArray(snap.activePlannedSession.exercises))
      ? snap.activePlannedSession : null);
    // SESS-2: restore the deferred swap (v2+) so a declared substitution survives a
    // reload; v1 snapshots have no such field and correctly restore as no pending swap.
    setPendingSubstitution((snap.pendingSubstitution && typeof snap.pendingSubstitution === 'object')
      ? snap.pendingSubstitution : null);
    return {
      resumed: true,
      sessionId: snap.sessionId || null,
      sessionLog: _sessionLog.value,
      hasPlan: !!_activePlannedSession.value,
    };
  } catch { clearPersistedSnapshot(); return { resumed: false }; }
}

// Remove the persisted snapshot (storage only — the caller hides the resume notice).
export function clearPersistedSnapshot() {
  try { const store = storage(); if (store) store.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
}

// ── test-only reset (fresh module state between unit tests) ──────────────────────
export function resetSessionStore() {
  _activePlannedSession.value = null;
  _sessionChromeExpanded.value = false;
  _coachSuggestionEngaged.value = false;
  _pendingSubstitution.value = null;
  _sessionLog.value = [];
  _sessionCompleted.value = [];
  _sessionSavedLog.value = [];
}
