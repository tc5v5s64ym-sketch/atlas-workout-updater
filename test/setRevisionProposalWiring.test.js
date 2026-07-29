'use strict';

// #1189 — the PRESCRIPTION-ONLY proposal lane (propose → approve → revise).
//
// #1188 shipped the capture ENTRY POINT (`emitEndorsedSetRevision`). Nothing in the real
// conversation reached it: the only mature proposal→approve lane in the app is movement-scoped
// end to end (`buildReplacementProposal` → `atlas:replacement-proposed` → `approvePendingReplacement`
// → `applySessionSubstitution` + a `substituted` outcome), and it rejects a prescription-only
// change outright — "a no-op (replacement collapses to the source) is not a replacement".
//
// This test drives the REAL seam, never `emitEndorsedSetRevision` directly: an athlete message
// goes into the production `tryProposeReplacement` router, the production builder stages the
// proposal, and the production `approvePendingSetRevision` / `rejectPendingSetRevision` /
// `tryResolvePendingSetRevision` handlers resolve it. The harness slices that whole span out of
// the built bundle exactly as test/substitutionBindingWiring.test.js slices the substitution
// binding path.
//
// Scope: capture only. SESSION_PLAN_SETS_WRITE_ENABLED stays 0 — the checkpoint POST is a
// dry-run sidecar and this test only proves it is ATTEMPTED with the right payload. The final
// server-side durability proof for #1163 still waits on the Phase 4 owner gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

const ledger = require('../src/app/sessionLedger.js');
const endorse = require('../src/app/endorsedSetRevision.js');
const activeReplacement = require('../src/app/activeReplacement.js');
const planMutationIntent = require('../src/app/planMutationIntent.js');
const setRevision = require('../src/app/pendingSetRevision.js');

const PLAN_VERSION = 'pv_x';
const SLOT_NAME = 'Back Squat';
const SLOT_CODE = 'SQ01';
const SLOT_ITEM = 'pi_bsq';

// The engine's authoritative next target for SQ01 — the ONLY source of the revised numbers.
const ENGINE_TARGET = { weight: 185, reps: 5, sets: 3, rir: null };
const ENGINE_RIR = 2;

function plan(overrides) {
  return {
    accepted: true,
    session_id: 'S1',
    session_date: '2026-07-29',
    plan_version: PLAN_VERSION,
    index: 0,
    exercises: [
      {
        name: SLOT_NAME, canonicalName: SLOT_NAME, liftCode: SLOT_CODE, plan_item_id: SLOT_ITEM,
        weight: 225, reps: 5, sets: 3, rir: 2,
      },
      {
        name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01', plan_item_id: 'pi_ohp',
        weight: 115, reps: 6, sets: 3, rir: 2,
      },
    ],
    ...(overrides || {}),
  };
}

