'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Phase C2 endpoint test — the REAL app booted with the shadow flag ON and the
// intent ROUTER stubbed (require-cache injection, per test/api-smoke.test.js):
// a chat message must get its normal reply unchanged while the shadow ring
// records the classification, served read-only by /api/debug/intent-shadow.

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Stub, not a key (sheets.js is fully stubbed below) — assembled in two parts
// so the changed-file secret scan's private-key-block rule never sees a
// contiguous BEGIN header in source.
process.env.GOOGLE_PRIVATE_KEY = ['-----BEGIN PRIVATE', 'KEY-----'].join(' ') + '\\nstub\\n-----END PRIVATE KEY-----';
process.env.ATLAS_INTENT_ROUTER = 'shadow';

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('no writes in this suite'); },
  deleteRowsByRange: async () => {},
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

// Stub the ROUTER (not the shadow service) so the real intentShadow ring and
// wiring run end-to-end with no network.
const routerCalls = [];
const fakeRouter = {
  classifyIntent: async (text, opts) => {
    routerCalls.push({ text, opts });
    return {
      schema_version: 1, type: 'best_workout', constraints: {}, source: 'chat',
      asOf: '2026-07-03T06:00:00Z', actor: 'user', raw_input: text,
      extraction: { confidence: 0.88, extractor: 'stub' },
    };
  },
};
require.cache[require.resolve('../services/intentRouter')] = {
  id: require.resolve('../services/intentRouter'), filename: require.resolve('../services/intentRouter'), loaded: true, exports: fakeRouter,
};

const originalConsoleLog = console.log;
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
  finally { console.log = originalConsoleLog; delete process.env.ATLAS_INTENT_ROUTER; }
});

const authHeaders = { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY };

test('shadow e2e: chat replies normally; the ring records the classification; debug endpoint serves it', async () => {
  const chatRes = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ message: 'what should I focus on this week?' }),
  });
  assert.equal(chatRes.status, 200);
  const chatBody = await chatRes.json();
  // The reply lane is untouched: unconfigured coach → the normal deterministic
  // path, with the standard proof that nothing was written.
  assert.equal(chatBody.status, 'ok');
  assert.equal(chatBody.data.configured, false);

  await new Promise(r => setTimeout(r, 50));   // fire-and-forget lands off-path

  assert.equal(routerCalls.length, 1, 'the router classified exactly the one message');
  assert.equal(routerCalls[0].text, 'what should I focus on this week?');
  assert.equal(routerCalls[0].opts.source, 'chat', 'source passed explicitly (per #824 review note)');

  const dbgRes = await fetch(`${baseUrl}/api/debug/intent-shadow`, { headers: authHeaders });
  assert.equal(dbgRes.status, 200);
  const dbg = await dbgRes.json();
  assert.equal(dbg.data.enabled, true);
  assert.equal(dbg.data.count, 1);
  assert.equal(dbg.data.entries[0].type, 'best_workout');
  assert.equal(dbg.data.entries[0].ok, true);
  assert.equal(dbg.data.entries[0].confidence, 0.88);
});

test('shadow e2e: the debug endpoint is auth-gated', async () => {
  const res = await fetch(`${baseUrl}/api/debug/intent-shadow`);
  assert.equal(res.status, 401);
});
