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
//   BUG B (deload shape) — FIXED in #848 (buildSession now resolves the RAW persisted
//     { training_state, deload_protocol:<string> } shape and cuts the load). Since the
//     brian serve-eligibility rail, Coach's Pick (decision_type 'workout') is NOT
//     serve-eligible: brian mode falls back to legacy and never DRIVES the pick, while
//     hybrid still shadow-composes it. So the deload proof moved off the (now-refused)
//     brian DRIVE path to two non-user-served levels: the buildSession unit test
//     (test/sessionGenerator.test.js, raw-shape deload) and the HYBRID shadow below
//     (data.brian observes the deload-reduced pick without serving it). The brian-mode
//     test here now pins the serve rail: Coach's Pick falls back to legacy.
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
//
// Doubles as the serve-rail regression the other way: `progression` IS serve-
// eligible, so the rail must NOT block it — this test asserts driven_by:'brian'
// on the progression route, proving the gate does not touch the live path.
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
// SERVE RAIL (brian mode): Coach's Pick (decision_type 'workout') is not serve-
// eligible, so brian must NOT drive the pick — it falls back to legacy with the
// rail reason. This is the regression guard that brian does not serve best_workout
// while it is not serve-eligible.
// ---------------------------------------------------------------------------
test('brian mode: Coach\'s Pick is not serve-eligible → falls back to legacy (serve rail)', async () => {
  deloadStateRows = [ACTIVE_DELOAD_ROW]; // active deload present; rail still refuses the pick
  const original = process.env.ATLAS_COACH_ENGINE;
  process.env.ATLAS_COACH_ENGINE = 'brian';
  try {
    const { status, body } = await getJson('/api/plan/intent-recommendation');
    assert.equal(status, 200);
    const data = body.data;

    assert.ok(data.engine_source, 'brian mode must attach engine_source');
    assert.equal(data.engine_source.driven_by, 'legacy',
      `Coach's Pick must fall back to legacy, not be driven by brian (got driven_by="${data.engine_source.driven_by}")`);
    assert.equal(data.engine_source.reason, 'not_serve_eligible',
      `fallback reason must be the serve rail (got "${data.engine_source.reason}")`);

    // Legacy result still served: the recommended intent keeps its legacy exercises.
    const rec = (data.intents || []).find(i => i && i.recommended);
    assert.ok(rec && Array.isArray(rec.exercises) && rec.exercises.length,
      'the legacy recommended intent must still be served');
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE;
    else process.env.ATLAS_COACH_ENGINE = original;
  }
});

// ---------------------------------------------------------------------------
// SHADOW OBSERVES (hybrid mode): the deload proof lives here now. Hybrid still
// fully composes Brian's Coach's Pick (deload-aware) and attaches it as `brian`
// for observation WITHOUT serving it — no engine_source, legacy response otherwise
// untouched. Confirms hybrid shadow observes Brian while brian serve mode refuses.
// ---------------------------------------------------------------------------
test('hybrid mode: shadow observes Brian\'s deload-reduced Coach\'s Pick without serving it', async () => {
  deloadStateRows = [ACTIVE_DELOAD_ROW]; // active deload in the RAW persisted shape
  const original = process.env.ATLAS_COACH_ENGINE;
  process.env.ATLAS_COACH_ENGINE = 'hybrid';
  try {
    const { status, body } = await getJson('/api/plan/intent-recommendation');
    assert.equal(status, 200);
    const data = body.data;

    // Shadow attach only — hybrid never sets engine_source (that is serve/brian).
    assert.equal(data.engine_source, undefined, 'hybrid must not drive/serve (no engine_source)');

    // In hybrid the wire `.brian` is the TRIMMED summary (coachDecisionSummary.summarizeBrianDecision),
    // not the raw decision — the composed blocks (lift_code/target_weight) live at
    // data.brian.blocks, not data.brian.payload.blocks.
    const brian = data.brian || {};
    const blocks = Array.isArray(brian.blocks) ? brian.blocks : [];
    const squat = blocks.find(b => b.lift_code === 'SQ01');
    assert.ok(squat, `shadow-composed pick must contain a Back Squat block (blocks: ${blocks.map(b => b.lift_code).join(',') || 'none'})`);

    // Independent baseline: the deload-OFF prescription (full working load).
    const fullTarget = prescribeLift(logRows, 'SQ01', ASOF, {}).targetWeight;
    assert.equal(typeof fullTarget, 'number', 'baseline prescription must yield a weight');

    // Deload proof (#848), now observed via the shadow: an active deload reduces the
    // composed Back Squat load below the full working target.
    assert.ok(squat.target_weight < fullTarget,
      `active deload must reduce the shadow-composed Back Squat load below the full ${fullTarget}, ` +
      `but the shadow pick composed ${squat.target_weight}`);
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE;
    else process.env.ATLAS_COACH_ENGINE = original;
  }
});