// Slice the WHOLE proposal router + both approval lanes (replacement and set-revision) out of
// the built bundle, plus the revision emitters they drive. Nothing is reimplemented here.
function harness(options) {
  const opts = options || {};
  // The real catalog resolver — the fake datalist below drives it, so the "replacement
  // collapses to the source" case is reached exactly as production reaches it.
  const sliceCatalog = appSrc.slice(
    appSrc.indexOf('function resolveCatalogExercise('),
    appSrc.indexOf('function skipPlannedExercise(')
  );
  const sliceLanes = appSrc.slice(
    appSrc.indexOf('async function tryProposeReplacement('),
    appSrc.indexOf('async function tryApplyImplicitSubstitution(')
  );
  const sliceEmit = appSrc.slice(
    appSrc.indexOf('function emitFutureSetRevision('),
    appSrc.indexOf('function implicitPlanItemId(')
  );
  assert.ok(sliceLanes.includes('async function tryProposeSetRevision('),
    'a prescription-only proposal lane must exist beside the replacement lane');
  assert.ok(sliceLanes.includes('function approvePendingSetRevision('),
    'the lane must expose a production approve handler');
  assert.ok(sliceEmit.includes('function emitEndorsedSetRevision('),
    'the #1188 capture entry point must still be present');

  const state = {
    plan: opts.plan === undefined ? plan() : opts.plan,
    log: opts.log || [],
    revisions: [],
    pendingReplacement: null,
    pendingSetRevision: null,
    posts: [],
    recommendCalls: [],
    events: [],
    announcements: [],
    outcomes: [],
    snapshots: 0,
    substitutions: [],
    engineTarget: opts.engineTarget === undefined ? ENGINE_TARGET : opts.engineTarget,
    engineRir: opts.engineRir === undefined ? ENGINE_RIR : opts.engineRir,
  };

  // A datalist that resolves "squats" to the planned "Back Squat" (unique substring match) —
  // the real resolveCatalogExercise discipline, so the collapse case is reached honestly.
  const catalog = {
    options: [
      { value: SLOT_NAME, label: SLOT_CODE },
      { value: 'Overhead Press', label: 'OHP01' },
      { value: 'Bench Press', label: 'BP01' },
    ],
  };
  const fakeDoc = {
    dispatchEvent: (e) => { state.events.push(e); return true; },
    getElementById: (id) => (id === 'exercise-catalog' ? catalog : null),
  };
  function FakeCustomEvent(type, init) { return { type, detail: init && init.detail }; }

  const factory = new Function(
    'document', 'CustomEvent', 'window', 'state',
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'isExplicitEndorsement',
    'buildSetRevisionProposal', 'isSetRevisionProposalFresh',
    'formatSetRevisionProposalLine', 'formatSetRevisionPrescription', 'classifySetRevisionFollowup',
    `
    'use strict';
    let lastIntentData = null;
    function getActivePlannedSession(){ return state.plan; }
    function getSessionLog(){ return state.log; }
    function getSessionRevisions(){ return state.revisions; }
    function setSessionRevisions(v){ state.revisions = Array.isArray(v) ? v : []; }
    function getPendingReplacement(){ return state.pendingReplacement; }
    function setPendingReplacement(v){ state.pendingReplacement = (v && typeof v === 'object') ? v : null; }
    function getPendingSetRevision(){ return state.pendingSetRevision; }
    function setPendingSetRevision(v){ state.pendingSetRevision = (v && typeof v === 'object') ? v : null; }
    function getCoachSuggestionEngaged(){ return true; }
    function setActivePlannedSession(v){ state.plan = v || null; }
    function getCanonicalSession(){ return null; }
    function ensureActivePlannedSession(){ return !!(state.plan && state.plan.exercises && state.plan.exercises.length); }
    function firstUnloggedPlannedLift(){
      const p = state.plan;
      return p && p.exercises && p.exercises[0] ? (p.exercises[0].canonicalName || p.exercises[0].name) : null;
    }
    function normalizePlanExercise(e){ return e; }
    function renderActiveSessionBanner(){}
    function saveSessionSnapshot(){ state.snapshots++; }
    function persistSessionSnapshot(){ state.snapshots++; }
    function emitPlanItemOutcome(o){ state.outcomes.push(o); }
    function applySessionSubstitution(from, to, code, rx){ state.substitutions.push({ from, to, code, rx }); return true; }
    function announcePlanMutation(summary, current){ state.announcements.push({ summary: summary || '', current: current || null }); }
    function api(url, init){
      if (String(url).indexOf('/api/recommend/next/') === 0) {
        state.recommendCalls.push(url);
        if (!state.engineTarget) return Promise.resolve({ status: 'ok', data: {} });
        return Promise.resolve({ status: 'ok', data: { next_target: state.engineTarget, target_rir: state.engineRir } });
      }
      state.posts.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({});
    }
    ${sliceCatalog}
    ${sliceEmit}
    ${sliceLanes}
    return {
      tryProposeReplacement, tryProposeSetRevision,
      approvePendingSetRevision, rejectPendingSetRevision, tryResolvePendingSetRevision,
      approvePendingReplacement, tryResolvePendingReplacement,
      emitEndorsedSetRevision,
    };
    `
  );

  const fakeWindow = { activeReplacement, planMutationIntent };
  const api = factory(
    fakeDoc, FakeCustomEvent, fakeWindow, state,
    ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount, endorse.isExplicitEndorsement,
    setRevision.buildSetRevisionProposal, setRevision.isSetRevisionProposalFresh,
    setRevision.formatSetRevisionProposalLine, setRevision.formatSetRevisionPrescription,
    setRevision.classifySetRevisionFollowup,
  );
  return { api, state };
}

// "change back squat to squats" — the athlete names a movement that STAYS in the plan. The
// replacement router resolves the "replacement" back to the source, so it is a prescription
// change, not a swap.
const SAME_MOVEMENT_MESSAGE = 'change back squat to squats';

async function proposed(options) {
  const h = harness(options);
  const handled = await h.api.tryProposeReplacement(SAME_MOVEMENT_MESSAGE);
  return { ...h, handled };
}

// ── creation ──────────────────────────────────────────────────────────────────

