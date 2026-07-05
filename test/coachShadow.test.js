'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  RING_MAX,
  summarizeBrianDecision,
  summarizeLegacyRecommendation,
  computeDivergence,
  observeBrianDecision,
  getCoachShadowLog,
  clearCoachShadowLog,
  _resetForTesting,
} = require('../services/coachShadow');

// A rich `progression` decision (the shape orchestrate() returns for the
// recommend/next + plan/today routes).
function progressionDecision() {
  return {
    decision_type: 'progression',
    status: 'answered',
    payload: { lift_code: 'BEN01', action: 'increase_load', lever: 'weight', target_weight: 230, target_reps: 5, rationale: 'Two clean sessions.' },
    confidence: { score: 82, tier: 'high', action: 'act', caveats: ['x'] },
    safety: { level: 'green', flags: ['nothing'], blocking: false },
    explanation_inputs: { scenario_id: 'underloaded' },
    provenance: { modules_run: ['scenario_classifier', 'progression', 'confidence'], skipped: ['fatigue'], engine_version: '1.0.0', state_asOf: 'x' },
  };
}

// A `workout` (Coach's Pick) decision — blocks carry the rep target under `reps`.
function workoutDecision() {
  return {
    decision_type: 'workout',
    status: 'answered',
    payload: {
      session_label: 'Full Body', focus: 'full_body',
      blocks: [
        { exercise: 'Back Squat', lift_code: 'SQ01', pattern: 'squat', sets: 3, reps: 5, target_weight: 295, target_rir: 2, scenario_id: 'on_target', source: 'brian', warmup: false },
        { exercise: 'Bench Press', lift_code: 'BEN01', pattern: 'push', sets: 3, reps: 5, target_weight: 185, target_rir: 2, scenario_id: 'on_target', source: 'brian', warmup: false },
      ],
    },
    confidence: { score: 70, tier: 'medium', action: 'act', caveats: [] },
    safety: { level: 'green', flags: [], blocking: false },
    provenance: { modules_run: ['session_generator'], skipped: [], engine_version: '1.0.0' },
  };
}

beforeEach(() => _resetForTesting());

describe('summarizeBrianDecision', () => {
  it('projects a progression decision to safe flat fields and omits engine internals', () => {
    const s = summarizeBrianDecision(progressionDecision());
    assert.equal(s.decision_type, 'progression');
    assert.equal(s.status, 'answered');
    assert.equal(s.action, 'increase_load');
    assert.equal(s.target_weight, 230);
    assert.equal(s.target_reps, 5);
    assert.equal(s.rationale, 'Two clean sessions.');
    assert.equal(s.confidence_tier, 'high');
    assert.equal(s.confidence_action, 'act');
    assert.equal(s.safety_level, 'green');
    assert.equal(s.block_count, null);
    assert.equal(s.blocks, null);
    // The trim: no raw provenance / module lists / explanation_inputs / confidence
    // internals / safety flags leak into the summary.
    assert.equal('provenance' in s, false);
    assert.equal('explanation_inputs' in s, false);
    assert.equal('caveats' in s, false);
    assert.equal('flags' in s, false);
    assert.equal('payload' in s, false);
  });

  it('projects a workout decision to trimmed blocks (lift_code/exercise/weight/reps) without per-block internals', () => {
    const s = summarizeBrianDecision(workoutDecision());
    assert.equal(s.decision_type, 'workout');
    assert.equal(s.session_label, 'Full Body');
    assert.equal(s.block_count, 2);
    assert.equal(s.blocks.length, 2);
    assert.deepEqual(s.blocks[0], { lift_code: 'SQ01', exercise: 'Back Squat', target_weight: 295, target_reps: 5 });
    // scenario_id / source / warmup / pattern / sets / target_rir are engine
    // internals — never in the trimmed block.
    assert.equal('scenario_id' in s.blocks[0], false);
    assert.equal('source' in s.blocks[0], false);
    assert.equal('pattern' in s.blocks[0], false);
    // progression-only fields are null for a workout (never invented).
    assert.equal(s.target_weight, null);
    assert.equal(s.target_reps, null);
  });

  it('returns null for a non-object and never throws on a malformed decision', () => {
    assert.equal(summarizeBrianDecision(null), null);
    assert.equal(summarizeBrianDecision('x'), null);
    assert.doesNotThrow(() => summarizeBrianDecision({}));
    const bare = summarizeBrianDecision({ decision_type: 'progression' });
    assert.equal(bare.target_weight, null);
    assert.equal(bare.blocks, null);
  });
});

