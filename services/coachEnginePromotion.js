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

// ── Brian serve-eligibility rail ─────────────────────────────────────────────
// A safety rail, NOT the final capability-manifest design. HYBRID shadow always
// composes and observes the full Brain decision (the Orchestrator is untouched by
// this); this rail only gates whether `brian` SERVE mode may DRIVE a user-facing
// response. A decision type is serve-eligible only when the Brain path producing it
// is runner-complete and vetted for production serving:
//   - `progression` IS eligible — a single guarded per-lift number with real
//     legacy fallbacks (active deload, just-logged anchor, clarification).
//   - `workout` (Coach's Pick / best_workout) is NOT eligible yet — its session-
//     generation capability stack (fatigue/volume/equipment) is not runner-complete,
//     so a served pick would be a partial decision rendered as authoritative.
// This is deliberately a coarse decision-type allowlist. Expressing required-vs-
// optional/defaulted capability semantics precisely in the manifest is deferred
// (see BACKLOG.md → One-Brain serve-eligibility follow-up). Flipping a type to
// eligible is an owner-gated promotion decision, never done implicitly here.
const SERVE_ELIGIBLE_DECISION_TYPES = new Set(['progression']);
function isBrianServeEligible(decisionType) {
  return SERVE_ELIGIBLE_DECISION_TYPES.has(decisionType);
}

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
 *
 * context.justLoggedSet: the in-workout anchor. Under session-level save a
 * just-logged set is NOT in the sheet yet, so a decision derived from a
 * sheet-only snapshot is stale by exactly that set — the legacy response
 * anchored on the fresh set wins. context.ephemeralSetFolded lifts the
 * guard ONLY when the caller folded the fresh set into the snapshot's rows
 * (services/ephemeralSetFold.js) in the same code path — the decision then
 * provably consumed the set, so it may drive the reaction.
 */
function planBrianOverride(recommendation, brian, validation, activeDeload, context) {
  if (activeDeload && activeDeload.in_deload === true) {
    return { eligible: false, reason: 'active_deload' };
  }
  if (context && context.justLoggedSet && context.ephemeralSetFolded !== true) {
    return { eligible: false, reason: 'just_logged_anchor' };
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
  // Serve-eligibility rail: `progression` IS serve-eligible today, so this is a
  // no-op here; kept explicit so both serve paths share one rail and flipping a
  // type off gates them together.
  if (!isBrianServeEligible(brian.decision_type)) {
    return { eligible: false, reason: 'not_serve_eligible' };
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

// ── Coach's Pick promotion (owner-approved 2026-07-02) ───────────────────────
// Decides whether a validated best_workout CoachingDecision is eligible to
// DRIVE the recommended intent on GET /api/plan/intent-recommendation. Same
// verbatim-numbers rule as planBrianOverride: every field below is copied
// straight from `brian.payload.blocks`; nothing is invented. Note the deload
// difference from the progression promotion: `sessionGenerator.buildSession`
// IS deload-aware (it applies the predefined protocol to its blocks), so no
// separate active-deload guard is needed here — Brian's workout decision
// already honors "AI decides *if*, engine decides *what*".

/**
 * Returns { eligible:false, reason } or { eligible:true, reason:null, exercises }
 * where `exercises` is the recommended intent's replacement list, each entry
 * mapped verbatim from a Brian workout block (target_reps ← block.reps).
 */
function planBrianPickOverride(result, brian, validation) {
  if (!validation || validation.valid !== true || !_isObj(brian)) {
    return { eligible: false, reason: 'invalid_decision' };
  }
  if (brian.decision_type === 'clarification_needed' || brian.status !== 'answered') {
    return { eligible: false, reason: 'needs_clarification' };
  }
  if (brian.decision_type !== 'workout') {
    return { eligible: false, reason: 'wrong_decision_type' };
  }
  // Serve-eligibility rail: `workout` (Coach's Pick) is not serve-eligible yet, so
  // brian falls back to legacy while hybrid still shadows the composed pick.
  if (!isBrianServeEligible(brian.decision_type)) {
    return { eligible: false, reason: 'not_serve_eligible' };
  }
  const payload = _isObj(brian.payload) ? brian.payload : {};
  const blocks = Array.isArray(payload.blocks) ? payload.blocks.filter(_isObj) : [];
  const prescribed = blocks.filter(b =>
    typeof b.exercise === 'string' && b.exercise && typeof b.target_weight === 'number');
  if (!prescribed.length) {
    return { eligible: false, reason: 'no_prescribed_numbers' };
  }
  const intents = _isObj(result) && Array.isArray(result.intents) ? result.intents : [];
  if (!intents.some(i => _isObj(i) && i.recommended === true)) {
    return { eligible: false, reason: 'no_recommended_intent' };
  }
  return {
    eligible: true,
    reason: null,
    // Brian's own surface labels, verbatim from the payload (never invented) —
    // the swapped exercise list must not sit under a legacy theme label that
    // no longer describes it (review #813).
    label: typeof payload.session_label === 'string' && payload.session_label ? payload.session_label : null,
    focus: typeof payload.focus === 'string' && payload.focus ? payload.focus : null,
    exercises: prescribed.map(b => ({
      exercise: b.exercise,
      lift_code: typeof b.lift_code === 'string' ? b.lift_code : null,
      target_weight: b.target_weight,
      ...(typeof b.reps === 'number' ? { target_reps: b.reps } : {}),
      ...(typeof b.sets === 'number' ? { target_sets: b.sets } : {}),
      ...(typeof b.target_rir === 'number' ? { target_rir: b.target_rir } : {}),
      // Deterministic wording of an engine fact (the block's scenario) — the
      // same fixed-connectives rule as brianVerdictText, no invented content.
      reason: typeof b.scenario_id === 'string' && b.scenario_id
        ? `Brian: ${b.scenario_id.replace(/_/g, ' ')}`
        : 'Brian',
    })),
  };
}

// Applies an eligible pick plan onto `result` IN PLACE (review #813 shape):
// - exercises: replaced with Brian's blocks (verbatim).
// - label/focus (+ todays_read.recommended_label): Brian's own session_label/
//   focus, verbatim, so the card's headline describes the list it shows.
// - pivot_logic / reason_codes: DELETED — they are derived from the legacy
//   exercise list and would describe movements no longer shown; the drawer
//   renders those sections only when present, so absence degrades cleanly.
// why_today, data_points, what_it_protects, watch_for, the other intents, and
// todays_read.recommended_reason stay legacy — readiness/theme facts that
// remain true and are not exercise-derived.
function applyBrianPickOverride(result, plan) {
  const recommended = result.intents.find(i => _isObj(i) && i.recommended === true);
  recommended.exercises = plan.exercises;
  if (plan.label) recommended.label = plan.label;
  if (plan.focus) recommended.focus = plan.focus;
  delete recommended.pivot_logic;
  delete recommended.reason_codes;
  if (plan.label && _isObj(result.todays_read) && result.todays_read.recommended_label) {
    result.todays_read.recommended_label = plan.label;
  }
}

module.exports = {
  planBrianOverride, applyBrianOverride, brianVerdictText,
  planBrianPickOverride, applyBrianPickOverride,
  isBrianServeEligible,
};
