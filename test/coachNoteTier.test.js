'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyNoteTier, TIERS, TRIGGERS } = require('../services/coachNoteTier');

// Fact-payload builders mirroring the real engine shapes:
//   effort_verdict:      analytics.effortVerdict     → { level: 'easy'|'on_target'|'hard'|'failure', ... }
//   progression_verdict: analytics.progressionVerdict → { level: 'new_ground'|'progressing'|'in_pocket'|'maintenance_drift'|'under_shot', ... }
//   effort_signals:      setEffortSignals.analyzeSetSequence output
const effort = level => ({ level, target_rir: 2, headline: 'x' });
const prog = level => ({ level, range_low: 200, range_high: 225, ceiling: 225, headline: 'x' });
function signals(overrides = {}) {
  return {
    progression_verdict: 'neutral',
    blocks_progression: false,
    signals: {
      redline_set: false,
      repeated_redline: false,
      rep_drop_after_redline: false,
      high_rir_workset_underdosed: false,
      pressing_readiness_yellow: false,
      ...overrides,
    },
    ...(overrides.blocks_progression !== undefined ? { blocks_progression: overrides.blocks_progression } : {}),
  };
}

// ─── vocabulary integrity ────────────────────────────────────────────────────

describe('coachNoteTier — vocabulary', () => {
  it('exposes exactly the three tiers', () => {
    assert.deepEqual(new Set(Object.values(TIERS)), new Set(['ack_only', 'short', 'extended']));
  });
  it('trigger ids are the derivable Conversation-Contract subset', () => {
    assert.deepEqual(new Set(Object.values(TRIGGERS)), new Set([
      'pain_injury', 'form_safety', 'pr_milestone', 'unexpected_excellence',
      'regression', 'challenge_sandbag', 'plan_change', 'low_confidence', 'user_asked_why',
    ]));
  });
  it('always returns the { tier, trigger, reason_code } shape', () => {
    const r = classifyNoteTier({});
    assert.deepEqual(Object.keys(r).sort(), ['reason_code', 'tier', 'trigger']);
  });
});

// ─── guards / missing facts → safe ack_only (never fabricate) ────────────────

describe('coachNoteTier — guards default to ack_only', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}]) {
    it(`ack_only for ${JSON.stringify(bad)}`, () => {
      const r = classifyNoteTier(bad);
      assert.equal(r.tier, TIERS.ACK_ONLY);
      assert.equal(r.trigger, null);
      assert.equal(r.reason_code, null);
    });
  }
  it('a routine neutral set (no readable verdict) → ack_only', () => {
    assert.equal(classifyNoteTier({ effort_signals: signals() }).tier, TIERS.ACK_ONLY);
  });
});

// ─── extended: every value trigger fires ─────────────────────────────────────