describe('summarizeLegacyRecommendation', () => {
  it('projects the legacy recommendation prescription fields', () => {
    const s = summarizeLegacyRecommendation({ recommendation: 'Hold 225', reasoning: 'x', next_target: { weight: 225, reps: 5, sets: 3 }, target_rir: 2 });
    assert.deepEqual(s, { verdict: 'Hold 225', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 });
  });
  it('returns null for a non-object and nulls missing numbers', () => {
    assert.equal(summarizeLegacyRecommendation(null), null);
    const s = summarizeLegacyRecommendation({});
    assert.deepEqual(s, { verdict: null, target_weight: null, target_reps: null, target_sets: null, target_rir: null });
  });
});

describe('computeDivergence', () => {
  it('compares only fields Brian prescribed; equal values → comparable, not diverged', () => {
    const d = computeDivergence({ target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 }, { target_weight: 225, target_reps: 5 });
    assert.equal(d.comparable, true);
    assert.equal(d.diverged, false);
    assert.equal(d.weight_delta, 0);
    assert.equal(d.reps_delta, 0);
    assert.deepEqual(d.brian_fields, ['target_weight', 'target_reps']);
  });

  it('reports the signed delta and diverged when a compared field differs', () => {
    const d = computeDivergence({ target_weight: 225, target_reps: 5 }, { target_weight: 230, target_reps: 5 });
    assert.equal(d.diverged, true);
    assert.equal(d.weight_delta, 5);
    assert.equal(d.reps_delta, 0);
  });

  it('does NOT flag a field Brian left null as divergence (intentionally-null is not noise)', () => {
    // Brian prescribed only weight; sets/target_rir differ but are not Brian-prescribed.
    const d = computeDivergence({ target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 }, { target_weight: 225, target_reps: null });
    assert.deepEqual(d.brian_fields, ['target_weight']);
    assert.equal(d.diverged, false);
    assert.equal(d.reps_delta, null);
  });

  it('a workout summary (no top-level weight/reps) is not comparable', () => {
    const d = computeDivergence({ target_weight: 225, target_reps: 5 }, summarizeBrianDecision(workoutDecision()));
    assert.equal(d.comparable, false);
    assert.equal(d.diverged, false);
    assert.deepEqual(d.brian_fields, []);
  });

  it('legacy missing a field Brian prescribed → that field is tracked but delta null', () => {
    const d = computeDivergence(null, { target_weight: 230, target_reps: 5 });
    assert.deepEqual(d.brian_fields, ['target_weight', 'target_reps']);
    assert.equal(d.weight_delta, null);
    assert.equal(d.comparable, false);
  });
});

