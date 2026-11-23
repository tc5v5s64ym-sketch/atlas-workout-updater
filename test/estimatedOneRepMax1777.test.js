'use strict';

// #1777 — Coach Q&A: estimated 1RM from a reps-to-failure set (deterministic Epley calculator).
// Proving probes, failing-first on base b557bb44. Harness: require-cache stubs for sheets +
// vision + coach, the real Express app, HTTP requests (per test/coach-ask-endpoint.test.js
// and test/coachChatGrounding.test.js). The REAL trainingSME / coachOps routes are exercised;
// only the Gemini reply and sheet reads are stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-key-1777';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

// Log_Cleaned rows for the history-boundary variant (V3): three flat Bench sessions at 225x5.
const LOG_ROWS = [
  ['2026-07-01', 's1', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 225, 5, 2, '', 1125],
  ['2026-07-03', 's2', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 225, 5, 2, '', 1125],
  ['2026-07-05', 's3', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 225, 5, 2, '', 1125],
];

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by a read-only coach route'); },
  deleteRowsByRange: async () => { throw new Error('no deletes on a coach route'); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async (name) => (name === 'Log_Cleaned' ? LOG_ROWS.slice() : []),
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = {
  id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets,
};
require.cache[require.resolve('../services/vision')] = {
  id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const coachState = {
  configured: false,
  reply: 'ok',
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
  finally { console.log = originalConsoleLog; delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_PROFILE_GOAL; }
});

function resetCoach() {
  coachState.configured = false;
  coachState.reply = 'ok';
  coachState.propose_edit = null; coachState.propose_note = null;
  coachState.propose_constraint = null; coachState.propose_plan_edit = null;
  coachState.violations = [];
  coachState.chatReplyCalls = 0;
}

async function ask(message) {
  resetCoach();
  const res = await fetch(`${baseUrl}/api/coach/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ message }),
  });
  const body = await res.json();
  return { res, body, data: body && body.data };
}

async function chat(message, context) {
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ message, history: [], context: context || {} }),
  });
  const body = await res.json();
  return { res, body, data: body && body.data };
}

// ── Unit: the Epley calculator itself ──────────────────────────────────────────

test('#1777 unit: Epley rounds to the nearest whole unit; reps=1 returns the weight; reps>12 is rough', () => {
  const m = require('../services/estimatedOneRepMax');
  assert.equal(m.estimateOneRepMax({ weight: 225, reps: 6 }).value, 270);
  assert.equal(m.estimateOneRepMax({ weight: 100, reps: 6 }).value, 120);
  assert.equal(m.estimateOneRepMax({ weight: 315, reps: 3 }).value, 347);
  assert.equal(m.estimateOneRepMax({ weight: 405, reps: 5 }).value, 473);
  assert.equal(m.estimateOneRepMax({ weight: 225, reps: 1 }).value, 225);
  assert.equal(m.estimateOneRepMax({ weight: 225, reps: 1 }).rough, false);
  assert.equal(m.estimateOneRepMax({ weight: 225, reps: 20 }).value, 375);
  assert.equal(m.estimateOneRepMax({ weight: 225, reps: 20 }).rough, true);
  assert.equal(m.estimateOneRepMax({ weight: 225, reps: 12 }).rough, false);
  assert.equal(m.estimateOneRepMax({ weight: 225, reps: 13 }).rough, true);
});

// ── Acceptance probe 1: Dale's exact question ──────────────────────────────────

test('#1777 P1: Dale\'s exact question -> 270 lb, labelled an estimate', async () => {
  const { res, data } = await ask('If I bench press 225 pounds six times till failure, what is my one rep max?');
  assert.equal(res.status, 200);
  assert.notEqual(data.depth, 'log_only', 'the question must not be swallowed as a log entry');
  assert.ok(data.answer, 'an answer must be served');
  assert.match(data.answer, /270/, `answer must carry 270: ${data.answer}`);
  assert.match(data.answer, /lb/i, 'answer must carry the stated unit');
  assert.match(data.answer, /estimat/i, 'the value must be labelled an estimate, never a measured max');
  assert.equal(data.source, 'training_sme');
});

// ── Acceptance probe 2: rewordings, incl. a kg variant ─────────────────────────

const REWORDINGS = [
  ['how much could I max if I got 225 for 6?', '270', null],
  ['225x6 to failure — what\'s that as a single?', '270', null],
  ['what\'s my estimated max on bench if I hit 100 kg for 6?', '120', /kg/i],
  ['If I squat 315 pounds for 3 reps to failure, what\'s my 1RM?', '347', /lb/i],
  ['deadlift 405 lb x 5 — what would my one rep max be?', '473', /lb/i],
];

for (const [question, expected, unitRe] of REWORDINGS) {
  test(`#1777 P2: rewording -> ${expected} (${question.slice(0, 48)}…)`, async () => {
    const { res, data } = await ask(question);
    assert.equal(res.status, 200);
    assert.ok(data.answer, 'an answer must be served');
    assert.match(data.answer, new RegExp(expected), `answer must carry ${expected}: ${data.answer}`);
    assert.match(data.answer, /estimat/i, 'the value must be labelled an estimate');
    if (unitRe) assert.match(data.answer, unitRe, `answer must carry the stated unit: ${data.answer}`);
  });
}

