'use strict';

// Coach decision snapshot — Phase 4 H-03 boundary adapter (shadow-first, first increment).
//
// The narrowest seam that begins canonicalizing the engine's route-local coaching decision
// into the ratified services/coachingDecision.js CoachingDecision, for the CoachTurnPacket
// shadow only. Today the /api/coach/chat route decides "this turn EXPLAINS the displayed
// recommendation" route-locally (services/coachExplanationGrounding.js resolves a trusted
// recommendation snapshot and stashes it on res.locals.coachRecommendationGrounding); the
// shadow already records the engine_decision trace stage for those turns, but packet.decision
// stays null — the H-03 "no Coach Turn Packet" gap the divergence report headlines.
//
// This adapter canonicalizes ONLY that read-only explain-recommendation decision, as a
// `progress_readout` CoachingDecision (the decision_type the manifest maps the
// `explain_recommendation` intent to — read-only, carries NO prescription). It is a faithful
// canonicalization of the route's real decision ENVELOPE, not a re-run of the Brain
// (`provenance.modules_run` is empty — the shadow does not execute the engine). Confidence is
// CONSERVATIVE and derived from the same grounding signal the route's own honesty logic uses
// (an engine label / real history ⇒ moderate/act; a bare outage snapshot ⇒ low/act_with_caveat
// + an insufficient_history caveat) — it never claims high confidence the engine did not
// compute. safety is green/non-blocking: the route's safety verdict is still route-local
// (H-12/Phase 5d), so the honest default for a read-only explanation is no safety event.
//
// FAIL CLOSED: returns null when the grounding is absent, is not an explain-recommendation
// snapshot, or the built decision does not validate. Guard 5 (check:packet-trace) additionally
// refuses to embed a decision that does not validate, so a malformed decision is never claimed.
//
// Pure / deterministic — no I/O, no clock, no randomness. Read-only; it builds a value.

const { buildCoachingDecision, validateCoachingDecision } = require('./coachingDecision');

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Build a canonical CoachingDecision from the route's recommendation-explanation grounding
 * snapshot (res.locals.coachRecommendationGrounding). Returns the decision, or null when the
 * grounding is absent / not an explain-recommendation snapshot / the decision fails validation.
 *
 * @param {object} grounding  the trusted recommendation snapshot (coachExplanationGrounding)
 * @returns {object|null}
 */
function buildCoachingDecisionFromExplanation(grounding) {
  const s = _isPlainObject(grounding) ? grounding : null;
  if (!s || s.coaching_strategy !== 'explain_recommendation') return null;

  // Grounded when the engine actually provided a day-type label OR real target history — the
  // same signal coachExplanationGrounding's deterministic explanation uses to decide whether it
  // may cite a reason vs state only the displayed prescription.
  const grounded = !!(s.label || (_isPlainObject(s.history) && s.history.last_date));
  const confidence = grounded
    ? { score: 70, tier: 'moderate', action: 'act', caveats: [] }
    : { score: 45, tier: 'low', action: 'act_with_caveat', caveats: ['insufficient_history'] };

  const decision = buildCoachingDecision({
    intent: { type: 'explain_recommendation', constraints: {}, source: 'coach_chat' },
    decision_type: 'progress_readout',
    status: 'answered',
    confidence,
    safety: { level: 'green', flags: [], blocking: false },
    payload: {},               // progress_readout carries no prescription (contract rule 6)
    missing_info: [],
    explanation_inputs: {},     // no prescribed numbers to echo (trust contract satisfied vacuously)
    provenance: { modules_run: [], skipped: [], state_asOf: null, engine_version: null },
  });

  return validateCoachingDecision(decision).valid ? decision : null;
}

module.exports = { buildCoachingDecisionFromExplanation };
