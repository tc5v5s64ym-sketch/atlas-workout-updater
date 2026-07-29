'use strict';

// #1189 — the prescription-only proposal lane, end to end: Atlas proposes a set-level change on a
// movement that STAYS in the plan, the athlete explicitly accepts, and exactly one revision is
// captured.
//
// This is the INTEGRATION seam, not a unit test of the emitter. It drives the real builder, the
// real store (persist + hydrate, so reload is genuinely exercised), and the real approve/reject
// handlers sliced from the BUILT bundle — the same technique
// test/substitutionBindingWiring.test.js uses. It never calls `emitEndorsedSetRevision` directly;
// that entry point (merged in #1188) is reached only through an approval, which is the whole
// point of this issue.
//
// VERIFIED GAP (gate, on main @ 2cc8b0d): `pendingSetRevision` does not exist anywhere; the only
// proposal lane is `pendingReplacement`, which is movement-scoped and explicitly rejects a
// same-movement proposal (`src/app/app.js:2247`, "A no-op (replacement collapses to the source) is
// not a replacement"). So #1163's requirement that identity and prescription come FROM THE STORED
// PROPOSAL, never reconstructed from free text, cannot be met until this lane exists.
//
// SESSION_PLAN_SETS_WRITE_ENABLED stays 0 throughout: the checkpoint POST is a dry-run sidecar and
// this test only proves it is attempted with the right payload. The durable server row is the
// separate final proof, gated on Phase 4.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const ledger = require('../src/app/sessionLedger.js');
const endorse = require('../src/app/endorsedSetRevision.js');

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
  // The lane's own module. Absent today — this is the red.
  try { proposalMod = await import('../src/app/setRevisionProposal.js'); } catch (_) { proposalMod = null; }
  storeMod = await import('../src/app/store.js');
});

const PLAN = {
  accepted: true,
  session_id: 'S1',
  session_date: '2026-07-29',
  plan_version: 'pv_x',
  exercises: [{ name: 'Back Squat', lift_code: 'SQ01', plan_item_id: 'pi-1', sets: 3 }],
};
const NAME = 'Back Squat';
const CODE = 'SQ01';
const REVISED = { weight: 185, reps: 5, rir: 2 };

function requireLane() {
  assert.ok(proposalMod, 'src/app/setRevisionProposal.js must exist — the prescription-only proposal lane');
  return proposalMod;
}

// Drive the REAL approve/reject handlers out of the built bundle, against the real ledger and the
// real endorsement decision. Only the DOM and the network are stubbed.
function handlers() {
  const start = appSrc.indexOf('function emitFutureSetRevision(');
  assert.notEqual(start, -1, 'emitFutureSetRevision must exist in the built bundle');
  const end = appSrc.indexOf('function implicitPlanItemId(');
  const slice = appSrc.slice(start, end === -1 ? undefined : end);

  const proposeAt = appSrc.indexOf('function proposeSetRevision(');
  const approveAt = appSrc.indexOf('function approvePendingSetRevision(');
  assert.notEqual(proposeAt, -1, 'app.js must expose proposeSetRevision — the proposal-creation seam');
  assert.notEqual(approveAt, -1, 'app.js must expose approvePendingSetRevision — the approval seam');
  const laneEnd = appSrc.indexOf('// F10C — is a just-logged exercise OFF the accepted plan', proposeAt);
  assert.notEqual(laneEnd, -1, 'the proposal lane must be delimited in the bundle');
  const laneSlice = appSrc.slice(Math.min(proposeAt, approveAt), laneEnd);

  const state = { plan: null, log: [], revisions: [], posts: [], snapshots: 0, outcomes: [], pending: null, rendered: [] };
  const factory = new Function(
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'isExplicitEndorsement',
    'buildSetRevisionProposal', 'decideApproval', 'state', `
    function getActivePlannedSession(){ return state.plan; }
    function getSessionLog(){ return state.log; }
    function getSessionRevisions(){ return state.revisions; }
    function setSessionRevisions(v){ state.revisions = Array.isArray(v) ? v : []; }
    function saveSessionSnapshot(){ state.snapshots++; }
    function persistSessionSnapshot(){ state.snapshots++; }
    function emitPlanItemOutcome(o){ state.outcomes.push(o); }
    function renderActiveSessionBanner(){}
    function getPendingSetRevision(){ return state.pending; }
    function setPendingSetRevision(v){ state.pending = v || null; }
    function api(url, opts){ state.posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({}); }
    const document = {
      getElementById(){ return { value: 'S1' }; },
      dispatchEvent(e){ state.rendered.push(e && e.detail ? e.detail.proposal : null); return true; },
    };
    function CustomEvent(type, init){ return { type, detail: (init && init.detail) || null }; }
    ${slice}
    ${laneSlice}
    return { proposeSetRevision, approvePendingSetRevision,
             rejectPendingSetRevision: typeof rejectPendingSetRevision === 'function' ? rejectPendingSetRevision : null,
             state };
  `);
  return factory(
    ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount,
    endorse.isExplicitEndorsement,
    requireLane().buildSetRevisionProposal, requireLane().decideApproval, state,
  );
}