test('#1777 P2b: an unstated unit is never invented', async () => {
  const { data } = await ask('225x6 to failure — what\'s that as a single?');
  assert.ok(data.answer);
  assert.match(data.answer, /270/, 'the value is 270');
  assert.doesNotMatch(data.answer, /\b(lb|lbs|kg|kgs|pounds|kilos)\b/i, 'no unit may be invented when none was stated');
});

// ── Acceptance probe 3: determinism ────────────────────────────────────────────

test('#1777 P3: the same question twice -> identical number', async () => {
  const q = 'If I bench press 225 pounds six times till failure, what is my one rep max?';
  const first = await ask(q);
  const second = await ask(q);
  assert.equal(first.data.answer, second.data.answer, 'the deterministic lane must answer identically');
});

// ── Acceptance probe 4: no set -> no number, coach asks for the set ───────────

test('#1777 P4: "What\'s my one rep max?" with no set -> no number; the coach asks for the set', async () => {
  const { res, data } = await ask('What\'s my one rep max?');
  assert.equal(res.status, 200);
  assert.ok(data.answer, 'the coach must answer by asking for the set');
  // "1RM" carries a digit as part of the term, not a served value — strip it first.
  assert.doesNotMatch(data.answer.replace(/1RM/gi, ''), /\d/, `no number may be served: ${data.answer}`);
  assert.match(data.answer, /what weight/i, 'the coach must ask for the weight');
  assert.match(data.answer, /how many reps/i, 'the coach must ask for the reps');
});

// ── Acceptance probe 5: model-attack ──────────────────────────────────────────

test('#1777 P5: a scripted model reply stating 285 never reaches the athlete (deterministic lane claims the turn)', async () => {
  resetCoach();
  coachState.configured = true;
  coachState.reply = 'Your 1RM is 285 lb — nice work, that puts you well ahead of your last cycle.';
  const { res, data } = await chat('If I bench press 225 pounds six times till failure, what is my one rep max?');
  assert.equal(res.status, 200);
  assert.ok(data.message, 'an answer must be served');
  assert.match(data.message, /270/, `the served answer must carry the calculator's value: ${data.message}`);
  assert.doesNotMatch(data.message, /285/, 'the scripted 285 must never reach the athlete');
  assert.equal(coachState.chatReplyCalls, 0, 'the model must never be called for a claimed 1RM turn');
  assert.equal(data.source, 'engine');
});

test('#1777 P5b: the 1RM backstop replaces a wrong model number when the model DOES run (discouraged statement)', async () => {
  resetCoach();
  coachState.configured = true;
  coachState.reply = 'Your 1RM is 285 lb — nice work, that puts you well ahead of your last cycle.';
  // A discouraged STATEMENT (no trailing "?") — a discouraged question is analytical
  // and does not set the reassure bypass, so the statement form is the path that
  // reaches the model.
  const { res, data } = await chat("I'm so frustrated with my bench. I got 225 pounds for 6 and I need to know my one rep max.");
  assert.equal(res.status, 200);
  assert.ok(data.message, 'an answer must be served');
  assert.match(data.message, /270/, `the served answer must carry the calculator's value: ${data.message}`);
  assert.doesNotMatch(data.message, /285/, 'the scripted 285 must never reach the athlete');
  assert.equal(coachState.chatReplyCalls, 1, 'the discouraged turn must reach the model (reassure voice)');
});

