'use strict';

// PR-3 — per-exercise BLOCK coach note wired into the read-only /api/coach/message
// path. Proves the trust-critical contract the owner required:
//   - a routine block is acknowledgment-only (tier ack_only): no prose, LLM NOT called
//   - an interesting block produces a note (LLM prose, or the deterministic
//     engine line when the engine suppresses the prose / the LLM is down)
//   - an LLM failure degrades to 200 (never a 5xx) and never affects logging
//   - the endpoint never writes — the write path / trust loop are untouched
//
// Harness mirrors test/coach-ask-endpoint.test.js (require-cache stub injection).
// batchNoteFacts / coachNoteTier / setEffortSignals stay REAL — only the Gemini
// voice module is stubbed, so the tier classification under test is the real one.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// Plain stub — sheets.js is fully require-cache stubbed below, so the value is
// never used for real auth. Deliberately NOT a PEM block (the changed-file secret
// scanner flags a literal private-key header even in a test stub).
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

const sheetState = { appendCalls: [], deleteCalls: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only coach path');
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

// Controllable coach voice: track call count + toggle configured/message/throw.
const coachState = { configured: true, message: 'Nice work on that block.', throwError: null, calls: 0 };
const fakeCoach = {
  isConfigured: () => coachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async () => {
    coachState.calls += 1;
    if (coachState.throwError) throw new Error(coachState.throwError);
    return coachState.message;
  },
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
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
  finally { console.log = originalConsoleLog; }
});

function resetCoach({ configured = true, message = 'Nice work on that block.', throwError = null } = {}) {
  coachState.configured = configured;
  coachState.message = message;
  coachState.throwError = throwError;
  coachState.calls = 0;
}

async function postBlock(facts) {
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind: 'block', facts }),
  });
  const body = await res.json();
  return { res, body };
}

// A routine block: two clean working sets at the target RIR, an accessory lift,
// no rec → no verdicts. The real classifier returns ack_only.
const ROUTINE_BLOCK = { exerciseName: 'Bicep Curl', muscleGroup: 'Arms', todaySets: [{ weight: 40, reps: 10, rir: 2 }, { weight: 40, reps: 10, rir: 2 }] };
// An interesting block: a heavy compound taken to RIR 0 (redline) → the real
// classifier returns extended / form_safety, and the engine emits an effort_note.
const REDLINE_BLOCK = { exerciseName: 'Bench Press', muscleGroup: 'Chest', todaySets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 3, rir: 0 }] };

test('routine block → ack_only, no prose, and the LLM is never called', async () => {
  resetCoach();
  const { res, body } = await postBlock(ROUTINE_BLOCK);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'ack_only');
  assert.equal(body.data.message, null, 'routine block must carry no coaching prose');
  assert.equal(body.data.effort_note, null, 'routine block must carry no deterministic effort line');
  assert.equal(coachState.calls, 0, 'a routine block must not call the LLM');
});

test('interesting block → extended tier and a note (deterministic line when prose is engine-owned)', async () => {
  resetCoach();
  const { res, body } = await postBlock(REDLINE_BLOCK);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.note_trigger, 'form_safety');
  // The frontend renders `message || effort_note`. For a redline the engine may
  // suppress the LLM prose, but a note must still be available via effort_note.
  const note = (typeof body.data.message === 'string' && body.data.message.trim())
    || (typeof body.data.effort_note === 'string' && body.data.effort_note.trim());
  assert.ok(note, 'an interesting block must produce a renderable note');
  assert.ok(coachState.calls >= 1, 'a non-routine block words via the coach voice');
});

test('PR (new working ground) via rec → extended / pr_milestone, LLM prose surfaces', async () => {
  resetCoach({ message: 'New working best — clean bar speed.' });
  const facts = {
    exerciseName: 'Back Squat', muscleGroup: 'Legs',
    todaySets: [{ weight: 275, reps: 3, rir: 2 }],
    rec: { progression_verdict: { level: 'new_ground' } },
  };
  const { res, body } = await postBlock(facts);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.note_trigger, 'pr_milestone');
  assert.equal(body.data.message, 'New working best — clean bar speed.');
});

test('LLM failure on an interesting block → still 200, logging unaffected, note degrades to the engine line', async () => {
  resetCoach({ throwError: 'gemini exploded' });
  const { res, body } = await postBlock(REDLINE_BLOCK);
  assert.equal(res.status, 200, 'an LLM failure must never surface as a non-200');
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.message, null, 'suppressed/failed prose is null');
  assert.ok(typeof body.data.effort_note === 'string' && body.data.effort_note.trim(), 'the deterministic engine line still carries the note');
  assert.ok(body.data.error, 'the degrade path reports the underlying error');
});

test('unconfigured coach → 200 with tier intact and no thrown error', async () => {
  resetCoach({ configured: false });
  const { res, body } = await postBlock(REDLINE_BLOCK);
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'extended');
  assert.equal(body.data.configured, false);
  assert.equal(coachState.calls, 0, 'an unconfigured coach never calls the LLM');
});

test('the block coach path never writes to any sheet (trust loop / write path untouched)', async () => {
  resetCoach();
  await postBlock(ROUTINE_BLOCK);
  await postBlock(REDLINE_BLOCK);
  await postBlock({ exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 0 }] });
  assert.equal(sheetState.appendCalls.length, 0, 'coach note path must never append rows');
  assert.equal(sheetState.deleteCalls.length, 0, 'coach note path must never delete rows');
});

test('regression: a plain kind:set request is undisturbed (note_tier null)', async () => {
  resetCoach();
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind: 'set', facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225, reps: 5, rir: 2 }] } }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, null, 'set kind must not carry a block note tier');
});
