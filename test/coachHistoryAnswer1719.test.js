'use strict';

// Fable fix 13 (#1719) — deterministic history answer for POST /api/coach/chat.
//
// B2-1 (deflection, B-10): "What did I lift for bench last time?" is answered
//   from the deterministic record (the most recent PRIOR session's rows), not
//   with a session-status summary.
// B2-2 (fabrication, model up, B-03): with the model consulted, the served
//   numbers match the stored rows; today's planned 230x5 is never presented
//   as last session. Proved two ways: the lane answers before the model for a
//   recognized phrasing, and backstop C replaces a fabricated model reply for
//   a phrasing variant the lane misses ("What did I lift for bench?").
// B2-3 (model down, B-11): model unavailable → the same deterministic answer
//   from the read rows; a past-tense question is never answered from plan
//   values. The unconfigured path (no Sheets read) says plainly it cannot
//   look history up — never plan values.
//
// Failing-first: on the base head (no history lane, no HISTORY_RE guard in
// buildSessionQuestionAnswer, no backstop C) B2-1 serves the deflection,
// B2-2 serves the fabrication (or a session-state statement with no history
// rows), and B2-3 serves the plan answer (model-down) or "coach unavailable".

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-key-1719';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

const { todayIso } = require('../services/analytics');
const sessionQA = require('../services/sessionQuestionAnswer');
const grounding = require('../services/coachResponseGrounding');

