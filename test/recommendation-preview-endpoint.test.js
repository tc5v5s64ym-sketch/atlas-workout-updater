'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateCoachExplanation } = require('../services/coachExplanationPolicy');

// --- Environment + sheet/vision/coach stubs (require-cache injection, per test/api-smoke.test.js) ---
process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Not a PEM block. The secret scanner flags a private-key SHAPE even in an obvious
// stub, and it scans changed files — so this line only became visible when this
// suite was touched. Every other suite already uses this form.
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';

const logRows = [
  ['2026-06-01', 'S-OLD', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '205', '5', '3', ''],
  ['2026-06-10', 'S-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', ''],
  ['2026-06-10', 'S-NEW', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '215', '6', '2', ''],
];

const sheetState = { appendCalls: [], deleteCalls: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only preview endpoint');
  },
  deleteRowsByRange: async (tabName, startIndex, endIndex) => {
    sheetState.deleteCalls.push({ tabName, startIndex, endIndex });
  },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? logRows : []),
  getSheetRows: async (tabName) => (tabName === 'Log_Cleaned' ? logRows : []),
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
    if (server) await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

async function getPreview(query) {
  const res = await fetch(`${baseUrl}/api/recommendation/preview${query}`, {
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY },
  });
  const body = await res.json();
  return { res, body };
}

const ALLOWED_KEYS = ['intent', 'source', 'recommendation', 'reasonCodes', 'safetyFlags', 'llmBrief', 'coachExplanation', 'weightGuidance'];

test('GET preview returns 200 with reasonCodes, locked numbers, and a validated explanation', async () => {
  const { res, body } = await getPreview('?liftCode=BEN01&goal=strength');
  assert.equal(res.status, 200);
  const data = body.data;
  assert.ok(Array.isArray(data.reasonCodes) && data.reasonCodes.length > 0);
  assert.ok(data.llmBrief && data.llmBrief.lockedNumbers);
  assert.equal(typeof data.coachExplanation, 'string');
  assert.equal(validateCoachExplanation(data.coachExplanation, data.llmBrief.lockedNumbers).valid, true);
});

test('preview response does not leak raw sheet rows / analytics internals', async () => {
  const { body } = await getPreview('?liftCode=BEN01&goal=strength');
  const data = body.data;
  assert.equal('raw' in data, false);
  for (const key of Object.keys(data)) {
    assert.ok(ALLOWED_KEYS.includes(key), `unexpected key leaked: ${key}`);
  }
  // recommendation carries only scalar prescription fields, no row arrays.
  for (const v of Object.values(data.recommendation)) {
    assert.equal(Array.isArray(v), false);
  }
});

test('cold start returns weightGuidance and invents no weight', async () => {
  const { body } = await getPreview('?liftCode=ZZ99&goal=hypertrophy');
  const data = body.data;
  assert.equal(data.recommendation.recommendedWeight, undefined);
  assert.equal(typeof data.weightGuidance, 'string');
  assert.ok(data.reasonCodes.includes('cold_start_no_history'));
});

test('pain constraint from query reaches the recommendation', async () => {
  const { body } = await getPreview('?liftCode=BEN01&goal=strength&painFlags=left%20shoulder');
  const data = body.data;
  assert.ok(data.reasonCodes.includes('constraint_pain_no_load_increase'));
  assert.ok(data.safetyFlags.includes('respect_pain_or_injury'));
});

test('the preview endpoint never triggers a write', async () => {
  await getPreview('?liftCode=BEN01&goal=strength');
  await getPreview('?liftCode=ZZ99&goal=hypertrophy&sessionMinutes=20');
  assert.equal(sheetState.appendCalls.length, 0);
  assert.equal(sheetState.deleteCalls.length, 0);
});
