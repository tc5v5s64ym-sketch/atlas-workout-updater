// services/deloadState.js
//
// Persisted training-state for the deload system, per docs/DELOAD_SPEC.md
// ("DELOAD STATE": "Atlas must remember it is currently in a deload"). Backed by
// the Deload_State sheet tab — Sheets is Atlas's record, so deload state lives
// there too, never in a database.
//
// APPEND-ONLY. Each state change appends a row; the CURRENT state is the last
// row. This gives a free audit trail (the spec wants the system auditable) and
// avoids in-place cell updates. An empty/absent tab means the lifter has never
// deloaded → the default NORMAL state.
//
// SEPARATE FROM THE WORKOUT TRUST LOOP. These are system-state writes, not
// logged sets: they do not go through preview→approve→write, carry no write_id,
// and never touch Log_Cleaned/Effort. Wired into request handling in a later PR.

const sheets = require('../sheets');
const { deloadStateColumns } = require('../config/columns');
const { STATES, isState } = require('./deloadStateMachine');

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

// Guarantee the tab has a header row before the first data append. The read path
// (sheets.getSheetRows) strips row 0 as a header, so without one the first
// persisted state would be swallowed and the lifter would read back as NORMAL —
// defeating "Atlas must remember it is currently in a deload". A1 empty ⇒ no
// header yet ⇒ write the column names first.
async function ensureHeaderRow() {
  let firstRow = [];
  try {
    const top = await sheets.readRange(`${DELOAD_STATE_TAB}!A1:A1`);
    firstRow = Array.isArray(top) ? top : [];
  } catch {
    firstRow = [];
  }
  const hasHeader = firstRow.length > 0 && Array.isArray(firstRow[0]) && String(firstRow[0][0] || '').trim() !== '';
  if (!hasHeader) {
    await sheets.appendRows(DELOAD_STATE_TAB, [[...deloadStateColumns]]);
  }
}

// Read the lifter's current training state — the last row of Deload_State, or the
// default NORMAL state when the tab is empty/absent.
async function readCurrentDeloadState() {
  const rows = await sheets.getSheetRows(DELOAD_STATE_TAB);
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
  await ensureHeaderRow();
  await sheets.appendRows(DELOAD_STATE_TAB, [stateToRow(record)]);
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