describe('coachNoteTier — value triggers → extended', () => {
  it('pain/injury (highest precedence)', () => {
    const r = classifyNoteTier({ injury: 'shoulder', progression_verdict: prog('new_ground') });
    assert.equal(r.tier, TIERS.EXTENDED);
    assert.equal(r.trigger, TRIGGERS.PAIN_INJURY);
    assert.match(r.reason_code, /shoulder/);
  });
  it('form/safety — redline set', () => {
    const r = classifyNoteTier({ effort_signals: signals({ redline_set: true }) });
    assert.equal(r.tier, TIERS.EXTENDED);
    assert.equal(r.trigger, TRIGGERS.FORM_SAFETY);
    assert.equal(r.reason_code, 'redline_set');
  });
  it('form/safety — blocks_progression', () => {
    const r = classifyNoteTier({ effort_signals: { ...signals(), blocks_progression: true } });
    assert.equal(r.trigger, TRIGGERS.FORM_SAFETY);
    assert.equal(r.reason_code, 'blocks_progression');
  });
  it('form/safety — at-failure effort verdict', () => {
    const r = classifyNoteTier({ effort_verdict: effort('failure') });
    assert.equal(r.trigger, TRIGGERS.FORM_SAFETY);
    assert.equal(r.reason_code, 'set_at_failure');
  });
  it('PR / new ground', () => {
    const r = classifyNoteTier({ progression_verdict: prog('new_ground'), effort_verdict: effort('hard') });
    assert.equal(r.tier, TIERS.EXTENDED);
    assert.equal(r.trigger, TRIGGERS.PR_MILESTONE);
    assert.equal(r.reason_code, 'new_ground');
  });
  it('unexpected excellence (positive pattern deviation, not a technical PR)', () => {
    // usually 225x5 @ RIR2, today 225x8 @ RIR2 — in-pocket weight, unusual output.
    const r = classifyNoteTier({
      unexpected_excellence: true,
      progression_verdict: prog('in_pocket'),
      effort_verdict: effort('on_target'),
    });
    assert.equal(r.tier, TIERS.EXTENDED);
    assert.equal(r.trigger, TRIGGERS.UNEXPECTED_EXCELLENCE);
  });
  it('regression — under-range weight that was NOT easy', () => {
    const r = classifyNoteTier({ progression_verdict: prog('under_shot'), effort_verdict: effort('hard') });
    assert.equal(r.tier, TIERS.EXTENDED);
    assert.equal(r.trigger, TRIGGERS.REGRESSION);
    assert.equal(r.reason_code, 'under_range');
  });
  it('regression — explicit flag', () => {
    const r = classifyNoteTier({ regression: true });
    assert.equal(r.trigger, TRIGGERS.REGRESSION);
    assert.equal(r.reason_code, 'regression_flag');
  });
  it('challenge/sandbag — easy effort', () => {
    const r = classifyNoteTier({ effort_verdict: effort('easy'), progression_verdict: prog('in_pocket') });
    assert.equal(r.tier, TIERS.EXTENDED);
    assert.equal(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.reason_code, 'easy_effort');
  });
  it('challenge/sandbag — under-range AND easy reads as sandbag, not regression', () => {
    const r = classifyNoteTier({ progression_verdict: prog('under_shot'), effort_verdict: effort('easy') });
    assert.equal(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.reason_code, 'under_range_and_easy');
  });
  it('challenge/sandbag — far_easy is the strongest under-effort read (own reason code)', () => {
    // effortVerdict emits far_easy at RIR >= target+5 (analytics.js:458) — must not
    // fall through to ack_only; gets a distinct, firmer reason code, not 'easy_effort'.
    const r = classifyNoteTier({ effort_verdict: effort('far_easy') });
    assert.equal(r.tier, TIERS.EXTENDED);
    assert.equal(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.reason_code, 'far_under_effort');
  });
  it('challenge/sandbag — far_easy + under_shot reads as sandbag, not regression', () => {
    const r = classifyNoteTier({ progression_verdict: prog('under_shot'), effort_verdict: effort('far_easy') });
    assert.equal(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.reason_code, 'far_under_effort');
  });
  it('challenge/sandbag — high-RIR underdose signal', () => {
    const r = classifyNoteTier({ effort_signals: signals({ high_rir_workset_underdosed: true }) });
    assert.equal(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.reason_code, 'high_rir_underdose');
  });
  it('plan change — substitution applied', () => {
    const r = classifyNoteTier({ substitution: { from: 'Deadlift', to: 'RDL' } });
    assert.equal(r.trigger, TRIGGERS.PLAN_CHANGE);
    assert.equal(r.reason_code, 'substitution_applied');
  });
  it('low confidence — object tier', () => {
    const r = classifyNoteTier({ confidence: { tier: 'low' } });
    assert.equal(r.trigger, TRIGGERS.LOW_CONFIDENCE);
  });
  it('low confidence — bare string', () => {
    assert.equal(classifyNoteTier({ confidence: 'low' }).trigger, TRIGGERS.LOW_CONFIDENCE);
  });
  it('user asked why', () => {
    const r = classifyNoteTier({ asked_why: true });
    assert.equal(r.trigger, TRIGGERS.USER_ASKED_WHY);
    assert.equal(r.reason_code, 'explicit_why');
  });
});

// ─── recovery/deload suppresses the sandbag challenge (mirrors suppressBumpForRecovery) ──