function fresh() {
  const h = handlers();
  h.state.plan = JSON.parse(JSON.stringify(PLAN));
  h.state.log = [];
  return h;
}

const PROPOSAL_INPUT = {
  plan_item_id: 'pi-1',
  planned_lift_code: CODE,
  prescribed_name: NAME,
  prescription: REVISED,
  from: { weight: 225, reps: 5, rir: 2 },
  accepted_set_count: 3,
  plan_version: 'pv_x',
};

// ── creation ──────────────────────────────────────────────────────────────────

test('#1189 a prescription-only proposal is created without changing the movement', () => {
  const { buildSetRevisionProposal } = requireLane();
  const p = buildSetRevisionProposal({ ...PROPOSAL_INPUT, proposed_at: '2026-07-29T06:00:00.000Z' });

  assert.ok(p, 'a complete input yields a proposal');
  assert.equal(p.kind, 'set_revision');
  assert.match(p.proposal_id, /^setrev:pi-1@/, 'deterministic id, scoped to the plan item');
  assert.equal(p.plan_item_id, 'pi-1');
  assert.equal(p.planned_lift_code, CODE, 'the movement is UNCHANGED');
  assert.equal(p.prescription.weight, 185);
  assert.equal(p.prescription.reps, 5);
  assert.equal(p.prescription.rir, 2);
  assert.equal(p.accepted_set_count, 3);
  assert.equal(p.plan_version, 'pv_x', 'staleness anchor');
  assert.ok(p.proposed_at, 'staleness evidence');
});

test('#1189 the proposal id is deterministic and fingerprints the prescription', () => {
  const { buildSetRevisionProposal } = requireLane();
  const a = buildSetRevisionProposal({ ...PROPOSAL_INPUT, proposed_at: '2026-07-29T06:00:00.000Z' });
  const b = buildSetRevisionProposal({ ...PROPOSAL_INPUT, proposed_at: '2026-07-29T06:30:00.000Z' });
  const c = buildSetRevisionProposal({ ...PROPOSAL_INPUT, prescription: { ...REVISED, weight: 195 } });

  assert.equal(a.proposal_id, b.proposal_id, 'same proposal recomputes the same id');
  assert.notEqual(a.proposal_id, c.proposal_id, 'a changed prescription cannot masquerade as it');
});

test('#1189 an incomplete or movement-changing input yields no proposal', () => {
  const { buildSetRevisionProposal } = requireLane();
  assert.equal(buildSetRevisionProposal(null), null);
  assert.equal(buildSetRevisionProposal({ ...PROPOSAL_INPUT, plan_item_id: '' }), null, 'no identity');
  assert.equal(buildSetRevisionProposal({ ...PROPOSAL_INPUT, planned_lift_code: '' }), null, 'no lift code');
  assert.equal(buildSetRevisionProposal({ ...PROPOSAL_INPUT, prescription: {} }), null, 'no target — never invented');
});

// ── persistence + reload ──────────────────────────────────────────────────────

