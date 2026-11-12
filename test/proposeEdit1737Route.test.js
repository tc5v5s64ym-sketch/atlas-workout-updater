'use strict';

// Issue #1737 — Fable fix 11 (P1): PROPOSE_EDIT — model names the operation
// and row only; values from the athlete or dropped; athlete accepts a card.
//
// These are the live /api/coach/chat route tests: the stubbed model returns
// the audit probes, and the route must return athlete-stated values (or drop
// the edit), never the model's numbers. Proving probes A1706-1..3 — the
// #1706 NEW-VARIANT: model text reaching real Log_Cleaned rows through the
// PROPOSE_EDIT path instead of the compile path.
//
// Written against the fixed behavior FIRST (failing-first at head 3c20967c:
// the route passes the model proposal through untouched).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-key-1707';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

const LOG_ROWS = [
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
  current_plan: [{ name: 'Bench Press', weight: 135, reps: 8, sets: 3 }],
  plan_completed: ['Bench Press'],
  current_preview: [
    { exercise: 'Bench Press', weight: 135, reps: 5, rir: 2 },
    { exercise: 'Bench Press', weight: 135, reps: 5, rir: 2 },
  ],
  session_tally: {
    exercises: [
      { exercise: 'Bench Press', sets: 1, per_set: [{ weight: 135, reps: 8, rir: 2 }], planned: true },
    ],
    total_working_sets: 1,
  },
};

test('A1706-1. Route — the audit probe: athlete said "really 140", model wrote 410', async () => {
  resetCoach();
  coachState.propose_edit = { action: 'update_set', index: 0, weight: 410, reps: 12, rir: 0 };
  const { res, json } = await post({ message: 'really 140', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  assert.equal(coachState.chatReplyCalls, 1, 'the turn reached the model path');
  assert.deepEqual(
    json.data.propose_edit,
    { action: 'update_set', index: 0, weight: 140 },
    '410 never reaches the client; the athlete-stated 140 does',
  );
});

test('A1706-1. Route — no athlete-stated value means the edit is dropped, prose stands', async () => {
  resetCoach();
  coachState.reply = 'Got it — keeping the set as logged.';
  coachState.propose_edit = { action: 'update_set', index: 0, weight: 410, reps: 12 };
  const { res, json } = await post({ message: 'yeah that looks right', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  assert.equal(json.data.propose_edit, null, 'no athlete value — nothing to apply');
  assert.match(json.data.message, /keeping the set/, 'the prose reply still stands');
});

test('A1706-2. Route — delete_set is identity-only: valid index passes, bad index drops', async () => {
  resetCoach();
  coachState.propose_edit = { action: 'delete_set', index: 0 };
  const { res, json } = await post({ message: 'that set felt off', context: ROUTE_CTX });
  assert.equal(res.status, 200);
  assert.deepEqual(json.data.propose_edit, { action: 'delete_set', index: 0 });

  resetCoach();
  coachState.propose_edit = { action: 'delete_set', index: 9 };
  const dropped = await post({ message: 'that set felt off', context: ROUTE_CTX });
  assert.equal(dropped.res.status, 200);
  assert.equal(dropped.json.data.propose_edit, null, 'an index with no row never reaches the client');
});

test('A1706-3. Route — add_set on an empty preview is dropped (no exercise-less row)', async () => {
  resetCoach();
  coachState.propose_edit = { action: 'add_set', weight: 410, reps: 12, rir: 0 };
  const emptyCtx = { ...ROUTE_CTX, current_preview: [] };
  const { res, json } = await post({ message: 'add one at 140x8', context: emptyCtx });
  assert.equal(res.status, 200);
  assert.equal(json.data.propose_edit, null, 'no preview row means no exercise to attach the set to');

  resetCoach();
  coachState.propose_edit = { action: 'add_set', weight: 410, reps: 12, rir: 0 };
  const kept = await post({ message: 'add one at 140x8', context: ROUTE_CTX });
  assert.equal(kept.res.status, 200);
  assert.deepEqual(
    kept.json.data.propose_edit,
    { action: 'add_set', weight: 140, reps: 8 },
    'with a preview row to attach to, the athlete-stated values survive',
  );
});
