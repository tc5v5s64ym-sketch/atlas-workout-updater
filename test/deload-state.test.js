const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub sheets.js BEFORE requiring the module under test, so no real Google Sheets
// call can ever happen (mirrors the require.cache injection in api-smoke.test.js).
const sheetsPath = require.resolve('../sheets');
const fakeSheetsState = {
  rows: [],          // current Deload_State rows (data rows only, no header)
  appendCalls: []    // { tabName, rows }
};
const fakeSheets = {
  // Mirrors the real getSheetRows: strips row 0 (header) and returns [] when only
  // a header (or nothing) exists. Tests seed a header row so appends read back.
  getSheetRows: async (tabName) => {
    fakeSheetsState.lastReadTab = tabName;
    if (fakeSheetsState.rows.length <= 1) return [];
    return fakeSheetsState.rows.slice(1).map(r => [...r]);
  },
  // ensureHeaderRow reads A1 to decide whether a header exists.
  readRange: async () => (fakeSheetsState.rows.length ? [fakeSheetsState.rows[0]] : []),
  appendRows: async (tabName, rows) => {
    fakeSheetsState.appendCalls.push({ tabName, rows });
    for (const r of rows) fakeSheetsState.rows.push([...r]);
    return { data: { updates: { updatedRows: rows.length } } };
  }
};
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const {
  DELOAD_STATE_TAB, defaultDeloadState, rowToState, stateToRow,
  readCurrentDeloadState, appendDeloadState
} = require('../services/deloadState');
const { STATES } = require('../services/deloadStateMachine');
const { deloadStateColumns } = require('../config/columns');

// Seed a header row (matching a provisioned tab) so ensureHeaderRow is a no-op
// for the standard tests and appendCalls reflects only data appends. The
// header-provisioning behaviour itself is exercised in its own test below.
beforeEach(() => {
  fakeSheetsState.rows = [[...deloadStateColumns]];
  fakeSheetsState.appendCalls = [];
});

test('appendDeloadState provisions a header row on a truly empty tab so the first state is not swallowed', async () => {
  fakeSheetsState.rows = [];        // no header at all
  fakeSheetsState.appendCalls = [];
  await appendDeloadState({ training_state: STATES.DELOAD_ACTIVE, deload_protocol: 'STRENGTH_DELOAD_V1' });
  // First append is the header, second is the state row.
  assert.equal(fakeSheetsState.appendCalls.length, 2);
  assert.deepEqual(fakeSheetsState.appendCalls[0].rows[0], [...deloadStateColumns]);
  // The state reads back (not stripped away as the header).
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.DELOAD_ACTIVE);
});

/* ===== default state ===== */

test('an empty tab reads as the default NORMAL state', async () => {
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.NORMAL);
  assert.equal(state.deload_protocol, null);
  assert.equal(state.deload_sessions_remaining, 0);
  assert.equal(fakeSheetsState.lastReadTab, DELOAD_STATE_TAB);
});

test('readCurrentDeloadState degrades to NORMAL when the tab read throws (optional/missing tab)', async () => {
  const original = fakeSheets.getSheetRows;
  fakeSheets.getSheetRows = async () => { throw new Error('Unable to parse range: Deload_State'); };
  try {
    const state = await readCurrentDeloadState();
    assert.equal(state.training_state, STATES.NORMAL);
  } finally {
    fakeSheets.getSheetRows = original;
  }
});

test('defaultDeloadState returns a fresh object each call (no shared mutation)', () => {
  const a = defaultDeloadState();
  a.training_state = STATES.DELOAD_ACTIVE;
  assert.equal(defaultDeloadState().training_state, STATES.NORMAL);
});

/* ===== read current = last row ===== */

test('readCurrentDeloadState returns the LAST appended row', async () => {
  await appendDeloadState({ training_state: STATES.RECOVERY_CANDIDATE, deload_reason: 'fatigue rising' });
  await appendDeloadState({
    training_state: STATES.DELOAD_ACTIVE,
    deload_protocol: 'STRENGTH_DELOAD_V1',
    deload_sessions_remaining: 1
  });
  const state = await readCurrentDeloadState();
  assert.equal(state.training_state, STATES.DELOAD_ACTIVE);
  assert.equal(state.deload_protocol, 'STRENGTH_DELOAD_V1');
  assert.equal(state.deload_sessions_remaining, 1);
});

