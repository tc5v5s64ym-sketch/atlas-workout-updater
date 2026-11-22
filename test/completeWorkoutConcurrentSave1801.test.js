'use strict';

// #1801 — VERIFY FIRST: /api/complete-workout takes no session claim.
//
// The issue (filed 2026-11-20 from Hammy's #1792-adjacent finding): the
// session-scoped claim (services/sessionWriteClaim.js, #1629) serializes
// /api/log-workout only — its own header says other routes that append to
// the same tabs (e.g. /api/complete-workout) are out of scope, and the
// complete-workout handler (index.js, /api/complete-workout) never calls
// acquireSessionClaim. beginWrite is keyed on write_id only, so two
// overlapping saves carrying DIFFERENT write_ids are both admitted and
// both run read-check-allocate-append against the same pre-append snapshot.
//
// Contract pinned here (the issue's verify-first acceptance), at the route
// with the real Express app and sheets.js stubbed in memory (the #1629
// idiom). The fake sheet is faithful in the load-bearing ways: an append
// is visible to later reads, and concurrent reads resolve as a group with
// the same pre-append snapshot (the deterministic equivalent of real
// Sheets I/O time — see the barrier below).
//   · Two concurrent different-id complete-workout calls for the SAME
//     session (client-supplied session_id, same rows + effort): exactly
//     one appends (2 Log rows, 1 Effort row). The loser gets a truthful
//     duplicate verdict, not a second copy.
//   · Two concurrent different-id complete-workout calls for TWO sessions
//     on the SAME date (server-minted ids): the two saves mint DIFFERENT
//     session ids — the workouts must not collapse onto one identity.
//   · Control: sequential different-id saves of the same session dedupe
//     (the second is refused as a duplicate with no new appends).
//
// Failing-first: on the s3-maintenance head (68b61607) this file's race
// tests fail — the same-session race appends 4 Log rows + 2 Effort rows
// with both calls reporting success, and the same-date race mints one
// session id for two distinct workouts.

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
// Keep this file's idempotency records in their own tmp file so a write_id
// from another suite can never replay here as a duplicate.
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1801-complete-workout-idempotency.json');

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
// equivalent, one per read function: concurrent reads resolve as a group
// with the same pre-append snapshot; a lone read resolves after a short
// timeout with the live state.
function makeBarrier() {
  let waiters = [];
  let timer = null;
  return function barrieredRead(snapshot) {
    return new Promise(resolve => {
      waiters.push(() => resolve(snapshot));
      if (waiters.length >= 2) {
        const ready = waiters;
        waiters = [];
        if (timer) { clearTimeout(timer); timer = null; }
        ready.forEach(fn => fn());
      } else if (!timer) {
        timer = setTimeout(() => {
          const ready = waiters;
          waiters = [];
          timer = null;
          ready.forEach(fn => fn());
        }, 50);
      }
    });
  };
}
let effortBarrier = makeBarrier();
let logKeysBarrier = makeBarrier();

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench|bench press'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'squat|back squat'],
];

