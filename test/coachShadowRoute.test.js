'use strict';

// Coach-engine shadow observability — HTTP-level coverage. Proves that with
// ATLAS_COACH_ENGINE=hybrid|brian the three coach-engine route gates record a
// server-side shadow entry (services/coachShadow) WITHOUT changing the served
// legacy-visible response, and that GET /api/debug/coach-shadow exposes the ring
// safely (auth-gated, read-only). Tests-only harness; no production files touched.

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

// Rich fixture (mirrors onebrain-brian-route-drive): 6 clean sessions each for a
// lower-body and a push lift ending on an over-performing top set, so the scenario
// classifier lands on a path that composes a valid answered decision.
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
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? logRows : []),
  getSheetRows: async tabName => {
    if (tabName === 'Log_Cleaned') return logRows;
    return [];
  },
  getHeaderRow: async tabName => {
    if (tabName === 'Log_Cleaned') return [...logCleanedColumns];
    if (tabName === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'],
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

const coachShadow = require('../services/coachShadow'); // same singleton index.js writes to
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

async function getJson(path, { auth = true } = {}) {
  const headers = auth ? { 'x-atlas-api-key': process.env.ATLAS_API_KEY } : {};
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function withMode(mode, fn) {
  return async () => {
    const original = process.env.ATLAS_COACH_ENGINE;
    coachShadow.clearCoachShadowLog();
    if (mode === undefined) delete process.env.ATLAS_COACH_ENGINE;
    else process.env.ATLAS_COACH_ENGINE = mode;
    try { await fn(); }
    finally {
      if (original === undefined) delete process.env.ATLAS_COACH_ENGINE;
      else process.env.ATLAS_COACH_ENGINE = original;
    }
  };
}

// ── /api/recommend/next ──────────────────────────────────────────────────────

test('hybrid: recommend/next records a coach-shadow entry and serves legacy fields unchanged', withMode('hybrid', async () => {
  // Legacy baseline for the same lift.
  const original = process.env.ATLAS_COACH_ENGINE;
  delete process.env.ATLAS_COACH_ENGINE;
  const legacy = await getJson('/api/recommend/next/SQ01');
  process.env.ATLAS_COACH_ENGINE = original;

  const { status, body } = await getJson('/api/recommend/next/SQ01');
  assert.equal(status, 200);
  const data = body.data;

  // Legacy-visible fields unchanged; no engine_source in hybrid.
  assert.deepEqual(data.next_target, legacy.body.data.next_target);
  assert.equal(data.recommendation, legacy.body.data.recommendation);
  assert.equal('engine_source' in data, false);

  // The wire `.brian` is the TRIMMED summary (no raw provenance), not the full decision.
  assert.ok(data.brian, 'hybrid attaches a brian summary');
  assert.equal('provenance' in data.brian, false, 'raw provenance must not reach the client');
  assert.equal('explanation_inputs' in data.brian, false);
  assert.equal(data.brian.decision_type, 'progression');

  // A server-side shadow entry was recorded for this request.
  const log = coachShadow.getCoachShadowLog();
  assert.ok(log.count >= 1, 'a coach-shadow entry was recorded');
  const entry = log.entries.find(e => e.route === '/api/recommend/next' && e.lift_code === 'SQ01');
  assert.ok(entry, 'entry has route + lift_code');
  assert.equal(entry.mode, 'hybrid');
  assert.equal(entry.driven_by, null);
  assert.equal(typeof entry.ms, 'number', 'elapsed ms captured');
  assert.ok(entry.brian && entry.brian.decision_type === 'progression');
  assert.ok(entry.divergence, 'divergence computed');
}));

// ── /api/plan/today (the coverage gap the audit flagged) ─────────────────────

test('hybrid: plan/today attaches a per-rec brian summary and records shadow entries', withMode('hybrid', async () => {
  const original = process.env.ATLAS_COACH_ENGINE;
  delete process.env.ATLAS_COACH_ENGINE;
  const legacy = await getJson('/api/plan/today');
  process.env.ATLAS_COACH_ENGINE = original;

  const { status, body } = await getJson('/api/plan/today');
  assert.equal(status, 200);
  const recs = body.data.recommendations;
  assert.equal(recs.length, legacy.body.data.recommendations.length);

  // Legacy-visible numbers unchanged; no engine_source anywhere.
  assert.deepEqual(recs.map(r => r.next_target), legacy.body.data.recommendations.map(r => r.next_target));
  for (const r of recs) assert.equal('engine_source' in r, false);

  // At least one rec carries a trimmed brian summary AND a shadow entry was recorded.
  const attached = recs.filter(r => r.brian);
  assert.ok(attached.length >= 1, 'plan/today attaches a brian summary in hybrid');
  for (const r of attached) assert.equal('provenance' in r.brian, false, 'no raw provenance on the wire');
  const log = coachShadow.getCoachShadowLog();
  assert.ok(log.entries.some(e => e.route === '/api/plan/today'), 'plan/today shadow entry recorded');
}));

// ── /api/plan/intent-recommendation (#849 rail stays brian-serve-only) ───────

test('hybrid: intent-recommendation observes the composed Coach\'s Pick without serving it (#849 rail intact)', withMode('hybrid', async () => {
  const { status, body } = await getJson('/api/plan/intent-recommendation');
  assert.equal(status, 200);
  const data = body.data;
  // Hybrid never serves/drives — no engine_source; the pick is only observed.
  assert.equal('engine_source' in data, false);
  const log = coachShadow.getCoachShadowLog();
  const entry = log.entries.find(e => e.route === '/api/plan/intent-recommendation');
  assert.ok(entry, 'a workout decision was observed');
  assert.equal(entry.mode, 'hybrid');
  assert.equal(entry.driven_by, null, 'hybrid does not drive');
  assert.equal(entry.brian.decision_type, 'workout');
}));

test('brian: intent-recommendation still records the shadow entry with driven_by:legacy/not_serve_eligible (#849 rail)', withMode('brian', async () => {
  const { status, body } = await getJson('/api/plan/intent-recommendation');
  assert.equal(status, 200);
  assert.equal(body.data.engine_source.driven_by, 'legacy');
  assert.equal(body.data.engine_source.reason, 'not_serve_eligible');
  const entry = coachShadow.getCoachShadowLog().entries.find(e => e.route === '/api/plan/intent-recommendation');
  assert.ok(entry, 'brian mode also observes the composed pick');
  assert.equal(entry.driven_by, 'legacy');
  assert.equal(entry.reason, 'not_serve_eligible');
}));

// ── the debug endpoint ───────────────────────────────────────────────────────

test('GET /api/debug/coach-shadow is auth-gated and returns the ring + aggregates', withMode('hybrid', async () => {
  await getJson('/api/recommend/next/SQ01'); // seed one entry

  const noAuth = await getJson('/api/debug/coach-shadow', { auth: false });
  assert.equal(noAuth.status, 401, 'debug endpoint must require the api key');

  const { status, body } = await getJson('/api/debug/coach-shadow');
  assert.equal(status, 200);
  assert.equal(body.data.mode, 'hybrid');
  assert.equal(body.data.ring_max, coachShadow.RING_MAX);
  assert.ok(body.data.count >= 1);
  assert.ok(body.data.aggregates && typeof body.data.aggregates.total === 'number');
  assert.ok(Array.isArray(body.data.entries));
  // The endpoint exposes only summarized entries — no raw provenance leaks here either.
  for (const e of body.data.entries) assert.equal('provenance' in e.brian, false);
}));

test('legacy: no shadow entry recorded and no brian attached (default mode untouched)', withMode(undefined, async () => {
  const { status, body } = await getJson('/api/recommend/next/SQ01');
  assert.equal(status, 200);
  assert.equal('brian' in body.data, false);
  assert.equal('engine_source' in body.data, false);
  assert.equal(coachShadow.getCoachShadowLog().count, 0, 'legacy mode records nothing');
}));
