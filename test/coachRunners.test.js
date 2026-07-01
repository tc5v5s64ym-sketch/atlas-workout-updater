'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRunners, safetyRunner, confidenceRunner, scenarioClassifierRunner, progressionRunner,
  sessionGeneratorRunner,
} = require('../services/coachRunners');
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
  it('exposes safety + confidence + scenario_classifier + progression adapters', () => {
    const r = buildRunners();
    assert.strictEqual(typeof r.safety, 'function');
    assert.strictEqual(typeof r.confidence, 'function');
    assert.strictEqual(typeof r.scenario_classifier, 'function');
    assert.strictEqual(typeof r.progression, 'function');
  });
});

// Rich history: 6 sessions of steady improvement — enough for confidence to clear
// 'ask' (act_with_caveat) so the orchestrator can produce an ANSWERED decision.
const RICH_ROWS = (() => {
  const dates = ['2026-05-20', '2026-05-24', '2026-05-28', '2026-06-01', '2026-06-05', '2026-06-08'];
  let w = 180; const rows = [];
  for (let i = 0; i < 6; i++) { rows.push([dates[i], 's' + i, 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, w, 5, 2, '', w * 5]); w += 5; }
  return rows;
})();

describe('scenarioClassifierRunner', () => {
  it('classifies a scenario from snapshot history', () => {
    const f = scenarioClassifierRunner({ snapshot: { asOf: ASOF, log_history: RICH_ROWS }, envelope: env('progression_review', { target_lift: 'BENCH' }) });
    assert.ok(f && typeof f.scenario_id === 'string');
  });
  it('returns null without a target lift', () => {
    assert.strictEqual(scenarioClassifierRunner({ snapshot: { asOf: ASOF, log_history: RICH_ROWS }, envelope: env('progression_review', {}) }), null);
  });
  it('never throws on garbage', () => assert.doesNotThrow(() => scenarioClassifierRunner(null)));
});

