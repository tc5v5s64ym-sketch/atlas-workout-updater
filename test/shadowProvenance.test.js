'use strict';

// PR-GATEA1 — provenance fields on the durable Brain_Shadow / Intent_Shadow rows.
//
// Each shadow recorder now appends evidence_class / evidence_eligible / request_origin
// to the END of its existing row (Brain_Shadow 16→19, Intent_Shadow 13→16) — additive,
// never reordering or reinterpreting the existing columns. Classification is
// telemetry-only and fails closed: a missing/garbage evidence object records
// unknown/ineligible, and request_origin is always a bounded token (no raw content).

const test = require('node:test');
const assert = require('node:assert/strict');
const brainShadow = require('../services/brainShadow');
const intentShadow = require('../services/intentShadow');
const { silentClassifier, recordProviderCalls } = require('./helpers/noProviderCall');

const HYBRID = 'hybrid';
const flush = () => new Promise(r => setImmediate(r));

function brainReset(appendImpl) { brainShadow._resetForTesting(appendImpl ? { append: appendImpl } : {}); }
// `classify` is ALWAYS stubbed. Without it the real classifyIntent runs, and on a
// machine carrying a GEMINI_API_KEY that is a live provider call whose latency
// outruns this file's flush() — these provenance assertions would then fail for a
// reason unrelated to provenance. The stub returns null, exactly what the real
// classifier returns with no key, so credential-free behavior is unchanged.
function intentReset(appendImpl) {
  intentShadow._resetForTesting(appendImpl
    ? { classify: silentClassifier(), append: appendImpl }
    : { classify: silentClassifier() });
}

// ── Brain_Shadow ─────────────────────────────────────────────────────────────

test('Brain_Shadow: appends evidence_class/eligible/request_origin at the END; existing 16 columns unchanged', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  brainShadow.observeBrainOrchestration({
    route: '/api/recommend/next', liftCode: 'SQ01', mode: HYBRID,
    decision: { decision_type: 'progression', status: 'answered', confidence: { tier: 'high' }, payload: { target_weight: 235, target_reps: 5 } },
    validation: { valid: true }, legacy: { target_weight: 230, target_reps: 5 }, ms: 3, appVersion: 'v130',
    evidence: { evidence_class: 'athlete_ui', evidence_eligible: true, request_origin: 'athlete_ui' },
  });
  await flush();
  try {
    const row = appended[0].rows[0];
    // existing columns preserved in place
    assert.equal(row[1], '/api/recommend/next');
    assert.equal(row[2], 'SQ01');
    assert.equal(row[6], 'progression');
    assert.equal(row[15], 'v130', 'app_version stays at index 15');
    // NEW provenance columns appended at the end
    assert.equal(row.length, 19, 'row grew 16 → 19');
    assert.equal(row[16], 'athlete_ui', 'evidence_class');
    assert.equal(row[17], 'TRUE', 'evidence_eligible');
    assert.equal(row[18], 'athlete_ui', 'request_origin');
  } finally { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; }
});

test('Brain_Shadow: a missing evidence object fails closed to unknown/ineligible', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  brainShadow.observeBrainOrchestration({
    route: '/api/plan/today', mode: HYBRID,
    decision: { decision_type: 'progression', status: 'answered', payload: { target_weight: 100 } },
    validation: { valid: true }, legacy: {}, ms: 1,
    // no `evidence`
  });
  await flush();
  try {
    const row = appended[0].rows[0];
    assert.equal(row[16], 'unknown');
    assert.equal(row[17], 'FALSE');
    assert.equal(row[18], '');
  } finally { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; }
});

