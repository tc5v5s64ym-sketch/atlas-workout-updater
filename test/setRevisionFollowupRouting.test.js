'use strict';

// Phase 4 criterion 4 step (b) — natural conversation and the proposal card share ONE trusted
// set-revision state machine.
//
// VERIFIED GAP (gate, on main @ 2848945): the #1189/#1194 lane is reachable ONLY through the card.
// `getPendingSetRevision` appears in the composer submit handler nowhere; the conversational lane
// (`src/app/app.js` runCloseout catch block) resolves a pending REPLACEMENT follow-up
// (`tryResolvePendingReplacement`) and nothing else, so a typed "do that" against a live
// set-revision proposal fell through to `/api/coach/chat` and the proposal was never decided.
// `docs/verification/PHASE_4_READINESS_2026-07-29.md` §5 records that widening this read side was
// held owner-reserved; the owner has now approved exactly five phrase classes.
//
// WHAT THIS TEST IS. It drives the REAL lane out of the BUILT bundle (`public/app.js`) against the
// real classifier, the real proposal state machine, the real endorsement decision, the real ledger
// and the real store persistence. Nothing is reimplemented and NO test calls
// `emitEndorsedSetRevision` directly — every capture here goes through an approval, which is the
// whole point of the criterion.
//
// SESSION_PLAN_SETS_WRITE_ENABLED stays 0: the revision checkpoint POST is a dry-run sidecar and
// this test only proves it is attempted with the payload the stored proposal already holds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const coachSrc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(repoRoot, 'public', 'legacyBridge.js'), 'utf8');
const selfSrc = fs.readFileSync(__filename, 'utf8');

const ledger = require('../src/app/sessionLedger.js');
const endorse = require('../src/app/endorsedSetRevision.js');
const proposalModule = require('../src/app/setRevisionProposal.js');

let followup = null;
test.before(async () => {
  try { followup = await import('../src/app/setRevisionFollowup.js'); } catch (_) { followup = null; }
});
function classifier() {
  assert.ok(followup, 'src/app/setRevisionFollowup.js must exist — the pure phrase classifier');
  return followup;
}

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
        name: SLOT_NAME, canonicalName: SLOT_NAME, liftCode: SLOT_CODE, lift_code: SLOT_CODE,
        plan_item_id: SLOT_ITEM, weight: 225, reps: 5, sets: 3, rir: 2,
      },
    ],
    ...(overrides || {}),
  };
}

const PROPOSAL_INPUT = {
  plan_item_id: SLOT_ITEM,
  planned_lift_code: SLOT_CODE,
  prescribed_name: SLOT_NAME,
  prescription: { weight: 185, reps: 5, rir: 2 },
  from: { weight: 225, reps: 5, rir: 2 },
  accepted_set_count: 3,
  plan_version: PLAN_VERSION,
};

// ── the real lane, sliced from the built bundle ───────────────────────────────
// Three slices, all real production code:
//   sliceEmit  — emitFutureSetRevision (the append-only revision emitter)
//   sliceLane  — proposeSetRevision / approvePendingSetRevision / rejectPendingSetRevision
//   sliceFollow— explainPendingSetRevision + the natural-language follow-up lane
// Only the DOM, the network and the snapshot writer are stubbed.
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
  const followStart = appSrc.indexOf('function explainPendingSetRevision(');
  const followEnd = appSrc.indexOf('function openTodaySessionPlan(');
  assert.notEqual(followStart, -1, 'explainPendingSetRevision must exist in the bundle');
  assert.notEqual(followEnd, -1, 'the follow-up region must be delimited in the bundle');
  const sliceFollow = appSrc.slice(followStart, followEnd);
  assert.ok(sliceFollow.includes('function trySetRevisionFollowup('),
    'a natural-language follow-up lane must exist — the card is not the only way to decide a proposal');

  const state = {
    plan: opts.plan === undefined ? plan() : opts.plan,
    log: opts.log || [],
    revisions: [],
    pendingSetRevision: null,
    pendingReplacement: opts.pendingReplacement || null,
    posts: [],
    events: [],
    snapshots: 0,
    outcomes: [],
    coachCalls: [],
  };

  const fakeDoc = {
    dispatchEvent: (e) => { state.events.push(e); return true; },
    getElementById: () => null,
  };
  function FakeCustomEvent(type, init) { return { type, detail: init && init.detail }; }

  const factory = new Function(
    'document', 'CustomEvent', 'state', 'window',
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'isExplicitEndorsement',
    'buildSetRevisionProposal', 'decideApproval', 'isProposalCurrent', 'setRevisionFutureSetCount',
    `
    'use strict';
    function getActivePlannedSession(){ return state.plan; }
    function getSessionLog(){ return state.log; }
    function getSessionRevisions(){ return state.revisions; }
    function setSessionRevisions(v){ state.revisions = Array.isArray(v) ? v : []; }
    function getPendingSetRevision(){ return state.pendingSetRevision; }
    function setPendingSetRevision(v){
      state.pendingSetRevision = (v && typeof v === 'object') ? v : null;
      if (state.pendingSetRevision) state.pendingReplacement = null;   // store.js mutual exclusion
    }
    function getPendingReplacement(){ return state.pendingReplacement; }
    function persistSessionSnapshot(){ state.snapshots++; }
    function saveSessionSnapshot(){ state.snapshots++; }
    function emitPlanItemOutcome(o){ state.outcomes.push(o); }
    function renderActiveSessionBanner(){}
    function fetchReaction(){ return Promise.resolve(null); }
    function api(url, init){
      state.posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      return Promise.resolve({});
    }
    ${sliceEmit}
    ${sliceLane}
    ${sliceFollow}
    return { proposeSetRevision, approvePendingSetRevision, rejectPendingSetRevision,
             explainPendingSetRevision, trySetRevisionFollowup };
    `
  );

  const api = factory(
    fakeDoc, FakeCustomEvent, state, { setRevisionFollowup: classifier() },
    ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount,
    endorse.isExplicitEndorsement,
    proposalModule.buildSetRevisionProposal, proposalModule.decideApproval,
    proposalModule.isProposalCurrent, proposalModule.futureSetCount,
  );
  return { api, state };
}

// A live proposal, staged the ONLY legitimate way: through proposeSetRevision.
function withProposal(options) {
  const h = harness(options);
  const p = h.api.proposeSetRevision({ ...PROPOSAL_INPUT, ...((options && options.proposal) || {}) });
  assert.ok(p, 'the fixture must stage a real proposal');
  h.state.events.length = 0;              // drop the proposal card event; assert on replies only
  return h;
}

const replies = (state) => state.events
  .filter(e => e.type === 'atlas:set-revision-reply' || e.type === 'atlas:set-revision-explained')
  .map(e => (e.detail && e.detail.line) || '');
const lastReply = (state) => replies(state).slice(-1)[0] || '';

