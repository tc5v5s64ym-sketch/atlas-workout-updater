'use strict';

// #1792 — CONCURRENT saves with a BLANK session_id (verify-first probe).
//
// The claim, unproven (found by reading code; the reviewer did NOT execute
// it): with a blank session_id the server allocates the id from memoized
// sheet reads BEFORE it takes the session claim, and the memo is never
// cleared after the claim — so the dedupe checks run on stale data. Two
// overlapping saves on the same date both get the ...-01 id, so one appends
// into the other.
//
// Why the existing concurrent-save tests do NOT cover this: #1629
// (test/concurrentDifferentIdSave.test.js) races saves with NAMED ids. On
// the named-id path the allocator never runs, so the per-request memos are
// first populated by the guards AFTER the claim wait — on fresh reads — and
// the loser sees the winner's rows. On the blank-id path the allocator runs
// first and populates BOTH memos with the pre-race snapshot; the loser then
// waits on the claim for the SAME ...-01 id and re-reads nothing.
//
// Contract pinned here, at the route with the real Express app and
// sheets.js stubbed in memory (the #1629 idiom). The fake sheet is faithful
// in the load-bearing ways: an append is visible to later reads, and
// concurrent reads resolve as a group with the same pre-append snapshot
// (the #1629 barrier — with all-immediate fakes the two requests serialize
// completely and the race never fires; real Sheets reads take real I/O
// time, so both requests are in flight together).
//   · Two concurrent blank-id saves of DIFFERENT workouts on the same date
//     get DISTINCT session_ids (…-01 and …-02). Merging two real workouts
//     onto one identity is the defect: session_id is what history, the
//     weekly summary, undo, Session_Plans, Session_Plan_Sets, and
//     `atlas:review-live` all join on.
//   · The same race WITH an effort row on each save: still distinct ids,
//     one Effort row per session. The Effort duplicate guard must also see
//     the winner's row — with stale memos it cannot.
//   · Control: two SEQUENTIAL blank-id saves already get distinct ids
//     (the allocator test pins this); the hole is only the overlap window.
//
// Failing-first: on the pre-fix tree both racers mint …-01, both return
// 200 success, and all rows land under …-01.

const test = require('node:test');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resetIdempotencyStore } = require('../services/idempotency');
const { resetSessionClaims } = require('../services/sessionWriteClaim');
const { logCleanedColumns, effortColumns } = require('../config/columns');
const { formatAmPmSuffix } = require('../services/sessionId');
// #1791 — a live /api/log-workout write requires the signed preview digest.
const { postLiveLogWorkout } = require('./helpers/previewDigest');

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
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1792-blank-session-idempotency.json');

const LOG_SESSION_IDX = logCleanedColumns.indexOf('session_id');
const EFFORT_SESSION_IDX = effortColumns.indexOf('session_id');

const state = {
  appends: [],
  effortSessionIds: [],   // the Effort tab's column B
  logCompositeKeys: [],   // what Log_Cleaned durably holds
};

// The race reproduces only if both concurrent reads resolve together, before
// either append lands. (The #1629 barrier, verbatim in shape: concurrent
// reads resolve as a group with the same pre-append snapshot; a lone read
// resolves after a short timeout with the live state.)
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
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'back squat|squat|squats'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
];

// #1762 refix: the Sheets append response reports the ACTUAL updated range,
// so its end column is the submitted rows' width.
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
    // Mirror the real sheet: an appended row becomes a durable record on the next read.
    if (tab === 'Log_Cleaned') {
      for (const r of rows) {
        const sid = String(r[LOG_SESSION_IDX] || '').trim();
        if (sid) state.logCompositeKeys.push(`${sid}||${r[2]}||${r[6]}`.toLowerCase());
      }
    }
    if (tab === 'Effort') {
      for (const r of rows) {
        const sid = String(r[EFFORT_SESSION_IDX] || '').trim();
        if (sid) state.effortSessionIds.push(sid);
      }
    }
    return { data: { updates: { updatedRange: `${tab}!A100:${endColumnFor(rows)}${99 + rows.length}`, updatedRows: rows.length } } };
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
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort'],
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const { app } = require('../index');

let server;
let baseUrl;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });

