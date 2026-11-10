'use strict';

// Issue #1709 — chat grounding misses history, RIR, and future-prescription
// claims (Astra boundary audit, 6 CONFIRMED P1s; audit probes
// B2-chat-prescription-lying / B2-chat-RIR-lying / B2-chat-history-lying).
//
// The audit fixture: Bench Press 135x8/RIR2 logged, Seated Row remaining,
// history also 135x8/RIR2. The model answered with an invented next
// prescription (Deadlift 315, 5x12), a false RIR ("0 RIR"), and false history
// ("Last session you logged Bench Press at 315 for 12 reps") — all returned
// to the client because no backstop judged them.
//
// Part A — the detectors (pure): history claims against recent_sessions,
// RIR against the tally's per-set rir, future prescriptions against the
// plan/preview.
// Part B — the live /api/coach/chat route: a model reply carrying the three
// invented claims is replaced with the engine's grounded statement.

const test = require('node:test');
const assert = require('node:assert/strict');

const grounding = require('../services/coachResponseGrounding');

// The audit fixture as engine context.
function fixtureCtx() {
  return {
    plan_state: {
      planned: ['Bench Press', 'Seated Row'],
      completed: ['Bench Press'],
      remaining: ['Seated Row'],
      isComplete: false,
    },
    current_plan: [
      { name: 'Bench Press', weight: 135, reps: 8, sets: 3 },
      { name: 'Seated Row', weight: 100, reps: 10, sets: 3 },
    ],
    session_tally: {
      exercises: [
        { exercise: 'Bench Press', sets: 1, per_set: [{ weight: 135, reps: 8, rir: 2 }], planned: true },
      ],
      total_working_sets: 1,
    },
    recent_sessions: [
      {
        date: '2026-11-08', exercises: ['Bench Press'], sets: 1, volume: 1080,
        lift_sets: { 'Bench Press': [{ weight: 135, reps: 8, rir: 2 }] },
      },
    ],
    session_count: 1,
  };
}

function allDetectors(reply, ctx) {
  return [
    ...grounding.detectUnsupportedMutationClaim(reply),
    ...grounding.detectUngroundedRecapNumbers(reply, ctx),
    ...grounding.detectUngroundedCompletionClaim(reply, ctx),
    ...grounding.detectUngroundedPrescriptionNumbers(reply, ctx),
  ];
}

// ── Part A ──────────────────────────────────────────────────────────────────

test('A1. B2-prescription — an invented next exercise with numbers is ungrounded', () => {
  const ctx = fixtureCtx();
  const found = grounding.detectUngroundedPrescriptionNumbers('Next up is Deadlift at 315 for 5 sets of 12 to finish the session.', ctx);
  assert.ok(found.some((f) => f.kind === 'prescription_numbers'), 'Deadlift is in no plan or preview entry');
  assert.equal(allDetectors('Next up is Deadlift at 315 for 5 sets of 12 to finish the session.', ctx).length > 0, true);
});

test('A2. B2-prescription — the true remaining prescription passes', () => {
  const ctx = fixtureCtx();
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('Seated Row is next, 100 for 3 sets of 10.', ctx).length, 0);
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('The plan calls for Seated Row at 100 for 3 sets of 10.', ctx).length, 0);
});

test('A3. B2-prescription — wrong numbers for a planned lift are ungrounded', () => {
  const ctx = fixtureCtx();
  assert.ok(grounding.detectUngroundedPrescriptionNumbers('Next, Seated Row at 150 for 3 sets of 10.', ctx).length > 0, '150 is not the planned load');
  assert.ok(grounding.detectUngroundedPrescriptionNumbers('Next, Seated Row at 100 for 5 sets of 10.', ctx).length > 0, '5 sets is not the planned count');
});

test('A4. B2-prescription — questions, proposals, and bare numbers are not claims', () => {
  const ctx = fixtureCtx();
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('Should I do Deadlift at 315 next?', ctx).length, 0, 'a question is not a prescription claim');
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('I suggest Deadlift at 315 for 5 sets of 12 if you want.', ctx).length, 0, 'an explicit suggestion is a proposal, not an assertion');
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('Next, 3 sets of 10 at 135.', ctx).length, 0, 'bare numbers with no lift named are unattributable');
});

