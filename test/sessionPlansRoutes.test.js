'use strict';

// Session_Plans routes (PR-E) — request validation + envelope passthrough. The
// capture service is stubbed (require.cache) so these tests exercise the HTTP
// surface deterministically without Sheets: required-field + opaque-ID-shape +
// vocabulary validation return 400; a valid request forwards the parsed session /
// items / outcome / closeout to the capture layer and returns its proof envelope
// under data.session_plans. (Auth is global app-level middleware in index.js, not
// in this router; the manifest test in api-smoke pins authRequired:true.)

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const captureCalls = [];
let captureFailure = false;
const envelope = (session) => ({ status: 'written', captured: true, written: 1, skipped: 0, plan_version: session.plan_version, reason: null });
const captureResult = (session) => captureFailure
  ? { status: 'error', captured: false, written: 0, skipped: 0, plan_version: session.plan_version, reason: 'authority unavailable' }
  : envelope(session);
const fakeCapture = {
  isEnabled: () => true,
  validateHeader: async () => ({ ok: true }),
  captureAccept: async (session, items) => { captureCalls.push({ fn: 'accept', session, items }); return { ...captureResult(session), written: captureFailure ? 0 : items.length }; },
  captureOutcome: async (session, item) => { captureCalls.push({ fn: 'outcome', session, item }); return captureResult(session); },
  captureCloseout: async (session, closeout) => { captureCalls.push({ fn: 'closeout', session, closeout }); return captureResult(session); },
};
const capturePath = require.resolve('../services/sessionPlanCapture');
require.cache[capturePath] = { id: capturePath, filename: capturePath, loaded: true, exports: fakeCapture };

// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
// blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`
// no longer controls the logged sets, the Effort row, the plan ledgers or the write
// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so
// no test's data changes — only where the route reads it from.
require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({ sheetsFallback: true });
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
const BASE = { session_id: 'S1', session_date: '2026-07-10', plan_version: PV };
const ACCEPT_ITEM = { plan_item_id: PI, planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' };

test.beforeEach(() => { captureCalls.length = 0; captureFailure = false; });

// ── accept ────────────────────────────────────────────────────────────────────

test('accept: a valid request forwards session+items and returns the envelope', async () => {
  const { status, body } = await post('/api/session-plans/accept', { ...BASE, items: [ACCEPT_ITEM] });
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.data.session_plans.status, 'written');
  assert.equal(body.data.session_plans.written, 1);
  assert.equal(captureCalls.length, 1);
  assert.equal(captureCalls[0].fn, 'accept');
  assert.equal(captureCalls[0].session.plan_version, PV);
  assert.equal(captureCalls[0].items[0].plan_item_id, PI);
});

test('authoritative capture failure is a 503, never a false acceptance', async () => {
  captureFailure = true;
  const accept = await post('/api/session-plans/accept', { ...BASE, items: [ACCEPT_ITEM] });
  assert.equal(accept.status, 503);
  assert.equal(accept.body.status, 'error');
  const outcome = await post('/api/session-plans/outcome', { ...BASE, item: { plan_item_id: PI, planned_lift_code: 'BEN01', outcome: 'completed' } });
  assert.equal(outcome.status, 503);
  const closeout = await post('/api/session-plans/closeout', { ...BASE, closeout_status: 'finalized' });
  assert.equal(closeout.status, 503);
});

test('accept: missing plan_version → 400, capture not called', async () => {
  const { status } = await post('/api/session-plans/accept', { ...BASE, plan_version: '', items: [ACCEPT_ITEM] });
  assert.equal(status, 400);
  assert.equal(captureCalls.length, 0);
});

test('accept: missing session_id means the SERVER must allocate — with no durable-record access it fails closed (503), never mints', async () => {
  // This router was registered with NO deps, so the allocation path has no
  // getSheetRows to prove slot availability with. The allocator-equipped behavior
  // (allocate over Effort ∪ Log_Cleaned ∪ Session_Plans, retry reuse, fail-closed
  // per source) is covered in test/acceptedPlanIdentityAllocation.test.js.
  const { status } = await post('/api/session-plans/accept', { ...BASE, session_id: '', items: [ACCEPT_ITEM] });
  assert.equal(status, 503);
  assert.equal(captureCalls.length, 0, 'no acceptance may be written under an unprovable identity');
});

