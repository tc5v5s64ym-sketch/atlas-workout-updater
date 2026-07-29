'use strict';

// PR-10 — src/app/store.js unit tests (the single session/plan state store).
//
// The store is the structural cure for the SESS-* "one representation updated, the
// other not" audit family: there is now ONE home for activePlannedSession, the
// session buffers, and the pending swap. These tests exercise the store directly
// (it has no DOM coupling beyond a localStorage the test fakes) — start/replace/
// skip/complete-shaped mutation, substitution pending→applied, resume-after-reload,
// and the v1→v2 snapshot shape bump that carries pendingSubstitution (SESS-2).

const test = require('node:test');
const assert = require('node:assert/strict');

let store;

function fakeLocalStorage() {
  const mem = new Map();
  return {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
    _mem: mem,
  };
}

test.before(async () => {
  globalThis.localStorage = fakeLocalStorage();
  store = await import('../src/app/store.js');
});

test.beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
  store.resetSessionStore();
});

test('initial state: everything empty / null', () => {
  const s = store.getState();
  assert.equal(s.activePlannedSession, null);
  assert.equal(s.sessionChromeExpanded, false);
  assert.equal(s.coachSuggestionEngaged, false);
  assert.equal(s.pendingSubstitution, null);
  assert.deepEqual(s.sessionLog, []);
  assert.deepEqual(s.sessionCompleted, []);
  assert.deepEqual(s.sessionSavedLog, []);
  assert.equal(s.coachDiscussionSinceLog, false);
});

test('getters return the LIVE reference (in-place push/splice is visible)', () => {
  store.getSessionLog().push({ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 });
  assert.equal(store.getSessionLog().length, 1);

  const plan = { label: 'x', exercises: [{ name: 'Bench Press' }, { name: 'Row' }], index: 0 };
  store.setActivePlannedSession(plan);
  store.getActivePlannedSession().index = 1;       // nested mutation via live ref
  assert.equal(store.getActivePlannedSession().index, 1);
  store.getActivePlannedSession().exercises.splice(0, 1);
  assert.equal(store.getActivePlannedSession().exercises.length, 1);
});

test('setters coerce: booleans, null-normalized objects, array-guarded arrays', () => {
  store.setSessionChromeExpanded('yes');
  assert.equal(store.getSessionChromeExpanded(), true);
  store.setCoachSuggestionEngaged(0);
  assert.equal(store.getCoachSuggestionEngaged(), false);
  store.setActivePlannedSession(undefined);
  assert.equal(store.getActivePlannedSession(), null);
  store.setPendingSubstitution(0);
  assert.equal(store.getPendingSubstitution(), null);
  store.setSessionLog('not-an-array');
  assert.deepEqual(store.getSessionLog(), []);
});

// ── app-level flags slice (PR-24: folded in from the deleted sharedState.js) ────
test('app-flags: atlasLastError + historyLoaded default empty and round-trip via actions', () => {
  assert.equal(store.getAtlasLastError(), null);
  assert.equal(store.getHistoryLoaded(), false);

  const err = { message: 'boom', status: 500, endpoint: '/api/x', at: 'now' };
  store.setAtlasLastError(err);
  assert.deepEqual(store.getAtlasLastError(), err);
  store.setAtlasLastError(null);
  assert.equal(store.getAtlasLastError(), null);

  store.setHistoryLoaded(true);
  assert.equal(store.getHistoryLoaded(), true);
  store.setHistoryLoaded(0);                       // coerces to boolean
  assert.equal(store.getHistoryLoaded(), false);
});

test('app-flags are NOT session state: resetSessionStore leaves them untouched', () => {
  // These are app-level (last API error, history-fetched flag) — never reset on
  // session end, exactly as when they lived on sharedState. resetSessionStore()
  // must clear only the session slice.
  store.setAtlasLastError({ message: 'boom' });
  store.setHistoryLoaded(true);
  store.setSessionLog([{ exercise: 'Bench' }]);

  store.resetSessionStore();

  assert.deepEqual(store.getSessionLog(), [], 'session slice IS reset');
  assert.deepEqual(store.getAtlasLastError(), { message: 'boom' }, 'app flag survives session reset');
  assert.equal(store.getHistoryLoaded(), true, 'app flag survives session reset');
  // Cleanup for later tests (beforeEach only resets the session slice).
  store.setAtlasLastError(null);
  store.setHistoryLoaded(false);
});