// CONTRACT CHANGE (owner ruling 2026-07-31). This case previously asserted that a
// declared-synthetic turn was PERSISTED with `synthetic` / `FALSE` provenance. The
// tagging was always correct — the problem was VOLUME: in live-retest run
// 30596164330 the synthetic Brain_Shadow mirror produced 126 of 150 Sheets
// quota-exceeded events and degraded production (20–38 s latencies; HTTP 500 on
// /api/history/recent and /api/summary/weekly). A declared-synthetic turn now does
// not reach the Sheet at all, so there is no row to inspect.
//
// Provenance tagging for every OTHER class stays asserted by the neighbouring cases
// (athlete_ui above, unknown/fail-closed below), and the ring + console line still
// record synthetic turns — see test/syntheticShadowQuotaContainment.test.js.
test('Brain_Shadow: a declared-synthetic turn is NOT persisted (quota containment)', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  brainShadow.observeBrainFailure({
    route: '/api/recommend/next', liftCode: 'BEN01', mode: HYBRID, reason: 'orchestrator_error', ms: 2,
    evidence: { evidence_class: 'synthetic', evidence_eligible: false, request_origin: 'sim' },
  });
  await flush();
  try {
    assert.deepEqual(appended, [], 'a declared synthetic origin never reaches the Brain_Shadow tab');
  } finally { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; }
});

// The `synthetic` CLASS can still persist, and must still be tagged correctly. The
// containment keys on the declared ORIGIN, not the class — so a non-production
// request with no declared synthetic origin classifies `synthetic` with
// request_origin `non_production_runtime`, which is deliberately NOT in
// SYNTHETIC_ORIGINS. That row still reaches the tab, and its provenance columns
// must still read synthetic / FALSE. Without this case the rewrite above would
// have silently dropped all row-level coverage for the synthetic class (Codex
// #1208 P2).
test('Brain_Shadow: a synthetic-CLASS row with a non-declared origin still persists, tagged synthetic/ineligible', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  brainShadow.observeBrainFailure({
    route: '/api/recommend/next', liftCode: 'BEN01', mode: HYBRID, reason: 'orchestrator_error', ms: 2,
    evidence: { evidence_class: 'synthetic', evidence_eligible: false, request_origin: 'non_production_runtime' },
  });
  await flush();
  try {
    assert.equal(appended.length, 1, 'a non-declared synthetic-class row is still mirrored');
    const row = appended[0].rows[0];
    assert.equal(row[16], 'synthetic', 'evidence_class');
    assert.equal(row[17], 'FALSE', 'evidence_eligible');
    assert.equal(row[18], 'non_production_runtime', 'request_origin bounded token');
  } finally { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; }
});

test('Brain_Shadow: an inconsistent injected evidence (class unknown but eligible:true) is not trusted → ineligible', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  brainShadow.observeBrainOrchestration({
    route: '/api/plan/today', mode: HYBRID,
    decision: { decision_type: 'progression', status: 'answered', payload: { target_weight: 100 } },
    validation: { valid: true }, legacy: {}, ms: 1,
    evidence: { evidence_class: 'unknown', evidence_eligible: true, request_origin: 'nope' },
  });
  await flush();
  try {
    const row = appended[0].rows[0];
    assert.equal(row[16], 'unknown', 'class normalized');
    assert.equal(row[17], 'FALSE', 'eligible recomputed from class — an injected true is not trusted');
  } finally { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; }
});

test('Brain_Shadow: legacy mode still records NOTHING (no ring, no append)', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/recommend/next', mode: 'legacy',
    decision: { decision_type: 'progression', status: 'answered' }, validation: { valid: true },
    evidence: { evidence_class: 'athlete_ui', evidence_eligible: true, request_origin: 'athlete_ui' },
  });
  await flush();
  try {
    assert.equal(entry, undefined, 'legacy mode is a no-op');
    assert.equal(appended.length, 0, 'no durable append in legacy');
  } finally { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; }
});

test('Brain_Shadow: a persistence throw never surfaces (TOTAL) even with provenance', async () => {
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async () => { throw new Error('sheets down'); });
  let entry;
  assert.doesNotThrow(() => {
    entry = brainShadow.observeBrainOrchestration({
      route: '/api/plan/today', mode: HYBRID,
      decision: { decision_type: 'progression', status: 'answered', payload: { target_weight: 100 } },
      validation: { valid: true }, legacy: {}, ms: 1,
      evidence: { evidence_class: 'athlete_ui', evidence_eligible: true, request_origin: 'athlete_ui' },
    });
  });
  await flush();
  assert.ok(entry, 'observe still returns its entry when the append throws');
  delete process.env.ATLAS_BRAIN_SHADOW_PERSIST;
});

