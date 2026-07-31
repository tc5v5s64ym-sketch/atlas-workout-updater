'use strict';

// Synthetic quota containment for Intent_Shadow / Brain_Shadow (owner ruling 2026-07-31).
//
// WHY. In live-retest Actions run 30596164330 the agent's own shadow telemetry exhausted
// the Google Sheets per-minute quota — 150 quota-exceeded events, `Brain_Shadow` alone
// accounting for 126 — and that degraded PRODUCTION traffic:
//
//   /api/plan/today          200  19,503 ms
//   /api/recommend/next/…    200  38,603 ms
//   /api/history/recent      500  15,401 ms
//   /api/summary/weekly      500  16,601 ms
//
// The rows were correctly TAGGED and never counted as owner evidence — the defect is
// VOLUME. So a declared-synthetic request no longer mirrors to the Sheet. The in-memory
// ring and console line are kept (free, quota-free, and what the debug endpoint and
// divergence tooling read).
//
// Together with #1207 this makes all FOUR shadow tabs synthetic-free:
// Coach_Shadow, Coach_Response (#1207) and Intent_Shadow, Brain_Shadow (here).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const intentShadow = require('../services/intentShadow');
const brainShadow = require('../services/brainShadow');
const coachShadowSheet = require('../services/coachShadowSheet');
const coachResponseSheet = require('../services/coachResponseSheet');
const { SYNTHETIC_ORIGINS, EVIDENCE_CLASSES } = require('../services/evidenceProvenance');

const SYNTHETIC = { evidence_class: EVIDENCE_CLASSES.SYNTHETIC, evidence_eligible: false, request_origin: 'playwright' };
const OWNER = { evidence_class: EVIDENCE_CLASSES.ATHLETE_UI, evidence_eligible: true, request_origin: 'athlete_ui' };

// Both lanes are env-gated in production; enable them so the persistence path is
// genuinely exercised rather than skipped for an unrelated reason.
process.env.ATLAS_INTENT_ROUTER = 'shadow';
process.env.ATLAS_COACH_ENGINE = 'hybrid';
process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';

// The observe calls are fire-and-forget promise chains; drain the microtask queue.
const drain = () => new Promise(r => setTimeout(r, 15));

async function intentAppends(evidence) {
  const rows = [];
  intentShadow._resetForTesting({ append: async (tab, r) => { rows.push({ tab, r }); } });
  intentShadow.observeChatMessage('bench press 135 8/2', { evidence });
  await drain();
  return rows;
}

async function brainAppends(evidence) {
  const rows = [];
  brainShadow._resetForTesting({ append: async (tab, r) => { rows.push({ tab, r }); } });
  brainShadow.observeBrainOrchestration({
    route: '/api/plan/today', liftCode: 'BEN01', mode: 'hybrid',
    decision: { payload: { target_weight: 135, target_reps: 8 } },
    validation: { valid: true },
    evidence
  });
  await drain();
  return rows;
}

// ── 1. Playwright-origin traffic reaches NONE of the four shadow tabs ────────

test('1a. Intent_Shadow: a playwright-origin request appends nothing', async () => {
  const rows = await intentAppends(SYNTHETIC);
  assert.deepEqual(rows, [], 'no Intent_Shadow append for synthetic traffic');
});

test('1b. Brain_Shadow: a playwright-origin request appends nothing', async () => {
  const rows = await brainAppends(SYNTHETIC);
  assert.deepEqual(rows, [], 'no Brain_Shadow append for synthetic traffic');
});

test('1c. Coach_Shadow / Coach_Response stay contained (#1207 preserved)', async () => {
  assert.equal(coachShadowSheet.persist({
    recordedAt: 'x', trace: { trace: { turn_id: 't', stages: [] }, missing: [] },
    assembled: { valid: true, errors: [], packet: { turn_id: 't' } }, visible: {}, synthetic: true
  }), null);
  assert.equal(coachResponseSheet.persist({
    turnId: 't', route: '/api/coach/message', intentType: 'block',
    visible: {}, modelStatus: 'ok', synthetic: true
  }), null);
});

test('1d. every recognized synthetic origin is contained, not just "playwright"', async () => {
  for (const origin of SYNTHETIC_ORIGINS) {
    const ev = { evidence_class: EVIDENCE_CLASSES.SYNTHETIC, evidence_eligible: false, request_origin: origin };
    const i = await intentAppends(ev);
    const b = await brainAppends(ev);
      assert.deepEqual(i, [], `Intent_Shadow must skip origin ${origin}`);
    assert.deepEqual(b, [], `Brain_Shadow must skip origin ${origin}`);
  }
});

// ── 2. Normal owner persistence is unchanged ────────────────────────────────

test('2a. Intent_Shadow still persists an owner request, with its provenance columns', async () => {
  const rows = await intentAppends(OWNER);
  assert.equal(rows.length, 1, 'owner traffic still mirrors to Intent_Shadow');
  assert.equal(rows[0].tab, 'Intent_Shadow');
  const row = rows[0].r[0];
  assert.ok(row.includes(EVIDENCE_CLASSES.ATHLETE_UI), 'the provenance class is still written');
  assert.ok(row.includes('TRUE'), 'an owner row stays evidence-eligible');
});

test('2b. Brain_Shadow still persists an owner request', async () => {
  const rows = await brainAppends(OWNER);
  assert.equal(rows.length, 1, 'owner traffic still mirrors to Brain_Shadow');
  assert.equal(rows[0].tab, 'Brain_Shadow');
});