test('#1189 the active proposal survives a reload', async () => {
  const { buildSetRevisionProposal } = requireLane();
  const s = storeMod;
  assert.ok(typeof s.getPendingSetRevision === 'function', 'the store must expose getPendingSetRevision');
  assert.ok(typeof s.setPendingSetRevision === 'function', 'the store must expose setPendingSetRevision');

  const p = buildSetRevisionProposal({ ...PROPOSAL_INPUT });
  s.setSessionLog([{ exercise: NAME }]);
  s.setActivePlannedSession(JSON.parse(JSON.stringify(PLAN)));
  s.setPendingSetRevision(p);
  s.persistSessionSnapshot('S1');

  s.setPendingSetRevision(null);           // simulate the process going away
  const res = s.hydrateSessionSnapshot();
  assert.ok(res && res.resumed !== false, 'the snapshot resumes');

  const restored = s.getPendingSetRevision();
  assert.ok(restored, 'the proposal is restored after reload');
  assert.equal(restored.proposal_id, p.proposal_id, 'the SAME proposal, not a rebuilt one');
  assert.equal(restored.planned_lift_code, CODE);
  assert.equal(restored.prescription.weight, 185);
});

test('#1189 an older snapshot restores with no pending proposal and is never rejected', async () => {
  const s = storeMod;
  s.clearPersistedSnapshot();
  // A v5 snapshot — written before this lane existed. It must still resume.
  const legacy = {
    v: 5, ts: Date.now(),
    sessionLog: [{ exercise: NAME }],
    sessionCompleted: [],
    activePlannedSession: JSON.parse(JSON.stringify(PLAN)),
    sessionId: 'S1',
  };
  globalThis.localStorage.setItem('atlas_session_snapshot_v1', JSON.stringify(legacy));

  const res = s.hydrateSessionSnapshot();
  assert.ok(res && res.resumed !== false, 'a v5 snapshot still resumes after the v6 bump');
  assert.equal(s.getPendingSetRevision(), null, 'and simply has no pending proposal');
});

// ── approval ──────────────────────────────────────────────────────────────────

test('#1189 explicit acceptance captures the revision exactly once', () => {
  const h = fresh();
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  assert.ok(h.state.pending, 'the proposal is stored, not applied');
  assert.equal(h.state.revisions.length, 0, 'proposing changes nothing yet');
  assert.equal(h.state.rendered.length, 1, 'the proposal is surfaced for a decision');

  const ok = h.approvePendingSetRevision({ proposal_id: h.state.pending.proposal_id, endorsement: 'yeah do it' });

  assert.equal(ok, true);
  assert.equal(h.state.revisions.length, 3, 'one revision per future set');
  assert.equal(h.state.posts.length, 3);
  assert.equal(h.state.posts[0].url, '/api/session-plan-sets/revision');
  assert.equal(h.state.posts[0].body.revision.planned_lift_code, CODE, 'movement unchanged');
  assert.equal(h.state.posts[0].body.revision.target_weight, 185, 'future sets carry the new prescription');
  assert.equal(h.state.outcomes.length, 0, 'NO substituted item_outcome');
  assert.equal(h.state.pending, null, 'the proposal is consumed');
});

test('#1189 completed sets are preserved; only future sets are revised', () => {
  const h = fresh();
  h.state.log = [{ exercise: NAME }, { exercise: NAME }];   // two of three already done
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  h.approvePendingSetRevision({ proposal_id: h.state.pending.proposal_id, endorsement: 'yes' });

  assert.equal(h.state.revisions.length, 1, 'only the remaining set');
  assert.equal(h.state.revisions[0].set_index, 3, 'and it is the third, not a performed one');
});

test('#1189 a second approval is idempotent — no duplicate revision chain', () => {
  const h = fresh();
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  const id = h.state.pending.proposal_id;
  h.approvePendingSetRevision({ proposal_id: id, endorsement: 'yes' });
  const after = h.state.revisions.length;

  const second = h.approvePendingSetRevision({ proposal_id: id, endorsement: 'yes' });

  assert.equal(second, false, 'the double tap is refused, not re-applied');
  assert.equal(h.state.revisions.length, after, 'the chain is unchanged');
});

// ── rejection, Ask Why, generic acknowledgement ────────────────────────────────

test('#1189 rejection clears the proposal and captures nothing', () => {
  const h = fresh();
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  assert.ok(h.rejectPendingSetRevision, 'app.js must expose rejectPendingSetRevision');

  h.rejectPendingSetRevision({ proposal_id: h.state.pending.proposal_id });

  assert.equal(h.state.pending, null, 'cleared');
  assert.equal(h.state.revisions.length, 0);
  assert.equal(h.state.posts.length, 0);
});

