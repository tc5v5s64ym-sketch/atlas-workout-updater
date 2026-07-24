'use strict';

// Canonical decision boundary adapter — Phase 4 H-03 (shadow-first, first increment).
//
// buildCoachingDecisionFromExplanation canonicalizes the route's read-only explain-recommendation
// decision (the coachExplanationGrounding snapshot on res.locals.coachRecommendationGrounding)
// into a validating `progress_readout` CoachingDecision, or null. These tests prove it builds a
// contract-valid decision, derives confidence conservatively from the grounding signal, carries
// no prescription, and fails closed on a non-explain / absent snapshot.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildCoachingDecisionFromExplanation, buildRecoveryDecision } = require('../services/coachDecisionSnapshot');
const { validateCoachingDecision } = require('../services/coachingDecision');

const grounded = () => ({ coaching_strategy: 'explain_recommendation', label: 'Upper Power', target: { name: 'Bench Press', weight: 185, reps: 5, rir: 2 }, history: { last_date: '2026-07-20', last_top: '190 for 5 at 2 RIR' } });
const outage = () => ({ coaching_strategy: 'explain_recommendation', label: null, target: { name: 'Bench Press', weight: 185 }, history: null });

describe('buildCoachingDecisionFromExplanation — valid canonicalization', () => {
  it('builds a contract-VALID progress_readout decision from a grounded snapshot', () => {
    const d = buildCoachingDecisionFromExplanation(grounded());
    assert.ok(d, 'a decision is returned');
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
    assert.equal(d.decision_type, 'progress_readout');
    assert.equal(d.intent.type, 'explain_recommendation');
    assert.equal(d.status, 'answered');
  });

  it('uses the CANONICAL IntentEnvelope source "chat" for the /api/coach/chat boundary (Codex #1151 P2)', () => {
    const d = buildCoachingDecisionFromExplanation(grounded());
    const vocab = require('../config/coaching/contracts/intent.vocabulary.json');
    assert.equal(d.intent.source, 'chat');
    assert.ok(vocab.sources.includes(d.intent.source), 'source must be in the closed IntentEnvelope vocabulary');
    assert.ok(!vocab.sources.includes('coach_chat'), 'coach_chat is deliberately NOT the canonical source');
  });

  it('carries NO prescription in the PAYLOAD (progress_readout, contract rule 6); no Brain re-run', () => {
    const d = buildCoachingDecisionFromExplanation(grounded());
    assert.deepEqual(d.payload, {});
    assert.deepEqual(d.provenance.modules_run, [], 'the shadow does not re-run the Brain');
  });

  it('populates explanation_inputs with the DISPLAYED readout facts (the LLM may word these)', () => {
    const d = buildCoachingDecisionFromExplanation(grounded());
    assert.equal(d.explanation_inputs.target_name, 'Bench Press');
    assert.equal(d.explanation_inputs.target_weight, 185);
    assert.equal(d.explanation_inputs.target_reps, 5);
    assert.equal(d.explanation_inputs.target_rir, 2);
    assert.equal(d.explanation_inputs.recommendation_label, 'Upper Power');
    // the decision stays contract-valid (progress_readout has no prescribed PAYLOAD numbers,
    // so these readout facts in explanation_inputs never trip the trust contract)
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
  });

  it('carries the target lift history facts the route explanation words (last_date + top set)', () => {
    const d = buildCoachingDecisionFromExplanation(grounded());
    // The SAME grounded prior fact coachExplanationGrounding.buildDeterministicRecommendationExplanation
    // cites ("Your last logged <lift> was <date> at <top set>") — so the canonical decision fully
    // captures what the route says (a precondition for future byte-identical live consumption).
    assert.equal(d.explanation_inputs.target_last_date, '2026-07-20');
    assert.equal(d.explanation_inputs.target_last_top, '190 for 5 at 2 RIR');
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
  });

  it('omits a last_top when history carries only a date (honest — nothing more to word)', () => {
    const d = buildCoachingDecisionFromExplanation({ coaching_strategy: 'explain_recommendation', label: 'Upper Power', target: { name: 'Bench Press', weight: 185 }, history: { last_date: '2026-07-20' } });
    assert.equal(d.explanation_inputs.target_last_date, '2026-07-20');
    assert.ok(!('target_last_top' in d.explanation_inputs), 'no top set ⇒ key absent, never null/empty');
  });

  it('omits absent facts — an outage snapshot with no numbers yields empty explanation_inputs', () => {
    const d = buildCoachingDecisionFromExplanation({ coaching_strategy: 'explain_recommendation', label: null, target: {}, history: null });
    assert.deepEqual(d.explanation_inputs, {}, 'nothing to word ⇒ empty (honest)');
    assert.equal(validateCoachingDecision(d).valid, true);
  });

  it('derives conservative confidence from the grounding signal (never fabricates high)', () => {
    const g = buildCoachingDecisionFromExplanation(grounded());
    assert.equal(g.confidence.tier, 'moderate');
    assert.equal(g.confidence.action, 'act');
    assert.deepEqual(g.confidence.caveats, []);
    const o = buildCoachingDecisionFromExplanation(outage());
    assert.equal(o.confidence.tier, 'low');
    assert.equal(o.confidence.action, 'act_with_caveat');
    assert.deepEqual(o.confidence.caveats, ['insufficient_history']);
    assert.equal(validateCoachingDecision(o).valid, true, validateCoachingDecision(o).errors.join(' | '));
  });

  it('history without last_date is treated as ungrounded (outage confidence)', () => {
    const d = buildCoachingDecisionFromExplanation({ coaching_strategy: 'explain_recommendation', label: null, history: {} });
    assert.equal(d.confidence.tier, 'low');
  });

  it('a green/non-blocking safety default (the route safety verdict is still route-local, H-12)', () => {
    const d = buildCoachingDecisionFromExplanation(grounded());
    assert.deepEqual(d.safety, { level: 'green', flags: [], blocking: false });
  });
});

