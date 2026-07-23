'use strict';

// Reproduces the production conversation-grounding failure on deployed 62ab44a
// (Flight Recorder FR-20260722231349-ckbvri1o) through the LIVE /api/coach/chat and
// /api/plan/intent-recommendation routes. Harness mirrors test/coachChatGrounding.test.js:
// require-cache stubs for sheets + coach, the real Express app, HTTP requests. The REAL
// services/coachExplanationGrounding + coachResponseGrounding + buildChatContext are
// exercised; only the Gemini reply and the sheet reads are stubbed.
//
// The five-turn sequence:
//   1. "What's the plan today"                 → GET /api/plan/intent-recommendation (authoritative)
//   2. "Why only 175 for bench …"              → POST /api/coach/chat (recommendation explanation)
//   3. "Hello, atlas are you there?"           → POST /api/coach/chat (conversational aside)
//   4. "Uh oh your broken again"               → POST /api/coach/chat (conversational aside)
//   5. "Hello what's the plan today"           → GET /api/plan/intent-recommendation (authoritative again)
//
// The bug: turn 2 substituted the unrelated benchmark CHALLENGE ("Bench Press has come in
// below your recent benchmark 5 of the last 5 sessions…") for an explanation of the 175
// recommendation, and turns 3–4 replayed that same challenge. The Gemini stub is
// CONTEXT-AWARE — it emits the benchmark challenge whenever coach_mode is "challenge" (the
// production behavior) and a grounded explanation otherwise — so the fix is proven by what
// the route feeds the model, not by the stub.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'hypertrophy';

const { generateLiftCode } = require('../services/exerciseEnrichment');
const BENCH_CODE = generateLiftCode('Bench Press');
const SQUAT_CODE = generateLiftCode('Back Squat');

// Log_Cleaned cols: date|session|exercise|canonical|muscle|lift_code|set_num|weight|reps|rir|notes|volume.
// Bench AND Back Squat each: a high benchmark run then five lower recent sessions → a
// consistent_underperformance ("below your recent benchmark 5 of the last 5") pattern for
// EACH lift. Bench is the recommendation lift the athlete asks about; Squat is an UNRELATED
// lift whose challenge must be filtered out of the bench explanation.
function row(date, sess, ex, muscle, w, reps) {
  return [date, sess, ex, ex, muscle, generateLiftCode(ex), 1, w, reps, 2, '', w * reps];
}
const LOG_ROWS = [
  row('2026-05-01', 'bh1', 'Bench Press', 'chest', 225, 5),
  row('2026-05-04', 'bh2', 'Bench Press', 'chest', 225, 5),
  row('2026-05-08', 'bh3', 'Bench Press', 'chest', 230, 5),
  row('2026-06-01', 'bs1', 'Bench Press', 'chest', 185, 5),
  row('2026-06-05', 'bs2', 'Bench Press', 'chest', 180, 5),
  row('2026-06-09', 'bs3', 'Bench Press', 'chest', 180, 5),
  row('2026-06-13', 'bs4', 'Bench Press', 'chest', 175, 5),
  row('2026-06-17', 'bs5', 'Bench Press', 'chest', 175, 5),
  row('2026-05-02', 'qh1', 'Back Squat', 'legs', 335, 5),
  row('2026-05-05', 'qh2', 'Back Squat', 'legs', 335, 5),
  row('2026-05-09', 'qh3', 'Back Squat', 'legs', 340, 5),
  row('2026-06-02', 'qs1', 'Back Squat', 'legs', 285, 5),
  row('2026-06-06', 'qs2', 'Back Squat', 'legs', 280, 5),
  row('2026-06-10', 'qs3', 'Back Squat', 'legs', 280, 5),
  row('2026-06-14', 'qs4', 'Back Squat', 'legs', 275, 5),
  row('2026-06-18', 'qs5', 'Back Squat', 'legs', 275, 5),
];