// ═══════════════════════════════════════════════════════════════════════════════
// Phrase 1 — "do that": the only class that may execute
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.1 "do that" approves one fresh proposal exactly once', () => {
  const h = withProposal();
  const id = h.state.pendingSetRevision.proposal_id;

  assert.equal(h.api.trySetRevisionFollowup('do that'), true, 'the lane claims the turn');

  assert.equal(h.state.revisions.length, 3, 'one revision per future set');
  assert.equal(h.state.revisions.every(r => r.plan_item_id === SLOT_ITEM), true,
    'identity comes from the stored proposal, never from the athlete\'s prose');
  assert.equal(h.state.revisions.every(r => r.planned_lift_code === SLOT_CODE), true,
    'planned_lift_code is PRESERVED — a load change is not a substitution');
  assert.equal(h.state.revisions.every(r => r.target_weight === 185), true,
    'the prescription comes from the stored proposal');
  assert.equal(h.state.outcomes.length, 0, 'no substituted item_outcome');
  assert.equal(h.state.pendingSetRevision, null, 'the proposal is consumed');
  assert.equal(h.state.posts.length, 3);
  assert.equal(h.state.posts[0].url, '/api/session-plan-sets/revision');
  assert.ok(lastReply(h.state), 'the athlete gets the deterministic success response');
  assert.match(lastReply(h.state), /185/, 'and it states the stored prescription');
  assert.ok(id, 'the proposal had a stable id');
});

test('4b.2 "yes, do that" approves exactly once', () => {
  for (const words of ['yes, do that', 'yes do that', 'apply that change', 'go with that',
    'yes, make that adjustment', "accept Atlas's change"]) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), true, `"${words}" must execute`);
    assert.equal(h.state.revisions.length, 3, `"${words}" captures exactly the future sets`);
    assert.equal(h.state.pendingSetRevision, null, `"${words}" consumes the proposal`);
  }
});

test('4b.3 "do that" with NO active proposal causes no mutation', () => {
  const h = harness();
  assert.equal(h.state.pendingSetRevision, null);

  assert.equal(h.api.trySetRevisionFollowup('do that'), false, 'the lane declines the turn');

  assert.equal(h.state.revisions.length, 0, 'nothing is revised');
  assert.equal(h.state.posts.length, 0, 'nothing is checkpointed');
  assert.equal(replies(h.state).length, 0, 'no referent is manufactured');
});

test('4b.4 a STALE proposal cannot approve', () => {
  const h = withProposal();
  h.state.plan = plan({ plan_version: 'pv_moved' });      // the plan moved under the proposal

  assert.equal(h.api.trySetRevisionFollowup('do that'), false, 'a stale proposal fails closed');

  assert.equal(h.state.revisions.length, 0, 'nothing is revised');
  assert.equal(h.state.posts.length, 0);
  assert.equal(h.state.pendingSetRevision, null, 'and the dead proposal is cleared, never applied');
});

test('4b.5 a SUPERSEDED proposal cannot approve', () => {
  const h = withProposal();
  const older = h.state.pendingSetRevision;
  // A newer proposal for the same slot supersedes it (store keeps exactly one).
  const newer = h.api.proposeSetRevision({ ...PROPOSAL_INPUT, prescription: { weight: 195, reps: 5, rir: 2 } });
  assert.notEqual(newer.proposal_id, older.proposal_id, 'the fixture genuinely superseded');
  h.state.events.length = 0;

  assert.equal(h.api.trySetRevisionFollowup('do that'), true, 'the CURRENT proposal is decidable');

  assert.equal(h.state.revisions.every(r => r.target_weight === 195), true,
    'the ACTIVE proposal is applied — never the superseded one');
  // And the superseded id can never be applied through the shared handler.
  assert.equal(h.api.approvePendingSetRevision({ proposal_id: older.proposal_id, endorsement: 'yes' }), false,
    'a superseded id is refused by the one approval implementation');
});

test('4b.6 double submission is idempotent', () => {
  const h = withProposal();

  assert.equal(h.api.trySetRevisionFollowup('do that'), true);
  const afterFirst = h.state.revisions.length;
  const postsAfterFirst = h.state.posts.length;

  assert.equal(h.api.trySetRevisionFollowup('do that'), false, 'the second "do that" finds nothing active');
  assert.equal(h.state.revisions.length, afterFirst, 'no second revision chain');
  assert.equal(h.state.posts.length, postsAfterFirst, 'no second checkpoint');
});

test('4b.7 negation does not borrow consent', () => {
  for (const words of ['I don\'t want to do that', 'Maybe do that later', 'I can\'t say yes, do that yet']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" is not consent`);
    assert.equal(h.state.revisions.length, 0, `"${words}" mutates nothing`);
    assert.ok(h.state.pendingSetRevision, `"${words}" leaves the decision outstanding`);
  }
});

test('4b.8 quotation does not borrow consent', () => {
  for (const words of ['Atlas said "do that"', 'Did I say do that?']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" is not consent`);
    assert.equal(h.state.revisions.length, 0);
    assert.ok(h.state.pendingSetRevision);
  }
});

test('4b.9 hypothetical wording does not borrow consent', () => {
  for (const words of ['If I say do that, what happens?', 'what would happen if I do that']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" is not consent`);
    assert.equal(h.state.revisions.length, 0);
    assert.ok(h.state.pendingSetRevision);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phrase 2 — "why that weight?": explain and preserve
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.10 "why that weight?" explains from the STRUCTURED proposal state', () => {
  const h = withProposal();

  assert.equal(h.api.trySetRevisionFollowup('why that weight?'), true, 'the lane answers it');

  const line = lastReply(h.state);
  assert.match(line, /185/, 'the answer states the stored target');
  assert.match(line, /225/, 'and the stored current prescription');
  assert.match(line, new RegExp(SLOT_NAME), 'named from the stored proposal');
  assert.equal(h.state.coachCalls.length, 0, 'the model is never invoked for a sufficient structured answer');
});

test('4b.10b every approved "why" shape reaches the same explanation', () => {
  for (const words of ['why that weight?', 'why those reps?', 'why that change?',
    'why are we dropping it?', 'why only that much?']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), true, `"${words}" explains`);
    assert.match(lastReply(h.state), /185/, `"${words}" answers from the proposal`);
    assert.ok(h.state.pendingSetRevision, `"${words}" preserves the proposal`);
  }
});

test('4b.11 an explanation KEEPS the proposal active', () => {
  const h = withProposal();
  const id = h.state.pendingSetRevision.proposal_id;

  h.api.trySetRevisionFollowup('why that weight?');

  assert.ok(h.state.pendingSetRevision, 'asking why is not deciding');
  assert.equal(h.state.pendingSetRevision.proposal_id, id, 'the SAME proposal, unchanged');
  assert.equal(h.state.revisions.length, 0, 'and nothing was applied');

  // …and it can still be approved afterwards, through the same handler.
  assert.equal(h.api.trySetRevisionFollowup('do that'), true);
  assert.equal(h.state.revisions.length, 3);
});

