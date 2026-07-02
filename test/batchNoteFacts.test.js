'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { assembleBatchNoteFacts } = require('../services/batchNoteFacts');
const { TIERS, TRIGGERS } = require('../services/coachNoteTier');

const verdict = level => ({ level, headline: 'x' });

// ─── guards ──────────────────────────────────────────────────────────────────

describe('batchNoteFacts — guards', () => {
  for (const bad of [null, undefined, 'x', 42, {}, { sets: null }, { sets: [] }, { sets: 'nope' }]) {
    it(`null for ${JSON.stringify(bad)}`, () => {
      assert.equal(assembleBatchNoteFacts(bad), null);
    });
  }
});

// ─── the canonical batch example (plan §4) ──────────────────────────────────
// "Bench 135 10/5 185 10/2 225 5/2 x3" → the parser expands x3 to 5 sets.

describe('batchNoteFacts — canonical batch block', () => {
  const block = {
    exerciseName: 'Bench Press',
    muscleGroup: 'Chest',
    sets: [
      { weight: 135, reps: 10, rir: 5 }, // warmup/feeder (early, RIR≥4, <85% of top)
      { weight: 185, reps: 10, rir: 2 },
      { weight: 225, reps: 5, rir: 2 },
      { weight: 225, reps: 5, rir: 2 },
      { weight: 225, reps: 5, rir: 2 },
    ],
  };

  it('counts every set but excludes the warmup from working sets', () => {
    const r = assembleBatchNoteFacts(block);
    assert.equal(r.set_count, 5);
    assert.equal(r.working_set_count, 4);
  });
  it('anchors the top set on the heaviest load (225×5)', () => {
    const r = assembleBatchNoteFacts(block);
    assert.deepEqual(r.top_set, { weight: 225, reps: 5, rir: 2 });
  });
  it('a routine block with no rec/verdicts and no signals → ack_only (never fabricate)', () => {
    const r = assembleBatchNoteFacts(block);
    assert.equal(r.tier.tier, TIERS.ACK_ONLY);
    assert.equal(r.facts.effort_verdict, null);
    assert.equal(r.facts.progression_verdict, null);
  });
  it('takes engine verdicts from the supplied rec (on-target/in_pocket → ack_only, receipt-only)', () => {
    const r = assembleBatchNoteFacts(block, {
      rec: { effort_verdict: verdict('on_target'), progression_verdict: verdict('in_pocket') },
    });
    // Routine on-plan reads are receipt-only now (coachNoteTier: mild → ack_only).
    assert.equal(r.tier.tier, TIERS.ACK_ONLY);
    assert.equal(r.facts.progression_verdict.level, 'in_pocket');
  });
  it('a PR block (rec new_ground) → extended / pr_milestone', () => {
    const r = assembleBatchNoteFacts(block, { rec: { progression_verdict: verdict('new_ground') } });
    assert.equal(r.tier.tier, TIERS.EXTENDED);
    assert.equal(r.tier.trigger, TRIGGERS.PR_MILESTONE);
  });
});

// ─── analysis-driven triggers (from the block's own sets) ────────────────────

describe('batchNoteFacts — analysis-driven reads', () => {
  it('a compound redline block flags form/safety', () => {
    const r = assembleBatchNoteFacts({
      exerciseName: 'Bench Press', muscleGroup: 'Chest',
      sets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 225, reps: 3, rir: 0 }],
    });
    assert.equal(r.analysis.signals.redline_set, true);
    assert.equal(r.tier.tier, TIERS.EXTENDED);
    assert.equal(r.tier.trigger, TRIGGERS.FORM_SAFETY);
  });
  it('a single high-RIR working set at top load reads as a sandbag challenge', () => {
    // 225×5 @ RIR 4 against a target of 2 → underdosed work set.
    const r = assembleBatchNoteFacts({
      exerciseName: 'Bench Press', muscleGroup: 'Chest',
      sets: [{ weight: 225, reps: 5, rir: 4 }],
    });
    assert.equal(r.analysis.signals.high_rir_workset_underdosed, true);
    assert.equal(r.tier.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.tier.reason_code, 'high_rir_underdose');
  });
  it('recovery_active suppresses the sandbag challenge on that same block', () => {
    const r = assembleBatchNoteFacts(
      { exerciseName: 'Bench Press', muscleGroup: 'Chest', sets: [{ weight: 225, reps: 5, rir: 4 }] },
      { recovery_active: true },
    );
    assert.notEqual(r.tier.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.tier.tier, TIERS.ACK_ONLY);
  });
});

