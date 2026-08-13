'use strict';

// Phase 3 concern 2 — the InteractionTrace spans a REAL coach turn through the live
// /api/coach/message seam (not just the shadow unit). Proves the trust-critical
// contract: with the flag off the shadow is fully inert and the response is a normal
// 200; with ATLAS_INTERACTION_TRACE=shadow ONE minted turn id is threaded through
// every stage the turn passes (intent → session_snapshot → engine_decision →
// coaching_strategy → model_response → validator_result → rendered_output), the
// assembled trace is schema-valid, and the visible response is UNCHANGED — the
// shadow never blocks, alters, or writes.
//
// Harness mirrors test/coach-message-block.test.js (require-cache stub injection).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
// Default the shadow OFF; individual tests toggle it and restore it.
delete process.env.ATLAS_INTERACTION_TRACE;

const sheetState = { throwOnRead: false };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by the read-only coach path'); },
  deleteRowsByRange: async () => {},
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => { if (sheetState.throwOnRead) throw new Error('sheets down'); return []; },
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

const coachState = { configured: true, message: 'Solid work.', throwError: null };
const fakeCoach = {
  isConfigured: () => coachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async () => { if (coachState.throwError) throw new Error(coachState.throwError); return coachState.message; },
  generatePlanMessage: async () => { if (coachState.throwError) throw new Error(coachState.throwError); return coachState.message; },
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const shadow = require('../services/interactionTraceShadow');
const { validateInteractionTrace } = require('../services/interactionTrace');

const originalConsoleLog = console.log;
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
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
  }
});

function resetCoach({ configured = true, message = 'Solid work.', throwError = null } = {}) {
  coachState.configured = configured;
  coachState.message = message;
  coachState.throwError = throwError;
}

async function rawPost(kind, facts) {
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind, facts }),
  });
  const body = await res.json();
  return { res, body };
}

// The response-finished hook (res.on('finish')) runs asynchronously AFTER fetch
// resolves, so the record for a POST may land a tick later. Rather than resetting
// the ring buffer between tests (which races the still-pending hook of the prior
// turn), each POST records the buffer length first and waits for exactly its own new
// record to appear — the NEWEST entry beyond that mark is this POST's turn.
async function post(kind, facts, { expectTrace = true } = {}) {
  const before = shadow.getShadowLog().length;
  const { res, body } = await rawPost(kind, facts);
  for (let i = 0; i < 100; i++) {
    const len = shadow.getShadowLog().length;
    if (expectTrace && len > before) break;
    if (!expectTrace && i >= 3) break; // a few ticks are enough to prove nothing was recorded
    await new Promise((r) => setImmediate(r));
  }
  const log = shadow.getShadowLog();
  const trace = (expectTrace && log.length > before) ? log[log.length - 1] : null;
  return { res, body, trace, recordedSince: log.length - before };
}

const SET = { exerciseName: 'Bench Press', muscleGroup: 'Chest', liftCode: 'BPR01', todaySets: [{ weight: 225, reps: 5, rir: 2 }], rec: { target_rir: 2 } };

test('flag OFF: the shadow is inert — nothing recorded, response is a normal 200', async () => {
  delete process.env.ATLAS_INTERACTION_TRACE;
  resetCoach();
  const { res, body, recordedSince } = await post('set', SET, { expectTrace: false });
  assert.equal(res.status, 200);
  assert.equal(body.data.source, 'gemini', 'the model is still called; only the shadow is off');
  assert.equal(recordedSince, 0, 'no trace recorded when the flag is off');
});

