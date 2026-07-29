'use strict';

// #1189 successor — the AFFORDANCE and the real conversational TRIGGER.
//
// #1191 merged the prescription-only proposal state machine (`setRevisionProposal.js`, the store
// field, the v6 snapshot, propose/approve/reject). Its own code comment names what it left:
// "the lane is reachable by the UI layer but not yet exercised by an ordinary session." No card
// rendered it and nothing in a real conversation opened a proposal.
//
// This test drives the NATURAL producer, not a contrived path. The chain already exists in
// production and is deterministic end to end — no model call anywhere in it:
//
//   athlete logs a set of an in-plan movement
//     → app.js fetchReaction(liftCode, justLoggedSet)          (src/app/app.js)
//     → GET /api/recommend/next/<code>?w&reps&rir              (index.js parseJustLoggedSet)
//     → services/justLoggedAnchor.recommendFromJustLoggedSet   (engine owns the numbers)
//     → { recommendation, next_target: {weight, reps}, target_rir, effort_verdict }
//
// Today that recommendation is narrated as PROSE ONLY ("Next: Room to progress — move to 230 × 5
// next set") while the accepted plan's remaining sets keep the old prescription. That is #1163's
// gap in its natural form, and it is the trigger this test pins.
//
// Identity is never reconstructed from Atlas's prose: the slot is resolved by plan_item_id
// through the accepted plan, and the prescription comes from the engine's structured
// `next_target` — never from the recommendation sentence.
//
// SESSION_PLAN_SETS_WRITE_ENABLED stays 0; the revision checkpoint POST is a dry-run sidecar and
// this test only proves it is attempted with the right payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const coachSrc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');

const ledger = require('../src/app/sessionLedger.js');
const endorse = require('../src/app/endorsedSetRevision.js');
const proposalModule = require('../src/app/setRevisionProposal.js');
const effective = require('../src/app/effectivePrescription.js');

const PLAN_VERSION = 'pv_x';
const SLOT_NAME = 'Back Squat';
const SLOT_CODE = 'SQ01';
const SLOT_ITEM = 'pi_bsq';

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

// Slice the REAL merged lane (propose/approve/reject/render) plus the REAL revision emitters and
// the new trigger out of the built bundle. Nothing here is reimplemented.
function harness(options) {
  const opts = options || {};
  const sliceEmit = appSrc.slice(
    appSrc.indexOf('function emitFutureSetRevision('),
    appSrc.indexOf('function implicitPlanItemId(')
  );
  const sliceLane = appSrc.slice(
    appSrc.indexOf('function proposeSetRevision('),
    appSrc.indexOf('function isOffPlanLoggedExercise(')
  );
  assert.ok(sliceLane.includes('function maybeProposeSetRevisionAfterLog('),
    'a real conversational trigger must exist — the merged lane has no in-conversation caller');

  const state = {
    plan: opts.plan === undefined ? plan() : opts.plan,
    log: opts.log || [],
    revisions: opts.revisions || [],
    pendingSetRevision: null,
    pendingReplacement: null,
    posts: [],
    reactionCalls: [],
    events: [],
    snapshots: 0,
    outcomes: [],
    // What the ENGINE returns for the just-logged set. `sets` is deliberately present and
    // deliberately ignored — the revision is bounded by the ACCEPTED set count, never the
    // engine's own.
    reaction: opts.reaction === undefined
      ? { recommendation: 'Room to progress — move to 230 × 5 next set.', next_target: { weight: 230, reps: 5, sets: 3 }, target_rir: 2 }
      : opts.reaction,
  };

  const fakeDoc = {
    dispatchEvent: (e) => { state.events.push(e); return true; },
    getElementById: () => null,
  };
  function FakeCustomEvent(type, init) { return { type, detail: init && init.detail }; }

  const factory = new Function(
    'document', 'CustomEvent', 'state',
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'isExplicitEndorsement',
    'buildSetRevisionProposal', 'decideApproval',
    'effectivePrescription', 'changesEffectivePrescription',
    `
    'use strict';
    function getActivePlannedSession(){ return state.plan; }
    function getSessionLog(){ return state.log; }
    function getSessionRevisions(){ return state.revisions; }
    function setSessionRevisions(v){ state.revisions = Array.isArray(v) ? v : []; }
    function getPendingSetRevision(){ return state.pendingSetRevision; }
    function setPendingSetRevision(v){
      state.pendingSetRevision = (v && typeof v === 'object') ? v : null;
      if (state.pendingSetRevision) state.pendingReplacement = null;
    }
    function persistSessionSnapshot(){ state.snapshots++; }
    function saveSessionSnapshot(){ state.snapshots++; }
    function emitPlanItemOutcome(o){ state.outcomes.push(o); }
    function renderActiveSessionBanner(){}
    function api(url, init){
      state.posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return Promise.resolve({});
    }
    function fetchReaction(code, justLogged){
      state.reactionCalls.push({ code, justLogged });
      return Promise.resolve(state.reaction);
    }
    ${sliceEmit}
    ${sliceLane}
    return {
      proposeSetRevision, approvePendingSetRevision, rejectPendingSetRevision,
      maybeProposeSetRevisionAfterLog,
    };
    `
  );

  const api = factory(
    fakeDoc, FakeCustomEvent, state,
    ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount,
    endorse.isExplicitEndorsement,
    proposalModule.buildSetRevisionProposal, proposalModule.decideApproval,
    effective.effectivePrescription, effective.changesEffectivePrescription,
  );
  return { api, state };
}