test('#1189 a same-movement change request creates a prescription-only proposal', async () => {
  const { state, handled } = await proposed();

  assert.equal(handled, true, 'the router owns the turn instead of dropping it');
  assert.ok(state.pendingSetRevision, 'a set-revision proposal is staged');
  assert.equal(state.pendingReplacement, null, 'and NO replacement proposal is staged');

  const p = state.pendingSetRevision;
  assert.equal(p.kind, 'set_revision');
  assert.equal(p.plan_item_id, SLOT_ITEM, 'the slot is identified by plan_item_id, never by name');
  assert.equal(p.planned_lift_code, SLOT_CODE, 'the movement does not move');
  assert.equal(p.plan_version, PLAN_VERSION, 'the staleness anchor is carried');
  assert.equal(p.accepted_set_count, 3, 'bounded by the accepted (v1) set count');
  assert.deepEqual(p.prescription, { weight: 185, reps: 5, rir: 2 });
  assert.deepEqual(p.from, { weight: 225, reps: 5, rir: 2 }, 'and what it replaces, for the proposal line');
  assert.ok(/^setrev:/.test(p.proposal_id), 'a set-revision proposal id, distinct from repl:');

  assert.equal(state.recommendCalls.length, 1, 'the prescription is resolved from the read-only engine');
  assert.equal(state.recommendCalls[0], `/api/recommend/next/${SLOT_CODE}`);
  assert.equal(state.revisions.length, 0, 'a PROPOSAL alone revises nothing');
  assert.equal(state.posts.length, 0, 'and checkpoints nothing');
});

test('#1189 the proposal is rendered for an explicit decision', async () => {
  const { state } = await proposed();
  const ev = state.events.find(e => e.type === 'atlas:set-revision-proposed');
  assert.ok(ev, 'the athlete is shown the proposal');
  assert.equal(ev.detail.proposal.proposal_id, state.pendingSetRevision.proposal_id);
  assert.ok(ev.detail.line && ev.detail.line.includes('185'), 'the line states the proposed target');
});

test('#1189 the proposal id is deterministic — the same proposal recomputes the same id', async () => {
  const a = await proposed();
  const b = await proposed();
  assert.equal(a.state.pendingSetRevision.proposal_id, b.state.pendingSetRevision.proposal_id);
});

test('#1189 no proposal is created when the engine returns no usable target', async () => {
  const { state, handled } = await proposed({ engineTarget: null });
  assert.equal(handled, false, 'nothing to propose — the turn falls through');
  assert.equal(state.pendingSetRevision, null, 'a target is NEVER invented');
  assert.equal(state.revisions.length, 0);
});

test('#1189 no proposal is created without an accepted plan', async () => {
  const { state, handled } = await proposed({ plan: plan({ accepted: false }) });
  assert.equal(handled, false);
  assert.equal(state.pendingSetRevision, null, 'an unaccepted plan carries no ledger identity');
});

test('#1189 no proposal is created when the engine target equals the current prescription', async () => {
  // Proposing "change Back Squat to exactly what it already is" is not a revision.
  const { state, handled } = await proposed({ engineTarget: { weight: 225, reps: 5, sets: 3, rir: null } });
  assert.equal(handled, false);
  assert.equal(state.pendingSetRevision, null);
});

// ── persistence + reload ──────────────────────────────────────────────────────

test('#1189 the proposal is persisted so a reload re-surfaces the SAME proposal', async () => {
  const { state } = await proposed();
  assert.ok(state.snapshots > 0, 'staging the proposal writes a snapshot');

  // Round-trip it exactly as the snapshot does, then re-validate against the unmutated plan.
  const restored = JSON.parse(JSON.stringify(state.pendingSetRevision));
  assert.equal(
    setRevision.isSetRevisionProposalFresh(restored, state.plan.exercises, state.plan.plan_version),
    true,
    'the restored proposal is still fresh against the same, never-mutated plan',
  );
});

// ── approve ───────────────────────────────────────────────────────────────────

test('#1189 explicit approval revises the future sets exactly once', async () => {
  const { api, state } = await proposed();

  const handled = api.approvePendingSetRevision();

  assert.equal(handled, true);
  assert.equal(state.revisions.length, 3, 'one revision per future set');
  assert.equal(state.posts.length, 3, 'each revision reaches the dry-run checkpoint route');
  assert.equal(state.posts[0].url, '/api/session-plan-sets/revision');
  for (const r of state.revisions) {
    assert.equal(r.planned_lift_code, SLOT_CODE, 'the movement is UNCHANGED');
    assert.equal(r.target_weight, 185);
    assert.equal(r.target_reps, 5);
    assert.equal(r.target_rir, 2);
  }
  assert.equal(state.pendingSetRevision, null, 'the proposal is resolved');
});

