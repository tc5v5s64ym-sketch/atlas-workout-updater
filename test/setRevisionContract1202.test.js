'use strict';

// #1202 — set-revision contract mismatch: the proposal builder accepted weight OR reps,
// but the ledger emitter (sessionLedger.buildFutureRevisions) requires weight AND reps.
// A reps-only (or weight-only) proposal was buildable, storable, renderable and approvable —
// and emitted nothing, while approvePendingSetRevision consumed it before emitting, so the
// athlete's decision was destroyed silently.
//
// Fix (issue options 1 + 2):
//  1. buildSetRevisionProposal aligns to the emitter: weight AND reps are both required.
//     Checked callers first: the only production producer is
//     maybeProposeSetRevisionAfterLog (app.js), whose target comes from the engine's
//     next_target. A target missing either half could never emit a revision anyway, so
//     no legitimate proposal is lost — it simply is not offered, instead of being
//     offered and then silently dropped on approval.
//  2. hydrateSessionSnapshot re-runs the restored pendingSetRevision through the builder,
//     so a corrupted or hand-edited snapshot cannot resurrect an unemittable proposal.

const test = require('node:test');
const assert = require('node:assert/strict');

let proposalMod = null;
let storeMod = null;

function fakeLocalStorage() {
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}

test.before(async () => {
  globalThis.localStorage = fakeLocalStorage();
  proposalMod = await import('../src/app/setRevisionProposal.js');
  storeMod = await import('../src/app/store.js');
});

const PLAN = {
  accepted: true,
  session_id: 'S1',
  session_date: '2026-07-29',
  plan_version: 'pv_x',
  exercises: [{ name: 'Back Squat', lift_code: 'SQ01', plan_item_id: 'pi-1', sets: 3 }],
};

const BASE_INPUT = {
  plan_item_id: 'pi-1',
  planned_lift_code: 'SQ01',
  prescribed_name: 'Back Squat',
  from: { weight: 225, reps: 5, rir: 2 },
  accepted_set_count: 3,
  plan_version: 'pv_x',
};

test('#1202 builder refuses a reps-only prescription (unemittable)', () => {
  const p = proposalMod.buildSetRevisionProposal({
    ...BASE_INPUT, prescription: { weight: null, reps: 8, rir: 2 },
  });
  assert.equal(p, null, 'a proposal the ledger can never emit must not be built');
});

test('#1202 builder refuses a weight-only prescription (unemittable)', () => {
  const p = proposalMod.buildSetRevisionProposal({
    ...BASE_INPUT, prescription: { weight: 185, reps: null, rir: 2 },
  });
  assert.equal(p, null, 'a proposal the ledger can never emit must not be built');
});

test('#1202 builder still builds a complete prescription that changes the target', () => {
  const p = proposalMod.buildSetRevisionProposal({
    ...BASE_INPUT, prescription: { weight: 185, reps: 5, rir: 2 },
  });
  assert.ok(p, 'a complete, differing prescription must still build');
  assert.equal(p.prescription.weight, 185);
  assert.equal(p.prescription.reps, 5);
});

function seedSnapshot(pendingSetRevision) {
  globalThis.localStorage = fakeLocalStorage();
  storeMod.resetSessionStore();
  const snap = {
    v: 6,
    ts: Date.now(),
    sessionLog: [{ exercise: 'Back Squat', sets: [{ weight: 225, reps: 5, rir: 2 }] }],
    sessionCompleted: [],
    activePlannedSession: JSON.parse(JSON.stringify(PLAN)),
    pendingSetRevision,
    sessionId: 'S1',
  };
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify(snap));
}

test('#1202 hydrate drops a restored reps-only pendingSetRevision', () => {
  const corrupt = proposalMod.buildSetRevisionProposal({
    ...BASE_INPUT, prescription: { weight: 185, reps: 5, rir: 2 },
  });
  assert.ok(corrupt, 'control proposal must build');
  // Hand-edit the stored form the way a corrupted snapshot would carry it:
  // a prescription the builder would now refuse.
  const tampered = { ...corrupt, prescription: { weight: null, reps: 8, rir: 2 } };
  seedSnapshot(tampered);
  const res = storeMod.hydrateSessionSnapshot();
  assert.equal(res.resumed, true, 'the session itself still resumes');
  assert.equal(storeMod.getPendingSetRevision(), null,
    'an unemittable restored proposal must not be re-surfaced for approval');
});

test('#1202 hydrate keeps a valid restored pendingSetRevision intact', () => {
  const valid = proposalMod.buildSetRevisionProposal({
    ...BASE_INPUT, prescription: { weight: 185, reps: 5, rir: 2 },
  });
  assert.ok(valid, 'control proposal must build');
  seedSnapshot(JSON.parse(JSON.stringify(valid)));
  const res = storeMod.hydrateSessionSnapshot();
  assert.equal(res.resumed, true);
  const restored = storeMod.getPendingSetRevision();
  assert.ok(restored, 'a valid proposal must survive reload');
  assert.equal(restored.proposal_id, valid.proposal_id, 'identity is preserved across reload');
  assert.equal(restored.prescription.weight, 185);
  assert.equal(restored.prescription.reps, 5);
});
