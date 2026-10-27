'use strict';

// QA-3 (S3 backport) — the client-visible contract of POST /api/log-workout's
// zero-append 200 lanes, pinned at the route so the review card's proof rule
// has something true to key on.
//
// This is the S3 re-expression of main's test/logWorkoutDuplicateOutcome.test.js
// (PR #1313). That file does not transplant: it boots S4-era authority stubs
// (test/helpers/stubWorkoutAuthority.js, which does not exist on this line)
// and asserts `write_authority === 'supabase_transaction'`, a field S3's
// server never emits. The CONTRACT it pins is true on S3, so the same four
// cases are proven here against this line's own harness family — the real
// Express app with `sheets.js` stubbed in memory (the closeoutSealIntegration
// idiom) — asserting the fields S3 actually emits:
//   · all-rows-duplicate: duplicate_write + all_rows_duplicate +
//     sheet_write 'skipped_duplicate' + original_sheet_write 'success' +
//     idempotency_status 'completed' + log_rows_written 0 — the shape the
//     client used to waive into a displayed "Saved", now surfaced as
//     already-logged. The zero in log_rows_written is the load-bearing field.
//   · duplicate echo of a genuine save: the SAME write_id replayed; the echo
//     spreads the original response, so it carries the original's real
//     log_rows_written (> 0) — the only duplicate the client may treat as
//     that write's own proof.
//   · dry-run: sheet_write 'skipped' + sheet_written false +
//     no_write_confirmed true.
//
// If any of these fields drift, the card's Saved claim drifts with them, so
// they are pinned here at the level that produces them.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resetIdempotencyStore } = require('../services/idempotency');
const { logCleanedColumns, effortColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// The idempotency store persists to disk and rehydrates; keep this file's
// records in its own tmp file so a write_id from another suite (or an
// earlier run of this one) can never replay here as a duplicate.
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-qa3-bp-duplicate-outcome-idempotency.json');

const state = {
  appends: [],           // every appendRows call: { tab, rows }
  logCompositeKeys: [],  // keys the sheet already holds: session||exercise||set
};

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench|bench press'],
];

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    return { data: { updates: { updatedRange: `${tab}!A100:L${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [...state.logCompositeKeys],
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
  state.appends = [];
  state.logCompositeKeys = [];
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

const BENCH_ROW = { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 };
// The composite key getLogCompositeKeys builds for the seeded row:
// session_id‖exercise‖set_number, lowercased (sheets.js).
const SEEDED_BENCH_KEY = 'qa3-dup||bench press||1';

test('QA-3 route (S3): the all-rows-duplicate lane is a completed 200 that proves ZERO rows written', async () => {
  reset();
  // One Bench Press set already logged for session QA3-DUP.
  state.logCompositeKeys = [SEEDED_BENCH_KEY];

  // A re-previewed save: FRESH write_id, stable session_id, every row already
  // logged — the B1 re-save shape, and the QA-3 incident shape.
  const { status, body } = await postLogWorkout({
    session_id: 'QA3-DUP',
    date: '2026-06-26',
    write_id: 'qa3-dup-fresh-write-id',
    log_rows: [BENCH_ROW],
  });

  assert.equal(status, 200);
  assert.equal(body.data.duplicate_write, true);
  assert.equal(body.data.all_rows_duplicate, true);
  assert.equal(body.data.idempotency_status, 'completed');
  assert.equal(body.data.sheet_write, 'skipped_duplicate');
  assert.equal(body.data.original_sheet_write, 'success');
  assert.equal(body.data.sheet_written, false);
  // THE load-bearing field: this 200 appended nothing, and says so.
  assert.equal(body.data.log_rows_written, 0);
  assert.equal(body.data.skipped_duplicates, 1);
  assert.equal(state.appends.length, 0, 'nothing was appended');
});

test('QA-3 route (S3): replaying the all-duplicate write_id echoes the same zero — never a rows proof', async () => {
  reset();
  state.logCompositeKeys = [SEEDED_BENCH_KEY];
  const payload = {
    session_id: 'QA3-DUP',
    date: '2026-06-26',
    write_id: 'qa3-dup-fresh-write-id',
    log_rows: [BENCH_ROW],
  };
  const first = await postLogWorkout(payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.all_rows_duplicate, true);
  assert.equal(first.body.data.log_rows_written, 0);

  const { status, body } = await postLogWorkout(payload);

  assert.equal(status, 200);
  assert.equal(body.data.duplicate_write, true);
  assert.equal(body.data.idempotency_status, 'completed');
  assert.equal(body.data.sheet_write, 'skipped_duplicate');
  assert.equal(body.data.log_rows_written, 0, 'an echo of a zero-append write still proves zero rows');
  assert.equal(state.appends.length, 0, 'still nothing appended');
});

test('QA-3 route (S3): a duplicate echo of a genuine save carries the original rows-written proof', async () => {
  reset();
  const payload = {
    session_id: 'QA3-NEW',
    date: '2026-06-26',
    write_id: 'qa3-echo-write-id',
    log_rows: [BENCH_ROW],
  };
  const first = await postLogWorkout(payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.duplicate_write, false);
  assert.equal(first.body.data.sheet_write, 'success');
  assert.equal(first.body.data.log_rows_written, 1);
  assert.equal(state.appends.length, 1, 'the genuine save appended its row');

  // Lost-response retry of the SAME write_id: the echo is the only response the
  // retried save ever sees, so the rows proof must ride on it.
  const second = await postLogWorkout(payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicate_write, true);
  assert.equal(second.body.data.idempotency_status, 'completed');
  assert.equal(second.body.data.sheet_write, 'skipped_duplicate');
  assert.equal(second.body.data.original_sheet_write, 'success');
  assert.equal(second.body.data.log_rows_written, 1,
    'the echo carries the original write\u2019s rows-written count — the client\u2019s proof for that write');
  assert.equal(state.appends.length, 1, 'the replay appended nothing');
});

test('QA-3 route (S3): the test_mode dry-run is a 200 that positively confirms no write', async () => {
  reset();
  const { status, body } = await postLogWorkout({
    session_id: 'QA3-DRY',
    date: '2026-06-26',
    test_mode: true,
    log_rows: [BENCH_ROW],
  });

  assert.equal(status, 200);
  assert.equal(body.data.test_mode, true);
  assert.equal(body.data.sheet_write, 'skipped');
  assert.equal(body.data.sheet_written, false);
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(state.appends.length, 0, 'a dry run appends nothing');
});
