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
  const calls = { setActivePlan: [], persist: 0, startWorkout: [], postAccept: [], postLedgerCheckpoint: [] };
  const deps = {
    crypto: fakeRandomUuidCrypto(),
    guard: {},
    sessionId: '20260710-AM-01',
    sessionDate: '2026-07-10',
    setActivePlan: (p) => calls.setActivePlan.push(p),
    persist: () => { calls.persist += 1; },
    startWorkout: (p) => calls.startWorkout.push(p),
    postAccept: async (payload) => { calls.postAccept.push(payload); return { data: { session_plans: { captured: true, status: 'written' } } }; },
    postLedgerCheckpoint: async (payload) => { calls.postLedgerCheckpoint.push(payload); return { data: { session_plan_sets: { captured: false, status: 'dry_run' } } }; },
    ...overrides,
  };
  return { deps, calls };
}

// ── F10B: build the ledger v1 items + checkpoint at acceptance ──────────────────

test('buildLedgerAcceptedItems: one row-spec per set-level item; targets carried; confidence set', () => {
  const items = [
    { plan_item_id: 'pi_1', planned_lift_code: 'DIP01' },
    { plan_item_id: 'pi_2', planned_lift_code: 'ROW01' },
  ];
  const exercises = [
    { sets: 3, weight: 65, reps: 5, rir: 2 },
    { sets: 3, weight: 100, reps: 8, rir: 1 },
  ];
  const out = mod.buildLedgerAcceptedItems(items, exercises);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { plan_item_id: 'pi_1', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2, confidence: 'reliable' });
});

test('buildLedgerAcceptedItems: no set count → NOT in the ledger; set count but no load/reps → no_reliable_target (never fabricated)', () => {
  const items = [
    { plan_item_id: 'pi_1', planned_lift_code: 'A1' },   // no sets → skipped
    { plan_item_id: 'pi_2', planned_lift_code: 'B1' },   // sets but no load/reps → no_reliable_target
    { plan_item_id: 'pi_3', planned_lift_code: 'PU01' }, // bodyweight (0) is a real target
  ];
  const exercises = [
    { weight: 100, reps: 5 },              // no sets
    { sets: 4 },                            // no load/reps
    { sets: 3, weight: 0, reps: 8, rir: 2 },
  ];
  const out = mod.buildLedgerAcceptedItems(items, exercises);
  assert.deepEqual(out.map(o => o.plan_item_id), ['pi_2', 'pi_3'], 'the no-set-count item is not invented into the ledger');
  assert.equal(out[0].confidence, 'no_reliable_target');
  assert.equal(out[0].target_weight, null, 'a missing target is never fabricated');
  assert.equal(out[1].confidence, 'reliable');
  assert.equal(out[1].target_weight, 0, 'bodyweight 0 is a real target');
});

test('runAcceptance: checkpoints the accepted plan as ledger v1 (non-blocking) when the plan has set-level targets', async () => {
  const { deps, calls } = harness();
  const REC_SETS = {
    label: 'Push', id: 'i1',
    exercises: [
      { name: 'Weighted Dip', liftCode: 'DIP01', sets: 3, weight: 65, reps: 5, rir: 2 },
      { name: 'Cable Row', liftCode: 'ROW01', sets: 3, weight: 100, reps: 8, rir: 1 },
    ],
  };
  const r = await mod.runAcceptance(REC_SETS, deps);
  assert.equal(r.started, true);
  assert.equal(calls.postLedgerCheckpoint.length, 1, 'the ledger checkpoint fires at acceptance');
  const payload = calls.postLedgerCheckpoint[0];
  assert.equal(payload.plan_version, r.plan_version, 'carries the accepted pv_ token');
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].target_weight, 65);
  assert.equal(payload.items[0].confidence, 'reliable');
  // The plan_item_id on each ledger item matches the accepted snapshot (the F10 spine).
  const acceptedIds = calls.startWorkout[0].items.map(i => i.plan_item_id);
  assert.deepEqual(payload.items.map(i => i.plan_item_id), acceptedIds);
});