test('4b.12 no trustworthy proposal produces clarification, never invention', () => {
  // (a) an untrustworthy (stale) proposal: ask which recommendation is meant; never answer from it.
  const stale = withProposal();
  stale.state.plan = plan({ plan_version: 'pv_moved' });
  assert.equal(stale.api.trySetRevisionFollowup('why that weight?'), true, 'the turn is answered honestly');
  const line = lastReply(stale.state);
  assert.doesNotMatch(line, /185/, 'a stale proposal is never read out as if current');
  assert.match(line, /which/i, 'it asks which recommendation the athlete means');
  assert.equal(stale.state.revisions.length, 0, 'and mutates nothing');

  // (b) no proposal at all: the lane does not engage, so nothing is invented and the existing
  // grounded coach path (criterion 4 step (a) discussion referent) answers unchanged.
  const none = harness();
  assert.equal(none.api.trySetRevisionFollowup('why that weight?'), false, 'no proposal → fall through');
  assert.equal(none.state.revisions.length, 0);
  assert.equal(replies(none.state).length, 0, 'no stale proposal is selected and no referent invented');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phrase 3 — "keep it": clarify, do not execute
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.13 bare "keep it" asks the two-choice question and performs NO action', () => {
  for (const words of ['keep it', 'Keep it.', 'just keep it', 'keep that', 'leave it']) {
    const h = withProposal();
    const id = h.state.pendingSetRevision.proposal_id;

    assert.equal(h.api.trySetRevisionFollowup(words), true, `"${words}" is claimed`);

    assert.equal(lastReply(h.state), 'Keep the original plan, or accept Atlas’s change?',
      `"${words}" asks the exact two-choice question`);
    assert.equal(h.state.revisions.length, 0, `"${words}" does not approve`);
    assert.ok(h.state.pendingSetRevision, `"${words}" does not reject`);
    assert.equal(h.state.pendingSetRevision.proposal_id, id, 'the proposal is preserved exactly');
  }
});

test('4b.14 "keep the original" rejects through the EXISTING handler', () => {
  for (const words of ['keep the original', 'leave it as planned', "don't change it",
    'stick with the original', 'yes, keep the original']) {
    const h = withProposal();

    assert.equal(h.api.trySetRevisionFollowup(words), true, `"${words}" is claimed`);

    assert.equal(h.state.pendingSetRevision, null, `"${words}" rejects the proposal`);
    assert.equal(h.state.revisions.length, 0, `"${words}" captures nothing`);
    assert.equal(h.state.posts.length, 0, `"${words}" checkpoints nothing`);
    assert.match(lastReply(h.state), new RegExp(SLOT_NAME), 'and says what was kept, from the stored proposal');
  }
});

test('4b.15 "accept Atlas\'s change" approves through the EXISTING handler', () => {
  const h = withProposal();

  assert.equal(h.api.trySetRevisionFollowup("accept Atlas's change"), true);

  assert.equal(h.state.revisions.length, 3, 'the same approval path as the card');
  assert.equal(h.state.revisions.every(r => r.planned_lift_code === SLOT_CODE), true);
  assert.equal(h.state.pendingSetRevision, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phrase 4 — "the last two sets": a scope fragment, not an action
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.16 "the last two sets" asks the scope clarification and performs NO mutation', () => {
  const h = withProposal();
  const id = h.state.pendingSetRevision.proposal_id;

  assert.equal(h.api.trySetRevisionFollowup('the last two sets'), true);

  assert.equal(lastReply(h.state),
    'What do you want to change about the last two sets — the weight, the reps, or remove them?',
    'the exact required scope question');
  assert.equal(h.state.revisions.length, 0, 'no load, rep target or deletion is inferred');
  assert.equal(h.state.posts.length, 0);
  assert.equal(h.state.pendingSetRevision.proposal_id, id, 'the proposal is the preserved structured anchor');
});

test('4b.17 fewer than two FUTURE sets are stated honestly', () => {
  // Two of the three accepted sets are already performed, so only ONE future set exists.
  const h = withProposal({ log: [{ exercise: SLOT_NAME }, { exercise: SLOT_NAME }] });

  assert.equal(h.api.trySetRevisionFollowup('the last two sets'), true);

  const line = lastReply(h.state);
  assert.doesNotMatch(line, /last two sets/, 'Atlas never pretends two future sets exist');
  assert.match(line, /\b1\b|\bone\b/, 'the actual remaining scope is stated');
  assert.match(line, new RegExp(SLOT_NAME));
  assert.equal(h.state.revisions.length, 0, 'and nothing is mutated');
});

test('4b.18 completed sets are NEVER included in the editable scope', () => {
  // All three accepted sets performed → no future sets at all.
  const h = withProposal({ log: [{ exercise: SLOT_NAME }, { exercise: SLOT_NAME }, { exercise: SLOT_NAME }] });

  assert.equal(h.api.trySetRevisionFollowup('the last two sets'), true);

  const line = lastReply(h.state);
  assert.match(line, /already logged/i, 'completed sets are reported as done, never as editable');
  assert.doesNotMatch(line, /last two sets/, 'no phantom future scope');
  assert.equal(h.state.revisions.length, 0);

  // The same honesty holds for the drop question, which must not offer to remove finished sets.
  const drop = withProposal({ log: [{ exercise: SLOT_NAME }, { exercise: SLOT_NAME }, { exercise: SLOT_NAME }] });
  assert.equal(drop.api.trySetRevisionFollowup('drop those'), true);
  assert.match(lastReply(drop.state), /already logged/i);
  assert.equal(drop.state.revisions.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phrase 5 — "drop those": ambiguous dimension
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.19 "drop those" asks which dimension and performs NO mutation', () => {
  for (const words of ['drop those', 'drop them', 'lower those', 'drop it']) {
    const h = withProposal();
    const id = h.state.pendingSetRevision.proposal_id;

    assert.equal(h.api.trySetRevisionFollowup(words), true, `"${words}" is claimed`);

    assert.equal(lastReply(h.state), 'Drop the weight, the reps, or the sets themselves?',
      `"${words}" asks the exact dimension question`);
    assert.equal(h.state.revisions.length, 0, `"${words}" invents no prescription`);
    assert.ok(h.state.pendingSetRevision, `"${words}" is NOT treated as a rejection`);
    assert.equal(h.state.pendingSetRevision.proposal_id, id);
  }
});

test('4b.19b a NAMED drop target stays with the existing skip lane', () => {
  const C = classifier();
  // "drop squats" is a real one-sided skip and belongs to tryApplyPlanMutation. The follow-up lane
  // must not claim it, even while a proposal is live — otherwise a genuine plan command would be
  // answered with a clarifying question and the plan would never change.
  for (const words of ['drop squats', 'drop the leg press', 'cut back squat', 'drop set on bench',
    'drop set', 'drop sets']) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'no_match',
      `"${words}" names its own target and is not a proposal follow-up`);
  }
  const h = withProposal();
  assert.equal(h.api.trySetRevisionFollowup('drop squats'), false, 'the lane falls through');
  assert.ok(h.state.pendingSetRevision, 'and leaves the proposal outstanding');

  // A SET-scoped drop is still the ambiguous dimension question, with the scope carried as language.
  const scoped = C.classifySetRevisionFollowup('drop the last two sets');
  assert.equal(scoped.action, 'clarify_drop_dimension');
  assert.equal(scoped.setScope.count, 2);
  const d = withProposal();
  assert.equal(d.api.trySetRevisionFollowup('drop the last two sets'), true);
  assert.equal(lastReply(d.state), 'Drop the weight, the reps, or the sets themselves?');
  assert.equal(d.state.revisions.length, 0, 'still no mutation on an ambiguous drop');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Non-consent, routing precedence, and competing state
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.20 generic acknowledgements do not approve', () => {
  for (const words of ['ok', 'sure', 'alright', 'got it', 'thanks', 'k', 'cool']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" is not consent and not a class`);
    assert.equal(h.state.revisions.length, 0, `"${words}" mutates nothing`);
    assert.ok(h.state.pendingSetRevision, `"${words}" leaves the decision outstanding`);
  }
});