test('A5. B2-prescription — a preview entry binds when the plan does not', () => {
  const ctx = fixtureCtx();
  ctx.current_preview = [{ exercise: 'Deadlift', weight: 315, reps: 5, rir: 2 }];
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('Next up is Deadlift at 315 for 5 reps.', ctx).length, 0, 'the preview carries the load');
  assert.ok(grounding.detectUngroundedPrescriptionNumbers('Next up is Deadlift at 335 for 5 reps.', ctx).length > 0, '335 is not the preview load');
  assert.ok(grounding.detectUngroundedPrescriptionNumbers('Next up is Deadlift at 315 for 5 sets of 5.', ctx).length > 0, 'the preview carries no set count, so sets have no binding');
});

test('A6. B2-prescription — RIR is compared only when the plan carries it', () => {
  const ctx = fixtureCtx();
  ctx.current_plan[1] = { name: 'Seated Row', weight: 100, reps: 10, sets: 3, rir: 1 };
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('Seated Row is next at 100 for 3 sets of 10 at 1 RIR.', ctx).length, 0);
  assert.ok(grounding.detectUngroundedPrescriptionNumbers('Seated Row is next at 100 for 3 sets of 10 at 3 RIR.', ctx).length > 0, '3 RIR contradicts the planned 1 RIR');
  const noRirPlan = fixtureCtx();
  assert.equal(grounding.detectUngroundedPrescriptionNumbers('Seated Row is next at 100 for 3 sets of 10 at 2 RIR.', noRirPlan).length, 0, 'an RIR target with no plan RIR is legitimate coaching');
});

test('A7. B2-RIR — a false RIR on an otherwise-true recap is flagged', () => {
  const ctx = fixtureCtx();
  for (const reply of [
    'You logged Bench Press at 135 for 8 reps at 0 RIR.',
    'You logged Bench Press at 135 for 8 reps at RIR 0.',
    'You logged Bench Press 135x8 @ 0.',
    'You logged Bench Press at 135 for 8 reps, 0 RIR.',
  ]) {
    const found = grounding.detectUngroundedRecapNumbers(reply, ctx);
    assert.ok(found.some((f) => f.kind === 'recap_numbers'), `must flag: ${reply}`);
  }
});

test('A8. B2-RIR — the true RIR passes, including the word-number form', () => {
  const ctx = fixtureCtx();
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Bench Press at 135 for 8 reps at 2 RIR.', ctx).length, 0);
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Bench Press at 135 for 8 reps at two RIR.', ctx).length, 0);
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Bench Press 135x8 @ 2.', ctx).length, 0);
});

test('A9. B2-RIR — two different RIRs in one clause fail closed', () => {
  const ctx = fixtureCtx();
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Bench Press at 135 for 8 reps at 0 RIR and 2 RIR.', ctx).length > 0,
    'contradictory RIRs cannot both be true');
});

test('A10. B2-history — invented history is flagged; recorded history passes', () => {
  const ctx = fixtureCtx();
  const found = grounding.detectUngroundedRecapNumbers('Last session you logged Bench Press at 315 for 12 reps.', ctx);
  assert.ok(found.some((f) => f.kind === 'recap_history_numbers'), '315x12 matches no recorded session');
  assert.equal(grounding.detectUngroundedRecapNumbers('Last session you logged Bench Press at 135 for 8 reps.', ctx).length, 0,
    'the recorded 135x8 is grounded');
  assert.equal(grounding.detectUngroundedRecapNumbers('Last session you logged Bench Press at 135 for 8 reps at 2 RIR.', ctx).length, 0,
    'the recorded RIR is grounded too');
  assert.ok(grounding.detectUngroundedRecapNumbers('Last session you logged Bench Press at 135 for 8 reps at 0 RIR.', ctx).length > 0,
    'a false RIR on true history is still ungrounded');
});

test('A11. B2-history — no recorded session means no history claim is grounded', () => {
  const ctx = fixtureCtx();
  ctx.recent_sessions = [];
  assert.ok(grounding.detectUngroundedRecapNumbers('Last session you logged Bench Press at 135 for 8 reps.', ctx).length > 0,
    'with no history the model must not invent any');
});

test('A12. B2-history — "last session" binds to the most recent session; "last week" to any', () => {
  const ctx = fixtureCtx();
  ctx.recent_sessions = [
    { date: '2026-11-08', exercises: ['Bench Press'], sets: 1, volume: 1080, lift_sets: { 'Bench Press': [{ weight: 135, reps: 8, rir: 2 }] } },
    { date: '2026-11-01', exercises: ['Bench Press'], sets: 1, volume: 1125, lift_sets: { 'Bench Press': [{ weight: 225, reps: 5, rir: 2 }] } },
  ];
  assert.ok(grounding.detectUngroundedRecapNumbers('Last session you logged Bench Press at 225 for 5 reps.', ctx).length > 0,
    '225x5 was the session before last, not the last session');
  assert.equal(grounding.detectUngroundedRecapNumbers('Last week you logged Bench Press at 225 for 5 reps.', ctx).length, 0,
    '225x5 is a real recorded session from last week');
});