const sheetsState = { logRows: LOG_ROWS, throwOnRead: false };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by the read-only chat/recommendation path'); },
  deleteRowsByRange: async () => { throw new Error('no deletes on the read-only path'); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async (name) => {
    // Simulate a Sheets outage on the cached full reads (log/effort) when armed.
    if (sheetsState.throwOnRead && (name === 'Log_Cleaned' || name === 'Effort')) throw new Error('simulated Sheets outage');
    return name === 'Log_Cleaned' ? sheetsState.logRows.slice() : [];
  },
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = { id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets };
require.cache[require.resolve('../services/vision')] = { id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) } };

// The production benchmark-challenge line — what the real model emits under coach_mode
// "challenge". If it (or any "benchmark" wording) reaches the athlete on the explanation or
// aside turns, the bug is present.
const CHALLENGE_REPLY = "Bench Press has come in below your recent benchmark 5 of the last 5 sessions. What's going on there — the load feels off, recovery, or just not feeling it lately?";

const coachState = { configured: true, replyOverride: undefined, violations: [], lastChatContext: null, lastHistory: null, chatReplyCalls: 0 };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateChatReply: async (args) => {
      coachState.chatReplyCalls += 1;
      const ctx = args && args.context ? args.context : null;
      coachState.lastChatContext = ctx;
      coachState.lastHistory = args && args.history ? args.history : null;
      const wrap = (reply) => ({ reply, propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null });
      if (coachState.replyOverride !== undefined) return wrap(coachState.replyOverride);
      // Context-aware simulation of the real model: challenge mode → the benchmark critique;
      // otherwise explain the prescription from the grounded current_plan.
      if (ctx && ctx.coach_mode === 'challenge') return wrap(CHALLENGE_REPLY);
      const bench = (ctx && Array.isArray(ctx.current_plan) ? ctx.current_plan : []).find((e) => /bench/i.test(e.name || ''));
      const w = bench ? bench.weight : 'the target';
      return wrap(`Today Bench Press comes in at ${w} — that's a recovery/pump target, controlled rather than a heavy top set.`);
    },
    findRegisterViolations: () => coachState.violations,
    looksLikePrClaim: () => false,
    generateCoachMessage: async () => 'Solid work.',
    generatePlanMessage: async () => 'Solid work.',
    sanitizeFacts: (f) => f,
  },
};

const packetShadow = require('../services/coachTurnPacketShadow');
const explanationGrounding = require('../services/coachExplanationGrounding');

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
  coachState.replyOverride = undefined;
  coachState.violations = [];
  coachState.lastChatContext = null;
  coachState.lastHistory = null;
  coachState.chatReplyCalls = 0;
}

async function chat(body) {
  const before = packetShadow.getShadowLog().length;
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (packetShadow.getShadowLog().length > before) break; }
  const shadowLog = packetShadow.getShadowLog();
  return { res, json, shadowRow: shadowLog.length > before ? shadowLog[shadowLog.length - 1] : null };
}

async function planRecommendation() {
  const res = await fetch(`${baseUrl}/api/plan/intent-recommendation`, {
    method: 'GET',
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY },
  });
  const json = await res.json();
  return { res, json };
}

// The displayed-but-not-accepted authoritative recommendation, exactly as the client
// forwards it into the chat context (currentPlanForChat falls back to the cached
// recommended intent when no session is active). No plan_completed / plan_state — it is
// displayed, not an active session.
const DISPLAYED_RECOMMENDATION = {
  current_plan: [
    { name: 'Bench Press', weight: 175, reps: 9, sets: 3, rir: 5 },
    { name: 'Dips (Weighted)', weight: 50, reps: 12, sets: 3, rir: 4 },
    { name: 'Face Pull', weight: 45, reps: 15, sets: 3, rir: 4 },
    { name: 'Lat Pulldown', weight: 130, reps: 12, sets: 3, rir: 4 },
  ],
};

const BENCH_EXPLAIN_MSG = "Why only 175 for bench I haven't done bench in over a week?";

// ── unit guards (module-direct; no server) ──────────────────────────────────