test('4b.T1 a set-revision proposal and a replacement proposal can never both decide a turn', () => {
  // The store enforces mutual exclusion (setPendingSetRevision clears pendingReplacement). If
  // malformed state somehow presents both, the lane must not guess which one "do that" names.
  const h = withProposal();
  h.state.pendingReplacement = { status: 'pending', proposal_id: 'repl:1', source: { name: 'Leg Press' } };

  assert.equal(h.api.trySetRevisionFollowup('do that'), true, 'the lane claims the turn to refuse it');

  assert.equal(h.state.revisions.length, 0, 'no set revision is applied on a guess');
  assert.equal(h.state.outcomes.length, 0, 'and no movement substitution is triggered');
  assert.ok(h.state.pendingSetRevision, 'both proposals stay outstanding');
  assert.ok(h.state.pendingReplacement);
  assert.match(lastReply(h.state), /which/i, 'the athlete is asked to choose');
});

test('4b.T2 the store keeps exactly one proposal outstanding', async () => {
  const storeMod = await import('../src/app/store.js');
  const mem = new Map();
  globalThis.localStorage = globalThis.localStorage || {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
  };
  storeMod.setPendingReplacement({ status: 'pending', proposal_id: 'repl:1' });
  storeMod.setPendingSetRevision({ kind: 'set_revision', proposal_id: 'setrev:1' });
  assert.equal(storeMod.getPendingReplacement(), null, 'staging a set revision clears a replacement');
  storeMod.setPendingReplacement({ status: 'pending', proposal_id: 'repl:2' });
  assert.equal(storeMod.getPendingSetRevision(), null, 'and the reverse holds too');
  storeMod.setPendingReplacement(null);
});

test('4b.24 replacement-proposal follow-ups remain unchanged', () => {
  // (a) with no set-revision proposal the new lane declines every turn, so the replacement
  //     follow-up lane behind it sees exactly the traffic it sees on main.
  const h = harness({ pendingReplacement: { status: 'pending', proposal_id: 'repl:1', source: { name: 'Leg Press' } } });
  for (const words of ['yes', 'do that', 'keep it', 'why that weight?', 'drop those', 'the last two sets']) {
    assert.equal(h.api.trySetRevisionFollowup(words), false,
      `"${words}" must fall through to the replacement lane when no set revision is pending`);
  }
  assert.ok(h.state.pendingReplacement, 'the replacement proposal is untouched');

  // (b) the replacement follow-up resolver itself is unchanged in the bundle.
  const fn = appSrc.slice(
    appSrc.indexOf('function tryResolvePendingReplacement('),
    appSrc.indexOf('function tryApplyImplicitSubstitution(')
  );
  assert.match(fn, /AR\.classifyFollowup\(text, proposal\)/, 'still classifies through activeReplacement');
  assert.match(fn, /approvePendingReplacement\(\)/, 'still approves through its own handler');
  assert.match(fn, /rejectPendingReplacement\(\)/, 'still rejects through its own handler');
  assert.doesNotMatch(fn, /SetRevision/, 'and it never reaches into the set-revision lane');
});

test('4b.25 factual-dispute and safety routing remain unchanged', () => {
  // A dispute ("that isn't what you planned") is resolved server-side through the discussion
  // referent (criterion 4 step (a)). The follow-up classifier must not claim those turns.
  const C = classifier();
  for (const words of [
    "that isn't what you planned", 'you said 225', 'that\'s not what I did',
    'my knee hurts', 'I feel beat up today', 'my back is a bit sore',
    'skip squats', 'replace back squats with bench', 'undo that write',
    'log it', 'done', 'bench 225 5/2',
  ]) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'no_match',
      `"${words}" belongs to a higher-priority lane`);
  }
});

test('4b.26 normal unmatched coach chat falls through unchanged', () => {
  const h = withProposal();
  for (const words of ['how is my bench trending?', 'what should I eat after this',
    'why do I always stall on deadlifts?', 'how many sets left', 'nice']) {
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" is not a proposal follow-up`);
  }
  assert.equal(h.state.revisions.length, 0, 'nothing was mutated by falling through');
  assert.ok(h.state.pendingSetRevision, 'and the proposal stays outstanding for the card');
  assert.equal(replies(h.state).length, 0, 'and Atlas said nothing deterministic on those turns');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Codex review round 1 — three real findings, pinned
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.X1 (Codex P1) consent must account for the WHOLE turn, never just its opening', () => {
  // "yes my knee hurts" opens with an affirmative and carries a safety report. Approving it would
  // rewrite the remaining sets AND swallow the safety turn, because the lane claims the message.
  for (const words of [
    'yes my knee hurts', 'sounds good but my knee hurts', 'yeah my shoulder is killing me',
    'do it my back feels off', 'yes lets also skip the last exercise', 'yep log bench 225',
    'go ahead and switch to leg press',
  ]) {
    assert.equal(endorse.isExplicitEndorsement(words), false,
      `"${words}" says more than yes, so it is not a yes`);
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" must fall through`);
    assert.equal(h.state.revisions.length, 0, `"${words}" mutates nothing`);
    assert.ok(h.state.pendingSetRevision, `"${words}" leaves the proposal outstanding`);
    assert.equal(replies(h.state).length, 0, 'and the safety/command turn is not swallowed');
  }

  // The ordinary spoken forms still endorse — the tightening must not break them.
  for (const words of ['yes', 'yeah do it', "let's do it", 'ok yeah do it', 'alright yes',
    'well go ahead', 'okay do it', 'do it please', 'yes, do that', 'yes, make that adjustment',
    'apply that change', 'go with that', "accept Atlas's change", 'accept', 'approve']) {
    assert.equal(endorse.isExplicitEndorsement(words), true, `"${words}" is a standalone endorsement`);
  }
});

test('4b.X2 (Codex P1) a superseded submit decides nothing', () => {
  // The lane is reached after an await, so an older reply's late parse rejection must not approve
  // against a proposal the athlete has since asked a clarifying question about. The composer checks
  // submit authority BEFORE the lane, not only before the async branches after it.
  const catchBlock = appSrc.slice(
    appSrc.indexOf('if (pendingChatText && !hasAnyEffortInput()) {'),
    appSrc.indexOf('tryResolvePendingReplacement(pendingChatText)')
  );
  const guardIdx = catchBlock.lastIndexOf('if (submitSeq !== previewRequestSeq');
  const laneIdx = catchBlock.indexOf('trySetRevisionFollowup(pendingChatText)');
  assert.notEqual(guardIdx, -1, 'the lane must be preceded by a submit-authority check');
  assert.notEqual(laneIdx, -1, 'the lane must be wired in the catch block');
  assert.ok(guardIdx < laneIdx, 'submit authority is checked BEFORE the state-changing lane');

  // And a clarification really does keep the proposal alive, which is what made the race reachable.
  const h = withProposal();
  assert.equal(h.api.trySetRevisionFollowup('keep it'), true);
  assert.ok(h.state.pendingSetRevision, 'the clarification preserved the proposal');
  assert.equal(h.state.revisions.length, 0);
});

