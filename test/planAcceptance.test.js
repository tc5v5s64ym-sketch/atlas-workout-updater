'use strict';

// PR-F — plan-acceptance identity + orchestration (src/app/planAcceptance.js).
// Pure/DI, so it runs in Node with no DOM. Covers the owner's PR-F requirements at
// the unit level: opaque pv_/pi_ UUID identity (crypto only, never timestamp/random);
// one immutable item per displayed exercise; unresolved identity blocks with no
// partial snapshot; double-tap mints one revision; flag-OFF/disabled/sidecar-failure
// still start the workout and preserve the local snapshot; only captured===true
// licenses memory language.

const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => { mod = await import('../src/app/planAcceptance.js'); });

// Fake cryptos ---------------------------------------------------------------
function fakeRandomUuidCrypto() {
  let n = 0;
  return { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
}
function fakeGetRandomValuesCrypto() {
  return { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 1) & 0xff; return arr; } };
}

const REC = {
  label: 'Upper A', id: 'upper_a',
  exercises: [
    { name: 'Bench Press', liftCode: 'BEN01' },
    { name: 'Barbell Row', liftCode: 'ROW01' },
  ],
};

// ── identity minting ──────────────────────────────────────────────────────────

test('mintId: crypto.randomUUID → prefixed opaque token', () => {
  const c = fakeRandomUuidCrypto();
  assert.match(mod.mintId(mod.PV_PREFIX, c), /^pv_[0-9a-f-]{36}$/);
  assert.match(mod.mintId(mod.PI_PREFIX, c), /^pi_[0-9a-f-]{36}$/);
});

