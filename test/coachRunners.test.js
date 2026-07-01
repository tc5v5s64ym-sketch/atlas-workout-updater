'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { buildRunners, safetyRunner, confidenceRunner } = require('../services/coachRunners');
const { buildIntentEnvelope } = require('../services/intentEnvelope');
const { assembleState } = require('../services/stateAssembly');
const { orchestrate } = require('../services/coachOrchestrator');
const { validateCoachingDecision } = require('../services/coachingDecision');
const manifest = require('../services/capabilityManifest');

before(() => manifest._resetForTesting());

const ASOF = '2026-06-30T14:00:00Z';
const LOG_ROWS = [
  ['2026-06-01', 's1', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 185, 5, 2, '', 925],
  ['2026-06-04', 's2', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 190, 5, 2, '', 950],
];

function env(type, constraints = {}) {
  return buildIntentEnvelope({ type, constraints, source: 'api', asOf: ASOF });
}

// ─── safety adapter ──────────────────────────────────────────────────────────

describe('safetyRunner', () => {
  it('returns a decision-shaped safety fragment', () => {
    const f = safetyRunner({ envelope: env('modify_workout', { injury: 'shoulder' }) });
    assert.ok(['green', 'yellow', 'red'].includes(f.level));
    assert.ok(Array.isArray(f.flags));
    assert.strictEqual(typeof f.blocking, 'boolean');
  });
  it('carries the injury as a flag', () => {
    const f = safetyRunner({ envelope: env('modify_workout', { injury: 'knee' }) });
    assert.deepEqual(f.flags, ['knee']);
  });
  it('green with no injury', () => {
    const f = safetyRunner({ envelope: env('modify_workout', {}) });
    assert.strictEqual(f.level, 'green');
    assert.strictEqual(f.blocking, false);
  });
  it('never throws on garbage ctx', () => {
    assert.doesNotThrow(() => safetyRunner(null));
    assert.doesNotThrow(() => safetyRunner({}));
  });
});

// ─── confidence adapter ──────────────────────────────────────────────────────

describe('confidenceRunner', () => {
  it('returns a decision-shaped confidence fragment', () => {
    const f = confidenceRunner({
      snapshot: { log_history: LOG_ROWS },
      envelope: env('progression_review', { target_lift: 'BENCH' }),
    });
    assert.strictEqual(typeof f.score, 'number');
    assert.ok(['high', 'moderate', 'low'].includes(f.tier));
    assert.ok(['act', 'act_with_caveat', 'ask'].includes(f.action));
    assert.ok(Array.isArray(f.caveats));
  });
  it('handles a missing lift / empty history without throwing', () => {
    const f = confidenceRunner({ snapshot: { log_history: [] }, envelope: env('progression_review', {}) });
    assert.strictEqual(typeof f.score, 'number');
  });
  it('never throws on garbage ctx', () => {
    assert.doesNotThrow(() => confidenceRunner(null));
    assert.doesNotThrow(() => confidenceRunner({}));
  });
});

// ─── registry ────────────────────────────────────────────────────────────────

describe('buildRunners', () => {
  it('exposes safety + confidence adapters', () => {
    const r = buildRunners();
    assert.strictEqual(typeof r.safety, 'function');
    assert.strictEqual(typeof r.confidence, 'function');
  });
});

// ─── full shadow composition (mirrors the index.js hybrid attach) ────────────

describe('shadow composition — envelope → assembleState(stub) → orchestrate → validate', () => {
  // Stub readers so no live Sheets / googleapis is touched, mirroring the
  // gated index.js path (which uses real readers in production).
  function stubReaders() {
    return {
      getLogRows:      async () => LOG_ROWS,
      readDeloadState: async () => null,
      getProfile:      async () => ({ profile_goal: 'powerlifting', training_level: 'intermediate', population: 'general' }),
    };
  }

  it('progression_review (recommend endpoint intent) → a VALID CoachingDecision', async () => {
    const envelope = env('progression_review', { target_lift: 'BENCH' });
    const snapshot = await assembleState({ readers: stubReaders(), asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    const v = validateCoachingDecision(brian);
    assert.strictEqual(v.valid, true, `errors: ${v.errors.join(' | ')}`);
    // confidence adapter ran; the missing keystone (scenario_classifier) is skipped
    assert.ok(brian.provenance.modules_run.includes('confidence'));
    assert.ok(brian.provenance.skipped.includes('scenario_classifier'));
  });

  it('modify_workout exercises both safety + confidence adapters and validates', async () => {
    const envelope = env('modify_workout', { injury: 'shoulder', target_lift: 'BENCH' });
    const snapshot = await assembleState({ readers: stubReaders(), asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    assert.strictEqual(validateCoachingDecision(brian).valid, true);
    assert.ok(brian.provenance.modules_run.includes('safety'));
    assert.ok(brian.provenance.modules_run.includes('confidence'));
  });

  it('the attached decision only surfaces when valid (guard mirrors index.js)', async () => {
    const envelope = env('progression_review', { target_lift: 'BENCH' });
    const snapshot = await assembleState({ readers: stubReaders(), asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    // index.js attaches only if validateCoachingDecision(brian).valid — assert that gate is satisfiable
    assert.strictEqual(validateCoachingDecision(brian).valid, true);
  });
});
