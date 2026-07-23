'use strict';

// Turn precedence — Phase 4 ("the canonical proof"), first concern (H-03/H-08/H-16).
//
// ONE authoritative current-message decision that owns the turn, instead of each route
// independently reinterpreting the same message. Phase 3's divergence summary
// (docs/verification/PHASE_3_DIVERGENCE_SUMMARY_2026-07-23.md, Flight Recorder
// FR-20260723120852-hw56ws9y) showed a single turn cascading through 2–5 route-local lanes
// (parser → modality → substitution → SME → free-form chat), each able to speak, with the
// last lane to answer winning — even when it contradicted the active plan.
//
// THE FAILURE THIS CONCERN RETIRES (FR turn 4). The athlete typed "Are you broken?" — a
// malfunction complaint about Atlas. The substitution lane's route-local gate is
// `intent === 'substitute' || isConstraintMessage(message)`, and `isConstraintMessage`
// matches the bare keyword `/\bbroken\b/` (services/constraintDetector.js) — so the route
// produced "No Bench Press today — Incline Press is your best swap…", contradicting the
// active plan where Bench Press was already first. The coach chat route ALREADY answers a
// malfunction complaint correctly (coachExplanationGrounding.isConversationalAside →
// buildConversationalAck, the 2026-07-22 fix), but it never got the turn: the substitution
// lane intercepted upstream.
//
// THE DECISION. `decideTurnPrecedence` is the single authority for "does this message
// authoritatively request a substitution?" It leans on the EXISTING authoritative classifiers
// (isConversationalAside, isConstraintMessage) plus the parser's named-lift recognition
// (messageNamesALift), and owns ONE narrow disambiguator regex for the ambiguity they cannot
// resolve on their own (documented at AMBIGUOUS_PRONOUN_REFERENT_RE below). A conversational
// aside (greeting / presence-check / malfunction complaint) is NEVER a substitution, even when
// it trips a constraint keyword by coincidence ("Are you broken?" contains "broken"). A genuine
// substitution is an explicit substitute intent from the client's deterministic classifier, or
// an equipment/exercise constraint message ("the rack is taken", "bench is broken").
//
// Three things keep a genuine equipment report substituting while ambiguity fails closed. The
// aside guard in coachExplanationGrounding vetoes ITSELF whenever the message names a lift or a
// plan word ("the bench is broken" contains "bench" → not an aside). When an aside DOES overlap
// a bare constraint keyword, the overlap yields to the constraint path only when the message
// carries an AUTHORITATIVE REFERENT — the parser recognizes a lift/equipment, or the malfunction
// names a concrete noun subject rather than a bare ambiguous pronoun. So "the cable machine is
// not working" (an aside via "not working", also a constraint, no ambiguous pronoun) still
// substitutes, while "Are you broken?", "you are not working", "it's broken", and "is it broken?"
// — whose only referent is a bare pronoun that could mean Atlas OR the equipment — fail closed.
//
// PHASE-4 HARDENING (this concern). The prior disambiguator vetoed only a SECOND-PERSON address
// ("are YOU broken?"), which let the IMPERSONAL ambiguous pronoun through: "it's broken" and
// "is it broken?" reached the constraint path and produced a plan-changing swap on a guess. In
// conversation those phrases often refer to Atlas itself (particularly after an incorrect
// answer), so until `discussion_referent` becomes a canonical CoachTurnPacket field later in
// Phase 4, an ambiguous pronoun-only malfunction must UNDER-CALL — decline the substitution —
// rather than fabricate an equipment referent.
//
// SCOPE OF THIS FIRST CONCERN. The decision is consumed by the substitution lane
// (POST /api/suggest-substitute), behind the ATLAS_TURN_PRECEDENCE flag (default inert).
// When the decision does not authorize a substitution, the route returns no recommendation
// and the client's existing fall-through routes the turn to the coach — which handles it
// correctly. Subsequent Phase-4 concerns extend the SAME decision to the chat/SME lanes
// (scope a current-exercise prescription question to the active exercise; recognize a
// warm-up question as a warm-up question; a clarification cannot replay a stale diagnostic)
// and promote `discussion_referent` to a CoachTurnPacket/WorkoutSession field. This concern
// changes no production behavior until the owner enables the flag at the Phase-4 owner gate;
// it never writes, never touches the preview→approve→write loop, and never invents a number.
//
// Pure / deterministic — no I/O, no clock, no randomness.

const { isConversationalAside } = require('./coachExplanationGrounding');
const { isConstraintMessage } = require('./constraintDetector');
const { messageNamesALift, normalize } = require('./coachResponseGrounding');