test('app-flags are excluded from the session snapshot shape (getState)', () => {
  store.setAtlasLastError({ message: 'boom' });
  store.setHistoryLoaded(true);
  const s = store.getState();
  assert.ok(!('atlasLastError' in s), 'getState is the session snapshot — no app flags');
  assert.ok(!('historyLoaded' in s), 'getState is the session snapshot — no app flags');
  store.setAtlasLastError(null);
  store.setHistoryLoaded(false);
});

// ── ADD-5 session flag (PR-24 slice 2): coachDiscussionSinceLog ─────────────────
test('coachDiscussionSinceLog: round-trips via the action, appears in getState, IS session-reset', () => {
  assert.equal(store.getCoachDiscussionSinceLog(), false, 'defaults false');
  store.setCoachDiscussionSinceLog('truthy');           // coerces to boolean
  assert.equal(store.getCoachDiscussionSinceLog(), true);
  assert.equal(store.getState().coachDiscussionSinceLog, true, 'reflected in the session snapshot');

  // Unlike the app-level flags, this IS session state — resetSessionStore clears it.
  store.resetSessionStore();
  assert.equal(store.getCoachDiscussionSinceLog(), false, 'session reset clears the ADD-5 focus flag');
});

test('start → substitution pending → applied clears the pending swap', () => {
  store.setActivePlannedSession({ label: 'p', exercises: [{ name: 'Leg Press' }], index: 0 });
  store.setPendingSubstitution({ prescribed: 'Leg Press', prescription: null });
  assert.equal(store.getPendingSubstitution().prescribed, 'Leg Press');
  // caller applies the swap in the live plan then clears the pending marker
  store.getActivePlannedSession().exercises[0] = { name: 'Hack Squat', reason: 'substituted' };
  store.setPendingSubstitution(null);
  assert.equal(store.getPendingSubstitution(), null);
  assert.equal(store.getActivePlannedSession().exercises[0].name, 'Hack Squat');
});

test('persist writes a v6 snapshot carrying pendingSubstitution (SESS-2), sessionRevisions (F10B), sessionImplicitRecs (F10C), pendingReplacement, pendingSetRevision (#1189) + sessionId', () => {
  store.setActivePlannedSession({ label: 'p', exercises: [{ name: 'Leg Press' }], index: 0 });
  store.getSessionLog().push({ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 });
  store.setSessionCompleted(['Bench Press']);
  store.setPendingSubstitution({ prescribed: 'Leg Press' });
  store.setSessionRevisions([{ plan_item_id: 'pi_1', set_index: 2, plan_version: 2, target_weight: 60, target_reps: 8, target_rir: 2, recommendation_source: 'live_revision' }]);
  store.setSessionImplicitRecs([{ plan_item_id: 'pi_impl_S1_HCURL', planned_lift_code: 'HCURL', target_weight: 30, target_reps: 12, target_rir: 1, target_set_count: 1 }]);
  store.setPendingReplacement({ proposal_id: 'repl:LEGPRESS->BENCHPRESS@x', source: { name: 'Leg Press' }, replacement: { name: 'Bench Press' }, status: 'pending' });
  store.setPendingSetRevision({ kind: 'set_revision', proposal_id: 'setrev:PI1@x', plan_item_id: 'pi_1', planned_lift_code: 'SQ01', status: 'pending' });
  store.persistSessionSnapshot('SESSION-42');
  const snap = JSON.parse(globalThis.localStorage.getItem('atlas_session_snapshot_v1'));
  assert.equal(snap.v, 6);
  assert.equal(typeof snap.ts, 'number');
  assert.equal(snap.sessionId, 'SESSION-42');
  assert.deepEqual(snap.pendingSubstitution, { prescribed: 'Leg Press' });
  assert.deepEqual(snap.sessionCompleted, ['Bench Press']);
  assert.equal(snap.sessionRevisions.length, 1);
  assert.equal(snap.sessionRevisions[0].plan_version, 2);
  assert.equal(snap.sessionImplicitRecs.length, 1);
  assert.equal(snap.sessionImplicitRecs[0].planned_lift_code, 'HCURL');
  assert.equal(snap.pendingReplacement.proposal_id, 'repl:LEGPRESS->BENCHPRESS@x');
  assert.equal(snap.pendingSetRevision.proposal_id, 'setrev:PI1@x');
});

