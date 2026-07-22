'use strict';

// Integration tests for active-session response grounding through the LIVE
// /api/coach/chat route (2026-07-21 production failures). Harness mirrors
// test/coachQaShadowRoute.test.js: require-cache stubs for sheets + coach, the real
// Express app, HTTP requests. The REAL services/coachResponseGrounding is exercised
// (only the Gemini reply and sheet reads are stubbed).
//
//   Failure 1 (relevance): a Seated Row explanation must reach the model with the
//     unrelated Bench Press diagnostic filtered out of the context.
//   Failure 2 (mutation truth): a reply that falsely claims "the plan was updated" is
//     replaced with a truthful grounded statement of the current plan; no write occurs.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

// Log_Cleaned columns: date_clean|session_id|exercise|canonical_exercise|muscle_group|
// lift_code|set_number|weight|reps|rir|notes|volume_calc. Three flat Bench sessions →
// detectStalls yields a Bench Press stall the narrowing must exclude from a Seated Row turn.
const BENCH_STALL_ROWS = [
  ['2026-07-01', 's1', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 225, 5, 2, '', 1125],
  ['2026-07-03', 's2', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 225, 5, 2, '', 1125],
  ['2026-07-05', 's3', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 225, 5, 2, '', 1125],
];

// The injected getSheetRows (index.js) caches log/effort reads for 30s and the cache
// is not test-invalidatable, so the log rows are held STABLE for the whole file (the
// Bench Press stall is always present). Tests that don't assert on stalls are
// unaffected — their grounding reads current_plan from the request context, not the log.
const sheetsState = { logRows: BENCH_STALL_ROWS };
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
  propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null,
  violations: [],
  lastChatContext: null,
  chatReplyCalls: 0,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => coachState.configured,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateChatReply: async (args) => {
      coachState.chatReplyCalls += 1;
      coachState.lastChatContext = args && args.context ? args.context : null;
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
const packetShadow = require('../services/coachTurnPacketShadow');
const discussionReferent = require('../services/coachDiscussionReferent');
const RESP = Object.fromEntries(responseSheet.RESPONSE_HEADERS.map((h, i) => [h, i]));
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
  coachState.propose_edit = null; coachState.propose_note = null; coachState.propose_constraint = null; coachState.propose_plan_edit = null;
  coachState.violations = [];
  coachState.lastChatContext = null;
  coachState.chatReplyCalls = 0;
  // The discussion-referent store is a process singleton; clear it at each test's start so
  // a referent recorded by one test can't leak into another's dispute resolution. Within a
  // test the store persists across post() calls (needed for the what's-next→dispute case).
  discussionReferent._resetForTesting();
}

async function post(body) {
  appended.length = 0;
  installCapture();
  const before = packetShadow.getShadowLog().length;
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); if (appended.length) break; }
  await responseSheet._flushForTesting();
  const shadowLog = packetShadow.getShadowLog();
  return { res, json, respRow: appended[appended.length - 1] || null, respCount: appended.length, shadowRow: shadowLog.length > before ? shadowLog[shadowLog.length - 1] : null, shadowCount: shadowLog.length - before };
}

const SEATED_PLAN = { current_plan: [{ name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 }], plan_completed: [] };

// ── Failure 2 — unsupported completed-mutation claim is replaced ────────────

test('Failure 2: a "the plan was updated" correction reply is grounded to the current plan (no false write claim, no write)', async () => {
  resetCoach();
  // The exact production Failure-2 model prose.
  coachState.reply = 'The plan was updated. It now calls for 3 sets of 10 reps at 200, aiming for 1 RIR.';
  // A model that (wrongly) also attaches an edit must not have it treated as approved.
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] };

  const { res, json } = await post({ message: "That isn't what you planned. You planned 3 sets at 8 reps.", context: SEATED_PLAN });
  assert.equal(res.status, 200);
  const msg = json.data.message;
  assert.match(msg, /current plan shows/i, 'states what the current plan actually shows');
  assert.match(msg, /3 sets of 10/, 'the real prescription (3 sets of 10)');
  assert.match(msg, /200/);
  assert.match(msg, /haven't changed/i, 'plainly states nothing was changed');
  assert.doesNotMatch(msg, /was updated|now calls for|i (changed|switched|adjusted)/i, 'the false completed-mutation prose never reaches the athlete');
  assert.equal(json.data.propose_plan_edit, null, 'the proposal is dropped — a false "already done" turn is not a trustworthy proposal');
  assert.equal(json.data.source, 'engine', 'the deterministic grounded statement replaces the model prose');
  // Read-only: appendRows throws if hit, so reaching here proves no write occurred.
});

