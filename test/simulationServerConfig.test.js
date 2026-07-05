'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = '1UuprDIBoV2Y9jEraOkKaqdX1PHE6ESiF9ZLFJH3CeXE';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';

const originalConsoleLog = console.log;
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
});
