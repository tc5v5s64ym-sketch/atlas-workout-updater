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

const ACCEPTED = { accepted: true, session_id: 'S1', session_date: '2026-07-29', plan_version: 'pv_x' };
const PLANNED_NAME = 'Back Squat';
const PLANNED_CODE = 'SQ01';

// Slice one top-level function out of the built bundle and drive it against the real ledger.
function harnessFor(fnName, endMarker) {
  const start = appSrc.indexOf(`function ${fnName}(`);
  if (start === -1) return null;
  const end = appSrc.indexOf(endMarker, start);
  const slice = appSrc.slice(start, end === -1 ? undefined : end);
  const state = { plan: null, log: [], revisions: [], posts: [], snapshots: 0, outcomes: [] };
  const factory = new Function(
    'buildFutureRevisions', 'appendRevisions', 'ledgerPerformedSetCount', 'state', `
    function getActivePlannedSession(){ return state.plan; }
    function getSessionLog(){ return state.log; }
    function getSessionRevisions(){ return state.revisions; }
    function setSessionRevisions(v){ state.revisions = Array.isArray(v) ? v : []; }
    function saveSessionSnapshot(){ state.snapshots++; }
    function emitPlanItemOutcome(o){ state.outcomes.push(o); }
    function renderActiveSessionBanner(){}
    function api(url, opts){ state.posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({}); }
    ${slice}
    return { fn: ${fnName}, state };
  `);
  return factory(ledger.buildFutureRevisions, ledger.appendRevisions, ledger.performedSetCount, state);
}

// ── CONTROL: the machinery already handles a same-movement revision ────────────

test('#1163 the emitter already builds a revision when the movement is UNCHANGED', () => {
  // Passes today. `emitFutureSetRevision` never compares the new lift code to the planned one, so
  // the revision lane is already correct for a load/rep-only change. Only the caller is missing.
  const h = harnessFor('emitFutureSetRevision', 'function implicitPlanItemId(');
  assert.ok(h, 'emitFutureSetRevision must exist in the built bundle');
  h.state.plan = { ...ACCEPTED };
  h.state.log = [];

  h.fn('pi-1', PLANNED_CODE, { weight: 185, reps: 5, rir: 2 }, PLANNED_NAME, 3);

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
  const h = harnessFor('emitEndorsedSetRevision', 'function implicitPlanItemId(');
  assert.ok(h, 'an endorsed set-level revision needs an entry point that does not require a substitute movement');

  h.state.plan = { ...ACCEPTED };
  h.state.log = [];

  // "Keep back squat, but drop the rest of the sets to 185x5."
  h.fn({
    plan_item_id: 'pi-1',
    planned_lift_code: PLANNED_CODE,
    prescribed_name: PLANNED_NAME,
    prescription: { weight: 185, reps: 5, rir: 2 },
    accepted_set_count: 3,
  });

  assert.equal(h.state.revisions.length, 3, 'one revision per remaining set');
  assert.equal(h.state.posts.length, 3, 'each revision reaches the checkpoint route');
  assert.equal(h.state.posts[0].body.revision.planned_lift_code, PLANNED_CODE);
  assert.equal(h.state.posts[0].body.revision.target_weight, 185);

  // The movement did NOT change. Routing this through the substitution lane would record a
  // `substituted` item_outcome for a movement that was never swapped, corrupting the
  // movement-level planned-vs-completed record that #952 closed on.
  assert.equal(h.state.outcomes.length, 0, 'a load change must never emit a substituted outcome');
});