describe('observeBrianDecision', () => {
  it('records a summarized entry (never the raw decision) with route/lift/mode/ms and returns it', () => {
    const entry = observeBrianDecision({
      route: '/api/recommend/next', liftCode: 'BEN01', mode: 'hybrid',
      decision: progressionDecision(), legacy: { target_weight: 225, target_reps: 5 }, ms: 12,
    });
    assert.ok(entry);
    assert.equal(entry.route, '/api/recommend/next');
    assert.equal(entry.lift_code, 'BEN01');
    assert.equal(entry.mode, 'hybrid');
    assert.equal(entry.ms, 12);
    assert.equal(entry.driven_by, null); // hybrid
    assert.equal(entry.brian.target_weight, 230);
    assert.equal('provenance' in entry.brian, false, 'the ring stores the trimmed summary, not raw provenance');
    assert.equal(entry.divergence.weight_delta, 5);
    assert.equal(entry.divergence.diverged, true);
    const log = getCoachShadowLog();
    assert.equal(log.count, 1);
    assert.equal(log.entries[0], entry);
  });

  it('carries driven_by/reason through (brian mode)', () => {
    const entry = observeBrianDecision({
      route: '/api/plan/intent-recommendation', mode: 'brian',
      decision: workoutDecision(), legacy: null, ms: 4, driven_by: 'legacy', reason: 'not_serve_eligible',
    });
    assert.equal(entry.driven_by, 'legacy');
    assert.equal(entry.reason, 'not_serve_eligible');
  });

  it('skips legacy mode and a null/invalid decision (nothing to observe)', () => {
    assert.equal(observeBrianDecision({ mode: 'legacy', decision: progressionDecision() }), undefined);
    assert.equal(observeBrianDecision({ mode: 'hybrid', decision: null }), undefined);
    assert.equal(getCoachShadowLog().count, 0);
  });

  it('is TOTAL — never throws on garbage input', () => {
    assert.doesNotThrow(() => observeBrianDecision(null));
    assert.doesNotThrow(() => observeBrianDecision(undefined));
    assert.doesNotThrow(() => observeBrianDecision({ mode: 'hybrid', decision: { payload: { get target_weight() { throw new Error('boom'); } } } }));
    assert.doesNotThrow(() => observeBrianDecision('nope'));
  });

  it('caps the ring at RING_MAX, newest first', () => {
    for (let i = 0; i < RING_MAX + 10; i++) {
      observeBrianDecision({ route: '/api/recommend/next', liftCode: 'L' + i, mode: 'hybrid', decision: progressionDecision(), legacy: null, ms: i });
    }
    const log = getCoachShadowLog();
    assert.equal(log.count, RING_MAX);
    assert.equal(log.entries[0].lift_code, 'L' + (RING_MAX + 9), 'newest first');
  });
});

describe('getCoachShadowLog', () => {
  it('reports aggregate counts by route/mode/driven_by, comparable/diverged, and avg_ms', () => {
    observeBrianDecision({ route: '/api/recommend/next', mode: 'hybrid', decision: progressionDecision(), legacy: { target_weight: 225, target_reps: 5 }, ms: 10 });
    observeBrianDecision({ route: '/api/recommend/next', mode: 'hybrid', decision: progressionDecision(), legacy: { target_weight: 230, target_reps: 5 }, ms: 20 }); // weight equal → not diverged
    observeBrianDecision({ route: '/api/plan/today', mode: 'brian', decision: progressionDecision(), legacy: { target_weight: 100, target_reps: 5 }, ms: 30, driven_by: 'brian' }); // diverged
    const { aggregates, count, ring_max } = getCoachShadowLog();
    assert.equal(ring_max, RING_MAX);
    assert.equal(count, 3);
    assert.equal(aggregates.total, 3);
    assert.equal(aggregates.by_route['/api/recommend/next'], 2);
    assert.equal(aggregates.by_route['/api/plan/today'], 1);
    assert.equal(aggregates.by_mode.hybrid, 2);
    assert.equal(aggregates.by_mode.brian, 1);
    assert.equal(aggregates.by_driven_by.none, 2); // hybrid entries
    assert.equal(aggregates.by_driven_by.brian, 1);
    assert.equal(aggregates.comparable, 3);
    assert.equal(aggregates.diverged, 2); // 230-225 and 230-100 differ; 230-230 does not
    assert.equal(aggregates.avg_ms, 20); // (10+20+30)/3
  });

  it('clearCoachShadowLog empties the ring', () => {
    observeBrianDecision({ route: '/x', mode: 'hybrid', decision: progressionDecision(), legacy: null, ms: 1 });
    assert.equal(getCoachShadowLog().count, 1);
    clearCoachShadowLog();
    assert.equal(getCoachShadowLog().count, 0);
  });
});
