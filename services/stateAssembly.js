'use strict';

// State Assembly — layer ③ of the One-Brain coaching engine.
//
// The read-only read-model hydration layer. Reads Sheets ONCE per request via
// injected readers and builds a single StateSnapshot the pure Brain modules
// consume. All coaching-read I/O is quarantined here so the Brain stays pure and
// offline-testable. NEVER writes — the preview→approve→write trust loop lives
// entirely outside the Brain.
//
// Spec: docs/COACHING_STATE_ASSEMBLY_SPEC.md
// Architecture: docs/COACHING_ENGINE_ARCHITECTURE.md
//
// Only pure derivers are imported at module top level. The Sheets-backed default
// readers (trainingStore, deloadState, profileGoal) are LAZY-required inside
// _defaultReaders(), so importing this module — and any test that injects its own
// readers — never pulls sheets.js / googleapis.
//
// Public API:
//   assembleState({ readers?, asOf, options? }) → Promise<StateSnapshot>
//   knownKeys(snapshot, envelope?)              → Set<inputKey>

const { buildMemorySnapshot }   = require('./memoryModule');   // pure
const { buildBodyweightHistory } = require('./analytics');     // pure

// Lazy — only reached on the production path (no injected readers). Keeps the
// static dependency graph free of sheets.js / googleapis.
function _defaultReaders() {
  try {
    const { getLogRows }              = require('./trainingStore');
    const { readCurrentDeloadState }  = require('./deloadState');
    const { getProfileGoal }          = require('./profileGoal');
    const coachingInputs              = require('./coachingInputsAuthority');
    return {
      getLogRows,
      readDeloadState: readCurrentDeloadState,
      // Only goal has a durable source today; level/population stay null until one exists.
      // Return null when there is no goal at all, so provenance.reads does not record a
      // 'profile' read that produced no data (the orchestrator consumes reads).
      getProfile: () => {
        const profile_goal = getProfileGoal();
        return profile_goal == null ? null : { profile_goal, training_level: null, population: null };
      },
      // Stored typed constraints — Supabase, their sole authority since the S4
      // cutover (OWNER CORRECTION 2026-08-13). Read STRICTLY: an empty result is a
      // real "no constraints", and a failure propagates.
      getConstraints: () => coachingInputs.constraintRows(),
    };
  } catch {
    // The reader LAYER could not be constructed at all — a module that failed to
    // load, not a store that failed to answer. That is a deployment fault rather
    // than a data one, and the snapshot degrades to empty as it always did.
    // provenance.reads stays empty, so nothing downstream mistakes it for data.
    return {};
  }
}

// Run a reader safely: never throws, records success in `reads`, returns the
// fallback on absence/empty/error.
//
// FOR THE INPUTS WHERE ABSENCE AND FAILURE MEAN THE SAME THING. `log_history` and
// `profile` are read this way: an athlete with no logged history and an unreadable
// history both leave the engine with nothing to reason from, and it says so.
async function _safeRead(fn, fallback, label, reads) {
  if (typeof fn !== 'function') return fallback;
  try {
    const v = await fn();
    if (v == null) return fallback;
    reads.push(label);
    return v;
  } catch {
    return fallback;
  }
}

// THE SAFETY INPUTS ARE READ STRICTLY, and the difference is the whole point.
//
// OWNER CORRECTION 2026-08-13: a Supabase read failure must never be presented as
// "no constraints" or "not in a deload". Those two inputs are what stop the engine
// prescribing into a reported injury or through a deliberate deload week, so an
// unreadable one is NOT DATA — it is the absence of a decision Atlas is not entitled
// to make. A successful read returning nothing is still a real answer and still
// defaults; a failure propagates and the caller refuses the request.
async function _strictRead(fn, fallback, label, reads) {
  if (typeof fn !== 'function') return fallback;
  const v = await fn();
  if (v == null) return fallback;
  reads.push(label);
  return v;
}

const EMPTY_PROFILE = Object.freeze({ profile_goal: null, training_level: null, population: null });

