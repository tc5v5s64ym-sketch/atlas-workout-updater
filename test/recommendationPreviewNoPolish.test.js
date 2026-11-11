'use strict';

// Fable fix 2 (#1728) — proving probe A1711-2: the /api/recommendation/preview
// coachExplanation must be the deterministic engine text, never a polished
// rewrite. A polish that passes the number/field validators can still contradict
// the engine prescription (wrong exercise, wrong weight attached to the right
// label), so the route must not serve polish output at all. The probe computes
// the expected text independently from the engine with exactly the inputs the
// route passes and asserts the served text is byte-identical to it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateCoachExplanation } = require('../services/coachExplanationPolicy');
const { buildRecommendation, parseRecommendationConstraints } = require('../services/recommendationPipeline');
const { getProfileGoal } = require('../services/profileGoal');

// --- Environment + sheet/vision/coach stubs (require-cache injection, per test/api-smoke.test.js) ---
process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// A non-PEM placeholder: sheets.js is fully stubbed via require.cache, so this value is
// never parsed. It deliberately avoids a PEM key block (the changed-file secret scan
// flags "BEGIN PRIVATE KEY" even in an obvious stub, since it scans new files).
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

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

// The hostile rewrite the old polish step could serve: a rewrite that
// contradicts the engine prescription — a different exercise and a different
// weight — while keeping the shape of a plausible coaching sentence. This
// models a model rewrite that slips past the number/field validators (same
// digits, re-attached), i.e. the Fable 5.2 re-audit's reworded variant of the
// #1711 finding. The served text must never be it.
const HOSTILE_EXPLANATION = 'Deadlift: 195 lb for 5 reps — go heavy today.';

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

test('A1711-2: preview serves the deterministic explanation, never a polished rewrite', async () => {
  // The expected text is computed independently from the engine with exactly
  // the inputs the route passes (same query, same stubbed sheet rows, same
  // profile-goal default). The route must serve it verbatim: any polish step
  // would return a different string and fail this comparison. (The probe's
  // hostile arm — a stubbed polish returning HOSTILE_EXPLANATION — ran on the
  // pre-amend head and is recorded on #1728; the polish module is deleted in
  // this amend, so there is no polish seam left to stub.)
  const query = { liftCode: 'BEN01', goal: 'strength' };
  const expected = buildRecommendation({
    sessionText: undefined,
    explicitGoal: 'strength',
    userProfileGoal: getProfileGoal(),
    liftCode: 'BEN01',
    exerciseName: undefined,
    logRows,
    effortRows: [],
    constraints: parseRecommendationConstraints(query),
  }).coachExplanation;
  assert.equal(typeof expected, 'string');
  assert.ok(expected.length > 0);
  assert.notEqual(expected, HOSTILE_EXPLANATION);

  const { res, body } = await getPreview('?liftCode=BEN01&goal=strength');
  assert.equal(res.status, 200);
  assert.equal(body.data.coachExplanation, expected);
  assert.equal(
    validateCoachExplanation(body.data.coachExplanation, body.data.llmBrief.lockedNumbers).valid,
    true,
  );
});
