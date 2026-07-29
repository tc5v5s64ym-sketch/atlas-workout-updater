'use strict';

// #1164 — V1 SAFETY CONTRACT: post-closeout undo is intentionally unsupported and fails closed.
//
// Owner ruling (2026-07-29). The durable reopen/receipt design is deferred out of Phase 4: the
// #952 closeout_status vocabulary stays frozen, no receipt tab is created, and no reopen_pending /
// reopened / crash-resume semantics are built. Instead, a session that has reached a durable
// `finalized` closeout in Session_Plans simply cannot be undone.
//
// WHY THIS IS THE SAFE CONTRACT. `/api/log-workout/undo-last` deletes Log_Cleaned rows and touches
// nothing else — verified: the route body references no Session_Plans, no Session_Plan_Sets, no
// sealCloseout, no closeout_write_id. So an undo after closeout strips the logged sets while
// Session_Plans still asserts `finalized`, and (once the seal lane is enabled) leaves
// closeout_write_id stamped on rows whose sets no longer exist. Session_Plans is an ALREADY-LIVE
// lane, so the falsely-finalized half of that is reachable in production TODAY, with the seal flag
// still 0. Rejecting the undo removes the only way to create the incoherence.
//
// The rejection is deliberately BEFORE any deletion and before any write of any kind: the guard
// answers from a durable read of Session_Plans and then refuses. Nothing is appended, nothing is
// stamped, no historical evidence is touched.
//
// Ordinary undo — a write that has NOT reached a finalized closeout — is unchanged. That is the
// common case and the tests below pin it, so the guard cannot quietly become a blanket ban.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetIdempotencyStore } = require('../services/idempotency');
const { logCleanedColumns, sessionPlansColumns } = require('../config/columns');

const originalConsoleLog = console.log;

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';

const OPEN_SESSION = 'session-open-a';
const FINAL_SESSION = 'session-finalized-a';
const PLAN_VERSION = 'pv_11111111-2222-3333-4444-555555555555';

const P = Object.fromEntries(sessionPlansColumns.map((c, i) => [c, i]));

function planRow({ key, session_id, event_type, closeout_status = '', plan_item_id = '' }) {
  const row = new Array(sessionPlansColumns.length).fill('');
  row[P.idempotency_key] = key;
  row[P.session_id] = session_id;
  row[P.session_date] = '2026-07-29';
  row[P.plan_version] = PLAN_VERSION;
  row[P.event_type] = event_type;
  row[P.plan_item_id] = plan_item_id;
  row[P.closeout_status] = closeout_status;
  row[P.recorded_at] = '2026-07-29T01:00:00.000Z';
  return row;
}

function logRow(session_id) {
  const row = new Array(logCleanedColumns.length).fill('');
  row[0] = '2026-07-29';
  row[1] = session_id;
  row[2] = 'Bench Press';
  row[6] = '1';
  row[7] = '225';
  row[8] = '5';
  row[9] = '2';
  return row;
}

// Two Log_Cleaned rows: sheet row 2 belongs to the OPEN session, row 3 to the FINALIZED one.
const state = {
  logRows: [logRow(OPEN_SESSION), logRow(FINAL_SESSION)],
  planRows: [],
  deletes: [],
  appends: [],
  updates: [],
  failPlanRead: false,
};

function resetState() {
  state.logRows = [logRow(OPEN_SESSION), logRow(FINAL_SESSION)];
  state.planRows = [
    planRow({ key: 'k-accept-final', session_id: FINAL_SESSION, event_type: 'plan_accepted', plan_item_id: 'pi-1' }),
    planRow({ key: 'k-close-final', session_id: FINAL_SESSION, event_type: 'session_closeout', closeout_status: 'finalized' }),
    planRow({ key: 'k-accept-open', session_id: OPEN_SESSION, event_type: 'plan_accepted', plan_item_id: 'pi-1' }),
  ];
  state.deletes = [];
  state.appends = [];
  state.updates = [];
  state.failPlanRead = false;
}
resetState();

