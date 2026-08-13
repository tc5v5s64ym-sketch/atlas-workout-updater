'use strict';

// ---------------------------------------------------------------------------
// Fail closed on an explicitly named but unresolvable exercise.
//
// PROVEN owner failure (gym session 2026-07-31): Atlas RECOMMENDED Good Morning.
// The athlete asked "how much for good morning?". The parser's deliberately narrow
// alias table does not carry Good Morning, so `resolveLiftName` fell past the message
// to the previous turn's lift and the answer came back with the DEADLIFT load. Chest
// Fly has the same exposure, and so does any name Atlas cannot resolve.
//
// The rule these tests pin: a message that NAMES a lift Atlas cannot resolve must never
// borrow another lift's numbers. It fails closed and asks. A message that names NO lift
// ("how much?", "and reps?") keeps using the active referent exactly as before.
//
// Part A drives the REAL production resolver (services/sessionQuestionAnswer).
// Part B re-implements the PRE-FIX algorithm and proves the same fixtures genuinely
//   produced the wrong lift, so Part A's greens are not vacuous.
// Part C drives the LIVE /api/coach/chat route end to end, so the fix is proven at the
//   seam the athlete actually reaches — not only through a helper.
// Read-only throughout: no write, no plan mutation, no parser-grammar change.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by the read-only chat path'); },
  deleteRowsByRange: async () => { throw new Error('no deletes on the chat path'); },
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

const coachState = { configured: true, reply: 'MODEL REPLY', chatReplyCalls: 0 };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateChatReply: async () => { coachState.chatReplyCalls += 1; return { reply: coachState.reply }; },
    findRegisterViolations: () => [],
    looksLikePrClaim: () => false,
    generateCoachMessage: async () => 'Solid work.',
    generatePlanMessage: async () => 'Solid work.',
    sanitizeFacts: (f) => f,
  },
};

const {
  resolveLiftName,
  buildSessionQuestionAnswer,
  answerUnresolvedExerciseQuestion,
} = require('../services/sessionQuestionAnswer');
const { canonicalizeExerciseName } = require('../services/workoutTextParser');
const { namedExercisePhrase } = require('../services/explicitExerciseReference');

// The owner's exact scene: Deadlift is the lift under discussion AND the planned lift,
// so ANY inheritance — prior turn or plan — shows up as "Deadlift".
const HISTORY = [{ role: 'user', text: 'deadlift 315 5/2' }, { role: 'assistant', text: 'Logged. Next up: Good Morning.' }];
const CONTEXT = { current_plan: [{ name: 'Deadlift', sets: 3, reps: 5, weight: 315, rir: 2 }], plan_completed: [] };

const answerFor = (message) => buildSessionQuestionAnswer(message, { history: HISTORY, clientContext: CONTEXT });

// ── Part A — the production resolver ───────────────────────────────────────

test('1. "how much for good morning?" no longer inherits Deadlift', () => {
  assert.equal(resolveLiftName('how much for good morning?', HISTORY, CONTEXT), null);
  assert.equal(resolveLiftName('how much for good mornings?', HISTORY, CONTEXT), null);

  const answer = answerFor('how much for good morning?');
  assert.ok(answer, 'the turn must be answered, not silently dropped');
  assert.doesNotMatch(answer, /deadlift/i, 'the deadlift must never be named');
  assert.doesNotMatch(answer, /315/, 'the deadlift load must never be quoted');
  assert.match(answer, /good morning/i, 'the ask names what Atlas heard');
  assert.match(answer, /which lift/i, 'the ask asks');
});

test('2. Chest Fly inherits neither the previous lift nor the planned lift', () => {
  for (const message of ['how much for chest fly?', 'how much for chest flies?', 'and reps for cable fly?']) {
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), null, message);
    const answer = answerFor(message);
    assert.doesNotMatch(answer, /deadlift|315/i, message);
    assert.match(answer, /which lift/i, message);
  }
  // Also with a DIFFERENT planned lift, so the assertion is about inheritance, not
  // about the word "deadlift": nothing from the plan may leak into the answer.
  const benchContext = { current_plan: [{ name: 'Bench Press', sets: 3, reps: 8, weight: 185, rir: 2 }] };
  assert.equal(resolveLiftName('how much for chest fly?', [{ text: 'bench 185 8/2' }], benchContext), null);
  assert.doesNotMatch(
    buildSessionQuestionAnswer('how much for chest fly?', { history: [{ text: 'bench 185 8/2' }], clientContext: benchContext }),
    /bench|185/i,
  );
});

test('3. a nonsense exercise name fails closed', () => {
  for (const message of ['how much for the flarbnax press?', 'what weight for zumbo curls?', 'how much for glorbo rows?']) {
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), null, message);
    assert.doesNotMatch(answerFor(message), /deadlift|315/i, message);
  }
});