test('4b.X3 (Codex P2) a FIRST-anchored scope is never answered as if it named the last sets', () => {
  const C = classifier();
  const first = C.classifySetRevisionFollowup('the first two sets');
  assert.equal(first.action, 'clarify_set_scope');
  assert.equal(first.setScope.position, 'first', 'the requested position is preserved');
  assert.equal(first.setScope.count, 2);

  // One set already logged: "the first two sets" names set 1 (done) and set 2. Completed sets are
  // not editable, so Atlas must say so rather than quietly answer about sets 2 and 3.
  const h = withProposal({ log: [{ exercise: SLOT_NAME }] });
  assert.equal(h.api.trySetRevisionFollowup('the first two sets'), true);
  const line = lastReply(h.state);
  assert.match(line, /first 2 sets/, 'the requested scope is named');
  assert.match(line, /already logged/i, 'and the overlap with completed work is stated');
  assert.match(line, /2 sets/, 'the actual editable scope is stated');
  assert.equal(h.state.revisions.length, 0, 'and nothing is mutated');

  // With nothing logged yet the first N ARE the future sets — the question echoes the athlete's own
  // position word rather than silently rewriting it to "last".
  const clean = withProposal();
  assert.equal(clean.api.trySetRevisionFollowup('the first two sets'), true);
  assert.equal(lastReply(clean.state),
    'What do you want to change about the first two sets — the weight, the reps, or remove them?');

  // The next-anchored form is echoed too.
  const next = withProposal();
  assert.equal(next.api.trySetRevisionFollowup('the next two sets'), true);
  assert.match(lastReply(next.state), /about the next two sets/);
});

test('4b.X4 a hedged utterance never rejects or approves', () => {
  for (const words of ['maybe keep the original', 'i think keep the original', 'i guess keep it',
    'maybe do that']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" is undecided`);
    assert.ok(h.state.pendingSetRevision, `"${words}" must not discard the decision`);
    assert.equal(h.state.revisions.length, 0);
  }
});

test('4b.X5 the two-choice question\'s own answers route to the two existing handlers', () => {
  // The lane asks "Keep the original plan, or accept Atlas's change?" — both direct answers must
  // work, and the asymmetry is deliberate: the ORIGINAL side is admitted as a bare noun phrase
  // because refusing is safe, while the acceptance side still needs an explicit endorsement.
  for (const words of ['the original', 'original', 'the original plan', 'as planned']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), true, `"${words}" answers the question`);
    assert.equal(h.state.pendingSetRevision, null, `"${words}" rejects through the existing handler`);
    assert.equal(h.state.revisions.length, 0, `"${words}" captures nothing`);
  }
  for (const words of ['accept', 'approve', 'accept the change']) {
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), true, `"${words}" answers the question`);
    assert.equal(h.state.revisions.length, 3, `"${words}" approves through the existing handler`);
  }
  // The bare noun phrase on the acceptance side is NOT consent — it falls through, fail-closed.
  const thin = withProposal();
  assert.equal(thin.api.trySetRevisionFollowup('the change'), false,
    'a bare noun phrase never rewrites the remaining sets');
  assert.equal(thin.state.revisions.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Codex review round 2 — three more real findings, pinned
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.Y1 (Codex P1) EVERY tier must consume the whole turn, not just its opening', () => {
  // The consent fix in round 1 covered only the approve tier. A compound turn still reached the
  // explanation tier ("why that weight? my knee hurts" — the safety report never reaches the coach)
  // and the rejection tier ("don't change it, my knee hurts" — which ALSO discarded the proposal).
  const compound = [
    'why that weight? my knee hurts',
    'why those reps? my shoulder is killing me',
    "don't change it, my knee hurts",
    'keep the original, my back is sore',
    'leave it as planned but my knee hurts',
    'keep it, my elbow is bothering me',
    'drop those, my knee hurts',
    'the last two sets and my knee hurts',
    'no changes, i think i tweaked something',
  ];
  const C = classifier();
  for (const words of compound) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'no_match',
      `"${words}" says more than a follow-up, so the whole message must fall through`);
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" must not be claimed`);
    assert.ok(h.state.pendingSetRevision, `"${words}" must not discard the proposal`);
    assert.equal(h.state.revisions.length, 0, `"${words}" must mutate nothing`);
    assert.equal(replies(h.state).length, 0, `"${words}" must not be answered instead of the coach`);
  }

  // …and the five approved shapes of every class still work after the tightening.
  for (const words of ['why that weight?', 'why those reps?', 'why that change?',
    'why are we dropping it?', 'why only that much?']) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'explain_active_proposal', `"${words}"`);
  }
  for (const words of ['keep the original', 'leave it as planned', "don't change it",
    'stick with the original', 'no changes', 'forget it', 'keep it as is', 'leave it alone']) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'reject_active_proposal', `"${words}"`);
  }
  for (const words of ['keep it', 'keep that', 'leave it', 'just keep it']) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'clarify_keep', `"${words}"`);
  }
});

test('4b.Y5 (Codex P1) a pain or symptom question is never answered as a proposal rationale', () => {
  const C = classifier();
  // The whole-turn fix was not enough: an arbitrary-word gap in the why pattern let
  // "why does it hurt like that?" match, so a single-clause SAFETY question was answered with a
  // prescription rationale and never reached the coach.
  const safety = [
    'why does it hurt like that?',
    'why does that hurt so much?',
    'why is it sore like that?',
    'why do i feel that in my knee?',
    'is that supposed to hurt',
    'that hurt',
    'my knee hurts',
    'keep it, that hurts',
    'do that but it hurts',
    'drop those they hurt',
    'the last two sets hurt',
  ];
  for (const words of safety) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'no_match',
      `"${words}" is about the athlete's body and belongs to the coach`);
    const h = withProposal();
    assert.equal(h.api.trySetRevisionFollowup(words), false, `"${words}" must not be claimed`);
    assert.equal(h.state.revisions.length, 0, `"${words}" must mutate nothing`);
    assert.ok(h.state.pendingSetRevision, `"${words}" must not discard the proposal`);
    assert.equal(replies(h.state).length, 0, `"${words}" must reach the coach, not this lane`);
  }

  // The approved why shapes still explain, and so do the natural change-verb forms.
  for (const words of ['why that weight?', 'why those reps?', 'why that change?',
    'why are we dropping it?', 'why only that much?', 'why did you change that?',
    'why is it lower?', 'why we dropped it']) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'explain_active_proposal', `"${words}"`);
  }
  // …and a coaching question that names its own subject still reaches the coach.
  for (const words of ['why do i always stall on deadlifts?', 'why is my bench flat?']) {
    assert.equal(C.classifySetRevisionFollowup(words).action, 'no_match', `"${words}"`);
  }
});