// #1762 refix: the Sheets append response reports the ACTUAL updated range,
// so its end column is the submitted rows' width. A fixed end column (the old
// :L) is a receipt the append-proof verdict now rightly refuses.
function endColumnFor(rows) {
  const width = Math.max(0, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  let letters = '';
  let n = width;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters || 'A';
}

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
    return { data: { updates: { updatedRange: `${tab}!A100:${endColumnFor(rows)}${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => effortBarrier([...state.effortSessionIds]),
  getLogCompositeKeys: async () => logKeysBarrier([...state.logCompositeKeys]),
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
  state.effortSessionIds = [];
  effortBarrier = makeBarrier();
  logKeysBarrier = makeBarrier();
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

const DATE = '2026-06-26';

function effortJson(sessionId, date) {
  return JSON.stringify({
    date: date || DATE,
    session_id: sessionId || '',
    duration: '00:45:00',
    active_calories: 300,
    total_calories: 400,
    average_hr: 120,
    peak_hr: 150,
    location: 'Home',
    notes: '',
  });
}

async function postCompleteWorkout(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${baseUrl}/api/complete-workout`, {
    method: 'POST',
    headers: { 'x-atlas-api-key': 'test-api-key' },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

const BENCH_ROWS = [
  { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 },
  { exercise: 'Bench Press', set_number: 2, weight: 235, reps: 5, rir: 2 },
];
const SQUAT_ROWS = [
  { exercise: 'Back Squat', set_number: 1, weight: 315, reps: 5, rir: 2 },
  { exercise: 'Back Squat', set_number: 2, weight: 325, reps: 5, rir: 2 },
];

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

function effortSessionIdsAppended() {
  return state.appends
    .filter(a => a.tab === 'Effort')
    .flatMap(a => a.rows.map(r => String(r[1])));
}

function logSessionIdsAppended() {
  return state.appends
    .filter(a => a.tab === 'Log_Cleaned')
    .flatMap(a => a.rows.map(r => String(r[1])));
}

test('#1801: two concurrent different-id complete-workout calls for one session append exactly once', async () => {
  reset();
  const sessionId = '1801-RACE';
  const base = {
    date: DATE,
    session_id: sessionId,
    log_rows_json: JSON.stringify(BENCH_ROWS),
    effort_json: effortJson(sessionId),
  };
  const [first, second] = await Promise.all([
    postCompleteWorkout({ ...base, write_id: '1801-race-write-a' }),
    postCompleteWorkout({ ...base, write_id: '1801-race-write-b' }),
  ]);

  // The hole, stated as counts: 2 intended Log rows and 1 Effort row, never 4 + 2.
  assert.equal(logRowsAppended(), 2, `expected 2 Log rows appended, got ${logRowsAppended()}`);
  assert.equal(effortRowsAppended(), 1, `expected 1 Effort row appended, got ${effortRowsAppended()}`);

  const responses = [first, second];
  const winners = responses.filter(r => r.body.data && r.body.data.data && r.body.data.data.sheet_write === 'success');
  assert.equal(winners.length, 1, `exactly one call reports a genuine success: ${JSON.stringify(responses.map(r => r.status))}`);
  assert.equal(winners[0].status, 200);
});

test('#1801: two concurrent different-id complete-workout calls for two sessions on the same date mint different session ids', async () => {
  reset();
  const [first, second] = await Promise.all([
    postCompleteWorkout({
      date: DATE,
      log_rows_json: JSON.stringify(BENCH_ROWS),
      effort_json: effortJson(''),
      write_id: '1801-twosession-write-a',
    }),
    postCompleteWorkout({
      date: DATE,
      log_rows_json: JSON.stringify(SQUAT_ROWS),
      effort_json: effortJson(''),
      write_id: '1801-twosession-write-b',
    }),
  ]);

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const idA = first.body.data && first.body.data.data && first.body.data.data.session_id;
  const idB = second.body.data && second.body.data.data && second.body.data.data.session_id;
  assert.ok(idA && idB, 'both calls report a session id');
  assert.notEqual(idA, idB, `two distinct workouts on one date must mint two session ids, both minted ${idA}`);
  assert.equal(logRowsAppended(), 4, `expected 4 Log rows appended (2 per session), got ${logRowsAppended()}`);
  assert.equal(effortRowsAppended(), 2, `expected 2 Effort rows appended, got ${effortRowsAppended()}`);
  assert.deepEqual(
    [...new Set(logSessionIdsAppended())].sort(),
    [idA, idB].sort(),
    'Log rows carry exactly the two distinct session ids',
  );
  assert.deepEqual(
    [...new Set(effortSessionIdsAppended())].sort(),
    [idA, idB].sort(),
    'Effort rows carry exactly the two distinct session ids',
  );
});

test('#1801 control: sequential different-id complete-workout calls for one session dedupe (no regression)', async () => {
  reset();
  const sessionId = '1801-SEQ';
  const base = {
    date: DATE,
    session_id: sessionId,
    log_rows_json: JSON.stringify(BENCH_ROWS),
    effort_json: effortJson(sessionId),
  };
  const first = await postCompleteWorkout({ ...base, write_id: '1801-seq-write-a' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(logRowsAppended(), 2);
  assert.equal(effortRowsAppended(), 1);

  const second = await postCompleteWorkout({ ...base, write_id: '1801-seq-write-b' });
  assert.equal(second.status, 409, `sequential duplicate session must be refused: ${JSON.stringify(second.body)}`);
  assert.equal(logRowsAppended(), 2, 'the sequential retry appended nothing');
  assert.equal(effortRowsAppended(), 1, 'the sequential retry appended no Effort row');
});

// #1801 variants (boundary-fix rule: fresh spellings of the same class).
// V1 — three-way same-session race: the claim serializes all three, so
// exactly one appends. Fails on base (6 Log + 3 Effort).
test('#1801 variant V1: three concurrent different-id complete-workout calls for one session append exactly once', async () => {
  reset();
  const sessionId = '1801-RACE3';
  const base = {
    date: DATE,
    session_id: sessionId,
    log_rows_json: JSON.stringify(BENCH_ROWS),
    effort_json: effortJson(sessionId),
  };
  const responses = await Promise.all([
    postCompleteWorkout({ ...base, write_id: '1801-race3-write-a' }),
    postCompleteWorkout({ ...base, write_id: '1801-race3-write-b' }),
    postCompleteWorkout({ ...base, write_id: '1801-race3-write-c' }),
  ]);
  assert.equal(logRowsAppended(), 2, `expected 2 Log rows appended, got ${logRowsAppended()}`);
  assert.equal(effortRowsAppended(), 1, `expected 1 Effort row appended, got ${effortRowsAppended()}`);
  const winners = responses.filter(r => r.body.data && r.body.data.data && r.body.data.data.sheet_write === 'success');
  assert.equal(winners.length, 1, `exactly one call reports a genuine success: ${JSON.stringify(responses.map(r => r.status))}`);
  assert.equal(winners[0].status, 200);
});

// V2 — different dates must NOT serialize against each other: the date key
// is per-date, so two concurrent server-minted calls on different dates both
// succeed with distinct ids. Guards against an over-broad claim. Passes on
// base and head alike.
test('#1801 variant V2: two concurrent server-minted complete-workout calls on different dates both succeed', async () => {
  reset();
  const otherDate = '2026-06-27';
  const [first, second] = await Promise.all([
    postCompleteWorkout({
      date: DATE,
      log_rows_json: JSON.stringify(BENCH_ROWS),
      effort_json: effortJson('', DATE),
      write_id: '1801-diffdate-write-a',
    }),
    postCompleteWorkout({
      date: otherDate,
      log_rows_json: JSON.stringify(SQUAT_ROWS),
      effort_json: effortJson('', otherDate),
      write_id: '1801-diffdate-write-b',
    }),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const idA = first.body.data && first.body.data.data && first.body.data.data.session_id;
  const idB = second.body.data && second.body.data.data && second.body.data.data.session_id;
  assert.ok(idA && idB, 'both calls report a session id');
  assert.notEqual(idA, idB, `different dates must mint different session ids, got ${idA} and ${idB}`);
  assert.equal(logRowsAppended(), 4, `expected 4 Log rows appended, got ${logRowsAppended()}`);
  assert.equal(effortRowsAppended(), 2, `expected 2 Effort rows appended, got ${effortRowsAppended()}`);
});

// V3 — a preview (test_mode) concurrent with a live write for the same
// session must neither block the write nor be blocked by it: previews never
// acquire the claim. Guards the preview exemption. Passes on base and head.
test('#1801 variant V3: a preview concurrent with a live write for the same session neither blocks nor is blocked', async () => {
  reset();
  const sessionId = '1801-PREVIEW';
  const base = {
    date: DATE,
    session_id: sessionId,
    log_rows_json: JSON.stringify(BENCH_ROWS),
    effort_json: effortJson(sessionId),
  };
  const [live, preview] = await Promise.all([
    postCompleteWorkout({ ...base, write_id: '1801-preview-write-live' }),
    postCompleteWorkout({ ...base, test_mode: 'true' }),
  ]);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(logRowsAppended(), 2, `the live write appends exactly once, got ${logRowsAppended()}`);
  assert.equal(effortRowsAppended(), 1, `the live write appends one Effort row, got ${effortRowsAppended()}`);
});

// V4 — release discipline: after a race, a sequential duplicate for the
// same session must be refused PROMPTLY. A leaked session claim would make
// this call wait out the 30s waiter timeout before answering 409; the
// 15s bound is half that timeout with a wide margin over the ~100ms a
// clean duplicate takes. Guards the outer-finally release.
test('#1801 variant V4: a sequential duplicate after a race is refused promptly (no leaked claim)', async () => {
  reset();
  const sessionId = '1801-RELEASE';
  const base = {
    date: DATE,
    session_id: sessionId,
    log_rows_json: JSON.stringify(BENCH_ROWS),
    effort_json: effortJson(sessionId),
  };
  await Promise.all([
    postCompleteWorkout({ ...base, write_id: '1801-release-write-a' }),
    postCompleteWorkout({ ...base, write_id: '1801-release-write-b' }),
  ]);
  assert.equal(logRowsAppended(), 2, `the race appends exactly once, got ${logRowsAppended()}`);
  const startedAt = Date.now();
  const second = await postCompleteWorkout({ ...base, write_id: '1801-release-write-c' });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(second.status, 409, `sequential duplicate session must be refused: ${JSON.stringify(second.body)}`);
  assert.equal(logRowsAppended(), 2, 'the sequential retry appended nothing');
  assert.ok(elapsedMs < 15000, `duplicate refusal must be prompt, took ${elapsedMs}ms (a leaked claim costs the 30s waiter timeout)`);
});

// #1801 variant V5 (pre-review F1): a supplied-id call racing a
// server-minted call on the same date must never collapse onto one session
// id. The supplied call takes the session key, the minted call the date
// key — with either-or keys nothing serializes them, both read the same
// snapshot, the minted call mints the supplied id, and both workouts land
// under it. Either both succeed with distinct ids, or exactly one succeeds
// and the other is refused a duplicate — never two workouts on one id.
// Fails on a either-or-key head (4 Log + 2 Effort, both exercises under
// the supplied id); passes once both keys are held.
// The ids are derived from the server clock's current period (the
// allocator mints AM before noon, PM after — services/sessionId.js), so
// the test holds on morning runs as well as afternoon ones.
test('#1801 variant V5: a supplied-id call racing a server-minted call on the same date never collapse onto one session id', async () => {
  reset();
  const periodSuffix = new Date().getHours() < 12 ? 'AM' : 'PM';
  const suppliedId = `20260626-${periodSuffix}-01`;
  const mintedId = `20260626-${periodSuffix}-02`;
  const [supplied, minted] = await Promise.all([
    postCompleteWorkout({
      date: DATE,
      session_id: suppliedId,
      log_rows_json: JSON.stringify(BENCH_ROWS),
      effort_json: effortJson(suppliedId),
      write_id: '1801-mixed-write-supplied',
    }),
    postCompleteWorkout({
      date: DATE,
      log_rows_json: JSON.stringify(SQUAT_ROWS),
      effort_json: effortJson(''),
      write_id: '1801-mixed-write-minted',
    }),
  ]);
  const statuses = [supplied.status, minted.status];
  assert.ok(statuses.every(s => s === 200 || s === 409), `each call answers 200 or 409: ${JSON.stringify(statuses)}`);
  const logCount = logRowsAppended();
  const effortCount = effortRowsAppended();
  assert.ok(logCount === 2 || logCount === 4, `2 or 4 Log rows appended, got ${logCount}`);
  assert.ok(effortCount === 1 || effortCount === 2, `1 or 2 Effort rows appended, got ${effortCount}`);
  assert.equal(logCount, 2 * effortCount, 'Log rows track Effort rows (2 per session)');
  const logRows = state.appends.filter(a => a.tab === 'Log_Cleaned').flatMap(a => a.rows);
  const benchIds = new Set(logRows.filter(r => String(r[2]) === 'Bench Press').map(r => String(r[1])));
  const squatIds = new Set(logRows.filter(r => String(r[2]) === 'Back Squat').map(r => String(r[1])));
  const shared = [...benchIds].filter(id => squatIds.has(id));
  assert.deepEqual(shared, [], `no session id carries both workouts' rows: shared ${JSON.stringify(shared)}`);
  if (supplied.status === 200 && minted.status === 200) {
    assert.deepEqual([...benchIds].sort(), [suppliedId], 'the supplied call keeps its id');
    assert.deepEqual([...squatIds].sort(), [mintedId], 'the minted call steps to the next free slot');
    assert.deepEqual([...new Set(effortSessionIdsAppended())].sort(), [suppliedId, mintedId], 'Effort rows carry the two distinct ids');
  }
});

// #1801 variant V6 (pre-review round 2, hardening): two supplied-id calls
// for DIFFERENT sessions on the same date share the date key in the
// both-keys design, so they serialize — but each keeps its own id and both
// must still succeed. Guards against the shared date key wrongly refusing
// distinct sessions. Passes on base and head alike (no collision either
// way); it pins the both-keys behaviour, not a failure.
test('#1801 variant V6: two supplied-id calls for different sessions on the same date both succeed', async () => {
  reset();
  const [first, second] = await Promise.all([
    postCompleteWorkout({
      date: DATE,
      session_id: '1801-V6-A',
      log_rows_json: JSON.stringify(BENCH_ROWS),
      effort_json: effortJson('1801-V6-A'),
      write_id: '1801-v6-write-a',
    }),
    postCompleteWorkout({
      date: DATE,
      session_id: '1801-V6-B',
      log_rows_json: JSON.stringify(SQUAT_ROWS),
      effort_json: effortJson('1801-V6-B'),
      write_id: '1801-v6-write-b',
    }),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(logRowsAppended(), 4, `expected 4 Log rows appended, got ${logRowsAppended()}`);
  assert.equal(effortRowsAppended(), 2, `expected 2 Effort rows appended, got ${effortRowsAppended()}`);
  const logRows = state.appends.filter(a => a.tab === 'Log_Cleaned').flatMap(a => a.rows);
  const benchIds = new Set(logRows.filter(r => String(r[2]) === 'Bench Press').map(r => String(r[1])));
  const squatIds = new Set(logRows.filter(r => String(r[2]) === 'Back Squat').map(r => String(r[1])));
  assert.deepEqual([...benchIds].sort(), ['1801-V6-A'], 'bench rows keep the first session id');
  assert.deepEqual([...squatIds].sort(), ['1801-V6-B'], 'squat rows keep the second session id');
});