test('#1777 P5c (unit): the 1RM backstop detector flags a wrong claimed max and passes the right one', () => {
  const g = require('../services/coachResponseGrounding');
  const facts = { value: 270, weight: 225, reps: 6, unit: 'lb' };
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Your 1RM is 285 lb.', facts), [285]);
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Your estimated 1RM is 270 lb (Epley).', facts), []);
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('You lifted 225 lb for 6, so your estimated max is 270 lb.', facts), []);
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Try 3 sets of 5 next time.', facts), []);
});

// Pre-review finding 4: a wrong max phrased WITHOUT 1RM wording must still be
// caught ("you might hit 285", "you could probably lift 285"). A prescription
// with no lift verb ("3 sets of 5") must still pass.
test('#1777 P5d (unit): the detector judges lift-verb sentences too, not only 1RM-phrased ones', () => {
  const g = require('../services/coachResponseGrounding');
  const facts = { value: 270, weight: 225, reps: 6, unit: 'lb' };
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Your 1RM is 270 lb. On a great day you might hit 285.', facts), [285]);
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Your estimated max is 270 lb. You might hit 285 on a good day.', facts), [285]);
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('You could probably lift 285.', facts), [285]);
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Your estimated 1RM is 270 lb. Try 3 sets of 5 next time.', facts), []);
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Press on — you have 3 sets of 5 left today.', facts), []);
});

// Pre-review finding 5: the unparenthesized Epley formula must not trip the detector.
test('#1777 P5e (unit): the detector passes the bare Epley formula too', () => {
  const g = require('../services/coachResponseGrounding');
  const facts = { value: 270, weight: 225, reps: 6, unit: 'lb' };
  assert.deepEqual(g.detectUngroundedOneRepMaxNumbers('Your estimated 1RM is 270 lb (Epley: 225 x 1 + 6/30 = 270).', facts), []);
});

// ── Acceptance probe 6: reps = 1 and reps > 12 ───────────────────────────────

test('#1777 P6a: reps = 1 -> the weight itself', async () => {
  const { data } = await ask('If I bench press 225 pounds once, what is my one rep max?');
  assert.ok(data.answer);
  assert.match(data.answer, /225/, 'reps = 1 returns the weight itself');
  assert.match(data.answer, /estimat/i);
});

test('#1777 P6b: reps = 20 -> value computed AND the rough-estimate flag present', async () => {
  const { data } = await ask('If I bench press 225 pounds twenty times till failure, what is my one rep max?');
  assert.ok(data.answer);
  assert.match(data.answer, /375/, '20 reps computes 375');
  assert.match(data.answer, /rough/i, 'above 12 reps the estimate must be flagged rougher');
});

// Pre-review finding 1: a weight spelled out as words ("two hundred twenty-five
// pounds") is a compound number the parser cannot resolve — it must fail closed
// to the ask-for-the-set, never serve a partially-understood number.
test('#1777 R1: a word-number compound weight fails closed — no number served', async () => {
  const { data } = await ask('If I bench press two hundred twenty-five pounds six times till failure, what is my one rep max?');
  assert.ok(data.answer, 'the coach must answer by asking for the set');
  assert.doesNotMatch(data.answer.replace(/1RM/gi, ''), /\d/, `no number may be served: ${data.answer}`);
  assert.match(data.answer, /what weight/i);
});

// Pre-review finding 1 (reps side): "thirty-five" is not twenty — it must fail
// closed rather than serve the value for 5 reps.
test('#1777 R1b: a word-number compound reps count fails closed — no number served', async () => {
  const { data } = await ask('If I bench press 225 pounds thirty-five times, what is my one rep max?');
  assert.ok(data.answer, 'the coach must answer by asking for the set');
  assert.doesNotMatch(data.answer.replace(/1RM/gi, ''), /\d/, `no number may be served: ${data.answer}`);
  assert.match(data.answer, /what weight/i);
});

