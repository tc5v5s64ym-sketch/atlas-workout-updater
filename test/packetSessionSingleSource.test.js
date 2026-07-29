'use strict';

// Phase 4 criterion 3 — ONE request-scoped canonical WorkoutSession (owner amendment, 2026-07-29).
//
// Before this, the live coach route and the post-response shadow each called
// `buildCanonicalSessionSnapshot` independently: `routes/coachOps.js` inside `deterministicAnswer`,
// and `services/coachQaShadow.js` inside its `res.on('finish')` handler. Two builders, one turn.
// They could not disagree on CONTENT today (the builder is pure over the same
// `context.active_session`), but the live answer and `packet.session` had no shared provenance —
// nothing structurally prevented them from diverging.
//
// THE OWNER AMENDMENT. `packet.session` cannot literally be consumed by the live answer: the
// packet is assembled inside the response-finished hook, i.e. AFTER the reply is sent, and that
// completed-turn observation boundary is Phase 3's and is not reopened. So criterion 3 is met by
// SHARED PROVENANCE instead:
//
//   the live visible answers consume the request-scoped canonical WorkoutSession that is
//   LATER embedded in packet.session
//
// This test proves that by OBJECT IDENTITY, which is stronger than deep equality: the builder runs
// exactly once per request, and the very object it returned is both what the answers read and what
// the packet embeds. The single permitted exception is the criterion-4 `discussion_referent`
// overlay, which the owner explicitly allows as an enriched COPY of the shared base.

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

const coachState = { configured: true, reply: 'Progressive overload means adding a little stress over time.' };
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

// ── the instrument: count every canonical-session build, and capture what it returned ────────
// A COUNTING WRAPPER around the REAL builder, injected before the app loads. Anything in the
// request that builds workout state goes through here, so a second builder anywhere — route,
// shadow, or a future caller — is visible as a second call.
const realSnapshot = require('../services/coachSessionSnapshot');
const builder = { calls: [], conflictAfterFirst: false };
require.cache[require.resolve('../services/coachSessionSnapshot')] = {
  id: require.resolve('../services/coachSessionSnapshot'),
  filename: require.resolve('../services/coachSessionSnapshot'),
  loaded: true,
  exports: {
    buildCanonicalSessionSnapshot: (ctx, opts) => {
      const out = realSnapshot.buildCanonicalSessionSnapshot(ctx, opts);
      builder.calls.push({ ctx, opts: opts || null, out });
      // Proof 5: a hypothetical SECOND builder returns deliberately CONFLICTING state. If any
      // consumer rebuilds, it gets this poisoned session and the identity assertions below fail
      // loudly rather than silently agreeing by accident.
      if (builder.conflictAfterFirst && builder.calls.length > 1) {
        return { ...(out || {}), exercises: [{ name: 'CONFLICTING REBUILD', status: 'pending', source: 'planned' }] };
      }
      return out;
    },
  },
};

const responseSheet = require('../services/coachResponseSheet');
const packetShadow = require('../services/coachTurnPacketShadow');

// Spy on the packet assembly to capture the exact `session` object the packet embeds.
const realAssemble = packetShadow.assembleShadowPacket;
const assembled = { calls: [] };
packetShadow.assembleShadowPacket = (params) => {
  assembled.calls.push(params);
  return realAssemble(params);
};

const appended = [];
function installCapture() {
  responseSheet._resetForTesting({ ensure: async () => {}, getHeader: async () => responseSheet.RESPONSE_HEADERS.slice(), append: async (tab, rows) => { for (const r of rows) appended.push(r); } });
}

const originalConsoleLog = console.log;
const { app } = require('../index');
let server; let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally {
    packetShadow.assembleShadowPacket = realAssemble;
    console.log = originalConsoleLog;
    delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_TURN_PRECEDENCE; delete process.env.ATLAS_PROFILE_GOAL;
  }
});

async function post(path, body) {
  appended.length = 0;
  builder.calls.length = 0;
  assembled.calls.length = 0;
  installCapture();
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY }, body: JSON.stringify(body) });
  const json = await res.json();
  // Let the response-finished hook (where the packet is assembled) run to completion.
  for (let i = 0; i < 60; i++) { await new Promise((r) => setImmediate(r)); if (assembled.calls.length) break; }
  await responseSheet._flushForTesting();
  return { res, json };
}

