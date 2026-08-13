'use strict';

// Q&A shadow coverage through the LIVE /api/coach/chat and /api/coach/ask seams — the
// routes that serve athlete questions, recommendation explanations, plan disputes, and
// corrections, and that minted no turn_id before this change. Proves: with the flag off
// nothing is captured; with it on every completed athlete-facing Q&A turn leaves ONE
// correlated Coach_Shadow + Coach_Response pair keyed by the same turn_id, storing the
// FINAL returned answer; the response is byte-identical; no training sheet is written.
//
// Harness mirrors test/coachResponseRoute.test.js (require-cache stub injection).

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
  appendRows: async () => { throw new Error('appendRows must not be called by a read-only Q&A path'); },
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
require.cache[require.resolve('../sheets')] = { id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets };
require.cache[require.resolve('../services/vision')] = { id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) } };

const coachState = { configured: true, reply: 'Because at RIR 1 that top set is near failure — that is the intended stimulus.', propose_note: null, violations: [], throwOnChat: false };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateChatReply: async () => { if (coachState.throwOnChat) throw new Error('gemini exploded'); return { reply: coachState.reply, propose_edit: null, propose_note: coachState.propose_note, propose_constraint: null, propose_plan_edit: null }; },
    findRegisterViolations: () => coachState.violations,
    looksLikePrClaim: () => false,
    generateCoachMessage: async () => 'Solid work.',
    generatePlanMessage: async () => 'Solid work.',
    sanitizeFacts: (f) => f,
  },
};

const smeState = { result: { answer: 'RIR means reps in reserve.', depth: 'explain', cards: ['rir_basics'], confidenceLevel: 'high' } };
const polishState = { transform: (a) => a }; // identity = no Gemini polish; override to simulate a real rewrite
require.cache[require.resolve('../services/trainingSME')] = { id: require.resolve('../services/trainingSME'), filename: require.resolve('../services/trainingSME'), loaded: true, exports: { buildTrainingSMEAnswer: () => smeState.result } };
require.cache[require.resolve('../services/coachPolish')] = { id: require.resolve('../services/coachPolish'), filename: require.resolve('../services/coachPolish'), loaded: true, exports: { polishSmeAnswer: async (a) => polishState.transform(a) } };

const responseSheet = require('../services/coachResponseSheet');
const packetShadow = require('../services/coachTurnPacketShadow');
const RESP = Object.fromEntries(responseSheet.RESPONSE_HEADERS.map((h, i) => [h, i]));

const appended = [];
function installCapture() {
  responseSheet._resetForTesting({ ensure: async () => {}, getHeader: async () => responseSheet.RESPONSE_HEADERS.slice(), append: async (tab, rows) => { for (const r of rows) appended.push(r); } });
}

const originalConsoleLog = console.log;
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
const { app } = require('../index');
let server; let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_PROFILE_GOAL; }
});

async function post(path, body) {
  appended.length = 0;
  installCapture();
  const before = packetShadow.getShadowLog().length;
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY }, body: JSON.stringify(body) });
  const json = await res.json();
  for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (appended.length) break; }
  await responseSheet._flushForTesting();
  const shadowLog = packetShadow.getShadowLog();
  return { res, json, respRow: appended[appended.length - 1] || null, respCount: appended.length, shadowRow: shadowLog.length > before ? shadowLog[shadowLog.length - 1] : null, shadowCount: shadowLog.length - before };
}

const Q = { message: 'Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?', history: [], context: {}, sessionId: '20260721-PM-01', appVersion: 'v145' };

test('A. flag OFF: a Q&A turn produces no Coach_Shadow or Coach_Response row', async () => {
  delete process.env.ATLAS_INTERACTION_TRACE;
  coachState.configured = true; coachState.throwOnChat = false; coachState.violations = []; coachState.reply = Q ? 'ans' : 'ans';
  const { res, respRow, shadowRow } = await post('/api/coach/chat', Q);
  assert.equal(res.status, 200);
  assert.equal(respRow, null);
  assert.equal(shadowRow, null);
});

