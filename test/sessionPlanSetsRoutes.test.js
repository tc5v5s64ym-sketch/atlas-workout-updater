'use strict';

// F10B — Session_Plan_Sets routes: request validation + envelope passthrough. The
// ledger capture service is stubbed (require.cache) so these tests exercise the HTTP
// surface deterministically without Sheets. Pins: required-field + opaque-ID-shape +
// target/revision validation return 400; a valid request forwards the parsed
// session/items to the capture layer and returns its proof envelope under
// data.session_plan_sets.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const captureCalls = [];
let captureFailure = false;
const liveEnvelope = () => captureFailure
  ? { status: 'error', captured: false, dry_run: false, written: 0, skipped: 0, range: null, reason: 'authority unavailable' }
  : { status: 'written', captured: true, dry_run: false, written: 1, skipped: 0, range: null, reason: null };
const fakeSetsCapture = {
  validateHeader: async () => ({ ok: true }),
  captureAcceptedPlan: async (session, items) => { captureCalls.push({ fn: 'accept', session, items }); return liveEnvelope(); },
  captureRevision: async (session, revision) => { captureCalls.push({ fn: 'revision', session, revision }); return liveEnvelope(); },
  captureImplicit: async (session, items) => { captureCalls.push({ fn: 'implicit', session, items }); return liveEnvelope(); },
};
const setsCapturePath = require.resolve('../services/sessionPlanSetsCapture');
require.cache[setsCapturePath] = { id: setsCapturePath, filename: setsCapturePath, loaded: true, exports: fakeSetsCapture };

// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
// blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
// The workout authority is Supabase since the S4 cutover: the implicit derivation
// reads its history from there, not from the injected sheets reader.
const { installWorkoutAuthorityStub, resetWorkoutAuthorityStub, workoutAuthorityStore } = require('./helpers/stubWorkoutAuthority');
installWorkoutAuthorityStub();
const registerSessionPlanRoutes = require('../routes/sessionPlans');

// The /implicit route derives server-side from the workout authority — Supabase since
// the S4 cutover, so there is no injected sheets reader left to stub. The derivation
// (deriveImplicitRecommendation) runs for REAL; only the history and the capture layer
// are doubled. Each test installs its logged-set fixture in the same `Log_Cleaned`
// column order the authority returns.
function setImplicitHistory(rows) {
  const store = workoutAuthorityStore();
  store.loggedSets = rows.map((r) => (Array.isArray(r) ? r.slice() : { ...r }));
  store.loggedSetWriteIds = rows.map(() => null);
}
let baseUrl, server;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(registerSessionPlanRoutes());
  await new Promise(resolve => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(() => { if (server) server.close(); });

async function post(path, body) {
  const r = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const PV = 'pv_11111111-1111-4111-8111-111111111111';
const PI = 'pi_aaaaaaaa-1111-4111-8111-111111111111';
const BASE = { session_id: 'S1', session_date: '2026-07-16', plan_version: PV };
const ITEM = { plan_item_id: PI, planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2, confidence: 'reliable' };
const REV = { plan_item_id: PI, planned_lift_code: 'DIP01', set_index: 2, plan_version: 2, target_set_count: 3, target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision', supersedes_key: 'abcdef0123456789' };

test.beforeEach(() => { captureCalls.length = 0; captureFailure = false; resetWorkoutAuthorityStub(); });

// ── accept ──────────────────────────────────────────────────────────────────────

test('accept: a valid request forwards session+items and returns durable proof', async () => {
  const { status, body } = await post('/api/session-plan-sets/accept', { ...BASE, items: [ITEM] });
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.session_plan_sets.dry_run, false);
  assert.equal(body.data.session_plan_sets.captured, true);
  assert.equal(captureCalls.length, 1);
  assert.deepEqual(captureCalls[0].items, [ITEM]);
});

test('accept: missing/blank plan_version and bad ID shapes are 400', async () => {
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, plan_version: '', items: [ITEM] })).status, 400);
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, plan_version: 'nope', items: [ITEM] })).status, 400);
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, items: [] })).status, 400);
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, items: [{ ...ITEM, plan_item_id: 'x' }] })).status, 400);
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, items: [{ ...ITEM, planned_lift_code: 'has space' }] })).status, 400);
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, items: [{ ...ITEM, target_set_count: 0 }] })).status, 400);
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, items: [{ ...ITEM, confidence: 'maybe' }] })).status, 400);
  assert.equal(captureCalls.length, 0, 'no forward on a rejected request');
});

