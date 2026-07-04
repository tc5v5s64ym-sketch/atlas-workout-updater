'use strict';

// One-Brain promotion — HTTP-level coverage of the ATLAS_COACH_ENGINE=brian
// DRIVE path (Option C, tests-only). Every existing brian route test uses a thin
// fixture that always clarifies → falls back to legacy, so the `driven_by:'brian'`
// serve path has never been exercised through Express. These tests drive it with
// a RICH fixture, closing that coverage hole and pinning ground truth for the two
// bugs the promotion-readiness audit flagged:
//
//   BUG A (bodyRegion) — REFUTED by this test. The audit claimed the progression
//     runner drops `bodyRegion` so lower-body lifts get the upper-body increment.
//     In fact liftPrescription._lastWorkingSetCtx populates `bodyRegion` from the
//     muscle group / exercise name, and progressionRunner passes that set straight
//     into recommendProgression. A Back Squat correctly gets the +5 lb lower-body
//     step, NOT the 2.5% upper-body one. This test GUARDS that (it PASSES on main).
//
//   BUG B (deload shape) — CONFIRMED. stateAssembly feeds the RAW persisted deload
//     row ({ training_state, deload_protocol:<string> }). sessionGenerator.buildSession
//     guards on `deload.protocol` (an OBJECT), which the raw shape lacks, so the
//     deload branch never fires and a brian Coach's Pick prescribes FULL loads
//     during an active deload. This test asserts the CORRECT (reduced) behavior and
//     is therefore RED on current main until buildSession reads the raw shape.
//
// Tests-only: no production files are touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { logCleanedColumns, effortColumns } = require('../config/columns');
const { recommendProgression } = require('../services/progressionModule');
const { prescribeLift } = require('../services/liftPrescription');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';

// Rich fixture: 6 clean sessions each for a LOWER-body (Back Squat / SQ01) and a
// horizontal-push (Bench Press / BEN01) lift, ending on an over-performing top set
// so the scenario classifier lands on `underloaded` → increase_load (the path that
// emits a weight target). Enough history to clear the confidence gate and DRIVE.
function sessions(exercise, muscle, code, startW) {
  const dates = ['2026-05-20', '2026-05-24', '2026-05-28', '2026-06-01', '2026-06-05', '2026-06-10'];
  const rows = [];
  let w = startW;
  for (let i = 0; i < 6; i++) {
    const reps = i === 5 ? 6 : 5; // last set over-performs (easier than prescribed)
    rows.push([dates[i], 's' + i + '-' + code, exercise, exercise, muscle, code, '1', String(w), String(reps), '3', '']);
    if (i < 4) w += 10;
  }
  return rows;
}
const logRows = [
  ...sessions('Back Squat', 'Legs', 'SQ01', 275),   // lower body → last set 315x6@3
  ...sessions('Bench Press', 'Chest', 'BEN01', 185), // horizontal push
];
const ASOF = '2026-07-01T00:00:00Z';
const SQ_LAST = { currentWeight: 315, currentReps: 6, currentRIR: 3 };

const exerciseCatalogRows = [
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'squat|squats'],
];

// Settable Deload_State — data rows only (the real getSheetRows strips the header).
// Columns: updated_at|training_state|deload_protocol|deload_reason|deload_start_date|deload_sessions_remaining|deload_exit_criteria
let deloadStateRows = [];
const ACTIVE_DELOAD_ROW = ['2026-06-11T00:00:00Z', 'DELOAD_ACTIVE', 'STRENGTH_DELOAD_V1', 'auto', '2026-06-11', '3', 'two clean sessions'];

const fakeSheets = {
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? logRows : []),
  getSheetRows: async tabName => {
    if (tabName === 'Log_Cleaned') return logRows;
    if (tabName === 'Deload_State') return deloadStateRows.map(r => [...r]);
    return [];
  },
  getHeaderRow: async tabName => {
    if (tabName === 'Log_Cleaned') return [...logCleanedColumns];
    if (tabName === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary', 'Deload_State'],
  appendRows: async () => ({ data: { updates: { updatedRange: 'X!A1', updatedRows: 1 } } }),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const fakeVision = { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) };
const visionPath = require.resolve('../services/vision');
require.cache[visionPath] = { id: visionPath, filename: visionPath, loaded: true, exports: fakeVision };

const fakeCoach = {
  isConfigured: () => false,
  coachModel: () => 'gemini-2.5-flash-lite',
  pingGemini: async () => 'OK',
  generateCoachMessage: async () => null,
  generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }),
  buildCoachSystemPrompt: () => 'stub',
  buildCoachUserPrompt: () => 'stub',
  sanitizeFacts: f => f,
};
const coachPath = require.resolve('../services/coach');
require.cache[coachPath] = { id: coachPath, filename: coachPath, loaded: true, exports: fakeCoach };

