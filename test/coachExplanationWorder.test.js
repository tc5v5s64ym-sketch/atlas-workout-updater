'use strict';

// Shared recommendation-explanation worder + the canonical-decision bridge — Phase 4 H-03
// (live-consumption groundwork).
//
// buildDeterministicRecommendationExplanation (from the route-local grounding snapshot) and
// buildDeterministicRecommendationExplanationFromDecision (from a canonical CoachTurnPacket
// decision's explanation_inputs) now funnel their facts through ONE private worder. These tests
// prove the two produce a BYTE-IDENTICAL string for a decision built from a snapshot — the
// invariant that lets the live route word the explanation from packet.decision without changing
// the served reply — plus the worder's fail-closed edges. No route is exercised here; this is the
// isolated equivalence proof that de-risks the subsequent flag-gated route wiring.
//
// Scope of the byte-identical guarantee: the realistic snapshot shape the route actually produces
// (coachExplanationGrounding.buildRecommendationSnapshot — trimmed strings, finite numbers). The
// decision's explanation_inputs are built by coachDecisionSnapshot._explanationInputsFrom, which
// trims strings; buildRecommendationSnapshot / buildTargetHistory never emit surrounding
// whitespace, so the two paths coincide exactly for every input the route can send.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const explanationGrounding = require('../services/coachExplanationGrounding');
const { buildCoachingDecisionFromExplanation } = require('../services/coachDecisionSnapshot');
const { validateCoachingDecision } = require('../services/coachingDecision');

const {
  buildDeterministicRecommendationExplanation,
  buildDeterministicRecommendationExplanationFromDecision,
  buildRecommendationSnapshot,
} = explanationGrounding;

// A representative matrix of the snapshot shapes the route produces, each tagged as an
// explain-recommendation snapshot (as buildRecommendationSnapshot always sets it).
const SNAPSHOTS = {
  'grounded, full prescription + history + top set': {
    coaching_strategy: 'explain_recommendation', label: 'Upper Power', focus: 'strength',
    target: { name: 'Bench Press', weight: 185, reps: 5, sets: 3, rir: 2 },
    history: { last_date: '2026-07-20', last_top: '190 for 5 at 2 RIR' },
  },
  'grounded label, no history (history null)': {
    coaching_strategy: 'explain_recommendation', label: 'Recovery/Pump', focus: null,
    target: { name: 'Back Squat', weight: 225, reps: 8, sets: 4, rir: 3 },
    history: null,
  },
  'outage: no label, weight only, no history': {
    coaching_strategy: 'explain_recommendation', label: null, focus: null,
    target: { name: 'Bench Press', weight: 175 }, history: null,
  },
  'date-only history (no top set)': {
    coaching_strategy: 'explain_recommendation', label: null, focus: null,
    target: { name: 'Deadlift', weight: 315, reps: 3 },
    history: { last_date: '2026-07-18' },
  },
  'label + weight, missing reps/rir/sets': {
    coaching_strategy: 'explain_recommendation', label: 'Upper Power', focus: null,
    target: { name: 'Overhead Press', weight: 95 }, history: { last_date: '2026-07-15', last_top: '95 for 5' },
  },
  'no weight ⇒ both paths null': {
    coaching_strategy: 'explain_recommendation', label: 'Upper Power', focus: null,
    target: { name: 'Bench Press' }, history: { last_date: '2026-07-20' },
  },
  'empty target ⇒ both paths null': {
    coaching_strategy: 'explain_recommendation', label: null, focus: null, target: {}, history: null,
  },
};

describe('recommendation explanation — the snapshot path and the decision path are byte-identical', () => {
  for (const [name, snap] of Object.entries(SNAPSHOTS)) {
    it(`${name}`, () => {
      const fromSnapshot = buildDeterministicRecommendationExplanation(snap);
      const decision = buildCoachingDecisionFromExplanation(snap);
      // Every explain-recommendation snapshot yields a contract-valid decision (progress_readout,
      // no prescription) — so the bridge always has a canonical decision to read.
      assert.ok(decision, 'a canonical decision is built for the snapshot');
      assert.equal(validateCoachingDecision(decision).valid, true, validateCoachingDecision(decision).errors.join(' | '));
      const fromDecision = buildDeterministicRecommendationExplanationFromDecision(decision);
      assert.equal(fromDecision, fromSnapshot, 'the decision path words the explanation byte-identically to the snapshot path');
    });
  }
});

describe('byte-identical through the REAL buildRecommendationSnapshot (the route-produced shape)', () => {
  it('a genuine snapshot assembled from context reconstructs identically from its decision', () => {
    const context = {
      current_plan: [{ name: 'Bench Press', weight: 185, reps: 5, sets: 3, rir: 2 }],
      recommended_label: 'Upper Power',
      recommended_focus: 'strength',
      readiness: [],
      recent_sessions: [
        { date: '2026-07-20', lift_sets: { 'Bench Press': [{ weight: 190, reps: 5, rir: 2 }] } },
      ],
    };
    const snap = buildRecommendationSnapshot(context, context.current_plan[0], 'why only 185 for bench?');
    // Sanity: the real snapshot carries the history top set the explanation words.
    assert.equal(snap.history.last_date, '2026-07-20');
    assert.equal(snap.history.last_top, '190 for 5 at 2 RIR');

    const fromSnapshot = buildDeterministicRecommendationExplanation(snap);
    assert.ok(fromSnapshot && fromSnapshot.includes('Your last logged Bench Press was 2026-07-20 at 190 for 5 at 2 RIR'),
      'the snapshot path words the grounded history sentence');

    const decision = buildCoachingDecisionFromExplanation(snap);
    const fromDecision = buildDeterministicRecommendationExplanationFromDecision(decision);
    assert.equal(fromDecision, fromSnapshot, 'the decision path is byte-identical to the snapshot path');
  });
});

describe('buildDeterministicRecommendationExplanationFromDecision — fail-closed edges', () => {
  it('returns null for an absent / malformed decision', () => {
    assert.equal(buildDeterministicRecommendationExplanationFromDecision(null), null);
    assert.equal(buildDeterministicRecommendationExplanationFromDecision(undefined), null);
    assert.equal(buildDeterministicRecommendationExplanationFromDecision('nope'), null);
    assert.equal(buildDeterministicRecommendationExplanationFromDecision({}), null, 'no explanation_inputs ⇒ null');
  });

  it('returns null when explanation_inputs carries no name/weight to explain', () => {
    assert.equal(buildDeterministicRecommendationExplanationFromDecision({ explanation_inputs: {} }), null);
    assert.equal(buildDeterministicRecommendationExplanationFromDecision({ explanation_inputs: { target_name: 'Bench Press' } }), null, 'name without weight ⇒ null');
    assert.equal(buildDeterministicRecommendationExplanationFromDecision({ explanation_inputs: { target_weight: 185 } }), null, 'weight without name ⇒ null');
  });

  it('words a minimal name+weight decision without inventing a label reason', () => {
    const out = buildDeterministicRecommendationExplanationFromDecision({ explanation_inputs: { target_name: 'Bench Press', target_weight: 175 } });
    assert.equal(out, "Bench Press is set at 175 lb — that's today's target.");
  });
});
