'use strict';

// Issue #1707 — model-proposed plan edits set exercise and prescription
// without the deterministic planner (Astra boundary audit, 6 CONFIRMED P1s;
// audit probe D_PLAN_MODEL_TO_USER).
//
// The audit probe: athlete asked "Can you add an accessory?" on a Bench/Row
// plan; the model supplied Romanian Deadlift 225 lb, 5 sets of 12, RIR 0 —
// applied to the active plan and rendered as the prescription. The model
// proposal carried exercise identity AND finite numeric fields, and the
// generation-only guard let it through (not a generation request).
//
// The fix: a model proposal may identify a requested operation only. Before
// the edit reaches the client, the deterministic planner resolves exercise
// choice and every prescription field from the athlete's logged history
// (prescribeLift); an exercise the planner cannot prescribe is dropped,
// fail-closed. Model-supplied weight/reps/sets/RIR never reach the client.
//
// These are the live /api/coach/chat route tests: the stubbed model returns
// the audit probe, and the route must return planner numbers (or drop the
// edit), never the model's numbers.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-key-1707';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

// RDL history: 4 sessions at 185 lb, 8–9 reps, RIR 2. prescribeLift resolves
// this to a 185 lb × 8 target (hold_progression) — nothing like the model's
// 225 lb × 12 × 5 @ RIR 0. Bench history: one 135x8/RIR2 session, the plan
// context for the audit fixture.
const LOG_ROWS = [
  ['2026-10-01', 's1', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 8, 2, '', 1480],
  ['2026-10-05', 's2', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 8, 2, '', 1480],
  ['2026-10-08', 's3', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 9, 2, '', 1665],
  ['2026-11-02', 's4', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 8, 2, '', 1480],
  ['2026-11-08', 's5', 'Bench Press', 'Bench Press', 'chest', 'BEN01', 1, 135, 8, 2, '', 1080],
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

// The audit probe, verbatim: model-supplied RDL 225 lb, 5 sets of 12, RIR 0.
const AUDIT_EDIT = {
  action: 'add_exercises',
  exercises: [{ name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 }],
};

test('R1. Route — the audit probe: model numbers are replaced by the planner prescription', async () => {
  resetCoach();
  coachState.reply = 'Sure — Romanian Deadlift is a solid posterior-chain accessory.';
  coachState.propose_plan_edit = AUDIT_EDIT;
  const { res, json } = await post({ message: 'Can you add an accessory?', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  const edit = json.data.propose_plan_edit;
  assert.ok(edit, 'the edit survives — only its numbers are re-resolved');
  assert.equal(edit.action, 'add_exercises');
  assert.equal(edit.exercises.length, 1);
  const ex = edit.exercises[0];
  assert.equal(ex.name, 'Romanian Deadlift');
  assert.equal(ex.liftCode, 'RDL01', 'the planner stamps the catalog lift code');
  assert.equal(ex.weight, 185, 'weight comes from logged history, not the model (225)');
  assert.equal(ex.reps, 8, 'reps come from the planner, not the model (12)');
  assert.equal(ex.sets, 3, 'sets come from the planner default, not the model (5)');
  assert.equal(ex.rir, 2, 'RIR comes from the planner default, not the model (0)');
});

test('R2. Route — an exercise with no logged history is dropped, fail-closed', async () => {
  resetCoach();
  coachState.reply = 'Sure — Face Pull is a solid accessory for shoulder health.';
  coachState.propose_plan_edit = {
    action: 'add_exercises',
    exercises: [{ name: 'Face Pull', weight: 40, reps: 15, sets: 3, rir: 2 }],
  };
  const { res, json } = await post({ message: 'Can you add an accessory?', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  assert.equal(json.data.propose_plan_edit, null, 'no history means no prescription — nothing is applied');
  assert.match(json.data.message, /Face Pull/, 'the prose suggestion still stands');
});

test('R3. Route — a remove is identity-only and passes through unchanged', async () => {
  resetCoach();
  coachState.reply = 'Want me to drop Seated Row from the plan?';
  coachState.propose_plan_edit = { action: 'remove_exercises', exercises: [{ name: 'Seated Row' }] };
  const { res, json } = await post({ message: 'Drop the seated row.', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  assert.deepEqual(json.data.propose_plan_edit, { action: 'remove_exercises', exercises: [{ name: 'Seated Row' }] });
});

test('R4. Route — a mixed replace keeps only the prescribable exercise, with planner numbers', async () => {
  resetCoach();
  coachState.reply = 'Here is the updated plan.';
  coachState.propose_plan_edit = {
    action: 'replace_plan',
    label: 'Coach plan',
    exercises: [
      { name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 },
      { name: 'Face Pull', weight: 40, reps: 15, sets: 3, rir: 2 },
    ],
  };
  const { res, json } = await post({ message: 'Rework the plan around accessories.', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  const edit = json.data.propose_plan_edit;
  assert.ok(edit, 'the resolvable exercise keeps the edit alive');
  assert.equal(edit.exercises.length, 1, 'the unprescribable exercise is dropped');
  assert.equal(edit.exercises[0].name, 'Romanian Deadlift');
  assert.equal(edit.exercises[0].weight, 185);
  assert.equal(edit.exercises[0].reps, 8);
});
