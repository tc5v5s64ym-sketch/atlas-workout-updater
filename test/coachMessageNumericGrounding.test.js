'use strict';

// #1710 — route-level tests: the audit's B1 narration probes must NOT reach the
// athlete through /api/coach/message anymore, while honest grounded prose
// still does. Harness mirrors test/coach-message-block.test.js (require-cache
// stub injection; the REAL route + REAL services/coachResponseGrounding are
// exercised — only the Gemini voice module and sheet reads are stubbed).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

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
const fakeVision = { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) };
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: fakeVision,
};

// Controllable coach voice: the audit's lying outputs, verbatim, plus honest controls.
const coachState = { configured: true, setMessage: '', planMessage: '', calls: 0 };
const fakeCoach = {
  isConfigured: () => coachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async () => { coachState.calls += 1; return coachState.setMessage; },
  generatePlanMessage: async () => { coachState.calls += 1; return coachState.planMessage; },
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

function resetCoach({ setMessage = '', planMessage = '' } = {}) {
  coachState.setMessage = setMessage;
  coachState.planMessage = planMessage;
  coachState.calls = 0;
}

async function postMessage(kind, facts) {
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind, facts }),
  });
  const body = await res.json();
  return { res, body };
}

// Bench Press 135x8 logged (no RIR, so the engine voice defers to the prose —
// the configuration under which the audit's set lie leaked); next target 135x8x3.
const SET_FACTS = {
  exerciseName: 'Bench Press',
  todaySets: [{ weight: 135, reps: 8 }],
  rec: { target_rir: 2, next_target: { weight: 135, reps: 8, sets: 3 } },
};

// Plan facts carry NO prescription numbers at all.
const PLAN_FACTS = {
  label: 'Build strength',
  focus: 'Squat pattern',
  why_today: ['Squat pattern is fresh'],
  readiness: [{ pattern: 'squat', status: 'fresh' }],
  data_points: [{ label: 'Sessions this week', value: '3', context: 'week' }],
};

// ── B1 audit probes: the lies must not reach the athlete ────────────────────

test('B1-set-lying: invented 315x12 + Deadlift prescription suppresses to null', async () => {
  resetCoach({ setMessage: 'You lifted 315 for 12 reps. Next do Deadlift at 225.' });
  const { res, body } = await postMessage('set', SET_FACTS);
  assert.equal(res.status, 200);
  assert.equal(body.data.message, null, 'ungrounded numbers must suppress the model prose');
  assert.equal(body.data.source, 'gemini');
  assert.equal(coachState.calls, 1, 'the LLM was still called; the validator rejects after');
});

test('B1-plan-lying: invented Deadlift 315 5x12 + add-20 suppresses to null', async () => {
  resetCoach({ planMessage: 'Today do Deadlift at 315 for 5 sets of 12 reps; then add 20 next session.' });
  const { res, body } = await postMessage('plan', PLAN_FACTS);
  assert.equal(res.status, 200);
  assert.equal(body.data.message, null, 'an invented prescription must suppress the model prose');
  assert.equal(body.data.source, 'gemini');
});

test('mutation claim on the message path suppresses to null', async () => {
  resetCoach({ setMessage: "I've updated the plan to add Deadlift." });
  const { res, body } = await postMessage('set', SET_FACTS);
  assert.equal(res.status, 200);
  assert.equal(body.data.message, null);
});

// ── Honest controls: grounded prose still reaches the athlete ───────────────

test('honest set recap of the logged set passes through verbatim', async () => {
  resetCoach({ setMessage: 'You lifted 135 for 8 reps — clean and controlled.' });
  const { res, body } = await postMessage('set', SET_FACTS);
  assert.equal(res.status, 200);
  assert.equal(body.data.message, 'You lifted 135 for 8 reps — clean and controlled.');
});

test('honest next-target prescription passes through verbatim', async () => {
  resetCoach({ setMessage: 'Next up is Bench Press at 135 for 8 reps across 3 sets.' });
  const { res, body } = await postMessage('set', SET_FACTS);
  assert.equal(res.status, 200);
  assert.equal(body.data.message, 'Next up is Bench Press at 135 for 8 reps across 3 sets.');
});

test('honest number-free plan prose passes through verbatim', async () => {
  resetCoach({ planMessage: 'Squat pattern is fresh today — a good day to push the main lift.' });
  const { res, body } = await postMessage('plan', PLAN_FACTS);
  assert.equal(res.status, 200);
  assert.equal(body.data.message, 'Squat pattern is fresh today — a good day to push the main lift.');
});
