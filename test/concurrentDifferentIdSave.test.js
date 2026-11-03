'use strict';

// #1629 — overlapping saves with different write_ids must not both append.
//
// Reproduced 2026-10-29 at the deployed head: two CONCURRENT typed saves of
// the same session content carrying DIFFERENT write_ids both returned success
// and both appended — 4 Log rows for 2 intended. Sequential different-id
// submits dedupe correctly (all_rows_duplicate) and same-id concurrent
// submits are stopped (409 in-progress); the hole is only the overlapping
// window across different write identities, because beginWrite is keyed on
// write_id only and the read-check-append sequence awaits between its read
// and its append.
//
// Contract pinned here (the issue's acceptance), at the route with the real
// Express app and sheets.js stubbed in memory (the closeoutSealIntegration /
// QA-3 idiom). The fake sheet is faithful in one load-bearing way: an append
// is visible to later reads, so a retry after the winner lands sees the rows.
//   · Two concurrent different-id saves of the same session (Log rows
//     only): exactly one appends (2 Log rows for 2 intended). The loser
//     gets the truthful already-logged verdict in-band (200,
//     duplicate_write, all_rows_duplicate, log_rows_written 0) — not a
//     second copy and not a bare in-progress refusal the client must retry
//     to learn the truth.
//   · A later fresh-id save of the same content is all_rows_duplicate with
//     no new appends.
//   · The same race WITH an effort row: still exactly one Log append and
//     one Effort append (safety property; the effort-bearing loser's verdict
//     shape follows the route's existing Effort session guard).
//   · Two concurrent saves of DIFFERENT sessions do not block each other:
//     the claim is session-scoped, not global.
//
// Failing-first: on the pre-fix tree this file's race test fails twice over
// (4 Log rows instead of 2, and the loser reports a genuine success).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resetIdempotencyStore } = require('../services/idempotency');
const { resetSessionClaims } = require('../services/sessionWriteClaim');
const { logCleanedColumns, effortColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// Keep this file's idempotency records in their own tmp file so a write_id
// from another suite can never replay here as a duplicate.
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1629-concurrent-idempotency.json');

const state = {
  appends: [],            // every appendRows call: { tab, rows }
  logCompositeKeys: [],   // keys the sheet already holds: session||exercise||set
  effortSessionIds: [],   // session_ids the Effort tab already holds
};

// The race reproduces only if both concurrent reads resolve together, before
// either append lands. With all-immediate fakes the two requests serialize
// completely (a chain of resolved promises never yields to the I/O phase, so
// the second request is not even read from the socket until the first
// finishes) and the race never fires. Real Sheets reads take real I/O time,
// so both requests are in flight together. This barrier is the deterministic
// equivalent: concurrent reads resolve as a group with the same pre-append
// snapshot; a lone read resolves after a short timeout with the live state.
let readWaiters = [];
let readTimer = null;
function barrieredRead(snapshot) {
  return new Promise(resolve => {
    readWaiters.push(() => resolve(snapshot));
    if (readWaiters.length >= 2) {
      const waiters = readWaiters;
      readWaiters = [];
      if (readTimer) { clearTimeout(readTimer); readTimer = null; }
      waiters.forEach(fn => fn());
    } else if (!readTimer) {
      readTimer = setTimeout(() => {
        const waiters = readWaiters;
        readWaiters = [];
        readTimer = null;
        waiters.forEach(fn => fn());
      }, 50);
    }
  });
}

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench|bench press'],
];

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    // A real sheet shows an append to later reads. Mirror that, or the
    // post-race retry could never observe the winner's rows.
    if (tab === 'Log_Cleaned') {
      for (const row of rows) {
        const key = `${row[1]}||${row[2]}||${row[6]}`.toLowerCase();
        if (!state.logCompositeKeys.includes(key)) state.logCompositeKeys.push(key);
      }
    }
    if (tab === 'Effort') {
      for (const row of rows) {
        if (row[1] && !state.effortSessionIds.includes(String(row[1]))) {
          state.effortSessionIds.push(String(row[1]));
        }
      }
    }
    return { data: { updates: { updatedRange: `${tab}!A100:L${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => barrieredRead([...state.effortSessionIds]),
  getLogCompositeKeys: async () => barrieredRead([...state.logCompositeKeys]),
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getHeaderRow: async tab => {
    if (tab === 'Log_Cleaned') return [...logCleanedColumns];
    if (tab === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => [
    'Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Constraints', 'Deload_State', 'Session_Plans', 'Session_Plan_Sets'
  ],
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort'
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const { app } = require('../index');

function reset() {
  resetIdempotencyStore();
  resetSessionClaims();
  state.appends = [];
  state.logCompositeKeys = [];
  state.effortSessionIds = [];
  readWaiters = [];
  if (readTimer) { clearTimeout(readTimer); readTimer = null; }
}

let server;
let baseUrl;
const originalConsoleLog = console.log;

test.before(async () => {
  console.log = () => {};
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

async function postLogWorkout(body) {
  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const BENCH_ROWS = [
  { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 },
  { exercise: 'Bench Press', set_number: 2, weight: 235, reps: 5, rir: 2 },
];
// Effort row in Effort column order: date, session_id, duration,
// active_calories, total_calories, average_hr, peak_hr, location, notes.
// session_id is overridden to the canonical session by formatEffortRow.
const EFFORT_ROW = ['2026-06-26', 'placeholder', 45, 300, 400, 120, 150, 'Home', ''];

function logRowsAppended() {
  return state.appends
    .filter(a => a.tab === 'Log_Cleaned')
    .reduce((n, a) => n + a.rows.length, 0);
}

function effortRowsAppended() {
  return state.appends
    .filter(a => a.tab === 'Effort')
    .reduce((n, a) => n + a.rows.length, 0);
}

test('#1629: two concurrent different-id saves of one session append exactly once; the loser gets the already-logged verdict', async () => {
  reset();
  const base = {
    session_id: '1629-RACE',
    date: '2026-06-26',
    log_rows: BENCH_ROWS,
  };
  const [first, second] = await Promise.all([
    postLogWorkout({ ...base, write_id: '1629-race-write-a' }),
    postLogWorkout({ ...base, write_id: '1629-race-write-b' }),
  ]);

  // The hole, stated as a count: 2 intended rows, never 4.
  assert.equal(logRowsAppended(), 2, `expected 2 Log rows appended, got ${logRowsAppended()}`);

  const responses = [first, second];
  const winners = responses.filter(r => r.body.data && r.body.data.sheet_write === 'success');
  const losers = responses.filter(r => r.body.data && r.body.data.all_rows_duplicate === true);
  assert.equal(winners.length, 1, 'exactly one save reports a genuine success');
  assert.equal(winners[0].status, 200);
  assert.equal(winners[0].body.data.log_rows_written, 2);
  assert.equal(losers.length, 1, 'the other save reports the already-logged verdict');
  assert.equal(losers[0].status, 200);
  assert.equal(losers[0].body.data.duplicate_write, true);
  assert.equal(losers[0].body.data.sheet_write, 'skipped_duplicate');
  assert.equal(losers[0].body.data.log_rows_written, 0);

  // A later fresh-id save of the same content is still a clean duplicate.
  const retry = await postLogWorkout({ ...base, write_id: '1629-race-write-c' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.all_rows_duplicate, true);
  assert.equal(retry.body.data.log_rows_written, 0);
  assert.equal(logRowsAppended(), 2, 'the retry appended nothing');
});

test('#1629: two concurrent different-id saves WITH an effort row still append exactly once', async () => {
  reset();
  const base = {
    session_id: '1629-RACE-EFFORT',
    date: '2026-06-26',
    log_rows: BENCH_ROWS,
    effort_row: EFFORT_ROW,
  };
  const [first, second] = await Promise.all([
    postLogWorkout({ ...base, write_id: '1629-race-effort-write-a' }),
    postLogWorkout({ ...base, write_id: '1629-race-effort-write-b' }),
  ]);

  // Safety property, not verdict shape: the effort-bearing loser is refused
  // by the Effort session guard (409) or reports the duplicate verdict —
  // either way it must not append. The verdict shape for this lane is the
  // route's existing guard behavior, not #1629's new contract.
  assert.equal(logRowsAppended(), 2, `expected 2 Log rows appended, got ${logRowsAppended()}`);
  assert.equal(effortRowsAppended(), 1, `expected 1 Effort row appended, got ${effortRowsAppended()}`);
  const winners = [first, second].filter(r => r.body.data && r.body.data.sheet_write === 'success');
  assert.equal(winners.length, 1, 'exactly one save reports a genuine success');
});

test('#1629 control: sequential different-id saves still dedupe (no regression)', async () => {
  reset();
  const base = {
    session_id: '1629-SEQ',
    date: '2026-06-26',
    log_rows: BENCH_ROWS,
  };
  const first = await postLogWorkout({ ...base, write_id: '1629-seq-write-a' });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.sheet_write, 'success');
  assert.equal(logRowsAppended(), 2);

  const second = await postLogWorkout({ ...base, write_id: '1629-seq-write-b' });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.all_rows_duplicate, true);
  assert.equal(second.body.data.log_rows_written, 0);
  assert.equal(logRowsAppended(), 2, 'the sequential retry appended nothing');
});

test('#1629 scope: two concurrent saves of DIFFERENT sessions do not block each other', async () => {
  reset();
  const base = {
    date: '2026-06-26',
    log_rows: BENCH_ROWS,
  };
  const [first, second] = await Promise.all([
    postLogWorkout({ ...base, session_id: '1629-SCOPE-A', write_id: '1629-scope-write-a' }),
    postLogWorkout({ ...base, session_id: '1629-SCOPE-B', write_id: '1629-scope-write-b' }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.sheet_write, 'success');
  assert.equal(second.status, 200);
  assert.equal(second.body.data.sheet_write, 'success');
  assert.equal(logRowsAppended(), 4, 'both sessions appended their own rows');
});