test('4b.Y6 (Codex P2) a first-anchored scope reports the INTERSECTION, not every future set', () => {
  // One of three logged. "the first two sets" names sets 1–2, of which only set 2 is still ahead.
  // Reporting "2 sets" would offer sets 2–3 — a different scope from the one the athlete named.
  const h = withProposal({ log: [{ exercise: SLOT_NAME }] });
  assert.equal(h.api.trySetRevisionFollowup('the first two sets'), true);
  const line = lastReply(h.state);
  assert.match(line, /first 2 sets/, 'the named range is stated');
  assert.match(line, /already logged/i, 'the completed overlap is stated');
  assert.match(line, /set 2\b/, 'and the answer is the INTERSECTION — set 2 only');
  assert.doesNotMatch(line, /sets 2–3|2 sets —/, 'never offers a set outside the named range');
  assert.equal(h.state.revisions.length, 0);

  // Every named set already logged → say so, and be explicit that what remains is outside the range.
  const done = withProposal({ log: [{ exercise: SLOT_NAME }, { exercise: SLOT_NAME }] });
  assert.equal(done.api.trySetRevisionFollowup('the first two sets'), true);
  assert.match(lastReply(done.state), /outside the range you named/,
    'an entirely-completed range is not silently replaced with a different one');

  // "all sets" intersects the whole remainder, so its range genuinely is sets 2–3.
  const all = withProposal({ log: [{ exercise: SLOT_NAME }] });
  assert.equal(all.api.trySetRevisionFollowup('all sets'), true);
  assert.match(lastReply(all.state), /All 3 sets/);
  assert.match(lastReply(all.state), /sets 2–3/, 'the all-range intersection is the real remainder');
});

test('4b.Y4 (Codex P1) a newer submit revokes an older one BEFORE any early return', () => {
  // `previewRequestSeq` advances on a form edit and inside invalidatePreview, and several newer
  // turns return before reaching either — a bug command, a plan request, an artifact ask, a held
  // clarification, finish/closeout, the correction prompt. An older reply awaiting its parse would
  // still have looked authoritative and could have approved a proposal the athlete moved on from.
  const handlerStart = appSrc.indexOf("document.getElementById('logger-form').addEventListener('submit'");
  assert.notEqual(handlerStart, -1, 'the composer submit handler must exist');
  const handler = appSrc.slice(handlerStart, appSrc.indexOf('trySetRevisionFollowup(pendingChatText)'));

  const bumpIdx = handler.indexOf('composerTurnSeq += 1;');
  const captureIdx = handler.indexOf('const turnSeq = composerTurnSeq;');
  assert.notEqual(bumpIdx, -1, 'every submit must bump the composer turn counter');
  assert.notEqual(captureIdx, -1, 'and capture its own turn identity');
  assert.ok(bumpIdx < captureIdx, 'bump, then capture — the current turn stays authoritative');

  // It must precede EVERY early return in the handler, so the first one is the yardstick.
  for (const earlier of [
    'parseBugCommand(submittedText)',
    'looksLikeSessionRequest(workoutTextInput.value)',
    'looksLikeArtifactRequest(workoutTextInput.value)',
    'resolvePendingClarification(workoutTextInput.value.trim())',
    'looksLikeLogIt(workoutTextInput.value)',
    'showCorrectionPrompt(correctionText)',
    'const pendingChatText =',
  ]) {
    const idx = handler.indexOf(earlier);
    assert.notEqual(idx, -1, `${earlier} must be present in the handler`);
    assert.ok(bumpIdx < idx, `the revoke must precede the early return at ${earlier}`);
  }

  // …and the state-changing lane must check BOTH counters.
  const guard = appSrc.slice(handlerStart, appSrc.indexOf('if (trySetRevisionFollowup(pendingChatText))'));
  assert.match(guard, /if \(submitSeq !== previewRequestSeq \|\| turnSeq !== composerTurnSeq\) return;/,
    'the lane is gated on the preview seq AND the composer turn seq');

  // The new counter must not be repurposed anywhere else, so preview / parse / modality and
  // blocked-log semantics stay exactly as they were: it appears in its own declaration, the
  // handler's revoke, and the one lane guard — and in none of those other mechanisms.
  for (const [label, from, to] of [
    ['invalidatePreview', 'function invalidatePreview(', 'function renderPreview('],
    ['tryPreviewModality', 'async function tryPreviewModality(', 'document.getElementById(\'logger-form\').addEventListener(\'submit\''],
  ]) {
    const a = appSrc.indexOf(from);
    const b = appSrc.indexOf(to);
    if (a === -1 || b === -1 || b <= a) continue;
    assert.equal(appSrc.slice(a, b).includes('composerTurnSeq'), false,
      `${label} must be untouched by the new counter`);
  }
  assert.doesNotMatch(appSrc, /blockedLogSeq\s*=\s*turnSeq/, 'it never displaces previewRequestSeq');
  assert.doesNotMatch(appSrc, /previewRequestSeq\s*=\s*composerTurnSeq/, 'the two counters stay separate');
});

test('4b.Y2 (Codex P2) an ALL-anchored scope is never narrowed to the last future sets', () => {
  const C = classifier();
  const all = C.classifySetRevisionFollowup('all sets');
  assert.equal(all.action, 'clarify_set_scope');
  assert.equal(all.setScope.position, 'all', 'the all marker is preserved, not discarded');
  assert.equal(C.classifySetRevisionFollowup('all the sets').setScope.position, 'all');
  assert.equal(C.classifySetRevisionFollowup('all three sets').setScope.count, 3);

  // One of three logged: "all sets" names a completed set, so the overlap must be stated rather
  // than silently answered as "the last two sets".
  const h = withProposal({ log: [{ exercise: SLOT_NAME }] });
  assert.equal(h.api.trySetRevisionFollowup('all sets'), true);
  const line = lastReply(h.state);
  assert.match(line, /All 3 sets/, 'the requested scope is named in full');
  assert.match(line, /already logged/i, 'and the completed-set overlap is stated');
  assert.doesNotMatch(line, /last two sets/, 'the request is never silently narrowed');
  assert.equal(h.state.revisions.length, 0);

  // Nothing logged: every named set really is ahead, so the question keeps the athlete's own word.
  const clean = withProposal();
  assert.equal(clean.api.trySetRevisionFollowup('all sets'), true);
  assert.match(lastReply(clean.state), /about all 3 sets/, 'echoes "all", never "the last N"');
});

