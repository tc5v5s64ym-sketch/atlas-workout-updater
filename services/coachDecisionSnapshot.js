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
function _strOrNull(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function _numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
// A string present iff it is truthy — NOT trimmed. This mirrors EXACTLY what the shared worder
// (coachExplanationGrounding._wordRecommendationExplanation) treats as "a name to word": `!f.name`.
// The target lift name is the one snapshot field buildRecommendationSnapshot does NOT normalize
// (it trims label/focus/dates but leaves target.name = entryName(entry) raw), so trimming it here
// would make the canonical-decision path word a DIFFERENT name than the flag-off snapshot path for
// a client current_plan name carrying surrounding whitespace — breaking byte-identity. Carrying the
// raw name reproduces the flag-off reply exactly (retrospective review, 2026-07-24).
function _presentStr(v) { return typeof v === 'string' && v ? v : null; }

// The readout facts the output-LLM may word for an explain-recommendation turn — the DISPLAYED
// recommendation's prescription (name + weight/reps/sets/rir), the engine's label/focus, and the
// target lift's most-recent logged session (last_date + top set). Only non-null facts are included
// ("here are the facts you may word"); an outage snapshot with no numbers yields a near-empty set
// (honest — nothing to word). These are the EXISTING displayed recommendation being explained (plus
// a genuinely-logged prior fact), NOT a new prescription — so the payload stays empty
// (progress_readout carries no prescription, contract rule 6) and the trust contract (which
// governs prescribed PAYLOAD numbers) is unaffected.
//
// The history facts (target_last_date/target_last_top) are the SAME logged fact the route's
// deterministic explanation words ("Your last logged <lift> was <date> at <top set>"); carrying
// them here completes the readout fact set so the canonical decision fully captures what the route
// says, a precondition for a future byte-identical live consumption of packet.decision. Pure.
function _explanationInputsFrom(snapshot) {
  const s = _isPlainObject(snapshot) ? snapshot : {};
  const t = _isPlainObject(s.target) ? s.target : {};
  const h = _isPlainObject(s.history) ? s.history : {};
  const out = {};
  const put = (k, v) => { if (v != null) out[k] = v; };
  // Raw (un-trimmed) to stay byte-identical with the flag-off snapshot path, which words the
  // un-normalized target.name verbatim (see _presentStr above). Every OTHER fact below is already
  // normalized identically by buildRecommendationSnapshot, so _strOrNull/_numOrNull are faithful there.
  put('target_name', _presentStr(t.name));
  put('target_weight', _numOrNull(t.weight));
  put('target_reps', _numOrNull(t.reps));
  put('target_sets', _numOrNull(t.sets));
  put('target_rir', _numOrNull(t.rir));
  put('recommendation_label', _strOrNull(s.label));
  put('focus', _strOrNull(s.focus));
  // The target lift's most-recent logged session — the same grounded prior fact the route's
  // deterministic explanation cites. last_top is the pre-formatted top-set string (e.g.
  // "185 for 5 at 2 RIR") built by coachExplanationGrounding.buildTargetHistory.
  put('target_last_date', _strOrNull(h.last_date));
  put('target_last_top', _strOrNull(h.last_top));
  return out;
}

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
    // `source` is the IntentEnvelope source vocabulary (config/coaching/contracts/
    // intent.vocabulary.json: button|chat|voice|api|wearable|schedule) — the /api/coach/chat
    // boundary is `chat` (Codex #1151 P2). NOT 'coach_chat' (not in the closed vocabulary).
    intent: { type: 'explain_recommendation', constraints: {}, source: 'chat' },
    decision_type: 'progress_readout',
    status: 'answered',
    confidence,
    safety: { level: 'green', flags: [], blocking: false },
    payload: {},               // progress_readout carries no prescription (contract rule 6)
    missing_info: [],
    // The readout facts the LLM may word (the displayed prescription + label/focus). No
    // prescribed PAYLOAD numbers exist for progress_readout, so the trust contract is satisfied
    // vacuously regardless of what non-prescription facts appear here.
    explanation_inputs: _explanationInputsFrom(s),
    provenance: { modules_run: [], skipped: [], state_asOf: null, engine_version: null },
  });

  return validateCoachingDecision(decision).valid ? decision : null;
}

/**
 * Build a canonical `recovery` CoachingDecision for a tiredness/recovery-routing turn (the route
 * decides "a tired lifter — answer with recovery routing" and returns early, stashing a shadow
 * signal on res.locals.coachRecoveryDecision). Read-only, no prescription.
 *
 * @param {object} [signal]
 * @param {boolean} [signal.engine_grounded]  true when the engine's fatigue signals were
 *        available (the configured path computes fatigueStatus + days-since-last-session); false
 *        on the outage path (client readiness only). Drives the CONSERVATIVE confidence, never a
 *        fabricated high value — grounded ⇒ moderate/act; outage ⇒ low/act_with_caveat +
 *        limited_readiness_inputs. safety stays green/non-blocking (recovery routing is an
 *        advisory, not a write block).
 * @returns {object|null}  the decision, or null when it fails validation.
 */
function buildRecoveryDecision(signal) {
  const grounded = !!(_isPlainObject(signal) && signal.engine_grounded === true);
  const confidence = grounded
    ? { score: 70, tier: 'moderate', action: 'act', caveats: [] }
    : { score: 45, tier: 'low', action: 'act_with_caveat', caveats: ['limited_readiness_inputs'] };

  const decision = buildCoachingDecision({
    intent: { type: 'readiness_checkin', constraints: {}, source: 'chat' },
    decision_type: 'recovery',
    status: 'answered',
    confidence,
    safety: { level: 'green', flags: [], blocking: false },
    payload: {},
    missing_info: [],
    explanation_inputs: {},
    provenance: { modules_run: [], skipped: [], state_asOf: null, engine_version: null },
  });

  return validateCoachingDecision(decision).valid ? decision : null;
}

module.exports = { buildCoachingDecisionFromExplanation, buildRecoveryDecision };