test('accept: the response echoes the session identity the acceptance was written under', async () => {
  const { status, body } = await post('/api/session-plans/accept', { ...BASE, items: [ACCEPT_ITEM] });
  assert.equal(status, 200);
  assert.equal(body.data.session_id, BASE.session_id);
});

test('accept: plan_version without pv_ prefix → 400', async () => {
  const { status } = await post('/api/session-plans/accept', { ...BASE, plan_version: 'a1b2c3', items: [ACCEPT_ITEM] });
  assert.equal(status, 400);
  assert.equal(captureCalls.length, 0);
});

test('accept: empty / missing items → 400', async () => {
  assert.equal((await post('/api/session-plans/accept', { ...BASE, items: [] })).status, 400);
  assert.equal((await post('/api/session-plans/accept', { ...BASE })).status, 400);
});

test('accept: an item without a pi_ plan_item_id or without planned_lift_code → 400', async () => {
  assert.equal((await post('/api/session-plans/accept', { ...BASE, items: [{ ...ACCEPT_ITEM, plan_item_id: 'x' }] })).status, 400);
  assert.equal((await post('/api/session-plans/accept', { ...BASE, items: [{ ...ACCEPT_ITEM, planned_lift_code: '' }] })).status, 400);
  assert.equal(captureCalls.length, 0);
});

test('accept: a whitespaced planned_lift_code → 400 (matches the builder canonical-code rule, not a 200 error)', async () => {
  const { status } = await post('/api/session-plans/accept', { ...BASE, items: [{ ...ACCEPT_ITEM, planned_lift_code: 'BEN 01' }] });
  assert.equal(status, 400);
  assert.equal(captureCalls.length, 0);
});

// ── outcome ─────────────────────────────────────────────────────────────────--

test('outcome: a valid completed request forwards the item and returns the envelope', async () => {
  const { status, body } = await post('/api/session-plans/outcome', { ...BASE, item: { plan_item_id: PI, planned_lift_code: 'BEN01', outcome: 'completed' } });
  assert.equal(status, 200);
  assert.equal(body.data.session_plans.status, 'written');
  assert.equal(captureCalls[0].fn, 'outcome');
  assert.equal(captureCalls[0].item.outcome, 'completed');
});

test('outcome: an unknown outcome → 400', async () => {
  const { status } = await post('/api/session-plans/outcome', { ...BASE, item: { plan_item_id: PI, planned_lift_code: 'BEN01', outcome: 'done' } });
  assert.equal(status, 400);
  assert.equal(captureCalls.length, 0);
});

test('outcome: substituted without performed_lift_code → 400', async () => {
  const { status } = await post('/api/session-plans/outcome', { ...BASE, item: { plan_item_id: PI, planned_lift_code: 'BEN01', outcome: 'substituted' } });
  assert.equal(status, 400);
});

test('outcome: a whitespaced planned_/performed_lift_code → 400', async () => {
  assert.equal((await post('/api/session-plans/outcome', { ...BASE, item: { plan_item_id: PI, planned_lift_code: 'BEN 01', outcome: 'completed' } })).status, 400);
  assert.equal((await post('/api/session-plans/outcome', { ...BASE, item: { plan_item_id: PI, planned_lift_code: 'BEN01', outcome: 'substituted', performed_lift_code: 'DB P01' } })).status, 400);
  assert.equal(captureCalls.length, 0);
});

test('outcome: missing item → 400', async () => {
  assert.equal((await post('/api/session-plans/outcome', { ...BASE })).status, 400);
});

// ── closeout ────────────────────────────────────────────────────────────────--

test('closeout: finalized / abandoned forward and return the envelope', async () => {
  for (const cs of ['finalized', 'abandoned']) {
    const { status, body } = await post('/api/session-plans/closeout', { ...BASE, closeout_status: cs });
    assert.equal(status, 200);
    assert.equal(body.data.session_plans.status, 'written');
    assert.equal(captureCalls.at(-1).closeout, cs);
  }
});

test('closeout: an unknown closeout_status → 400', async () => {
  assert.equal((await post('/api/session-plans/closeout', { ...BASE, closeout_status: 'done' })).status, 400);
  assert.equal((await post('/api/session-plans/closeout', { ...BASE })).status, 400);
  assert.equal(captureCalls.length, 0);
});
