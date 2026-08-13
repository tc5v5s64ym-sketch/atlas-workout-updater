'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = '1UuprDIBoV2Y9jEraOkKaqdX1PHE6ESiF9ZLFJH3CeXE';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_COACH_ENGINE = 'hybrid';
process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
process.env.ATLAS_INTENT_ROUTER = 'shadow';

const originalConsoleLog = console.log;
// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
// blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();

// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`

// no longer controls the logged sets, the Effort row, the plan ledgers or the write

// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so

// no test's data changes — only where the route reads it from.

require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({ sheetsFallback: true });
const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

test('server debug config exposes safe sheet verification info in test mode', async () => {
  const response = await fetch(`${baseUrl}/api/debug/config`, {
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.sheetVerification.canVerify, true);
  assert.equal(body.data.sheetVerification.source, 'GOOGLE_SHEETS_ID');
  assert.equal(body.data.sheetVerification.id, process.env.GOOGLE_SHEETS_ID);
  assert.equal(body.data.sheetVerification.idLast6, 'H3CeXE');
  assert.equal(body.data.sheetVerification.isSandboxSheet, true);
  assert.equal(Object.prototype.hasOwnProperty.call(body.data.sheetVerification, 'isProductionSheet'), false);
  assert.equal(body.data.coachEngineMode, 'hybrid');
  assert.equal(body.data.brainShadowPersistEnabled, true);
  assert.equal(body.data.intentRouterMode, 'shadow');
});
