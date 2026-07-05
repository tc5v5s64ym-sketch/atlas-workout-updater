'use strict';

// Brain ORCHESTRATOR shadow lane — unit coverage for services/brainShadow. Proves
// the recorder captures ONE entry per orchestration outcome (win, decline/invalid,
// null, non-brain route, AND a thrown crash), that it is mode-gated (inert in
// legacy), that the best-effort Sheets mirror is fire-and-forget and can never
// surface a failure, and that the read snapshot aggregates wins vs. failures.
// Pure module test — no app boot, no network (append is injected).

const test = require('node:test');
const assert = require('node:assert/strict');

const brainShadow = require('../services/brainShadow');

const HYBRID = 'hybrid';

function reset(appendImpl) {
  brainShadow._resetForTesting(appendImpl ? { append: appendImpl } : {});
}

// Silence the one console line per record so the suite output stays clean.
const originalLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = originalLog; });

test('WIN: records ok:true with decision_type/status/confidence tier, skipped, and divergence', () => {
  const appended = [];
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1'; // opt into the durable mirror for this assertion
  reset(async (tab, rows) => { appended.push({ tab, rows }); });
  const decision = {
    decision_type: 'progression',
    status: 'answered',
    confidence: { tier: 'high', action: 'answer' },
    payload: { target_weight: 235, target_reps: 5 },
    provenance: { skipped: ['deload_guard', 'fatigue_model'] },
  };
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/recommend/next', liftCode: 'SQ01', mode: HYBRID,
    decision, validation: { valid: true },
    legacy: { target_weight: 225, target_reps: 5 }, ms: 4,
  });

  assert.ok(entry, 'an entry is returned');
  assert.equal(entry.ok, true);
  assert.equal(entry.reason, null);
  assert.equal(entry.decision_type, 'progression');
  assert.equal(entry.status, 'answered');
  assert.equal(entry.confidence_tier, 'high');
  assert.deepEqual(entry.skipped, ['deload_guard', 'fatigue_model'], 'declared skipped capabilities captured');
  assert.equal(entry.divergence.comparable, true);
  assert.equal(entry.divergence.diverged, true);
  assert.equal(entry.divergence.weight_delta, 10);
  assert.equal(entry.divergence.reps_delta, 0);
  assert.equal(entry.ms, 4);

  // Best-effort Sheets mirror fired to the Brain_Shadow tab (fire-and-forget).
  return new Promise(r => setImmediate(r)).then(() => {
    assert.equal(appended.length, 1);
    assert.equal(appended[0].tab, brainShadow.SHADOW_TAB);
    assert.equal(appended[0].tab, 'Brain_Shadow');
    const row = appended[0].rows[0];
    assert.equal(row[1], '/api/recommend/next');
    assert.equal(row[2], 'SQ01');
    assert.equal(row[4], 'TRUE', 'ok column');
    assert.equal(row[6], 'progression');
  }).finally(() => { delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; });
});

test('durable mirror is OFF by default: no Sheets append fires without ATLAS_BRAIN_SHADOW_PERSIST', async () => {
  const appended = [];
  delete process.env.ATLAS_BRAIN_SHADOW_PERSIST; // default
  reset(async (tab, rows) => { appended.push({ tab, rows }); });
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/recommend/next', liftCode: 'SQ01', mode: HYBRID,
    decision: { payload: { target_weight: 100 }, provenance: {} }, validation: { valid: true }, ms: 1,
  });
  assert.ok(entry, 'the ring still records (the reviewable record the flip needs)');
  await new Promise(r => setImmediate(r));
  assert.equal(appended.length, 0, 'no durable Sheets write from the read route by default — write path untouched');
  assert.equal(brainShadow.getBrainShadowLog().count, 1);
});

test('FAILURE — invalid decision: records ok:false, reason invalid_decision (the swallowed decline)', () => {
  reset();
  const decision = {
    decision_type: 'clarification_needed',
    status: 'needs_clarification',
    confidence: { tier: 'low', action: 'ask' },
    payload: { reason: 'insufficient_data' },
    provenance: { skipped: ['progression'] },
  };
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/recommend/next', liftCode: 'SQ01', mode: HYBRID,
    decision, validation: { valid: false, errors: ['payload.target_weight missing'] },
    legacy: { target_weight: 225, target_reps: 5 }, ms: 2,
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, 'invalid_decision');
  assert.equal(entry.decision_type, 'clarification_needed', 'still captures what the invalid decision declared');
  assert.deepEqual(entry.skipped, ['progression']);
});

test('FAILURE — null decision: records ok:false, reason null_decision', () => {
  reset();
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/plan/today', liftCode: 'BEN01', mode: HYBRID,
    decision: null, validation: { valid: false }, legacy: null, ms: 1,
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, 'null_decision');
  assert.equal(entry.decision_type, null);
  assert.deepEqual(entry.skipped, []);
});

test('FAILURE — non-brain route object: records ok:false, reason non_brain_route', () => {
  reset();
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/plan/today', mode: HYBRID,
    decision: { intent: 'log_intent', brain: false, routed: 'trust_loop' },
    validation: { valid: false }, ms: 0,
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, 'non_brain_route');
});