test('A13. B2-history — a history claim about a lift only in history is still judged', () => {
  const ctx = fixtureCtx();
  ctx.recent_sessions = [
    { date: '2026-11-08', exercises: ['Deadlift'], sets: 1, volume: 1575, lift_sets: { 'Deadlift': [{ weight: 315, reps: 5, rir: 2 }] } },
  ];
  assert.equal(grounding.detectUngroundedRecapNumbers('Last session you logged Deadlift at 315 for 5 reps.', ctx).length, 0);
  assert.ok(grounding.detectUngroundedRecapNumbers('Last session you logged Deadlift at 335 for 5 reps.', ctx).length > 0);
});

test('A14. B2-combined — all three invented claims in one reply are caught', () => {
  const ctx = fixtureCtx();
  const reply = 'You logged Bench Press at 135 for 8 reps at 0 RIR. Last session you logged Bench Press at 315 for 12 reps, so you are building nicely. Next up is Deadlift at 315 for 5 sets of 12 to finish the session.';
  const found = allDetectors(reply, ctx);
  const kinds = new Set(found.map((f) => f.kind));
  assert.ok(kinds.has('recap_numbers'), 'false RIR');
  assert.ok(kinds.has('recap_history_numbers'), 'false history');
  assert.ok(kinds.has('prescription_numbers'), 'invented next prescription');
});

test('A15. Control — the truthful reply passes every detector', () => {
  const ctx = fixtureCtx();
  assert.equal(allDetectors('You logged Bench Press at 135 for 8 reps at 2 RIR. Seated Row is still remaining — the plan calls for 100 for 3 sets of 10.', ctx).length, 0);
});

// ── Part B — the live route ─────────────────────────────────────────────────

process.env.ATLAS_API_KEY = 'test-key-1709';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

// One flat Bench session in the log: the engine's recent_sessions history.
const LOG_ROWS = [
  ['2026-11-08', 's1', 'Bench Press', 'Bench Press', 'chest', 'BPX01', 1, 135, 8, 2, '', 1080],
];
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

const { app } = require('../index');
let server; let baseUrl;

test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
  delete process.env.ATLAS_INTERACTION_TRACE; delete process.env.ATLAS_PROFILE_GOAL;
});

function resetCoach() {
  coachState.configured = true;
  coachState.reply = 'ok';
  coachState.propose_edit = null; coachState.propose_note = null; coachState.propose_constraint = null; coachState.propose_plan_edit = null;
  coachState.violations = [];
  coachState.lastChatContext = null;
  coachState.chatReplyCalls = 0;
}

async function post(body) {
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() };
}

const ROUTE_CTX = {
  current_plan: [
    { name: 'Bench Press', weight: 135, reps: 8, sets: 3 },
    { name: 'Seated Row', weight: 100, reps: 10, sets: 3 },
  ],
  plan_completed: ['Bench Press'],
  session_tally: {
    exercises: [
      { exercise: 'Bench Press', sets: 1, per_set: [{ weight: 135, reps: 8, rir: 2 }], planned: true },
    ],
    total_working_sets: 1,
  },
};

test('B1. Route — the audit reply (invented prescription + false RIR + false history) is replaced', async () => {
  resetCoach();
  coachState.reply = 'You logged Bench Press at 135 for 8 reps at 0 RIR. Last session you logged Bench Press at 315 for 12 reps, so you are building nicely. Next up is Deadlift at 315 for 5 sets of 12 to finish the session.';
  coachState.propose_plan_edit = { action: 'replace_plan', exercises: [{ name: 'Deadlift', sets: 5, reps: 12, weight: 315 }] };
  const { res, json } = await post({ message: 'How did that set look?', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  assert.equal(json.data.source, 'engine', 'the deterministic grounded statement replaces the model prose');
  assert.doesNotMatch(json.data.message, /315|Deadlift|0 RIR/, 'no invented number reaches the athlete');
  assert.equal(json.data.propose_plan_edit, null, 'the proposal is dropped');
});

test('B2. Route — the truthful reply passes through unchanged', async () => {
  resetCoach();
  coachState.reply = 'You logged Bench Press at 135 for 8 reps at 2 RIR. Seated Row is still remaining — the plan calls for 100 for 3 sets of 10.';
  const { res, json } = await post({ message: 'How did that set look?', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  assert.equal(json.data.message, coachState.reply);
  assert.equal(json.data.source, 'gemini');
});
