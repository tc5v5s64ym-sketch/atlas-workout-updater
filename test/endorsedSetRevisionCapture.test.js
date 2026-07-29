'use strict';

// #1163 — an EXPLICITLY ENDORSED set-level revision on a movement that STAYS in the plan
// ("keep the movement, the rest of the sets are now X") must be captured as a durable revision.
//
// VERIFIED CURRENT STATE. The whole set-level revision lane already exists and works:
//   client   src/app/sessionLedger.js  buildFutureRevisions / appendRevisions (chain + versions)
//   client   src/app/app.js            emitFutureSetRevision (builds, persists, posts)
//   route    routes/sessionPlans.js    POST /api/session-plan-sets/revision
//   service  services/sessionPlanSetsCapture.js  captureRevision
//   store    services/sessionPlanSetsStore.js    checkpointRevision (idempotency, supersedes)
//
// The gap is the TRIGGER, and only the trigger. `emitFutureSetRevision` has exactly ONE caller —
// src/app/app.js:1682, inside `applySessionSubstitution`. So a set-level revision is captured only
// as a SIDE EFFECT of a movement→movement swap. An endorsement that changes load or reps while
// keeping the movement reaches no capture at all, which is exactly what #1163 reports.
//
// The first test below is the CONTROL and it passes today: the emitter itself is indifferent to
// whether the lift code changed, so a same-movement revision is already built correctly. That is
// the evidence that the fix is a trigger, not new machinery.
//
// The second test is the DEFECT: there is no entry point that reaches the emitter without a
// substitution. It drives the built bundle exactly as test/sessionRevisionWiring.test.js does.
//
// Scope: capture only. This test asserts nothing about SESSION_PLAN_SETS_WRITE_ENABLED, which
// stays 0 — the POST is a dry-run sidecar today and this test only proves it is ATTEMPTED with the
// right payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
const ledger = require('../src/app/sessionLedger.js');
const endorse = require('../src/app/endorsedSetRevision.js');

const ACCEPTED = { accepted: true, session_id: 'S1', session_date: '2026-07-29', plan_version: 'pv_x' };
const PLANNED_NAME = 'Back Squat';
const PLANNED_CODE = 'SQ01';

// Slice the revision emitters out of the built bundle and drive them against the real ledger.
// BOTH are taken in one slice: emitEndorsedSetRevision delegates to emitFutureSetRevision, so
// slicing them apart would leave the delegate undefined.
const SLICE_START = 'function emitFutureSetRevision(';
const SLICE_END = 'function implicitPlanItemId(';

function harness() {
  const start = appSrc.indexOf(SLICE_START);
  assert.notEqual(start, -1, 'emitFutureSetRevision must exist in the built bundle');
  const end = appSrc.indexOf(SLICE_END, start);
  const slice = appSrc.slice(start, end === -1 ? undefined : end);
  const state = { plan: null, log: [], revisions: [], posts: [], snapshots: 0, outcomes: [] };
  const factory = new Function(
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'isExplicitEndorsement', 'state', `
    function getActivePlannedSession(){ return state.plan; }
    function getSessionLog(){ return state.log; }
    function getSessionRevisions(){ return state.revisions; }
    function setSessionRevisions(v){ state.revisions = Array.isArray(v) ? v : []; }
    function saveSessionSnapshot(){ state.snapshots++; }
    function emitPlanItemOutcome(o){ state.outcomes.push(o); }
    function renderActiveSessionBanner(){}
    function api(url, opts){ state.posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({}); }
    ${slice}
    return {
      emitFutureSetRevision,
      emitEndorsedSetRevision: typeof emitEndorsedSetRevision === 'function' ? emitEndorsedSetRevision : null,
      state,
    };
  `);
  return factory(
    ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount,
    endorse.isExplicitEndorsement, state,
  );
}

function endorsedHarness() {
  const h = harness();
  assert.ok(h.emitEndorsedSetRevision,
    'an endorsed set-level revision needs an entry point that does not require a substitute movement');
  h.state.plan = { ...ACCEPTED };
  return h;
}

const ENDORSED = {
  plan_item_id: 'pi-1',
  planned_lift_code: PLANNED_CODE,
  prescribed_name: PLANNED_NAME,
  prescription: { weight: 185, reps: 5, rir: 2 },
  accepted_set_count: 3,
};

