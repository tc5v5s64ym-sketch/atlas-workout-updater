'use strict';

// #1727 (Fable fix 1): /api/coach/ask must serve the deterministic SME card text,
// never a Gemini-polished rewrite. The polish guard (numbersPreserved) only locks
// NUMBERS: a rewrite that keeps the same numbers in the same order passes it while
// swapping labels, units, exercises, or the association of a range to a goal — and
// the replaced text is still served with source: training_sme and the card list the
// client renders as a 'Based on:' provenance line. Proving probes from the Fable 5.2
// re-audit (A1711-1, A1711-3, B-polish-2): each sets a hostile polish rewrite and
// asserts the route serves the card text, not the rewrite.
//
// Harness mirrors test/coachQaShadowRoute.test.js (require-cache stub injection).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;
process.env.ATLAS_PROFILE_GOAL = 'strength';

const fakeSheets = {
  validateConfig: () => {},
  appendRows: async () => { throw new Error('appendRows must not be called by a read-only Q&A path'); },
  deleteRowsByRange: async () => {},
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

require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => true,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateChatReply: async () => ({ reply: 'ok', propose_edit: null, propose_note: null, propose_constraint: null, propose_plan_edit: null }),
    findRegisterViolations: () => [],
    looksLikePrClaim: () => false,
    generateCoachMessage: async () => 'Solid work.',
    generatePlanMessage: async () => 'Solid work.',
    sanitizeFacts: (f) => f,
  },
};

const smeState = { result: { answer: null, depth: 'explain', cards: ['rep_ranges'], confidenceLevel: 'high' } };
require.cache[require.resolve('../services/trainingSME')] = { id: require.resolve('../services/trainingSME'), filename: require.resolve('../services/trainingSME'), loaded: true, exports: { buildTrainingSMEAnswer: () => smeState.result } };

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

async function ask(message) {
  const res = await fetch(`${baseUrl}/api/coach/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY }, body: JSON.stringify({ message }) });
  const json = await res.json();
  return { res, json };
}

function assertCardTextServed(res, json, cardText, probe) {
  assert.equal(res.status, 200);
  assert.equal(json.data.source, 'training_sme');
  assert.deepEqual(json.data.cards, ['rep_ranges']);
  assert.equal(json.data.answer, cardText, `${probe}: the deterministic card text must be served, not the polished rewrite`);
}

// A1711-1: the audit's reversed rep ranges — "strength 1-6, hypertrophy 8-15"
// returned with the ranges attached to the wrong goals. The literal #1711 payload
// (reordering the numbers) is now caught by the ordered-sequence check, but the
// re-audit's reworded variant keeps the numbers in the same order and swaps the
// LABELS around them — numbersPreserved passes, meaning reversed.
test('A1711-1: a polish that reverses the rep ranges is not served — the card text is', async (t) => {
  const cardText = 'For strength, use 1-6 reps; for hypertrophy, use 8-15 reps.';
  smeState.result = { answer: cardText, depth: 'explain', cards: ['rep_ranges'], confidenceLevel: 'high' };
  const { res, json } = await ask('How many reps for strength vs hypertrophy?');
  assertCardTextServed(res, json, cardText, 'A1711-1');
});

// A1711-3: the set/rep swap — an engine prescription of 2 sets, 3-5 reps, 195 lb
// described with sets and reps exchanged. The reworded variant keeps the digits in
// the same order ("2 reps of 3-5 sets") so numbersPreserved passes, meaning swapped.
test('A1711-3: a polish that swaps sets and reps is not served — the card text is', async (t) => {
  const cardText = 'Do 2 sets of 3-5 reps at 195 lb.';
  smeState.result = { answer: cardText, depth: 'explain', cards: ['rep_ranges'], confidenceLevel: 'high' };
  const { res, json } = await ask('How many sets and reps at 195 lb?');
  assertCardTextServed(res, json, cardText, 'A1711-3');
});

// B-polish-2: wholesale replacement — labels, units and exercises swapped while the
// numbers are preserved, so the numbersPreserved guard passes and the replaced text
// is served as if it were the card answer.
test('B-polish-2: a polish that swaps labels, units and exercises wholesale is not served — the card text is', async (t) => {
  const cardText = 'Squat: 3 sets of 5 reps at 100 kg. Rest 3 minutes between sets.';
  smeState.result = { answer: cardText, depth: 'explain', cards: ['rep_ranges'], confidenceLevel: 'high' };
  const { res, json } = await ask('How should I squat 100 kg?');
  assertCardTextServed(res, json, cardText, 'B-polish-2');
});
