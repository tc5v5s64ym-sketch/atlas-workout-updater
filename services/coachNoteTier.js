'use strict';

// Coach-Note Tier — deterministic verbosity classifier for coaching notes.
//
// PURE. No I/O, no LLM, no Sheets, no writes, no routes. Given the facts the
// engine ALREADY emits for a logged set or exercise block, it decides HOW MUCH
// the coach should say — nothing more. It emits no wording and no numbers; the
// LLM / template layer words the tier's facts later (engine owns the read, the
// voice only words it — docs/COACHING_NOTE_VOICE.md IRON RULE).
//
// This is PR-1 of the Conversation Prototype v1 build lane
// (docs/ATLAS_CONVERSATION_PROTOTYPE_V1_PLAN.md §10). It is intentionally
// UNWIRED in this slice: nothing consumes it yet. The per-set / per-block note
// attach point is a later slice (plan PR-2/PR-3), so the engine is
// fixture-locked first (deterministic-first).
//
// The three tiers (docs/CONVERSATION_CONTRACT_V1.md rules 2/3 — "quiet when
// normal, sharp when something matters", and "always acknowledge a log"):
//   ack_only  → routine set/block, matches expectation, no trigger. The
//               deterministic "✅ logged" receipt with no commentary. This is the
//               safe default — missing/garbage facts land here, never a fabricated
//               note. Acknowledgment is NEVER throttled (voice invariants 4/5).
//   short     → RESERVED / currently unused. Mild "on-plan" reads (in-pocket /
//               holding / climbing progress, or an on-target / grinder effort) are
//               receipt-only: they resolve to ack_only, NOT a note. Only the value
//               triggers below earn prose (owner: routine logs are receipt-only).
//               The value is kept in the vocabulary for a possible future one-line band.
//   extended  → a value trigger fired; the coach spends words. Still conclusion-
//               first, still ≤120 words (that ceiling lives in the voice layer).
//
// Triggers are the deterministically-derivable subset of the Conversation
// Contract's eleven "something matters" triggers (rule 2). A per-set/per-block
// fact payload cannot see missed-sessions, wearable, or nutrition signals, so
// those three are out of this classifier's input scope (add them when those
// facts are wired). Precedence is SAFETY-FIRST, mirroring scenarioClassifier's
// evidence-tier ordering: pain > form/safety > the positive/negative reads.
//
// classifyNoteTier(facts) → { tier, trigger, reason_code }
//   facts (all optional; unknown/missing → ack_only, never fabricate): {
//     effort_verdict:      { level } — analytics.effortVerdict: 'far_easy'|'easy'|'on_target'|'hard'|'failure'
//     progression_verdict: { level } — analytics.progressionVerdict: 'new_ground'|'progressing'|'in_pocket'|'maintenance_drift'|'under_shot'
//     effort_signals:      analyzeSetSequence output ({ signals:{…}, blocks_progression, … }) | null
//     injury:              truthy pain/injury signal | null
//     unexpected_excellence: true when the set positively deviates from the lifter's own pattern (contract trigger #11)
//     regression:          true for an explicit lift-moving-backward flag (belt-and-braces alongside under_shot)
//     substitution:        truthy when a plan change / swap was applied (contract trigger #5)
//     confidence:          { tier: 'low'|… } | 'low' | … — low confidence earns a word (contract trigger #8)
//     recovery_active:     true on a deliberate deload/recovery session — suppresses the sandbag challenge
//                          (a high-RIR set is EXPECTED then; mirrors setEffortSignals.suppressBumpForRecovery)
//     asked_why:           true when the user explicitly asked "why?" (contract trigger #7)
//   }

// Tier vocabulary (exported for wiring/tests).
const TIERS = Object.freeze({
  ACK_ONLY: 'ack_only',
  SHORT: 'short',
  EXTENDED: 'extended',
});

// The deterministically-derivable Conversation-Contract triggers this classifier
// can fire, in safety-first precedence order. (Contract rule 2's eleven, minus
// the three that need signals absent from a set/block payload.)
const TRIGGERS = Object.freeze({
  PAIN_INJURY: 'pain_injury',
  FORM_SAFETY: 'form_safety',
  PR_MILESTONE: 'pr_milestone',
  UNEXPECTED_EXCELLENCE: 'unexpected_excellence',
  REGRESSION: 'regression',
  CHALLENGE_SANDBAG: 'challenge_sandbag',
  PLAN_CHANGE: 'plan_change',
  LOW_CONFIDENCE: 'low_confidence',
  USER_ASKED_WHY: 'user_asked_why',
});

function _levelOf(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;
  return typeof verdict.level === 'string' ? verdict.level : null;
}

function _confidenceTier(confidence) {
  if (!confidence) return null;
  if (typeof confidence === 'string') return confidence;
  if (typeof confidence === 'object' && typeof confidence.tier === 'string') return confidence.tier;
  return null;
}

// Any form/safety read from the per-set effort analysis: a compound set that
// blocks progression, an unplanned redline, a rep-drop after one, a pressing
// system gone yellow, or an outright at/near-failure effort verdict.
function _formSafetyReason(facts) {
  const es = facts.effort_signals;
  if (es && typeof es === 'object') {
    if (es.blocks_progression === true) return 'blocks_progression';
    const s = es.signals && typeof es.signals === 'object' ? es.signals : {};
    if (s.redline_set === true) return 'redline_set';
    if (s.rep_drop_after_redline === true) return 'rep_drop_after_redline';
    if (s.pressing_readiness_yellow === true) return 'pressing_readiness_yellow';
  }
  if (_levelOf(facts.effort_verdict) === 'failure') return 'set_at_failure';
  return null;
}