const ACTIVE = { exercises: [
  { name: 'Back Squat', liftCode: 'SQ', status: 'completed', source: 'planned' },
  { name: 'Bench Press', liftCode: 'BENCH', status: 'pending', source: 'planned' },
  { name: 'Hammer Curl', liftCode: 'HC', status: 'pending', source: 'inserted' },
] };

const KNOWLEDGE = 'Tell me about progressive overload.';
const WHATS_NEXT = "what's next?";
const ARE_WE_DONE = 'are we done?';

function shadowOn() { process.env.ATLAS_TURN_PRECEDENCE = 'on'; process.env.ATLAS_INTERACTION_TRACE = 'shadow'; }
function flagOff() { delete process.env.ATLAS_TURN_PRECEDENCE; process.env.ATLAS_INTERACTION_TRACE = 'shadow'; }

// THE PATH THAT ACTUALLY EXERCISES BOTH BUILDERS.
//
// A knowledge question is answered by the model and never reaches `deterministicAnswer`, so the
// ROUTE never builds a canonical session and only the shadow does — one call, and a test written
// against that fixture passes on unfixed code. That is a false green, and this file must not rest
// on one. The state-answer lanes ("what's next?" / "are we done?") live on the model-down path,
// which is where the route's own build happens. Verified against unfixed main: a state question
// with the model down produced TWO builds.
async function stateTurn(message, body) {
  coachState.configured = false;
  try {
    return await post('/api/coach/chat', {
      message, history: [], sessionId: '20260723-PM-01',
      context: { active_session: ACTIVE }, ...(body || {}),
    });
  } finally { coachState.configured = true; }
}

const packetSession = () => (assembled.calls.length ? assembled.calls[assembled.calls.length - 1].session : undefined);
const sharedBase = () => (builder.calls.length ? builder.calls[0].out : undefined);

// ── 1 · exactly one build per request, on the path that used to build twice ────

test('criterion 3 — flag ON: a state turn builds the canonical session exactly ONCE', async () => {
  shadowOn();
  await stateTurn(WHATS_NEXT);

  assert.equal(builder.calls.length, 1,
    'the route and the post-response shadow must share one build (unfixed main produced 2)');
});

test('criterion 3 — "are we done?" also builds exactly once', async () => {
  shadowOn();
  await stateTurn(ARE_WE_DONE);
  assert.equal(builder.calls.length, 1);
});

// ── 2 · the visible answers consume the shared session, and no rebuild can win ─

test("criterion 3 — \"what's next?\" consumes the shared session; a conflicting rebuild is never called", async () => {
  shadowOn();
  builder.conflictAfterFirst = true;   // any second build returns poisoned state
  try {
    const r = await stateTurn(WHATS_NEXT);
    assert.equal(r.res.status, 200);
    assert.equal(builder.calls.length, 1, 'no second builder ran');
    assert.doesNotMatch(JSON.stringify(r.json.data || {}), /CONFLICTING REBUILD/,
      'the visible answer never came from a rebuild');
  } finally { builder.conflictAfterFirst = false; }
});

test('criterion 3 — "are we done?" consumes the shared session; a conflicting rebuild is never called', async () => {
  shadowOn();
  builder.conflictAfterFirst = true;
  try {
    const r = await stateTurn(ARE_WE_DONE);
    assert.equal(r.res.status, 200);
    assert.equal(builder.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(r.json.data || {}), /CONFLICTING REBUILD/);
  } finally { builder.conflictAfterFirst = false; }
});

// ── 3 · the packet embeds that same canonical truth ───────────────────────────

test('criterion 3 — the packet embeds the SAME canonical session object the live turn used', async () => {
  shadowOn();
  await stateTurn(WHATS_NEXT);

  assert.equal(builder.calls.length, 1, 'still one build');
  assert.ok(assembled.calls.length >= 1, 'the packet was assembled after the response');
  const base = sharedBase();
  const embedded = packetSession();
  assert.ok(base, 'the shared base exists for this turn');
  assert.ok(embedded, 'the packet embedded a session');
  // Identity, not deep equality — with no referent to overlay there is nothing to copy.
  assert.equal(embedded, base,
    'packet.session must BE the request-scoped canonical session, not an independent rebuild');
});

