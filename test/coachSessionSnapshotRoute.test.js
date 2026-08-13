'use strict';

// Canonical session seam through the LIVE /api/coach/chat route — Phase 4 H-08A.
//
// Proves, through the real Express route + the real coachQaShadow boundary (require-cache
// stub injection, mirroring test/coachQaShadowRoute.test.js), that:
//   • flag ON (ATLAS_TURN_PRECEDENCE) + a valid active_session ⇒ the shadow packet carries the
//     canonical WorkoutSession (embedded.session:true), the trace records session_snapshot,
//     packet and Coach_Response share ONE turn id, and the VISIBLE reply is byte-identical;
//   • flag OFF ⇒ packet.session stays null, session_snapshot is absent, reply byte-identical;
//   • an old client that omits active_session ⇒ no crash, no fabricated session, reply unchanged;
//   • a malformed snapshot ⇒ fails closed (no session), reply unchanged, the shadow never
//     blocks or leaks an error;
//   • no training Sheet is ever appended (read-only route).
//
// The message is a plain knowledge question that triggers NO deterministic lift-answer lane
// and NO ATLAS_TURN_PRECEDENCE visible lane, so the ONLY thing the flag changes here is the
// shadow's session embedding — the visible reply is invariant to it.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
delete process.env.ATLAS_TURN_PRECEDENCE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by a read-only chat path'); },
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

const coachState = { configured: true, reply: 'Progressive overload means adding a little stress over time so the body keeps adapting.' };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateChatReply: async () => ({ reply: coachState.reply, propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null }),
    findRegisterViolations: () => [],
    looksLikePrClaim: () => false,
    generateCoachMessage: async () => 'Solid work.',
    generatePlanMessage: async () => 'Solid work.',
    sanitizeFacts: (f) => f,
  },
};
require.cache[require.resolve('../services/trainingSME')] = { id: require.resolve('../services/trainingSME'), filename: require.resolve('../services/trainingSME'), loaded: true, exports: { buildTrainingSMEAnswer: () => ({ answer: null, depth: 'log_only', cards: [], confidenceLevel: 'low' }) } };
require.cache[require.resolve('../services/coachPolish')] = { id: require.resolve('../services/coachPolish'), filename: require.resolve('../services/coachPolish'), loaded: true, exports: { polishSmeAnswer: async (a) => a } };

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

// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`

// no longer controls the logged sets, the Effort row, the plan ledgers or the write

// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so

// no test's data changes — only where the route reads it from.

require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({ sheetsFallback: true });
const { app } = require('../index');
let server; let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE; delete process.env.ATLAS_PROFILE_GOAL; }
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
  return { res, json, respRow: appended[appended.length - 1] || null, respCount: appended.length, shadowRow: shadowLog.length > before ? shadowLog[shadowLog.length - 1] : null };
}

