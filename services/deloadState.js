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
// logged sets: they do not go through preview→approve→write and never touch
// Log_Cleaned/Effort. Since #1794 they DO carry an optional client write_id
// (idempotency), answer the write-freeze gate, and ride the tight write rate
// limit — the same write discipline as the other write routes. Wired into
// request handling in routes/coachOps.js.

const sheets = require('../sheets');
const { deloadStateColumns } = require('../config/columns');
const { STATES, isState } = require('./deloadStateMachine');
const { isRecognizedProtocol } = require('./deloadProtocols');

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

// A state object is sound only when its protocol and counter can be trusted:
//   - a non-null protocol must name a frozen protocol, exactly; an active
//     deload additionally REQUIRES one (#1771, C-02). An empty / typo /
//     lowercase / numeric / JSON-shaped protocol on an otherwise active deload
//     used to read as "no protocol", and every consumer filled the gap with
//     the full-load prescription. A damaged protocol now fails closed here,
//     at the read, write, and in-memory choke points alike — never silently
//     as "no deload".
//   - sessions_remaining must be a finite non-negative integer (null/undefined
//     means "not specified" and reads as 0). A present-but-garbage counter
//     used to read as 0, which ends the deload after one session and restores
//     full load early — the same defect class, so it fails closed too.
// Throws on any violation; callers let the throw propagate (never a default).
function assertDeloadStateSound(state) {
  const protocol = state.deload_protocol;
  if (protocol !== null && protocol !== undefined && !isRecognizedProtocol(protocol)) {
    throw new Error(
      `Unrecognized Deload_State deload_protocol: ${JSON.stringify(protocol)} (an active deload requires a complete recognized protocol; refusing to evaluate as NORMAL)`
    );
  }
  if (state.training_state === STATES.DELOAD_ACTIVE && (protocol === null || protocol === undefined)) {
    throw new Error(
      'DELOAD_ACTIVE state requires a recognized deload_protocol (got null; refusing to evaluate as NORMAL)'
    );
  }
  const sessionsRaw = state.deload_sessions_remaining;
  const n = sessionsRaw === null || sessionsRaw === undefined ? 0 : Number(sessionsRaw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(
      `Unrecognized Deload_State deload_sessions_remaining: ${JSON.stringify(state.deload_sessions_remaining)} (counter must be a finite non-negative integer; refusing to read it as 0)`
    );
  }
}

// A sheet row (array, in deloadStateColumns order) → a state object.
function rowToState(row) {
  const arr = Array.isArray(row) ? row : [];
  const state = {};
  deloadStateColumns.forEach((col, i) => { state[col] = cell(arr[i]); });

  // sessions_remaining is numeric; a missing/empty cell reads as 0. A present
  // cell is kept as its number (NaN included) so the soundness check below can
  // fail closed on garbage instead of masking it as 0 (#1771, C-02).
  state.deload_sessions_remaining = Number(state.deload_sessions_remaining);
  // training_state must be a real state. An unrecognized cell is DAMAGED persisted
  // data — fail closed (throw) rather than silently reading it as NORMAL: a
  // damaged last row mid-deload would otherwise lift the deload and serve a
  // full-load prescription (Fable B-16, #1734, probe B3-08). This mirrors the
  // write side (appendDeloadState refuses to persist an unknown state): the read
  // side must be equally loud. A missing/empty tab is still "no deload yet" —
  // that case is handled by readCurrentDeloadState before this is reached — but
  // a present row with no recognizable state is corrupt, never a default.
  if (!isState(state.training_state)) {
    throw new Error(
      `Unrecognized Deload_State training_state: ${JSON.stringify(state.training_state)} (last row is damaged; refusing to assume NORMAL)`
    );
  }
  assertDeloadStateSound(state);
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
// default NORMAL state when the tab is empty/absent. Deload_State is an OPTIONAL
// tab (config/sheetContract.js): a tab CONFIRMED missing is "no deload yet", so
// it degrades to NORMAL. Any other read failure is unreadable state — it must
// never authorize a normal-load prescription (#1771, C-02), so it throws and
// the caller fails closed (500 on /api/recommend/next, edit dropped on the
// plan-edit path). Absence is established only by confirmTabMissing (metadata
// read + tab not listed), never inferred from the error wording: the same
// "Unable to parse range" also fires for a malformed range on an existing tab.
// A present last row whose training_state/protocol/counter is unrecognized is
// damaged persisted data, and rowToState fails closed (throws) rather than
// reading it as NORMAL (#1734, probe B3-08; #1771, C-02) — the throw
// propagates from here so no caller can prescribe as if no deload existed.
async function readCurrentDeloadState() {
  let rows;
  try {
    rows = await sheets.getSheetRows(DELOAD_STATE_TAB);
  } catch (error) {
    if (typeof sheets.confirmTabMissing === 'function'
      && await sheets.confirmTabMissing(error, DELOAD_STATE_TAB)) {
      return defaultDeloadState();
    }
    throw error;
  }
  if (!Array.isArray(rows) || rows.length === 0) return defaultDeloadState();
  return rowToState(rows[rows.length - 1]);
}

// Append a new state record. Stamps updated_at (ISO) when absent and validates
// training_state — persisting an unknown state would be a loud bug, not a silent
// NORMAL. The protocol and counter are validated the same way before anything is
// written (not even the header): a damaged protocol or counter must never reach
// the sheet, where the next read would have to fail closed on it (#1771, C-02).
// Returns the normalized record that was written.
async function appendDeloadState(state = {}) {
  if (!isState(state.training_state)) {
    throw new Error(`Cannot persist unknown training_state: ${JSON.stringify(state.training_state)}`);
  }
  const record = {
    ...defaultDeloadState(),
    ...state,
    updated_at: state.updated_at || new Date().toISOString()
  };
  assertDeloadStateSound(record);
  await ensureHeaderRow();
  await sheets.appendRows(DELOAD_STATE_TAB, [stateToRow(record)]);
  return record;
}

module.exports = {
  DELOAD_STATE_TAB,
  assertDeloadStateSound,
  defaultDeloadState,
  rowToState,
  stateToRow,
  readCurrentDeloadState,
  appendDeloadState
};
