'use strict';

// One-Brain Promotion PR 1 — decides whether a validated CoachingDecision is
// eligible to DRIVE the legacy /api/recommend/next/:liftCode response (as
// opposed to hybrid's shadow-only attach), and computes the exact field
// overrides. Pure: no I/O, no LLM, no Sheets. Every number this module
// produces is copied verbatim from `brian.payload` — it never invents one.
//
// Scope: this route only. Does not touch today's pick, coach chat/message,
// in-session set reaction, or any write path.

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Decide whether `brian` is eligible to drive `recommendation`, and if so,
 * compute the override values. Returns:
 *   { eligible: false, reason: <string> }
 *   { eligible: true, reason: null, weight, reps, rationale, action }
 *
 * `weight`/`reps` are `null` when Brian's payload didn't prescribe that
 * field (progression's payload.target_weight/target_reps are each optional
 * per config/coaching/contracts/decision.contract.json) — the caller keeps
 * the legacy value for any field Brian left null.
 *
 * activeDeload: pass the route's already-computed deload state. Deload is a
 * predefined protocol (CLAUDE.md: "AI decides *if*, engine decides *what*")
 * and must never be overridden by a progression decision, which has no
 * deload awareness — an active deload always wins, unconditionally.
 */
function planBrianOverride(recommendation, brian, validation, activeDeload) {
  if (activeDeload && activeDeload.in_deload === true) {
    return { eligible: false, reason: 'active_deload' };
  }
  if (!validation || validation.valid !== true || !_isObj(brian)) {
    return { eligible: false, reason: 'invalid_decision' };
  }
  if (brian.decision_type === 'clarification_needed' || brian.status !== 'answered') {
    return { eligible: false, reason: 'needs_clarification' };
  }
  if (brian.decision_type !== 'progression') {
    return { eligible: false, reason: 'wrong_decision_type' };
  }
  const payload = _isObj(brian.payload) ? brian.payload : {};
  const hasWeight = typeof payload.target_weight === 'number';
  const hasReps = typeof payload.target_reps === 'number';
  if (!hasWeight && !hasReps) {
    return { eligible: false, reason: 'no_prescribed_numbers' };
  }
  if (!_isObj(recommendation) || !_isObj(recommendation.next_target)) {
    return { eligible: false, reason: 'no_legacy_target' };
  }
  return {
    eligible: true,
    reason: null,
    weight: hasWeight ? payload.target_weight : null,
    reps: hasReps ? payload.target_reps : null,
    rationale: typeof payload.rationale === 'string' && payload.rationale ? payload.rationale : null,
    action: typeof payload.action === 'string' ? payload.action : null
  };
}

// Minimal, deterministic verdict sentence built only from `plan`'s own
// fields (all copied straight from Brian's payload by planBrianOverride) —
// no LLM, no invented numbers, no phrase table beyond fixed connective words.
function brianVerdictText(plan) {
  const action = plan.action ? String(plan.action).replace(/_/g, ' ') : 'progress';
  if (plan.weight != null && plan.reps != null) return `Brian: ${action} — ${plan.weight} x ${plan.reps}.`;
  if (plan.weight != null) return `Brian: ${action} — ${plan.weight}.`;
  if (plan.reps != null) return `Brian: ${action} — ${plan.reps} reps.`;
  return `Brian: ${action}.`;
}

// Applies an eligible plan onto `recommendation` IN PLACE, matching the
// route's existing imperative style (deload/rule_decision/etc. are also
// applied in place). Only overwrites next_target.weight/reps, reasoning, and
// the recommendation verdict text. next_target.sets, target_rir, and every
// other legacy field are left untouched — the "preserve legacy fallback
// fields" compatibility requirement.
function applyBrianOverride(recommendation, plan) {
  if (plan.weight != null) recommendation.next_target.weight = plan.weight;
  if (plan.reps != null) recommendation.next_target.reps = plan.reps;
  if (plan.rationale) recommendation.reasoning = plan.rationale;
  recommendation.recommendation = brianVerdictText(plan);
}

module.exports = { planBrianOverride, applyBrianOverride, brianVerdictText };
