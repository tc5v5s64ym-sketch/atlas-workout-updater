'use strict';

// #1342 — in-session working-weight finder (Corpus V2 §F.8) on the read-only
// /api/coach/message path. Proves the contract the corpus detector reads:
//   - a substituted block with no history for the logged lift enters finder
//     mode: `finder_mode: true` + the criterion / working weight / overshoot /
//     baseline on the response data, on EVERY return path (success, LLM-down,
//     LLM error, and the ack-only short-circuit the confirmation turn takes);
//   - the finder ruling reaches the model facts (sanitizeFacts whitelist);
//   - no finder without a substitution, and none when the logged lift already
//     has history (a benchmark exists);
//   - the canonical finder wordings stay numerically grounded (#1710), and a
//     wrong-load correction is flagged.
//
// Harness mirrors test/coach-message-block.test.js (require-cache stub
// injection). The finder engine stays REAL — only the Gemini voice module is
// stubbed, so the state under test is the real one.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';

const sheetState = { appendCalls: [], logRows: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only coach path');
  },
  deleteRowsByRange: async () => {},
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => sheetState.logRows,
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
const coachState = { configured: true, message: 'Nice work on that block.', throwError: null, calls: 0, lastFacts: null };
const fakeCoach = {
  isConfigured: () => coachState.configured,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async (facts) => {
    coachState.calls += 1;
    coachState.lastFacts = facts;
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
const { app, invalidateSheetRowsCache } = require('../index');
const { detectUngroundedMessageNumbers } = require('../services/coachResponseGrounding');

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
  coachState.lastFacts = null;
}

async function postBlock(facts) {
  // The app caches Log_Cleaned rows for 30s — bust it whenever the sheet
  // state changed, or the next probe reads the previous probe's rows.
  invalidateSheetRowsCache();
  const res = await fetch(`${baseUrl}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ kind: 'block', facts }),
  });
  const body = await res.json();
  return { res, body };
}

const SUB_S4 = { classification: 'substituted', prescribed: { name: 'Bench Press' }, logged: { name: 'Machine Chest Press' } };
const SUB_S11 = { classification: 'substituted', prescribed: { name: 'Cable Row' }, logged: { name: 'Plate-Loaded Row' } };
const S4_SETS = [
  { weight: 120, reps: 10, rir: 4 },
  { weight: 140, reps: 8, rir: 2 },
  { weight: 150, reps: 8, rir: 0 },
];

test('S4 turn 2: finder enters, 140 is the working weight, 150 overshot', async () => {
  resetCoach();
  sheetState.logRows = [];
  const { res, body } = await postBlock({
    exerciseName: 'Machine Chest Press', muscleGroup: 'Chest', todaySets: S4_SETS, substitution: SUB_S4,
  });
  assert.equal(res.status, 200);
  assert.equal(body.data.finder_mode, true);
  assert.deepEqual(body.data.finder.criterion, { reps: 8, rir: 2 });
  assert.equal(body.data.finder.status, 'overshot');
  assert.deepEqual(body.data.finder.working_weight, { weight: 140, reps: 8, rir: 2 });
  assert.deepEqual(body.data.finder.overshoot, { weight: 150, reps: 8, rir: 0 });
  assert.equal(body.data.finder.baseline, null);
  assert.equal(sheetState.appendCalls.length, 0, 'read-only route never writes');
});

test('S4 turn 3: confirmation sets baseline 140 8/2 x3 and the turn is not silent', async () => {
  resetCoach();
  sheetState.logRows = [];
  const { res, body } = await postBlock({
    exerciseName: 'Machine Chest Press', muscleGroup: 'Chest',
    todaySets: [{ weight: 140, reps: 8, rir: 2 }, { weight: 140, reps: 8, rir: 2 }],
    finder_prior_sets: S4_SETS,
  });
  assert.equal(res.status, 200);
  assert.equal(body.data.finder_mode, true);
  assert.equal(body.data.finder.status, 'baselined');
  assert.deepEqual(body.data.finder.baseline, { exercise: 'Machine Chest Press', weight: 140, reps: 8, rir: 2, sets: 3 });
  assert.notEqual(body.data.note_tier, 'ack_only', 'a finder ruling must not collapse to silent ack');
});

test('S11 turn 3: self-run finder baselines 230 10/2 x2 in one block', async () => {
  resetCoach();
  sheetState.logRows = [];
  const { res, body } = await postBlock({
    exerciseName: 'Plate-Loaded Row', muscleGroup: 'Back',
    todaySets: [
      { weight: 205, reps: 10, rir: 3 },
      { weight: 230, reps: 10, rir: 2 },
      { weight: 230, reps: 10, rir: 2 },
    ],
    substitution: SUB_S11,
  });
  assert.equal(res.status, 200);
  assert.equal(body.data.finder_mode, true);
  assert.equal(body.data.finder.status, 'baselined');
  assert.deepEqual(body.data.finder.working_weight, { weight: 230, reps: 10, rir: 2 });
  assert.equal(body.data.finder.overshoot, null);
  assert.deepEqual(body.data.finder.baseline, { exercise: 'Plate-Loaded Row', weight: 230, reps: 10, rir: 2, sets: 2 });
});

test('guard: history for the logged lift means no finder', async () => {
  resetCoach();
  sheetState.logRows = [
    ['2026-11-20', 'sess-1', '', '', '', 'MACHINE_CHEST_PRESS', '', 140, 8, 2, '', ''],
    ['2026-11-20', 'sess-1', '', '', '', 'MACHINE_CHEST_PRESS', '', 140, 8, 2, '', ''],
    ['2026-11-18', 'sess-0', '', '', '', 'MACHINE_CHEST_PRESS', '', 135, 8, 2, '', ''],
  ];
  try {
    const { res, body } = await postBlock({
      liftCode: 'MACHINE_CHEST_PRESS', exerciseName: 'Machine Chest Press', muscleGroup: 'Chest',
      todaySets: S4_SETS, substitution: SUB_S4,
    });
    assert.equal(res.status, 200);
    assert.equal(body.data.finder_mode, false);
    assert.equal(body.data.finder, null);
  } finally {
    sheetState.logRows = [];
  }
});

test('guard: a routine block with no substitution never enters the finder', async () => {
  resetCoach();
  sheetState.logRows = [];
  const { res, body } = await postBlock({
    exerciseName: 'Bicep Curl', muscleGroup: 'Arms',
    todaySets: [{ weight: 40, reps: 10, rir: 2 }, { weight: 40, reps: 10, rir: 2 }],
  });
  assert.equal(res.status, 200);
  assert.equal(body.data.finder_mode, false);
  assert.equal(body.data.finder, null);
  assert.equal(body.data.note_tier, 'ack_only', 'routine block stays silent');
});

test('finder state reaches the model facts so the LLM can word the ruling', async () => {
  resetCoach();
  sheetState.logRows = [];
  const { body } = await postBlock({
    exerciseName: 'Machine Chest Press', muscleGroup: 'Chest', todaySets: S4_SETS, substitution: SUB_S4,
  });
  assert.equal(coachState.calls, 1, 'a finder block calls the LLM');
  assert.ok(coachState.lastFacts, 'facts captured');
  assert.equal(coachState.lastFacts.finder.status, 'overshot');
  assert.equal(coachState.lastFacts.finder.working_weight.weight, 140);
  assert.equal(body.data.finder_mode, true);
});

test('finder fields ride the LLM-down and LLM-error responses too', async () => {
  sheetState.logRows = [];
  resetCoach({ configured: false });
  const down = await postBlock({
    exerciseName: 'Machine Chest Press', muscleGroup: 'Chest', todaySets: S4_SETS, substitution: SUB_S4,
  });
  assert.equal(down.res.status, 200);
  assert.equal(down.body.data.finder_mode, true);
  assert.equal(down.body.data.finder.status, 'overshot');

  resetCoach({ throwError: 'gemini down' });
  const failed = await postBlock({
    exerciseName: 'Machine Chest Press', muscleGroup: 'Chest', todaySets: S4_SETS, substitution: SUB_S4,
  });
  assert.equal(failed.res.status, 200);
  assert.equal(failed.body.data.finder_mode, true);
  assert.equal(failed.body.data.finder.working_weight.weight, 140);
});

// #1710 — the canonical finder wordings must stay numerically grounded, and a
// wrong-load correction must be flagged. Facts as the route passes them.
const S4_FACTS = {
  exerciseName: 'Machine Chest Press',
  todaySets: S4_SETS,
  finder: {
    exercise: 'Machine Chest Press', prescribed_exercise: 'Bench Press',
    criterion: { reps: 8, rir: 2 }, status: 'overshot',
    working_weight: { weight: 140, reps: 8, rir: 2 },
    overshoot: { weight: 150, reps: 8, rir: 0 }, baseline: null,
  },
};

test('grounding: the S4 overshoot ruling is grounded', () => {
  const findings = detectUngroundedMessageNumbers(
    '140 is the working weight. 150 overshot the target, so drop back to 140.',
    S4_FACTS, 'block');
  assert.deepEqual(findings, []);
});

test('grounding: the S4 baseline ruling is grounded', () => {
  const facts = {
    exerciseName: 'Machine Chest Press',
    todaySets: [{ weight: 140, reps: 8, rir: 2 }, { weight: 140, reps: 8, rir: 2 }],
    finder_prior_sets: S4_SETS,
    finder: {
      exercise: 'Machine Chest Press', prescribed_exercise: 'Bench Press',
      criterion: { reps: 8, rir: 2 }, status: 'baselined',
      working_weight: { weight: 140, reps: 8, rir: 2 },
      overshoot: { weight: 150, reps: 8, rir: 0 },
      baseline: { exercise: 'Machine Chest Press', weight: 140, reps: 8, rir: 2, sets: 3 },
    },
  };
  const findings = detectUngroundedMessageNumbers(
    'Good correction. 140 8/2 x3 is the baseline now — not 150.',
    facts, 'block');
  assert.deepEqual(findings, []);
});

test('grounding: a wrong-load correction is flagged', () => {
  const findings = detectUngroundedMessageNumbers(
    'Next, machine chest press at 155 for two sets.',
    S4_FACTS, 'block');
  assert.ok(findings.length > 0, '155 is not the engine working weight');
  assert.ok(findings.some((f) => f.kind === 'prescription_numbers'));
});