describe('buildCoachingDecisionFromExplanation — fails closed', () => {
  it('returns null for a non-explain-recommendation snapshot', () => {
    assert.equal(buildCoachingDecisionFromExplanation({ coaching_strategy: 'plan_grounded' }), null);
    assert.equal(buildCoachingDecisionFromExplanation({ target: { name: 'Bench' } }), null, 'no coaching_strategy → null');
  });

  it('returns null for an absent / malformed grounding', () => {
    assert.equal(buildCoachingDecisionFromExplanation(null), null);
    assert.equal(buildCoachingDecisionFromExplanation(undefined), null);
    assert.equal(buildCoachingDecisionFromExplanation('nope'), null);
    assert.equal(buildCoachingDecisionFromExplanation([]), null);
  });
});

describe('buildRecoveryDecision — the recovery-routing decision (H-03)', () => {
  it('builds a contract-VALID recovery decision (readiness_checkin intent, no prescription)', () => {
    const d = buildRecoveryDecision({ engine_grounded: true });
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
    assert.equal(d.decision_type, 'recovery');
    assert.equal(d.intent.type, 'readiness_checkin');
    assert.equal(d.intent.source, 'chat');
    assert.deepEqual(d.payload, {});
    assert.deepEqual(d.safety, { level: 'green', flags: [], blocking: false });
  });

  it('derives conservative confidence from engine-grounding (never fabricates high)', () => {
    const g = buildRecoveryDecision({ engine_grounded: true });
    assert.equal(g.confidence.tier, 'moderate');
    assert.equal(g.confidence.action, 'act');
    assert.deepEqual(g.confidence.caveats, []);
    const o = buildRecoveryDecision({ engine_grounded: false });
    assert.equal(o.confidence.tier, 'low');
    assert.equal(o.confidence.action, 'act_with_caveat');
    assert.deepEqual(o.confidence.caveats, ['limited_readiness_inputs']);
    assert.equal(validateCoachingDecision(o).valid, true, validateCoachingDecision(o).errors.join(' | '));
  });

  it('tolerates a missing / malformed signal (defaults to the ungrounded, valid decision)', () => {
    assert.equal(validateCoachingDecision(buildRecoveryDecision()).valid, true);
    assert.equal(buildRecoveryDecision(null).confidence.tier, 'low');
    assert.equal(buildRecoveryDecision('nope').confidence.tier, 'low');
  });
});

describe('buildRecoveryDecision — explanation_inputs carries the recovery reason facts (H-03)', () => {
  it('an engine-grounded, elevated + back-to-back turn carries fatigue_status + days_since_last_session', () => {
    const d = buildRecoveryDecision({ engine_grounded: true, fatigueStatus: { status: 'high' }, daysSinceLastSession: 1, readiness: [] });
    assert.deepEqual(d.explanation_inputs, { fatigue_status: 'high', days_since_last_session: 1 });
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
  });

  it('carries the fatigued-pattern list from the readiness snapshot', () => {
    const d = buildRecoveryDecision({ engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 2, readiness: [
      { pattern: 'horizontal push', status: 'fatigued' },
      { pattern: 'hinge', status: 'fatigued' },
      { pattern: 'squat', status: 'ready' },
    ] });
    assert.deepEqual(d.explanation_inputs.fatigued_patterns, ['horizontal push', 'hinge']);
    assert.equal(d.explanation_inputs.fatigue_status, 'normal');
    assert.equal(d.explanation_inputs.days_since_last_session, 2);
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
  });

  it('days === 0 (trained today) is carried, not dropped as falsy', () => {
    const d = buildRecoveryDecision({ engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 0 });
    assert.equal(d.explanation_inputs.days_since_last_session, 0);
  });

  it('the recovered branch carries a normal status + day count', () => {
    const d = buildRecoveryDecision({ engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 5, readiness: [] });
    assert.deepEqual(d.explanation_inputs, { fatigue_status: 'normal', days_since_last_session: 5 });
  });

  it('an OUTAGE/limited signal (client readiness only) carries at most fatigued_patterns + the limited caveat', () => {
    const d = buildRecoveryDecision({ engine_grounded: false, readiness: [{ pattern: 'hinge', status: 'fatigued' }] });
    assert.deepEqual(d.explanation_inputs, { fatigued_patterns: ['hinge'] }, 'no engine fatigue_status / days on the outage path');
    assert.deepEqual(d.confidence.caveats, ['limited_readiness_inputs'], 'the engine-grounded vs outage distinction is preserved');
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
  });

  it('a bare / malformed signal yields empty explanation_inputs (honest — nothing to word), still valid', () => {
    assert.deepEqual(buildRecoveryDecision({ engine_grounded: false }).explanation_inputs, {});
    assert.deepEqual(buildRecoveryDecision({ engine_grounded: true, fatigueStatus: 'nope', readiness: 'nope', daysSinceLastSession: 'abc' }).explanation_inputs, {});
    assert.equal(validateCoachingDecision(buildRecoveryDecision()).valid, true);
  });

  it('the fatigued_patterns array value never trips the trust contract (recovery has no prescribed numbers)', () => {
    const d = buildRecoveryDecision({ engine_grounded: true, readiness: [{ pattern: 'a', status: 'fatigued' }, { pattern: 'b', status: 'fatigued' }] });
    assert.ok(Array.isArray(d.explanation_inputs.fatigued_patterns));
    assert.equal(validateCoachingDecision(d).valid, true, validateCoachingDecision(d).errors.join(' | '));
  });
});