async function post(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

function reset() {
  resetIdempotencyStore();
  resetSessionClaims();
  state.appends = [];
  state.effortSessionIds = [];
  state.logCompositeKeys = [];
  readWaiters = [];
  if (readTimer) { clearTimeout(readTimer); readTimer = null; }
}

// The ids the server actually stamped onto the Log rows it wrote, in write order.
function writtenSessionIds() {
  return state.appends
    .filter(a => a.tab === 'Log_Cleaned')
    .flatMap(a => a.rows.map(r => String(r[LOG_SESSION_IDX] || '').trim()))
    .filter(Boolean);
}

function effortSessionIdsWritten() {
  return state.appends
    .filter(a => a.tab === 'Effort')
    .flatMap(a => a.rows.map(r => String(r[EFFORT_SESSION_IDX] || '').trim()))
    .filter(Boolean);
}

const DATE = '2026-08-02';

// The allocator stamps AM or PM from the WALL CLOCK (`formatAmPmSuffix`), so
// derive the period from the same function the allocator uses and pin the
// INCREMENT (…-01 → …-02), never the time of day.
const PERIOD = formatAmPmSuffix();
const slot = n => `20260802-${PERIOD}-${String(n).padStart(2, '0')}`;

// A blank session_id means "this is a new workout — you decide": no
// session_id in the payload, so the server allocates. Each racer is a
// DIFFERENT workout (different exercise), so composite-key dedupe cannot
// save them — only distinct allocation can.
function blankSave(exercise, weight, effort) {
  const payload = {
    date: DATE,
    write_id: crypto.randomUUID(),   // a DISTINCT approval each time, never a retry
    log_rows: [{ exercise, set_number: 1, weight, reps: 5, rir: 2 }],
  };
  if (effort) {
    // Object-form effort rows must carry a session_id field (formatEffortRow
    // rewrites it to the RESOLVED identity — the stale ...-01 the client
    // proposed, exactly as the allocator test does).
    payload.effort_row = { date: DATE, session_id: slot(1), duration: 60, active_calories: 400, total_calories: 500, average_hr: 120, peak_hr: 160, location: 'Gym', notes: '' };
  }
  return postLiveLogWorkout(post, payload, 'blankSessionConcurrentSave');
}

test('#1792: two concurrent blank-id saves of DIFFERENT workouts get distinct session_ids', async () => {
  reset();

  const [first, second] = await Promise.all([
    blankSave('Back Squat', 225),
    blankSave('Bench Press', 185),
  ]);

  assert.equal(first.response.status, 200, `first save must write: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.equal(second.response.status, 200, `second save must write: ${JSON.stringify(second.body).slice(0, 300)}`);

  const allIds = [...new Set(writtenSessionIds())];
  assert.deepEqual(allIds, [slot(1), slot(2)],
    `two different workouts must take two distinct slots. Ids written: ${JSON.stringify(allIds)}. ` +
    'Both minting …-01 collapses two real workouts onto one identity, and every ' +
    'downstream consumer that joins on session_id can no longer tell them apart.');

  // Each response must NAME the identity it chose.
  const named = [first.body?.data?.session_id, second.body?.data?.session_id].sort();
  assert.deepEqual(named, [slot(1), slot(2)], 'each response reports its own allocated identity');
});

test('#1792: the same race WITH an effort row on each save still keeps the Effort rows apart', async () => {
  reset();

  const [first, second] = await Promise.all([
    blankSave('Back Squat', 225, true),
    blankSave('Bench Press', 185, true),
  ]);

  assert.equal(first.response.status, 200, `first save must write: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.equal(second.response.status, 200, `second save must write: ${JSON.stringify(second.body).slice(0, 300)}`);

  assert.deepEqual([...new Set(writtenSessionIds())], [slot(1), slot(2)],
    `Log rows must split across two slots. Ids written: ${JSON.stringify([...new Set(writtenSessionIds())])}.`);
  assert.deepEqual([...new Set(effortSessionIdsWritten())].sort(), [slot(1), slot(2)],
    `one Effort row per session, each under its own id. Effort ids written: ${JSON.stringify(effortSessionIdsWritten())}. ` +
    'Two Effort rows under …-01 is the extra row that then makes undo refuse.');
});

test('#1792 control: sequential blank-id saves already get distinct ids (no regression)', async () => {
  reset();
  const first = await blankSave('Back Squat', 225);
  assert.equal(first.response.status, 200);
  assert.equal(first.body?.data?.session_id, slot(1));
  const second = await blankSave('Bench Press', 185);
  assert.equal(second.response.status, 200);
  assert.equal(second.body?.data?.session_id, slot(2));
  assert.deepEqual([...new Set(writtenSessionIds())], [slot(1), slot(2)]);
});