test('#1189 approval never records a substituted outcome', async () => {
  const { api, state } = await proposed();
  api.approvePendingSetRevision();
  assert.equal(state.outcomes.length, 0,
    'a load change is not a substitution — a substituted outcome would corrupt the movement-level record');
  assert.equal(state.substitutions.length, 0, 'and the substitution executor is never driven');
});

test('#1189 a verbal endorsement approves through the real follow-up router', async () => {
  for (const words of ['yes', 'yeah do it', 'do it', 'go ahead', 'sounds good', 'ok yeah do it']) {
    const { api, state } = await proposed();
    const handled = api.tryResolvePendingSetRevision(words);
    assert.equal(handled, true, `"${words}" resolves the proposal`);
    assert.equal(state.revisions.length, 3, `"${words}" applies the revision`);
    assert.equal(state.outcomes.length, 0);
  }
});

test('#1189 completed sets are preserved — only FUTURE sets are revised', async () => {
  const { api, state } = await proposed({ log: [{ exercise: SLOT_NAME }, { exercise: SLOT_NAME }] });
  api.approvePendingSetRevision();

  assert.equal(state.revisions.length, 1, 'only the one remaining set is revised');
  assert.equal(state.revisions[0].set_index, 3, 'and it is the THIRD set, not a performed one');
});

test('#1189 approving twice does not duplicate the revision chain', async () => {
  const { api, state } = await proposed();

  assert.equal(api.approvePendingSetRevision(), true);
  const afterFirst = state.revisions.length;
  assert.equal(api.approvePendingSetRevision(), false, 'the second approve finds no pending proposal');

  assert.equal(afterFirst, 3);
  assert.equal(state.revisions.length, 3, 'no duplicate revisions');
  assert.equal(state.posts.length, 3, 'and no duplicate checkpoints');
});

// ── reject ────────────────────────────────────────────────────────────────────

test('#1189 a decline clears the proposal and revises nothing', async () => {
  for (const words of ['no', 'nah', 'not yet', 'skip it', 'leave it']) {
    const { api, state } = await proposed();
    const handled = api.tryResolvePendingSetRevision(words);
    assert.equal(handled, true, `"${words}" is a decision`);
    assert.equal(state.pendingSetRevision, null, `"${words}" clears the proposal`);
    assert.equal(state.revisions.length, 0, `"${words}" revises nothing`);
    assert.equal(state.posts.length, 0);
  }
});

test('#1189 after a decline a later bare "yes" finds nothing and does nothing', async () => {
  const { api, state } = await proposed();
  api.tryResolvePendingSetRevision('no');
  const handled = api.tryResolvePendingSetRevision('yes');
  assert.equal(handled, false, 'there is no stored proposal to read');
  assert.equal(state.revisions.length, 0, 'identity is never reconstructed from prose');
});

// ── Ask Why ───────────────────────────────────────────────────────────────────

test('#1189 a question keeps the proposal ACTIVE and unapplied', async () => {
  for (const words of ['why that weight?', 'what would that do?', 'why?']) {
    const { api, state } = await proposed();
    const before = state.pendingSetRevision.proposal_id;

    const handled = api.tryResolvePendingSetRevision(words);

    assert.equal(handled, true, `"${words}" is answered from the proposal`);
    assert.ok(state.pendingSetRevision, `"${words}" must not discard the proposal`);
    assert.equal(state.pendingSetRevision.proposal_id, before, 'and it is the SAME proposal');
    assert.equal(state.revisions.length, 0, `"${words}" applies nothing`);
    const said = state.announcements[state.announcements.length - 1];
    assert.ok(said && said.summary.includes('185'), 'the answer states the proposed target, never invents one');
  }
});

test('#1189 a generic acknowledgement is not approval', async () => {
  for (const words of ['ok', 'alright', 'sure', 'k', 'hmm', 'maybe', 'i guess']) {
    const { api, state } = await proposed();
    const handled = api.tryResolvePendingSetRevision(words);
    assert.equal(handled, false, `"${words}" is not a decision`);
    assert.ok(state.pendingSetRevision, `"${words}" leaves the proposal pending`);
    assert.equal(state.revisions.length, 0, `"${words}" must revise nothing`);
  }
});

test('#1189 an affirmative with NO active proposal does nothing at all', () => {
  const { api, state } = harness();
  assert.equal(api.tryResolvePendingSetRevision('yes'), false);
  assert.equal(state.revisions.length, 0);
  assert.equal(state.posts.length, 0);
});

// ── stale + superseded ────────────────────────────────────────────────────────