test('4. known explicit exercise names still resolve', () => {
  assert.equal(resolveLiftName('how much for bench?', HISTORY, CONTEXT), 'Bench Press');
  assert.equal(resolveLiftName('how much for barbell rows?', HISTORY, CONTEXT), 'Bent-Over Row');
  assert.equal(resolveLiftName('how much for squat?', HISTORY, CONTEXT), 'Back Squat');
  assert.equal(resolveLiftName('how much for seated row?', HISTORY, CONTEXT), 'Seated Row');
  assert.equal(resolveLiftName('and reps for overhead press?', HISTORY, CONTEXT), 'Overhead Press');
  // A resolvable name is never intercepted by the fail-closed lane.
  assert.equal(answerUnresolvedExerciseQuestion('how much for barbell rows?'), null);
});

test('5. context-only shorthand still uses the active referent', () => {
  for (const message of ['how much?', 'what weight?', 'and reps?', 'how many sets?', 'rir?']) {
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), 'Deadlift', message);
    assert.equal(answerUnresolvedExerciseQuestion(message), null, message);
  }
  // Session nouns are not exercise names — the follow-up keeps its referent.
  for (const message of ['how much for the last set?', 'what weight for warmup?', 'how much for the next one?']) {
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), 'Deadlift', message);
  }
  assert.match(answerFor('how much?'), /Deadlift/);
});

test('6. a greeting containing "good morning" does not steal a real lift reference', () => {
  // The greeting is a greeting; the explicit reference in the same message still wins.
  assert.equal(resolveLiftName('good morning, how much for bench?', HISTORY, CONTEXT), 'Bench Press');
  assert.equal(resolveLiftName('Good morning! What weight for barbell rows?', HISTORY, CONTEXT), 'Bent-Over Row');
  // A greeting plus pure shorthand keeps the active referent — it is not a Good Morning question.
  assert.equal(resolveLiftName('good morning, how much?', HISTORY, CONTEXT), 'Deadlift');
  assert.equal(resolveLiftName('morning, whats my rir?', HISTORY, CONTEXT), 'Deadlift');
  assert.equal(namedExercisePhrase('good morning!'), null);
  // Only the LEADING greeting is discounted: the exercise reference still registers.
  assert.equal(namedExercisePhrase('how much for good morning?'), 'good morning');
});

test('an AMBIGUOUS name fails closed with the parser\'s own disambiguation, not a "no such lift" line', () => {
  // "rows" is understood but identifies no single lift, so inheriting the prior lift is the
  // same defect — and telling the athlete Atlas has no rows would be false.
  for (const message of ['how much for rows?', 'how much for row?']) {
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), null, message);
    const asked = answerUnresolvedExerciseQuestion(message);
    assert.ok(asked, message);
    assert.match(asked.text, /which row/i, message);
    assert.doesNotMatch(asked.text, /don't have/i, message);
    assert.doesNotMatch(asked.text, /deadlift|315/i, message);
  }
});

test('a coaching question about an unresolvable lift still reaches the coach', () => {
  // Advice and history framings are the model's, not this lane's.
  assert.equal(answerUnresolvedExerciseQuestion('should i do good mornings instead?'), null);
  assert.equal(answerUnresolvedExerciseQuestion('why do good mornings have a lower rir?'), null);
  assert.equal(answerUnresolvedExerciseQuestion('how much did i do for good mornings last time?'), null);
  // And a message asking no session attribute is not this lane's either.
  assert.equal(answerUnresolvedExerciseQuestion('good mornings are my favourite'), null);
});

// Codex #1213 P2 — a catalogue alias can END in a piece of equipment, which would make
// equipment shorthand read as a named exercise and decline a question it should answer.
test('equipment is not an exercise name — equipment shorthand keeps its referent', () => {
  for (const message of [
    'what weight on the barbell?',
    'how much for the dumbbell?',
    'how much weight on the bar?',
    'how much for the cable?',
    'how many plates?',
    'what weight on the machine?',
  ]) {
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), 'Deadlift', message);
    assert.equal(answerUnresolvedExerciseQuestion(message), null, message);
  }
  // The movement word still decides, so an equipment-qualified lift is unaffected.
  assert.equal(resolveLiftName('how much for barbell rows?', HISTORY, CONTEXT), 'Bent-Over Row');
  assert.ok(answerUnresolvedExerciseQuestion('how much for dumbbell flyes?'), 'a movement word still names a lift');
});

test('an unresolvable name is not detected in ordinary conversation', () => {
  for (const message of [
    'how much water should i drink?',
    'how much protein?',
    'how much rest between sets?',
    'how much time do we have?',
    'how much longer?',
    'how many sets left?',
    'how much did i sleep?',
  ]) {
    assert.equal(answerUnresolvedExerciseQuestion(message), null, message);
  }
});

// ── Part B — the same fixtures against the PRE-FIX algorithm ───────────────

// The resolver exactly as it stood before this change: message, then the most recent
// prior turn, then the live preview/plan — with no fail-closed step. Kept here so the
// tests above cannot pass vacuously: if these fixtures did not reproduce the defect,
// this function would not return "Deadlift".
function preFixResolveLiftName(message, history, clientContext) {
  const fromMsg = canonicalizeExerciseName(message);
  if (fromMsg && fromMsg.canonicalName) return fromMsg.canonicalName;
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = turns[i] && turns[i].text;
    if (!text) continue;
    const hit = canonicalizeExerciseName(text);
    if (hit && hit.canonicalName) return hit.canonicalName;
  }
  const cc = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const preview = Array.isArray(cc.current_preview) ? cc.current_preview : [];
  if (preview[0] && preview[0].exercise) return preview[0].exercise;
  const plan = Array.isArray(cc.current_plan) ? cc.current_plan : [];
  if (plan[0] && plan[0].name) return plan[0].name;
  return null;
}

