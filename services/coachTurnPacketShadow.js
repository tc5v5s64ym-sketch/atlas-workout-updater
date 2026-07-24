'use strict';

// CoachTurnPacket shadow — Phase 3 ("shadow the packet and the trace", H-03/H-14).
//
// Concern 2 threaded ONE turn id through the coach-handler stages and assembled the
// spanning InteractionTrace in shadow. This module (concern 3) assembles the
// CoachTurnPacket — the assembled truth of one coach turn (services/coachTurnPacket.js,
// the ratified read-only contract) — for that same turn, keyed by the same turn id,
// and logs the packet and the actual visible response SIDE BY SIDE. The divergence
// report reads these records and lists every place production contradicted or bypassed
// packet truth.
//
// WHAT PHASE 3 POPULATES — and why the packet is deliberately sparse.
// The read-only coach route produces almost nothing in canonical contract form today;
// that is finding H-03 ("no Coach Turn Packet") itself. So this shadow populates ONLY
// the fact the route genuinely produces canonically:
//   • athlete → AthleteContext with profile_goal (services/profileGoal.js already
//     normalizes it to the canonical training-goal vocabulary, so it always validates).
// Everything else is left at its honest empty value:
//   • session   → the canonical client WorkoutSession when the /api/coach/chat boundary
//                 assembled and validated one this turn (H-08A, flag-gated), else null (the
//                 server otherwise sees only log history, not the client session slots — H-08)
//   • exercises → []    (there is no canonical ExerciseIdentity registry yet — a
//                        name/lift_code slug would be a fabricated immutable key; H-11,
//                        Phase 5b builds the registry)
//   • decision  → null  (the engine's coaching decision is computed route-locally in a
//                        non-canonical shape — H-03; Phase 4 canonicalizes it)
//   • safety    → null  (the safety verdict is route-local — H-12; Phase 5d)
//   • closeout  → null  (this read-only route is never a closeout turn)
// Understating is safe; overstating is the disease being cured (H-05/H-15). Those nulls
// are not a gap to hide — they are the divergence report's headline: production bypasses
// packet truth on every turn, which is exactly what Phase 4/5 retires.
//
// Gated by the same flag as the trace shadow (ATLAS_INTERACTION_TRACE=shadow; default
// inert). Best-effort and response-invisible: each record is logged and mirrored to the
// dedicated Coach_Shadow diagnostics tab, but the coach response never waits for or
// depends on that append. The visible summary remains bounded/redacted (presence and
// shape only) — never the coaching prose or any workout number.

const { buildCoachTurnPacket, validateCoachTurnPacket } = require('./coachTurnPacket');
const { buildAthleteContext } = require('./athleteContext');
const { validateWorkoutSession } = require('./workoutSession');
const { validateCoachingDecision } = require('./coachingDecision');
const { isShadowEnabled } = require('./interactionTraceShadow');
const coachShadowSheet = require('./coachShadowSheet');

const MAX_LOG = 200;
const _log = [];

function _push(record) {
  _log.push(record);
  if (_log.length > MAX_LOG) _log.shift();
}

function assembleShadowPacket(params) {
  const p = params && typeof params === 'object' ? params : {};
  const athlete = buildAthleteContext({ profile_goal: p.profileGoal != null ? p.profileGoal : null });
  // Embed the canonical client WorkoutSession (H-08A) and the canonical CoachingDecision (H-03)
  // ONLY when each genuinely validates — a caller passes them already built + validated at the
  // boundary, but re-check here so an absent or malformed fact is honestly dropped to null
  // (never a half-populated embed). exercises/safety/closeout stay empty: those are still owned
  // by their own campaign phases (H-11/H-12) and are out of scope for this seam.
  let session = null;
  if (p.session != null && validateWorkoutSession(p.session).valid) session = p.session;
  let decision = null;
  if (p.decision != null && validateCoachingDecision(p.decision).valid) decision = p.decision;
  const packet = buildCoachTurnPacket({
    turn_id:   p.turnId,
    athlete,
    session,
    exercises: [],
    decision,
    safety:    null,
    closeout:  null,
  });
  const v = validateCoachTurnPacket(packet);
  return { packet, valid: v.valid, errors: v.errors };
}

function summarizeVisible(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : {};
  const msg = typeof data.message === 'string' ? data.message : null;
  return {
    message_present: !!(msg && msg.trim()),
    message_len: msg ? msg.length : 0,
    source: typeof data.source === 'string' ? data.source : null,
    configured: data.configured === true ? true : (data.configured === false ? false : null),
    note_tier: data.note_tier != null ? data.note_tier : null,
    kind: typeof data.kind === 'string' ? data.kind : null,
    error_present: !!data.error,
  };
}

function _embeddedFields(packet) {
  return {
    athlete: packet.athlete != null,
    athlete_profile_goal: !!(packet.athlete && packet.athlete.profile_goal != null),
    session: packet.session != null,
    exercises: Array.isArray(packet.exercises) ? packet.exercises.length : 0,
    decision: packet.decision != null,
    safety: packet.safety != null,
    closeout: packet.closeout != null,
  };
}