test('#1189: a pending set-revision proposal round-trips through the snapshot (reload re-surfaces the SAME proposal)', () => {
  const proposal = {
    kind: 'set_revision', proposal_id: 'setrev:PIBSQ@pi_bsq|SQ01|185|5|2|3',
    plan_item_id: 'pi_bsq', planned_lift_code: 'SQ01', prescribed_name: 'Back Squat',
    prescription: { weight: 185, reps: 5, rir: 2 }, accepted_set_count: 3,
    from: { weight: 225, reps: 5, rir: 2 }, plan_version: 'pv_x', status: 'pending',
  };
  store.setActivePlannedSession({ accepted: true, session_id: 'S1', plan_version: 'pv_x', label: 'p', exercises: [{ name: 'Back Squat', plan_item_id: 'pi_bsq' }], index: 0 });
  store.getSessionLog().push({ exercise: 'Back Squat', weight: 225, reps: 5, rir: 2 });
  store.setPendingSetRevision(proposal);
  store.persistSessionSnapshot('S1');
  store.resetSessionStore();
  assert.equal(store.getPendingSetRevision(), null, 'reset clears the pending proposal');

  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  assert.deepEqual(store.getPendingSetRevision(), proposal, 'the SAME proposal is restored intact');
});

test('#1189: a v5 snapshot (no pendingSetRevision) still restores, with no proposal', () => {
  // Backward compatibility is additive, exactly as every prior bump: an older snapshot simply
  // lacks the newer field and restores it as its empty value. Nothing is dropped or rewritten.
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify({
    v: 5,
    ts: Date.now(),
    sessionLog: [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 }],
    sessionCompleted: ['Bench Press'],
    activePlannedSession: { accepted: true, label: 'p', exercises: [{ name: 'Bench Press' }], index: 0 },
    pendingReplacement: { proposal_id: 'repl:A->B@x', status: 'pending' },
    sessionId: 'S-OLD',
  }));

  const res = store.hydrateSessionSnapshot();

  assert.equal(res.resumed, true, 'a v5 snapshot is never rejected on deploy');
  assert.equal(res.sessionId, 'S-OLD');
  assert.equal(store.getPendingSetRevision(), null, 'the missing field restores as no proposal');
  assert.equal(store.getPendingReplacement().proposal_id, 'repl:A->B@x', 'and v5 fields are untouched');
  assert.equal(store.getSessionLog().length, 1);
});

test('F10C: implicit recommendations round-trip through the snapshot (reconstructed after reload)', () => {
  store.setActivePlannedSession({ accepted: true, session_id: 'S1', plan_version: 'pv_x', label: 'p', exercises: [{ name: 'Bench Press', plan_item_id: 'pi_1' }], index: 0 });
  store.getSessionLog().push({ exercise: 'Bench Press', weight: 185, reps: 8, rir: 2 });
  store.setSessionImplicitRecs([{ plan_item_id: 'pi_impl_S1_HCURL', planned_lift_code: 'HCURL', target_weight: 30, target_reps: 12, target_rir: 1, target_set_count: 1 }]);
  store.persistSessionSnapshot('S1');
  store.resetSessionStore();
  assert.deepEqual(store.getSessionImplicitRecs(), [], 'reset clears implicit recs');
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  assert.equal(store.getSessionImplicitRecs().length, 1, 'the implicit rec survives a reload');
  assert.equal(store.getSessionImplicitRecs()[0].target_reps, 12);
});

test('v3 snapshot back-compat: sessionImplicitRecs restores as [] (older snapshot has no such field)', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify({
    v: 3, ts: Date.now(),
    sessionLog: [{ exercise: 'Squat', weight: 315, reps: 5, rir: 1 }],
    sessionCompleted: ['Squat'], activePlannedSession: null,
  }));
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  assert.deepEqual(store.getSessionImplicitRecs(), []);
});

test('F10B: mid-session revisions round-trip through the snapshot (reconstructed after reload)', () => {
  store.setActivePlannedSession({ accepted: true, session_id: 'S1', plan_version: 'pv_x', label: 'p', exercises: [{ name: 'Dumbbell Press', plan_item_id: 'pi_1' }], index: 0 });
  store.getSessionLog().push({ exercise: 'Bench Press', weight: 185, reps: 8, rir: 2 });
  store.setSessionRevisions([{ plan_item_id: 'pi_1', set_index: 2, plan_version: 2, target_weight: 60, target_reps: 8, target_rir: 2, recommendation_source: 'live_revision' }]);
  store.persistSessionSnapshot('S1');
  store.resetSessionStore();
  assert.deepEqual(store.getSessionRevisions(), [], 'reset clears revisions');
  const res = store.hydrateSessionSnapshot();
  assert.equal(res.resumed, true);
  assert.equal(store.getSessionRevisions().length, 1, 'the durable revision survives a reload');
  assert.equal(store.getSessionRevisions()[0].target_weight, 60);
});