test('A. explanation (chat, gemini): one correlated pair stores the FINAL returned text', async () => {
  // byte-identical baseline
  delete process.env.ATLAS_INTERACTION_TRACE;
  coachState.configured = true; coachState.throwOnChat = false; coachState.violations = []; coachState.propose_note = null;
  coachState.reply = 'Because at RIR 1 that top set is near failure — that is the intended stimulus.';
  const off = (await post('/api/coach/chat', Q)).json;

  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const { res, json, respRow, respCount, shadowRow } = await post('/api/coach/chat', Q);
  assert.equal(res.status, 200);
  assert.deepEqual(json.data, off.data, 'response body is byte-identical with the shadow flag on');

  assert.ok(shadowRow, 'a Coach_Shadow record was produced');
  assert.ok(respRow, 'a Coach_Response record was produced');
  assert.equal(respCount, 1, 'exactly one response row (no duplicate telemetry)');
  // Correlated by the SAME minted turn_id.
  assert.equal(respRow[RESP.turn_id], shadowRow.turn_id);
  assert.match(respRow[RESP.turn_id], /^turn:/);
  // Truthful classification + final text.
  assert.equal(shadowRow.intent_type, 'coach_chat');
  assert.equal(shadowRow.source, 'coach_chat');
  assert.equal(shadowRow.packet_valid, true);
  assert.equal(shadowRow.trace.valid, true);
  assert.equal(respRow[RESP.route], '/api/coach/chat');
  assert.equal(respRow[RESP.visible_message], json.data.message);
  assert.equal(respRow[RESP.visible_message], coachState.reply);
  assert.equal(respRow[RESP.visible_message_present], 'TRUE');
  assert.equal(respRow[RESP.visible_source], 'gemini');
  assert.equal(respRow[RESP.suppressed], 'FALSE');
  assert.equal(respRow[RESP.session_id], '20260721-PM-01');
  // Model + validator stages ran on the gemini path; the rest are honestly missing.
  const stages = Object.fromEntries(shadowRow.trace.stages.map((s) => [s.stage, s.status]));
  assert.equal(stages.model_response, 'ok');
  assert.equal(stages.validator_result, 'ok');
  assert.ok(shadowRow.trace.missing.includes('parser'));
  assert.ok(shadowRow.trace.missing.includes('write_proof'));
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('D. suppressed (chat): the FINAL nulled answer is recorded, not the model draft', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnChat = false;
  coachState.reply = 'NEW PR you crushed it!!'; coachState.propose_note = { note: 'keep going' }; coachState.violations = ['pr_without_grant'];
  const { res, json, respRow, shadowRow } = await post('/api/coach/chat', Q);
  assert.equal(res.status, 200);
  assert.equal(json.data.message, null, 'the register-violating reply is suppressed to null');
  assert.ok(respRow && shadowRow);
  assert.notEqual(respRow[RESP.visible_message], coachState.reply); // never the draft
  assert.equal(respRow[RESP.visible_message_present], 'FALSE');
  assert.equal(respRow[RESP.suppressed], 'TRUE');
  // The stub reports a violation code the enum does not know, so the recorder fails closed
  // to `unknown` rather than persisting the stub's arbitrary string.
  assert.equal(respRow[RESP.suppression_reason], 'validator_suppressed:unknown');
  coachState.reply = 'ok'; coachState.propose_note = null; coachState.violations = [];
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('D2. suppressed (chat): a RECOGNIZED violation records its exact code, proving the chat wiring', async () => {
  // Codex #1219 P2: asserting `unknown` above cannot prove the chat wiring works, because
  // an unwired route also yields `unknown` (formatSuppressionReason(null)). This test uses a
  // code the enum KNOWS, so removing the res.locals assignment in the chat route — or its
  // forwarding through coachQaShadow — makes the suffix fall back to `unknown` and fails here.
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnChat = false;
  coachState.reply = 'Fucking great work there.';
  coachState.propose_note = { note: 'keep going' };
  coachState.violations = [{ code: 'profanity_without_permission', phrase: 'Fucking' }];
  const { res, json, respRow } = await post('/api/coach/chat', Q);
  assert.equal(res.status, 200);
  assert.equal(json.data.message, null, 'the register-violating reply is still suppressed to null');
  assert.ok(respRow);
  assert.equal(respRow[RESP.suppressed], 'TRUE');
  assert.equal(respRow[RESP.suppression_reason], 'validator_suppressed:profanity_without_permission');
  // The draft and the matched phrase never reach the record.
  assert.ok(!respRow.join(' | ').includes(coachState.reply));
  assert.ok(!/fucking/i.test(respRow.join(' | ')));
  coachState.reply = 'ok'; coachState.propose_note = null; coachState.violations = [];
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('E. error/fallback (chat): the FINAL athlete-facing fallback is captured; HTTP unchanged', async () => {
  // When Gemini throws, /api/coach/chat degrades to a deterministic fallback and never
  // surfaces the error to the athlete. Telemetry captures whatever the athlete actually
  // received, exactly, and the HTTP response is unaffected by the telemetry or the error.
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnChat = true;
  const { res, json, respRow, shadowRow } = await post('/api/coach/chat', Q);
  assert.equal(res.status, 200);
  assert.ok(respRow && shadowRow, 'the fallback turn is still captured');
  // Stored text is EXACTLY the final returned text (empty when the fallback returned null).
  assert.equal(respRow[RESP.visible_message], json.data.message || '');
  // visible_error is truthful: TRUE iff the served payload carried an error marker.
  assert.equal(respRow[RESP.visible_error], json.data.error ? 'TRUE' : 'FALSE');
  coachState.throwOnChat = false;
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('ask: an athlete-facing SME answer is captured (data.answer → visible_message)', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  smeState.result = { answer: 'RIR means reps in reserve.', depth: 'explain', cards: ['rir_basics'], confidenceLevel: 'high' };
  polishState.transform = (a) => a; // no rewrite → model not used
  const { res, json, respRow, shadowRow } = await post('/api/coach/ask', { message: 'What is RIR?', appVersion: 'v145' });
  assert.equal(res.status, 200);
  assert.ok(respRow && shadowRow);
  assert.equal(respRow[RESP.route], '/api/coach/ask');
  assert.equal(shadowRow.intent_type, 'coach_ask');
  assert.equal(respRow[RESP.visible_message], json.data.answer);
  assert.equal(respRow[RESP.visible_source], 'training_sme');
  const stages = Object.fromEntries(shadowRow.trace.stages.map((s) => [s.stage, s.status]));
  assert.equal(stages.model_response, 'skipped', 'an unrewritten SME answer is not model usage');
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('ask: a Gemini-polished SME answer records REAL model usage (not hidden as skipped)', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  smeState.result = { answer: 'RIR means reps in reserve.', depth: 'explain', cards: ['rir_basics'], confidenceLevel: 'high' };
  polishState.transform = () => 'Reps in reserve — how many clean reps you had left in the tank.'; // Gemini rewrote it
  const { res, json, respRow, shadowRow } = await post('/api/coach/ask', { message: 'What is RIR?', appVersion: 'v145' });
  assert.equal(res.status, 200);
  assert.ok(respRow && shadowRow);
  assert.equal(respRow[RESP.visible_message], json.data.answer); // the polished text the athlete saw
  const stages = Object.fromEntries(shadowRow.trace.stages.map((s) => [s.stage, s.status]));
  assert.equal(stages.model_response, 'ok', 'a successful Gemini polish is recorded as model usage');
  polishState.transform = (a) => a;
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('ask: a non-athlete-facing log_only pre-check produces NO row (one pair per question)', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  smeState.result = { answer: null, depth: 'log_only', cards: [], confidenceLevel: 'low' };
  const { res, respRow, respCount, shadowCount } = await post('/api/coach/ask', { message: 'bench 225 5/2', appVersion: 'v145' });
  assert.equal(res.status, 200);
  assert.equal(respRow, null, 'a log_only SME pre-check the client ignores is not captured');
  assert.equal(respCount, 0);
  assert.equal(shadowCount, 0);
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('the Q&A shadow never writes to any training sheet', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  coachState.configured = true; coachState.throwOnChat = false; coachState.violations = []; coachState.reply = 'ok';
  const { res } = await post('/api/coach/chat', Q); // fakeSheets.appendRows throws if any write is attempted
  assert.equal(res.status, 200);
  delete process.env.ATLAS_INTERACTION_TRACE;
});