test('7. the fixtures reproduce the defect: the pre-fix resolver DID answer with the wrong lift', () => {
  for (const message of ['how much for good morning?', 'how much for chest fly?', 'how much for the flarbnax press?']) {
    assert.equal(preFixResolveLiftName(message, HISTORY, CONTEXT), 'Deadlift',
      `${message} must inherit Deadlift under the pre-fix algorithm`);
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), null,
      `${message} must fail closed under the production resolver`);
  }
  // The behaviour the fix must NOT change: both algorithms agree everywhere else.
  for (const message of ['how much?', 'and reps?', 'how much for bench?', 'good morning, how much?', 'how much for barbell rows?']) {
    assert.equal(resolveLiftName(message, HISTORY, CONTEXT), preFixResolveLiftName(message, HISTORY, CONTEXT), message);
  }
});

// ── Part C — the live /api/coach/chat route ────────────────────────────────

// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
const { app } = require('../index');
const originalConsoleLog = console.log;
let server; let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; }
});

async function chat(message, context) {
  coachState.chatReplyCalls = 0;
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify({ message, context, history: HISTORY }),
  });
  return { res, json: await res.json() };
}

test('LIVE ROUTE: "how much for good morning?" is declined, never answered with the deadlift load', async () => {
  const { res, json } = await chat('how much for good morning?', CONTEXT);
  assert.equal(res.status, 200);
  const reply = String((json.data && json.data.message) || '');
  assert.doesNotMatch(reply, /deadlift/i, reply);
  assert.doesNotMatch(reply, /315/, reply);
  assert.match(reply, /good morning/i, reply);
  assert.match(reply, /which lift/i, reply);
  // Declined deterministically — the turn never reached the model with the plan in context.
  assert.equal(coachState.chatReplyCalls, 0);
  assert.equal(json.data.source, 'engine');
});

// Codex #1213 P1 — the guard used to sit inside `if (!reassureBypass && !warmupDefer)`,
// which is exactly where the wrong-lift answer still reached the model.

test('LIVE ROUTE: a DISCOURAGED framing cannot smuggle the unresolvable lift past the guard', async () => {
  const { res, json } = await chat("I'm frustrated. How much for good morning", CONTEXT);
  assert.equal(res.status, 200);
  const reply = String((json.data && json.data.message) || '');
  assert.doesNotMatch(reply, /deadlift/i, reply);
  assert.doesNotMatch(reply, /315/, reply);
  assert.match(reply, /which lift/i, reply);
  assert.equal(coachState.chatReplyCalls, 0, 'the reassure bypass must not carry it to the model');
});

test('LIVE ROUTE: a WARM-UP framing cannot smuggle the unresolvable lift past the guard', async () => {
  process.env.ATLAS_TURN_PRECEDENCE = '1'; // turns warmupDefer on
  try {
    const { res, json } = await chat('how many warm up sets for good morning?', CONTEXT);
    assert.equal(res.status, 200);
    const reply = String((json.data && json.data.message) || '');
    assert.doesNotMatch(reply, /deadlift/i, reply);
    assert.doesNotMatch(reply, /315/, reply);
    assert.match(reply, /which lift/i, reply);
    assert.equal(coachState.chatReplyCalls, 0, 'the warm-up defer must not carry it to the model');
  } finally {
    delete process.env.ATLAS_TURN_PRECEDENCE;
  }
});

test('LIVE ROUTE: a discouraged framing about a RESOLVABLE lift still routes as before', async () => {
  // The guard is tightly gated, so the reassure lane keeps every turn it owned.
  const { json } = await chat("I'm frustrated. My bench reps are going nowhere", CONTEXT);
  const reply = String((json.data && json.data.message) || '');
  assert.doesNotMatch(reply, /which lift/i, 'the fail-closed lane must not intercept a resolvable lift');
});

test('LIVE ROUTE: a resolvable lift is untouched and still answers from the plan', async () => {
  const benchContext = { current_plan: [{ name: 'Bench Press', sets: 3, reps: 8, weight: 185, rir: 2 }], plan_completed: [] };
  const { res, json } = await chat('how much for bench?', benchContext);
  assert.equal(res.status, 200);
  const reply = String((json.data && json.data.message) || '');
  assert.match(reply, /Bench Press/);
  assert.match(reply, /185/);
});

test('LIVE ROUTE: bare shorthand still answers from the active referent', async () => {
  const { res, json } = await chat('how much?', CONTEXT);
  assert.equal(res.status, 200);
  const reply = String((json.data && json.data.message) || '');
  assert.match(reply, /Deadlift/);
  assert.match(reply, /315/);
});
