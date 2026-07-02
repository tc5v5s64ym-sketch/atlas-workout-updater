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
    const { getSheetRows }            = require('./sheets');
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
      // Stored typed constraints (the optional Constraints tab). A missing tab or
      // read failure degrades to [] via _safeRead — never blocks the snapshot.
      getConstraints: () => getSheetRows('Constraints'),
    };
  } catch {
    // Reader layer unavailable (e.g. Sheets client cannot load) → degrade to an
    // empty snapshot rather than throw. A coaching-read outage must never 500 or
    // interrupt the write path (Constitution). provenance.reads stays empty.
    return {};
  }
}

// Run a reader safely: never throws, records success in `reads`, returns the
// fallback on absence/empty/error so a Sheets outage degrades gracefully.
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
  const deload_state = await _safeRead(R.readDeloadState, null, 'deload_state', reads);
  const constraintsRaw = await _safeRead(R.getConstraints, [], 'constraints', reads);
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
