// services/deloadState.js
//
// Persisted training-state for the deload system, per docs/DELOAD_SPEC.md
// ("DELOAD STATE": "Atlas must remember it is currently in a deload").
//
// SUPABASE IS ITS SOLE AUTHORITY (OWNER CORRECTION 2026-08-13). It was the
// `Deload_State` tab, on the reading that Google Sheets was Atlas's record for
// everything. But deload state is read by `/api/recommend/next` and by the state
// assembler, so it is an input to a PRESCRIPTION — and the owner ruled that no
// prescription input may be a synchronous Google Sheets dependency. No Sheets
// fallback survives, and no cache was added in its place.
//
// APPEND-ONLY. Each state change appends a row; the CURRENT state is the last
// row. This gives a free audit trail (the spec wants the system auditable) and
// avoids in-place cell updates. An empty/absent tab means the lifter has never
// deloaded → the default NORMAL state.
//
// SEPARATE FROM THE WORKOUT TRUST LOOP. These are system-state writes, not
// logged sets: they do not go through preview→approve→write, carry no write_id,
// and never touch Log_Cleaned/Effort. Wired into request handling in a later PR.

const authority = require('./coachingInputsAuthority');
const { deloadStateColumns } = require('../config/columns');
const { STATES, isState } = require('./deloadStateMachine');

// Retained as the concept's NAME, not as a destination. `docs/ATLAS_SYSTEM_AUTHORITY.md`,
// the status document and several diagnostics still label this concept by its
// historical tab, and renaming the label would make the migration harder to read,
// not easier. Nothing dereferences it as a Google Sheets range any more.
const DELOAD_STATE_TAB = process.env.DELOAD_STATE_SHEET_NAME || 'Deload_State';

// The implicit state of a lifter with no Deload_State history: plain NORMAL,
// nothing pending. Returned as a fresh object each call so callers can't mutate
// a shared default.
function defaultDeloadState() {
  return {
    updated_at: null,
    training_state: STATES.NORMAL,
    deload_protocol: null,
    deload_reason: null,
    deload_start_date: null,
    deload_sessions_remaining: 0,
    deload_exit_criteria: null
  };
}

// Coerce a stored cell to a clean value: '' / undefined → null, so an empty cell
// reads as "unset" rather than an empty string.
function cell(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// A sheet row (array, in deloadStateColumns order) → a state object.
function rowToState(row) {
  const arr = Array.isArray(row) ? row : [];
  const state = {};
  deloadStateColumns.forEach((col, i) => { state[col] = cell(arr[i]); });

  // sessions_remaining is numeric; a missing/garbage value reads as 0.
  const n = Number(state.deload_sessions_remaining);
  state.deload_sessions_remaining = Number.isFinite(n) ? n : 0;
  // training_state must be a real state; an unrecognized cell falls back to NORMAL.
  if (!isState(state.training_state)) state.training_state = STATES.NORMAL;
  return state;
}

// A state object → a sheet row (array, in deloadStateColumns order). Null/missing
// fields render as empty cells.
function stateToRow(state) {
  return deloadStateColumns.map(col => {
    const v = state[col];
    return v === undefined || v === null ? '' : v;
  });
}

// THE HEADER-ROW SEED IS GONE. A tab needed one before its first data row, because
// the read path strips row 0 as a header and would otherwise swallow the first
// persisted state — the lifter would read back as NORMAL, defeating "Atlas must
// remember it is currently in a deload". A table has columns, so there is nothing
// to seed and nothing that can be swallowed.

// Read the lifter's current training state — the newest row, or the default NORMAL
// state when there genuinely is no history.
//
// ── AN UNREADABLE AUTHORITY IS NOT "NO DELOAD" ───────────────────────────────
//
// This used to catch every failure and return NORMAL, which was defensible while the
// store was an OPTIONAL Google Sheets tab: absent and unreadable were hard to tell
// apart, and a spurious deload would have cut the athlete's prescription for nothing.
//
// It is indefensible now, and the owner ruled it out (OWNER CORRECTION 2026-08-13).
// Supabase is the sole authority, so the two cases are perfectly distinguishable: a
// successful read returning no rows means the lifter has never deloaded, and a failed
// read means Atlas DOES NOT KNOW. Answering NORMAL on "do not know" silently discards
// an ACTIVE deload and prescribes the athlete's full working load into a week the
// engine had deliberately cut — a different prescription, presented as a normal one.
//
// So an empty read still defaults, and an unreadable one THROWS. Every caller that
// turns this into a prescription refuses that request with a clean service error;
// callers that are telemetry catch it themselves and say so.
async function readCurrentDeloadState() {
  const rows = await authority.deloadStateRows();
  if (!Array.isArray(rows) || rows.length === 0) return defaultDeloadState();
  return rowToState(rows[rows.length - 1]);
}

// Append a new state record. Stamps updated_at (ISO) when absent and validates
// training_state — persisting an unknown state would be a loud bug, not a silent
// NORMAL. Returns the normalized record that was written.
async function appendDeloadState(state = {}) {
  if (!isState(state.training_state)) {
    throw new Error(`Cannot persist unknown training_state: ${JSON.stringify(state.training_state)}`);
  }
  const record = {
    ...defaultDeloadState(),
    ...state,
    updated_at: state.updated_at || new Date().toISOString()
  };
  await authority.appendDeloadState(stateToRow(record));
  return record;
}

module.exports = {
  DELOAD_STATE_TAB,
  defaultDeloadState,
  rowToState,
  stateToRow,
  readCurrentDeloadState,
  appendDeloadState
};