test('FAILURE — thrown crash: observeBrainFailure records ok:false with the reason', () => {
  reset();
  const entry = brainShadow.observeBrainFailure({
    route: '/api/recommend/next', liftCode: 'SQ01', mode: HYBRID, reason: 'orchestrator_error',
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.reason, 'orchestrator_error');
  assert.equal(entry.decision_type, null);
  assert.equal(entry.divergence.comparable, false);
});

test('observeBrainFailure defaults reason to orchestrator_error', () => {
  reset();
  const entry = brainShadow.observeBrainFailure({ route: '/api/plan/today', mode: HYBRID });
  assert.equal(entry.reason, 'orchestrator_error');
});

test('mode gate: legacy (unset/other) records NOTHING — keeps byte-identity', () => {
  reset();
  assert.equal(brainShadow.observeBrainOrchestration({ mode: undefined, decision: {}, validation: { valid: true } }), undefined);
  assert.equal(brainShadow.observeBrainOrchestration({ mode: 'legacy', decision: {}, validation: { valid: true } }), undefined);
  assert.equal(brainShadow.observeBrainFailure({ mode: 'legacy' }), undefined);
  assert.equal(brainShadow.getBrainShadowLog().count, 0);
});

test('brian mode also records', () => {
  reset();
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/recommend/next', mode: 'brian',
    decision: { decision_type: 'progression', status: 'answered', payload: { target_weight: 100 }, provenance: {} },
    validation: { valid: true }, ms: 1,
  });
  assert.ok(entry);
  assert.equal(entry.mode, 'brian');
});

test('divergence is non-comparable when the legacy summary carries no target numbers', () => {
  reset();
  const entry = brainShadow.observeBrainOrchestration({
    route: '/api/plan/intent-recommendation', mode: HYBRID,
    decision: { decision_type: 'workout', status: 'answered', payload: { blocks: [] }, provenance: {} },
    validation: { valid: true },
    legacy: { recommended_label: 'Upper A', exercise_count: 5 }, ms: 3,
  });
  assert.equal(entry.divergence.comparable, false);
  assert.equal(entry.divergence.diverged, false);
  assert.equal(entry.divergence.weight_delta, null);
});

test('ring is capped at RING_MAX (newest first)', () => {
  reset();
  for (let i = 0; i < brainShadow.RING_MAX + 10; i++) {
    brainShadow.observeBrainFailure({ route: '/r' + i, mode: HYBRID, reason: 'orchestrator_error' });
  }
  const log = brainShadow.getBrainShadowLog();
  assert.equal(log.count, brainShadow.RING_MAX);
  assert.equal(log.entries.length, brainShadow.RING_MAX);
  assert.equal(log.entries[0].route, '/r' + (brainShadow.RING_MAX + 9), 'newest first');
});

test('snapshot aggregates wins vs failures and reasons', () => {
  reset();
  brainShadow.observeBrainOrchestration({ route: '/a', mode: HYBRID, decision: { payload: {}, provenance: {} }, validation: { valid: true } });
  brainShadow.observeBrainOrchestration({ route: '/a', mode: HYBRID, decision: null, validation: { valid: false } });
  brainShadow.observeBrainFailure({ route: '/b', mode: HYBRID, reason: 'orchestrator_error' });
  const { aggregates } = brainShadow.getBrainShadowLog();
  assert.equal(aggregates.total, 3);
  assert.equal(aggregates.ok, 1);
  assert.equal(aggregates.failed, 2);
  assert.equal(aggregates.by_reason.null_decision, 1);
  assert.equal(aggregates.by_reason.orchestrator_error, 1);
  assert.equal(aggregates.by_route['/a'], 2);
});

test('TOTAL: a throwing Sheets append never surfaces and the ring still records', async () => {
  process.env.ATLAS_BRAIN_SHADOW_PERSIST = '1';
  try {
    reset(async () => { throw new Error('tab missing / no creds'); });
    const entry = brainShadow.observeBrainOrchestration({
      route: '/api/recommend/next', mode: HYBRID,
      decision: { payload: { target_weight: 100 }, provenance: {} }, validation: { valid: true }, ms: 1,
    });
    assert.ok(entry, 'the in-memory record still happens even when persistence throws');
    // Let the fire-and-forget rejection settle; it must be swallowed (no unhandled rejection).
    await new Promise(r => setImmediate(r));
    assert.equal(brainShadow.getBrainShadowLog().count, 1);
  } finally {
    delete process.env.ATLAS_BRAIN_SHADOW_PERSIST;
  }
});

test('isBrainShadowEnabled reflects ATLAS_COACH_ENGINE', () => {
  const original = process.env.ATLAS_COACH_ENGINE;
  try {
    delete process.env.ATLAS_COACH_ENGINE;
    assert.equal(brainShadow.isBrainShadowEnabled(), false);
    process.env.ATLAS_COACH_ENGINE = 'hybrid';
    assert.equal(brainShadow.isBrainShadowEnabled(), true);
    process.env.ATLAS_COACH_ENGINE = 'brian';
    assert.equal(brainShadow.isBrainShadowEnabled(), true);
    process.env.ATLAS_COACH_ENGINE = 'legacy';
    assert.equal(brainShadow.isBrainShadowEnabled(), false);
  } finally {
    if (original === undefined) delete process.env.ATLAS_COACH_ENGINE;
    else process.env.ATLAS_COACH_ENGINE = original;
  }
});
