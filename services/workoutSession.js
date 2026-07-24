'use strict';

// WorkoutSession — canonical contract (Phase 2 Work item 2; charter row in
// docs/CANONICAL_CONTRACTS.md).
//
// Pure / deterministic. No I/O at call time beyond the static contract JSON.
// No LLM, no Sheets, no write path, no route.
//
// The single truth of the in-progress session: its ordered exercise slots, each
// slot's status + set tally, and the DERIVED cursor. This names and versions the
// shape that lives today on the client as src/app/activeSession.js
// ({ exercises: [{ name, liftCode, status, source }] } with a derived cursor);
// the server sees only StateSnapshot.log_history. It is ratified read-only here
// and is NOT yet wired (hence its staged entry in config/wiring-allowlist.json);
// Phase 4 makes the live route consume it and enforces the session-priority
// invariant (H-08 / H-18).
//
// The cursor is DERIVED, never stored — currentSlot() is the first pending slot,
// mirroring activeSession.currentExercise / nextUp so the composer and next-up
// router can never disagree. This module is the single owner of session-truth
// selectors. Duplicate slot names are allowed and stay independent (F10).
//
// Public API:
//   buildWorkoutSession(params)       → session object (does NOT validate)
//   validateWorkoutSession(session)   → { valid, errors[] }  (total, never throws)
//   fromActiveSession(active, opts)   → canonical WorkoutSession from the live
//                                       src/app/activeSession.js client model
//   currentSlot(session)              → the first pending slot, or null (derived)
//   remainingSlots(session)           → all pending slots, in order
//   isComplete(session)               → had slots and none pending
//   SCHEMA_VERSION, SLOT_STATUSES, SLOT_SOURCES

const path = require('node:path');
const fs   = require('node:fs');

const CONTRACT_FILE = path.join(__dirname, '..', 'config', 'coaching', 'contracts', 'workout-session.contract.json');

const SCHEMA_VERSION = 1;