const fakeSheets = {
  getSheetRows: async (tabName) => {
    if (tabName === 'Log_Cleaned') return state.logRows.map((r) => [...r]);
    if (tabName === 'Session_Plans') {
      if (state.failPlanRead) throw new Error('Simulated Session_Plans read failure');
      return state.planRows.map((r) => [...r]);
    }
    return [];
  },
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? state.logRows.map((r) => [...r]) : []),
  getHeaderRow: async (tabName) => (tabName === 'Log_Cleaned' ? [...logCleanedColumns] : []),
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort', 'Session_Plans'],
  deleteRowsByRange: async (tab, startIndex, endIndex) => {
    state.deletes.push({ tab, startIndex, endIndex });
    return { data: {} };
  },
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows });
    return { data: { updates: { updatedRange: `${tab}!A2:P2`, updatedRows: rows.length } } };
  },
  updateColumnCells: async (tab, column, cells) => {
    state.updates.push({ tab, column, cells });
    return { data: { totalUpdatedCells: cells.length } };
  },
  readRange: async () => [],
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  validateConfig: () => true,
  getSafeSpreadsheetConfig: () => ({}),
  isTransientAppendError: () => false,
  retryWithBackoff: async (fn) => fn(),
  ensureSheetTab: async () => true,
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};

const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const { app } = require('../index');

let server;
let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
  } finally {
    console.log = originalConsoleLog;
  }
});

test.beforeEach(() => {
  resetIdempotencyStore();
  resetState();
});

