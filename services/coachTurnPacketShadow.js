'use strict';

// CoachTurnPacket shadow — Phase 3 ("shadow the packet and the trace", H-03/H-14).
//
// Concern 2 threaded ONE turn id through the coach-handler stages and assembled the
// spanning InteractionTrace in shadow. This module (concern 3) assembles the
// CoachTurnPacket — the assembled truth of one coach turn (services/coachTurnPacket.js,
// the ratified read-only contract) — for that same turn, keyed by the same turn id,
// and logs the packet and the actual visible response SIDE BY SIDE. The nightly
// divergence report (concern 4) reads these records and lists every place production
// contradicted or bypassed packet truth.
//
// WHAT PHASE 3 POPULATES — and why the packet is deliberately sparse.
// The read-only coach route produces almost nothing in canonical contract form today;
// that is finding H-03 ("no Coach Turn Packet") itself. So this shadow populates ONLY
// the fact the route genuinely produces canonically:
//   • athlete → AthleteContext with profile_goal (services/profileGoal.js already
//     normalizes it to the canonical training-goal vocabulary, so it always validates).
// Everything else is left at its honest empty value:
//   • session   → null  (the server sees only log history, not the client session
//                        slots — H-08; Phase 4 consumes the client WorkoutSession)
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
// inert). LOG-ONLY, best-effort — writes no Sheet, never blocks or alters the response.
// The logged visible summary is bounded/redacted (presence and shape only) — never the
// coaching prose or any workout number.
//
// Public API:
//   isShadowEnabled()                         → boolean (shared with the trace shadow)
//   assembleShadowPacket({turnId, profileGoal}) → { packet, valid, errors }
//   summarizeVisible(body)                    → bounded visible summary
//   observe({ trace, assembled, visible })    → record | null (logs packet vs visible)
//   getShadowLog()                            → record[]  (newest last; diagnostics/tests)
//   _resetForTesting()

const { buildCoachTurnPacket, validateCoachTurnPacket } = require('./coachTurnPacket');
const { buildAthleteContext } = require('./athleteContext');
const { isShadowEnabled } = require('./interactionTraceShadow');

const MAX_LOG = 200;
const _log = [];

function _push(record) {
  _log.push(record);
  if (_log.length > MAX_LOG) _log.shift();
}

// Assemble the shadow CoachTurnPacket from the turn's canonically-available facts.
// Always builds a STRUCTURALLY COMPLETE packet (every embedded field present) so the
// validator's explicit-null rule is satisfied; populates only what is canonical today
// (see the header). Validates via the packet's own contract (which validates every
// embedded fact by its own validator — "one Brain" as a schema invariant).
function assembleShadowPacket(params) {
  const p = params && typeof params === 'object' ? params : {};
  const athlete = buildAthleteContext({ profile_goal: p.profileGoal != null ? p.profileGoal : null });
  const packet = buildCoachTurnPacket({
    turn_id:   p.turnId,
    athlete,
    session:   null,
    exercises: [],
    decision:  null,
    safety:    null,
    closeout:  null,
  });
  const v = validateCoachTurnPacket(packet);
  return { packet, valid: v.valid, errors: v.errors };
}

// Bounded, redacted summary of the visible coach response — presence and shape only,
// never the coaching prose or any workout number. Enough for the divergence report to
// detect "the visible reply carried coaching the packet does not represent".
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

// Which embedded facts the assembled packet actually carries — booleans (and the
// exercises count). The report treats a null/empty embedded fact as bypassed packet
// truth (production computed it route-locally instead of from the packet).
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

// One line per turn — a stable, single-line JSON record prefixed `[coach-turn-shadow]`,
// self-contained (packet summary + visible summary + trace summary), so the nightly
// divergence report parses everything it needs from this one line. Carries only
// structural/synthetic fields — no prose, no workout data, no secrets.
function _logShadow(record) {
  try { console.log(`[coach-turn-shadow] ${JSON.stringify(record)}`); }
  catch (_) { /* log-only best-effort */ }
}

// Log the assembled packet and the visible response side by side (plus the concern-2
// trace summary, so the record is self-contained). Best-effort; never throws; inert
// when the shadow flag is off.
function observe(params) {
  if (!isShadowEnabled()) return null;
  const p = params && typeof params === 'object' ? params : {};
  try {
    const a = p.assembled && typeof p.assembled === 'object' ? p.assembled : {};
    const packet = a.packet && typeof a.packet === 'object' ? a.packet : null;
    const traceRec = p.trace && typeof p.trace === 'object' && p.trace.trace ? p.trace : null;
    const record = {
      turn_id: packet ? packet.turn_id : (traceRec ? traceRec.trace.turn_id : null),
      packet_valid: a.valid === true,
      packet_errors: Array.isArray(a.errors) ? a.errors.slice(0, 10) : [],
      embedded: packet ? _embeddedFields(packet) : null,
      visible: summarizeVisible(p.visible),
      trace: traceRec ? {
        valid: traceRec.valid,
        stages: traceRec.trace.stages.map((s) => ({ stage: s.stage, status: s.status })),
        missing: Array.isArray(traceRec.missing) ? traceRec.missing : [],
      } : null,
    };
    _logShadow(record);
    _push(record);
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
  _resetForTesting,
};
