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
// authoritatively request a substitution?" It composes the EXISTING authoritative
// classifiers (it introduces no new phrase regex — that would just be another route-local
// patch): a conversational aside (greeting / presence-check / malfunction complaint) is
// NEVER a substitution, even when it trips a constraint keyword by coincidence
// ("Are you broken?" contains "broken"). A genuine substitution is an explicit substitute
// intent from the client's deterministic classifier, or an equipment/exercise constraint
// message ("the rack is taken", "bench is broken"). Two things keep a genuine equipment
// report substituting: the aside guard in coachExplanationGrounding vetoes itself whenever
// the message names a lift or a plan word ("the bench is broken" contains "bench" → not an
// aside), and when an aside DOES overlap a bare constraint keyword the veto applies only if
// the message addresses Atlas in the second person — so an impersonal report like "the cable
// machine is not working" (an aside via "not working", also a constraint) is left to the
// constraint path and still substitutes, while "Are you broken?" is vetoed.
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

// A second-person address to Atlas ("are YOU broken?", "ATLAS you there?") is what separates
// an Atlas-directed malfunction complaint (veto — FR turn 4) from an IMPERSONAL equipment
// report ("the cable machine is not working", "the rack is broken") that isConversationalAside
// also matches (its "not working" / "broken" alternations) and that isConstraintMessage
// correctly recognizes. Only used to disambiguate the aside∩constraint overlap so a genuine
// equipment report still substitutes.
const ATLAS_ADDRESSED_RE = /\b(?:you|u|ur|your|you['’]?re|youre|atlas)\b/i;

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

  // A conversational aside owns the turn over a substitution — the required rule "a greeting
  // or malfunction complaint cannot invoke substitution". But when it OVERLAPS a constraint
  // keyword it must still yield to a genuine equipment report: an aside that is also a
  // constraint only vetoes when it actually addresses Atlas in the second person
  // ("Are you broken?"). An impersonal equipment report ("the cable machine is not working")
  // is an aside AND a constraint but does NOT address Atlas, so it stays a constraint and
  // still substitutes.
  if (aside && (!constraint || ATLAS_ADDRESSED_RE.test(message))) {
    return { lane: LANES.ASIDE, allowSubstitution: false, reason: 'greeting/presence/Atlas-directed malfunction aside — not a substitution request' };
  }
  if (explicitIntent) {
    return { lane: LANES.SUBSTITUTION, allowSubstitution: true, reason: 'explicit substitution intent' };
  }
  if (constraint) {
    return { lane: LANES.SUBSTITUTION, allowSubstitution: true, reason: 'equipment/exercise constraint' };
  }
  return { lane: LANES.NONE, allowSubstitution: false, reason: 'no authoritative substitution signal' };
}

module.exports = { decideTurnPrecedence, isTurnPrecedenceEnabled, LANES };