const { app } = require('../index');

let baseUrl;
let server;
test.before(async () => {
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY } });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// GUARD (audit Bug A REFUTED): the progression DRIVE path threads bodyRegion, so
// a lower-body lift gets the lower-body increment. PASSES on main.
// ---------------------------------------------------------------------------
test('brian DRIVE: a lower-body lift uses the lower-body load increment (bodyRegion is threaded)', async () => {
  deloadStateRows = []; // NORMAL — no deload interference on the progression path
  const original = process.env.ATLAS_COACH_ENGINE;
  process.env.ATLAS_COACH_ENGINE = 'brian';
  try {
    const { status, body } = await getJson('/api/recommend/next/SQ01?w=315&reps=6&rir=3');
    assert.equal(status, 200);
    const data = body.data;

    // Precondition: we actually reached the brian DRIVE path (not the fallback).
    assert.ok(data.engine_source, 'brian mode must attach engine_source');
    assert.equal(data.engine_source.driven_by, 'brian',
      `expected brian to DRIVE this recommendation; got fallback reason="${data.engine_source && data.engine_source.reason}"`);

    const scenarioId = data.brian && data.brian.explanation_inputs && data.brian.explanation_inputs.scenario_id;
    assert.ok(scenarioId, 'brian decision must expose its scenario_id');

    const lower = recommendProgression(scenarioId, { ...SQ_LAST, bodyRegion: 'lower_body' });
    const upper = recommendProgression(scenarioId, { ...SQ_LAST, bodyRegion: 'upper_body' });
    assert.notEqual(lower.targetWeight, upper.targetWeight,
      'fixture sanity: the two regions must produce different targets');

    // A Back Squat is lower-body → the driven weight is the lower-body target.
    assert.equal(data.next_target.weight, lower.targetWeight,
      `lower-body lift must use the lower-body increment (${lower.targetWeight}), not the upper-body one (${upper.targetWeight})`);
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE;
    else process.env.ATLAS_COACH_ENGINE = original;
  }
});

// ---------------------------------------------------------------------------
// PROOF (audit Bug B CONFIRMED) — pinned as a node:test `todo`. Coach's Pick must
// reduce load during an active deload. The assertion still runs and fails on main
// (buildSession's `&& deload.protocol` guard fails on the raw persisted shape, so
// it prescribes the FULL working load mid-deload), but `todo` reports it without
// failing the run — so this documents the confirmed bug while keeping shared CI
// green. It flips to a passing test once buildSession detects the raw deload shape;
// remove the `todo` marker in that fix PR.
// ---------------------------------------------------------------------------
test('brian DRIVE: Coach\'s Pick reduces load during an active deload (deload shape)',
  { todo: 'RED until buildSession detects raw stateAssembly deload shape.' }, async () => {
  deloadStateRows = [ACTIVE_DELOAD_ROW]; // active deload in the RAW persisted shape
  const original = process.env.ATLAS_COACH_ENGINE;
  process.env.ATLAS_COACH_ENGINE = 'brian';
  try {
    const { status, body } = await getJson('/api/plan/intent-recommendation');
    assert.equal(status, 200);
    const data = body.data;

    // Precondition: brian actually DROVE the pick (the Pick path has no separate
    // active-deload guard — buildSession is *supposed* to handle deload itself).
    assert.ok(data.engine_source, 'brian mode must attach engine_source');
    assert.equal(data.engine_source.driven_by, 'brian',
      `expected brian to DRIVE Coach's Pick; got fallback reason="${data.engine_source && data.engine_source.reason}"`);

    const brian = data.brian || {};
    const blocks = (brian.payload && brian.payload.blocks) || [];
    const squat = blocks.find(b => b.lift_code === 'SQ01');
    assert.ok(squat, `driven pick must contain a Back Squat block (blocks: ${blocks.map(b => b.lift_code).join(',') || 'none'})`);

    // Independent baseline: the deload-OFF prescription (what main produces).
    const fullTarget = prescribeLift(logRows, 'SQ01', ASOF, {}).targetWeight;
    assert.equal(typeof fullTarget, 'number', 'baseline prescription must yield a weight');

    // CORRECT behavior: an active deload reduces the prescribed load below the full
    // working target. RED on main (raw deload shape ignored → full load prescribed).
    assert.ok(squat.target_weight < fullTarget,
      `active deload must reduce the Back Squat load below the full ${fullTarget}, ` +
      `but the driven pick prescribed ${squat.target_weight} — buildSession does not detect the raw deload shape ` +
      `(guards on deload.protocol object; stateAssembly feeds deload_protocol string)`);
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE;
    else process.env.ATLAS_COACH_ENGINE = original;
  }
});