// The ONE narrow disambiguator this module owns, used ONLY to resolve the aside∩constraint
// overlap (a message that is both a conversational aside AND trips a constraint keyword). It
// recognizes a malfunction predicated on a BARE AMBIGUOUS PRONOUN whose referent is not a named
// exercise or equipment:
//   • the IMPERSONAL "it" — "it's broken", "is it broken?" — which could mean the equipment OR
//     Atlas itself; and
//   • a SECOND-PERSON address to Atlas — "you", "u", "ur", "your", "atlas" — "are you broken?",
//     "you are not working".
// Either way there is no authoritative referent for a plan-changing swap, so the turn fails
// closed. A GENUINE report names a concrete noun subject ("the cable machine is not working",
// "the rack is not working") that matches none of these tokens and is left to the constraint
// path, and the parser's messageNamesALift ("the bench is broken") is an authoritative referent
// that overrides this test entirely. Erring toward the pronoun (fail closed) is the required
// under-call: ambiguity must never fabricate an equipment referent. Superseded later in Phase 4
// when `discussion_referent` becomes a canonical CoachTurnPacket field.
const AMBIGUOUS_PRONOUN_REFERENT_RE = /\b(?:it|its|you|youre|u|ur|your|atlas)\b/i;

// The flag that gates route consumption of this decision. Default inert: absent/off ⇒ the
// live routes behave exactly as before. The owner turns it on at the Phase-4 owner gate.
const ENABLED_VALUES = new Set(['on', '1', 'true', 'enforce', 'enabled']);

function isTurnPrecedenceEnabled(env) {
  const e = env && typeof env === 'object' ? env : process.env;
  return ENABLED_VALUES.has(String(e.ATLAS_TURN_PRECEDENCE || '').trim().toLowerCase());
}

// Turn lanes this decision can name. Only `substitution` / `aside` are consumed in this
// first concern; the rest are the named seams later Phase-4 concerns wire out.
const LANES = Object.freeze({
  SUBSTITUTION: 'substitution', // an authoritative substitution request
  ASIDE: 'aside',               // greeting / presence-check / malfunction complaint
  NONE: 'none',                 // no authoritative substitution signal this turn
});

/**
 * The single authoritative current-message decision for the substitution lane.
 *
 * @param {object} params
 * @param {string} params.message  the raw current athlete message
 * @param {string} [params.intent] the client's deterministic intent tag ('substitute' when
 *                                  its classifier resolved an explicit substitution request)
 * @returns {{ lane: string, allowSubstitution: boolean, reason: string }}
 */
function decideTurnPrecedence(params) {
  const p = params && typeof params === 'object' ? params : {};
  const message = typeof p.message === 'string' ? p.message : '';
  const explicitIntent = p.intent === 'substitute';
  const aside = isConversationalAside(message);
  const constraint = isConstraintMessage(message);

  // AUTHORITATIVE REFERENT vs AMBIGUOUS PRONOUN. The parser recognizing a named lift/equipment
  // (messageNamesALift — "the bench is broken", "the squat rack is broken") is authoritative and
  // always overrides the pronoun test. Absent that, an `ambiguousReferent` is a constraint whose
  // only referent is a bare ambiguous pronoun ("it"/second-person Atlas) — no concrete noun to
  // point a swap at. A genuine impersonal report ("the cable machine is not working") names a
  // concrete noun that matches none of the pronoun tokens, so it is NOT ambiguous.
  const namedReferent = messageNamesALift(message);
  const ambiguousReferent = !namedReferent && AMBIGUOUS_PRONOUN_REFERENT_RE.test(normalize(message));

  // (1) A conversational aside owns the turn: a greeting / presence-check / malfunction complaint
  //     is never a substitution. When it overlaps a constraint keyword it still yields to a
  //     GENUINE (named/concrete) report, but fails closed on an ambiguous one.
  if (aside && (!constraint || ambiguousReferent)) {
    return { lane: LANES.ASIDE, allowSubstitution: false, reason: 'greeting/presence/ambiguous-referent malfunction aside — not a substitution request' };
  }
  // (2) An explicit substitution intent from the client's deterministic classifier is
  //     authoritative even without a constraint keyword ("give me something else").
  if (explicitIntent) {
    return { lane: LANES.SUBSTITUTION, allowSubstitution: true, reason: 'explicit substitution intent' };
  }
  // (3) A constraint message substitutes ONLY with an authoritative referent. An ambiguous
  //     pronoun-only malfunction the aside classifier did not recognize ("it is broken") still
  //     fails closed here rather than fabricate an equipment referent — the required under-call
  //     until `discussion_referent` becomes canonical later in Phase 4.
  if (constraint && ambiguousReferent) {
    return { lane: LANES.ASIDE, allowSubstitution: false, reason: 'ambiguous pronoun-only malfunction — no authoritative referent for a substitution' };
  }
  if (constraint) {
    return { lane: LANES.SUBSTITUTION, allowSubstitution: true, reason: 'equipment/exercise constraint' };
  }
  return { lane: LANES.NONE, allowSubstitution: false, reason: 'no authoritative substitution signal' };
}

module.exports = { decideTurnPrecedence, isTurnPrecedenceEnabled, LANES };