test('#1189 a stale proposal (the plan version moved) refuses and revises nothing', async () => {
  const { api, state } = await proposed();
  state.plan = plan({ plan_version: 'pv_y' });          // the plan was re-accepted under it

  const handled = api.approvePendingSetRevision();

  assert.equal(handled, true, 'the turn is owned — the athlete is told, not ignored');
  assert.equal(state.revisions.length, 0, 'a stale proposal is never applied');
  assert.equal(state.posts.length, 0);
  assert.equal(state.pendingSetRevision, null, 'and it is cleared');
});

test('#1189 a stale proposal (the slot is gone) refuses and revises nothing', async () => {
  const { api, state } = await proposed();
  state.plan = plan({ exercises: plan().exercises.slice(1) });   // Back Squat removed

  api.approvePendingSetRevision();

  assert.equal(state.revisions.length, 0);
  assert.equal(state.pendingSetRevision, null);
});

test('#1189 only the NEWEST proposal is approvable — an older card refuses', async () => {
  const { api, state } = await proposed();
  const older = state.pendingSetRevision;

  // A second proposal for the same slot supersedes it (a different engine target).
  state.engineTarget = { weight: 195, reps: 5, sets: 3, rir: null };
  await api.tryProposeSetRevision(SLOT_NAME);
  const newer = state.pendingSetRevision;
  assert.notEqual(newer.proposal_id, older.proposal_id, 'the newer proposal superseded the older');

  // A tap on the stale, still-visible older card must not apply the newer revision.
  assert.equal(api.approvePendingSetRevision(older), false, 'approving an older proposal_id refuses');
  assert.equal(state.revisions.length, 0);

  // The newest one still approves normally.
  assert.equal(api.approvePendingSetRevision(newer), true);
  assert.equal(state.revisions[0].target_weight, 195);
});

// ── the existing replacement lane is untouched ────────────────────────────────

test('#1189 a genuine movement replacement still goes down the replacement lane', async () => {
  const { api, state } = harness();

  const handled = await api.tryProposeReplacement('replace back squat with bench press');

  assert.equal(handled, true);
  assert.ok(state.pendingReplacement, 'a real swap still stages a REPLACEMENT proposal');
  assert.equal(state.pendingSetRevision, null, 'and never a set-revision proposal');
  assert.ok(state.events.some(e => e.type === 'atlas:replacement-proposed'));

  assert.equal(api.approvePendingReplacement(), true);
  assert.equal(state.substitutions.length, 1, 'and it still drives the substitution executor');
  assert.equal(state.substitutions[0].to, 'Bench Press');
});

test('#1189 a set-revision proposal is never applied to a movement that was since swapped', () => {
  // The two lanes can both have staged a proposal (a set revision, then a genuine replacement).
  // applySessionSubstitution KEEPS the original plan_item_id on the slot and changes its lift
  // code, so identity alone would still resolve — and a revision would land on a movement the
  // athlete never endorsed it for. The staleness test pins the lift code for exactly this.
  const { api, state } = harness();
  state.pendingSetRevision = {
    kind: 'set_revision', proposal_id: 'setrev:PIBSQ@x',
    plan_item_id: SLOT_ITEM, planned_lift_code: SLOT_CODE, prescribed_name: SLOT_NAME,
    prescription: { weight: 185, reps: 5, rir: 2 }, accepted_set_count: 3,
    from: { weight: 225, reps: 5, rir: 2 }, plan_version: PLAN_VERSION, status: 'pending',
  };
  // The slot keeps its identity but becomes a different movement.
  state.plan.exercises[0].liftCode = 'FSQ01';

  const handled = api.approvePendingSetRevision();

  assert.equal(handled, true, 'the athlete is told, not silently ignored');
  assert.equal(state.revisions.length, 0, 'the revision is REFUSED — the movement moved under it');
  assert.equal(state.posts.length, 0);
  assert.equal(state.pendingSetRevision, null, 'and the stale proposal is cleared');
});

// ── the temporary #1188 global is gone ────────────────────────────────────────

test('#1189 the temporary window.atlasEndorseSetRevision global is deleted', () => {
  // #1188 shipped it as the narrowest public surface that let that slice ship, and documented
  // it as TEMPORARY: "once the prescription-proposal lane lands and approvePendingSetRevision
  // calls the internal function directly, this global has no remaining caller". It does now.
  assert.doesNotMatch(appSrc, /window\.atlasEndorseSetRevision\s*=/,
    'the global must be removed once the proposal lane calls the internal function directly');
  const lane = appSrc.slice(
    appSrc.indexOf('function approvePendingSetRevision('),
    appSrc.indexOf('function rejectPendingSetRevision(')
  );
  assert.match(lane, /emitEndorsedSetRevision\(/,
    'the approve handler calls the capture entry point directly');
});
