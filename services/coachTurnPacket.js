'use strict';

// CoachTurnPacket — canonical contract (Phase 2 Work item 2; charter row in
// docs/CANONICAL_CONTRACTS.md). The EIGHTH and LAST contract, ratified most
// carefully because it assembles from the other seven.
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON and
// the sibling contract validators. No LLM, no Sheets, no write path, no route.
//
// The assembled truth of ONE coach turn — every fact the reply may use, from one
// place (finding H-03). Keyed by the InteractionTrace `turn_id`, it embeds:
//   • athlete   → AthleteContext           (the durable profile)
//   • session   → WorkoutSession           (the in-progress session truth)
//   • exercises → ExerciseIdentity[]       (the identities resolved for the turn)
//   • decision  → CoachingDecision         (the engine's single decision)
//   • safety    → SafetyDecision           (the single safety verdict)
//   • closeout  → CloseoutTransaction      (present only on a closeout turn)
// It is ratified read-only here and is NOT yet wired (hence its staged entry in
// config/wiring-allowlist.json); Phase 3 assembles it in shadow for every real
// turn and Phase 4 makes the live coach route consume it, retiring route-local
// recomputation of packet-owned facts.
//
// EVERY embedded fact is validated by its OWN canonical contract's validator, so
// the packet is valid iff each embedded fact is canonical — "one Brain" is a schema
// invariant, not a convention. There is no single home to adapt from (facts are
// recomputed route-locally today), so there is no boundary adapter; the packet IS
// the assembly. The single safety verdict is enforced consistent across `safety`
// and `decision` (see the consistency rule below).
//
// Public API:
//   buildCoachTurnPacket(params)     → packet object (does NOT validate)
//   validateCoachTurnPacket(packet)  → { valid, errors[] }  (total, never throws)
//   SCHEMA_VERSION

const path = require('node:path');
const fs   = require('node:fs');

const { validateAthleteContext }     = require('./athleteContext');
const { validateWorkoutSession }     = require('./workoutSession');
const { validateExerciseIdentity }   = require('./exerciseIdentity');
const { validateCoachingDecision }   = require('./coachingDecision');
const { validateSafetyDecision }     = require('./safetyDecision');
const { validateCloseoutTransaction } = require('./closeoutTransaction');

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'coach-turn-packet.contract.json');

const SCHEMA_VERSION = 1;

let _contract = null;
function _loadContract() {
  if (!_contract) _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}
function _resetForTesting() { _contract = null; }

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble a CoachTurnPacket. Stamps schema_version, passes turn_id through, and
 * defaults every embedded fact to null (exercises to []). `turn_id` is NOT
 * invented. Does NOT validate — the embedded facts are validated by their own
 * contracts in validateCoachTurnPacket.
 */
function buildCoachTurnPacket(params) {
  const p = _isPlainObject(params) ? params : {};
  return {
    schema_version: SCHEMA_VERSION,
    turn_id:        p.turn_id,
    athlete:        p.athlete != null ? p.athlete : null,
    session:        p.session != null ? p.session : null,
    exercises:      Array.isArray(p.exercises) ? p.exercises : [],
    decision:       p.decision != null ? p.decision : null,
    safety:         p.safety != null ? p.safety : null,
    closeout:       p.closeout != null ? p.closeout : null,
  };
}

// ─── validator (total; never throws) ────────────────────────────────────────────

// Delegate to a sibling contract's validator for a nullable embedded fact: it must
// be PRESENT (explicit-null rule), and when non-null it must validate under its own
// canonical contract. Sub-errors are surfaced under the field name.
function _validateEmbedded(packet, key, validate, errors) {
  if (!Object.prototype.hasOwnProperty.call(packet, key)) {
    errors.push(`${key}: must be present (null or a valid ${key})`);
    return;
  }
  const v = packet[key];
  if (v === null) return;
  if (!_isPlainObject(v)) { errors.push(`${key}: must be a plain object or null`); return; }
  const r = validate(v);
  if (!r.valid) for (const e of r.errors) errors.push(`${key}.${e}`);
}

function validateCoachTurnPacket(packet) {
  if (!_isPlainObject(packet)) return { valid: false, errors: ['packet: must be an object'] };

  try { _loadContract(); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }

  const errors = [];

  if (packet.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  // turn_id — the single InteractionTrace id spanning the whole turn.
  if (!_isNonEmptyString(packet.turn_id)) errors.push('turn_id: must be a non-empty string');

  // Each embedded fact is validated by its OWN canonical contract (the one-Brain
  // property): the packet is valid iff every embedded fact is canonical.
  _validateEmbedded(packet, 'athlete',  validateAthleteContext,     errors);
  _validateEmbedded(packet, 'session',  validateWorkoutSession,     errors);
  _validateEmbedded(packet, 'decision', validateCoachingDecision,   errors);
  _validateEmbedded(packet, 'safety',   validateSafetyDecision,     errors);
  _validateEmbedded(packet, 'closeout', validateCloseoutTransaction, errors);

  // exercises: the ExerciseIdentity list resolved for the turn (may be empty); each
  // element is validated by its own contract.
  if (!Array.isArray(packet.exercises)) {
    errors.push('exercises: must be an array');
  } else {
    packet.exercises.forEach((ex, i) => {
      if (!_isPlainObject(ex)) { errors.push(`exercises[${i}]: must be a plain object`); return; }
      const r = validateExerciseIdentity(ex);
      if (!r.valid) for (const e of r.errors) errors.push(`exercises[${i}].${e}`);
    });
  }

  // ── Single-safety-verdict consistency (H-12) ──
  // When both the SafetyDecision and the CoachingDecision are present, they must
  // represent ONE verdict — the route and the Brain read it, they do not each
  // re-derive it. safety.state ⟺ decision.safety.level and safety.blocking ⟺
  // decision.safety.blocking.
  if (_isPlainObject(packet.safety) && _isPlainObject(packet.decision) && _isPlainObject(packet.decision.safety)) {
    if (packet.safety.state !== packet.decision.safety.level) {
      errors.push(`safety consistency: safety.state '${packet.safety.state}' must equal decision.safety.level '${packet.decision.safety.level}' (one verdict, not re-derived)`);
    }
    if (packet.safety.blocking !== packet.decision.safety.blocking) {
      errors.push('safety consistency: safety.blocking must equal decision.safety.blocking (one verdict, not re-derived)');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  buildCoachTurnPacket,
  validateCoachTurnPacket,
  _resetForTesting,
};