test('runAcceptance: a codes-only plan (no set counts) posts NO ledger checkpoint (nothing to store)', async () => {
  const { deps, calls } = harness();
  await mod.runAcceptance(REC, deps); // REC exercises carry no sets
  assert.equal(calls.postLedgerCheckpoint.length, 0);
});

test('runAcceptance: a ledger-checkpoint sidecar failure never unwinds the accepted plan', async () => {
  const { deps, calls } = harness({ postLedgerCheckpoint: async () => { throw new Error('network down'); } });
  const REC_SETS = { label: 'Push', id: 'i1', exercises: [{ name: 'Weighted Dip', liftCode: 'DIP01', sets: 3, weight: 65, reps: 5, rir: 2 }] };
  const r = await mod.runAcceptance(REC_SETS, deps);
  assert.equal(r.started, true, 'the workout starts regardless of the checkpoint sidecar');
  assert.equal(calls.startWorkout.length, 1);
});

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

// ── server-allocated session identity (authority fix, 2026-08-03) ───────────────
// With no ESTABLISHED identity the client derives nothing (its old
// `${date}-{AM|PM}-01` mint re-used the first same-period session's identity):
// it sends NO session_id, and the /accept response's server-allocated identity
// becomes the session's established one.

const ALLOCATED = '20260803-PM-02';
const REC_SETS_ONE = { label: 'Push', id: 'i1', exercises: [{ name: 'Weighted Dip', liftCode: 'DIP01', sets: 3, weight: 65, reps: 5, rir: 2 }] };

function unestablishedHarness(overrides = {}) {
  const adopted = [];
  const h = harness({
    sessionId: null,
    adoptSessionId: (sid) => adopted.push(sid),
    postAccept: async (payload) => {
      h.calls.postAccept.push(payload);
      return { data: { session_plans: { captured: true, status: 'written' }, session_id: ALLOCATED } };
    },
    ...overrides,
  });
  return { ...h, adopted };
}

test('unestablished: the accept payload carries NO session_id key at all', async () => {
  const { deps, calls } = unestablishedHarness();
  await mod.runAcceptance(REC, deps);
  assert.equal(calls.postAccept.length, 1);
  assert.ok(!('session_id' in calls.postAccept[0]), 'no decided identity is sent — omitted, not blanked');
  assert.deepEqual(Object.keys(calls.postAccept[0]).sort(), ['items', 'plan_version', 'session_date'].sort());
});

test('unestablished: the server-allocated identity is ADOPTED — stored plan, adopt hook, result', async () => {
  const { deps, calls, adopted } = unestablishedHarness();
  const r = await mod.runAcceptance(REC, deps);
  assert.deepEqual(adopted, [ALLOCATED], 'adoptSessionId receives the allocated identity exactly once');
  assert.equal(calls.setActivePlan[0].session_id, ALLOCATED, 'the LIVE stored plan carries the adopted identity');
  assert.equal(r.session_id, ALLOCATED);
  assert.equal(r.captured, true);
});

test('unestablished: the ledger checkpoint WAITS for the allocated identity and carries it', async () => {
  const { deps, calls } = unestablishedHarness();
  let checkpointBeforeAccept = false;
  deps.postLedgerCheckpoint = async (payload) => {
    if (calls.postAccept.length === 0) checkpointBeforeAccept = true;
    calls.postLedgerCheckpoint.push(payload);
    return { data: { session_plan_sets: { captured: false, status: 'dry_run' } } };
  };
  await mod.runAcceptance(REC_SETS_ONE, deps);
  assert.equal(checkpointBeforeAccept, false, 'no checkpoint row may exist under a guessed identity');
  assert.equal(calls.postLedgerCheckpoint.length, 1);
  assert.equal(calls.postLedgerCheckpoint[0].session_id, ALLOCATED);
});

test('unestablished + a response naming NO identity: nothing is adopted, no checkpoint fires, the workout still starts', async () => {
  const { deps, calls, adopted } = unestablishedHarness({
    postAccept: async (payload) => { calls.postAccept.push(payload); return { data: { session_plans: { captured: true, status: 'written' } } }; },
  });
  const r = await mod.runAcceptance(REC_SETS_ONE, deps);
  assert.equal(r.started, true);
  assert.deepEqual(adopted, []);
  assert.equal(calls.setActivePlan[0].session_id, null, 'the session stays unnamed — never a client-derived identity');
  assert.equal(calls.postLedgerCheckpoint.length, 0, 'no ledger row under an unnamed session');
});