test('Failure 2 (Test 7): ambiguous evidence — a mutation-claim reply with no plan in view states uncertainty, invents nothing', async () => {
  resetCoach();
  coachState.reply = 'The plan was updated. It now calls for 3 sets of 10.';
  const { res, json } = await post({ message: "That isn't what you planned. You planned 3 sets at 8 reps.", context: {} });
  assert.equal(res.status, 200);
  assert.match(json.data.message, /don't have the current plan|not sure which/i, 'states uncertainty rather than a target');
  assert.match(json.data.message, /haven't changed/i);
  assert.doesNotMatch(json.data.message, /was updated|now calls for/i);
});

test('Test 3: a genuine proposal ("I can change it… want me to?") passes through unchanged with its plan edit', async () => {
  resetCoach();
  coachState.reply = 'I can change that to 3 sets of 8 if you want.';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] };
  const { res, json } = await post({ message: 'Change it to 3 sets of 8.', context: SEATED_PLAN });
  assert.equal(res.status, 200);
  assert.equal(json.data.message, 'I can change that to 3 sets of 8 if you want.', 'a conditional proposal is not a mutation claim — prose preserved');
  assert.deepEqual(json.data.propose_plan_edit, { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] }, 'the proposal is preserved');
  assert.equal(json.data.source, 'gemini');
});

test('regression: the acceptable production explanation prose is NOT rewritten', async () => {
  resetCoach();
  // The production explanation that was "acceptable" — present-state, no completed-mutation claim.
  coachState.reply = 'The plan calls for 200 for 10 reps at 1 RIR on Seated Row to increase volume on a lift that has stalled.';
  const { res, json } = await post({ message: 'Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?', context: SEATED_PLAN });
  assert.equal(res.status, 200);
  assert.equal(json.data.message, coachState.reply, 'a truthful present-state explanation passes through unchanged');
  assert.equal(json.data.source, 'gemini');
});

// ── Failure 1 — relevance narrowing wired into the route ────────────────────

test('Failure 1: a Seated Row explanation reaches the model with the unrelated Bench Press diagnostic filtered out', async () => {
  resetCoach();
  coachState.reply = 'On Seated Row the plan calls for 200 for 10 at 1 RIR to progress from 195.';
  const { res } = await post({ message: 'Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?', context: SEATED_PLAN });
  assert.equal(res.status, 200);
  const ctx = coachState.lastChatContext;
  assert.ok(ctx, 'the model was actually called (not short-circuited)');
  assert.ok(!(ctx.stalls || []).some(s => /bench/i.test(s.exercise || '')), 'the unrelated Bench Press stall is filtered out of the model context');
  assert.deepEqual(ctx.muscle_gaps, [], 'muscle_gaps dropped for a focused plan explanation');
});

test('Failure 1 control: a broad-session review still receives the full diagnostics (Bench stall present)', async () => {
  resetCoach();
  coachState.reply = 'A few things stand out across your recent training.';
  const { res } = await post({ message: "Are there any problems with today's workout or my recent training?", context: SEATED_PLAN });
  assert.equal(res.status, 200);
  const ctx = coachState.lastChatContext;
  assert.ok(ctx, 'the model was called');
  assert.ok((ctx.stalls || []).some(s => /bench/i.test(s.exercise || '')), 'a broad review is NOT narrowed — the Bench stall remains available');
});

// ── Test 8 — telemetry integrity (one correlated pair, final grounded text) ──