test('unit: the bench log seeds a consistent_underperformance (challenge) pattern for BOTH lifts', () => {
  const { detectPatterns } = require('../services/coachMemory');
  const bench = detectPatterns(BENCH_CODE, LOG_ROWS);
  const squat = detectPatterns(SQUAT_CODE, LOG_ROWS);
  assert.ok(bench.patterns.some((p) => p.type === 'consistent_underperformance'), 'bench underperformance is present in the raw context');
  assert.ok(squat.patterns.some((p) => p.type === 'consistent_underperformance'), 'squat (unrelated) underperformance is present in the raw context');
});

test('unit: an aside is recognized but a "why 175" explanation and a plan request are not', () => {
  assert.equal(explanationGrounding.isConversationalAside('Hello, atlas are you there?'), true);
  assert.equal(explanationGrounding.isConversationalAside('Uh oh your broken again'), true);
  assert.equal(explanationGrounding.isConversationalAside(BENCH_EXPLAIN_MSG), false);
  assert.equal(explanationGrounding.isConversationalAside("Hello what's the plan today"), false);
});

// Codex P1: a PAST-tense history question with a number must NOT be hijacked into the
// current-recommendation lane — history owns it.
test('unit: a past-tense history question is NOT a recommendation-explanation turn', () => {
  const ctx = { current_plan: [{ name: 'Bench Press', weight: 175, reps: 9, sets: 3, rir: 5 }], recommended_label: 'Recovery / Pump' };
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('Why did I do 175 for bench last week?', ctx), false);
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('why was my bench 175 last session?', ctx), false);
  // Adverbial past-tense forms — "did I <adverb> <verb>" — must also be excluded (Codex).
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('Why did I only get 5 reps on bench?', ctx), false);
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('Why did I just barely hit 175 on bench?', ctx), false);
  // A question about the CURRENT displayed recommendation still fires.
  assert.equal(explanationGrounding.isRecommendationExplanationTurn(BENCH_EXPLAIN_MSG, ctx), true);
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('Why did you recommend only 175 for bench?', ctx), true);
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('Why so light on bench today?', ctx), true);
  // A recommendation question that merely CITES a prior session as context must still fire
  // (the history is not the question's subject) — the exclusion is scoped to the why-clause.
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('Why only 175 for bench today? I benched 225 last week.', ctx), true);
  assert.equal(explanationGrounding.isRecommendationExplanationTurn('Why only 175 for bench today, I benched 225 last week?', ctx), true);
});

// Codex P2 (follow-up): a configured provider whose Sheets read fails mid-turn must still
// explain the displayed recommendation — never regress to the generic advice fallback. Runs
// FIRST so the log/effort cache is cold and the simulated outage actually propagates (a
// rejected read is never cached).
test('provider configured but Sheets read fails: the explanation is still grounded in the displayed 175', async () => {
  resetCoach();
  sheetsState.throwOnRead = true;
  try {
    const { res, json } = await chat({ message: BENCH_EXPLAIN_MSG, context: DISPLAYED_RECOMMENDATION });
    assert.equal(res.status, 200);
    assert.equal(json.data.source, 'engine', 'deterministic engine answer on the outage path');
    assert.match(json.data.message, /Bench Press/, 'names the target lift');
    assert.match(json.data.message, /175/, 'explains the displayed 175 recommendation despite the Sheets outage');
    // The reasoning phrase distinguishes the recommendation EXPLANATION from the generic
    // advice fallback ("Bench Press: use 175 lbs, 9 reps, 3 sets, RIR 5."), which lacks it.
    assert.match(json.data.message, /heavier top set/i, 'explains WHY the target was chosen — not the generic advice fallback');
    assert.doesNotMatch(json.data.message, /benchmark|below your recent/i, 'never a challenge paragraph');
  } finally {
    sheetsState.throwOnRead = false;
  }
});

// ── the five-turn production sequence ────────────────────────────────────────