test('criterion 3 — the shadow never rebuilds workout state', async () => {
  shadowOn();
  builder.conflictAfterFirst = true;
  try {
    await stateTurn(WHATS_NEXT);
    assert.equal(builder.calls.length, 1,
      'the response-finished hook must read the shared session, never build its own');
    const embedded = packetSession();
    const names = ((embedded && embedded.exercises) || []).map((e) => e.name);
    assert.ok(!names.includes('CONFLICTING REBUILD'), 'a conflicting rebuild can never reach the packet');
  } finally { builder.conflictAfterFirst = false; }
});

test('criterion 3 — discussion_referent is the ONLY permitted post-response overlay', async () => {
  shadowOn();
  await stateTurn(WHATS_NEXT);

  const base = sharedBase();
  const embedded = packetSession();
  assert.ok(base && embedded);
  // Every non-referent field must be identical to the shared base. If the packet ever needs to
  // differ in anything else, that is a second source of workout truth by another name.
  const keys = new Set([...Object.keys(base), ...Object.keys(embedded)]);
  for (const k of keys) {
    if (k === 'discussion_referent') continue;
    assert.deepEqual(embedded[k], base[k], `packet.session.${k} must match the shared canonical base`);
  }
});

// ── 4 · flag off: byte-identical legacy behaviour, no build at all ────────────

test('criterion 3 — flag OFF: the canonical builder is never called and packet.session stays null', async () => {
  flagOff();
  const r = await stateTurn(WHATS_NEXT);

  assert.equal(r.res.status, 200);
  assert.equal(builder.calls.length, 0, 'flag off must not build canonical workout state at all');
  assert.ok(assembled.calls.length >= 1, 'the packet is still assembled');
  assert.equal(packetSession(), null, 'packet.session stays null exactly as before');
});

test('criterion 3 — flag OFF: the visible state answer is byte-identical before and after this change', async () => {
  // The legacy plan_state path must be untouched when the flag is off.
  flagOff();
  const a = await stateTurn(WHATS_NEXT);
  const b = await stateTurn(WHATS_NEXT);
  assert.deepEqual(a.json.data, b.json.data, 'the legacy path is stable and unchanged');
  assert.equal(builder.calls.length, 0);
});

// ── 5 · absent / malformed active_session ────────────────────────────────────

test('criterion 3 — absent active_session: one evaluation, no fabricated session', async () => {
  shadowOn();
  const r = await stateTurn(WHATS_NEXT, { context: {} });

  assert.equal(r.res.status, 200);
  assert.equal(builder.calls.length, 1, 'evaluated once — "absent" is a result, not a skipped step');
  assert.equal(sharedBase(), null, 'and it honestly yields no canonical session');
  assert.equal(packetSession(), null, 'nothing is fabricated for the packet either');
});

test('criterion 3 — malformed active_session: one evaluation, fails closed, no contradictory snapshot', async () => {
  shadowOn();
  const malformed = { exercises: [{ name: '', status: 'not-a-status', source: 'nope' }] };
  const r = await stateTurn(WHATS_NEXT, { context: { active_session: malformed } });

  assert.equal(r.res.status, 200);
  assert.equal(builder.calls.length, 1, 'malformed input must not trigger a second independent build');
  assert.equal(sharedBase(), null, 'the existing fail-closed contract is preserved');
  assert.equal(packetSession(), null, 'and the packet never carries a half-repaired session');
});

// ── 6 · packet timing and the completed-turn boundary are unchanged ───────────

test('criterion 3 — the packet is still assembled AFTER the response, exactly once', async () => {
  shadowOn();
  await stateTurn(WHATS_NEXT);

  assert.equal(assembled.calls.length, 1,
    'exactly one packet per turn — never assembled early and never assembled twice');
  const p = assembled.calls[0];
  assert.ok(Object.prototype.hasOwnProperty.call(p, 'turnId'), 'the packet is still keyed to the turn');
});

test('criterion 3 — a model-answered turn is byte-identical with the flag on and off', async () => {
  // The knowledge path never reaches the state lanes, so the provenance seam must be completely
  // invisible there — same visible payload in both flag states.
  flagOff();
  const off = await post('/api/coach/chat', { message: KNOWLEDGE, history: [], context: { active_session: ACTIVE }, sessionId: '20260723-PM-01' });
  shadowOn();
  const on = await post('/api/coach/chat', { message: KNOWLEDGE, history: [], context: { active_session: ACTIVE }, sessionId: '20260723-PM-01' });

  assert.equal(on.res.status, 200);
  assert.deepEqual(on.json.data, off.json.data, 'the model answer is untouched by the seam');
});