// A "left too much in the tank" read: a far-too-light or explicitly easy work
// set, the underdose signal from the effort analysis, or under-range weight
// lifted easily. `far_easy` (RIR >= target+5 — the strongest under-effort read
// effortVerdict produces) gets its own reason code so the voice can be firmer and
// the signal is not laundered into the milder `easy`. Suppressed on a recovery/
// deload session (a high-RIR set is prescribed there).
function _sandbagReason(facts) {
  if (facts.recovery_active === true) return null;
  const effort = _levelOf(facts.effort_verdict);
  const prog = _levelOf(facts.progression_verdict);
  const es = facts.effort_signals;
  const underdosed = !!(es && es.signals && es.signals.high_rir_workset_underdosed === true);
  if (underdosed) return 'high_rir_underdose';
  if (effort === 'far_easy') return 'far_under_effort';
  if (effort === 'easy') return prog === 'under_shot' ? 'under_range_and_easy' : 'easy_effort';
  return null;
}

/**
 * Decide the coaching-note verbosity tier for a logged set/block.
 * Returns the safe ack_only default when facts are missing or reveal nothing
 * worth a word — it never fabricates a trigger.
 *
 * @param {object} facts - engine-emitted facts (see module header).
 * @returns {{ tier: string, trigger: string|null, reason_code: string|null }}
 */
function classifyNoteTier(facts) {
  const ack = { tier: TIERS.ACK_ONLY, trigger: null, reason_code: null };
  if (!facts || typeof facts !== 'object') return ack;

  const extended = (trigger, reason_code) => ({ tier: TIERS.EXTENDED, trigger, reason_code });

  // ── Value triggers, safety-first precedence (first match wins) → extended ──

  // 1. Pain / injury — highest precedence.
  if (facts.injury) {
    const which = typeof facts.injury === 'string' ? facts.injury : 'reported';
    return extended(TRIGGERS.PAIN_INJURY, `injury_signal:${which}`);
  }

  // 2. Form / safety — a redline, rep-drop, pressing-yellow, block, or failure.
  const formReason = _formSafetyReason(facts);
  if (formReason) return extended(TRIGGERS.FORM_SAFETY, formReason);

  // 3. PR / new working ground.
  if (_levelOf(facts.progression_verdict) === 'new_ground') {
    return extended(TRIGGERS.PR_MILESTONE, 'new_ground');
  }

  // 4. Unexpected excellence — positive deviation from the lifter's own pattern.
  if (facts.unexpected_excellence === true) {
    return extended(TRIGGERS.UNEXPECTED_EXCELLENCE, 'positive_pattern_deviation');
  }

  // 5. Regression — an explicit backward flag, or under-range weight that was NOT
  //    light (an easy/far_easy under-range set is a sandbag, handled next, not a
  //    regression — the lifter had room, they didn't fail to reach their range).
  const prog = _levelOf(facts.progression_verdict);
  const effortLevel = _levelOf(facts.effort_verdict);
  if (facts.regression === true) return extended(TRIGGERS.REGRESSION, 'regression_flag');
  if (prog === 'under_shot' && effortLevel !== 'easy' && effortLevel !== 'far_easy') {
    return extended(TRIGGERS.REGRESSION, 'under_range');
  }

  // 6. Challenge / sandbag — more in the tank than the plan asked for.
  const sandbagReason = _sandbagReason(facts);
  if (sandbagReason) return extended(TRIGGERS.CHALLENGE_SANDBAG, sandbagReason);

  // 7. Plan change — a swap/substitution was applied.
  if (facts.substitution) return extended(TRIGGERS.PLAN_CHANGE, 'substitution_applied');

  // 8. Low confidence — the engine is unsure; say so honestly.
  if (_confidenceTier(facts.confidence) === 'low') {
    return extended(TRIGGERS.LOW_CONFIDENCE, 'low_confidence');
  }

  // 9. The user explicitly asked why.
  if (facts.asked_why === true) return extended(TRIGGERS.USER_ASKED_WHY, 'explicit_why');

  // ── No value trigger fired → acknowledgment only (the receipt/readback speaks,
  //    the coach stays quiet). A merely on-plan set — in-range / holding / climbing
  //    progress, or an on-target / grinder effort — is NOT worth a coaching note;
  //    only the nine value triggers above earn prose (owner: routine logs are
  //    receipt-only). The reason_code is preserved so the ack stays traceable (WHY
  //    it went silent); the tier (ack_only) is what gates rendering.
  if (prog === 'in_pocket' || prog === 'maintenance_drift' || prog === 'progressing') {
    return { tier: TIERS.ACK_ONLY, trigger: null, reason_code: prog };
  }
  const effort = _levelOf(facts.effort_verdict);
  if (effort === 'on_target' || effort === 'hard') {
    return { tier: TIERS.ACK_ONLY, trigger: null, reason_code: `effort_${effort}` };
  }

  // Routine, neutral, or nothing to read → acknowledgment only (never fabricate).
  return ack;
}

module.exports = { classifyNoteTier, TIERS, TRIGGERS };
