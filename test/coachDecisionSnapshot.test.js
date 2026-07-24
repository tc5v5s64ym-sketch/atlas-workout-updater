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

const { buildCoachingDecisionFromExplanation } = require('../services/coachDecisionSnapshot');
const { validateCoachingDecision } = require('../services/coachingDecision');

const grounded = () => ({ coaching_strategy: 'explain_recommendation', label: 'Upper Power', target: { name: 'Bench Press', weight: 185, reps: 5, rir: 2 }, history: { last_date: '2026-07-20' } });
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

  it('carries NO prescription (progress_readout, contract rule 6) and no prescribed numbers', () => {
    const d = buildCoachingDecisionFromExplanation(grounded());
    assert.deepEqual(d.payload, {});
    assert.deepEqual(d.explanation_inputs, {});
    assert.deepEqual(d.provenance.modules_run, [], 'the shadow does not re-run the Brain');
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
