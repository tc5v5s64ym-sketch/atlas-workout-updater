'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeBrianDecision,
  summarizeLegacyRecommendation,
} = require('../services/coachDecisionSummary');

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
    // internals / safety flags leak into the summary (what ships to the client).
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