// The packet's discussion referent — the lift a bare correction should resolve to. The
// packet has NO such field today; Phase 4 adds it to the CoachTurnPacket/WorkoutSession set
// at answer time. Read it defensively so the divergence comparison goes live automatically
// once the field exists (packet.referent, or session.discussion_referent).
function _packetReferent(packet) {
  if (!packet || typeof packet !== 'object') return null;
  if (packet.referent != null) return packet.referent;
  const s = packet.session;
  if (s && typeof s === 'object' && s.discussion_referent != null) return s.discussion_referent;
  return null;
}

// The recommendation-explanation grounding the route actually used to build the reply — a
// bounded snapshot of the session/recommendation, the target exercise, the engine decision
// (the prescription), and the coaching strategy. Recorded on the SHADOW RECORD (the
// `[coach-turn-shadow]` log + the ring buffer), NOT on the canonical packet's
// session/exercises/decision fields: an ExerciseIdentity needs an immutable registry key
// that does not exist yet (H-11, Phase 5b), and claiming canonical packet facts the route
// does not yet produce would OVERSTATE (the disease being cured, H-05/H-15). The Coach_Shadow
// Sheet schema is unchanged — coachShadowSheet.buildRow serializes only its fixed columns and
// never reads this field. Absent on every non-recommendation-explanation turn.
function _summarizeGrounding(grounding) {
  if (!grounding || typeof grounding !== 'object') return null;
  const t = grounding.target && typeof grounding.target === 'object' ? grounding.target : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    coaching_strategy: str(grounding.coaching_strategy),
    recommendation_label: str(grounding.label),
    fingerprint_lifts: grounding.fingerprint && Array.isArray(grounding.fingerprint.lifts) ? grounding.fingerprint.lifts.slice(0, 10) : [],
    target: {
      name: str(t.name),
      weight: num(t.weight),
      reps: num(t.reps),
      sets: num(t.sets),
      rir: t.rir == null ? null : num(t.rir),
    },
    readiness_count: Array.isArray(grounding.readiness) ? grounding.readiness.length : 0,
    has_history: !!(grounding.history && grounding.history.last_date),
  };
}

function _logShadow(record) {
  try { console.log(`[coach-turn-shadow] ${JSON.stringify(record)}`); }
  catch (_) { /* log-only best-effort */ }
}

function observe(params) {
  if (!isShadowEnabled()) return null;
  const p = params && typeof params === 'object' ? params : {};
  try {
    const a = p.assembled && typeof p.assembled === 'object' ? p.assembled : {};
    const packet = a.packet && typeof a.packet === 'object' ? a.packet : null;
    const traceRec = p.trace && typeof p.trace === 'object' && p.trace.trace ? p.trace : null;
    const visible = summarizeVisible(p.visible);
    const routeRef = p.routeReferent && typeof p.routeReferent === 'object' ? p.routeReferent : null;
    const recordedAt = new Date().toISOString();
    const record = {
      recorded_at: recordedAt,
      turn_id: packet ? packet.turn_id : (traceRec ? traceRec.trace.turn_id : null),
      intent_type: traceRec ? traceRec.intent_type : null,
      source: traceRec ? traceRec.source : null,
      packet_valid: a.valid === true,
      packet_errors: Array.isArray(a.errors) ? a.errors.slice(0, 10) : [],
      embedded: packet ? _embeddedFields(packet) : null,
      // The lift a bare correction resolves to: the route's pick vs the packet's field
      // (null until Phase 4). A route pick with a null packet referent is the divergence
      // signal that the referent is computed route-locally.
      referent: {
        route: routeRef && routeRef.route != null ? routeRef.route : null,
        packet: _packetReferent(packet),
        is_dispute: routeRef ? !!routeRef.is_dispute : false,
      },
      visible,
      // The recommendation-explanation grounding the route used for this turn (target
      // exercise, prescription, engine reason, coaching strategy). Null on every other turn.
      grounding: _summarizeGrounding(p.grounding),
      trace: traceRec ? {
        valid: traceRec.valid,
        stages: traceRec.trace.stages.map((s) => ({ stage: s.stage, status: s.status })),
        missing: Array.isArray(traceRec.missing) ? traceRec.missing : [],
      } : null,
    };
    _logShadow(record);
    _push(record);
    coachShadowSheet.persist({ recordedAt, trace: traceRec, assembled: a, visible });
    return record;
  } catch (_) {
    return null; // shadow must never surface a failure
  }
}

function getShadowLog() {
  return _log.slice();
}

function _resetForTesting() {
  _log.length = 0;
}

module.exports = {
  isShadowEnabled,
  assembleShadowPacket,
  summarizeVisible,
  observe,
  getShadowLog,
  // Exposed for Drift Guard 5 (scripts/check-packet-trace.js): the guard verifies these
  // embedded-presence flags never overclaim a fact its own contract does not validate.
  _embeddedFields,
  _resetForTesting,
};