describe('coachNoteTier — recovery suppresses the sandbag challenge', () => {
  it('an easy set on a recovery day does NOT fire challenge_sandbag', () => {
    const r = classifyNoteTier({
      effort_verdict: effort('easy'),
      progression_verdict: prog('in_pocket'),
      recovery_active: true,
    });
    assert.notEqual(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    // in_pocket is receipt-only now (ack_only), never an add-load nudge.
    assert.equal(r.tier, TIERS.ACK_ONLY);
  });
  it('a far_easy set on a recovery day does NOT fire challenge_sandbag', () => {
    const r = classifyNoteTier({ effort_verdict: effort('far_easy'), recovery_active: true });
    assert.notEqual(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
    assert.equal(r.tier, TIERS.ACK_ONLY);
  });
  it('the underdose signal is suppressed on recovery → ack_only when nothing else reads', () => {
    const r = classifyNoteTier({ effort_signals: signals({ high_rir_workset_underdosed: true }), recovery_active: true });
    assert.equal(r.tier, TIERS.ACK_ONLY);
  });
  it('recovery does NOT suppress a real safety read (redline still fires)', () => {
    const r = classifyNoteTier({ effort_signals: signals({ redline_set: true }), recovery_active: true });
    assert.equal(r.trigger, TRIGGERS.FORM_SAFETY);
  });
});

// ─── precedence ──────────────────────────────────────────────────────────────

describe('coachNoteTier — safety-first precedence', () => {
  it('pain outranks a PR and a redline', () => {
    const r = classifyNoteTier({
      injury: true,
      progression_verdict: prog('new_ground'),
      effort_signals: signals({ redline_set: true }),
    });
    assert.equal(r.trigger, TRIGGERS.PAIN_INJURY);
  });
  it('form/safety outranks a PR', () => {
    const r = classifyNoteTier({
      progression_verdict: prog('new_ground'),
      effort_signals: signals({ rep_drop_after_redline: true }),
    });
    assert.equal(r.trigger, TRIGGERS.FORM_SAFETY);
  });
  it('a PR outranks a same-payload sandbag', () => {
    const r = classifyNoteTier({ progression_verdict: prog('new_ground'), effort_verdict: effort('easy') });
    assert.equal(r.trigger, TRIGGERS.PR_MILESTONE);
  });
});

// ─── mild "on-plan" signals are receipt-only (ack_only, not a note) ──────────
// Owner: routine logs produce only the deterministic receipt. A merely on-plan
// read (in-range / holding / climbing progress, or on-target / grinder effort)
// keeps a reason_code for tracing but stays silent (tier ack_only). Only the nine
// value triggers speak. RIR-0/failure, redline, and blocks_progression still fire
// FORM_SAFETY (covered above) — routine silence must not touch those.

describe('coachNoteTier — mild on-plan signals → ack_only (receipt-only)', () => {
  for (const level of ['in_pocket', 'maintenance_drift', 'progressing']) {
    it(`progression '${level}' → ack_only, reason_code preserved`, () => {
      const r = classifyNoteTier({ progression_verdict: prog(level), effort_verdict: effort('on_target') });
      assert.equal(r.tier, TIERS.ACK_ONLY);
      assert.equal(r.trigger, null);
      assert.equal(r.reason_code, level);
    });
  }
  it('on-target effort with no progression read → ack_only', () => {
    const r = classifyNoteTier({ effort_verdict: effort('on_target') });
    assert.equal(r.tier, TIERS.ACK_ONLY);
    assert.equal(r.reason_code, 'effort_on_target');
  });
  it('a hard (grinder) set with no other read → ack_only', () => {
    const r = classifyNoteTier({ effort_verdict: effort('hard') });
    assert.equal(r.tier, TIERS.ACK_ONLY);
    assert.equal(r.reason_code, 'effort_hard');
  });
  it('the routine Cable-Curl case (on-target, in-pocket) → ack_only', () => {
    // The exact live-test regression: 3× on-target sets in the working band must
    // be receipt-only, not "Dialled in — that landed right on target."
    const r = classifyNoteTier({ effort_verdict: effort('on_target'), progression_verdict: prog('in_pocket') });
    assert.equal(r.tier, TIERS.ACK_ONLY);
    assert.equal(r.trigger, null);
  });
  it('SHORT is retired — classifyNoteTier never returns it', () => {
    const inputs = [
      { effort_verdict: effort('on_target') },
      { effort_verdict: effort('hard') },
      { progression_verdict: prog('in_pocket'), effort_verdict: effort('on_target') },
      { progression_verdict: prog('maintenance_drift') },
      { progression_verdict: prog('progressing') },
      {},
    ];
    for (const f of inputs) assert.notEqual(classifyNoteTier(f).tier, TIERS.SHORT);
  });
});

// ─── purity ──────────────────────────────────────────────────────────────────

describe('coachNoteTier — purity', () => {
  it('does not mutate the input facts', () => {
    const facts = Object.freeze({
      effort_verdict: Object.freeze(effort('easy')),
      progression_verdict: Object.freeze(prog('under_shot')),
    });
    assert.doesNotThrow(() => classifyNoteTier(facts));
    const r = classifyNoteTier(facts);
    assert.equal(r.trigger, TRIGGERS.CHALLENGE_SANDBAG);
  });
  it('is deterministic across repeated calls', () => {
    const facts = { progression_verdict: prog('new_ground') };
    assert.deepEqual(classifyNoteTier(facts), classifyNoteTier(facts));
  });
});
