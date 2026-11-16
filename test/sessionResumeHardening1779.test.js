'use strict';

// #1779 — the in-progress session must survive a service restart / cold start.
// Verify-first (comments 6895845740 / 6895881668) found the mechanism: a refused
// resume (finality `unknown` on a cold start) keeps the snapshot, but the app
// then holds an EMPTY buffer, and the unconditional persist on beforeunload /
// tab-hide DELETED it — the logged sets were permanently gone. The fix:
//   (1) an empty-state persist never deletes a persisted snapshot that still
//       carries logged work (only an explicit clear — save, Start Over,
//       discard, finalized, stale — removes it);
//   (2) the finality check retries `unknown` with backoff instead of refusing
//       the whole resume on the first transient failure, and the refusal reason
//       is exposed so the shell can surface a tap-to-retry state;
//   (3) a finalized session still refuses AND clears (no phantom resume).
// Store-level tests. The DOM half (pending / retry notice) is pinned by the
// wiring assertions at the bottom of this file against the built public/app.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

const KEY = 'atlas_session_snapshot_v1';
const SID = '2026-11-16-01';

const PLAN = {
  accepted: true,
  session_id: SID,
  session_date: '2026-11-16',
  plan_version: 'pv_1779',
  exercises: [{ name: 'Bench Press', canonicalName: 'Bench Press', liftCode: 'BEN01' }],
};

const SETS = [
  { exercise: 'Bench Press', canonical: 'Bench Press', weight: 225, reps: 5, rir: 2, notes: '' },
  { exercise: 'Bench Press', canonical: 'Bench Press', weight: 215, reps: 6, rir: 2, notes: '' },
  { exercise: 'Back Squat', canonical: 'Back Squat', weight: 315, reps: 3, rir: 2, notes: '' },
];

test.before(async () => {
  globalThis.localStorage = fakeLocalStorage();
  store = await import('../src/app/store.js');
});

test.beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
  store.resetSessionStore();
});

// Log 3 sets + accept a plan, exactly what emitSetLogged + plan accept leave
// behind (snapshot written after every set).
function logThreeSets() {
  store.setSessionLog([...SETS]);
  store.setSessionCompleted(['Bench Press', 'Back Squat']);
  store.setActivePlannedSession(structuredClone(PLAN));
  store.persistSessionSnapshot(SID);
  assert.notEqual(globalThis.localStorage.getItem(KEY), null, 'setup: snapshot written');
}

// Simulate a fresh client load: empty slice, hydrate from storage.
function freshLoad() {
  store.resetSessionStore();
  return store.hydrateSessionSnapshot();
}

test('#1779 F1: a refused resume + an empty-state persist must NOT delete the snapshot', async () => {
  logThreeSets();
  assert.equal(freshLoad().resumed, true);
  assert.equal(store.getSessionLog().length, 3);
  // Cold start: the finality check cannot be established.
  const stands = await store.confirmResumedSession(SID, async () => ({ unknown: true }), { retries: 0, retryDelayMs: 0 });
  assert.equal(stands, false, 'unknown finality still fails closed');
  assert.equal(store.getSessionLog().length, 0, 'the slice is rolled back');
  assert.notEqual(globalThis.localStorage.getItem(KEY), null, 'the snapshot is kept after the refusal');
  // THE DEFECT: the app now holds an empty buffer, and beforeunload /
  // tab-hide persists unconditionally. That persist must not delete the
  // only copy of the athlete's logged sets.
  store.persistSessionSnapshot(null);
  assert.notEqual(globalThis.localStorage.getItem(KEY), null,
    'an empty-state persist must never delete a snapshot that carries logged work');
  // The next load retries the check and recovers the session.
  assert.equal(freshLoad().resumed, true);
  assert.equal(store.getSessionLog().length, 3, 'all 3 sets survive the refused resume');
  assert.equal(store.getSessionLog()[2].weight, 315);
});

test('#1779 F1: an accepted-plan-only snapshot survives the same refused-resume flow', async () => {
  store.setActivePlannedSession(structuredClone(PLAN));
  store.persistSessionSnapshot(SID);
  assert.equal(freshLoad().resumed, true);
  const stands = await store.confirmResumedSession(SID, async () => ({ unknown: true }), { retries: 0, retryDelayMs: 0 });
  assert.equal(stands, false);
  store.persistSessionSnapshot(null);
  assert.notEqual(globalThis.localStorage.getItem(KEY), null,
    'an accepted plan with no sets yet is still in-progress work — keep it');
  assert.equal(freshLoad().resumed, true);
  assert.equal(store.getActivePlannedSession().accepted, true);
});

test('#1779 F1: an empty-state persist still drops a snapshot that has nothing to keep', () => {
  // A snapshot with no logged sets and no accepted plan is not in-progress
  // work (hydrate would refuse + clear it anyway). The guard must not turn
  // persist into a leak for content-less snapshots.
  const empty = {
    v: 6, ts: Date.now(), session_date: store.snapshotLocalDate(Date.now()),
    sessionLog: [], sessionCompleted: [],
    activePlannedSession: { accepted: false, exercises: [{ name: 'Bench Press' }] },
  };
  globalThis.localStorage.setItem(KEY, JSON.stringify(empty));
  store.persistSessionSnapshot(null);
  assert.equal(globalThis.localStorage.getItem(KEY), null);
});