test('Test 8: a grounded correction turn still produces ONE Coach_Shadow + Coach_Response pair storing the final text', async () => {
  resetCoach();
  coachState.reply = 'The plan was updated. It now calls for 3 sets of 10.';
  process.env.ATLAS_INTERACTION_TRACE = 'shadow';
  try {
    const { res, json, respRow, respCount, shadowRow } = await post({ message: "That isn't what you planned. You planned 3 sets at 8 reps.", context: SEATED_PLAN });
    assert.equal(res.status, 200);
    assert.ok(shadowRow, 'one Coach_Shadow record');
    assert.ok(respRow, 'one Coach_Response record');
    assert.equal(respCount, 1, 'exactly one response row (no duplicate telemetry)');
    assert.equal(respRow[RESP.turn_id], shadowRow.turn_id, 'the pair shares one turn_id');
    // The stored visible text is the FINAL grounded statement, byte-for-byte.
    assert.equal(respRow[RESP.visible_message], json.data.message, 'Coach_Response stores the exact final visible text');
    assert.match(json.data.message, /haven't changed/i);
  } finally {
    delete process.env.ATLAS_INTERACTION_TRACE;
  }
});

// ── Fail-closed — the model is BYPASSED entirely on a factual plan dispute ────
// These prove requirement 6: arbitrary completed-write wording cannot reach the
// athlete on this read-only route WITHOUT relying on a finite denylist. The proof
// is structural — `generateChatReply` is never called on a dispute turn, so no
// model prose (however phrased) is ever in a position to be returned.

test('FAIL-CLOSED: a factual dispute never invokes the model — novel "already rewritten" prose cannot reach the athlete', async () => {
  resetCoach();
  // Wording NO denylist would enumerate — if this ever reached the athlete it would be a false write claim.
  coachState.reply = 'Boom — your program is locked in and fully rewritten to 3x8. All set, it now shows 3 sets of 8!';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] };
  const { res, json } = await post({ message: "That isn't what you planned. You planned 3 sets at 8 reps.", context: SEATED_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the model is NOT called at all — the answer is built deterministically (no denylist to outrun)');
  const msg = json.data.message;
  assert.match(msg, /current plan shows/i, 'states what the plan actually shows');
  assert.match(msg, /3 sets of 10/, 'the real prescription');
  assert.match(msg, /not 3 sets of 8/i, "distinguishes the athlete's claim");
  assert.match(msg, /haven't changed/i, 'states plainly that nothing was changed');
  assert.doesNotMatch(msg, /rewritten|locked in|Boom|All set/i, 'none of the model prose reaches the athlete — it was never generated for this turn');
  assert.equal(json.data.propose_plan_edit, null, 'no proposal leaks from a bypassed turn');
  assert.equal(json.data.source, 'engine');
});

// The exact production sequence: an explanation about Seated Row, then a correction that
// OMITS the lift name while the active plan holds several exercises. The disputed lift is
// recovered deterministically from the prior turn — the model is still never called.
const MULTI_PLAN = { current_plan: [
  { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
  { name: 'Bench Press', sets: 4, reps: 6, weight: 185, rir: 2 },
  { name: 'Back Squat', sets: 5, reps: 5, weight: 275, rir: 2 },
], plan_completed: [] };

test('FAIL-CLOSED (production sequence): a bare correction resolves the disputed lift from the prior turn in a multi-exercise plan', async () => {
  resetCoach();
  // False completed-write prose the model must never get the chance to emit.
  coachState.reply = 'Done — I rewrote Seated Row to 3 sets of 8 and saved it.';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] };
  const history = [
    { role: 'user', text: 'Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?' },
    { role: 'atlas', text: 'Seated Row is set at 200 for 10 at 1 RIR to add back volume.' },
  ];
  const { res, json } = await post({ message: "That isn't what you planned. You planned 3 sets at 8 reps.", context: MULTI_PLAN, history });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'the model is never called — the referent is resolved deterministically from the prior turn');
  const msg = json.data.message;
  assert.match(msg, /Seated Row/, 'names the disputed lift, recovered from the prior athlete turn');
  assert.match(msg, /3 sets of 10/, 'states the real prescription (3 sets of 10)');
  assert.match(msg, /200/, 'at 200');
  assert.match(msg, /1 RIR/, 'and 1 RIR');
  assert.match(msg, /not 3 sets of 8/i, "distinguishes the athlete's 3-sets-of-8 claim");
  assert.match(msg, /haven't changed/i, 'states plainly that nothing was changed');
  assert.doesNotMatch(msg, /rewrote|saved|locked|rewritten/i, 'the false completed-write prose never reaches the athlete');
  assert.equal(json.data.propose_plan_edit, null, 'no proposal survives a bypassed dispute turn');
  assert.equal(json.data.source, 'engine');
  // Read-only: appendRows throws if hit, so reaching here proves no write occurred.
});

test('FAIL-CLOSED negative control: an unresolvable bare correction in a multi-exercise plan states uncertainty, still never calls the model', async () => {
  resetCoach();
  coachState.reply = 'All set — the plan now reads 3 sets of 8.';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] };
  // Prior conversation exists but names no single plan lift, and no active-exercise context.
  const history = [
    { role: 'user', text: 'Thanks, that helps a lot.' },
    { role: 'atlas', text: 'Anytime — glad it landed.' },
  ];
  const { res, json } = await post({ message: "That isn't what you planned. You planned 3 sets at 8 reps.", context: MULTI_PLAN, history });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'still fail-closed — the model is not called even when the referent is unresolved');
  assert.match(json.data.message, /not sure which exercise|tell me the lift/i, 'states uncertainty instead of guessing a lift');
  assert.match(json.data.message, /haven't changed/i);
  assert.doesNotMatch(json.data.message, /now reads|All set|3 sets of 8/i, 'no model prose and no invented target');
  assert.equal(json.data.propose_plan_edit, null);
  assert.equal(json.data.source, 'engine');
});

