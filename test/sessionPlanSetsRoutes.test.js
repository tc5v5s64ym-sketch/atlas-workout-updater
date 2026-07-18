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
const dryRunEnvelope = { status: 'dry_run', captured: false, dry_run: true, written: 0, skipped: 0, range: null, reason: 'write_disabled' };
const fakeSetsCapture = {
  validateHeader: async () => ({ ok: true }),
  captureAcceptedPlan: async (session, items) => { captureCalls.push({ fn: 'accept', session, items }); return dryRunEnvelope; },
  captureRevision: async (session, revision) => { captureCalls.push({ fn: 'revision', session, revision }); return dryRunEnvelope; },
};
const setsCapturePath = require.resolve('../services/sessionPlanSetsCapture');
require.cache[setsCapturePath] = { id: setsCapturePath, filename: setsCapturePath, loaded: true, exports: fakeSetsCapture };

const registerSessionPlanRoutes = require('../routes/sessionPlans');

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

test.beforeEach(() => { captureCalls.length = 0; });

// ── accept ──────────────────────────────────────────────────────────────────────

test('accept: a valid request forwards session+items and returns the dry-run envelope', async () => {
  const { status, body } = await post('/api/session-plan-sets/accept', { ...BASE, items: [ITEM] });
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.session_plan_sets.dry_run, true);
  assert.equal(body.data.session_plan_sets.captured, false);
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

test('revision: a valid explicit revision forwards and returns the dry-run envelope', async () => {
  const { status, body } = await post('/api/session-plan-sets/revision', { ...BASE, revision: REV });
  assert.equal(status, 200);
  assert.equal(body.data.session_plan_sets.dry_run, true);
  assert.equal(captureCalls[0].fn, 'revision');
});

test('revision: a performed-value source / v1 / missing supersedes are 400 (only explicit future revisions)', async () => {
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: { ...REV, recommendation_source: 'accepted' } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: { ...REV, plan_version: 1 } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: { ...REV, supersedes_key: '' } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: { ...REV, set_index: 0 } })).status, 400);
  assert.equal((await post('/api/session-plan-sets/revision', { ...BASE, revision: null })).status, 400);
  assert.equal(captureCalls.length, 0);
});
