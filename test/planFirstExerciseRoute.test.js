'use strict';

// /api/plan/intent-recommendation — the AUTHORITATIVE workout-generation pipeline
// honoring the athlete's requested FIRST exercise ("Plan me a workout but have it
// start with back squats"). 2026-07-22 requirement: the request routes here (never
// the free-form /api/coach/chat pseudo-plan lane); the returned plan LEADS with the
// requested lift, its numbers come from the deterministic engine, and when history
// can't set a load the entry carries an EXPLICIT unresolved-load state — never a
// fabricated weight, never a silently dropped field. Read-only: no Sheet write.
//
// require-cache injection stub pattern (per test/recommendation-preview-endpoint.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
// A non-PEM placeholder: sheets.js is fully stubbed via require.cache, so this value is
// never parsed. It deliberately avoids a PEM key block (the changed-file secret scan
// flags "BEGIN PRIVATE KEY" even in an obvious stub, since it scans new files).
process.env.GOOGLE_PRIVATE_KEY = 'stub-google-private-key';
delete process.env.ATLAS_COACH_ENGINE; // legacy engine (deterministic) for these tests

// Log_Cleaned rows: 11 cols per CLAUDE.md (date, session, exercise, canonical, muscle,
// lift_code, set, weight, reps, rir, notes). Back Squat (SQ01) has ample history so the
// engine resolves a working weight; Bench Press (BEN01) supplies a second lift so the
// recommendation is non-trivial. No history exists for a novel lift → unresolved load.
const logRows = [
  ['2026-06-02', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '275', '5', '2', ''],
  ['2026-06-02', 'S1', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '2', '275', '5', '2', ''],
  ['2026-06-09', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '285', '5', '2', ''],
  ['2026-06-09', 'S2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '2', '285', '5', '2', ''],
  ['2026-06-16', 'S3', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '290', '5', '2', ''],
  ['2026-06-04', 'S4', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '205', '5', '2', ''],
  ['2026-06-11', 'S5', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '215', '5', '2', ''],
  ['2026-06-18', 'S6', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', ''],
];

const sheetState = { appendCalls: [], deleteCalls: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    sheetState.appendCalls.push({ tabName, rows });
    throw new Error('appendRows must not be called by the read-only recommendation endpoint');
  },
  deleteRowsByRange: async (tabName, startIndex, endIndex) => {
    sheetState.deleteCalls.push({ tabName, startIndex, endIndex });
  },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? logRows : []),
  getSheetRows: async (tabName) => (tabName === 'Log_Cleaned' ? logRows : []),
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

const fakeCoach = {
  isConfigured: () => false,
  coachModel: () => 'gemini-2.5-flash-lite',
  generateCoachMessage: async () => null,
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  sanitizeFacts: (f) => f,
};
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true, exports: fakeCoach,
};

const originalConsoleLog = console.log;
// The exercise catalog reads Supabase (OWNER CORRECTION 2026-08-13). Stubbed here so
// the suite never opens a database connection; it delegates to the sheets fixture above.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();

// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`

// no longer controls the logged sets, the Effort row, the plan ledgers or the write

// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so

// no test's data changes — only where the route reads it from.

require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({ sheetsFallback: true });
const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

async function getRec(query) {
  const res = await fetch(`${baseUrl}/api/plan/intent-recommendation${query}`, {
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY },
  });
  const body = await res.json();
  return { res, body };
}

function recommendedIntent(body) {
  const intents = (body && body.data && body.data.intents) || [];
  return intents.find((i) => i && i.recommended) || intents[0] || null;
}

test('a requested first exercise WITH history leads the plan with an engine-resolved load', async () => {
  const { res, body } = await getRec('?firstExercise=back%20squat');
  assert.equal(res.status, 200);
  const rec = recommendedIntent(body);
  assert.ok(rec && Array.isArray(rec.exercises) && rec.exercises.length, 'a recommended intent with exercises');
  const first = rec.exercises[0];
  // LEADS with Back Squat (whether it was reordered or injected).
  assert.equal(first.exercise, 'Back Squat', 'the plan leads with the requested first exercise');
  assert.equal(rec.requested_first_exercise, 'Back Squat', 'the intent records the requested lead');
  // The load is the deterministic engine's number — present and NOT flagged unresolved.
  assert.ok(!first.unresolved_load, 'a lift with history is not an unresolved-load entry');
  const w = first.target_weight != null ? first.target_weight : (first.next_target && first.next_target.weight);
  assert.ok(typeof w === 'number' && Number.isFinite(w) && w > 0, `expected a resolved numeric load, got ${w}`);
});

test('a requested first exercise WITHOUT history leads with an EXPLICIT unresolved-load state (no fabrication)', async () => {
  const { res, body } = await getRec('?firstExercise=Zercher%20Carry');
  assert.equal(res.status, 200);
  const rec = recommendedIntent(body);
  const first = rec.exercises[0];
  assert.match(String(first.exercise), /Zercher Carry/i, 'the plan leads with the requested novel lift');
  assert.equal(first.unresolved_load, true, 'no history → the entry is flagged unresolved-load');
  assert.equal(first.target_weight, null, 'never a fabricated weight — the load field is explicitly null');
  assert.ok(typeof first.reason === 'string' && first.reason.length > 0, 'an explicit reason is surfaced, not a silent omission');
  assert.equal(rec.requested_first_exercise, first.exercise);
});

test('no firstExercise param → the plain authoritative recommendation (no requested lead marker)', async () => {
  const { res, body } = await getRec('');
  assert.equal(res.status, 200);
  const rec = recommendedIntent(body);
  assert.ok(rec, 'a recommendation is returned');
  assert.equal(rec.requested_first_exercise, undefined, 'no requested-first marker without the param');
});

test('the requested-first generation path never writes to the Sheet (read-only trust boundary)', async () => {
  const before = sheetState.appendCalls.length;
  await getRec('?firstExercise=back%20squat');
  await getRec('?firstExercise=Zercher%20Carry');
  assert.equal(sheetState.appendCalls.length, before, 'generation/preview must never append rows');
});

// 2026-07-22 production messages (deployed 9f72ee5): "Plan me a work out but have it start
// with {bench press | squats | lat pull}". Once the two-word "work out" is classified as a
// generation request, extractGenerationConstraints threads these exact first exercises into
// this authoritative route. Each must LEAD the returned plan — the requested first exercise
// preserved, and the plan's lead row consistent with the recorded requested lead.
const { normKey } = require('../services/planFirstExercise');

for (const firstExercise of ['bench press', 'squats', 'lat pull']) {
  test(`the production first exercise "${firstExercise}" leads the authoritative plan`, async () => {
    const { res, body } = await getRec(`?firstExercise=${encodeURIComponent(firstExercise)}`);
    assert.equal(res.status, 200);
    const rec = recommendedIntent(body);
    assert.ok(rec && Array.isArray(rec.exercises) && rec.exercises.length, 'a recommended intent with exercises');
    assert.ok(rec.requested_first_exercise, 'the intent records the requested lead (first exercise preserved)');
    // The plan's visible lead row IS the recorded requested lead — no divergence at the source.
    assert.equal(
      normKey(rec.exercises[0].exercise || rec.exercises[0].name),
      normKey(rec.requested_first_exercise),
      'the plan leads with the requested first exercise');
  });
}