test('unestablished + BOTH attempts fail: started, unnamed, no adoption, no checkpoint, exactly one recovery retry', async () => {
  let attempts = 0;
  const { deps, calls, adopted } = unestablishedHarness({
    postAccept: async () => { attempts += 1; throw new Error('network down'); },
  });
  const r = await mod.runAcceptance(REC_SETS_ONE, deps);
  assert.equal(r.started, true);
  assert.equal(r.captured, false);
  assert.equal(attempts, 2, 'one original attempt + ONE bounded recovery retry, never more');
  assert.deepEqual(adopted, []);
  assert.equal(calls.setActivePlan[0].session_id, null);
  assert.equal(calls.postLedgerCheckpoint.length, 0);
});

// Codex P1 (this PR): a lost response can follow a COMPLETED server-side write. The
// recovery retry re-sends the identical pv_ payload; the route's durable retry-reuse
// returns the ORIGINAL identity, so the client recovers the id instead of leaving the
// session unnamed (where outcome/closeout fail closed and a later save could split
// the workout across identities).
test('unestablished + lost first response: the recovery retry recovers the SAME allocated identity and adopts it', async () => {
  let attempts = 0;
  const payloads = [];
  const { deps, calls, adopted } = unestablishedHarness({
    postAccept: async (payload) => {
      attempts += 1;
      payloads.push(payload);
      if (attempts === 1) throw new Error('response lost (client abort)');
      return { data: { session_plans: { captured: true, status: 'skipped' }, session_id: ALLOCATED } };
    },
  });
  const r = await mod.runAcceptance(REC_SETS_ONE, deps);
  assert.equal(attempts, 2);
  assert.deepEqual(payloads[0], payloads[1], 'the retry re-sends the IDENTICAL payload — same pv_/pi_ identity, never re-minted');
  assert.deepEqual(adopted, [ALLOCATED], 'the recovered identity is adopted');
  assert.equal(calls.setActivePlan[0].session_id, ALLOCATED);
  assert.equal(calls.postLedgerCheckpoint.length, 1, 'the ledger checkpoint fires under the recovered identity');
  assert.equal(calls.postLedgerCheckpoint[0].session_id, ALLOCATED);
  assert.equal(r.captured, true);
  assert.equal(r.session_id, ALLOCATED);
});

test('established + sidecar failure: NO recovery retry — an established identity needs none', async () => {
  let attempts = 0;
  const { deps } = harness({
    postAccept: async () => { attempts += 1; throw new Error('network down'); },
  });
  const r = await mod.runAcceptance(REC, deps);
  assert.equal(r.started, true);
  assert.equal(attempts, 1, 'the pre-fix single-attempt semantics hold when identity is already established');
});

test('established: the identity is sent, the checkpoint fires immediately under it, and nothing is adopted', async () => {
  const adopted = [];
  const { deps, calls } = harness({
    adoptSessionId: (sid) => adopted.push(sid),
    postAccept: async (payload) => {
      calls.postAccept.push(payload);
      // the server echoes an established identity verbatim
      return { data: { session_plans: { captured: true, status: 'written' }, session_id: '20260710-AM-01' } };
    },
  });
  let checkpointBeforeAccept = false;
  deps.postLedgerCheckpoint = async (payload) => {
    if (calls.postAccept.length === 0) checkpointBeforeAccept = true;
    calls.postLedgerCheckpoint.push(payload);
    return {};
  };
  const r = await mod.runAcceptance(REC_SETS_ONE, deps);
  assert.equal(calls.postAccept[0].session_id, '20260710-AM-01');
  assert.equal(checkpointBeforeAccept, true, 'an established identity checkpoints immediately, as before');
  assert.equal(calls.postLedgerCheckpoint[0].session_id, '20260710-AM-01');
  assert.deepEqual(adopted, [], 'an echoed established identity is not an adoption');
  assert.equal(r.session_id, '20260710-AM-01');
});