test('#1779 F1: an explicit clear still removes the snapshot (save / Start Over / discard)', () => {
  logThreeSets();
  store.clearPersistedSnapshot();
  assert.equal(globalThis.localStorage.getItem(KEY), null);
  // The save / Start Over path also resets the in-memory buffers; a later
  // empty-state persist is then a harmless no-op, not a resurrection.
  store.resetSessionStore();
  store.persistSessionSnapshot(null);
  assert.equal(globalThis.localStorage.getItem(KEY), null);
  assert.equal(freshLoad().resumed, false);
});

test('#1779 F2: the finality check retries unknown before refusing', async () => {
  logThreeSets();
  assert.equal(freshLoad().resumed, true);
  let calls = 0;
  const stands = await store.confirmResumedSession(SID, async () => {
    calls += 1;
    return calls < 3 ? { unknown: true } : { finalized: false };
  }, { retries: 2, retryDelayMs: 0 });
  assert.equal(calls, 3, 'two transient unknowns are retried, the third answer stands');
  assert.equal(stands, true, 'a late not-finalized answer recovers the resume in the same load');
  assert.equal(store.getSessionLog().length, 3);
  assert.equal(store.getResumeRefusalReason(), null);
});

test('#1779 F2: exhausted retries refuse but keep the snapshot and report unknown', async () => {
  logThreeSets();
  assert.equal(freshLoad().resumed, true);
  let calls = 0;
  const stands = await store.confirmResumedSession(SID, async () => {
    calls += 1;
    return { unknown: true };
  }, { retries: 2, retryDelayMs: 0 });
  assert.equal(calls, 3, 'three attempts total (initial + 2 retries)');
  assert.equal(stands, false);
  assert.equal(store.getResumeRefusalReason(), 'unknown');
  assert.notEqual(globalThis.localStorage.getItem(KEY), null, 'the snapshot survives for the tap-to-retry / next load');
  assert.equal(freshLoad().resumed, true, 'the next load can retry the check');
  assert.equal(store.getSessionLog().length, 3);
});

test('#1779 F2: a throwing checker is retried like unknown, then stands when it answers', async () => {
  logThreeSets();
  assert.equal(freshLoad().resumed, true);
  let calls = 0;
  const stands = await store.confirmResumedSession(SID, async () => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return { finalized: false };
  }, { retries: 2, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(stands, true);
  assert.equal(store.getSessionLog().length, 3);
});

test('#1779 F2: a late finalized answer still refuses and clears (no phantom resume)', async () => {
  logThreeSets();
  assert.equal(freshLoad().resumed, true);
  let calls = 0;
  const stands = await store.confirmResumedSession(SID, async () => {
    calls += 1;
    return calls < 2 ? { unknown: true } : { finalized: true };
  }, { retries: 2, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(stands, false);
  assert.equal(store.getResumeRefusalReason(), 'finalized');
  assert.equal(globalThis.localStorage.getItem(KEY), null, 'a finalized session’s snapshot is garbage — cleared');
  assert.equal(store.getSessionLog().length, 0);
  // No phantom resume: nothing comes back on the next load, even after an
  // empty-state persist in between.
  store.persistSessionSnapshot(null);
  assert.equal(freshLoad().resumed, false);
  assert.equal(store.getSessionLog().length, 0);
});

test('#1779 F2: retries: 0 keeps the single-attempt behavior for callers that want it', async () => {
  logThreeSets();
  assert.equal(freshLoad().resumed, true);
  let calls = 0;
  const stands = await store.confirmResumedSession(SID, async () => {
    calls += 1;
    return { unknown: true };
  }, { retries: 0, retryDelayMs: 0 });
  assert.equal(calls, 1);
  assert.equal(stands, false);
  assert.equal(store.getResumeRefusalReason(), 'unknown');
});

// ── DOM half wiring (src/app/app.js) ────────────────────────────────────────────

test('#1779 wiring: the shell surfaces resume state and offers a tap-to-retry', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'app.js'), 'utf8');
  // The finality gate's refusal reason reaches the shell.
  assert.match(app, /getResumeRefusalReason/, 'the shell reads the refusal reason');
  // While the check runs, the athlete sees "Restoring…" instead of an empty app.
  assert.match(app, /function renderResumePendingNotice\(\)/, 'a pending notice exists');
  assert.match(app, /Restoring your session/, 'the pending notice says what is happening');
  // An `unknown` refusal renders a retry notice (not silence) whose tap
  // re-runs the restore against the kept snapshot.
  assert.match(app, /function renderResumeRetryNotice\(\)/, 'a retry notice exists');
  assert.match(app, /tap to retry/i, 'the retry notice names the affordance');
  const retryRegion = app.slice(app.indexOf('function renderResumeRetryNotice('));
  assert.match(retryRegion, /restoreSessionSnapshot\(\)/, 'tapping the retry notice re-runs the restore');
  // A finalized refusal hides the notice — a finished session never resurrects.
  const restoreRegion = app.slice(app.indexOf('async function restoreSessionSnapshot('));
  assert.match(restoreRegion, /getResumeRefusalReason\(\) === 'unknown'/,
    'the restore distinguishes an unknown refusal (retry) from a finalized one (hide)');
  // The retry re-entry cannot stack concurrent restores.
  assert.match(restoreRegion, /resumeRestoreInFlight/, 'concurrent restores are guarded');
});
