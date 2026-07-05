'use strict';

// Coach-engine shadow — fault-injection coverage. Proves the shadow path degrades
// safely at the HTTP layer:
//   (1) a THROWN orchestrator never fails the request and never changes the served
//       legacy fields — hybrid omits `.brian`, brian falls back with engine_source
//       reason 'orchestrator_error' — across all three gated routes.
//   (2) a THROWN shadow observation (observeBrianDecision) never fails the request
//       and never changes the served response.
// Injects thin wrappers over orchestrate + observeBrianDecision (a live FAULT
// toggle) via require.cache BEFORE index.js loads. Tests-only; no production files.

const test = require('node:test');
const assert = require('node:assert/strict');
const { logCleanedColumns, effortColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';

const FAULT = { orchestrate: false, observe: false };

// Wrap orchestrate + observeBrianDecision with a live fault toggle, preserving
// every other real export, BEFORE index.js destructures them at load.
const realOrchestrator = require('../services/coachOrchestrator');
const orchPath = require.resolve('../services/coachOrchestrator');
require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: {
  ...realOrchestrator,
  orchestrate: (...args) => { if (FAULT.orchestrate) throw new Error('orchestrate boom'); return realOrchestrator.orchestrate(...args); },
} };

const realShadow = require('../services/coachShadow');
const shadowPath = require.resolve('../services/coachShadow');
require.cache[shadowPath] = { id: shadowPath, filename: shadowPath, loaded: true, exports: {
  ...realShadow,
  observeBrianDecision: (...args) => { if (FAULT.observe) throw new Error('observe boom'); return realShadow.observeBrianDecision(...args); },
} };

function sessions(exercise, muscle, code, startW) {
  const dates = ['2026-05-20', '2026-05-24', '2026-05-28', '2026-06-01', '2026-06-05', '2026-06-10'];
  const rows = [];
  let w = startW;
  for (let i = 0; i < 6; i++) {
    const reps = i === 5 ? 6 : 5;
    rows.push([dates[i], 's' + i + '-' + code, exercise, exercise, muscle, code, '1', String(w), String(reps), '3', '']);
    if (i < 4) w += 10;
  }
  return rows;
}
const logRows = [
  ...sessions('Back Squat', 'Legs', 'SQ01', 275),
  ...sessions('Bench Press', 'Chest', 'BEN01', 185),
];
const exerciseCatalogRows = [
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'squat|squats'],
];
const fakeSheets = {
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async (t) => (t === 'Log_Cleaned' ? logRows : []),
  getSheetRows: async t => (t === 'Log_Cleaned' ? logRows : []),
  getHeaderRow: async t => (t === 'Log_Cleaned' ? [...logCleanedColumns] : t === 'Effort' ? [...effortColumns] : []),
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'],
  appendRows: async () => ({ data: { updates: { updatedRange: 'X!A1', updatedRows: 1 } } }),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };
const visionPath = require.resolve('../services/vision');
require.cache[visionPath] = { id: visionPath, filename: visionPath, loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) } };
const coachPath = require.resolve('../services/coach');
require.cache[coachPath] = { id: coachPath, filename: coachPath, loaded: true, exports: {
  isConfigured: () => false, coachModel: () => 'x', pingGemini: async () => 'OK',
  generateCoachMessage: async () => null, generatePlanMessage: async () => null,
  generateChatReply: async () => ({ reply: null }), buildCoachSystemPrompt: () => 's',
  buildCoachUserPrompt: () => 's', sanitizeFacts: f => f,
} };

const { app } = require('../index');

let baseUrl;
let server;
test.before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });
test.afterEach(() => { FAULT.orchestrate = false; FAULT.observe = false; });

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY } });
  return { status: res.status, body: await res.json() };
}

const ROUTES = ['/api/recommend/next/SQ01', '/api/plan/today', '/api/plan/intent-recommendation'];

function recsOf(data) {
  return Array.isArray(data.recommendations) ? data.recommendations : [data];
}

test('thrown orchestrator: hybrid omits .brian and serves legacy fields unchanged (all 3 routes)', async () => {
  const original = process.env.ATLAS_COACH_ENGINE;
  try {
    for (const route of ROUTES) {
      // Legacy baseline (orchestrate works, mode off).
      delete process.env.ATLAS_COACH_ENGINE;
      FAULT.orchestrate = false;
      const legacy = await getJson(route);

      // Hybrid + orchestrate throws.
      process.env.ATLAS_COACH_ENGINE = 'hybrid';
      FAULT.orchestrate = true;
      const hybrid = await getJson(route);

      assert.equal(hybrid.status, 200, `${route} must still 200 on a shadow throw`);
      for (const r of recsOf(hybrid.body.data)) {
        assert.equal('brian' in r, false, `${route}: hybrid must not attach .brian when orchestrate throws`);
        assert.equal('engine_source' in r, false, `${route}: hybrid never sets engine_source`);
      }
      // Legacy-visible payload is identical to the flag-off response.
      assert.deepEqual(recsOf(hybrid.body.data).map(r => r.next_target), recsOf(legacy.body.data).map(r => r.next_target));
    }
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE; else process.env.ATLAS_COACH_ENGINE = original;
  }
});

test('thrown orchestrator: brian falls back with engine_source reason=orchestrator_error (all 3 routes)', async () => {
  const original = process.env.ATLAS_COACH_ENGINE;
  try {
    for (const route of ROUTES) {
      delete process.env.ATLAS_COACH_ENGINE;
      FAULT.orchestrate = false;
      const legacy = await getJson(route);

      process.env.ATLAS_COACH_ENGINE = 'brian';
      FAULT.orchestrate = true;
      const brian = await getJson(route);

      assert.equal(brian.status, 200, `${route} must still 200 on a shadow throw`);
      for (const r of recsOf(brian.body.data)) {
        assert.ok(r.engine_source, `${route}: brian mode records engine_source`);
        assert.equal(r.engine_source.driven_by, 'legacy');
        assert.equal(r.engine_source.reason, 'orchestrator_error');
        assert.equal('brian' in r, false, `${route}: no brian attach when orchestrate throws`);
      }
      assert.deepEqual(recsOf(brian.body.data).map(r => r.next_target), recsOf(legacy.body.data).map(r => r.next_target));
    }
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE; else process.env.ATLAS_COACH_ENGINE = original;
  }
});

test('thrown observation: a shadow-record failure never fails the route or changes the served fields (all 3 routes)', async () => {
  const original = process.env.ATLAS_COACH_ENGINE;
  try {
    for (const route of ROUTES) {
      delete process.env.ATLAS_COACH_ENGINE;
      FAULT.observe = false;
      const legacy = await getJson(route);

      process.env.ATLAS_COACH_ENGINE = 'hybrid';
      FAULT.observe = true; // orchestrate works; observeBrianDecision throws
      const hybrid = await getJson(route);

      assert.equal(hybrid.status, 200, `${route}: an observation throw must not fail the route`);
      // Legacy-visible numbers are unchanged; the attach (which precedes observe) still happened.
      assert.deepEqual(recsOf(hybrid.body.data).map(r => r.next_target), recsOf(legacy.body.data).map(r => r.next_target));
      for (const r of recsOf(hybrid.body.data)) assert.equal('engine_source' in r, false);
    }
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE; else process.env.ATLAS_COACH_ENGINE = original;
  }
});
