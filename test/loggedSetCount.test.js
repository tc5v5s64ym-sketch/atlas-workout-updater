'use strict';

// Issue #1525 — mid-session "how many sets have I done?" must equal the sets
// actually logged, not plan_completed's length and not the prescribed count.
//
// Filed state: 2 sets of one exercise + 1 of another (3 total) was answered
// "2 sets". On current s3-maintenance the phrasing is unclaimed, the model-down
// path answers the prescription ("Back Squat: 4 sets."), and neither completion
// nor recap backstop rejects "You've done 2 sets."

const test = require('node:test');
const assert = require('node:assert/strict');
const grounding = require('../services/coachResponseGrounding');

function issueContext() {
  return {
    current_plan: [
      { name: 'Back Squat', sets: 4, reps: 5, weight: 225, rir: 2 },
      { name: 'Bench Press', sets: 3, reps: 8, weight: 185, rir: 2 },
    ],
    plan_completed: ['Back Squat', 'Bench Press'],
    plan_state: {
      planned: ['Back Squat', 'Bench Press'],
      completed: ['Back Squat', 'Bench Press'],
      remaining: [],
      isComplete: false,
    },
    session_tally: {
      exercises: [
        { exercise: 'Back Squat', sets: 2, per_set: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 5, rir: 2 }], planned: true },
        { exercise: 'Bench Press', sets: 1, per_set: [{ weight: 185, reps: 8, rir: 2 }], planned: true },
      ],
      total_working_sets: 3,
    },
  };
}

test('classifier claims the filed phrasing and close logged-count variants only', () => {
  for (const q of [
    'how many sets have I done?',
    'How many sets have I done',
    'ok, how many sets have I done?',
    'how many sets have I logged?',
    'how many sets did I do?',
    'how many sets did I log so far?',
    'how many working sets have I done?',
    'how many sets have I done today?',
    'how many sets of bench have I done?',
    'how many bench sets have I done?',
    "I've done how many sets?",
  ]) {
    assert.equal(grounding.isLoggedSetCountQuestion(q), true, q);
  }
  for (const q of [
    'how many sets?',
    'how many sets for bench?',
    'how many sets left?',
    'how many sets do I have left?',
    'how many sets should I do?',
    'how many sets are planned?',
    'how many sets did I do last time?',
    'how many reps have I done?',
    'how many sets and reps have I done?',
    'why have I done so many sets?',
    'how many warm up sets have I done?',
    'how many sets have I done last session?',
  ]) {
    assert.equal(grounding.isLoggedSetCountQuestion(q), false, q);
  }
});

test('the filed 2+1 session is answered as 3 logged sets, not 2 and not the prescription', () => {
  const heard = grounding.buildLoggedSetCountAnswer('how many sets have I done?', issueContext());
  assert.equal(heard, '3 sets logged this session: Back Squat 2, Bench Press 1.');
  assert.doesNotMatch(heard, /\b2 sets\b/);
  assert.doesNotMatch(heard, /\b4 sets\b/);
});

test('a named lift reports its logged sets, not the prescribed count', () => {
  const ctx = issueContext();
  assert.equal(
    grounding.buildLoggedSetCountAnswer('how many sets of bench have I done?', ctx),
    'Bench Press: 1 set logged this session.'
  );
  assert.equal(
    grounding.buildLoggedSetCountAnswer('how many sets have I done for squat?', ctx),
    'Back Squat: 2 sets logged this session.'
  );
});

test('an absent tally is not filled from plan_completed', () => {
  const ctx = issueContext();
  delete ctx.session_tally;
  const heard = grounding.buildLoggedSetCountAnswer('how many sets have I done?', ctx);
  assert.equal(heard, "I don't have this session's set tally, so I can't say how many sets are logged.");
  assert.doesNotMatch(heard, /\d/);
});

test('a present empty tally says nothing is logged yet', () => {
  const ctx = issueContext();
  ctx.session_tally = { exercises: [], total_working_sets: 0 };
  assert.equal(
    grounding.buildLoggedSetCountAnswer('how many sets have I done?', ctx),
    'No working sets logged this session yet.'
  );
});

test('an unresolvable lift is not answered with another lift\'s count', () => {
  const heard = grounding.buildLoggedSetCountAnswer('how many sets of good morning have I done?', issueContext());
  assert.equal(heard, "I can't tell which lift that is, so I won't guess a set count.");
  assert.doesNotMatch(heard, /\d/);
});

// ── live /api/coach/chat ────────────────────────────────────────────────────

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;

const writeAttempts = [];
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tab, rows) => { writeAttempts.push({ tab, rows }); throw new Error('no writes on the coach chat path'); },
  deleteRowsByRange: async () => { throw new Error('no deletes'); },
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
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const coachState = { reply: "You've done 2 sets.", configured: true, calls: 0 };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateCoachMessage: async () => null,
    generatePlanMessage: async () => null,
    generateChatReply: async () => { coachState.calls += 1; return { reply: coachState.reply }; },
    findRegisterViolations: () => [],
    looksLikePrClaim: () => false,
    sanitizeFacts: (f) => f,
    sanitizeChatContext: (c) => c,
  },
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

async function chat(message, context, configured = true) {
  coachState.configured = configured;
  coachState.calls = 0;
  coachState.reply = "You've done 2 sets.";
  writeAttempts.length = 0;
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'test-api-key', 'x-atlas-request-origin': 'probe' },
    body: JSON.stringify({ message, context }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, data: body && body.data ? body.data : {}, calls: coachState.calls };
}

test('route: the model cannot answer the filed question with the exercise count', async () => {
  const { status, data, calls } = await chat('how many sets have I done?', issueContext(), true);
  assert.equal(status, 200);
  assert.equal(data.source, 'engine');
  assert.equal(data.message, '3 sets logged this session: Back Squat 2, Bench Press 1.');
  assert.equal(calls, 0, 'the model must not word this count');
  assert.equal(writeAttempts.length, 0);
});

test('route: model-down path reports the logged count, not the prescription', async () => {
  const { status, data, calls } = await chat('How many sets have I done?', issueContext(), false);
  assert.equal(status, 200);
  assert.equal(data.source, 'engine');
  assert.equal(data.message, '3 sets logged this session: Back Squat 2, Bench Press 1.');
  assert.doesNotMatch(String(data.message), /4 sets/);
  assert.equal(calls, 0);
});

test('route: "how many sets of bench have I done?" is the logged 1, not the prescribed 3', async () => {
  const { status, data } = await chat('how many sets of bench have I done?', issueContext(), true);
  assert.equal(status, 200);
  assert.equal(data.source, 'engine');
  assert.equal(data.message, 'Bench Press: 1 set logged this session.');
});

test('route: a prescription ask is not captured by the logged-count lane', async () => {
  const { status, data } = await chat('how many sets for bench?', issueContext(), true);
  assert.equal(status, 200);
  assert.equal(data.source, 'engine');
  assert.equal(data.message, 'Bench Press today: 3 sets.');
});