async function undo(body) {
  const response = await fetch(`${baseUrl}/api/log-workout/undo-last`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

// Sheet row 3 = the finalized session's row; sheet row 2 = the open session's row.
const FINAL_RANGE = 'Log_Cleaned!A3:L3';
const OPEN_RANGE = 'Log_Cleaned!A2:L2';

function assertNothingTouched(why) {
  assert.equal(state.deletes.length, 0, `${why}: no Log_Cleaned rows may be deleted`);
  assert.equal(state.appends.length, 0, `${why}: no appends to any tab`);
  assert.equal(state.updates.length, 0, `${why}: no cell updates — closeout_write_id is never touched`);
  assert.equal(state.logRows.length, 2, `${why}: the log is unchanged`);
}

// ── the contract ──────────────────────────────────────────────────────────────

test('#1164 a finalized session with NO ledger seal rejects undo (today\'s production shape)', async () => {
  // SESSION_PLAN_SETS_WRITE_ENABLED is 0, so no checkpoint rows and no seal exist — yet
  // Session_Plans still records `finalized`, because it is a separate already-live lane. This is
  // the currently reachable incoherence, and it is the case that matters most.
  const { response, body } = await undo({
    log_appended_range: FINAL_RANGE,
    session_id: FINAL_SESSION,
    rows_to_delete: 1,
    confirm_delete: true,
    write_id: 'w-undo-1',
  });

  assert.equal(response.status, 409);
  assert.equal(body.status, 'error');
  assert.equal(body.details && body.details.error_code, 'finalized_workout_undo_not_supported');
  assertNothingTouched('finalized, no ledger');
});

test('#1164 a finalized session WITH a sealed ledger rejects undo', async () => {
  // Same durable verdict, reached from the same Session_Plans read. The seal's presence must not
  // change the answer — the guard never consults Session_Plan_Sets and never mutates it.
  state.planRows.push(planRow({
    key: 'k-close-final-2', session_id: FINAL_SESSION,
    event_type: 'session_closeout', closeout_status: 'finalized',
  }));

  const { response, body } = await undo({
    log_appended_range: FINAL_RANGE,
    session_id: FINAL_SESSION,
    rows_to_delete: 1,
    confirm_delete: true,
    write_id: 'w-undo-2',
  });

  assert.equal(response.status, 409);
  assert.equal(body.details && body.details.error_code, 'finalized_workout_undo_not_supported');
  assertNothingTouched('finalized, sealed ledger');
});

test('#1164 the rejection explains itself to the athlete', async () => {
  const { body } = await undo({
    log_appended_range: FINAL_RANGE,
    session_id: FINAL_SESSION,
    rows_to_delete: 1,
    confirm_delete: true,
    write_id: 'w-undo-3',
  });
  const message = String(body.message || '');
  assert.ok(message.length > 0, 'a message is present');
  assert.match(message, /closed out|finalized|completed/i, 'names the closed-out state');
  assert.ok(!/undefined|\[object/.test(message), 'no placeholder leakage');
});

test('#1164 a duplicate rejected request stays rejected, and still deletes nothing', async () => {
  const first = await undo({
    log_appended_range: FINAL_RANGE, session_id: FINAL_SESSION,
    rows_to_delete: 1, confirm_delete: true, write_id: 'w-undo-dup',
  });
  assert.equal(first.body.details && first.body.details.error_code, 'finalized_workout_undo_not_supported');

  const second = await undo({
    log_appended_range: FINAL_RANGE, session_id: FINAL_SESSION,
    rows_to_delete: 1, confirm_delete: true, write_id: 'w-undo-dup',
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.body.details && second.body.details.error_code, 'finalized_workout_undo_not_supported',
    'a rejected undo is never converted into a duplicate-success by the idempotency shield');
  assertNothingTouched('duplicate rejection');
});

test('#1164 an unreadable Session_Plans fails CLOSED — undo is refused, not allowed', async () => {
  // The guard cannot prove the session is un-finalized, so it must not proceed. Ambiguity fails
  // closed, exactly as the seal lane's ledger_read_failed does.
  state.failPlanRead = true;

  const { response, body } = await undo({
    log_appended_range: OPEN_RANGE, session_id: OPEN_SESSION,
    rows_to_delete: 1, confirm_delete: true, write_id: 'w-undo-readfail',
  });

  assert.notEqual(response.status, 200, 'an unprovable state never permits a delete');
  assert.equal(body.status, 'error', 'the request does not report success');
  assertNothingTouched('Session_Plans unreadable');
});

// ── the capability that must survive ──────────────────────────────────────────

test('#1164 ordinary pre-finalization undo still works', async () => {
  // The open session has a plan_accepted event but NO session_closeout. Undo must behave exactly
  // as it does today: read-back verified, then delete.
  const { response, body } = await undo({
    log_appended_range: OPEN_RANGE, session_id: OPEN_SESSION,
    rows_to_delete: 1, confirm_delete: true, write_id: 'w-undo-ok',
  });

  assert.equal(response.status, 200, 'a non-finalized write is still undoable');
  assert.equal(body.data ? body.data.rows_deleted : body.rows_deleted, 1);
  assert.equal(state.deletes.length, 1, 'exactly one delete');
  assert.equal(state.appends.length, 0, 'undo still writes nothing anywhere else');
  assert.equal(state.updates.length, 0, 'undo still stamps nothing');
});

test('#1164 a session with no Session_Plans history at all is still undoable', async () => {
  // Branch C of the earlier design: no durable closeout record. Absence of a `finalized` event is
  // not ambiguity — the read SUCCEEDED and found none — so ordinary undo proceeds.
  state.planRows = [];

  const { response } = await undo({
    log_appended_range: OPEN_RANGE, session_id: OPEN_SESSION,
    rows_to_delete: 1, confirm_delete: true, write_id: 'w-undo-nohistory',
  });

  assert.equal(response.status, 200);
  assert.equal(state.deletes.length, 1);
});

test('#1164 an abandoned closeout does not block undo', async () => {
  // `abandoned` is the other frozen #952 status. It means the athlete walked away, not that a
  // sealed record exists — so it must not be swept into the ban.
  state.planRows = [
    planRow({ key: 'k-aband', session_id: OPEN_SESSION, event_type: 'session_closeout', closeout_status: 'abandoned' }),
  ];

  const { response } = await undo({
    log_appended_range: OPEN_RANGE, session_id: OPEN_SESSION,
    rows_to_delete: 1, confirm_delete: true, write_id: 'w-undo-abandoned',
  });

  assert.equal(response.status, 200, 'abandoned is not finalized');
  assert.equal(state.deletes.length, 1);
});

test('#1164 one session being finalized does not block undo for a different session', async () => {
  // The finalized session's event must not leak across session_id boundaries.
  const { response } = await undo({
    log_appended_range: OPEN_RANGE, session_id: OPEN_SESSION,
    rows_to_delete: 1, confirm_delete: true, write_id: 'w-undo-crosstalk',
  });

  assert.equal(response.status, 200, 'the open session is unaffected by the finalized one');
  assert.equal(state.deletes.length, 1);
  assert.equal(state.deletes[0].startIndex, 1, 'deleted the OPEN session row (sheet row 2), not the finalized one');
});