// The natural event: the athlete just logged a set of an in-plan movement.
function loggedSet(over) {
  return { exercise: SLOT_NAME, canonical: SLOT_NAME, liftCode: SLOT_CODE, weight: 225, reps: 5, rir: 5, ...(over || {}) };
}

async function afterLog(options) {
  const h = harness(options);
  const set = (options && options.set) || loggedSet();
  // The log is in the session buffer by the time the reaction is fetched (session-level save).
  h.state.log = h.state.log.concat([set]);
  const proposed = await h.api.maybeProposeSetRevisionAfterLog(set);
  return { ...h, proposed };
}

const approveRequest = (state) => ({ proposal_id: state.pendingSetRevision.proposal_id, endorsement: 'yes' });

// ── the natural trigger creates the proposal ──────────────────────────────────

test('#1189 a real logged set + the engine reaction creates a prescription-only proposal', async () => {
  const { state, proposed } = await afterLog();

  assert.ok(proposed, 'the natural post-log recommendation opens a proposal');
  assert.ok(state.pendingSetRevision, 'and it is staged as the active proposal');
  assert.equal(state.reactionCalls.length, 1, 'the engine is asked, anchored on the just-logged set');
  assert.equal(state.reactionCalls[0].code, SLOT_CODE);

  const p = state.pendingSetRevision;
  assert.equal(p.plan_item_id, SLOT_ITEM, 'the slot is identified by plan_item_id, never by prose');
  assert.equal(p.planned_lift_code, SLOT_CODE, 'the movement does not move');
  assert.equal(p.plan_version, PLAN_VERSION);
  assert.equal(p.accepted_set_count, 3, 'bounded by the ACCEPTED set count, not the engine\'s sets');
  assert.deepEqual(p.prescription, { weight: 230, reps: 5, rir: 2 },
    'the numbers come from the engine\'s structured next_target, never from its sentence');
  assert.equal(state.revisions.length, 0, 'a PROPOSAL alone revises nothing');
  assert.equal(state.posts.length, 0, 'and checkpoints nothing');
});

test('#1189 the proposal is surfaced to the coach thread', async () => {
  const { state } = await afterLog();
  const ev = state.events.find(e => e.type === 'atlas:set-revision-proposed');
  assert.ok(ev, 'the athlete is shown the proposal');
  assert.equal(ev.detail.proposal.proposal_id, state.pendingSetRevision.proposal_id);
});

test('#1189 no proposal without an accepted plan', async () => {
  const { state, proposed } = await afterLog({ plan: plan({ accepted: false }) });
  assert.equal(proposed, null);
  assert.equal(state.pendingSetRevision, null, 'an unaccepted plan carries no ledger identity');
});

test('#1189 no proposal for a lift that is not an accepted plan slot', async () => {
  const { state, proposed } = await afterLog({
    set: loggedSet({ exercise: 'Hammer Curl', canonical: 'Hammer Curl', liftCode: 'HCURL' }),
  });
  assert.equal(proposed, null, 'an off-plan lift has no slot to revise');
  assert.equal(state.pendingSetRevision, null);
});