// The MISSING CLASS the prior fix couldn't cover: ATLAS named the lift ("what's next?" →
// "Bench Press…"), the athlete disputed without naming it and with NO prior athlete turn
// naming a lift. The server records the discussed lift at answer time (tier 2), so the bare
// dispute resolves to Bench deterministically — the model is never called.
const NEXTUP_PLAN = { current_plan: [
  { name: 'Bench Press', sets: 4, reps: 6, weight: 175, rir: 5 },
  { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
  { name: 'Back Squat', sets: 5, reps: 5, weight: 275, rir: 2 },
], plan_completed: [] };

test('MISSING CLASS (server tier 2): "what\'s next?" → Atlas answers Bench → bare dispute resolves to Bench, model never called', async () => {
  resetCoach();
  // Turn 1 — "what's next?": the server records Bench (the next-up lift) as the session's
  // discussion referent on the way to answering (the model words it here).
  coachState.reply = 'Next up is Bench Press — 4 sets of 6 at 175, 5 RIR.';
  const t1 = await post({ message: "What's next?", context: NEXTUP_PLAN });
  assert.equal(t1.res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, "the what's-next turn reaches the model (recording the referent on the way)");

  // Turn 2 — a BARE dispute with NO history naming any lift. The ONLY way to resolve it is
  // the server-recorded referent from turn 1 (tier 2). A false completed-write reply is
  // staged to prove the model is bypassed.
  coachState.reply = 'Done — I switched Bench to 3 sets of 6 and saved it.';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Bench Press', sets: 3, reps: 6, weight: 175, rir: 5 }] };
  const t2 = await post({ message: "That isn't what you planned. You planned 3 sets at 6 reps.", context: NEXTUP_PLAN });
  assert.equal(t2.res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'the dispute turn does NOT call the model (still 1 from turn 1)');
  const msg = t2.json.data.message;
  assert.match(msg, /Bench Press/, 'resolves to Bench — the lift Atlas named when answering "what\'s next?"');
  assert.match(msg, /4 sets of 6/, 'states the real prescription');
  assert.match(msg, /175/);
  assert.match(msg, /not 3 sets of 6/i, "distinguishes the athlete's claim");
  assert.match(msg, /haven't changed/i);
  assert.doesNotMatch(msg, /switched|saved|Done/i, 'no false completed-write prose reaches the athlete');
  assert.equal(t2.json.data.propose_plan_edit, null, 'no proposal survives a bypassed dispute turn');
  assert.equal(t2.json.data.source, 'engine');
});

test('MISSING CLASS control: the SAME bare dispute WITHOUT a preceding "what\'s next?" fails closed (proves tier 2 did the work)', async () => {
  resetCoach();
  coachState.reply = 'Done — I switched Bench to 3 sets of 6.';
  // No preceding turn, no history → nothing recorded → multi-plan bare dispute fails closed.
  const t = await post({ message: "That isn't what you planned. You planned 3 sets at 6 reps.", context: NEXTUP_PLAN });
  assert.equal(t.res.status, 200);
  assert.equal(coachState.chatReplyCalls, 0, 'still fail-closed — model not called');
  assert.match(t.json.data.message, /not sure which exercise|tell me the lift/i, 'no referent → states uncertainty');
  assert.doesNotMatch(t.json.data.message, /switched|Done/i);
});

// The referent must not bleed ACROSS workouts. A DIFFERENT plan (a different planned-lift
// set) is a different session key, so a bare dispute in the new workout fails closed rather
// than inheriting the previous workout's referent (Codex #1128).
test('referent is scoped per workout: a dispute in a DIFFERENT plan does not inherit the prior plan\'s referent', async () => {
  resetCoach();
  const PLAN_A = { current_plan: [
    { name: 'Overhead Press', sets: 4, reps: 8, weight: 95, rir: 2 },
    { name: 'Lat Pulldown', sets: 3, reps: 12, weight: 120, rir: 1 },
  ], plan_completed: [] };
  // Turn 1 — "what's next?" in PLAN A records Overhead Press under PLAN A's key.
  coachState.reply = 'Next up is Overhead Press.';
  const a = await post({ message: "What's next?", context: PLAN_A });
  assert.equal(a.res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1);
  // Turn 2 — a bare dispute in a DIFFERENT workout (NEXTUP_PLAN: Bench/Row/Squat). Its
  // session key differs, so PLAN A's Overhead Press referent is NOT visible → fail closed.
  coachState.reply = 'Done — switched it.';
  const b = await post({ message: "That isn't what you planned. You planned 3 sets at 6 reps.", context: NEXTUP_PLAN });
  assert.equal(b.res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'the dispute is still handled deterministically (model not called)');
  assert.match(b.json.data.message, /not sure which exercise|tell me the lift/i, 'no cross-workout referent → states uncertainty');
  assert.doesNotMatch(b.json.data.message, /Overhead Press/, 'the prior workout\'s lift never leaks in');
});

// A workout RESTARTED with the same lift set but a DIFFERENT order/prescription is a
// different plan fingerprint, so its referent cannot bleed in (Codex #1128 — order and
// prescriptions participate in the key, not just the sorted lift names).
test('referent does not bleed when a workout is re-ordered/re-prescribed with the same lift set', async () => {
  resetCoach();
  // Workout 1: Bench first (next-up) — records Bench under fingerprint #1.
  const W1 = { current_plan: [
    { name: 'Bench Press', sets: 4, reps: 6, weight: 175, rir: 5 },
    { name: 'Seated Row', sets: 3, reps: 10, weight: 200, rir: 1 },
  ], plan_completed: [] };
  coachState.reply = 'Next up is Bench Press.';
  const a = await post({ message: "What's next?", context: W1 });
  assert.equal(a.res.status, 200);
  // Workout 2: SAME two lifts, REORDERED (Seated Row first) + different prescription → a
  // different fingerprint. A bare dispute must NOT inherit workout 1's Bench referent.
  const W2 = { current_plan: [
    { name: 'Seated Row', sets: 4, reps: 8, weight: 210, rir: 2 },
    { name: 'Bench Press', sets: 5, reps: 5, weight: 185, rir: 3 },
  ], plan_completed: [] };
  coachState.reply = 'Done — switched it.';
  const b = await post({ message: "That isn't what you planned. You planned 3 sets at 6 reps.", context: W2 });
  assert.equal(b.res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'model not called (still 1 from the what\'s-next turn)');
  assert.match(b.json.data.message, /not sure which exercise|tell me the lift/i, 'the re-ordered workout does not inherit the prior Bench referent');
});

test('explanation ("why did you…") still reaches the model — only factual disputes are short-circuited', async () => {
  resetCoach();
  coachState.reply = 'On Seated Row the plan calls for 200 for 10 at 1 RIR to progress from 195.';
  const { res, json } = await post({ message: 'Why did you program seated rows for 200 pounds at 10 reps with 1 RIR?', context: SEATED_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'a genuine explanation is answered by the model, not the deterministic dispute path');
  assert.equal(json.data.message, coachState.reply, 'the truthful present-state explanation passes through');
  assert.equal(json.data.source, 'gemini');
});

test('modification request ("change it to…") still reaches the model and its proposal passes through — not a dispute', async () => {
  resetCoach();
  coachState.reply = 'I can change that to 3 sets of 8 if you want.';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] };
  const { res, json } = await post({ message: 'Change it to 3 sets of 8.', context: SEATED_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'an explicit modification request is a proposal turn, not a factual dispute — the model runs');
  assert.deepEqual(json.data.propose_plan_edit, { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] }, 'the proposal survives to the approval flow');
  assert.equal(json.data.source, 'gemini');
});

test('natural-language change request ("Can we change the plan to 3x8?") reaches the model, not the dispute path (Codex #1126)', async () => {
  resetCoach();
  coachState.reply = 'Sure — I can change Seated Row to 3 sets of 8. Want me to?';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] };
  const { res, json } = await post({ message: 'Can we change the plan to 3x8?', context: SEATED_PLAN });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'a request-framed change reaches the model — it is NOT short-circuited as a factual dispute');
  assert.doesNotMatch(json.data.message, /haven't changed it/i, 'the athlete is not wrongly told nothing changed on a change request');
  assert.deepEqual(json.data.propose_plan_edit, { action: 'replace_plan', exercises: [{ name: 'Seated Row', sets: 3, reps: 8, weight: 200, rir: 1 }] }, 'the proposal is preserved so the approval flow can proceed');
  assert.equal(json.data.source, 'gemini');
});
