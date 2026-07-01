'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { orchestrate, ENGINE_VERSION } = require('../services/coachOrchestrator');
const { validateCoachingDecision } = require('../services/coachingDecision');
const manifest = require('../services/capabilityManifest');

before(() => manifest._resetForTesting());

const ASOF = '2026-06-30T14:00:00Z';
const SNAPSHOT = { asOf: ASOF, log_history: [], deload_state: null, profile: {}, provenance: { reads: [], derived: [] } };

function env(type, constraints = {}, source = 'button') {
  return { schema_version: 1, type, constraints, source, asOf: ASOF, actor: 'user' };
}

// ─── guards ──────────────────────────────────────────────────────────────────

describe('orchestrate — guards', () => {
  it('returns null for missing/invalid envelope', () => {
    assert.strictEqual(orchestrate(null), null);
    assert.strictEqual(orchestrate({}), null);
    assert.strictEqual(orchestrate({ envelope: {} }), null);
  });
  it('returns null for an unknown intent', () => {
    assert.strictEqual(orchestrate({ envelope: env('do_my_taxes'), snapshot: SNAPSHOT }), null);
  });
  it('returns a routed marker for a non-Brain intent (log_intent)', () => {
    const r = orchestrate({ envelope: env('log_intent'), snapshot: SNAPSHOT });
    assert.deepEqual(r, { intent: 'log_intent', brain: false, routed: 'trust_loop' });
  });
});

// ─── always produces a valid CoachingDecision ────────────────────────────────

describe('orchestrate — output always validates', () => {
  it('best_workout with no runners → valid clarification (keystones missing)', () => {
    const d = orchestrate({ envelope: env('best_workout'), snapshot: SNAPSHOT, runners: {} });
    const v = validateCoachingDecision(d);
    assert.strictEqual(v.valid, true, `errors: ${v.errors.join(' | ')}`);
    assert.strictEqual(d.decision_type, 'clarification_needed');
    assert.strictEqual(d.status, 'needs_clarification');
  });

  it('skips status:missing keystones and records them in provenance.skipped', () => {
    const d = orchestrate({ envelope: env('best_workout'), snapshot: SNAPSHOT, runners: {} });
    assert.ok(d.provenance.skipped.includes('session_generator'));
    assert.ok(d.provenance.skipped.includes('scenario_classifier'));
    assert.ok(!d.provenance.modules_run.includes('session_generator'));
    assert.strictEqual(d.provenance.engine_version, ENGINE_VERSION);
    assert.strictEqual(d.provenance.state_asOf, ASOF);
  });

  it('progress_query (read-only) → valid progress_readout-or-clarification, no throw', () => {
    const d = orchestrate({ envelope: env('progress_query'), snapshot: SNAPSHOT, runners: {} });
    assert.strictEqual(validateCoachingDecision(d).valid, true);
  });
});

// ─── answered path via injected runners ──────────────────────────────────────

describe('orchestrate — answered path (progression, partial module runs)', () => {
  // progression is status:partial (real module) so it runs when a runner is given;
  // scenario_classifier is status:missing so it is skipped.
  const runners = {
    confidence: () => ({ score: 80, tier: 'high', action: 'act', caveats: [] }),
    progression: () => ({ decision: {
      payload: { lift_code: 'BENCH', action: 'increase', target_weight: 190, target_reps: 5 },
      explanation_inputs: { target_weight: 190, target_reps: 5 },
    } }),
  };

  it('produces a valid answered progression decision', () => {
    const d = orchestrate({ envelope: env('progression_review', { target_lift: 'BENCH' }, 'chat'), snapshot: SNAPSHOT, runners });
    const v = validateCoachingDecision(d);
    assert.strictEqual(v.valid, true, `errors: ${v.errors.join(' | ')}`);
    assert.strictEqual(d.decision_type, 'progression');
    assert.strictEqual(d.status, 'answered');
    assert.strictEqual(d.payload.target_weight, 190);
  });

  it('records progression + confidence in modules_run and the missing keystone in skipped', () => {
    const d = orchestrate({ envelope: env('progression_review', { target_lift: 'BENCH' }, 'chat'), snapshot: SNAPSHOT, runners });
    assert.ok(d.provenance.modules_run.includes('progression'));
    assert.ok(d.provenance.modules_run.includes('confidence'));
    assert.ok(d.provenance.skipped.includes('scenario_classifier'));
  });

  it('run ∪ skipped equals the resolved plan (nothing dropped) and they are disjoint', () => {
    const d = orchestrate({ envelope: env('progression_review', { target_lift: 'BENCH' }, 'chat'), snapshot: SNAPSHOT, runners });
    const plan = new Set(manifest.resolve('progression_review').order.map(x => x.id));
    const union = new Set([...d.provenance.modules_run, ...d.provenance.skipped]);
    assert.deepEqual([...union].sort(), [...plan].sort());
    assert.strictEqual(d.provenance.modules_run.filter(x => d.provenance.skipped.includes(x)).length, 0);
  });

  it('honors the trust contract — a payload number not echoed makes the decision invalid', () => {
    const bad = {
      confidence: () => ({ score: 80, tier: 'high', action: 'act', caveats: [] }),
      progression: () => ({ decision: {
        payload: { lift_code: 'BENCH', action: 'increase', target_weight: 190, target_reps: 5 },
        explanation_inputs: { target_reps: 5 }, // 190 not echoed
      } }),
    };
    const d = orchestrate({ envelope: env('progression_review', { target_lift: 'BENCH' }, 'chat'), snapshot: SNAPSHOT, runners: bad });
    assert.strictEqual(validateCoachingDecision(d).valid, false);
  });
});

// ─── clarification path ──────────────────────────────────────────────────────

describe('orchestrate — clarification path', () => {
  it('confidence action=ask → clarification even when a payload exists', () => {
    const runners = {
      confidence: () => ({ score: 30, tier: 'low', action: 'ask', caveats: ['insufficient_history'] }),
      progression: () => ({ decision: {
        payload: { lift_code: 'BENCH', action: 'increase', target_weight: 190, target_reps: 5 },
        explanation_inputs: { target_weight: 190, target_reps: 5 },
      } }),
    };
    const d = orchestrate({ envelope: env('progression_review', { target_lift: 'BENCH' }, 'chat'), snapshot: SNAPSHOT, runners });
    assert.strictEqual(validateCoachingDecision(d).valid, true);
    assert.strictEqual(d.decision_type, 'clarification_needed');
    assert.strictEqual(d.confidence.action, 'ask');
    assert.ok(d.missing_info.length >= 1);
  });

  it('a throwing runner is skipped, never crashes assembly', () => {
    const runners = { confidence: () => { throw new Error('boom'); } };
    const d = orchestrate({ envelope: env('progression_review', {}, 'chat'), snapshot: SNAPSHOT, runners });
    assert.strictEqual(validateCoachingDecision(d).valid, true);
    assert.ok(d.provenance.skipped.includes('confidence'));
  });
});

// ─── rule-free guard ─────────────────────────────────────────────────────────

describe('orchestrate — rule-free coordinator', () => {
  it('imports no Brain decision module directly (only manifest + contract + state-assembly helpers)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'coachOrchestrator.js'), 'utf8');
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    const allowed = new Set(['./capabilityManifest', './coachingDecision', './stateAssembly', 'node:fs', 'node:path']);
    for (const t of requires) {
      assert.ok(allowed.has(t),
        `coachOrchestrator must not import a Brain decision module — found require('${t}'); module computation belongs in injected runners`);
    }
  });
});