/* ===== append writes to the right tab, in column order, with a timestamp ===== */

test('appendDeloadState writes to Deload_State in column order and stamps updated_at', async () => {
  const record = await appendDeloadState({
    training_state: STATES.DELOAD_ACTIVE,
    deload_protocol: 'POWER_DELOAD_V1',
    deload_reason: 'grinding RIR for weeks',
    deload_start_date: '2026-06-16',
    deload_sessions_remaining: 1,
    deload_exit_criteria: 'return to working weight next session'
  });

  assert.equal(fakeSheetsState.appendCalls.length, 1);
  const { tabName, rows } = fakeSheetsState.appendCalls[0];
  assert.equal(tabName, DELOAD_STATE_TAB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, deloadStateColumns.length);

  // updated_at stamped (ISO) and lands in the first column.
  assert.ok(record.updated_at && !Number.isNaN(Date.parse(record.updated_at)));
  assert.equal(rows[0][deloadStateColumns.indexOf('updated_at')], record.updated_at);
  assert.equal(rows[0][deloadStateColumns.indexOf('training_state')], STATES.DELOAD_ACTIVE);
  assert.equal(rows[0][deloadStateColumns.indexOf('deload_protocol')], 'POWER_DELOAD_V1');
});

test('a caller-supplied updated_at is preserved, not overwritten', async () => {
  const ts = '2026-06-01T00:00:00.000Z';
  const record = await appendDeloadState({ training_state: STATES.NORMAL, updated_at: ts });
  assert.equal(record.updated_at, ts);
});

/* ===== validation: never persist an unknown state ===== */

test('appendDeloadState throws on an unknown training_state', async () => {
  await assert.rejects(
    () => appendDeloadState({ training_state: 'SLEEPING' }),
    /Cannot persist unknown training_state/
  );
  await assert.rejects(() => appendDeloadState({}), /Cannot persist unknown training_state/);
  assert.equal(fakeSheetsState.appendCalls.length, 0); // nothing written on a bad state
});

/* ===== row <-> state normalization ===== */

test('rowToState maps columns, coerces sessions_remaining, and guards bad state', () => {
  const row = ['2026-06-16T00:00:00Z', STATES.DELOAD_ACTIVE, 'STRENGTH_DELOAD_V1', 'reason', '2026-06-16', '2', 'exit'];
  const s = rowToState(row);
  assert.equal(s.training_state, STATES.DELOAD_ACTIVE);
  assert.equal(s.deload_sessions_remaining, 2); // numeric, not the string '2'

  // Empty cells → null; unknown state → NORMAL; non-numeric sessions → 0.
  const sparse = rowToState(['', 'WAT', '', '', '', 'n/a', '']);
  assert.equal(sparse.training_state, STATES.NORMAL);
  assert.equal(sparse.deload_protocol, null);
  assert.equal(sparse.deload_sessions_remaining, 0);
});

test('stateToRow renders null/missing fields as empty cells in column order', () => {
  const row = stateToRow({ training_state: STATES.NORMAL });
  assert.equal(row.length, deloadStateColumns.length);
  assert.equal(row[deloadStateColumns.indexOf('training_state')], STATES.NORMAL);
  assert.equal(row[deloadStateColumns.indexOf('deload_protocol')], ''); // missing → ''
});

test('state survives a stateToRow → rowToState round trip', () => {
  const original = {
    updated_at: '2026-06-16T12:00:00.000Z',
    training_state: STATES.DELOAD_ACTIVE,
    deload_protocol: 'HYPERTROPHY_DELOAD_V1',
    deload_reason: 'multi-lift stall',
    deload_start_date: '2026-06-16',
    deload_sessions_remaining: 1,
    deload_exit_criteria: 'one session then re-evaluate'
  };
  assert.deepEqual(rowToState(stateToRow(original)), original);
});
