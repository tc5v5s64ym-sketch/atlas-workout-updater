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

const HYBRID = 'hybrid';
const flush = () => new Promise(r => setImmediate(r));

function brainReset(appendImpl) { brainShadow._resetForTesting(appendImpl ? { append: appendImpl } : {}); }
function intentReset(appendImpl) { intentShadow._resetForTesting(appendImpl ? { append: appendImpl } : {}); }

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

test('Brain_Shadow: a synthetic evidence object records synthetic/ineligible', async () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  brainReset(async (tab, rows) => { appended.push({ tab, rows }); });
  brainShadow.observeBrainFailure({
    route: '/api/recommend/next', liftCode: 'BEN01', mode: HYBRID, reason: 'orchestrator_error', ms: 2,
    evidence: { evidence_class: 'synthetic', evidence_eligible: false, request_origin: 'sim' },
  });
  await flush();
  try {
    const row = appended[0].rows[0];
    assert.equal(row[16], 'synthetic');
    assert.equal(row[17], 'FALSE');
    assert.equal(row[18], 'sim');
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