test('#1189 Ask Why leaves the proposal ACTIVE and unapplied', () => {
  const h = fresh();
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  const id = h.state.pending.proposal_id;

  const applied = h.approvePendingSetRevision({ proposal_id: id, endorsement: 'why that weight?' });

  assert.equal(applied, false, 'a question is not consent');
  assert.ok(h.state.pending, 'the proposal stays active so Atlas can answer');
  assert.equal(h.state.pending.proposal_id, id, 'and it is the same proposal');
  assert.equal(h.state.revisions.length, 0);
});

test('#1189 a generic acknowledgement does not approve', () => {
  for (const words of ['ok', 'alright', 'sure', 'hmm', 'k']) {
    const h = fresh();
    h.proposeSetRevision({ ...PROPOSAL_INPUT });
    const applied = h.approvePendingSetRevision({ proposal_id: h.state.pending.proposal_id, endorsement: words });
    assert.equal(applied, false, `"${words}" must not approve`);
    assert.equal(h.state.revisions.length, 0, `"${words}" captures nothing`);
  }
});

test('#1189 an affirmative with NO active proposal does nothing', () => {
  const h = fresh();
  assert.equal(h.state.pending, null);
  const applied = h.approvePendingSetRevision({ proposal_id: 'setrev:pi-1@whatever', endorsement: 'yes do it' });
  assert.equal(applied, false, 'identity is never reconstructed from prose');
  assert.equal(h.state.revisions.length, 0);
});

// ── stale / superseded / malformed ────────────────────────────────────────────

test('#1189 a STALE proposal fails closed', () => {
  const h = fresh();
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  const id = h.state.pending.proposal_id;
  h.state.plan = { ...h.state.plan, plan_version: 'pv_MOVED' };   // the plan moved on

  const applied = h.approvePendingSetRevision({ proposal_id: id, endorsement: 'yes' });

  assert.equal(applied, false, 'a proposal anchored to an older plan_version is refused');
  assert.equal(h.state.revisions.length, 0);
  assert.equal(h.state.pending, null, 'and it is cleared rather than left to be re-approved');
});

test('#1189 approving a SUPERSEDED proposal is refused; only the newest applies', () => {
  const h = fresh();
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  const older = h.state.pending.proposal_id;
  h.proposeSetRevision({ ...PROPOSAL_INPUT, prescription: { weight: 195, reps: 5, rir: 2 } });
  const newer = h.state.pending.proposal_id;
  assert.notEqual(older, newer, 'the second proposal supersedes the first');

  assert.equal(h.approvePendingSetRevision({ proposal_id: older, endorsement: 'yes' }), false,
    'the superseded id cannot be approved');
  assert.equal(h.state.revisions.length, 0);

  assert.equal(h.approvePendingSetRevision({ proposal_id: newer, endorsement: 'yes' }), true);
  assert.equal(h.state.posts[0].body.revision.target_weight, 195, 'the NEWEST prescription applies');
});

test('#1189 a malformed approval request is refused', () => {
  const h = fresh();
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  assert.equal(h.approvePendingSetRevision(null), false);
  assert.equal(h.approvePendingSetRevision({ endorsement: 'yes' }), false, 'no proposal_id');
  assert.equal(h.state.revisions.length, 0);
  assert.ok(h.state.pending, 'a malformed request does not destroy the proposal');
});

test('#1189 a proposal for an unaccepted plan is never created', () => {
  const h = fresh();
  h.state.plan = { ...h.state.plan, accepted: false };
  h.proposeSetRevision({ ...PROPOSAL_INPUT });
  assert.equal(h.state.pending, null, 'no accepted plan means no ledger identity to revise');
});

// ── the replacement lane is untouched ─────────────────────────────────────────

test('#1189 a replacement proposal and a set-revision proposal cannot both be active', () => {
  const { buildSetRevisionProposal } = requireLane();
  const s = storeMod;
  s.setPendingReplacement({ kind: 'replacement', proposal_id: 'repl:a->b@1' });
  s.setPendingSetRevision(buildSetRevisionProposal({ ...PROPOSAL_INPUT }));

  const bothActive = !!s.getPendingReplacement() && !!s.getPendingSetRevision();
  assert.equal(bothActive, false, 'the two proposal lanes are mutually exclusive — no ambiguous state');
});
