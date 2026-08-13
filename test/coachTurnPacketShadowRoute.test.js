'use strict';

// Phase 3 concern 3 — the CoachTurnPacket is assembled in shadow for a REAL coach turn
// through the live /api/coach/message seam, keyed by the same turn id as the trace, and
// logged side by side with the visible response. Proves the trust-critical contract:
// with the flag off nothing is recorded and the response is a normal 200; with the flag
// on a valid packet is assembled and the visible response is UNCHANGED — the shadow (and
// its res.json capture wrapper) never blocks, alters, or writes.
//
// Harness mirrors test/interactionTraceShadowRoute.test.js (require-cache stub injection).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength'; // a canonical goal → athlete.profile_goal populates

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by the read-only coach path'); },
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
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};
const coachState = { configured: true, message: 'Solid work.' };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateCoachMessage: async () => coachState.message,
    generatePlanMessage: async () => coachState.message,
    generateChatReply: async () => ({ reply: null }),
    sanitizeFacts: (f) => f,
  },
};

const packetShadow = require('../services/coachTurnPacketShadow');
const traceShadow = require('../services/interactionTraceShadow');
const { validateCoachTurnPacket } = require('../services/coachTurnPacket');

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
  finally {
    console.log = originalConsoleLog;
    delete process.env.ATLAS_INTERACTION_TRACE;
    delete process.env.ATLAS_PROFILE_GOAL;
  }
});

async function post(kind, facts, { expectRecord = true } = {}) {
  const before = packetShadow.getShadowLog().length;
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind, facts }),
  });
  const body = await res.json();
  for (let i = 0; i < 100; i++) {
    const len = packetShadow.getShadowLog().length;
    if (expectRecord && len > before) break;
    if (!expectRecord && i >= 3) break;
    await new Promise((r) => setImmediate(r));
  }
  const log = packetShadow.getShadowLog();
  const record = (expectRecord && log.length > before) ? log[log.length - 1] : null;
  return { res, body, record, recordedSince: log.length - before };
}

const SET = { exerciseName: 'Bench Press', muscleGroup: 'Chest', liftCode: 'BPR01', todaySets: [{ weight: 225, reps: 5, rir: 2 }], rec: { target_rir: 2 } };

test('flag OFF: no packet recorded and the response is a normal 200', async () => {
  delete process.env.ATLAS_INTERACTION_TRACE;
  const { res, recordedSince } = await post('set', SET, { expectRecord: false });
  assert.equal(res.status, 200);
  assert.equal(recordedSince, 0, 'no packet recorded when the flag is off');
});

test('flag ON: a valid packet is assembled and logged side by side; response unchanged', async () => {
  // Capture the flag-OFF response for the same input to prove zero behavior change.
  delete process.env.ATLAS_INTERACTION_TRACE;
  const off = (await post('set', SET, { expectRecord: false })).body;

  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const { res, body, record } = await post('set', SET);
  assert.equal(res.status, 200);
  // Zero behavior change (the res.json capture wrapper must not alter the payload).
  assert.deepEqual(
    { message: body.data.message, source: body.data.source, voice: body.data.voice, configured: body.data.configured },
    { message: off.data.message, source: off.data.source, voice: off.data.voice, configured: off.data.configured },
  );

  assert.ok(record, 'a packet-vs-visible record was logged');
  assert.equal(record.packet_valid, true, `packet must be valid; errors: ${JSON.stringify(record.packet_errors)}`);
  assert.match(record.turn_id, /^turn:/);
  // athlete carried (profile goal set), everything else is the bypass the report surfaces.
  assert.equal(record.embedded.athlete_profile_goal, true);
  assert.equal(record.embedded.session, false);
  assert.equal(record.embedded.exercises, 0);
  assert.equal(record.embedded.decision, false);
  assert.equal(record.embedded.safety, false);
  // visible summary is present and bounded (source only, no prose).
  assert.equal(record.visible.source, 'gemini');
  assert.equal(typeof record.visible.message_present, 'boolean');
  // trace joined by the same turn id, with the read-only route's honest missing stages.
  assert.ok(record.trace, 'the trace summary is embedded');
  assert.deepEqual(record.trace.missing, ['parser', 'knowledge_retrieval', 'write_proof']);
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('flag ON: the packet id matches the trace id (one turn, one packet, one trace)', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const { record } = await post('set', SET);
  assert.ok(record);
  // The trace shadow and the packet shadow recorded the SAME turn, keyed by one id.
  const traceLog = traceShadow.getShadowLog();
  const newestTrace = traceLog[traceLog.length - 1];
  assert.ok(newestTrace, 'the trace shadow also recorded this turn');
  assert.equal(record.turn_id, newestTrace.trace.turn_id, 'packet id and trace id are the one minted turn id');
  // Re-validate the packet shape the shadow asserts, independent of the route.
  const rebuilt = packetShadow.assembleShadowPacket({ turnId: record.turn_id, profileGoal: 'strength' });
  assert.equal(validateCoachTurnPacket(rebuilt.packet).valid, true);
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('the packet-shadow path never writes to any sheet (trust loop untouched)', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  // fakeSheets.appendRows throws if called; a clean 200 proves no write was attempted.
  const { res } = await post('set', SET);
  assert.equal(res.status, 200);
  delete process.env.ATLAS_INTERACTION_TRACE;
});
