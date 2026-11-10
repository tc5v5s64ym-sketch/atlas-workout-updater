'use strict';

// #1692 — resume must not resurrect a finalized session (D1) or a snapshot
// from another training day (D2). Store-level tests: persist stamps
// session_date; hydrate enforces date equality (from the field when present,
// derived from `ts` for pre-fix snapshots); confirmResumedSession enforces
// the server's closeout finality — finalized refuses + clears the snapshot,
// unknown fails closed but KEEPS it so the next load can retry.

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

const KEY = 'atlas_session_snapshot_v1';

test.before(async () => {
  globalThis.localStorage = fakeLocalStorage();
  store = await import('../src/app/store.js');
});

test.beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
  store.resetSessionStore();
});

function seedSnapshot({ sid, ts, session_date, withLog = true }) {
  const snap = {
    v: 6,
    ts,
    ...(session_date !== undefined ? { session_date } : {}),
    sessionLog: withLog ? [{ exercise: 'Bench Press', weight: 135, reps: 8 }] : [],
    sessionCompleted: withLog ? ['Bench Press'] : [],
    activePlannedSession: { accepted: true, exercises: [{ name: 'Bench Press' }] },
    sessionId: sid,
  };
  globalThis.localStorage.setItem(KEY, JSON.stringify(snap));
  return snap;
}

// 2026-11-08 23:30 local → 2026-11-09 07:00 local (7.5 h later, next day).
const NIGHT = new Date(2026, 10, 8, 23, 30, 0).getTime();
const MORNING = new Date(2026, 10, 9, 7, 0, 0).getTime();

function withMockedNow(now, fn) {
  const realNow = Date.now;
  Date.now = () => now;
  try { return fn(); } finally { Date.now = realNow; }
}

test('D2: persist stamps session_date with today’s local date', () => {
  store.setSessionLog([{ exercise: 'Bench Press', weight: 135, reps: 8 }]);
  store.persistSessionSnapshot('SID-1');
  const snap = JSON.parse(globalThis.localStorage.getItem(KEY));
  assert.equal(snap.session_date, store.snapshotLocalDate(Date.now()));
  assert.match(snap.session_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('D2: hydrate refuses a cross-midnight snapshot and clears it', () => {
  seedSnapshot({ sid: 'S1', ts: NIGHT, session_date: '2026-11-08' });
  const res = withMockedNow(MORNING, () => store.hydrateSessionSnapshot());
  assert.equal(res.resumed, false);
  assert.equal(globalThis.localStorage.getItem(KEY), null);
});

test('D2: hydrate accepts a same-day snapshot', () => {
  const now = Date.now();
  seedSnapshot({ sid: 'S1', ts: now, session_date: store.snapshotLocalDate(now) });
  const res = store.hydrateSessionSnapshot();
  assert.equal(res.resumed, true);
  assert.equal(res.sessionId, 'S1');
});

test('D2: a pre-fix snapshot without session_date derives its date from ts', () => {
  // Cross-midnight, no field → refused.
  seedSnapshot({ sid: 'S1', ts: NIGHT });
  const refused = withMockedNow(MORNING, () => store.hydrateSessionSnapshot());
  assert.equal(refused.resumed, false);
  assert.equal(globalThis.localStorage.getItem(KEY), null);
  // Same day, no field → accepted.
  const now = Date.now();
  seedSnapshot({ sid: 'S1', ts: now });
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
});

test('D2: a malformed session_date falls back to the ts-derived date', () => {
  seedSnapshot({ sid: 'S1', ts: NIGHT, session_date: 'yesterday' });
  const res = withMockedNow(MORNING, () => store.hydrateSessionSnapshot());
  assert.equal(res.resumed, false);
});

test('D1: a finalized session is refused and its snapshot is cleared', async () => {
  seedSnapshot({ sid: 'sess-final-1', ts: Date.now(), session_date: store.snapshotLocalDate(Date.now()) });
  const hydrated = store.hydrateSessionSnapshot();
  assert.equal(hydrated.resumed, true);
  assert.equal(store.getSessionLog().length, 1);
  const stands = await store.confirmResumedSession('sess-final-1', async () => ({ finalized: true }));
  assert.equal(stands, false);
  assert.equal(store.getSessionLog().length, 0, 'the applied snapshot is rolled back out of the slice');
  assert.equal(globalThis.localStorage.getItem(KEY), null, 'a finalized session’s snapshot is garbage — cleared');
  assert.equal(store.hydrateSessionSnapshot().resumed, false);
});

test('D1: an open session stands and keeps its snapshot', async () => {
  seedSnapshot({ sid: 'sess-open-1', ts: Date.now(), session_date: store.snapshotLocalDate(Date.now()) });
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  const stands = await store.confirmResumedSession('sess-open-1', async () => ({ finalized: false }));
  assert.equal(stands, true);
  assert.equal(store.getSessionLog().length, 1);
  assert.notEqual(globalThis.localStorage.getItem(KEY), null);
});

test('D1: unknown finality fails closed but KEEPS the snapshot for a retry', async () => {
  seedSnapshot({ sid: 'sess-open-1', ts: Date.now(), session_date: store.snapshotLocalDate(Date.now()) });
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  const stands = await store.confirmResumedSession('sess-open-1', async () => ({ unknown: true }));
  assert.equal(stands, false);
  assert.equal(store.getSessionLog().length, 0, 'the slice is rolled back');
  assert.notEqual(globalThis.localStorage.getItem(KEY), null, 'a transient check failure must not delete the in-progress snapshot');
  assert.equal(store.hydrateSessionSnapshot().resumed, true, 'the next load can retry the check');
});

test('D1: a throwing checker is unknown (refuse, snapshot kept)', async () => {
  seedSnapshot({ sid: 'sess-open-1', ts: Date.now(), session_date: store.snapshotLocalDate(Date.now()) });
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  const stands = await store.confirmResumedSession('sess-open-1', async () => { throw new Error('network down'); });
  assert.equal(stands, false);
  assert.notEqual(globalThis.localStorage.getItem(KEY), null);
});

test('D1: a snapshot with no server session id has nothing to check', async () => {
  const snap = seedSnapshot({ sid: undefined, ts: Date.now(), session_date: store.snapshotLocalDate(Date.now()) });
  delete snap.sessionId;
  globalThis.localStorage.setItem(KEY, JSON.stringify(snap));
  assert.equal(store.hydrateSessionSnapshot().resumed, true);
  let checkerCalled = false;
  const stands = await store.confirmResumedSession(null, async () => { checkerCalled = true; return { finalized: true }; });
  assert.equal(stands, true);
  assert.equal(checkerCalled, false);
});
