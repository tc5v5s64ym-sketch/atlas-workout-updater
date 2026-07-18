'use strict';

// F10C slice 2 — the app.js wiring that turns an OFF-PLAN (unannounced) logged exercise
// into a durable implicit-recommendation checkpoint (derive server-side → store a
// reliable result → snapshot for reload). Slices the real emitImplicitRecommendation +
// isOffPlanLoggedExercise from the built bundle and drives them with the REAL
// planSlotStatuses (so off-plan detection can't diverge from slot attribution) + a store
// shim + an api stub. Proves: off-plan fires (a planned lift does not), only a reliable
// derivation is stored, it's idempotent per lift, and it fails closed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

let PS;
test.before(async () => { PS = await import('../src/app/planSlotStatuses.js'); });

function loadHarness(derivation) {
  const slice = appSrc.slice(
    appSrc.indexOf('function implicitPlanItemId('),
    appSrc.indexOf('function reorderPlannedExercise('),
  );
  assert.ok(slice.includes('function emitImplicitRecommendation('), 'slice must contain emitImplicitRecommendation');
  const state = { plan: null, implicit: [], posts: [], snapshots: 0, derivation };
  const factory = new Function('planSlotStatuses', 'state', `
    function getActivePlannedSession(){ return state.plan; }
    function getSessionImplicitRecs(){ return state.implicit; }
    function setSessionImplicitRecs(v){ state.implicit = Array.isArray(v) ? v : []; }
    function saveSessionSnapshot(){ state.snapshots++; }
    function api(url, opts){ state.posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ data: { derivation: state.derivation } }); }
    ${slice}
    return { emitImplicitRecommendation, isOffPlanLoggedExercise, implicitPlanItemId, state };
  `);
  return factory(PS.planSlotStatuses, state);
}

const ACCEPTED = {
  accepted: true, session_id: 'S1', session_date: '2026-07-16', plan_version: 'pv_x',
  exercises: [{ canonicalName: 'Bench Press', liftCode: 'BENCH', plan_item_id: 'pi_1' }],
};
const RELIABLE = { confidence: 'reliable', target_set_count: 1, target_weight: 30, target_reps: 12, target_rir: 1, planned_lift_code: 'HCURL' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('off-plan detection reuses the F10 selector: a planned lift is on-plan, an unlisted lift is off-plan', () => {
  const h = loadHarness(RELIABLE);
  assert.equal(h.isOffPlanLoggedExercise(ACCEPTED, 'Bench Press', 'BENCH'), false, 'the planned lift is on-plan');
  assert.equal(h.isOffPlanLoggedExercise(ACCEPTED, 'Hammer Curl', 'HCURL'), true, 'an unlisted lift is off-plan');
});

test('an off-plan log posts to /implicit and stores the RELIABLE derivation for reload', async () => {
  const h = loadHarness(RELIABLE);
  h.state.plan = ACCEPTED;
  h.emitImplicitRecommendation('Hammer Curl', 'HCURL');
  await flush();
  assert.equal(h.state.posts.length, 1);
  assert.equal(h.state.posts[0].url, '/api/session-plan-sets/implicit');
  assert.equal(h.state.posts[0].body.item.planned_lift_code, 'HCURL');
  assert.equal(h.state.posts[0].body.item.plan_item_id, 'pi_impl_S1_HCURL', 'deterministic id per (session, lift)');
  assert.equal(h.state.posts[0].body.plan_version, 'pv_x', 'the pv_ token rides on the session envelope');
  assert.equal(h.state.implicit.length, 1, 'the reliable rec is stored');
  assert.equal(h.state.implicit[0].target_reps, 12);
  assert.ok(h.state.snapshots >= 1, 'persisted for reload');
});

test('a no_reliable_target derivation stores NOTHING (no row — §4A rule 5)', async () => {
  const h = loadHarness({ confidence: 'no_reliable_target', target_set_count: 1, reason: 'no_prior_history' });
  h.state.plan = ACCEPTED;
  h.emitImplicitRecommendation('Hammer Curl', 'HCURL');
  await flush();
  assert.equal(h.state.posts.length, 1, 'still derived server-side');
  assert.equal(h.state.implicit.length, 0, 'but nothing is stored (no reliable target)');
  assert.equal(h.state.snapshots, 0, 'and no snapshot write for an empty result');
});

test('idempotent per lift: a second off-plan log of the same lift neither re-posts nor duplicates', async () => {
  const h = loadHarness(RELIABLE);
  h.state.plan = ACCEPTED;
  h.emitImplicitRecommendation('Hammer Curl', 'HCURL');
  await flush();
  h.emitImplicitRecommendation('Hammer Curl', 'HCURL');
  await flush();
  assert.equal(h.state.implicit.length, 1, 'one implicit rec per lift/session');
  assert.equal(h.state.posts.length, 1, 'the second log is deduped before posting');
});

test('fails closed: an unaccepted plan or a missing lift code → no post', async () => {
  const h = loadHarness(RELIABLE);
  h.state.plan = { accepted: false, session_id: 'S1', exercises: [] };
  h.emitImplicitRecommendation('Hammer Curl', 'HCURL');
  h.state.plan = ACCEPTED;
  h.emitImplicitRecommendation('Hammer Curl', '');
  await flush();
  assert.equal(h.state.posts.length, 0);
});