// ── CONTROL: the machinery already handles a same-movement revision ────────────

test('#1163 the emitter already builds a revision when the movement is UNCHANGED', () => {
  // Passes today. `emitFutureSetRevision` never compares the new lift code to the planned one, so
  // the revision lane is already correct for a load/rep-only change. Only the caller is missing.
  const h = harness();
  h.state.plan = { ...ACCEPTED };
  h.state.log = [];

  h.emitFutureSetRevision('pi-1', PLANNED_CODE, { weight: 185, reps: 5, rir: 2 }, PLANNED_NAME, 3);

  assert.equal(h.state.revisions.length, 3, 'one revision per future set');
  assert.equal(h.state.posts.length, 3, 'each revision is posted to the checkpoint route');
  assert.equal(h.state.posts[0].url, '/api/session-plan-sets/revision');
  assert.equal(h.state.posts[0].body.revision.planned_lift_code, PLANNED_CODE,
    'the movement is unchanged — the revision carries the SAME lift code');
  assert.equal(h.state.posts[0].body.revision.target_weight, 185, 'the endorsed load is carried');
  assert.ok(h.state.snapshots > 0, 'revisions are persisted for reload');
});

// ── DEFECT: nothing reaches that emitter without a substitution ────────────────

test('#1163 an endorsed set-level revision with NO movement change is captured', () => {
  // THE DEFECT. `emitFutureSetRevision` has exactly one caller — inside applySessionSubstitution —
  // so an endorsement that keeps the movement and changes only the prescription reaches no
  // capture. A dedicated entry point must exist that emits the revision WITHOUT claiming a
  // movement substitution.
  const h = endorsedHarness();
  h.state.log = [];

  // "Keep back squat, but drop the rest of the sets to 185x5."
  h.emitEndorsedSetRevision({ ...ENDORSED });

  assert.equal(h.state.revisions.length, 3, 'one revision per remaining set');
  assert.equal(h.state.posts.length, 3, 'each revision reaches the checkpoint route');
  assert.equal(h.state.posts[0].body.revision.planned_lift_code, PLANNED_CODE);
  assert.equal(h.state.posts[0].body.revision.target_weight, 185);

  // The movement did NOT change. Routing this through the substitution lane would record a
  // `substituted` item_outcome for a movement that was never swapped, corrupting the
  // movement-level planned-vs-completed record that #952 closed on.
  assert.equal(h.state.outcomes.length, 0, 'a load change must never emit a substituted outcome');
});

// ── the rest of the contract ──────────────────────────────────────────────────

test('#1163 completed sets are preserved — only FUTURE sets are revised', () => {
  const h = endorsedHarness();
  // Two of the three sets are already logged, so only the third is revisable.
  h.state.log = [{ exercise: PLANNED_NAME }, { exercise: PLANNED_NAME }];

  h.emitEndorsedSetRevision({ ...ENDORSED });

  assert.equal(h.state.revisions.length, 1, 'only the one remaining set is revised');
  assert.equal(h.state.revisions[0].set_index, 3, 'and it is the THIRD set, not a performed one');
  for (const r of h.state.revisions) {
    assert.ok(r.set_index > 2, 'no performed set index is ever revised');
  }
});

test('#1163 future sets carry the new prescription', () => {
  const h = endorsedHarness();
  h.state.log = [];

  h.emitEndorsedSetRevision({ ...ENDORSED });

  for (const r of h.state.revisions) {
    assert.equal(r.target_weight, 185);
    assert.equal(r.target_reps, 5);
    assert.equal(r.target_rir, 2);
    assert.equal(r.planned_lift_code, PLANNED_CODE, 'the movement never changes');
  }
});

test('#1163 the revision survives reload (it is persisted, not just posted)', () => {
  const h = endorsedHarness();
  h.state.log = [];

  h.emitEndorsedSetRevision({ ...ENDORSED });

  assert.ok(h.state.snapshots > 0, 'a snapshot is written so the revision survives a reload');
  // Simulate the reload: the restored revisions are the client-side durable record, and they
  // still describe the endorsed prescription. This is the implementation proof for #1163 while
  // SESSION_PLAN_SETS_WRITE_ENABLED is 0 — the server row is the separate final proof.
  const restored = h.state.revisions.map((r) => ({ ...r }));
  assert.equal(restored.length, 3);
  assert.equal(restored[0].target_weight, 185);
  assert.equal(restored[0].planned_lift_code, PLANNED_CODE);
});