describe('progressionRunner', () => {
  it('emits a decision fragment whose numbers are echoed under matching keys', () => {
    const results = { scenario_classifier: { scenario_id: 'underloaded' } };
    const f = progressionRunner({ snapshot: { asOf: ASOF, log_history: RICH_ROWS }, envelope: env('progression_review', { target_lift: 'BENCH' }), results });
    assert.ok(f && f.decision && f.decision.payload && f.decision.explanation_inputs);
    assert.strictEqual(f.decision.payload.lift_code, 'BENCH');
    // key-aware: any prescribed number in payload is echoed under the same key
    for (const k of ['target_weight', 'target_reps']) {
      if (typeof f.decision.payload[k] === 'number') {
        assert.strictEqual(f.decision.explanation_inputs[k], f.decision.payload[k]);
      }
    }
  });
  it('returns null when no scenario was classified', () => {
    const f = progressionRunner({ snapshot: { asOf: ASOF, log_history: RICH_ROWS }, envelope: env('progression_review', { target_lift: 'BENCH' }), results: {} });
    assert.strictEqual(f, null);
  });
  it('never throws on garbage', () => assert.doesNotThrow(() => progressionRunner(null)));

  it('selects the chronologically-most-recent set even when rows are out of order', () => {
    // Most recent session (215 lb) placed FIRST in the array to defeat positional order.
    const outOfOrder = [
      ['2026-06-08', 's3', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 215, 5, 1, '', 1075],
      ['2026-06-01', 's1', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 205, 5, 3, '', 1025],
      ['2026-06-04', 's2', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 210, 5, 2, '', 1050],
    ];
    // increase_load scenario so a targetWeight is produced from the selected set.
    const f = progressionRunner({
      snapshot: { asOf: ASOF, log_history: outOfOrder },
      envelope: env('progression_review', { target_lift: 'BENCH' }),
      results: { scenario_classifier: { scenario_id: 'underloaded' } },
    });
    assert.ok(f && f.decision, 'expected a decision fragment');
    // The prescription must build on 215 (the 2026-06-08 set), not 210 (positional last).
    assert.ok(f.decision.payload.target_weight > 215,
      `expected target_weight built on the 215 set, got ${f.decision.payload.target_weight}`);
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
    // confidence + scenario_classifier adapters ran; a runner-less capability is skipped
    assert.ok(brian.provenance.modules_run.includes('confidence'));
    assert.ok(brian.provenance.modules_run.includes('scenario_classifier'));
    assert.ok(brian.provenance.skipped.includes('expected_performance'));
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

  it('rich history → an ANSWERED progression decision (first real Brian answer)', async () => {
    const envelope = env('progression_review', { target_lift: 'BENCH' });
    const snapshot = await assembleState({ readers: { ...stubReaders(), getLogRows: async () => RICH_ROWS }, asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    const v = validateCoachingDecision(brian);
    assert.strictEqual(v.valid, true, `errors: ${v.errors.join(' | ')}`);
    assert.strictEqual(brian.status, 'answered', `expected answered, got ${brian.status} (${brian.decision_type})`);
    assert.strictEqual(brian.decision_type, 'progression');
    assert.strictEqual(brian.payload.lift_code, 'BENCH');
    // scenario_classifier + progression ran; the trust contract held (valid=true above)
    assert.ok(brian.provenance.modules_run.includes('scenario_classifier'));
    assert.ok(brian.provenance.modules_run.includes('progression'));
  });

  it('thin history → clarification (honest — confidence stays ask)', async () => {
    const thin = [['2026-06-08', 's1', 'Bench Press', 'Bench Press', 'chest', 'BENCH', 1, 185, 5, 2, '', 925]];
    const envelope = env('progression_review', { target_lift: 'BENCH' });
    const snapshot = await assembleState({ readers: { ...stubReaders(), getLogRows: async () => thin }, asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    assert.strictEqual(validateCoachingDecision(brian).valid, true);
    assert.strictEqual(brian.decision_type, 'clarification_needed');
  });
});

// Full-body history covering the four core patterns (barbell variants) with enough
// sessions for whole-workout confidence to clear 'ask'.
function fullBodyRows() {
  const dates = ['2026-05-16', '2026-05-20', '2026-05-24', '2026-05-28', '2026-06-01', '2026-06-05'];
  const out = [];
  for (const [ex, code, m, w0] of [['Back Squat', 'SQUAT', 'quads', 225], ['Bench Press', 'BENCH', 'chest', 185],
    ['Barbell Row', 'ROW', 'back', 135], ['Romanian Deadlift', 'RDL', 'hamstrings', 205]]) {
    let w = w0;
    for (let i = 0; i < 6; i++) { out.push([dates[i], 's' + code + i, ex, ex, m, code, 1, w, 5, 2, '', w * 5]); w += 5; }
  }
  return out;
}

describe('sessionGeneratorRunner', () => {
  it('returns a workout decision fragment from snapshot + constraints', () => {
    const f = sessionGeneratorRunner({ snapshot: { asOf: ASOF, log_history: fullBodyRows() }, envelope: env('best_workout', {}) });
    assert.ok(f && f.decision && Array.isArray(f.decision.payload.blocks));
    assert.ok(f.decision.explanation_inputs.blocks.length === f.decision.payload.blocks.length);
  });
  it('returns null when buildSession can build nothing (no history)', () => {
    assert.strictEqual(sessionGeneratorRunner({ snapshot: { asOf: ASOF, log_history: [] }, envelope: env('best_workout', {}) }), null);
  });
  it('never throws on garbage', () => assert.doesNotThrow(() => sessionGeneratorRunner(null)));
});

describe('shadow composition — best_workout → answered workout (first full Brian workout)', () => {
  function readers(rows) {
    return { getLogRows: async () => rows, readDeloadState: async () => null,
      getProfile: async () => ({ profile_goal: 'general-fitness', training_level: 'intermediate', population: 'general' }) };
  }
  it('rich full-body history → an ANSWERED workout decision', async () => {
    const envelope = env('best_workout', {});
    const snapshot = await assembleState({ readers: readers(fullBodyRows()), asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    const v = validateCoachingDecision(brian);
    assert.strictEqual(v.valid, true, `errors: ${v.errors.join(' | ')}`);
    assert.strictEqual(brian.status, 'answered', `got ${brian.status}/${brian.decision_type}`);
    assert.strictEqual(brian.decision_type, 'workout');
    assert.ok(brian.payload.blocks.length >= 1);
    assert.ok(brian.provenance.modules_run.includes('session_generator'));
  });
  it('no history → clarification', async () => {
    const envelope = env('best_workout', {});
    const snapshot = await assembleState({ readers: readers([]), asOf: ASOF });
    const brian = orchestrate({ envelope, snapshot, runners: buildRunners() });
    assert.strictEqual(validateCoachingDecision(brian).valid, true);
    assert.strictEqual(brian.decision_type, 'clarification_needed');
  });
});