test('4b.Y3 (Codex P1) the future-set selector lives outside the frozen app.js shell', () => {
  // CLAUDE.md app.js freeze: no new session-truth selector or truth derivation in src/app/app.js.
  // The first draft derived the editable future-set count there, which broke that rule.
  const mod = require('../src/app/setRevisionProposal.js');
  assert.equal(typeof mod.futureSetCount, 'function',
    'the selector must live in the proposal module, not the shell');

  const proposal = proposalModule.buildSetRevisionProposal({ ...PROPOSAL_INPUT });
  assert.equal(mod.futureSetCount(proposal, []), 3, 'nothing logged → every accepted set is ahead');
  assert.equal(mod.futureSetCount(proposal, [{ exercise: SLOT_NAME }]), 2);
  assert.equal(mod.futureSetCount(proposal, [{ exercise: SLOT_NAME }, { exercise: SLOT_NAME }]), 1);
  assert.equal(mod.futureSetCount(proposal, Array(5).fill({ exercise: SLOT_NAME })), 0,
    'never negative, and a completed set is never editable');
  assert.equal(mod.futureSetCount(null, []), 0, 'fails closed on a missing proposal');

  // The shell must PASS the session buffer in rather than derive the count itself.
  const lane = appSrc.slice(
    appSrc.indexOf('function trySetRevisionFollowup('),
    appSrc.indexOf('function openTodaySessionPlan(')
  );
  assert.match(lane, /setRevisionFutureSetCount\(active, getSessionLog\(\)\)/,
    'the shell only supplies state to the imported selector');
  assert.doesNotMatch(appSrc.slice(appSrc.indexOf('function explainPendingSetRevision('), appSrc.indexOf('function openTodaySessionPlan(')),
    /function setRevisionFutureSetCount\(/, 'no local selector remains in the shell');
});

// ═══════════════════════════════════════════════════════════════════════════════
// The card path is unchanged, and both paths share ONE state machine
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.21 the existing card Approve action is unchanged', () => {
  const listener = appSrc.slice(
    appSrc.indexOf("document.addEventListener('atlas:set-revision-decision'"),
    appSrc.indexOf('function explainPendingSetRevision(')
  );
  assert.match(listener, /d\.decision === 'approve'\) approvePendingSetRevision\(\{ proposal_id: d\.proposal_id, endorsement: d\.endorsement \}\)/,
    'Approve still routes to the one approval handler with the card\'s own id + endorsement');
  assert.match(coachSrc, /approve\.addEventListener\('click', \(\) => decide\('approve', 'yes'\)\)/,
    'the Approve button still carries an unambiguous affirmative');

  // and it still works, driven exactly as the card drives it
  const h = withProposal();
  const id = h.state.pendingSetRevision.proposal_id;
  assert.equal(h.api.approvePendingSetRevision({ proposal_id: id, endorsement: 'yes' }), true);
  assert.equal(h.state.revisions.length, 3);
});

test('4b.22 the existing card Keep Original action is unchanged', () => {
  const listener = appSrc.slice(
    appSrc.indexOf("document.addEventListener('atlas:set-revision-decision'"),
    appSrc.indexOf('function explainPendingSetRevision(')
  );
  assert.match(listener, /d\.decision === 'reject'\) rejectPendingSetRevision\(\{ proposal_id: d\.proposal_id \}\)/,
    'Keep Original is still an explicit rejection');
  assert.match(coachSrc, /keep\.addEventListener\('click', \(\) => decide\('reject'\)\)/,
    'the Keep Original button still dispatches a rejection');

  const h = withProposal();
  const id = h.state.pendingSetRevision.proposal_id;
  assert.equal(h.api.rejectPendingSetRevision({ proposal_id: id }), true);
  assert.equal(h.state.pendingSetRevision, null);
  assert.equal(h.state.revisions.length, 0);
});

test('4b.23 the existing card Ask Why action is unchanged', () => {
  const listener = appSrc.slice(
    appSrc.indexOf("document.addEventListener('atlas:set-revision-decision'"),
    appSrc.indexOf('function explainPendingSetRevision(')
  );
  assert.match(listener, /d\.decision === 'ask_why'\) explainPendingSetRevision\(d\.proposal_id\)/,
    'Ask Why still routes to the one explanation handler');
  assert.match(coachSrc, /why\.addEventListener\('click', \(\) => decide\('ask_why'\)\)/);

  const h = withProposal();
  const id = h.state.pendingSetRevision.proposal_id;
  assert.equal(h.api.explainPendingSetRevision(id), true);
  assert.ok(h.state.pendingSetRevision, 'Ask Why still keeps the proposal active');
  assert.match(lastReply(h.state), /185/);
});