test('#1163 repeated processing of one endorsement does not duplicate the revision chain', () => {
  const h = endorsedHarness();
  h.state.log = [];

  h.emitEndorsedSetRevision({ ...ENDORSED });
  const afterFirst = h.state.revisions.length;
  h.emitEndorsedSetRevision({ ...ENDORSED });   // same endorsement processed twice

  assert.equal(afterFirst, 3);
  assert.equal(h.state.revisions.length, 3, 'the append-only chain dedupes an identical revision');
});

test('#1163 a decline, a question, or a bare acknowledgement captures nothing', () => {
  for (const words of [
    'no', 'nah', 'not yet', "don't", 'skip it', 'leave it',      // decline
    'what would that do?', 'should I?', 'how much?',              // question
    'ok', 'alright', 'sure', 'hmm', 'maybe', 'i guess', '',       // ambiguous / bare
    'no, do it',                                                  // contradictory → refuse
  ]) {
    const h = endorsedHarness();
    h.state.log = [];

    const captured = h.emitEndorsedSetRevision({ ...ENDORSED, endorsement: words });

    assert.equal(captured, false, `"${words}" must not endorse a plan revision`);
    assert.equal(h.state.revisions.length, 0, `"${words}" must capture no revision`);
    assert.equal(h.state.posts.length, 0, `"${words}" must post nothing`);
  }
});

test('#1163 an unambiguous endorsement in the athlete\'s words does capture', () => {
  for (const words of ['yes', 'yeah do it', 'yep', 'do it', "let's do it", 'go ahead', 'sounds good']) {
    const h = endorsedHarness();
    h.state.log = [];

    const captured = h.emitEndorsedSetRevision({ ...ENDORSED, endorsement: words });

    assert.equal(captured, true, `"${words}" is an explicit endorsement`);
    assert.equal(h.state.revisions.length, 3, `"${words}" captures the revision`);
    assert.equal(h.state.outcomes.length, 0, 'still never a substituted outcome');
  }
});

test('#1163 an incomplete request captures nothing', () => {
  const h = endorsedHarness();
  h.state.log = [];
  assert.equal(h.emitEndorsedSetRevision({ ...ENDORSED, plan_item_id: '' }), false, 'no plan identity');
  assert.equal(h.emitEndorsedSetRevision({ ...ENDORSED, planned_lift_code: '' }), false, 'no lift code');
  assert.equal(h.emitEndorsedSetRevision({ ...ENDORSED, prescribed_name: '' }), false, 'no movement name');
  assert.equal(h.emitEndorsedSetRevision(null), false, 'no request at all');
  assert.equal(h.state.revisions.length, 0);
  assert.equal(h.state.posts.length, 0);
});

test('#1163 the existing substitution path is unchanged', () => {
  // The substitution lane still reaches the SAME emitter and still produces its revisions with
  // the SUBSTITUTE's lift code. This pins that the new entry point did not alter the old one.
  const h = harness();
  h.state.plan = { ...ACCEPTED };
  h.state.log = [];

  h.emitFutureSetRevision('pi-1', 'FSQ01', { weight: 135, reps: 8, rir: 2 }, PLANNED_NAME, 3);

  assert.equal(h.state.revisions.length, 3);
  assert.equal(h.state.posts[0].body.revision.planned_lift_code, 'FSQ01',
    'a real substitution still records the SUBSTITUTE code');
  assert.equal(h.state.posts[0].body.revision.target_weight, 135);
});

test('#1163 no revision is captured without an accepted plan', () => {
  const h = endorsedHarness();
  h.state.plan = { ...ACCEPTED, accepted: false };
  h.state.log = [];

  h.emitEndorsedSetRevision({ ...ENDORSED });

  assert.equal(h.state.revisions.length, 0, 'an unaccepted plan carries no ledger identity');
  assert.equal(h.state.posts.length, 0);
});