test('#1189 no proposal when the engine resolves no usable target', async () => {
  for (const reaction of [null, {}, { next_target: null }, { next_target: { weight: null, reps: null } }]) {
    const { state, proposed } = await afterLog({ reaction });
    assert.equal(proposed, null, 'a target is NEVER invented');
    assert.equal(state.pendingSetRevision, null);
  }
});

// ── CRITICAL P2: the effective-prescription baseline ──────────────────────────

test('#1189 P2 case 1 — slot 225, revision to 185, engine proposes 185 again: nothing happens', async () => {
  // The accepted slot still reads 225 (a revision never rewrites it). Baselining on 225 would
  // make 185 look like a change: a card would be staged, the revision builder would dedupe it
  // away on approval, and Atlas would claim a revision that never happened.
  const revisions = [2, 3].map(set_index => ({
    plan_item_id: SLOT_ITEM, set_index, plan_version: 2,
    target_weight: 185, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision',
  }));
  const { state, proposed } = await afterLog({
    revisions,
    reaction: { next_target: { weight: 185, reps: 5 }, target_rir: 2 },
  });

  assert.equal(proposed, null, 'no new proposal');
  assert.equal(state.pendingSetRevision, null);
  assert.equal(state.revisions.length, 2, 'no new revision — the prior ones are untouched');
  assert.equal(state.posts.length, 0);
  assert.equal(state.events.filter(e => e.type === 'atlas:set-revision-proposed').length, 0,
    'and no success-shaped claim reaches the athlete');
});

test('#1189 P2 case 2 — slot 225, revision to 185, engine proposes 175: baseline is 185', async () => {
  const revisions = [2, 3].map(set_index => ({
    plan_item_id: SLOT_ITEM, set_index, plan_version: 2,
    target_weight: 185, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision',
  }));
  const { api, state, proposed } = await afterLog({
    revisions,
    reaction: { next_target: { weight: 175, reps: 5 }, target_rir: 2 },
  });

  assert.ok(proposed, 'a genuine change against the EFFECTIVE prescription is proposed');
  assert.deepEqual(state.pendingSetRevision.from, { weight: 185, reps: 5, rir: 2 },
    'the baseline is the latest accepted revision, not the accepted-plan slot');

  assert.equal(api.approvePendingSetRevision(approveRequest(state)), true);
  // One set is performed, so only sets 2 and 3 are still future.
  const fresh = state.revisions.filter(r => r.target_weight === 175);
  assert.equal(fresh.length, 2, 'only the still-future sets are revised');
  for (const r of fresh) assert.ok(r.set_index > 1, 'no performed set index is revised');
  assert.equal(state.revisions.filter(r => r.target_weight === 185).length, 2,
    'prior revisions remain as historical evidence and are not rewritten');
});

test('#1189 P2 case 3 — every affected set already completed: no proposal, no emit, no success claim', async () => {
  const { state, proposed } = await afterLog({
    log: [loggedSet(), loggedSet()],   // two already in the buffer; the just-logged one makes three
  });

  assert.equal(proposed, null, 'nothing is revisable');
  assert.equal(state.pendingSetRevision, null);
  assert.equal(state.revisions.length, 0);
  assert.equal(state.posts.length, 0);
  assert.equal(state.events.filter(e => e.type === 'atlas:set-revision-proposed').length, 0);
});

// ── approve / reject / ask why ────────────────────────────────────────────────

test('#1189 Approve applies the revision exactly once, to future sets only', async () => {
  const { api, state } = await afterLog();

  assert.equal(api.approvePendingSetRevision(approveRequest(state)), true);

  // One set was just logged, so sets 2 and 3 remain.
  assert.equal(state.revisions.length, 2, 'one revision per remaining future set');
  for (const r of state.revisions) {
    assert.ok(r.set_index > 1, 'completed sets are untouched');
    assert.equal(r.planned_lift_code, SLOT_CODE, 'the planned lift code is preserved UNCHANGED');
    assert.equal(r.target_weight, 230);
  }
  assert.equal(state.posts.length, 2, 'each revision reaches the dry-run checkpoint');
  assert.equal(state.posts[0].url, '/api/session-plan-sets/revision');
  assert.equal(state.outcomes.length, 0, 'NO substituted item_outcome is emitted');
  assert.equal(state.pendingSetRevision, null, 'the proposal is consumed');
});

