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
    schema_version: SCHEMA_VERSION,
    session_id:     p.session_id != null ? p.session_id : null,
    slots,
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

module.exports = {
  SCHEMA_VERSION,
  buildWorkoutSession,
  validateWorkoutSession,
  currentSlot,
  remainingSlots,
  isComplete,
  get SLOT_STATUSES() { return [..._loadContract().slot_statuses]; },
  get SLOT_SOURCES() { return [..._loadContract().slot_sources]; },
  _resetForTesting,
};