let _contract = null;
function _loadContract() {
  if (!_contract) _contract = Object.freeze(JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')));
  return _contract;
}
function _resetForTesting() { _contract = null; }

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function _isNonNegInt(v) { return Number.isInteger(v) && v >= 0; }

// ─── builder ──────────────────────────────────────────────────────────────────

/**
 * Assemble a WorkoutSession. Stamps schema_version, defaults session_id to null
 * and slots to [], and normalizes each slot (status→'pending', source→'planned',
 * sets_logged→0, sets_target→null, lift_code→null) like createActiveSession. Does
 * NOT validate.
 *
 * `discussion_referent` (D10): the canonical key of the lift the conversation is
 * currently about, set at answer time so a bare correction resolves from ONE state
 * read instead of the interim in-memory store + history scan. Optional + nullable;
 * defaults to null. Not yet populated on the live route (that layers on later).
 */
function buildWorkoutSession(params) {
  const p = _isPlainObject(params) ? params : {};
  const slots = (Array.isArray(p.slots) ? p.slots : []).map((s) => {
    const slot = _isPlainObject(s) ? s : {};
    return {
      name:        slot.name,
      lift_code:   slot.lift_code != null ? slot.lift_code : null,
      status:      slot.status != null ? slot.status : 'pending',
      source:      slot.source != null ? slot.source : 'planned',
      sets_logged: slot.sets_logged != null ? slot.sets_logged : 0,
      sets_target: slot.sets_target != null ? slot.sets_target : null,
    };
  });
  return {
    schema_version:      SCHEMA_VERSION,
    session_id:          p.session_id != null ? p.session_id : null,
    slots,
    discussion_referent: p.discussion_referent != null ? p.discussion_referent : null,
  };
}

// ─── validator (total; never throws) ────────────────────────────────────────────

function validateWorkoutSession(session) {
  if (!_isPlainObject(session)) return { valid: false, errors: ['session: must be an object'] };

  let contract;
  try { contract = _loadContract(); }
  catch (e) { return { valid: false, errors: [`contract load failed: ${e.message}`] }; }
  const statuses = new Set(contract.slot_statuses);
  const sources = new Set(contract.slot_sources);

  const errors = [];
  const _has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  if (session.schema_version !== SCHEMA_VERSION) errors.push(`schema_version: must be ${SCHEMA_VERSION}`);

  // session_id follows the explicit-null rule: present, null or a non-empty string.
  if (!_has(session, 'session_id')) errors.push('session_id: must be present (null or a non-empty string)');
  else if (session.session_id !== null && !_isNonEmptyString(session.session_id)) errors.push('session_id: must be a non-empty string or null');

  // discussion_referent (D10) is OPTIONAL (absent is fine — an older/hand-built session omits
  // it); when present it is null or a non-empty canonical key. Never required, so it never
  // breaks a session literal that predates the field.
  if (_has(session, 'discussion_referent') && session.discussion_referent !== null && !_isNonEmptyString(session.discussion_referent)) {
    errors.push('discussion_referent: must be a non-empty string or null when present');
  }

  if (!Array.isArray(session.slots)) {
    errors.push('slots: must be an array');
    return { valid: false, errors };
  }

  // Duplicate slot names are ALLOWED (F10) — no uniqueness check.
  session.slots.forEach((slot, i) => {
    if (!_isPlainObject(slot)) { errors.push(`slots[${i}]: must be an object`); return; }
    if (!_isNonEmptyString(slot.name)) errors.push(`slots[${i}].name: must be a non-empty string`);

    if (!_has(slot, 'lift_code')) errors.push(`slots[${i}].lift_code: must be present (null or a non-empty string)`);
    else if (slot.lift_code !== null && !_isNonEmptyString(slot.lift_code)) errors.push(`slots[${i}].lift_code: must be a non-empty string or null`);

    if (!statuses.has(slot.status)) errors.push(`slots[${i}].status: must be one of ${[...statuses].join(', ')}`);
    if (!sources.has(slot.source)) errors.push(`slots[${i}].source: must be one of ${[...sources].join(', ')}`);

    if (!_isNonNegInt(slot.sets_logged)) errors.push(`slots[${i}].sets_logged: must be an integer >= 0`);

    if (!_has(slot, 'sets_target')) errors.push(`slots[${i}].sets_target: must be present (null or an integer >= 1)`);
    else if (slot.sets_target !== null && !(Number.isInteger(slot.sets_target) && slot.sets_target >= 1)) errors.push(`slots[${i}].sets_target: must be an integer >= 1 or null`);
  });

  return { valid: errors.length === 0, errors };
}

// ─── derived session-truth selectors (single owner) ──────────────────────────────

// The current slot = the first PENDING slot, in order (mirrors
// activeSession.currentExercise / nextUp). null when nothing is pending.
function currentSlot(session) {
  if (!_isPlainObject(session) || !Array.isArray(session.slots)) return null;
  return session.slots.find((s) => _isPlainObject(s) && s.status === 'pending') || null;
}

// All still-to-do (pending) slots, in order.
function remainingSlots(session) {
  if (!_isPlainObject(session) || !Array.isArray(session.slots)) return [];
  return session.slots.filter((s) => _isPlainObject(s) && s.status === 'pending');
}

// True when the session had slots and none remain pending.
function isComplete(session) {
  if (!_isPlainObject(session) || !Array.isArray(session.slots) || session.slots.length === 0) return false;
  return remainingSlots(session).length === 0;
}

// ─── boundary adapter: live client session → canonical WorkoutSession ────────────

// The live client model (src/app/activeSession.js) carries `liftCode` as a STRING and uses
// `''` for "no lift code" (createActiveSession → toEntry normalizes an absent code to ''),
// but the canonical contract requires `lift_code` to be `null` or a NON-EMPTY string. Bridge
// the two representations faithfully: trim, and coerce an empty/whitespace-only code → null.
// Without this, a real un-coded exercise (the common case — most planned lifts carry no code)
// would produce `lift_code: ''`, failing validation and sinking the WHOLE session to null at
// the H-08 boundary. Prefer a non-empty `liftCode`, then a non-empty `lift_code`, else null.
function _canonicalLiftCode(v) {
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

// Convert the live client model (src/app/activeSession.js —
// `{ exercises: [{ name, liftCode, status, source }] }`) into a canonical, valid
// WorkoutSession. This is the single boundary Phase 4 crosses when the route
// consumes the client's active session for the outage/session-priority fallback:
// `liftCode` → `lift_code` (empty → null, see _canonicalLiftCode); the client model carries
// no set tallies, so `sets_logged` defaults to 0 and `sets_target` to null; `status`/`source`
// pass through (they already use this contract's enums). Pure; validates clean.
function fromActiveSession(active, { session_id = null, discussion_referent = null } = {}) {
  const exercises = _isPlainObject(active) && Array.isArray(active.exercises) ? active.exercises : [];
  return buildWorkoutSession({
    session_id,
    discussion_referent,
    slots: exercises.map((e) => {
      const ex = _isPlainObject(e) ? e : {};
      return {
        name:        ex.name,
        lift_code:   _canonicalLiftCode(ex.liftCode) || _canonicalLiftCode(ex.lift_code),
        status:      ex.status,
        source:      ex.source,
        sets_logged: 0,
        sets_target: null,
      };
    }),
  });
}

module.exports = {
  SCHEMA_VERSION,
  buildWorkoutSession,
  validateWorkoutSession,
  fromActiveSession,
  currentSlot,
  remainingSlots,
  isComplete,
  get SLOT_STATUSES() { return [..._loadContract().slot_statuses]; },
  get SLOT_SOURCES() { return [..._loadContract().slot_sources]; },
  _resetForTesting,
};
