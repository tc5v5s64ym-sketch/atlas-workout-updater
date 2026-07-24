'use strict';

// Shared recovery worder + the canonical-decision bridge — Phase 4 H-03 (live-consumption groundwork).
//
// buildTirednessRecoveryAnswer (from the route-local recovery signals, via recoveryReasonFacts) and
// buildTirednessRecoveryAnswerFromDecision (from a canonical CoachTurnPacket recovery decision's
// explanation_inputs) now funnel their facts through ONE private worder (_wordRecovery). These tests
// prove the two produce a BYTE-IDENTICAL string for a decision built from route signals — the
// invariant that lets the live route word the recovery reply from packet.decision without changing
// the served reply — across the COMPLETE recovery branch matrix, plus the bridge's fail-closed edges.
// No route is exercised here; this is the isolated equivalence proof that de-risks the PR-3 wiring.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTirednessRecoveryAnswer,
  buildTirednessRecoveryAnswerFromDecision,
} = require('../services/recoveryRouting');
const { buildRecoveryDecision } = require('../services/coachDecisionSnapshot');
const { validateCoachingDecision } = require('../services/coachingDecision');

// The complete matrix of recovery signal shapes the route produces — every branch, the day-count
// wording boundaries, the singular/plural boundary, the reasons.slice(0,2) drop when all three fire,
// the recovered branch, engine-grounded vs outage/limited, incomplete facts, and the bare fallback.
const SIGNALS = {
  'elevated weekly load only': { engine_grounded: true, fatigueStatus: { status: 'high' }, daysSinceLastSession: 4, readiness: [] },
  'back-to-back: trained today (d=0)': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 0, readiness: [] },
  'back-to-back: trained yesterday (d=1)': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 1, readiness: [] },
  'one fatigued pattern (singular "pattern is")': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 2, readiness: [{ pattern: 'horizontal push', status: 'fatigued' }] },
  'two fatigued patterns (plural "patterns are")': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 2, readiness: [{ pattern: 'push', status: 'fatigued' }, { pattern: 'hinge', status: 'fatigued' }] },
  'three fatigued patterns (slice(0,2) names, plural)': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 2, readiness: [{ pattern: 'push', status: 'fatigued' }, { pattern: 'hinge', status: 'fatigued' }, { pattern: 'squat', status: 'fatigued' }] },
  'ALL THREE reasons fire (patterns dropped by reasons.slice(0,2))': { engine_grounded: true, fatigueStatus: { status: 'high' }, daysSinceLastSession: 0, readiness: [{ pattern: 'push', status: 'fatigued' }, { pattern: 'hinge', status: 'fatigued' }] },
  'recovered branch (d>=3, normal, no reasons)': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 5, readiness: [] },
  'recovered boundary (d===3)': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: 3, readiness: [] },
  'outage/limited: fatigued pattern only': { engine_grounded: false, readiness: [{ pattern: 'hinge', status: 'fatigued' }] },
  'outage/limited: no fatigued pattern → fallback': { engine_grounded: false, readiness: [{ pattern: 'hinge', status: 'ready' }] },
  'bare signal → fallback': { engine_grounded: false },
  'numeric-string day count (coerced)': { engine_grounded: true, fatigueStatus: { status: 'normal' }, daysSinceLastSession: '4', readiness: [] },
  'high status + high day count (elevated wins, not recovered)': { engine_grounded: true, fatigueStatus: { status: 'high' }, daysSinceLastSession: 6, readiness: [] },
};

describe('recovery reply — the route-signals path and the canonical-decision path are byte-identical', () => {
  for (const [name, signals] of Object.entries(SIGNALS)) {
    it(`${name}`, () => {
      const fromSignals = buildTirednessRecoveryAnswer(signals);
      const decision = buildRecoveryDecision(signals);
      // Every recovery signal yields a contract-valid decision (recovery, no prescription).
      assert.ok(decision, 'a canonical recovery decision is built');
      assert.equal(validateCoachingDecision(decision).valid, true, validateCoachingDecision(decision).errors.join(' | '));
      const fromDecision = buildTirednessRecoveryAnswerFromDecision(decision);
      assert.equal(fromDecision, fromSignals, 'the decision path words the recovery reply byte-identically to the signals path');
      assert.ok(fromSignals && fromSignals.trim().length > 0, 'the recovery reply is always non-empty');
    });
  }
});

describe('the two paths agree on the exact wording boundaries', () => {
  it('d=0 says "already trained today"; d=1 says "trained yesterday"', () => {
    const today = buildTirednessRecoveryAnswer({ daysSinceLastSession: 0 });
    assert.match(today, /already trained today/);
    assert.equal(buildTirednessRecoveryAnswerFromDecision(buildRecoveryDecision({ daysSinceLastSession: 0 })), today);
    const yest = buildTirednessRecoveryAnswer({ daysSinceLastSession: 1 });
    assert.match(yest, /trained yesterday/);
    assert.equal(buildTirednessRecoveryAnswerFromDecision(buildRecoveryDecision({ daysSinceLastSession: 1 })), yest);
  });

  it('one pattern → "pattern is"; two → "patterns are"', () => {
    const one = buildTirednessRecoveryAnswer({ readiness: [{ pattern: 'push', status: 'fatigued' }] });
    assert.match(one, /pattern is already flagged fatigued/);
    assert.equal(buildTirednessRecoveryAnswerFromDecision(buildRecoveryDecision({ readiness: [{ pattern: 'push', status: 'fatigued' }] })), one);
    const two = buildTirednessRecoveryAnswer({ readiness: [{ pattern: 'push', status: 'fatigued' }, { pattern: 'hinge', status: 'fatigued' }] });
    assert.match(two, /patterns are already flagged fatigued/);
    assert.equal(buildTirednessRecoveryAnswerFromDecision(buildRecoveryDecision({ readiness: [{ pattern: 'push', status: 'fatigued' }, { pattern: 'hinge', status: 'fatigued' }] })), two);
  });
});

describe('buildTirednessRecoveryAnswerFromDecision — fail-closed edges (always a safe non-empty reply)', () => {
  const FALLBACK = "Then don't force it. A lighter session or a full rest day both beat grinding through fatigue — recovery is when the training pays off. If you do train, leave more in reserve than usual and stop while it still feels clean.";

  it('an absent / malformed decision degrades to the safe no-numbers routing (never throws, never null)', () => {
    assert.equal(buildTirednessRecoveryAnswerFromDecision(null), FALLBACK);
    assert.equal(buildTirednessRecoveryAnswerFromDecision(undefined), FALLBACK);
    assert.equal(buildTirednessRecoveryAnswerFromDecision('nope'), FALLBACK);
    assert.equal(buildTirednessRecoveryAnswerFromDecision({}), FALLBACK, 'no explanation_inputs ⇒ fallback');
    assert.equal(buildTirednessRecoveryAnswerFromDecision({ explanation_inputs: {} }), FALLBACK);
  });

  it('malformed fact TYPES in explanation_inputs are dropped (no fabrication), degrading to fallback', () => {
    assert.equal(buildTirednessRecoveryAnswerFromDecision({ explanation_inputs: { fatigue_status: 42, days_since_last_session: 'x', fatigued_patterns: 'nope' } }), FALLBACK);
  });

  it('a hand-built valid recovery decision words from its explanation_inputs', () => {
    const out = buildTirednessRecoveryAnswerFromDecision({ explanation_inputs: { fatigue_status: 'high' } });
    assert.match(out, /well above your usual volume/);
    assert.match(out, /pull-back/);
  });
});