// Log_Cleaned columns: date_clean|session_id|exercise|canonical_exercise|
// muscle_group|lift_code|set_number|weight|reps|rir|notes|volume_calc.
// One stable rows set for the whole file (the injected getSheetRows is cached
// 30s by index.js, so rows are held stable per file like coachChatGrounding).
const TODAY = todayIso();
const LOG_ROWS = [
  // Most recent PRIOR session for Bench Press — the bound facts.
  ['2026-08-05', '20260805-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 135, 12, 4, '', 1620],
  ['2026-08-05', '20260805-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 2, 185, 10, 2, '', 1850],
  ['2026-08-05', '20260805-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 3, 225, 6, 1, '', 1350],
  ['2026-08-05', '20260805-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 4, 225, 5, 1, '', 1125],
  ['2026-08-05', '20260805-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 5, 225, 5, 1, '', 1125],
  // Older session — must NOT be picked as "last time".
  ['2026-08-01', '20260801-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 185, 8, 3, '', 1480],
  ['2026-08-01', '20260801-AM-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 2, 185, 8, 3, '', 1480],
  // TODAY's in-progress session — must NEVER be "last time".
  [TODAY, 'today-session-01', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 235, 3, 1, '', 705],
];

const BENCH_PLAN = {
  current_plan: [{ name: 'Bench Press', sets: 5, reps: 5, weight: 230, rir: 1 }],
  plan_completed: [],
};
const TWO_LIFT_PLAN = {
  current_plan: [
    { name: 'Bench Press', sets: 5, reps: 5, weight: 230, rir: 1 },
    { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
  ],
  plan_completed: [],
};

// ── Part A — the pure history lane ──────────────────────────────────────────

test('A1. bindLastSessionFacts picks the most recent PRIOR session, in sheet order', () => {
  const facts = sessionQA.bindLastSessionFacts('Bench Press', LOG_ROWS, { today: TODAY });
  assert.ok(facts, 'facts bind');
  assert.equal(facts.sessionId, '20260805-AM-01');
  assert.equal(facts.date, '2026-08-05');
  assert.equal(facts.liftName, 'Bench Press');
  assert.deepEqual(facts.sets.map((s) => [s.weight, s.reps, s.rir]), [
    [135, 12, 4], [185, 10, 2], [225, 6, 1], [225, 5, 1], [225, 5, 1],
  ]);
  assert.ok(!facts.sets.some((s) => s.weight === 235), "today's partial sets are never 'last time'");
  assert.ok(!facts.sets.some((s) => s.weight === 185 && s.reps === 8), 'the older session is not picked');
});

test('A2. bindLastSessionFacts excludes the current session by id', () => {
  const facts = sessionQA.bindLastSessionFacts('Bench Press', LOG_ROWS, { currentSessionId: 'today-session-01', today: TODAY });
  assert.ok(facts, 'falls back to the most recent prior session');
  assert.equal(facts.sessionId, '20260805-AM-01');
  assert.deepEqual(facts.sets.map((s) => [s.weight, s.reps, s.rir]), [
    [135, 12, 4], [185, 10, 2], [225, 6, 1], [225, 5, 1], [225, 5, 1],
  ]);
  // The id exclusion is precise: excluding a different session id does not
  // blanket-exclude today's sessions — only the current session is excluded,
  // so another session from today still counts as prior.
  const other = sessionQA.bindLastSessionFacts('Bench Press', LOG_ROWS, { currentSessionId: '20260805-AM-01', today: TODAY });
  assert.equal(other.sessionId, 'today-session-01');
});

test('A3. bindLastSessionFacts returns null for a lift with no logged rows', () => {
  assert.equal(sessionQA.bindLastSessionFacts('Back Squat', LOG_ROWS, { today: TODAY }), null);
});

test('A4. answerHistoryQuestion formats the bound answer with explicit provenance', () => {
  const ans = sessionQA.answerHistoryQuestion('What did I lift for bench last time?', {
    history: [], clientContext: BENCH_PLAN, logRows: LOG_ROWS, lastDiscussedLift: null,
    currentSessionId: null, today: TODAY,
  });
  assert.ok(ans, 'an answer is returned');
  assert.equal(ans.kind, 'answer');
  assert.match(ans.text, /2026-08-05/);
  assert.match(ans.text, /20260805-AM-01/);
  assert.match(ans.text, /135x12 RIR4/);
  assert.match(ans.text, /185x10 RIR2/);
  assert.match(ans.text, /225x6 RIR1/);
  assert.match(ans.text, /225x5 RIR1/);
  assert.doesNotMatch(ans.text, /230/, 'today\'s planned 230 is never the history answer');
  assert.doesNotMatch(ans.text, /235/, "today's partial sets are never the history answer");
  assert.ok(ans.facts, 'the bound facts ride along for backstop C');
  assert.equal(ans.facts.sessionId, '20260805-AM-01');
});

test('A5. answerHistoryQuestion says plainly when there is no logged last session', () => {
  const ans = sessionQA.answerHistoryQuestion('What did I lift for squat last time?', {
    history: [], clientContext: BENCH_PLAN, logRows: LOG_ROWS, lastDiscussedLift: null,
    currentSessionId: null, today: TODAY,
  });
  assert.ok(ans, 'an answer is returned');
  assert.equal(ans.kind, 'no-record');
  assert.match(ans.text, /don't have a logged last session/i);
  assert.doesNotMatch(ans.text, /230/, 'never the plan value');
  assert.equal(ans.facts, null);
});

test('A6. answerHistoryQuestion clarifies when no lift can be resolved', () => {
  const ans = sessionQA.answerHistoryQuestion('What did I lift last time?', {
    history: [], clientContext: TWO_LIFT_PLAN, logRows: LOG_ROWS, lastDiscussedLift: null,
    currentSessionId: null, today: TODAY,
  });
  assert.ok(ans, 'an answer is returned');
  assert.equal(ans.kind, 'clarify');
  assert.match(ans.text, /for which lift/i);
  assert.match(ans.text, /Bench Press/);
  assert.match(ans.text, /Seated Row/);
  assert.equal(ans.facts, null);
});

test('A7. answerHistoryQuestion says it cannot look history up when no rows were read', () => {
  const ans = sessionQA.answerHistoryQuestion('What did I lift for bench last time?', {
    history: [], clientContext: BENCH_PLAN, logRows: null, lastDiscussedLift: null,
    currentSessionId: null, today: TODAY,
  });
  assert.ok(ans, 'an answer is returned');
  assert.equal(ans.kind, 'unavailable');
  assert.match(ans.text, /can't look up your training history/i);
  assert.doesNotMatch(ans.text, /230|225/, 'never plan or guessed numbers');
  assert.equal(ans.facts, null);
});

test('A8. B-11: buildSessionQuestionAnswer defers past-tense questions (HISTORY_RE guard)', () => {
  const ctx = BENCH_PLAN;
  assert.equal(
    sessionQA.buildSessionQuestionAnswer('how much did I bench last time?', {
      history: [], clientContext: ctx,
      resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 5, rir: 1 }),
    }),
    null,
    'a past-tense weight question is never answered from the plan / engine target',
  );
  assert.match(
    sessionQA.buildSessionQuestionAnswer('how much for bench?', {
      history: [], clientContext: ctx,
      resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 5, rir: 1 }),
    }),
    /Bench Press: 230 lbs/,
    'the present-tense question still answers from the plan',
  );
});

test('A9. isHistoryQuestion recognizes the B2 phrasings and not present-tense asks', () => {
  assert.equal(sessionQA.isHistoryQuestion('What did I lift for bench last time?'), true);
  assert.equal(sessionQA.isHistoryQuestion('how much did I bench last session?'), true);
  assert.equal(sessionQA.isHistoryQuestion('how much for bench?'), false);
  assert.equal(sessionQA.isHistoryQuestion('what is my bench today?'), false);
});

test('A10. backstop C: a fabricated history number is flagged; a true one passes', () => {
  const facts = sessionQA.bindLastSessionFacts('Bench Press', LOG_ROWS, { today: TODAY });
  assert.ok(grounding.detectUngroundedHistoryNumbers('You benched 230 lbs for 5 reps.', facts).length > 0,
    'the planned 230 is not a recorded last-session number');
  assert.ok(grounding.detectUngroundedHistoryNumbers('Last time you benched 230 lbs.', facts).length > 0,
    'the plan value fails even with history framing');
  assert.equal(grounding.detectUngroundedHistoryNumbers('You benched 225 for 5 reps.', facts).length, 0,
    'the recorded 225x5 is grounded');
  assert.equal(grounding.detectUngroundedHistoryNumbers('You benched 135 for 12 reps at 4 RIR.', facts).length, 0,
    'the recorded first set is grounded');
  assert.equal(grounding.detectUngroundedHistoryNumbers('Nice work on bench today.', facts).length, 0,
    'prose with no numbers has nothing to judge');
  assert.ok(grounding.detectUngroundedHistoryNumbers('You did 3 sets last time.', facts).length > 0,
    'the recorded session has 5 sets, not 3');
  assert.equal(grounding.detectUngroundedHistoryNumbers('You did 5 sets last time.', facts).length, 0,
    'the recorded set count is grounded');
  assert.equal(grounding.detectUngroundedHistoryNumbers('You benched 225 for 5 reps.', null).length, 0,
    'no bound facts means nothing to judge');
});

// ── Part B — the live route ─────────────────────────────────────────────────

const sheetsState = { logRows: LOG_ROWS };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by the read-only chat path'); },
  deleteRowsByRange: async () => { throw new Error('no deletes on the chat path'); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async (name) => (name === 'Log_Cleaned' ? sheetsState.logRows.slice() : []),
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = { id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets };
require.cache[require.resolve('../services/vision')] = { id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) } };

const coachState = {
  configured: true,
  reply: 'ok',
  throwError: false,
  propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null,
  violations: [],
  chatReplyCalls: 0,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateChatReply: async () => {
      coachState.chatReplyCalls += 1;
      if (coachState.throwError) throw new Error('model down (test stub)');
      return {
        reply: coachState.reply,
        propose_edit: coachState.propose_edit,
        propose_note: coachState.propose_note,
        propose_constraint: coachState.propose_constraint,
        propose_plan_edit: coachState.propose_plan_edit,
      };
    },
    findRegisterViolations: () => coachState.violations,
    looksLikePrClaim: () => false,
    generateCoachMessage: async () => 'Solid work.',
    generatePlanMessage: async () => 'Solid work.',
    sanitizeFacts: (f) => f,
  },
};

const responseSheet = require('../services/coachResponseSheet');
const discussionReferent = require('../services/coachDiscussionReferent');
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
  finally { console.log = originalConsoleLog; delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_PROFILE_GOAL; }
});

function resetCoach() {
  coachState.configured = true;
  coachState.reply = 'ok';
  coachState.throwError = false;
  coachState.propose_edit = null; coachState.propose_note = null; coachState.propose_constraint = null; coachState.propose_plan_edit = null;
  coachState.violations = [];
  coachState.chatReplyCalls = 0;
  discussionReferent._resetForTesting();
}

async function post(body) {
  appended.length = 0;
  installCapture();
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (appended.length) break; }
  await responseSheet._flushForTesting();
  return { res, json };
}

test('B2-1. The history question is answered from the record, not deflected (model never consulted)', async () => {
  resetCoach();
  // The exact production deflection: a session-status summary.
  coachState.reply = 'Logged this session: Bench Press. Still remaining: Seated Row.';
  const { res, json } = await post({ message: 'What did I lift for bench last time?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the deterministic lane answers before the model');
  assert.equal(json.data.source, 'engine');
  const msg = json.data.message;
  assert.match(msg, /2026-08-05/, 'provenance: the session date');
  assert.match(msg, /20260805-AM-01/, 'provenance: the session id');
  assert.match(msg, /135x12 RIR4/);
  assert.match(msg, /225x5 RIR1/);
  assert.doesNotMatch(msg, /230/, "today's planned 230 is never presented as last session");
  assert.doesNotMatch(msg, /235/, "today's partial sets are never 'last time'");
  assert.doesNotMatch(msg, /Logged this session/, 'no session-status deflection');
});

test('B2-2a. Backstop C: a fabricated model reply to a variant phrasing is replaced with the bound answer', async () => {
  resetCoach();
  // Variant phrasing the lane misses (no HISTORY_RE token): the model IS consulted.
  coachState.reply = 'You benched 230 lbs for 5 reps.';
  const { res, json } = await post({ message: 'What did I lift for bench?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'the model was consulted for the variant phrasing');
  assert.equal(json.data.source, 'engine', 'the fabricated reply is replaced, not served');
  const msg = json.data.message;
  assert.match(msg, /20260805-AM-01/);
  assert.match(msg, /225x5 RIR1/);
  assert.doesNotMatch(msg, /230/, 'the planned 230 never reaches the athlete as history');
  assert.equal(json.data.propose_edit, null);
  assert.equal(json.data.propose_plan_edit, null);
});

test('B2-2b. Control: a true model reply to the variant phrasing passes through untouched', async () => {
  resetCoach();
  coachState.reply = 'You benched 225 for 5 reps.';
  const { res, json } = await post({ message: 'What did I lift for bench?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1);
  assert.equal(json.data.source, 'gemini', 'grounded model prose is served as the model reply');
  assert.equal(json.data.message, 'You benched 225 for 5 reps.');
});

test('B2-2c. Pre-review guard: a correct TODAY answer is never replaced by last session (backstop C false positive)', async () => {
  resetCoach();
  // "What did I bench today?" is a TODAY question, not a history question — the broad
  // trigger must not bind last session's facts for it, or backstop C would judge the
  // true 235x3 against the 2026-08-05 sets and replace it with a wrong answer. The
  // reply carries "lbs" so C's number parser actually reads it (a bare "235 for 3"
  // has no parseable reading and would pass vacuously).
  coachState.reply = 'You benched 235 lbs for 3 reps today.';
  const { res, json } = await post({ message: 'What did I bench today?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'the model answers the today question');
  assert.equal(json.data.source, 'gemini', "today's true numbers are served, not replaced");
  assert.equal(json.data.message, 'You benched 235 lbs for 3 reps today.');
  assert.doesNotMatch(json.data.message, /20260805-AM-01/, "last session's numbers never answer a today question");
});

test('B2-3a. Model down: the same deterministic answer comes from the read rows', async () => {
  resetCoach();
  coachState.throwError = true;
  const { res, json } = await post({ message: 'What did I lift for bench last time?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  assert.equal(json.data.source, 'engine');
  const msg = json.data.message;
  assert.match(msg, /20260805-AM-01/);
  assert.match(msg, /225x5 RIR1/);
  assert.doesNotMatch(msg, /230/, 'no plan value on the model-down path');
  assert.doesNotMatch(msg, /coach unavailable/i, 'the lifter is not dead-ended');
});

test('B2-3b. Model down (B-11): a past-tense weight question is never answered from the plan', async () => {
  resetCoach();
  coachState.throwError = true;
  const { res, json } = await post({ message: 'how much did I bench last time?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  const msg = json.data.message;
  assert.match(msg, /20260805-AM-01/, 'the history lane owns the past-tense question');
  assert.doesNotMatch(msg, /Bench Press: 230 lbs/, 'the plan value is never the history answer');
});

test('B2-3c. Unconfigured: the route says plainly it cannot look history up', async () => {
  resetCoach();
  coachState.configured = false;
  const { res, json } = await post({ message: 'What did I lift for bench last time?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  assert.match(json.data.message, /can't look up your training history/i);
  assert.doesNotMatch(json.data.message, /230|225/, 'never plan or guessed numbers');
});

test('B2-1b. No logged last session: the honest floor, never the plan', async () => {
  resetCoach();
  coachState.reply = 'Logged this session: Bench Press. Still remaining: Seated Row.';
  const { res, json } = await post({ message: 'What did I lift for squat last time?', context: BENCH_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the lane answers before the model');
  assert.match(json.data.message, /don't have a logged last session/i);
  assert.doesNotMatch(json.data.message, /230/, 'never the plan value');
});

test('B2-1c. Ambiguous lift: the lane clarifies instead of guessing a lift', async () => {
  resetCoach();
  coachState.reply = 'Logged this session: Bench Press. Still remaining: Seated Row.';
  const { res, json } = await post({ message: 'What did I lift last time?', context: TWO_LIFT_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the lane answers before the model');
  assert.match(json.data.message, /for which lift/i);
  assert.match(json.data.message, /Bench Press/);
  assert.match(json.data.message, /Seated Row/);
});
