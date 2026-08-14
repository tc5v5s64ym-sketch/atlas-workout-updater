'use strict';

// ── routes/reads.js — a failed read reaches a TRUTHFUL terminal status ────────
//
// The owner hit a hard 500 on `GET /api/summary/weekly`. Every handler in this
// read-only router answered ANY thrown error with 500 + the raw message. A 500 says
// "this server is broken, there is nothing to try again", which is right for a bug
// in this code and wrong for a temporary authority outage — and the client had no
// way to tell those apart. The S4 router now classifies failures from its sole
// Supabase authority: temporary gateway/connection failures answer 503 with
// `retryable:true`; permanent permission, request and data errors answer 500.
//
// These tests mount the REAL router on a real Express app and drive real HTTP, so
// they prove the wiring, not just the helper. The router is read-only: nothing here
// can retry, duplicate, or touch a workout write.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const state = { recentRowsError: null, sheetRowsError: null, catalogError: null };

const fakeSheets = {
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
  getRecentRows: async () => { if (state.recentRowsError) throw state.recentRowsError; return []; },
  // services/trainingStore.js destructures this from the module at load, so the
  // routes backed by the store fail through the same stub as the direct readers.
  // ONE READ, NOT TWO. Under Sheets the migrated routes reached the log either
  // through `getRecentRows` (bounded) or `getSheetRows` (whole tab), and this suite
  // armed them separately. The S4 cutover collapsed both into one authority read, so
  // either armed error must reach it — otherwise a test that arms `recentRowsError`
  // would silently observe a healthy read and assert nothing.
  getSheetRows: async () => {
    if (state.sheetRowsError) throw state.sheetRowsError;
    if (state.recentRowsError) throw state.recentRowsError;
    return [];
  },
  getExerciseCatalog: async () => { if (state.catalogError) throw state.catalogError; return []; },
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`
// no longer controls the logged sets, the Effort row, the plan ledgers or the write
// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so
// no test's data changes — only where the route reads it from.
const { installWorkoutAuthorityStub, resetWorkoutAuthorityStub } = require('./helpers/stubWorkoutAuthority');
installWorkoutAuthorityStub({ sheetsFallback: true });
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
  // The double seeds itself from the sheets fixture on FIRST access, so it has to be
  // re-armed per test — otherwise one test's successful read would outlive it and the
  // next test's armed failure would never be reached.
  resetWorkoutAuthorityStub();
});

async function get(path) {
  // Re-armed per REQUEST, not per test: two of these tests change the armed failure
  // between requests, and the double seeds itself from the fixture on first access.
  // This read-only suite writes nothing, so discarding the seed costs nothing.
  resetWorkoutAuthorityStub();
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
  state.recentRowsError = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  const { status, body } = await get('/api/summary/weekly');
  assert.equal(status, 500, 'a missing database relation is a real server-side fault, not a retry');
  assert.equal(body.status, 'error');
  assert.equal(body.details, 'relation does not exist');
});

test('a PostgreSQL connection failure is retryable; a permission failure is not', async () => {
  state.recentRowsError = Object.assign(new Error('connection failure'), { code: '08006' });
  assert.equal((await get('/api/summary/weekly')).status, 503);

  state.recentRowsError = Object.assign(new Error('insufficient privilege'), { code: '42501' });
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

// A missing relation is a durable schema fact for the owner to fix, not an outage:
// it must not tell the client "try again in a moment" forever.
test('an undefined table is a 500, never a retryable 503', async () => {
  state.recentRowsError = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  const { status } = await get('/api/summary/weekly');
  assert.equal(status, 500);
});