test('#1189 double tap is idempotent', async () => {
  const { api, state } = await afterLog();
  const req = approveRequest(state);

  assert.equal(api.approvePendingSetRevision(req), true);
  const after = state.revisions.length;
  assert.equal(api.approvePendingSetRevision(req), false, 'the second tap finds nothing active');

  assert.equal(state.revisions.length, after, 'no duplicate revisions');
  assert.equal(state.posts.length, after, 'and no duplicate checkpoints');
});

test('#1189 Keep Original clears the proposal and revises nothing', async () => {
  const { api, state } = await afterLog();

  assert.equal(api.rejectPendingSetRevision({ proposal_id: state.pendingSetRevision.proposal_id }), true);

  assert.equal(state.pendingSetRevision, null);
  assert.equal(state.revisions.length, 0);
  assert.equal(state.posts.length, 0);
});

test('#1189 Ask Why preserves the ACTIVE proposal', async () => {
  const { api, state } = await afterLog();
  const before = state.pendingSetRevision.proposal_id;

  for (const words of ['why that weight?', 'what would that do?', 'hmm']) {
    assert.equal(
      api.approvePendingSetRevision({ proposal_id: before, endorsement: words }), false,
      `"${words}" is not consent`,
    );
    assert.ok(state.pendingSetRevision, `"${words}" must not discard the proposal`);
    assert.equal(state.pendingSetRevision.proposal_id, before, 'and it is the SAME proposal');
  }
  assert.equal(state.revisions.length, 0, 'nothing was applied while the athlete deliberates');
});

test('#1189 a generic acknowledgement does not approve', async () => {
  for (const words of ['ok', 'sure', 'alright', 'k', 'got it', 'thanks']) {
    const { api, state } = await afterLog();
    assert.equal(
      api.approvePendingSetRevision({ proposal_id: state.pendingSetRevision.proposal_id, endorsement: words }),
      false, `"${words}" must not rewrite the remaining sets`,
    );
    assert.equal(state.revisions.length, 0);
  }
});

test('#1189 affirmative text with NO active proposal does nothing', () => {
  const { api, state } = harness();
  assert.equal(api.approvePendingSetRevision({ proposal_id: 'setrev:anything', endorsement: 'yes' }), false);
  assert.equal(state.revisions.length, 0);
  assert.equal(state.posts.length, 0);
});

// ── stale + superseded ────────────────────────────────────────────────────────

test('#1189 a stale card cannot approve (the plan version moved)', async () => {
  const { api, state } = await afterLog();
  const req = approveRequest(state);
  state.plan = plan({ plan_version: 'pv_y' });

  assert.equal(api.approvePendingSetRevision(req), false, 'a stale proposal is never applied');
  assert.equal(state.revisions.length, 0);
  assert.equal(state.pendingSetRevision, null, 'and it is cleared');
});

test('#1189 a superseded card cannot approve', async () => {
  const { api, state } = await afterLog();
  const olderReq = approveRequest(state);

  // A later logged set produces a newer recommendation, superseding the first proposal.
  state.reaction = { next_target: { weight: 240, reps: 5 }, target_rir: 2 };
  const second = loggedSet({ weight: 230 });
  state.log = state.log.concat([second]);
  await api.maybeProposeSetRevisionAfterLog(second);
  assert.notEqual(state.pendingSetRevision.proposal_id, olderReq.proposal_id, 'a newer proposal superseded it');

  assert.equal(api.approvePendingSetRevision(olderReq), false, 'the older card is inert');
  assert.equal(state.revisions.length, 0);

  assert.equal(api.approvePendingSetRevision(approveRequest(state)), true, 'the newest still approves');
  assert.equal(state.revisions[0].target_weight, 240);
});

// ── the card, and the wiring that makes it real ───────────────────────────────

test('#1189 the coach thread renders the proposal card with all three affordances', () => {
  assert.match(coachSrc, /atlas:set-revision-proposed/,
    'the coach conversation must listen for the proposal event');
  const at = coachSrc.indexOf('atlas:set-revision-proposed');
  const region = coachSrc.slice(Math.max(0, at - 3000), at + 500);
  assert.match(region, /Approve/, 'an Approve affordance');
  assert.match(region, /Keep Original/, 'a Keep Original affordance');
  assert.match(region, /Ask Why/, 'an Ask Why affordance');
  assert.match(region, /atlas:set-revision-decision/,
    'the card dispatches a decision the shell applies — the card never applies it itself');
});

