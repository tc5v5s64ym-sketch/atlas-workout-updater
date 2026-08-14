'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// --- Environment + sheet/vision/coach stubs (require-cache injection, per test/api-smoke.test.js) ---
process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Not a PEM block. The secret scanner flags a private-key SHAPE even in an obvious
// stub, and it scans changed files — so this line only became visible when this
// suite was touched. Every other suite already uses this form.
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';

const sheetState = { appendCalls: [], deleteCalls: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only SME endpoint');
  },
  deleteRowsByRange: async (tabName, s, e) => { sheetState.deleteCalls.push({ tabName, s, e }); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};
const fakeVision = { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) };
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: fakeVision,
};
const fakeCoach = {
  isConfigured: () => false,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async () => null,
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const originalConsoleLog = console.log;
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
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
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; }
});

async function ask(message) {
  const res = await fetch(`${baseUrl}/api/coach/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ message }),
  });
  const body = await res.json();
  return { res, body };
}

test('logging-shaped input returns no SME lecture (log_only, answer null)', async () => {
  const { res, body } = await ask('bench 190 6/2');
  assert.equal(res.status, 200);
  assert.equal(body.data.depth, 'log_only');
  assert.equal(body.data.answer, null);
});

test('a comparison question returns a card-grounded compare answer', async () => {
  const { body } = await ask('explain hypertrophy vs strength');
  assert.equal(body.data.depth, 'compare_options');
  assert.equal(typeof body.data.answer, 'string');
  assert.ok(body.data.cards.includes('strength_training'));
  assert.ok(body.data.cards.includes('hypertrophy_training'));
});

test('a "teach me" question returns a teach-depth answer', async () => {
  const { body } = await ask('teach me how progressive overload works');
  assert.equal(body.data.depth, 'teach_me');
  assert.match(body.data.answer, /overload/i);
});

test('empty message is a 400', async () => {
  const res = await fetch(`${baseUrl}/api/coach/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(res.status, 400);
});

test('the SME endpoint never triggers a write', async () => {
  await ask('explain deloads');
  await ask('bench 225 5/1');
  assert.equal(sheetState.appendCalls.length, 0);
  assert.equal(sheetState.deleteCalls.length, 0);
});