// ── Intent_Shadow ────────────────────────────────────────────────────────────

test('Intent_Shadow: appends evidence fields at the END; existing 13 columns unchanged', async () => {
  const appended = [];
  process.env.ATLAS_INTENT_ROUTER = 'shadow';
  intentReset(async (tab, rows) => { appended.push({ tab, rows }); });
  intentShadow.observeChatMessage('skip leg extension today', {
    route: 'composer', source: 'chat', appVersion: 'v130',
    evidence: { evidence_class: 'athlete_ui', evidence_eligible: true, request_origin: 'athlete_ui' },
  });
  await flush(); await flush();
  try {
    const row = appended[0].rows[0];
    assert.equal(row[8], 'chat', 'source stays index 8');
    assert.equal(row[9], 'composer', 'route stays index 9');
    assert.equal(row[10], 'v130', 'app_version stays index 10');
    assert.equal(row[11], '', 'review_status stays index 11');
    assert.equal(row[12], '', 'review_notes stays index 12');
    assert.equal(row.length, 16, 'row grew 13 → 16');
    assert.equal(row[13], 'athlete_ui', 'evidence_class');
    assert.equal(row[14], 'TRUE', 'evidence_eligible');
    assert.equal(row[15], 'athlete_ui', 'request_origin');
  } finally { delete process.env.ATLAS_INTENT_ROUTER; }
});

test('Intent_Shadow: missing evidence fails closed to unknown/ineligible; OFF records nothing', async () => {
  const appended = [];
  // OFF: no record
  delete process.env.ATLAS_INTENT_ROUTER;
  intentReset(async (tab, rows) => { appended.push({ tab, rows }); });
  intentShadow.observeChatMessage('hello', { route: 'composer', source: 'chat' });
  await flush();
  assert.equal(appended.length, 0, 'shadow OFF → no record');

  // ON, no evidence → unknown
  process.env.ATLAS_INTENT_ROUTER = 'shadow';
  intentReset(async (tab, rows) => { appended.push({ tab, rows }); });
  intentShadow.observeChatMessage('hello', { route: 'composer', source: 'chat' });
  await flush(); await flush();
  try {
    const row = appended[0].rows[0];
    assert.equal(row[13], 'unknown');
    assert.equal(row[14], 'FALSE');
    assert.equal(row[15], '');
  } finally { delete process.env.ATLAS_INTENT_ROUTER; }
});

// ── No secret / sensitive content in the provenance cells ────────────────────

test('no raw/secret content reaches the provenance cells — request_origin is a bounded token', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  brainShadow.observeBrainOrchestration({
    route: '/api/plan/today', mode: HYBRID,
    decision: { decision_type: 'progression', status: 'answered', payload: { target_weight: 100 } },
    validation: { valid: true }, legacy: {}, ms: 1,
    // hostile injected evidence carrying a secret-looking origin
    evidence: { evidence_class: 'athlete_ui', evidence_eligible: true, request_origin: 'Bearer sk-live-DEADBEEF' },
  });
  await flush();
  try {
    const row = appended[0].rows[0];
    assert.ok(!/sk-live|Bearer/i.test(String(row[18])), 'a secret-looking request_origin is never persisted verbatim');
    assert.ok(String(row[18]).length <= 32, 'request_origin is a bounded token');
  } finally { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; }
});

// ── Hermeticity ───────────────────────────────────────────────────────────────
// The stub above would rot silently: remove it and credential-free CI stays green
// while a credentialed machine calls the provider again. This proves the provenance
// observation path issues no outbound request. It trips on the ATTEMPT, so it needs
// neither network nor credential to bite.

test('provenance observation reaches no provider, with or without an ambient key', async () => {
  const attempts = await recordProviderCalls(async () => {
    intentReset(async () => {});
    intentShadow.observeChatMessage('skip leg extension today', {
      route: 'composer', source: 'chat',
      evidence: { evidence_class: 'athlete_ui', evidence_eligible: true, request_origin: 'athlete_ui' },
    });
    await flush();
  });
  assert.deepEqual(attempts, [],
    `a unit test must not reach a provider; attempted: ${attempts.join(', ')}`);
});
