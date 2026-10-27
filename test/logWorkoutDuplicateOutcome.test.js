'use strict';

// QA-3 — the client-visible contract of POST /api/log-workout's zero-append 200
// lanes, pinned at the route so the review card's proof rule has something true
// to key on.
//
// The server has three lanes that return 200 from this endpoint having appended
// nothing: the test_mode dry-run, the duplicate write_id echo, and the
// all-rows-duplicate partition. QA-3's client fix does NOT change any response
// shape — it consumes these fields:
//   · all-rows-duplicate: duplicate_write + idempotency_status 'completed' +
//     write_authority 'supabase_transaction' + log_rows_written 0 — the shape
//     the client used to waive into a displayed "Saved", now surfaced as
//     already-logged. The zero in log_rows_written is the load-bearing field.
//   · duplicate echo of a genuine save: the SAME shape, except the echoed
//     original response carries its real log_rows_written (> 0) — that echo is
//     the only duplicate the client may treat as that write's own proof.
//   · dry-run: sheet_written false + no_write_confirmed true.
//
// If any of these fields drift, the card's Saved claim drifts with them, so
// they are pinned here at the level that produces them (the stubWorkoutAuthority
// idiom: the real route code against the authority double).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';

const appended = [];

const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = {
  id: sheetsPath, filename: sheetsPath, loaded: true,
  exports: {
    validateConfig: () => {},
    appendRows: async (tab, rows) => {
      appended.push({ tab, rows });
      return { data: { updates: { updatedRows: rows.length, updatedRange: `${tab}!A2:L2` } } };
    },
    getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
    getSheetRows: async () => [],
    getRecentRows: async () => [],
    getHeaderRow: async () => [],
    readRange: async () => [],
    getEffortSessionIds: async () => [],
    getLogCompositeKeys: async () => [],
    deleteRowsByRange: async () => ({}),
    invalidateTabCache: () => {},
    declareRequestRanges: () => {},
    runWithReadContext: (fn) => fn(),
    currentRequestIdentity: () => null,
    logSheetName: 'Log_Cleaned',
    effortSheetName: 'Effort',
    classifySheetsReadError: () => null,
    sheetsReadFailureClass: () => null,
    getSafeSpreadsheetConfig: () => ({ canVerify: false, source: 'GOOGLE_SHEETS_ID' }),
  },
};

// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13).
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();

// One Bench Press set already logged for session QA3-DUP, in logCleanedColumns
// order (date, session_id, exercise, canonical, muscle, lift code, set_number,
// weight, reps, rir, notes, volume).
const SEEDED_BENCH = ['2026-06-26', 'QA3-DUP', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', 1, 225, 5, 2, '', 1125];
const { workoutAuthorityStore } = require('./helpers/stubWorkoutAuthority');
require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({
  seed: { loggedSets: [SEEDED_BENCH] },
});
const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function postLogWorkout(body) {
  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const BENCH_ROW = { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 };

test('QA-3 route: the all-rows-duplicate lane is a completed 200 that proves ZERO rows written', async () => {
  const store = workoutAuthorityStore();
  assert.equal(store.loggedSets.length, 1, 'seed: exactly the one pre-logged set');

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
  assert.equal(body.data.write_authority, 'supabase_transaction');
  assert.equal(body.data.sheet_write, 'skipped_duplicate');
  assert.equal(body.data.sheet_written, false);
  // THE load-bearing field: this 200 appended nothing, and says so.
  assert.equal(body.data.log_rows_written, 0);
  assert.equal(store.loggedSets.length, 1, 'nothing was appended');
  assert.equal(store.calls.saves.length, 0, 'the save transaction never ran');
});

test('QA-3 route: replaying the all-duplicate write_id echoes the same zero — never a rows proof', async () => {
  const { status, body } = await postLogWorkout({
    session_id: 'QA3-DUP',
    date: '2026-06-26',
    write_id: 'qa3-dup-fresh-write-id',
    log_rows: [BENCH_ROW],
  });

  assert.equal(status, 200);
  assert.equal(body.data.duplicate_write, true);
  assert.equal(body.data.idempotency_status, 'completed');
  assert.equal(body.data.log_rows_written, 0, 'an echo of a zero-append write still proves zero rows');
  assert.equal(workoutAuthorityStore().loggedSets.length, 1, 'still nothing appended');
});

test('QA-3 route: a duplicate echo of a genuine save carries the original rows-written proof', async () => {
  const payload = {
    session_id: 'QA3-NEW',
    date: '2026-06-26',
    write_id: 'qa3-echo-write-id',
    log_rows: [BENCH_ROW],
  };
  const first = await postLogWorkout(payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.duplicate_write, false);
  assert.equal(first.body.data.log_rows_written, 1);
  assert.equal(workoutAuthorityStore().loggedSets.length, 2, 'the genuine save appended its row');

  // Lost-response retry of the SAME write_id: the echo is the only response the
  // retried save ever sees, so the rows proof must ride on it.
  const second = await postLogWorkout(payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicate_write, true);
  assert.equal(second.body.data.idempotency_status, 'completed');
  assert.equal(second.body.data.write_authority, 'supabase_transaction');
  assert.equal(second.body.data.sheet_write, 'skipped_duplicate');
  assert.equal(second.body.data.log_rows_written, 1,
    'the echo carries the original write\u2019s rows-written count — the client\u2019s proof for that write');
  assert.equal(workoutAuthorityStore().loggedSets.length, 2, 'the replay appended nothing');
});

test('QA-3 route: the test_mode dry-run is a 200 that positively confirms no write', async () => {
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
  assert.equal(workoutAuthorityStore().loggedSets.length, 2, 'a dry run appends nothing');
});