// ── Codex P2 regressions (this PR) ────────────────────────────────────────────

test('#1163 an affirmative token inside a NON-consent sentence is not an endorsement', () => {
  // "I can't say yes yet" contains `yes` while explicitly withholding it. An anywhere-in-message
  // match returned true and would have rewritten every remaining set on a refusal.
  for (const words of [
    'i cant say yes yet',
    "i can't say yes yet",
    'maybe yes later',
    'i said yes to the last one but not this',
    'not sure i can do it',
    'id rather do it next week',
  ]) {
    const h = endorsedHarness();
    h.state.log = [];
    const captured = h.emitEndorsedSetRevision({ ...ENDORSED, endorsement: words });
    assert.equal(captured, false, `"${words}" withholds consent`);
    assert.equal(h.state.revisions.length, 0, `"${words}" must capture nothing`);
    assert.equal(h.state.posts.length, 0);
  }
});

test('#1163 a lead-in before a real affirmative still endorses', () => {
  // The tightening must not break the ordinary spoken forms.
  for (const words of ['ok yeah do it', 'alright yes', 'well go ahead', 'okay do it']) {
    const h = endorsedHarness();
    h.state.log = [];
    assert.equal(h.emitEndorsedSetRevision({ ...ENDORSED, endorsement: words }), true, `"${words}"`);
    assert.equal(h.state.revisions.length, 3, `"${words}" captures the revision`);
  }
});

test('#1163 the entry point reports success ONLY when a revision was emitted', () => {
  // An unaccepted plan emits nothing. Reporting `true` would tell the athlete their plan changed
  // when session truth never moved.
  const unaccepted = endorsedHarness();
  unaccepted.state.plan = { ...ACCEPTED, accepted: false };
  unaccepted.state.log = [];
  assert.equal(unaccepted.emitEndorsedSetRevision({ ...ENDORSED }), false, 'no accepted plan → not captured');
  assert.equal(unaccepted.state.revisions.length, 0);

  // Every set already performed → no future set to revise → nothing emitted.
  const done = endorsedHarness();
  done.state.log = [{ exercise: PLANNED_NAME }, { exercise: PLANNED_NAME }, { exercise: PLANNED_NAME }];
  assert.equal(done.emitEndorsedSetRevision({ ...ENDORSED }), false, 'no remaining sets → not captured');
  assert.equal(done.state.revisions.length, 0);

  // An incomplete prescription can build no revision.
  const bare = endorsedHarness();
  bare.state.log = [];
  assert.equal(bare.emitEndorsedSetRevision({ ...ENDORSED, prescription: {} }), false, 'no target → not captured');
  assert.equal(bare.state.revisions.length, 0);

  // …and the positive control: a genuine capture still reports true.
  const good = endorsedHarness();
  good.state.log = [];
  assert.equal(good.emitEndorsedSetRevision({ ...ENDORSED }), true);
  assert.equal(good.state.revisions.length, 3);
});

test('#1163 the substitution path still reports its own emit outcome', () => {
  const h = harness();
  h.state.plan = { ...ACCEPTED };
  h.state.log = [];
  assert.equal(h.emitFutureSetRevision('pi-1', 'FSQ01', { weight: 135, reps: 8, rir: 2 }, PLANNED_NAME, 3), true);
  h.state.plan = { ...ACCEPTED, accepted: false };
  assert.equal(h.emitFutureSetRevision('pi-1', 'FSQ01', { weight: 135, reps: 8, rir: 2 }, PLANNED_NAME, 3), false);
});

// ── the public surface is stricter than the internal function ─────────────────

test('#1163 the public global refuses a request that carries no endorsement at all', () => {
  // The global is reachable by any script on the page and mutates plan state, so it demands the
  // athlete's own words. The internal function keeps the optional-endorsement contract for the
  // successor's Approve affordance, where consent comes from the tap.
  const at = appSrc.indexOf('window.atlasEndorseSetRevision');
  assert.notEqual(at, -1, 'the global entry point must exist in the built bundle');
  const decl = appSrc.slice(at, at + 400);
  assert.match(decl, /hasOwnProperty\.call\(r, 'endorsement'\)/,
    'the global must require an endorsement field before it will act');
  assert.match(decl, /return false/, 'and refuse without one');
});