// ── revision ──────────────────────────────────────────────────────────────────

test('revision: a valid explicit revision forwards and returns durable proof', async () => {
  const { status, body } = await post('/api/session-plan-sets/revision', { ...BASE, revision: REV });
  assert.equal(status, 200);
  assert.equal(body.data.session_plan_sets.captured, true);
  assert.equal(captureCalls[0].fn, 'revision');
});

test('authoritative accept and revision failures return 503', async () => {
  captureFailure = true;
  assert.equal((await post('/api/session-plan-sets/accept', { ...BASE, items: [ITEM] })).status, 503);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: REV })).status, 503);
});

test('revision: a performed-value source / v1 / bad set_index are 400 (only explicit future revisions)', async () => {
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: { ...REV, recommendation_source: 'accepted' } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: { ...REV, plan_version: 1 } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: { ...REV, set_index: 0 } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: null })).status, 400);
  assert.equal(captureCalls.length, 0);
});

test('revision: supersedes_key is OPTIONAL — the server derives it from the prior version', async () => {
  const { supersedes_key, ...noKey } = REV; // eslint-disable-line no-unused-vars
  const { status } = await post('/api/session-plan-sets/revision', { ...BASE, revision: noKey });
  assert.equal(status, 200, 'a revision without supersedes_key is accepted (derived server-side)');
  assert.equal(captureCalls[0].fn, 'revision');
});

// ── implicit (F10C) ─────────────────────────────────────────────────────────────

// A prior-session working set for lift CROW (object row — normalizeLogRow reads it).
const priorRow = (over = {}) => ({ date_clean: '2026-07-01', session_id: 'S_prior', exercise: 'Cable Row', canonical_exercise: 'Cable Row', muscle_group: 'back', lift_code: 'CROW', set_number: 1, weight: 100, reps: 8, rir: 2, notes: '', volume_calc: 800, ...over });
const IMPL_ITEM = { plan_item_id: PI, planned_lift_code: 'CROW', exercise_name: 'Cable Row' };

test('implicit: a reliable derivation from PRIOR history checkpoints one implicit item', async () => {
  setImplicitHistory([priorRow(), priorRow({ set_number: 2 })]);
  const { status, body } = await post('/api/session-plan-sets/implicit', { ...BASE, item: IMPL_ITEM });
  assert.equal(status, 200);
  assert.equal(body.data.derivation.confidence, 'reliable');
  assert.equal(body.data.derivation.target_reps, 8, 'exact prior reps');
  assert.equal(body.data.derivation.target_rir, 2, 'exact prior rir');
  assert.equal(body.data.derivation.target_set_count, 1);
  assert.equal(captureCalls[0].fn, 'implicit');
  assert.equal(captureCalls[0].items[0].plan_item_id, PI);
  assert.equal(captureCalls[0].items[0].confidence, 'reliable');
});

test('implicit: the CURRENT session is excluded — only-current-session history → no_reliable_target', async () => {
  setImplicitHistory([priorRow({ session_id: 'S1' })]); // same session as BASE → excluded (leakage guarantee)
  const { status, body } = await post('/api/session-plan-sets/implicit', { ...BASE, item: IMPL_ITEM });
  assert.equal(status, 200);
  assert.equal(body.data.derivation.confidence, 'no_reliable_target');
  assert.equal(captureCalls[0].items[0].confidence, 'no_reliable_target', 'forwarded unreliable → the builder skips it (no row)');
});

test('implicit: bad session / missing item / bad ID shapes are 400', async () => {
  setImplicitHistory([priorRow()]);
  assert.equal((await post('/api/session-plan-sets/implicit', { ...BASE, plan_version: 'nope', item: IMPL_ITEM })).status, 400);
  assert.equal((await post('/api/session-plan-sets/implicit', { ...BASE })).status, 400, 'no item');
  assert.equal((await post('/api/session-plan-sets/implicit', { ...BASE, item: { ...IMPL_ITEM, plan_item_id: 'x' } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/implicit', { ...BASE, item: { ...IMPL_ITEM, planned_lift_code: 'has space' } })).status, 400);
  assert.equal(captureCalls.length, 0, 'no forward on a rejected request');
});