test('flag ON: one turn id spans the full stage set, and the visible response is unchanged', async () => {
  // Capture the flag-OFF response for the same input to prove zero behavior change.
  delete process.env.ATLAS_INTERACTION_TRACE;
  resetCoach();
  const off = (await post('set', SET, { expectTrace: false })).body;

  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  resetCoach();
  const { res, body, trace } = await post('set', SET);
  // Zero behavior change: the coaching-relevant fields are identical with the shadow on.
  assert.equal(res.status, 200);
  assert.deepEqual(
    { message: body.data.message, source: body.data.source, voice: body.data.voice, configured: body.data.configured },
    { message: off.data.message, source: off.data.source, voice: off.data.voice, configured: off.data.configured },
    'the visible response must be identical whether the shadow is on or off',
  );

  assert.ok(trace, 'a spanning trace was recorded');
  assert.equal(trace.valid, true, `trace must be schema-valid; errors: ${trace.errors.join(' | ')}`);
  assert.equal(validateInteractionTrace(trace.trace).valid, true);
  assert.equal(trace.intent_type, 'set');
  assert.equal(trace.source, 'coach_message');
  assert.deepEqual(trace.trace.stages.map((s) => s.stage),
    ['intent', 'session_snapshot', 'engine_decision', 'coaching_strategy', 'model_response', 'validator_result', 'rendered_output']);
  assert.match(trace.trace.turn_id, /^turn:/);
  // model_response ok (Gemini was called even though the engine may suppress its prose),
  // rendered_output ok (200).
  assert.equal(trace.trace.stages.find((s) => s.stage === 'model_response').status, 'ok');
  assert.equal(trace.trace.stages.find((s) => s.stage === 'rendered_output').status, 'ok');
  // The stages this read-only route legitimately bypasses surface as `missing`.
  assert.deepEqual(trace.missing, ['parser', 'knowledge_retrieval', 'write_proof']);
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('flag ON: a routine block records model_response=skipped and validator_result=skipped', async () => {
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  resetCoach();
  // A routine block short-circuits to the silent ack: the LLM is never called and the
  // deterministic validator never runs.
  const { res, body, trace } = await post('block', { exerciseName: 'Bicep Curl', muscleGroup: 'Arms', todaySets: [{ weight: 40, reps: 10, rir: 2 }, { weight: 40, reps: 10, rir: 2 }] });
  assert.equal(res.status, 200);
  assert.equal(body.data.note_tier, 'ack_only');
  assert.equal(body.data.message, null);

  assert.ok(trace);
  assert.equal(trace.valid, true, `errors: ${trace.errors.join(' | ')}`);
  assert.equal(trace.trace.stages.find((s) => s.stage === 'model_response').status, 'skipped');
  assert.equal(trace.trace.stages.find((s) => s.stage === 'validator_result').status, 'skipped');
  delete process.env.ATLAS_INTERACTION_TRACE;
});

test('flag ON: a Sheets-read failure still degrades to 200 and still records a valid spanning trace', async () => {
  // The shadow must never block the graceful-degrade path. (session_snapshot's honest
  // 'error' status on an enrichment failure is asserted at the unit level — through the
  // route the injected getSheetRows cache can mask a late read failure, so here we prove
  // only the live-path guarantee: the turn still completes and the trace still assembles.)
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  resetCoach();
  sheetState.throwOnRead = true;
  try {
    const { res, trace } = await post('set', { exerciseName: 'Overhead Press', muscleGroup: 'Shoulders', liftCode: 'OHP01', todaySets: [{ weight: 95, reps: 5, rir: 2 }], rec: { target_rir: 2 } });
    assert.equal(res.status, 200, 'a Sheets failure still degrades to 200');
    assert.ok(trace, 'a spanning trace is still recorded on the degrade path');
    assert.equal(trace.valid, true, `errors: ${trace.errors.join(' | ')}`);
    assert.ok(trace.trace.stages.some((s) => s.stage === 'session_snapshot'), 'the session_snapshot stage is still recorded');
    assert.equal(trace.trace.stages.find((s) => s.stage === 'rendered_output').status, 'ok');
  } finally {
    sheetState.throwOnRead = false;
    delete process.env.ATLAS_INTERACTION_TRACE;
  }
});