test('2c. unclassified/unknown traffic still persists — only a DECLARED synthetic origin is skipped', async () => {
  for (const ev of [undefined, {}, { request_origin: 'missing' }, { request_origin: 'athlete_ui' }]) {
    const i = await intentAppends(ev);
    assert.equal(i.length, 1, `unknown traffic must still persist (${JSON.stringify(ev)}) — losing possibly-genuine evidence is the worse failure`);
  }
});

test('2c-bis. a synthetic-CLASS row with a non-declared origin still persists, tagged synthetic/ineligible', async () => {
  // The containment keys on the declared ORIGIN, not the class. A non-production
  // request with no declared synthetic origin classifies `synthetic` with
  // request_origin `non_production_runtime`, which is deliberately NOT in
  // SYNTHETIC_ORIGINS — so it still mirrors, and must still be tagged honestly
  // (Codex #1208 P2: keep row-level coverage for the persisted synthetic class).
  const ev = { evidence_class: EVIDENCE_CLASSES.SYNTHETIC, evidence_eligible: false, request_origin: 'non_production_runtime' };
  const rows = await intentAppends(ev);
  assert.equal(rows.length, 1, 'a non-declared synthetic-class row still reaches Intent_Shadow');
  const row = rows[0].r[0];
  assert.ok(row.includes(EVIDENCE_CLASSES.SYNTHETIC), 'evidence_class stays synthetic');
  assert.ok(row.includes('FALSE'), 'evidence_eligible stays FALSE');
  assert.ok(row.includes('non_production_runtime'), 'the bounded origin token is preserved');
});

test('2d. the ring and console line are kept, so the debug endpoint and divergence tooling still see synthetic turns', async () => {
  intentShadow._resetForTesting({ append: async () => {} });
  const count = () => intentShadow.getShadowLog().entries.length;
  const before = count();
  intentShadow.observeChatMessage('bench press 135 8/2', { evidence: SYNTHETIC });
  await drain();
  assert.equal(count(), before + 1,
    'the in-memory ring still records the synthetic turn — only the Sheet mirror is skipped');
});

// ── 3. The live-test runner still blocks every state-mutating write ─────────

test('3a. workout, plan-ledger, revision, closeout, seal and Flight Recorder writes all abort', () => {
  const blockade = require('../scripts/live-retest-write-blockade');
  const mustAbort = [
    '/api/log-workout', '/api/complete-workout', '/api/log-workout/undo-last',
    '/api/session-plans/accept', '/api/session-plans/outcome', '/api/session-plans/closeout',
    '/api/session-plan-sets/accept', '/api/session-plan-sets/revision', '/api/session-plan-sets/implicit',
    '/api/flight/ingest'
  ];
  for (const p of mustAbort) {
    const d = blockade.classifyOutboundRequest({ method: 'POST', url: `https://a.test${p}`, body: JSON.stringify({ s: 1 }) });
    assert.equal(d.allowed, false, `${p} must still abort`);
  }
  // …and carrying test_mode does not buy passage on a route that ignores it.
  assert.equal(blockade.classifyOutboundRequest({
    method: 'POST', url: 'https://a.test/api/session-plans/accept', body: JSON.stringify({ test_mode: true })
  }).allowed, false);
  // The preview flow still works.
  assert.equal(blockade.classifyOutboundRequest({
    method: 'POST', url: 'https://a.test/api/log-workout', body: JSON.stringify({ test_mode: true })
  }).allowed, true);
});

// ── 4. Nothing sensitive is logged ──────────────────────────────────────────

test('4a. the containment guards log no request body, reply text, credential, or cookie', async () => {
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await intentAppends({ ...SYNTHETIC });
    await brainAppends({ ...SYNTHETIC });
  } finally {
    console.log = realLog;
  }
  const blob = logs.join('\n');
  for (const forbidden of ['atlas_session', 'Authorization', 'Bearer', 'api_key', 'ATLAS_ACCESS_CODE', 'set-cookie']) {
    assert.equal(blob.includes(forbidden), false, `${forbidden} must never be logged`);
  }
});

test('4b. no shadow module logs a credential, cookie, or raw request body', () => {
  for (const f of ['services/intentShadow.js', 'services/brainShadow.js', 'services/coachShadowSheet.js', 'services/coachResponseSheet.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*req\.headers/, `${f} must not log request headers`);
    assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*req\.body/, `${f} must not log a raw request body`);
    assert.doesNotMatch(src, /atlas_session|ATLAS_ACCESS_CODE/, `${f} must not reference the session credential`);
  }
});

test('4c. the live-retest blockade still records path + reason only, never a body', async () => {
  const { installWriteBlockade } = require('../scripts/live-retest');
  const blocked = [];
  const logs = [];
  const context = { async route(_p, h) { context._handler = h; } };
  await installWriteBlockade(context, { onBlocked: b => blocked.push(b), logger: { log() {}, error: m => logs.push(m) } });
  await context._handler({
    request: () => ({ method: () => 'POST', url: () => 'https://a.test/api/log-workout', postData: () => JSON.stringify({ note: 'PRIVATE OWNER TEXT' }) }),
    continue: async () => {}, abort: async () => {}
  });
  assert.equal(JSON.stringify(blocked).includes('PRIVATE OWNER TEXT'), false);
  assert.equal(logs.join('\n').includes('PRIVATE OWNER TEXT'), false);
  assert.deepEqual(Object.keys(blocked[0]).sort(), ['path', 'reason']);
});
