'use strict';

// ── routes/reads.js — a failed read reaches a TRUTHFUL terminal status ────────
//
// The owner hit a hard 500 on `GET /api/summary/weekly`. Every handler in this
// read-only router answered ANY thrown error with 500 + the raw message. A 500 says
// "this server is broken, there is nothing to try again", which is right for a bug
// in this code and wrong for Google rate-limiting us — and the client had no way to
// tell those apart.
//
// The read layer now retries the transient case in-request (sheets.js
// `readWithRetry`). Arriving at the handler's catch with a transient error therefore
// means the BOUNDED retry was exhausted, so this is the fail-closed terminal state:
// 503 + `retryable:true`. A permanent failure still answers 500, because it is one.
//
// These tests mount the REAL router on a real Express app and drive real HTTP, so
// they prove the wiring, not just the helper. The router is read-only: nothing here
// can retry, duplicate, or touch a workout write.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// The REAL classifier, captured before the fake replaces the module — the fixture
// must never carry a second copy of it.
const { classifySheetsReadError } = require('../sheets');

const state = { recentRowsError: null, sheetRowsError: null, catalogError: null };

const fakeSheets = {
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
  getRecentRows: async () => { if (state.recentRowsError) throw state.recentRowsError; return []; },
  // services/trainingStore.js destructures this from the module at load, so the
  // routes backed by the store fail through the same stub as the direct readers.
  getSheetRows: async () => { if (state.sheetRowsError) throw state.sheetRowsError; return []; },
  getExerciseCatalog: async () => { if (state.catalogError) throw state.catalogError; return []; },
  classifySheetsReadError,
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
const registerReadRoutes = require('../routes/reads');

const gaxios = (status, message) => Object.assign(new Error(message), {
  status,
  response: { status, data: { error: { status: '', message } } },
});

// One app, one ephemeral port, closed at the end.
const app = express();
app.use((req, _res, next) => { req.requestId = 'test-req'; req.requestStartMs = Date.now(); next(); });
app.use(registerReadRoutes({
  getSheetRows: async () => { if (state.sheetRowsError) throw state.sheetRowsError; return []; },
}));

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

test.beforeEach(() => {
  state.recentRowsError = null;
  state.sheetRowsError = null;
  state.catalogError = null;
});

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

// ── the exact failure the owner hit ───────────────────────────────────────────

test('GET /api/summary/weekly answers 503 + retryable when the upstream read is unavailable', async () => {
  state.recentRowsError = gaxios(503, 'Backend Error');
  const { status, body } = await get('/api/summary/weekly');
  assert.equal(status, 503, 'a temporarily unavailable data source is not a broken server');
  assert.notEqual(status, 500);
  assert.equal(body.status, 'error');
  assert.equal(body.details.retryable, true, 'the client must be able to tell that retrying can work');
  assert.equal(body.details.reason, 'upstream_read_unavailable');
  assert.match(body.message, /temporarily unavailable/);
});

test('GET /api/summary/weekly still answers a hard 500 when the failure is PERMANENT', async () => {
  state.recentRowsError = gaxios(404, 'Requested entity was not found.');
  const { status, body } = await get('/api/summary/weekly');
  assert.equal(status, 500, 'a wrong spreadsheet id is a real server-side fault, not a retry');
  assert.equal(body.status, 'error');
  assert.equal(body.details, 'Requested entity was not found.');
});

test('a rate-limit rejection is retryable; a revoked service account is not — both are 403 upstream', async () => {
  state.recentRowsError = Object.assign(new Error('Quota exceeded'), {
    status: 403,
    response: { status: 403, data: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } } },
  });
  assert.equal((await get('/api/summary/weekly')).status, 503);

  state.recentRowsError = gaxios(403, 'The caller does not have permission');
  assert.equal((await get('/api/summary/weekly')).status, 500);
});

// ── the same truthful status across the whole router ──────────────────────────
//
// The 500 was not one handler's bug — it was the same guess repeated fifteen times.
// Fixing only the route the owner happened to hit would leave fourteen copies.

test('EVERY read route answers 503 on a transient failure, not 500', async () => {
  // Every route in the router that can surface a Sheets read failure — the whole
  // list, taken from the `router.get(...)` declarations, so a route left on the old
  // guess is a failure here rather than an omission nobody notices.
  const routes = [
    '/api/history/recent',
    '/api/summary/weekly',
    '/api/exercises/last-session?exercise=Bench+Press',
    '/api/exercises/BEN01',
    '/api/exercises/BEN01/progress',
    '/api/exercises/BEN01/detail',
    '/api/volume/muscle-groups',
    '/api/search/sessions?exercise=Bench+Press',
    '/api/catalog/exercises',
    '/api/catalog/search?q=bench',
    '/api/sessions/recent',
    '/api/sessions/SESSION-1',
    '/api/progress/summary',
    '/api/report/weekly',
    '/api/prs/recent',
    '/api/stalls',
  ];
  // Every reader fails, so the assertion does not depend on knowing which helper a
  // given route happens to use today — a route that switches readers stays covered.
  for (const path of routes) {
    state.recentRowsError = gaxios(503, 'Backend Error');
    state.sheetRowsError = gaxios(503, 'Backend Error');
    state.catalogError = gaxios(503, 'Backend Error');
    const { status, body } = await get(path);
    assert.equal(status, 503, `${path} must report a transient upstream failure as 503`);
    assert.equal(body.details.retryable, true, `${path} must say the failure is retryable`);
  }
});

// A request-shape rejection must never be dressed up as an upstream outage — the
// client would retry forever against an argument it has to fix itself.
test('a bad request argument is still a 400, untouched by the read-failure lane', async () => {
  assert.equal((await get('/api/stalls?minSessions=1')).status, 400);
  assert.equal((await get('/api/report/weekly?days=99')).status, 400);
});

// A missing tab is a durable schema fact for the owner to fix, not an outage: it
// must not tell the client "try again in a moment" forever.
test('a MISSING TAB is a 500, never a retryable 503', async () => {
  state.recentRowsError = new Error('Unable to parse range: Log_Cleaned!A:Z');
  const { status } = await get('/api/summary/weekly');
  assert.equal(status, 500);
});
