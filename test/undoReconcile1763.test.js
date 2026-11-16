'use strict';

// #1763 [P1][Astra D03] — VERIFY FIRST: undo commit-then-error retry deletes a
// different row.
//
// The Astra Ultra re-audit (2026-11-14, at 66fec920) captured it: two
// same-session sets 135x8 then 145x8; undo targets set 1; the adapter deletes
// it then throws ECONNRESET. The error claims the Log rows are still present;
// read-back shows only set 2. A same-ID retry then deletes set 2 and returns
// 'Rows deleted'. The Effort side mirrors: 'no rows were deleted' while the
// Effort row is gone. Regression family of #1736.
//
// Invariant to enforce (issue #1763): unknown delete outcomes remain
// unverified until read-back establishes the outcome; a retry must target the
// original row identity, never a shifted position.
//
// Proved here at the live path: real POSTs against the real Express app with
// only `./sheets` faked (require.cache injection, same pattern as the
// verify-first probe), with the fake adapter injecting before/after-commit
// faults at both tables. Each probe asserts the FIXED outcome, so the defect
// probes FAIL at the s3 head until the undo reconciles by row identity.
//
// Variant set (issue acceptance + design-proof Q2): before/after-commit
// timeout/reset/503 at both tables; same-ID and fresh-ID retries (and the
// no-write_id production client path); identical twins; partial undo; receipt
// loss (client loses its receipt; the server record persists); delayed
// deletes; the next same-session row must survive every retry; error text
// must match the read-back state.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { resetIdempotencyStore } = require('../services/idempotency');
const { resetSessionClaims } = require('../services/sessionWriteClaim');
const { logCleanedColumns, effortColumns } = require('../config/columns');

// Isolate this file's receipt store from every other test file running in
// parallel (the default file is shared). Must be set before index.js loads
// the idempotency service.
const idempotencyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-1763-')), 'idempotency.json');
process.env.ATLAS_IDEMPOTENCY_FILE = idempotencyFile;

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';

const SESSION = 'session-1763-a';
const SET1 = { weight: '135', reps: '8' };
const SET2 = { weight: '145', reps: '8' };

function logRow({ weight, reps }) {
  const row = new Array(logCleanedColumns.length).fill('');
  row[0] = '2026-11-16';
  row[1] = SESSION;
  row[2] = 'Bench Press';
  row[6] = '1';
  row[7] = weight;
  row[8] = reps;
  row[9] = '2';
  return row;
}

function effortRow() {
  const row = new Array(effortColumns.length).fill('');
  row[0] = '2026-11-16';
  row[1] = SESSION;
  row[2] = '58';
  return row;
}

const state = {
  logRows: [],
  effortRows: [],
  // Per-tab fault: { tab: { when: 'before'|'after'|'delayed', error } }.
  // 'after'   = the rows ARE removed, then the adapter throws (commit-then-error).
  // 'before'  = the adapter throws without touching the rows.
  // 'delayed' = the adapter throws AND the delete lands on a LATER read-back
  //             (a delete that commits after the error was returned).
  faults: {},
  // One-shot: throw on the Nth getSheetRows('Log_Cleaned') call (1-based),
  // then disarm. Used to fault the post-delete verification read specifically.
  failLogReadNumber: null,
  logReadCount: 0,
  // A delayed delete waiting to land: { tab, startIndex, endIndex, readsRemaining }.
  // It lands when the matching tab has been read that many more times.
  pendingDelete: null,
  deletes: [],
};

function resetState() {
  state.logRows = [logRow(SET1), logRow(SET2)];
  state.effortRows = [effortRow()];
  state.faults = {};
  state.failLogReadNumber = null;
  state.logReadCount = 0;
  state.pendingDelete = null;
  state.deletes = [];
}

function setFault(tab, when, error) {
  state.faults[tab] = { when, error };
}

