'use strict';

// PR-F — accepted-plan identity survives reload via the EXISTING session snapshot
// store (src/app/store.js), reused (not a new persistence layer). Pins the owner's
// reload requirements: an accepted plan-only snapshot (no logged sets) restores with
// its pv_/pi_ identity intact; restore mints no new ids and makes no network call;
// an UNACCEPTED plan-only snapshot is still NOT resumed (preserves the 2026-07-03
// "don't hijack a fresh freestyle log" fix).

const test = require('node:test');
const assert = require('node:assert/strict');

let store;
function fakeLocalStorage() {
  const mem = new Map();
  return { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: k => { mem.delete(k); }, _mem: mem };
}

test.before(async () => { globalThis.localStorage = fakeLocalStorage(); store = await import('../src/app/store.js'); });
test.beforeEach(() => { globalThis.localStorage = fakeLocalStorage(); store.resetSessionStore(); });

const ACCEPTED_PLAN = {
  label: 'Upper A', intentId: 'upper_a',
  session_id: '20260710-AM-01', session_date: '2026-07-10',
  plan_version: 'pv_9f1c8e0a-4d2b-4f6a-9c11-7e5b2a0d1c33',
  accepted: true,
  items: [
    { plan_item_id: 'pi_aaaa1111', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: null, outcome: 'planned', performed_lift_code: null },
    { plan_item_id: 'pi_bbbb2222', planned_order: 2, planned_lift_code: 'ROW01', movement_pattern: null, outcome: 'planned', performed_lift_code: null },
  ],
  exercises: [{ name: 'Bench Press', liftCode: 'BEN01' }, { name: 'Barbell Row', liftCode: 'ROW01' }],
  index: 0,
};

test('an accepted plan-only snapshot (no sets) survives reload with pv_/pi_ identity intact', () => {
  store.setActivePlannedSession(ACCEPTED_PLAN);
  store.persistSessionSnapshot('20260710-AM-01');
  // simulate a reload: in-memory state gone, localStorage persists
  store.setActivePlannedSession(null);
  const res = store.hydrateSessionSnapshot();
  assert.equal(res.resumed, true);
  const restored = store.getActivePlannedSession();
  assert.ok(restored, 'the accepted plan is restored even with no logged sets');
  assert.equal(restored.accepted, true);
  assert.equal(restored.plan_version, 'pv_9f1c8e0a-4d2b-4f6a-9c11-7e5b2a0d1c33', 'same plan_version, not re-minted');
  assert.deepEqual(restored.items.map(i => i.plan_item_id), ['pi_aaaa1111', 'pi_bbbb2222'], 'same immutable plan_item_ids');
  assert.deepEqual(restored.items.map(i => i.planned_lift_code), ['BEN01', 'ROW01']);
});

test('restore mints no new identity — the restored ids are byte-identical to the persisted ones', () => {
  store.setActivePlannedSession(ACCEPTED_PLAN);
  store.persistSessionSnapshot('20260710-AM-01');
  const persistedRaw = globalThis.localStorage.getItem('atlas_session_snapshot_v1');
  store.setActivePlannedSession(null);
  store.hydrateSessionSnapshot();
  const restored = store.getActivePlannedSession();
  // Every id in the restored plan appears verbatim in the persisted JSON (no re-mint).
  assert.ok(persistedRaw.includes(restored.plan_version));
  for (const it of restored.items) assert.ok(persistedRaw.includes(it.plan_item_id));
});

test('an UNACCEPTED plan-only snapshot is still NOT resumed (2026-07-03 freestyle-log fix preserved)', () => {
  const draft = { label: 'Upper A', intentId: 'upper_a', exercises: [{ name: 'Bench Press', liftCode: 'BEN01' }], index: 0 }; // no accepted flag
  store.setActivePlannedSession(draft);
  store.persistSessionSnapshot('20260710-AM-01');
  store.setActivePlannedSession(null);
  const res = store.hydrateSessionSnapshot();
  assert.equal(res.resumed, false, 'a non-accepted plan-only snapshot must not silently resume');
  assert.equal(store.getActivePlannedSession(), null);
});