test('Turn 1 — "what\'s the plan today" returns the authoritative recommendation pipeline (no write)', async () => {
  const { res, json } = await planRecommendation();
  assert.equal(res.status, 200);
  assert.ok(json.data && Array.isArray(json.data.intents), 'the authoritative intent-recommendation pipeline answered');
  // Read-only: fakeSheets.appendRows throws if hit, so a clean 200 proves no write occurred.
});

test('Turn 2 — the bench explanation is grounded in the 175 recommendation, not a benchmark challenge', async () => {
  resetCoach();
  const { res, json } = await chat({ message: BENCH_EXPLAIN_MSG, context: DISPLAYED_RECOMMENDATION });
  assert.equal(res.status, 200);

  // (a) The model was reached with the recommendation as trusted context.
  const ctx = coachState.lastChatContext;
  assert.ok(ctx, 'the model was called for the explanation');
  assert.notEqual(ctx.coach_mode, 'challenge', 'coach_mode is DEMOTED from challenge — the recommendation outranks the standing benchmark pattern');
  const benchEntry = (ctx.current_plan || []).find((e) => /bench/i.test(e.name || ''));
  assert.deepEqual(benchEntry, { name: 'Bench Press', weight: 175, reps: 9, sets: 3, rir: 5 }, 'the explanation context contains Bench Press 175×9 @5 ×3');

  // (b) Diagnostics are narrowed to bench — the challenge for the requested lift is dropped
  //     and the UNRELATED squat challenge is gone entirely.
  assert.ok(!(ctx.memory_patterns || []).some((p) => Array.isArray(p.patterns) && p.patterns.some((x) => x.type === 'consistent_underperformance')),
    'no consistent_underperformance challenge survives into the explanation context');
  assert.ok(!(ctx.memory_patterns || []).some((p) => p.liftCode === SQUAT_CODE), 'the unrelated Back Squat diagnostic is absent');
  assert.deepEqual(ctx.muscle_gaps, [], 'muscle_gaps dropped for a focused recommendation explanation');

  // (c) The answer addresses why 175 was selected and never substitutes the benchmark challenge.
  const msg = json.data.message;
  assert.match(msg, /175/, 'the answer explains the current 175 recommendation');
  assert.match(msg, /recovery|pump|target|recommendation|focus/i, 'the answer addresses why 175 was chosen');
  assert.doesNotMatch(msg, /benchmark|below your recent|5 of the last 5/i, 'no unrelated stall/challenge paragraph is substituted');
});