// A plain knowledge question — no lift-answer lane, no TP visible lane.
const MSG = 'Tell me about progressive overload.';
// The live client active-session shape (src/app/activeSession.js): ordered slots, a completed
// slot, DUPLICATE names kept as independent slots, and substituted/inserted sources.
const ACTIVE = { exercises: [
  { name: 'Back Squat', liftCode: 'SQ', status: 'completed', source: 'planned' },
  { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'substituted' },
  { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
  { name: 'Hammer Curl', liftCode: 'HC', status: 'pending', source: 'inserted' },
] };

// A shadow-OFF baseline reply for a given ATLAS_TURN_PRECEDENCE setting (so TP-lane behavior is
// held constant and only the shadow's session embedding varies against it).
async function baselineData(tpOn, body) {
  if (tpOn) process.env.ATLAS_TURN_PRECEDENCE = 'on'; else delete process.env.ATLAS_TURN_PRECEDENCE;
  delete process.env.ATLAS_INTERACTION_TRACE;
  return (await post('/api/coach/chat', body)).json.data;
}

const stages = (row) => Object.fromEntries(row.shadowRow ? row.shadowRow.trace.stages.map((s) => [s.stage, s.status]) : []);

test('flag ON + valid active_session: packet carries the canonical session; reply byte-identical', async () => {
  const base = await baselineData(true, { message: MSG, history: [], context: {} });

  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const on = await post('/api/coach/chat', { message: MSG, history: [], context: { active_session: ACTIVE }, sessionId: '20260723-PM-01' });

  assert.equal(on.res.status, 200);
  // The shadow + the additive active_session field are BOTH inert to the visible reply.
  assert.deepEqual(on.json.data, base, 'the visible reply is byte-identical with the session seam live');
  assert.ok(on.shadowRow, 'a Coach_Shadow record was produced');
  assert.equal(on.shadowRow.packet_valid, true);
  // The canonical session is embedded in the packet.
  assert.equal(on.shadowRow.embedded.session, true, 'packet.session !== null');
  // …and the other embedded facts stay honestly empty (their own phases).
  assert.equal(on.shadowRow.embedded.exercises, 0);
  assert.equal(on.shadowRow.embedded.decision, false);
  assert.equal(on.shadowRow.embedded.safety, false);
  assert.equal(on.shadowRow.embedded.closeout, false);
  // Trace records session_snapshot as genuinely present (not engine_decision).
  const st = stages(on);
  assert.equal(st.session_snapshot, 'ok', 'session_snapshot is present');
  assert.ok(!('engine_decision' in st), 'engine_decision is NOT claimed from session state alone');
  assert.ok(on.shadowRow.trace.missing.includes('engine_decision'), 'engine_decision surfaces as missing');
  // Packet and Coach_Response share the ONE minted turn id.
  assert.ok(on.respRow, 'a Coach_Response record was produced');
  assert.equal(on.respRow[RESP.turn_id], on.shadowRow.turn_id);
  assert.match(on.respRow[RESP.turn_id], /^turn:/);
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});

test('flag OFF: packet.session stays null, session_snapshot absent, reply byte-identical', async () => {
  const base = await baselineData(false, { message: MSG, history: [], context: {} });

  delete process.env.ATLAS_TURN_PRECEDENCE; // flag off
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const off = await post('/api/coach/chat', { message: MSG, history: [], context: { active_session: ACTIVE } });

  assert.equal(off.res.status, 200);
  assert.deepEqual(off.json.data, base, 'flag OFF ⇒ reply byte-identical');
  assert.ok(off.shadowRow);
  assert.equal(off.shadowRow.embedded.session, false, 'prior packet behavior unchanged (session null)');
  assert.ok(off.shadowRow.trace.missing.includes('session_snapshot'), 'session_snapshot honestly missing');
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('old client (no active_session), flag ON: no crash, no fabricated session, reply unchanged', async () => {
  const base = await baselineData(true, { message: MSG, history: [], context: {} });

  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const r = await post('/api/coach/chat', { message: MSG, history: [], context: {} });

  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.data, base);
  assert.ok(r.shadowRow);
  assert.equal(r.shadowRow.embedded.session, false, 'no session is fabricated for an old client');
  assert.ok(r.shadowRow.trace.missing.includes('session_snapshot'));
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});

test('malformed active_session, flag ON: fails closed, reply unchanged, no leaked error', async () => {
  const base = await baselineData(true, { message: MSG, history: [], context: {} });

  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const r = await post('/api/coach/chat', { message: MSG, history: [], context: { active_session: { exercises: [{ name: 'Bench Press', status: 'bogus', source: 'planned' }] } } });

  assert.equal(r.res.status, 200, 'the shadow never blocks the response');
  assert.deepEqual(r.json.data, base, 'reply unchanged on a malformed snapshot');
  assert.ok(!r.json.data.error, 'the shadow never leaks an error to the athlete');
  assert.ok(r.shadowRow);
  assert.equal(r.shadowRow.embedded.session, false, 'a malformed snapshot fails closed to null');
  assert.equal(r.shadowRow.packet_valid, true, 'the packet stays valid (session honestly null)');
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});

test('the session seam never appends to a training Sheet', async () => {
  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  // fakeSheets.appendRows throws if any training write is attempted; a 200 proves none was.
  const r = await post('/api/coach/chat', { message: MSG, history: [], context: { active_session: ACTIVE } });
  assert.equal(r.res.status, 200);
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});

// H-03 (shadow-first) — a "why …" turn makes the route decide "explain the displayed
// recommendation" (grounding). With the flag on, that decision is canonicalized into
// packet.decision (a progress_readout CoachingDecision), clearing the "null decision"
// divergence signal for those turns. Flag off ⇒ packet.decision stays null. Visible reply
// unchanged either way.
test('H-03: flag ON + a "why …" turn carries a canonical decision in the packet (embedded.decision)', async () => {
  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const ctx = {
    current_plan: [{ name: 'Bench Press', weight: 185, reps: 5, rir: 2, sets: 3 }],
    recommended_label: 'Upper Power',
    active_session: { exercises: [{ name: 'Bench Press', liftCode: '', status: 'pending', source: 'planned' }] },
  };
  const r = await post('/api/coach/chat', { message: 'Why only 185 for bench press?', history: [], context: ctx });
  assert.equal(r.res.status, 200);
  assert.ok(r.shadowRow);
  assert.equal(r.shadowRow.embedded.decision, true, 'packet.decision is carried for the explain-recommendation turn');
  assert.equal(r.shadowRow.packet_valid, true);
  // the engine_decision spine stage is present for this turn
  const st = Object.fromEntries(r.shadowRow.trace.stages.map((s) => [s.stage, s.status]));
  assert.equal(st.engine_decision, 'ok');
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});

test('H-03: flag OFF ⇒ packet.decision stays null (byte-identical prior shadow behavior)', async () => {
  delete process.env.ATLAS_TURN_PRECEDENCE;
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const ctx = { current_plan: [{ name: 'Bench Press', weight: 185 }], recommended_label: 'Upper Power' };
  const r = await post('/api/coach/chat', { message: 'Why only 185 for bench press?', history: [], context: ctx });
  assert.equal(r.res.status, 200);
  assert.ok(r.shadowRow);
  assert.equal(r.shadowRow.embedded.decision, false, 'flag off ⇒ no canonical decision embedded');
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('H-03: flag ON + a tired turn carries a canonical RECOVERY decision (embedded.decision)', async () => {
  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const r = await post('/api/coach/chat', { message: "I'm completely exhausted and cooked today.", history: [], context: {} });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.data.source, 'engine', 'recovery routing owns the reply');
  assert.ok(r.shadowRow);
  assert.equal(r.shadowRow.embedded.decision, true, 'the recovery decision is carried in the packet');
  const st = Object.fromEntries(r.shadowRow.trace.stages.map((s) => [s.stage, s.status]));
  assert.equal(st.engine_decision, 'ok', 'engine_decision recorded for the recovery turn');
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});

// PR 1 (canonical recovery reason facts): enriching the shadow recovery decision's
// explanation_inputs is SHADOW-ONLY — the route hoists the recovery signals it already computes
// and stashes them on res.locals for the shadow; the visible recovery reply is untouched.
test('H-03: the recovery reply is byte-identical whether the shadow enrichment is on or off', async () => {
  const body = { message: "I'm completely exhausted and cooked today.", history: [], context: {} };
  // Shadow OFF baseline (TP on so lane behavior is held constant).
  const base = await baselineData(true, body);
  // Shadow ON — the recovery decision is enriched with reason facts, but the reply must not change.
  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  const on = await post('/api/coach/chat', body);
  assert.equal(on.res.status, 200);
  assert.equal(on.json.data.source, 'engine', 'recovery routing still owns the reply');
  assert.deepEqual(on.json.data, base, 'the visible recovery reply is byte-identical with the enrichment live');
  assert.equal(on.shadowRow.embedded.decision, true, 'the enriched recovery decision is still embedded');
  // Read-only: the stubbed sheets.appendRows throws if a training write is attempted, so a 200 here
  // proves the recovery path never wrote.
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});

// D10 — the route resolves a discussion referent AT ANSWER TIME (the lift a bare correction
// resolves to). With the canonical session carried (H-08A), that referent is now set on the
// packet's session (packet.session.discussion_referent), so the divergence report's
// "route-local referent" signal clears: referent.packet == referent.route.
test('D10: the answer-time referent is carried on the packet session (referent.packet == route)', async () => {
  process.env.ATLAS_TURN_PRECEDENCE = 'on';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  // A "why …" turn naming a lift IN the plan resolves a discussion referent; active_session
  // carries the same lift so the canonical session validates and takes the referent.
  const ctx = {
    current_plan: [{ name: 'Bench Press' }],
    active_session: { exercises: [{ name: 'Bench Press', liftCode: '', status: 'pending', source: 'planned' }] },
  };
  const r = await post('/api/coach/chat', { message: 'Why only 185 for bench press?', history: [], context: ctx });
  assert.equal(r.res.status, 200);
  assert.ok(r.shadowRow);
  assert.ok(r.shadowRow.referent.route, 'the route resolved a referent this turn');
  assert.equal(r.shadowRow.referent.packet, r.shadowRow.referent.route, 'the packet session now carries the referent (route-local cleared)');
  assert.equal(r.shadowRow.embedded.session, true);
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE;
});
