'use strict';

// Coach-response capture through the LIVE /api/coach/message seam. Proves the trust
// contract: with the shadow flag off nothing is captured and the response is a normal
// 200; with it on, every completed coach turn leaves exactly ONE durable Coach_Response
// record whose visible_message is the FINAL text actually returned to the client (not an
// earlier model draft), keyed by the SAME turn_id as the trace/packet shadow — and the
// capture never alters the response or writes to any training sheet.
//
// Harness mirrors test/coachTurnPacketShadowRoute.test.js (require-cache stub injection).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

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
const coachState = { configured: true, message: 'Solid work — that top set moved well.', throwOnGenerate: false };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateCoachMessage: async () => { if (coachState.throwOnGenerate) throw new Error('gemini exploded'); return coachState.message; },
    generatePlanMessage: async () => { if (coachState.throwOnGenerate) throw new Error('gemini exploded'); return coachState.message; },
    generateChatReply: async () => ({ reply: null }),
    sanitizeFacts: (f) => f,
  },
};

const responseSheet = require('../services/coachResponseSheet');
const traceShadow = require('../services/interactionTraceShadow');

// In-memory capture of what Coach_Response would append (never touches a real sheet).
const appended = [];
function installCapture() {
  responseSheet._resetForTesting({
    ensure: async () => {},
    getHeader: async () => responseSheet.RESPONSE_HEADERS.slice(),
    append: async (tab, rows) => { for (const r of rows) appended.push(r); },
  });
}

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

const SET = { exerciseName: 'Bench Press', muscleGroup: 'Chest', liftCode: 'BPR01', todaySets: [{ weight: 225, reps: 5, rir: 2 }], rec: { target_rir: 2 } };

async function post(kind, facts) {
  appended.length = 0;
  installCapture();
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind, facts, sessionId: '20260721-PM-01', appVersion: 'v145' }),
  });
  const body = await res.json();
  // Let the res.on('finish') hook run and drain the best-effort queue.
  for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (appended.length) break; }
  await responseSheet._flushForTesting();
  return { res, body, row: appended[appended.length - 1] || null };
}

const COL = Object.fromEntries(responseSheet.RESPONSE_HEADERS.map((h, i) => [h, i]));

test('flag OFF: no response record captured; response is a normal 200', async () => {
  delete process.env.ATLAS_INTERACTION_TRACE;
  coachState.configured = true; coachState.throwOnGenerate = false;
  const { res, row } = await post('plan', SET);
  assert.equal(res.status, 200);
  assert.equal(row, null, 'no Coach_Response record when the shadow flag is off');
});

test('VISIBLE RESPONSE: one record stores the FINAL returned text, keyed by the turn_id', async () => {
  // Baseline flag-off response to prove zero behavior change.
  delete process.env.ATLAS_INTERACTION_TRACE;
  coachState.configured = true; coachState.throwOnGenerate = false;
  const off = (await post('plan', SET)).body;

  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const { res, body, row } = await post('plan', SET);
  assert.equal(res.status, 200);

  // Zero behavior change — the capture wrapper must not alter the payload.
  assert.equal(body.data.message, off.data.message);

  assert.ok(row, 'a Coach_Response record was captured');
  // The stored text is exactly what the client received (the FINAL, post-validator text).
  assert.equal(row[COL.visible_message], body.data.message);
  assert.equal(row[COL.visible_message], coachState.message);
  assert.equal(row[COL.visible_message_present], 'TRUE');
  assert.equal(row[COL.suppressed], 'FALSE');
  assert.equal(row[COL.suppression_reason], '');
  assert.equal(row[COL.visible_source], 'gemini');
  assert.equal(row[COL.route], '/api/coach/message');
  assert.equal(row[COL.session_id], '20260721-PM-01');
  assert.equal(row[COL.app_version], 'v145');

  // Correlates with the trace/packet shadow: the SAME minted turn_id.
  const traceLog = traceShadow.getShadowLog();
  const newestTrace = traceLog[traceLog.length - 1];
  assert.ok(newestTrace, 'the trace shadow recorded this same turn');
  assert.equal(row[COL.turn_id], newestTrace.trace.turn_id);
  assert.match(row[COL.turn_id], /^turn:/);
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('SUPPRESSED: the stored text is the FINAL (nulled) output, never the model draft', async () => {
  // A 'set' turn where the model produced a draft the deterministic validator suppresses.
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnGenerate = false;
  const { res, body, row } = await post('set', SET);
  assert.equal(res.status, 200);
  assert.equal(body.data.message, null, 'the FINAL returned message is suppressed to null');
  assert.ok(row, 'the suppressed turn is still captured');
  // The record reflects the FINAL response, not the model draft (coachState.message).
  assert.notEqual(row[COL.visible_message], coachState.message);
  assert.equal(row[COL.visible_message], '');
  assert.equal(row[COL.visible_message_present], 'FALSE');
  assert.equal(row[COL.suppressed], 'TRUE');
  // The reason now names the producer that actually nulled the prose, set at the
  // suppression point in finalizeCoachVoice — not inferred afterwards.
  assert.match(row[COL.suppression_reason], /^validator_suppressed:/);
  assert.ok(responseSheet.isValidatorSuppressed(row[COL.suppression_reason]));
  // Whatever the producer, the stored value is a bounded enum — never prose.
  assert.doesNotMatch(row[COL.suppression_reason], /\s/);
  assert.ok(!row[COL.suppression_reason].includes(coachState.message));
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('DELIBERATE SILENCE: a routine block records silence explicitly, not as missing data', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnGenerate = false;
  const { res, row } = await post('block', SET);
  assert.equal(res.status, 200);
  assert.ok(row, 'the silent block is still captured');
  assert.equal(row[COL.visible_message_present], 'FALSE');
  assert.equal(row[COL.suppressed], 'FALSE');
  assert.equal(row[COL.suppression_reason], 'deliberate_silence');
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('ERROR: an LLM error still leaves a record, marked as an error fallback', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnGenerate = true;
  const { res, row } = await post('plan', SET);
  assert.equal(res.status, 200); // degrades gracefully; never surfaces the error to the athlete
  assert.ok(row, 'the error turn is still captured');
  assert.equal(row[COL.suppression_reason], 'model_error_fallback');
  assert.equal(row[COL.visible_error], 'TRUE');
  coachState.throwOnGenerate = false;
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('OUTAGE: an LLM-outage turn is captured and marked as an outage fallback', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = false;
  const { res, row } = await post('plan', SET);
  assert.equal(res.status, 200);
  assert.ok(row, 'the outage turn is still captured');
  assert.equal(row[COL.suppression_reason], 'outage_fallback');
  coachState.configured = true;
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('the response-capture path never writes to any training sheet', async () => {
  // fakeSheets.appendRows throws if called; a clean 200 proves no training-sheet write.
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnGenerate = false;
  const { res } = await post('plan', SET);
  assert.equal(res.status, 200);
  delete process.env.ATLAS_INTERACTION_TRACE;
});