// ─── trigger flags pass through to the tier ──────────────────────────────────

describe('batchNoteFacts — trigger flags pass through', () => {
  const block = { exerciseName: 'Romanian Deadlift', sets: [{ weight: 225, reps: 8, rir: 2 }] };
  it('injury flag → pain_injury (highest precedence)', () => {
    const r = assembleBatchNoteFacts(block, { injury: 'lower back', rec: { progression_verdict: verdict('new_ground') } });
    assert.equal(r.tier.trigger, TRIGGERS.PAIN_INJURY);
  });
  it('substitution → plan_change', () => {
    const r = assembleBatchNoteFacts(block, { substitution: { from: 'Deadlift', to: 'Romanian Deadlift' } });
    assert.equal(r.tier.trigger, TRIGGERS.PLAN_CHANGE);
  });
  it('unexpected_excellence passes through', () => {
    const r = assembleBatchNoteFacts(block, { unexpected_excellence: true });
    assert.equal(r.tier.trigger, TRIGGERS.UNEXPECTED_EXCELLENCE);
  });
  it('confidence falls back to rec.confidence', () => {
    const r = assembleBatchNoteFacts(block, { rec: { confidence: { tier: 'low' } } });
    assert.equal(r.tier.trigger, TRIGGERS.LOW_CONFIDENCE);
  });
});

// ─── top-set selection ───────────────────────────────────────────────────────

describe('batchNoteFacts — top-set selection', () => {
  it('heaviest load wins over a higher-rep lighter set', () => {
    const r = assembleBatchNoteFacts({ exerciseName: 'Squat', sets: [{ weight: 225, reps: 5, rir: 2 }, { weight: 185, reps: 10, rir: 2 }] });
    assert.equal(r.top_set.weight, 225);
  });
  it('among equal loads, the hardest (lowest RIR) then latest set wins', () => {
    const r = assembleBatchNoteFacts({ exerciseName: 'Squat', sets: [
      { weight: 200, reps: 5, rir: 3 },
      { weight: 200, reps: 5, rir: 1 },
      { weight: 200, reps: 5, rir: 1 },
    ] });
    assert.deepEqual(r.top_set, { weight: 200, reps: 5, rir: 1 });
  });
  it('a bodyweight block (no loads) falls back to the last set without crashing', () => {
    const r = assembleBatchNoteFacts({ exerciseName: 'Pull Up', sets: [{ weight: null, reps: 15, rir: 1 }, { weight: null, reps: 12, rir: 1 }] });
    assert.deepEqual(r.top_set, { weight: null, reps: 12, rir: 1 });
    assert.equal(r.set_count, 2);
  });
});

// ─── input shapes + purity ───────────────────────────────────────────────────

describe('batchNoteFacts — input shapes and purity', () => {
  it('accepts compact-array sets [weight, reps, rir]', () => {
    const r = assembleBatchNoteFacts({ exerciseName: 'Bench Press', sets: [[225, 5, 2], [225, 5, 4]] });
    assert.equal(r.set_count, 2);
    assert.equal(r.top_set.weight, 225);
  });
  it('does not mutate the input block/opts', () => {
    const block = Object.freeze({ exerciseName: 'Bench Press', sets: Object.freeze([Object.freeze({ weight: 225, reps: 5, rir: 2 })]) });
    const opts = Object.freeze({ rec: Object.freeze({ progression_verdict: Object.freeze(verdict('new_ground')) }) });
    assert.doesNotThrow(() => assembleBatchNoteFacts(block, opts));
  });
  it('is deterministic across repeated calls', () => {
    const block = { exerciseName: 'Bench Press', sets: [{ weight: 225, reps: 5, rir: 2 }] };
    const opts = { rec: { progression_verdict: verdict('new_ground') } };
    assert.deepEqual(assembleBatchNoteFacts(block, opts), assembleBatchNoteFacts(block, opts));
  });
});