test('Turn 3 — "Hello, atlas are you there?" gets a conversational acknowledgement, not a replayed challenge', async () => {
  resetCoach();
  const { res, json } = await chat({
    message: 'Hello, atlas are you there?',
    context: DISPLAYED_RECOMMENDATION,
    history: [
      { role: 'user', text: BENCH_EXPLAIN_MSG },
      { role: 'atlas', text: CHALLENGE_REPLY },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the model is NOT called — a stale visible response cannot be replayed');
  assert.match(json.data.message, /i'?m here/i, 'a direct conversational acknowledgement');
  assert.doesNotMatch(json.data.message, /benchmark|below your recent|175/i, 'the prior bench challenge/explanation is not repeated');
  assert.equal(json.data.source, 'engine');
});

test('Turn 4 — "Uh oh your broken again" gets a safe acknowledgement, not a replayed challenge', async () => {
  resetCoach();
  const { res, json } = await chat({
    message: 'Uh oh your broken again',
    context: DISPLAYED_RECOMMENDATION,
    history: [
      { role: 'user', text: BENCH_EXPLAIN_MSG },
      { role: 'atlas', text: CHALLENGE_REPLY },
      { role: 'user', text: 'Hello, atlas are you there?' },
      { role: 'atlas', text: CHALLENGE_REPLY },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the model is NOT called — no replay of the prior answer');
  assert.match(json.data.message, /i'?m here/i, 'a direct acknowledgement');
  assert.doesNotMatch(json.data.message, /benchmark|below your recent|175/i, 'the prior bench challenge is not repeated');
  assert.equal(json.data.source, 'engine');
});

test('Turn 5 — "Hello what\'s the plan today" still uses the authoritative recommendation pipeline (no write)', async () => {
  const { res, json } = await planRecommendation();
  assert.equal(res.status, 200);
  assert.ok(json.data && Array.isArray(json.data.intents), 'the final plan request routes through the authoritative pipeline');
});

// ── the deterministic explanation (LLM down) ─────────────────────────────────

test('LLM-down: the recommendation explanation is answered deterministically from the 175 recommendation', async () => {
  resetCoach();
  coachState.replyOverride = null; // the model returns nothing → fall through to the engine
  const { res, json } = await chat({ message: BENCH_EXPLAIN_MSG, context: DISPLAYED_RECOMMENDATION });
  assert.equal(res.status, 200);
  assert.equal(json.data.source, 'engine', 'the deterministic engine explanation answers when the model is empty');
  assert.match(json.data.message, /Bench Press/, 'names the target lift');
  assert.match(json.data.message, /175/, 'explains the current 175 recommendation');
  assert.doesNotMatch(json.data.message, /benchmark|below your recent/i, 'never a challenge paragraph');
});

// Codex P2: with the provider unconfigured, the recommendation explanation is still
// grounded in the displayed recommendation (client-forwarded current_plan) — not a
// generic advice fallback.
test('provider unconfigured: the recommendation explanation is grounded in the displayed 175, not a generic fallback', async () => {
  resetCoach();
  coachState.configured = false;
  const { res, json } = await chat({ message: BENCH_EXPLAIN_MSG, context: DISPLAYED_RECOMMENDATION });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the model is never called when unconfigured');
  assert.equal(json.data.source, 'engine');
  assert.match(json.data.message, /Bench Press/, 'names the target lift');
  assert.match(json.data.message, /175/, 'explains the displayed 175 recommendation even during an outage');
  // Distinguishes the recommendation explanation from the generic advice fallback.
  assert.match(json.data.message, /heavier top set/i, 'explains WHY the target was chosen — not the generic advice fallback');
  assert.doesNotMatch(json.data.message, /benchmark|below your recent/i, 'never a challenge paragraph');
});

// ── Coach_Shadow strengthening for the explanation path ──────────────────────

test('Coach_Shadow: the explanation turn records the recommendation snapshot, target, engine decision and coaching strategy', async () => {
  resetCoach();
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  try {
    const { res, shadowRow } = await chat({ message: BENCH_EXPLAIN_MSG, context: DISPLAYED_RECOMMENDATION });
    assert.equal(res.status, 200);
    assert.ok(shadowRow, 'one Coach_Shadow record for the explanation turn');
    assert.equal(shadowRow.packet_valid, true, 'the shadow packet stays valid');

    // The grounding block — session/recommendation snapshot, target exercise, engine decision.
    assert.ok(shadowRow.grounding, 'the shadow record carries the recommendation grounding');
    assert.equal(shadowRow.grounding.coaching_strategy, 'explain_recommendation');
    assert.deepEqual(shadowRow.grounding.target, { name: 'Bench Press', weight: 175, reps: 9, sets: 3, rir: 5 }, 'the target exercise + prescription');
    assert.equal(shadowRow.grounding.recommendation_label != null || shadowRow.grounding.fingerprint_lifts.length > 0, true, 'the recommendation snapshot/fingerprint is present');

    // The spine stages the route now genuinely runs for the explanation path are recorded
    // honestly (no longer surfaced as `missing`).
    const stageNames = shadowRow.trace.stages.map((s) => s.stage);
    assert.ok(stageNames.includes('session_snapshot'), 'session_snapshot recorded');
    assert.ok(stageNames.includes('engine_decision'), 'engine_decision recorded');
    assert.ok(stageNames.includes('coaching_strategy'), 'coaching_strategy recorded');
    assert.ok(!shadowRow.trace.missing.includes('coaching_strategy'), 'coaching_strategy is no longer missing');
  } finally {
    delete process.env.ATLAS_INTERACTION_TRACE;
  }
});