test('4b.SM natural language and the card converge on ONE state machine', () => {
  // The typed lane must call the SAME three handlers the card listener calls, and must not carry
  // a second approval, a second consent test, or a second revision emitter.
  const followStart = appSrc.indexOf('function trySetRevisionFollowup(');
  const lane = appSrc.slice(followStart, appSrc.indexOf('function openTodaySessionPlan('));
  assert.match(lane, /approvePendingSetRevision\(/, 'approval goes through the existing handler');
  assert.match(lane, /rejectPendingSetRevision\(/, 'rejection goes through the existing handler');
  assert.match(lane, /explainPendingSetRevision\(/, 'explanation goes through the existing handler');
  assert.match(lane, /isProposalCurrent\(/, 'freshness is the existing shared test');
  assert.doesNotMatch(lane, /emitEndorsedSetRevision\(/, 'never a second emit path');
  assert.doesNotMatch(lane, /emitFutureSetRevision\(/, 'never a second revision builder');
  assert.doesNotMatch(lane, /decideApproval\(/, 'never a second approval decision');
  assert.doesNotMatch(lane, /buildSetRevisionProposal\(/, 'never re-derives proposal identity');

  // Identity is never reconstructed from prose: the lane reads the stored proposal only.
  assert.match(lane, /active\.proposal_id/, 'the stored proposal_id is the authority');
  assert.doesNotMatch(lane, /canonicalizeExerciseName|parseWorkout|getChatHistory/,
    'no prose parsing, no history scan, no Atlas-generated text is read for identity');
});

test('4b.28 no load/rep revision emits a substituted outcome', () => {
  const h = withProposal();
  h.api.trySetRevisionFollowup('do that');
  assert.equal(h.state.outcomes.length, 0,
    'a prescription change is not a substitution — a substituted item_outcome would corrupt the record');
  assert.equal(h.state.revisions.every(r => r.planned_lift_code === SLOT_CODE), true);
});

test('4b.29 completed sets remain unchanged and only future sets revise', () => {
  const h = withProposal({ log: [{ exercise: SLOT_NAME }] });   // set 1 of 3 already performed

  assert.equal(h.api.trySetRevisionFollowup('do that'), true);

  assert.equal(h.state.revisions.length, 2, 'only the two FUTURE sets are revised');
  const indexes = h.state.revisions.map(r => r.set_index).sort();
  assert.deepEqual(indexes, [2, 3], 'set 1 stays frozen');
});

test('4b.30 a reload-restored proposal behaves identically to a new one', async () => {
  const storeMod = await import('../src/app/store.js');
  const mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
  };
  const p = proposalModule.buildSetRevisionProposal({ ...PROPOSAL_INPUT });
  storeMod.setActivePlannedSession(plan());
  storeMod.setSessionLog([]);
  storeMod.setPendingSetRevision(p);
  storeMod.persistSessionSnapshot('S1');
  storeMod.setPendingSetRevision(null);                       // the process went away
  const res = storeMod.hydrateSessionSnapshot();
  assert.ok(res && res.resumed !== false, 'the snapshot resumes');
  const restored = storeMod.getPendingSetRevision();
  assert.ok(restored, 'the proposal is restored');

  // Drive the lane against the RESTORED object — same identity, same behaviour.
  const h = harness();
  h.state.pendingSetRevision = restored;
  assert.equal(h.api.trySetRevisionFollowup('do that'), true, 'a restored proposal is approvable');
  assert.equal(h.state.revisions.length, 3);
  assert.equal(h.state.revisions.every(r => r.planned_lift_code === SLOT_CODE), true);
  assert.equal(h.state.revisions.every(r => r.target_weight === 185), true,
    'from the RESTORED stored proposal, not a rebuilt one');

  const clarify = harness();
  clarify.state.pendingSetRevision = proposalModule.buildSetRevisionProposal({ ...PROPOSAL_INPUT });
  assert.equal(clarify.api.trySetRevisionFollowup('keep it'), true);
  assert.equal(lastReply(clarify.state), 'Keep the original plan, or accept Atlas’s change?',
    'and a restored proposal clarifies identically');
  storeMod.setPendingSetRevision(null);
  storeMod.clearPersistedSnapshot();
});

test('4b.27 no test in this file calls emitEndorsedSetRevision directly', () => {
  const calls = selfSrc.split('\n').filter(l => /emitEndorsedSetRevision\s*\(/.test(l) && !/doesNotMatch|assert/.test(l));
  assert.deepEqual(calls, [],
    'every capture proven here must go through an approval, never the emitter');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Routing precedence in the REAL composer seam
// ═══════════════════════════════════════════════════════════════════════════════

test('4b.R1 the follow-up lane is wired into the real composer message flow', () => {
  const bugIdx = appSrc.indexOf('parseBugCommand(submittedText)');
  const sessionIdx = appSrc.indexOf('looksLikeSessionRequest(workoutTextInput.value)');
  const clarifyIdx = appSrc.indexOf('resolvePendingClarification(workoutTextInput.value.trim())');
  const logItIdx = appSrc.indexOf('looksLikeLogIt(workoutTextInput.value)');
  const revIdx = appSrc.indexOf('trySetRevisionFollowup(pendingChatText)');
  const replIdx = appSrc.indexOf('tryResolvePendingReplacement(pendingChatText)');
  const modalIdx = appSrc.indexOf('tryPreviewModality(pendingChatText');
  const propIdx = appSrc.indexOf('tryProposeReplacement(pendingChatText)');
  const mutIdx = appSrc.indexOf('tryApplyPlanMutation(pendingChatText)');
  const implicitIdx = appSrc.indexOf('tryApplyImplicitSubstitution(pendingChatText)');
  const icIdx = appSrc.indexOf('tryApplyIdentityCorrection(pendingChatText)');
  const suggestIdx = appSrc.indexOf('checkAndSuggestSubstitute(pendingChatText)');
  const coachIdx = appSrc.indexOf('routeMessageToCoach(pendingChatText)');

  for (const [name, idx] of Object.entries({
    bugIdx, sessionIdx, clarifyIdx, logItIdx, revIdx, replIdx, modalIdx, propIdx,
    mutIdx, implicitIdx, icIdx, suggestIdx, coachIdx,
  })) assert.notEqual(idx, -1, `${name} must be present in the composer flow`);

  // Higher-priority commands keep their precedence: bug capture, the plan request, the held
  // bodyweight clarification and finish/closeout all run BEFORE the conversational lane.
  assert.ok(bugIdx < sessionIdx && sessionIdx < clarifyIdx && clarifyIdx < logItIdx,
    'bug → plan request → held clarification → closeout order is unchanged');
  assert.ok(logItIdx < revIdx, 'finish/closeout still outranks a proposal follow-up');

  // The proposal-follow-up lane runs FIRST among the pending-proposal lanes — it is the only one
  // that can detect the both-pending conflict — and BEFORE modality, explicit replacement,
  // skip/mutation, implicit substitution, identity correction and the coach.
  assert.ok(revIdx < replIdx, 'set-revision follow-up precedes the replacement follow-up');
  assert.ok(replIdx < modalIdx && modalIdx < propIdx && propIdx < mutIdx,
    'the existing replacement → modality → propose → mutate order is unchanged');
  assert.ok(mutIdx < implicitIdx && implicitIdx < icIdx && icIdx < suggestIdx && suggestIdx < coachIdx,
    'the existing tail of the lane is unchanged');
});

test('4b.R2 the classifier is a pure module wired through the one browser seam', () => {
  assert.match(bridgeSrc, /import \* as setRevisionFollowup from '\.\/setRevisionFollowup\.js'/,
    'legacyBridge must import the classifier');
  assert.match(bridgeSrc, /window\.setRevisionFollowup =/, 'and expose it for the shell');

  const src = fs.readFileSync(path.join(repoRoot, 'src', 'app', 'setRevisionFollowup.js'), 'utf8');
  for (const forbidden of [
    'getPendingSetRevision', 'setPendingSetRevision', 'document', 'window', 'fetch(',
    'api(', 'localStorage', 'emitFutureSetRevision', 'proposal_id', 'plan_item_id',
  ]) {
    assert.equal(src.includes(forbidden), false,
      `the classifier must classify LANGUAGE only — it must not reference ${forbidden}`);
  }
});

test('4b.C1 the classifier returns a bounded action enum', () => {
  const C = classifier();
  const allowed = new Set([
    'approve_active_proposal', 'explain_active_proposal', 'reject_active_proposal',
    'clarify_keep', 'clarify_set_scope', 'clarify_drop_dimension', 'no_match',
  ]);
  const samples = ['do that', 'why that weight?', 'keep the original', 'keep it',
    'the last two sets', 'drop those', 'ok', '', null, undefined, 42, {}];
  for (const s of samples) {
    const out = C.classifySetRevisionFollowup(s);
    assert.ok(out && typeof out === 'object', `a verdict object for ${JSON.stringify(s)}`);
    assert.ok(allowed.has(out.action), `bounded action for ${JSON.stringify(s)}, got ${out.action}`);
  }
  assert.deepEqual([...allowed].sort(), [...C.FOLLOWUP_ACTIONS].sort(),
    'the published enum matches the implementation');
});

test('4b.C2 the scope fragment is read as language only, never as a prescription', () => {
  const C = classifier();
  const two = C.classifySetRevisionFollowup('the last two sets');
  assert.equal(two.action, 'clarify_set_scope');
  assert.equal(two.setScope.count, 2, 'the COUNT is language; the sets it names come from state');
  assert.equal(two.setScope.position, 'last');
  assert.equal(Object.prototype.hasOwnProperty.call(two, 'weight'), false, 'no load is ever inferred');
  assert.equal(Object.prototype.hasOwnProperty.call(two, 'reps'), false, 'no rep target is ever inferred');

  assert.equal(C.classifySetRevisionFollowup('the last 2 sets').setScope.count, 2);
  assert.equal(C.classifySetRevisionFollowup('the last set').setScope.count, 1);
  assert.equal(C.classifySetRevisionFollowup('the remaining sets').setScope.count, null,
    'an unquantified scope carries no count to guess with');
});