test('#1189 the card carries the STRUCTURED proposal identity, not prose', () => {
  const at = coachSrc.indexOf('atlas:set-revision-proposed');
  const region = coachSrc.slice(Math.max(0, at - 3000), at + 500);
  assert.match(region, /proposal_id/,
    'the decision names the proposal by id, so a stale card cannot act');
});

test('#1189 the shell applies a card decision through the merged lane only', () => {
  assert.match(appSrc, /atlas:set-revision-decision/, 'the shell listens for the card decision');
  const at = appSrc.indexOf("addEventListener('atlas:set-revision-decision'");
  assert.notEqual(at, -1, 'a decision listener must exist');
  const region = appSrc.slice(at, at + 900);
  assert.match(region, /approvePendingSetRevision\(/, 'approve routes to the merged lane');
  assert.match(region, /rejectPendingSetRevision\(/, 'reject routes to the merged lane');
});

test('#1189 a reload restores the active proposal card', () => {
  const at = appSrc.indexOf('function restoreSessionSnapshot(');
  assert.notEqual(at, -1);
  const region = appSrc.slice(at, appSrc.indexOf('function hasUnsavedSessionState('));
  assert.match(region, /getPendingSetRevision\(\)/, 'the restore reads the persisted proposal');
  assert.match(region, /renderSetRevisionProposal|isProposalCurrent/,
    'and re-surfaces it (or discards it when the plan moved under it)');
});

// ── the existing replacement lane is untouched ────────────────────────────────

test('#1189 the replacement proposal card still works unchanged', () => {
  assert.match(coachSrc, /atlas:replacement-proposed/, 'the replacement card still renders');
  assert.match(appSrc, /atlas:replacement-decision/, 'and the shell still applies its decision');
});

test('#1189 competing replacement and set-revision proposals cannot coexist', async () => {
  const { state } = await afterLog();
  assert.ok(state.pendingSetRevision, 'a set-revision proposal is active');
  assert.equal(state.pendingReplacement, null,
    'staging one retires the other — the store enforces one decision at a time');
});

test('#1189 an ORDINARY logged set reaches the trigger in production', () => {
  // The difference between "the trigger exists" and "a real session exercises it". The call must
  // live in the logged-set path itself, beside the F10C off-plan counterpart — not behind a
  // window.* global, which is exactly what left the merged lane unexercised.
  const emit = appSrc.slice(
    appSrc.indexOf('function emitSetLogged('),
    appSrc.indexOf('async function fetchReaction(')
  );
  assert.match(emit, /proposeSetRevisionsForLoggedSlots\(byExercise, enrichMap\)/,
    'logging a set must be what opens the proposal');
  // …and that fan-out is gated to ON-plan slots, mirroring the off-plan implicit-rec lane.
  const fanOut = appSrc.slice(
    appSrc.indexOf('function proposeSetRevisionsForLoggedSlots('),
    appSrc.indexOf('async function maybeProposeSetRevisionAfterLog(')
  );
  assert.match(fanOut, /isOffPlanLoggedExercise\(plan, canonical, code\)/,
    'off-plan lifts stay with the implicit-recommendation lane');
  assert.match(fanOut, /maybeProposeSetRevisionAfterLog\(/, 'and on-plan slots reach the trigger');
});

test('#1189 the lane is no longer reachable ONLY through a window global', () => {
  // #1188 left one temporary global; #1191 left three. A global is not a conversation.
  const calls = appSrc.split('\n').filter(l =>
    /maybeProposeSetRevisionAfterLog\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/^async function/.test(l));
  assert.ok(calls.length >= 1, 'the trigger has at least one real in-app caller');
  assert.ok(calls.some(l => !/window\./.test(l)),
    'and at least one of them is not a window.* entry point');
});

// ── no shortcut around the real seam ──────────────────────────────────────────

test('#1189 this test never calls emitEndorsedSetRevision directly', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  const calls = self.split('\n').filter(l =>
    /emitEndorsedSetRevision\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.equal(calls.length, 0,
    'every revision in this file must come from the real propose → approve seam');
});
