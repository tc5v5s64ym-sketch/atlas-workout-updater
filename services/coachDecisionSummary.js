'use strict';

// Coach decision summary — pure projection helpers for the coach-engine gate in
// index.js. These build the SAFE, trimmed view of a CoachingDecision that (a) ships
// to the client as the hybrid `.brian` attach (instead of the full decision, so raw
// provenance/module internals never reach the browser) and (b) supplies the legacy
// projection used for divergence.
//
// This module holds NO ring, NO endpoint, NO I/O. Server-side shadow OBSERVABILITY
// (the ring, the console line, the divergence aggregate, the debug endpoint, the
// optional durable tab) lives in services/brainShadow.js — the single coach-engine
// shadow recorder. (Earlier this file also carried a duplicate win-only ring; that
// was consolidated into brainShadow, which records wins AND declines/crashes.)

function _isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// Project a validated CoachingDecision to a SAFE, flat summary. This is the shape
// attached to the wire response in hybrid mode (replacing the full decision). It
// deliberately OMITS raw provenance/module lists, explanation_inputs, missing_info,
// confidence internals (score/caveats), safety flags, and per-block internals
// (scenario_id/source/warmup/pattern) — engine internals, not client-facing signal.
// It keeps the decision type/status, the prescription the coach would surface
// (progression numbers OR the workout's block prescriptions — the owner's own
// training data), and the confidence/safety TIER/LEVEL. Returns null for a
// non-object (no decision to summarize).
function summarizeBrianDecision(decision) {
  if (!_isObj(decision)) return null;
  const payload = _isObj(decision.payload) ? decision.payload : {};
  const confidence = _isObj(decision.confidence) ? decision.confidence : {};
  const safety = _isObj(decision.safety) ? decision.safety : {};
  const blocks = Array.isArray(payload.blocks)
    ? payload.blocks.filter(_isObj).map(b => ({
        lift_code: typeof b.lift_code === 'string' ? b.lift_code : null,
        exercise: typeof b.exercise === 'string' ? b.exercise : null,
        target_weight: typeof b.target_weight === 'number' ? b.target_weight : null,
        // session-generator blocks carry the rep target under `reps`; accept
        // `target_reps` too for forward-compatibility. Never invents a number.
        target_reps: typeof b.reps === 'number' ? b.reps
          : (typeof b.target_reps === 'number' ? b.target_reps : null),
      }))
    : null;
  return {
    decision_type: typeof decision.decision_type === 'string' ? decision.decision_type : null,
    status: typeof decision.status === 'string' ? decision.status : null,
    action: typeof payload.action === 'string' ? payload.action : null,
    target_weight: typeof payload.target_weight === 'number' ? payload.target_weight : null,
    target_reps: typeof payload.target_reps === 'number' ? payload.target_reps : null,
    rationale: typeof payload.rationale === 'string' ? payload.rationale : null,
    confidence_tier: typeof confidence.tier === 'string' ? confidence.tier : null,
    confidence_action: typeof confidence.action === 'string' ? confidence.action : null,
    safety_level: typeof safety.level === 'string' ? safety.level : null,
    block_count: blocks ? blocks.length : null,
    session_label: typeof payload.session_label === 'string' ? payload.session_label : null,
    blocks,
  };
}

// Progression-route legacy projection (analytics.js recommendation) — the fields a
// divergence check needs, mirroring the dev compare card's summarizeLegacy. Captured
// BEFORE any brian override mutates the recommendation. Returns null for a
// non-object.
function summarizeLegacyRecommendation(recommendation) {
  if (!_isObj(recommendation)) return null;
  const nt = _isObj(recommendation.next_target) ? recommendation.next_target : null;
  return {
    verdict: typeof recommendation.recommendation === 'string' ? recommendation.recommendation : null,
    target_weight: nt && typeof nt.weight === 'number' ? nt.weight : null,
    target_reps: nt && typeof nt.reps === 'number' ? nt.reps : null,
    target_sets: nt && typeof nt.sets === 'number' ? nt.sets : null,
    target_rir: typeof recommendation.target_rir === 'number' ? recommendation.target_rir : null,
  };
}

module.exports = {
  summarizeBrianDecision,
  summarizeLegacyRecommendation,
};
