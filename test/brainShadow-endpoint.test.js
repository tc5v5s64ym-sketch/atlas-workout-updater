'use strict';

// Brain ORCHESTRATOR shadow lane — HTTP-level coverage. Proves that with
// ATLAS_COACH_ENGINE=hybrid the coach-engine route gates record a services/brainShadow
// entry for EVERY orchestration — a WIN and (via a forced orchestrator throw) a
// CRASH — WITHOUT changing the served legacy-visible response, and that
// GET /api/debug/brain-shadow exposes the ring safely (auth-gated, read-only).
// Tests-only harness; no production files touched.
//
// node --test runs each file in its own process, so the require.cache injection
// below (sheets + a coachOrchestrator WRAPPER) is isolated to this file. The wrapper
// delegates to the REAL orchestrator by default and can be flipped to throw for the
// failure-path assertion.

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

// Rich fixture (coach-engine route harness): 6 clean sessions ending on an
// over-performing top set, so the scenario classifier composes a valid answered
// decision — i.e. a WIN the shadow can record.
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

// The Brain_Shadow tab append is best-effort; capture calls without failing.
const appendCalls = [];
const fakeSheets = {
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? logRows : []),
  getSheetRows: async tabName => (tabName === 'Log_Cleaned' ? logRows : []),
  getHeaderRow: async tabName => {
    if (tabName === 'Log_Cleaned') return [...logCleanedColumns];
    if (tabName === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'],
  appendRows: async (tab, rows) => { appendCalls.push({ tab, rows }); return { data: { updates: { updatedRange: 'X!A1', updatedRows: 1 } } }; },
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

// Wrap the REAL orchestrator so we can force a throw for the crash-path test while
// keeping genuine composed decisions for the win-path test.
const realOrchestrator = require('../services/coachOrchestrator');
let orchestrateImpl = realOrchestrator.orchestrate;
const orchPath = require.resolve('../services/coachOrchestrator');
require.cache[orchPath] = {
  id: orchPath, filename: orchPath, loaded: true,
  exports: { orchestrate: (params) => orchestrateImpl(params), ENGINE_VERSION: realOrchestrator.ENGINE_VERSION },
};

const brainShadow = require('../services/brainShadow'); // same singleton index.js writes to
const { app } = require('../index');

let baseUrl;
let server;
test.before(async () => {
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

async function getJson(path, { auth = true } = {}) {
  const headers = auth ? { 'x-atlas-api-key': process.env.ATLAS_API_KEY } : {};
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function withMode(mode, fn) {
  return async () => {
    const original = process.env.ATLAS_COACH_ENGINE;
    brainShadow.clearBrainShadowLog();
    orchestrateImpl = realOrchestrator.orchestrate; // default: real decisions
    if (mode === undefined) delete process.env.ATLAS_COACH_ENGINE;
    else process.env.ATLAS_COACH_ENGINE = mode;
    try { await fn(); }
    finally {
      orchestrateImpl = realOrchestrator.orchestrate;
      if (original === undefined) delete process.env.ATLAS_COACH_ENGINE;
      else process.env.ATLAS_COACH_ENGINE = original;
    }
  };
}

// ── WIN path: recorded, response unchanged ───────────────────────────────────

test('hybrid: recommend/next records a WIN brain-shadow entry and serves legacy fields unchanged', withMode('hybrid', async () => {
  const original = process.env.ATLAS_COACH_ENGINE;
  delete process.env.ATLAS_COACH_ENGINE;
  const legacy = await getJson('/api/recommend/next/SQ01');
  process.env.ATLAS_COACH_ENGINE = original;

  const { status, body } = await getJson('/api/recommend/next/SQ01');
  assert.equal(status, 200);
  const data = body.data;

  // Legacy-visible fields unchanged; no engine_source in hybrid (byte-identity).
  assert.deepEqual(data.next_target, legacy.body.data.next_target);
  assert.equal(data.recommendation, legacy.body.data.recommendation);
  assert.equal('engine_source' in data, false);

  const log = brainShadow.getBrainShadowLog();
  const entry = log.entries.find(e => e.route === '/api/recommend/next' && e.lift_code === 'SQ01');
  assert.ok(entry, 'a brain-shadow entry was recorded for the orchestration');
  assert.equal(entry.mode, 'hybrid');
  assert.equal(entry.ok, true, 'a valid decision is a win');
  assert.equal(entry.reason, null);
  assert.equal(entry.decision_type, 'progression');
  assert.equal(typeof entry.status, 'string');
  assert.ok('confidence_tier' in entry);
  assert.ok(Array.isArray(entry.skipped), 'declared skipped capabilities captured');
  assert.ok(entry.divergence, 'divergence computed');
  assert.equal(typeof entry.ms, 'number');
}));

// ── CRASH path: the thrown-error the empty catch used to swallow is recorded ──

test('hybrid: an orchestrator THROW is recorded as ok:false/orchestrator_error and never fails the request', withMode('hybrid', async () => {
  const original = process.env.ATLAS_COACH_ENGINE;
  delete process.env.ATLAS_COACH_ENGINE;
  const legacy = await getJson('/api/recommend/next/SQ01');
  process.env.ATLAS_COACH_ENGINE = original;

  orchestrateImpl = () => { throw new Error('boom — runner exploded'); };

  const { status, body } = await getJson('/api/recommend/next/SQ01');
  assert.equal(status, 200, 'a Brain crash must NEVER fail the user-facing request');
  // Falls back to legacy untouched — no brian summary attached, no engine_source.
  assert.deepEqual(body.data.next_target, legacy.body.data.next_target);
  assert.equal('brian' in body.data, false);
  assert.equal('engine_source' in body.data, false);

  const entry = brainShadow.getBrainShadowLog().entries.find(e => e.route === '/api/recommend/next');
  assert.ok(entry, 'the crash was recorded');
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, 'orchestrator_error');
}));

// ── the debug endpoint ────────────────────────────────────────────────────────

test('GET /api/debug/brain-shadow is auth-gated and returns the ring + aggregates', withMode('hybrid', async () => {
  await getJson('/api/recommend/next/SQ01'); // seed one entry

  const noAuth = await getJson('/api/debug/brain-shadow', { auth: false });
  assert.equal(noAuth.status, 401, 'debug endpoint must require the api key');

  const { status, body } = await getJson('/api/debug/brain-shadow');
  assert.equal(status, 200);
  assert.equal(body.data.mode, 'hybrid');
  assert.equal(body.data.enabled, true);
  assert.equal(body.data.ring_max, brainShadow.RING_MAX);
  assert.ok(body.data.count >= 1);
  assert.ok(body.data.aggregates && typeof body.data.aggregates.total === 'number');
  assert.ok(Array.isArray(body.data.entries));
}));

// ── legacy stays inert ────────────────────────────────────────────────────────

test('legacy: no brain-shadow entry recorded and no brian attached (default mode untouched)', withMode(undefined, async () => {
  const { status, body } = await getJson('/api/recommend/next/SQ01');
  assert.equal(status, 200);
  assert.equal('brian' in body.data, false);
  assert.equal('engine_source' in body.data, false);
  assert.equal(brainShadow.getBrainShadowLog().count, 0, 'legacy mode records nothing');
}));