/**
 * Hydrate the read-model. Read-only, never throws on a failing reader.
 * Pass `readers` (stubs) in tests; omit it in production to use the Sheets-backed
 * defaults. `asOf` is echoed verbatim (no clock read here — purity).
 */
async function assembleState(params) {
  const { readers, asOf } = params && typeof params === 'object' ? params : {};
  const R = readers && typeof readers === 'object' ? readers : _defaultReaders();

  const reads = [];
  const derived = [];

  const log_history = await _safeRead(R.getLogRows, [], 'log', reads);
  // Strict: an unreadable deload state or constraint set fails the snapshot rather
  // than silently becoming "not deloading" and "no injuries".
  const deload_state = await _strictRead(R.readDeloadState, null, 'deload_state', reads);
  const constraintsRaw = await _strictRead(R.getConstraints, [], 'constraints', reads);
  const profileRaw = await _safeRead(R.getProfile, null, 'profile', reads);
  const profile = profileRaw && typeof profileRaw === 'object'
    ? {
        profile_goal:   profileRaw.profile_goal ?? null,
        training_level: profileRaw.training_level ?? null,
        population:     profileRaw.population ?? null,
      }
    : { ...EMPTY_PROFILE };

  const rows = Array.isArray(log_history) ? log_history : [];

  // Derived keys — computed from log_history, not separately read.
  let memory_snapshot = null;
  let bodyweight_history = null;
  if (rows.length) {
    try { memory_snapshot = buildMemorySnapshot(rows); derived.push('memory_snapshot'); } catch { memory_snapshot = null; }
    try { bodyweight_history = buildBodyweightHistory(rows); derived.push('bodyweight_history'); } catch { bodyweight_history = null; }
  }

  return {
    asOf: asOf ?? null,
    log_history: rows,
    deload_state,
    profile,
    memory_snapshot,
    bodyweight_history,
    equipment_profile: null, // no durable source yet; per-request equipment arrives via the envelope
    // Stored typed rules from the Constraints tab, raw. The constraint_resolver
    // runner (coachRunners) maps + merges them with envelope constraints — this
    // layer only hydrates, it never interprets (Brain purity).
    constraints_active: Array.isArray(constraintsRaw) ? constraintsRaw : [],
    provenance: {
      reads,
      derived,
      state_asOf: asOf ?? null,
    },
  };
}

// Which input keys are KNOWN for the missing-info handshake: state keys present
// in the snapshot ∪ constraint keys provided on the envelope. Bookkeeping only.
function knownKeys(snapshot, envelope) {
  const keys = new Set();
  if (snapshot && typeof snapshot === 'object') {
    if (Array.isArray(snapshot.log_history) && snapshot.log_history.length) keys.add('log_history');
    if (snapshot.deload_state != null) keys.add('deload_state');
    if (snapshot.memory_snapshot != null) keys.add('memory_snapshot');
    if (snapshot.bodyweight_history != null) keys.add('bodyweight_history');
    if (snapshot.equipment_profile != null) keys.add('equipment_profile');
    if (Array.isArray(snapshot.constraints_active) && snapshot.constraints_active.length) keys.add('constraints_active');
    const p = snapshot.profile;
    if (p && typeof p === 'object') {
      if (p.profile_goal != null) keys.add('profile_goal');
      if (p.training_level != null) keys.add('training_level');
      if (p.population != null) keys.add('population');
    }
  }
  const constraints = envelope && typeof envelope === 'object' && envelope.constraints && typeof envelope.constraints === 'object'
    ? envelope.constraints : {};
  for (const k of Object.keys(constraints)) {
    // readiness_inputs / signal are vocabulary keys as-is; the rest are namespaced constraint.*
    if (k === 'readiness_inputs' || k === 'signal') keys.add(k);
    else keys.add(`constraint.${k}`);
  }
  return keys;
}

module.exports = {
  assembleState,
  knownKeys,
  // Exposed so a caller that already holds the log rows (e.g. the index.js hybrid
  // attach) can reuse them: assembleState({ readers: { ...defaultReaders(), getLogRows } }).
  defaultReaders: _defaultReaders,
};