test('v2 snapshot back-compat: sessionRevisions restores as [] (older snapshot has no such field)', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify({
    v: 2, ts: Date.now(),
    sessionLog: [{ exercise: 'Squat', weight: 315, reps: 5, rir: 1 }],
    sessionCompleted: ['Squat'], activePlannedSession: null,
  }));
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  assert.deepEqual(store.getSessionRevisions(), []);
});

test('persist drops the snapshot when nothing is in progress', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', 'stale');
  store.persistSessionSnapshot('');
  assert.equal(globalThis.localStorage.getItem('atlas_session_snapshot_v1'), null);
});

test('resume-after-reload restores buffers, plan, AND the pending swap (SESS-2)', () => {
  // Simulate: mid-session with a declared-but-unapplied swap, then a reload.
  store.setActivePlannedSession({ label: 'p', exercises: [{ name: 'Leg Press' }], index: 0 });
  store.getSessionLog().push({ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 });
  store.setSessionCompleted(['Bench Press']);
  store.setPendingSubstitution({ prescribed: 'Leg Press', prescription: null });
  store.persistSessionSnapshot('SID');

  store.resetSessionStore();                        // fresh page load, memory gone
  assert.equal(store.getPendingSubstitution(), null);

  const res = store.hydrateSessionSnapshot();
  assert.equal(res.resumed, true);
  assert.equal(res.sessionId, 'SID');
  assert.equal(res.hasPlan, true);
  assert.equal(store.getSessionLog().length, 1);
  assert.deepEqual(store.getSessionCompleted(), ['Bench Press']);
  // The stranded-swap bug: before SESS-2 this was lost on reload.
  assert.deepEqual(store.getPendingSubstitution(), { prescribed: 'Leg Press', prescription: null });
});

test('v1 snapshot back-compat: resumes; missing pendingSubstitution restores as null', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify({
    v: 1, ts: Date.now(),
    sessionLog: [{ exercise: 'Squat', weight: 315, reps: 5, rir: 1 }],
    sessionCompleted: ['Squat'],
    activePlannedSession: null,
  }));
  const res = store.hydrateSessionSnapshot();
  assert.equal(res.resumed, true);
  assert.equal(store.getSessionLog().length, 1);
  assert.equal(store.getPendingSubstitution(), null);
});

test('hydrate refuses a stale (>12h) snapshot and clears it', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify({
    v: 2, ts: Date.now() - (13 * 60 * 60 * 1000),
    sessionLog: [{ exercise: 'Squat' }], sessionCompleted: [],
  }));
  assert.equal(store.hydrateSessionSnapshot().resumed, false);
  assert.equal(globalThis.localStorage.getItem('atlas_session_snapshot_v1'), null);
});

test('hydrate refuses a plan-only snapshot with no logged sets (freestyle must not auto-guide)', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify({
    v: 2, ts: Date.now(),
    sessionLog: [], sessionCompleted: [],
    activePlannedSession: { label: 'p', exercises: [{ name: 'Bench' }], index: 0 },
  }));
  assert.equal(store.hydrateSessionSnapshot().resumed, false);
  assert.equal(store.getActivePlannedSession(), null);
  assert.equal(globalThis.localStorage.getItem('atlas_session_snapshot_v1'), null);
});

test('hydrate refuses a malformed snapshot without throwing', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', '{not json');
  assert.equal(store.hydrateSessionSnapshot().resumed, false);
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify({ v: 2, ts: Date.now(), sessionLog: 'x' }));
  assert.equal(store.hydrateSessionSnapshot().resumed, false);
});

test('clearPersistedSnapshot removes the key (storage only)', () => {
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', 'x');
  store.clearPersistedSnapshot();
  assert.equal(globalThis.localStorage.getItem('atlas_session_snapshot_v1'), null);
});

test('persistence is best-effort: a throwing storage never propagates', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('boom'); },
    setItem() { throw new Error('boom'); },
    removeItem() { throw new Error('boom'); },
  };
  store.getSessionLog().push({ exercise: 'Bench', weight: 1, reps: 1, rir: 0 });
  assert.doesNotThrow(() => store.persistSessionSnapshot('x'));
  assert.doesNotThrow(() => store.clearPersistedSnapshot());
  assert.equal(store.hydrateSessionSnapshot().resumed, false);
});