// Pre-review finding 6: "10 lb for 10" is a real set — the reps guard compares
// token positions, not values, so equal weight and reps still parse.
test('#1777 R6: weight == reps still parses (10 lb for 10 -> 13 lb estimate)', async () => {
  const { data } = await ask("dumbbell curl 10 lb for 10, what's my max?");
  assert.ok(data.answer);
  assert.match(data.answer, /13/, '10 lb x 10 -> 13 lb Epley estimate');
  assert.match(data.answer, /estimat/i);
});

// ── Variants ──────────────────────────────────────────────────────────────────

test('#1777 V1: chat route with an active-workout context claims the question (client skips the SME mid-workout)', async () => {
  resetCoach();
  coachState.configured = true;
  const { res, data } = await chat('If I bench press 225 pounds six times till failure, what is my one rep max?', {
    current_plan: [{ name: 'Bench Press', sets: 3, reps: 5, weight: 225, rir: 1 }],
    plan_completed: [],
  });
  assert.equal(res.status, 200);
  assert.match(data.message, /270/, `chat lane must serve 270: ${data.message}`);
  assert.equal(data.source, 'engine');
  assert.equal(coachState.chatReplyCalls, 0, 'the model must never be called for a claimed 1RM turn');
});

test('#1777 V2: model-down chat (Gemini unconfigured) still answers deterministically', async () => {
  resetCoach();
  coachState.configured = false;
  const { res, data } = await chat('If I bench press 225 pounds six times till failure, what is my one rep max?');
  assert.equal(res.status, 200);
  assert.ok(data.message, 'the deterministic fallback must answer');
  assert.match(data.message, /270/, `fallback must serve 270: ${data.message}`);
  assert.equal(data.source, 'engine');
});

test('#1777 V3: a past-tense history question is NOT claimed by the 1RM lane (that is #1778 territory)', async () => {
  resetCoach();
  coachState.configured = true;
  const { res, data } = await chat('What was my max last time?');
  assert.equal(res.status, 200);
  assert.ok(data.message, 'an answer must be served');
  assert.doesNotMatch(data.message, /what weight did you lift/i, 'the 1RM lane must not ask for a set on a history question');
});

test('#1777 V4: chat route reps > 12 -> value computed AND the rough-estimate flag present', async () => {
  resetCoach();
  coachState.configured = true;
  const { res, data } = await chat('If I bench press 225 pounds twenty times till failure, what is my one rep max?');
  assert.equal(res.status, 200);
  assert.match(data.message, /375/);
  assert.match(data.message, /rough/i);
  assert.equal(coachState.chatReplyCalls, 0);
});

test('#1777 V5: chat route kg variant -> 120 kg', async () => {
  resetCoach();
  coachState.configured = true;
  const { res, data } = await chat("what's my estimated max on bench if I hit 100 kg for 6?");
  assert.equal(res.status, 200);
  assert.match(data.message, /120/);
  assert.match(data.message, /kg/i);
  assert.equal(coachState.chatReplyCalls, 0);
});

test('#1777 V6: chat route with no set -> asks for the set, serves no number', async () => {
  resetCoach();
  coachState.configured = true;
  const { res, data } = await chat("What's my one rep max?");
  assert.equal(res.status, 200);
  assert.ok(data.message);
  assert.doesNotMatch(data.message.replace(/1RM/gi, ''), /\d/, `no number may be served: ${data.message}`);
  assert.match(data.message, /what weight/i);
});

// Pre-review finding 2: "my max" without a set or a lift word is not a 1RM
// question — "what is my max heart rate?" must NOT be claimed by the 1RM lane.
test('#1777 R2: "what is my max heart rate?" is not claimed by the 1RM lane', async () => {
  const { data } = await ask('what is my max heart rate?');
  assert.equal(data.answer, null, 'the 1RM lane must not answer a heart-rate question');
  assert.ok(!data.cards || !data.cards.includes('estimated_1rm_epley'), 'the Epley card must not be served');
});

// Pre-review finding 3: a 1RM STATEMENT is a log line, not a question — the lane
// must not claim it (claiming it would swallow the set instead of logging it).
test('#1777 R3: a 1RM statement is not claimed — the set stays a log line', async () => {
  const { data } = await ask('my 1RM attempt: bench 225x6');
  assert.equal(data.answer, null, 'the 1RM lane must not answer a statement');
  assert.ok(!data.cards || !data.cards.includes('estimated_1rm_epley'), 'the Epley card must not be served');
});