test('mintId: getRandomValues fallback → a v4-shaped uuid, prefixed', () => {
  const id = mod.mintId(mod.PV_PREFIX, fakeGetRandomValuesCrypto());
  assert.match(id, /^pv_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('mintId: no cryptographic source → null (never a timestamp/Math.random identity)', () => {
  assert.equal(mod.mintId(mod.PV_PREFIX, null), null);
  assert.equal(mod.mintId(mod.PI_PREFIX, {}), null); // object with neither randomUUID nor getRandomValues
});

// ── item construction ─────────────────────────────────────────────────────────

test('buildAcceptedItems: one immutable item per displayed exercise, unique pi_ ids', () => {
  const c = fakeRandomUuidCrypto();
  const r = mod.buildAcceptedItems(REC.exercises, () => mod.mintId(mod.PI_PREFIX, c));
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map(i => i.planned_order), [1, 2]);
  assert.deepEqual(r.items.map(i => i.planned_lift_code), ['BEN01', 'ROW01']);
  assert.ok(r.items.every(i => /^pi_/.test(i.plan_item_id)));
  assert.equal(new Set(r.items.map(i => i.plan_item_id)).size, 2, 'ids are unique');
  assert.ok(r.items.every(i => i.outcome === 'planned' && i.performed_lift_code === null));
});

test('buildAcceptedItems: an unresolved / non-canonical lift code blocks (no partial)', () => {
  const c = fakeRandomUuidCrypto();
  for (const bad of [{ name: 'X', liftCode: '' }, { name: 'X', liftCode: 'BEN 01' }, { name: 'X' }]) {
    const r = mod.buildAcceptedItems([{ name: 'Bench', liftCode: 'BEN01' }, bad], () => mod.mintId(mod.PI_PREFIX, c));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unresolved_item');
  }
});

test('buildAcceptedItems: empty plan → not ok', () => {
  assert.equal(mod.buildAcceptedItems([], () => 'pi_x').ok, false);
});

// ── copy: only captured===true licenses memory language ───────────────────────

test('acceptCopy: only captured===true permits memory language', () => {
  assert.deepEqual(mod.acceptCopy({ captured: true, status: 'written' }), { memory: true, text: 'Plan captured.' });
  for (const env of [
    { captured: false, status: 'disabled' },
    { captured: false, status: 'tab_missing' },
    { captured: false, status: 'header_mismatch' },
    { captured: false, status: 'error' },
    { status: 'unknown' },
    null,
    undefined,
  ]) {
    assert.deepEqual(mod.acceptCopy(env), { memory: false, text: 'Plan started.' });
  }
});

// ── orchestration ─────────────────────────────────────────────────────────────

function harness(overrides = {}) {
  const calls = { setActivePlan: [], persist: 0, startWorkout: [], postAccept: [] };
  const deps = {
    crypto: fakeRandomUuidCrypto(),
    guard: {},
    sessionId: '20260710-AM-01',
    sessionDate: '2026-07-10',
    setActivePlan: (p) => calls.setActivePlan.push(p),
    persist: () => { calls.persist += 1; },
    startWorkout: (p) => calls.startWorkout.push(p),
    postAccept: async (payload) => { calls.postAccept.push(payload); return { data: { session_plans: { captured: true, status: 'written' } } }; },
    ...overrides,
  };
  return { deps, calls };
}

test('runAcceptance: happy path stores the accepted snapshot, starts the workout, mints one revision', async () => {
  const { deps, calls } = harness();
  const r = await mod.runAcceptance(REC, deps);
  assert.equal(r.started, true);
  assert.equal(r.captured, true);
  assert.equal(r.message, 'Plan captured.');
  assert.match(r.plan_version, /^pv_/);
  assert.equal(calls.setActivePlan.length, 1);
  const stored = calls.setActivePlan[0];
  assert.equal(stored.accepted, true);
  assert.equal(stored.plan_version, r.plan_version);
  assert.equal(stored.items.length, 2);
  // PR-G1: each execution-view exercise is tagged with its immutable plan_item_id
  // (items[i] ↔ exercises[i]), so a later skip/substitution resolves identity DIRECTLY
  // off the slot — never by lift-code/name/position.
  assert.deepEqual(stored.exercises.map(e => e.plan_item_id), stored.items.map(i => i.plan_item_id));
  assert.equal(stored.session_id, '20260710-AM-01');
  assert.equal(calls.persist, 1, 'snapshot persisted before/with the request');
  assert.equal(calls.startWorkout.length, 1, 'workout started');
  assert.equal(calls.postAccept.length, 1);
  assert.equal(calls.postAccept[0].plan_version, r.plan_version);
  assert.equal(calls.postAccept[0].items.length, 2);
});

test('runAcceptance: a concurrent double-tap mints ONE revision (guard.busy)', async () => {
  const { deps, calls } = harness();
  const [a, b] = await Promise.all([mod.runAcceptance(REC, deps), mod.runAcceptance(REC, deps)]);
  const started = [a, b].filter(x => x.started);
  const ignored = [a, b].filter(x => x.ignored);
  assert.equal(started.length, 1, 'exactly one acceptance runs');
  assert.equal(ignored.length, 1, 'the second tap is ignored');
  assert.equal(calls.setActivePlan.length, 1, 'only one accepted revision stored');
});

test('runAcceptance: flag-OFF / disabled response still starts the workout, no memory language', async () => {
  const { deps, calls } = harness({ postAccept: async () => ({ data: { session_plans: { captured: false, status: 'disabled' } } }) });
  const r = await mod.runAcceptance(REC, deps);
  assert.equal(r.started, true);
  assert.equal(r.captured, false);
  assert.equal(r.message, 'Plan started.');
  assert.equal(calls.startWorkout.length, 1);
  assert.equal(calls.setActivePlan.length, 1, 'the accepted snapshot is still stored locally');
});

test('runAcceptance: a sidecar failure still starts the workout and preserves the snapshot (no re-mint)', async () => {
  const { deps, calls } = harness({ postAccept: async () => { throw new Error('network down'); } });
  const r = await mod.runAcceptance(REC, deps);
  assert.equal(r.started, true);
  assert.equal(r.captured, false);
  assert.equal(r.message, 'Plan started.');
  assert.equal(calls.setActivePlan.length, 1, 'snapshot preserved despite the failure');
  assert.equal(calls.persist, 1);
  assert.equal(calls.startWorkout.length, 1);
});

test('runAcceptance: an unresolved plan item blocks acceptance — no snapshot, no start, clear message', async () => {
  const badRec = { label: 'X', id: 'x', exercises: [{ name: 'Bench', liftCode: 'BEN01' }, { name: 'Mystery', liftCode: '' }] };
  const { deps, calls } = harness();
  const r = await mod.runAcceptance(badRec, deps);
  assert.equal(r.started, false);
  assert.equal(r.blocked, true);
  assert.equal(r.message, mod.UNRESOLVED_PLAN_MESSAGE);
  assert.equal(calls.setActivePlan.length, 0, 'no partial accepted snapshot');
  assert.equal(calls.persist, 0);
  assert.equal(calls.startWorkout.length, 0);
  assert.equal(calls.postAccept.length, 0);
});

test('runAcceptance: no cryptographic source blocks acceptance (never a weak identity)', async () => {
  const { deps, calls } = harness({ crypto: null });
  const r = await mod.runAcceptance(REC, deps);
  assert.equal(r.blocked, true);
  assert.equal(calls.setActivePlan.length, 0);
});

test('runAcceptance: the POST payload carries identity + planned metadata only (no loads/reps)', async () => {
  const { deps, calls } = harness();
  await mod.runAcceptance(REC, deps);
  const payload = calls.postAccept[0];
  assert.deepEqual(Object.keys(payload).sort(), ['items', 'plan_version', 'session_date', 'session_id'].sort());
  const it = payload.items[0];
  assert.ok(it.plan_item_id && it.planned_order && it.planned_lift_code);
  assert.ok(!('weight' in it) && !('reps' in it) && !('rir' in it), 'no loads/reps/RIR in the accept payload');
});