// Sheets deleteRowsByRange(tab, startIndex, endIndex): 0-based, end exclusive,
// over ALL rows INCLUDING the header (sheet row 2 = index 1). This fixture's
// arrays exclude the header, so the data index is sheetIndex - 1.
function applyDelete(tab, startIndex, endIndex) {
  const rows = tab === 'Log_Cleaned' ? state.logRows : state.effortRows;
  rows.splice(startIndex - 1, endIndex - startIndex);
}

function maybeLandPendingDelete(tabName) {
  const p = state.pendingDelete;
  if (!p || p.tab !== tabName) return;
  p.readsRemaining -= 1;
  if (p.readsRemaining <= 0) {
    state.pendingDelete = null;
    applyDelete(p.tab, p.startIndex, p.endIndex);
  }
}

const fakeSheets = {
  getSheetRows: async (tabName) => {
    if (tabName === 'Log_Cleaned') {
      state.logReadCount += 1;
      if (state.failLogReadNumber !== null && state.logReadCount === state.failLogReadNumber) {
        state.failLogReadNumber = null;
        throw new Error('Simulated read-back failure');
      }
    }
    // A delayed delete lands once the sheet has been read enough times.
    maybeLandPendingDelete(tabName);
    if (tabName === 'Log_Cleaned') return state.logRows.map((r) => [...r]);
    if (tabName === 'Effort') return state.effortRows.map((r) => [...r]);
    if (tabName === 'Session_Plans') return [];
    return [];
  },
  getRecentRows: async (tabName) => (tabName === 'Log_Cleaned' ? state.logRows.map((r) => [...r]) : []),
  getHeaderRow: async (tabName) => (tabName === 'Log_Cleaned' ? [...logCleanedColumns] : []),
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort', 'Session_Plans'],
  deleteRowsByRange: async (tab, startIndex, endIndex) => {
    state.deletes.push({ tab, startIndex, endIndex });
    const f = state.faults[tab];
    if (f && f.when === 'before') {
      throw new Error(`Simulated ${f.error} before ${tab} delete commit`);
    }
    if (f && f.when === 'delayed') {
      // The error returns first; the delete lands two Log reads later —
      // after the catch's reconciliation read, before the retry's read.
      state.pendingDelete = { tab, startIndex, endIndex, readsRemaining: 2 };
      throw new Error(`Simulated ${f.error} with delayed ${tab} delete commit`);
    }
    applyDelete(tab, startIndex, endIndex);
    if (f && f.when === 'after') {
      throw new Error(`Simulated ${f.error} after ${tab} delete commit`);
    }
    return { data: {} };
  },
  appendRows: async () => { throw new Error('no appends on the undo path'); },
  updateColumnCells: async () => { throw new Error('no updates on the undo path'); },
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
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

test.beforeEach(() => {
  resetIdempotencyStore();
  resetSessionClaims();
  resetState();
});

const RANGE_SET1 = 'Log_Cleaned!A2:L2';
const RANGE_BOTH = 'Log_Cleaned!A2:L3';

async function undo(writeId, range = RANGE_SET1, rowsToDelete = 1) {
  const payload = {
    log_appended_range: range,
    session_id: SESSION,
    rows_to_delete: rowsToDelete,
    confirm_delete: true,
  };
  if (writeId !== undefined) payload.write_id = writeId;
  const response = await fetch(`${baseUrl}/api/log-workout/undo-last`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

function snapshot() {
  return {
    log: state.logRows.map((r) => `${r[7]}x${r[8]}`),
    effort: state.effortRows.length,
  };
}

function logDeletes() {
  return state.deletes.filter((d) => d.tab === 'Log_Cleaned').length;
}

// ── P1: Log after-commit ECONNRESET (the filed defect) ───────────────────────
// The delete commits, then the adapter throws. Read-back establishes the undo
// landed, so the first attempt itself answers the verified success — and a
// same-ID retry must reconcile to the same success without deleting again.

test('#1763 P1 Log after-commit ECONNRESET: first attempt reconciles to success, retry deletes nothing', async () => {
  setFault('Log_Cleaned', 'after', 'ECONNRESET');
  const first = await undo('w-p1');
  const afterFirst = snapshot();
  assert.equal(first.status, 200, 'the committed undo is a verified success, not a 500');
  assert.equal(afterFirst.log.join(','), '145x8', 'set 1 is gone; only set 2 remains');
  assert.equal(afterFirst.effort, 0, 'Effort row is gone');
  assert.equal(first.body.data.rows_deleted, 1);

  state.faults = {};
  const retry = await undo('w-p1');
  const afterRetry = snapshot();
  assert.equal(retry.status, 200, 'same-ID retry reconciles to the completed undo');
  assert.equal(afterRetry.log.join(','), '145x8', 'set 2 survives the retry');
  assert.equal(logDeletes(), 1, 'no second Log delete ran');
  assert.equal(retry.body.data.duplicate_write, true, 'the retry replays as a duplicate');
});

// ── P2: Log before-commit timeout (control: must heal) ───────────────────────
// The Effort delete commits, then the Log delete throws before committing.
// The first attempt reports the verified partial state; the retry finishes it.

test('#1763 P2 Log before-commit timeout: same-ID retry heals', async () => {
  setFault('Log_Cleaned', 'before', 'timeout');
  const first = await undo('w-p2');
  assert.equal(first.status, 500, 'first attempt errors');
  assert.equal(snapshot().log.join(','), '135x8,145x8', 'nothing was deleted by the first attempt');
  assert.equal(snapshot().effort, 0, 'the Effort delete did commit before the Log failure');
  assert.ok(/effort/i.test(String(first.body.message)), 'error text names the Effort row state');
  assert.match(String(first.body.message), /log rows are still present/i,
    'the verified partial state is stated: Effort gone, Log rows still present');

  state.faults = {};
  const retry = await undo('w-p2');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(snapshot().log.join(','), '145x8', 'retry deletes only set 1; set 2 survives');
  assert.equal(snapshot().effort, 0, 'Effort row deleted by the first attempt, not re-deleted');
});

// ── P3: Effort after-commit ECONNRESET (mirror defect) ───────────────────────

test('#1763 P3 Effort after-commit ECONNRESET: error text truthful, same-ID retry completes Log-only', async () => {
  setFault('Effort', 'after', 'ECONNRESET');
  const first = await undo('w-p3');
  const afterFirst = snapshot();
  assert.equal(first.status, 500, 'first attempt errors');
  assert.equal(afterFirst.effort, 0, 'the Effort row IS gone after the first attempt');
  assert.ok(!/no rows were deleted/i.test(String(first.body.message)), 'error text must not claim no rows were deleted');
  assert.ok(/effort/i.test(String(first.body.message)), 'error text names the Effort row state');

  state.faults = {};
  const retry = await undo('w-p3');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(snapshot().log.join(','), '145x8', 'retry deletes only set 1; set 2 survives');
  assert.equal(snapshot().effort, 0);
});

// ── P4: Effort before-commit timeout (control: must heal) ────────────────────

test('#1763 P4 Effort before-commit timeout: same-ID retry heals', async () => {
  setFault('Effort', 'before', 'timeout');
  const first = await undo('w-p4');
  assert.equal(first.status, 500, 'first attempt errors');
  assert.equal(snapshot().effort, 1, 'Effort row still present after the first attempt');

  state.faults = {};
  const retry = await undo('w-p4');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(snapshot().log.join(','), '145x8', 'retry deletes only set 1; set 2 survives');
  assert.equal(snapshot().effort, 0, 'Effort row deleted by the retry');
});

// ── Fresh write_id retries ───────────────────────────────────────────────────

test('#1763 P1-fresh Log after-commit ECONNRESET: a FRESH write_id retry must not delete set 2', async () => {
  setFault('Log_Cleaned', 'after', 'ECONNRESET');
  const first = await undo('w-p1f');
  assert.equal(first.status, 200, 'the committed undo is a verified success');
  assert.equal(snapshot().log.join(','), '145x8', 'set 1 is already gone after the first attempt');

  state.faults = {};
  const retry = await undo('w-p1f-retry');
  assert.equal(retry.status, 200, 'fresh-ID retry reconciles to the completed undo');
  assert.equal(snapshot().log.join(','), '145x8', 'set 2 survives the fresh-ID retry');
  assert.equal(logDeletes(), 1, 'no second Log delete ran');
});

test('#1763 P3-fresh Effort after-commit ECONNRESET: a FRESH write_id retry completes Log-only', async () => {
  setFault('Effort', 'after', 'ECONNRESET');
  const first = await undo('w-p3f');
  assert.equal(first.status, 500, 'first attempt errors');
  assert.equal(snapshot().effort, 0, 'the Effort row IS gone after the first attempt');

  state.faults = {};
  const retry = await undo('w-p3f-retry');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(snapshot().log.join(','), '145x8', 'retry deletes only set 1; set 2 survives');
  assert.equal(snapshot().effort, 0);
});

// ── The production client path: no write_id at all ───────────────────────────

test('#1763 no-write_id client: Log after-commit + retry without write_id must not delete set 2', async () => {
  setFault('Log_Cleaned', 'after', 'ECONNRESET');
  const first = await undo(undefined);
  assert.equal(first.status, 200, 'the committed undo is a verified success');
  assert.equal(snapshot().log.join(','), '145x8', 'set 1 is already gone after the first attempt');

  state.faults = {};
  const retry = await undo(undefined);
  assert.equal(retry.status, 200, 'retry reconciles to the completed undo');
  assert.equal(snapshot().log.join(','), '145x8', 'set 2 survives the retry');
  assert.equal(logDeletes(), 1, 'no second Log delete ran');
});

test('#1763 no-write_id client: ordinary undo still works and deletes exactly the target', async () => {
  const first = await undo(undefined);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(snapshot().log.join(','), '145x8', 'only set 1 deleted; set 2 survives');
  assert.equal(snapshot().effort, 0, 'Effort row deleted');
  assert.equal(logDeletes(), 1, 'exactly one Log delete');
});

// ── Identical twins ──────────────────────────────────────────────────────────

test('#1763 identical twins: undo refuses when the target content also exists outside the range', async () => {
  // A twin of set 1 sits below it: the target fingerprint matches a row the
  // undo must not touch, so no positional delete can tell them apart.
  state.logRows = [logRow(SET1), logRow(SET2), logRow(SET1)];
  const res = await undo('w-twins');
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(String(res.body.message || ''), /ambiguous|identical|twin/i, 'refusal names the ambiguity');
  assert.equal(snapshot().log.join(','), '135x8,145x8,135x8', 'nothing was deleted');
  assert.equal(state.deletes.length, 0, 'no delete ran');
});

// ── Partial undo over a multi-row range ──────────────────────────────────────

test('#1763 partial undo: Effort committed, Log untouched, retry completes the whole range', async () => {
  setFault('Effort', 'after', 'ECONNRESET');
  const first = await undo('w-partial', RANGE_BOTH, 2);
  assert.equal(first.status, 500, 'first attempt errors');
  assert.equal(snapshot().effort, 0, 'Effort row committed by the first attempt');
  assert.equal(snapshot().log.join(','), '135x8,145x8', 'Log rows untouched by the first attempt');
  assert.ok(/effort/i.test(String(first.body.message)), 'error text names the Effort row state');

  state.faults = {};
  const retry = await undo('w-partial', RANGE_BOTH, 2);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(snapshot().log.join(','), '', 'retry deletes both targeted sets');
  assert.equal(snapshot().effort, 0);
});

// ── Delayed deletes ──────────────────────────────────────────────────────────

test('#1763 delayed delete: a Log delete that lands after the error is caught by reconciliation', async () => {
  setFault('Log_Cleaned', 'delayed', 'timeout');
  const first = await undo('w-delayed');
  assert.equal(first.status, 500, 'first attempt errors while the outcome is unknown');
  assert.ok(!/rows deleted/i.test(String(first.body.message)) || /unverified|unknown|not verified/i.test(String(first.body.message)),
    'a 500 must not read as a success');
  assert.equal(snapshot().effort, 0, 'the Effort delete committed before the Log failure');

  state.faults = {};
  const retry = await undo('w-delayed');
  assert.equal(retry.status, 200, 'retry reconciles to the completed undo');
  assert.equal(snapshot().log.join(','), '145x8', 'set 2 survives the retry');
  assert.equal(logDeletes(), 1, 'no second Log delete ran');
});

// ── 503 variant ──────────────────────────────────────────────────────────────

test('#1763 503 variant: Log after-commit 503 behaves like the ECONNRESET case', async () => {
  setFault('Log_Cleaned', 'after', '503');
  const first = await undo('w-503');
  assert.equal(first.status, 200, 'the committed undo is a verified success');
  assert.equal(snapshot().log.join(','), '145x8', 'set 1 is already gone after the first attempt');

  state.faults = {};
  const retry = await undo('w-503');
  assert.equal(retry.status, 200, 'retry reconciles to the completed undo');
  assert.equal(snapshot().log.join(','), '145x8', 'set 2 survives the retry');
  assert.equal(logDeletes(), 1, 'no second Log delete ran');
});

// ── Verification-read failure after a successful delete ──────────────────────

test('#1763 post-delete verification read failure: no success is claimed, retry reconciles', async () => {
  // The deletes land, then the post-delete verification read throws: the route
  // must answer unverified (500), never success — and the retry must reconcile
  // to completed without deleting again. The route reads Log_Cleaned twice on
  // the happy path (pre-delete verification, post-delete verification), so the
  // fault fires on the second Log read.
  state.failLogReadNumber = 2;
  const first = await undo('w-verifyfail');
  assert.equal(first.status, 500, 'no success is claimed when verification cannot run');
  assert.equal(snapshot().log.join(','), '145x8', 'the delete itself landed');
  assert.ok(!/rows deleted/i.test(String(first.body.message)) || /unverified|unknown|not verified/i.test(String(first.body.message)),
    'a 500 must not read as a success');

  const retry = await undo('w-verifyfail');
  assert.equal(retry.status, 200, 'retry reconciles to the completed undo');
  assert.equal(snapshot().log.join(','), '145x8', 'set 2 survives the retry');
  assert.equal(logDeletes(), 1, 'no second Log delete ran');
});

// ── Receipt loss (client-side) ───────────────────────────────────────────────

test('#1763 receipt loss: client loses its receipt and retries with a fresh write_id', async () => {
  // The first attempt is the no-write_id production client: the server derives
  // the receipt from (session_id, range). The client never sees a receipt it
  // can reuse, so the retry arrives with a fresh explicit write_id. The
  // server-side prior record must still reconcile it — the retry completes
  // Log-only and never touches set 2.
  setFault('Effort', 'after', 'ECONNRESET');
  const first = await undo(undefined);
  assert.equal(first.status, 500, 'first attempt errors');
  assert.equal(snapshot().effort, 0, 'the Effort row IS gone after the first attempt');

  state.faults = {};
  const retry = await undo('w-lost-retry');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(snapshot().log.join(','), '145x8', 'retry deletes only set 1; set 2 survives');
  assert.equal(snapshot().effort, 0);
});

// ── Re-save generation (derived write_id) ────────────────────────────────────

test('#1763 re-save generation: undo after an undo + re-save deletes the NEW rows, not the old', async () => {
  // Undo completes for the first write (no write_id: the production client).
  const first = await undo(undefined);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(snapshot().log.join(','), '145x8', 'first undo removed set 1 only');

  // The athlete re-saves the same session: a new set lands at the same range
  // and a fresh Effort row is created. The next undo targets the NEW write.
  state.logRows = [logRow({ weight: '150', reps: '5' }), logRow(SET2)];
  state.effortRows = [effortRow()];
  const second = await undo(undefined);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(snapshot().log.join(','), '145x8', 'the re-saved set is undone; the older set survives');
  assert.equal(snapshot().effort, 0, 'the re-saved Effort row is removed');
});
