'use strict';

// #1794 — DELOAD endpoints skip the write rules (verify-first probe).
//
// The claim, unproven (found by reading code): POST /api/deload/begin,
// /api/deload/advance and /api/deload/resolve (routes/coachOps.js:2316-2363)
// carry no write_id, no idempotency, no write-freeze check and no
// write-bucket rate limit. A double-tapped "advance" takes two sessions off
// the deload count.
//
// Code-read confirmation (all verified at s3 head c209c050, before any probe
// ran):
//   · write_id / idempotency: no mention anywhere in the three handlers or in
//     services/deloadEngine.js / services/deloadState.js. The route comment
//     (coachOps.js:2272-2274) states it outright: "no write_id".
//   · write-freeze: services/writeFreeze.admitWrite is reached only from the
//     seven beginWrite routes in index.js (coaching-notes, constraints,
//     log-modality, bodyweight, complete-workout, log-workout,
//     log-workout/undo-last). The deload routes never call
//     refuseIfWritesFrozen.
//   · rate limit: the deload paths ride ONLY the general /api limiter
//     (index.js:353, 300/min default). They are NOT in the tight `write`
//     limiter list (index.js:378, 60 per 10 min) with the other write routes.
//     A double-tap (2 requests) is nowhere near either cap, so no limiter
//     protects against a double-submit.
//   · The state machine is the ONLY guard, and it guards the wrong thing: it
//     rejects an ILLEGAL move (advance when not deloading, begin while
//     deloading, resolve outside post-evaluation) but cannot tell a duplicate
//     submission of a LEGAL move from a second intentional one.
//
// Contract pinned here, at the route with the real Express app and sheets.js
// stubbed in memory (the #1792 idiom). The fake sheet is faithful in the
// load-bearing ways: an append is visible to later reads, and concurrent
// reads resolve as a group with the same pre-append snapshot (the #1629
// barrier — with all-immediate fakes the two requests serialize completely
// and the race never fires; real Sheets reads take real I/O time, so both
// requests are in flight together).
//   · P1: the same advance submitted twice with the SAME write_id applies
//     ONCE (remaining 2 → 1). A retry / double-tap is not a second session.
//   · P2: the same advance submitted twice CONCURRENTLY with the same
//     write_id applies once — exactly one Deload_State row appended.
//   · P3 (control): two advances with DISTINCT write_ids both apply
//     (remaining 2 → 0) — idempotency must never collapse two real sessions.
//   · P4: the same begin submitted twice concurrently with the same write_id
//     appends exactly one DELOAD_ACTIVE row.
//   · P5: the same resolve submitted twice concurrently with the same
//     write_id appends exactly one NORMAL row.
//   · P6 (control): sequential resolve of a second, distinct resolve is
//     refused by the state machine (409) — the existing guard keeps working.
//
// Failing-first: on the pre-fix tree the endpoint ignores write_id entirely,
// so P1 takes two sessions off the count, P2/P4/P5 each append twice, and
// only the controls (P3, P6) pass.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key-stub';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// Per-process receipt file: a previous run's completed write_ids must never
// replay into this run (the store persists to disk by design).
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), `atlas-deload-double-submit-${process.pid}.json`);

const DELOAD_HEADER = ['updated_at', 'training_state', 'deload_protocol', 'deload_reason', 'deload_start_date', 'deload_sessions_remaining', 'deload_exit_criteria'];
const REMAINING_IDX = DELOAD_HEADER.indexOf('deload_sessions_remaining');
const STATE_IDX = DELOAD_HEADER.indexOf('training_state');

// Modeled Deload_State tab: header + data rows, in sheet order.
const state = {
  deloadSheet: [],
  appends: [], // { tab, rows } for Deload_State only, after seeding
};

// The race reproduces only if both concurrent reads resolve together, before
// either append lands. (The #1629/#1792 barrier, verbatim in shape, applied
// to Deload_State reads only: concurrent reads resolve as a group with the
// same pre-append snapshot; a lone read resolves after a short timeout with
// the live state.)
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
    if (tab === 'Deload_State') {
      state.appends.push({ tab, rows: rows.map(r => [...r]) });
      for (const r of rows) state.deloadSheet.push([...r]);
    }
    return { data: { updates: { updatedRange: `${tab}!A100:${endColumnFor(rows)}${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async (range) => {
    if (String(range).startsWith('Deload_State!') && state.deloadSheet.length > 0) {
      return [state.deloadSheet[0].map(v => String(v))];
    }
    return [];
  },
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async (tab) => {
    if (tab === 'Deload_State') {
      // getSheetRows strips row 0 as the header; the current state is the
      // last DATA row. Barriered so concurrent reads share one snapshot.
      return barrieredRead(state.deloadSheet.slice(1).map(r => [...r]));
    }
    return [];
  },
  getHeaderRow: async () => [],
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Deload_State'],
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
    body: JSON.stringify(payload || {}),
  });
  return { response, body: await response.json() };
}

async function getStatus() {
  const response = await fetch(`${baseUrl}/api/deload/status`, {
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY },
  });
  return { response, body: await response.json() };
}

function reset() {
  state.deloadSheet = [];
  state.appends = [];
  readWaiters = [];
  if (readTimer) { clearTimeout(readTimer); readTimer = null; }
}

function seedActiveDeload(remaining) {
  state.deloadSheet = [
    [...DELOAD_HEADER],
    ['2026-06-16T00:00:00Z', 'DELOAD_ACTIVE', 'STRENGTH_DELOAD_V1', 'testing', '2026-06-16', String(remaining), ''],
  ];
}

function seedPostDeload() {
  state.deloadSheet = [
    [...DELOAD_HEADER],
    ['2026-06-16T00:00:00Z', 'POST_DELOAD_EVALUATION', 'STRENGTH_DELOAD_V1', 'testing', '2026-06-16', '0', ''],
  ];
}

async function remaining() {
  const { response, body } = await getStatus();
  assert.equal(response.status, 200, `status must read: ${JSON.stringify(body).slice(0, 200)}`);
  return Number(body.data.state.deload_sessions_remaining);
}

async function trainingState() {
  const { body } = await getStatus();
  return body.data.state.training_state;
}

function deloadAppends() {
  return state.appends.filter(a => a.tab === 'Deload_State');
}

// P1 — the headline probe: the same advance twice (same write_id) must apply
// once. On base the endpoint ignores write_id, so both apply: 2 → 0.
test('#1794 P1: same write_id advance twice applies once', async () => {
  reset();
  seedActiveDeload(2);

  const first = await post('/api/deload/advance', { write_id: 'w-advance-1' });
  assert.equal(first.response.status, 200, `first advance must succeed: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.equal(await remaining(), 1, 'first advance takes one session off (2 → 1)');

  const second = await post('/api/deload/advance', { write_id: 'w-advance-1' });
  assert.equal(second.response.status, 200, `duplicate advance must answer 200 (replay), not 409: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(await remaining(), 1,
    'the duplicate advance must NOT take a second session off the count. ' +
    `Remaining: ${await remaining()} (2 → 0 means the double-tap took two sessions).`);
  assert.equal(deloadAppends().length, 1, 'the duplicate advance must not append a second state row');
});

// P2 — the same advance twice CONCURRENTLY (same write_id) applies once.
test('#1794 P2: concurrent same write_id advance applies once', async () => {
  reset();
  seedActiveDeload(2);

  const [first, second] = await Promise.all([
    post('/api/deload/advance', { write_id: 'w-advance-2' }),
    post('/api/deload/advance', { write_id: 'w-advance-2' }),
  ]);
  assert.equal(first.response.status, 200, `first racer must succeed: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.equal(second.response.status, 200, `second racer must answer 200 (replay), not 409: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(await remaining(), 1, `concurrent duplicate must leave one session taken, not two. Remaining: ${await remaining()}.`);
  assert.equal(deloadAppends().length, 1,
    `concurrent duplicate must append exactly one state row, not two. Appended rows: ${JSON.stringify(deloadAppends().map(a => a.rows[0][REMAINING_IDX]))}.`);
});

// P3 (control) — two advances with DISTINCT write_ids are two real sessions.
test('#1794 P3 (control): distinct write_id advances both apply', async () => {
  reset();
  seedActiveDeload(2);

  const first = await post('/api/deload/advance', { write_id: 'w-advance-3a' });
  assert.equal(first.response.status, 200, `first advance must succeed: ${JSON.stringify(first.body).slice(0, 300)}`);
  const second = await post('/api/deload/advance', { write_id: 'w-advance-3b' });
  assert.equal(second.response.status, 200, `second advance must succeed: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(await remaining(), 0, 'two distinct advances take two sessions off (2 → 0)');
  assert.equal(await trainingState(), 'POST_DELOAD_EVALUATION', 'running out of sessions moves to POST_DELOAD_EVALUATION');
  assert.equal(deloadAppends().length, 2, 'two distinct advances append two state rows');
});

// P4 — the same begin twice CONCURRENTLY (same write_id) appends one row.
test('#1794 P4: concurrent same write_id begin appends once', async () => {
  reset();
  state.deloadSheet = [[...DELOAD_HEADER]]; // tab exists, no deload yet

  const [first, second] = await Promise.all([
    post('/api/deload/begin', { write_id: 'w-begin-4', focus: 'strength', sessions_remaining: 3 }),
    post('/api/deload/begin', { write_id: 'w-begin-4', focus: 'strength', sessions_remaining: 3 }),
  ]);
  assert.equal(first.response.status, 200, `first begin must succeed: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.equal(second.response.status, 200, `second begin must answer 200 (replay), not 409: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(deloadAppends().length, 1,
    `concurrent duplicate begin must append exactly one DELOAD_ACTIVE row. Appended: ${JSON.stringify(deloadAppends().map(a => a.rows[0][STATE_IDX]))}.`);
  assert.equal(await remaining(), 3, 'one begin leaves 3 sessions remaining');
});

// P5 — the same resolve twice CONCURRENTLY (same write_id) appends one row.
test('#1794 P5: concurrent same write_id resolve appends once', async () => {
  reset();
  seedPostDeload();

  const [first, second] = await Promise.all([
    post('/api/deload/resolve', { write_id: 'w-resolve-5' }),
    post('/api/deload/resolve', { write_id: 'w-resolve-5' }),
  ]);
  assert.equal(first.response.status, 200, `first resolve must succeed: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.equal(second.response.status, 200, `second resolve must answer 200 (replay), not 409: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(deloadAppends().length, 1,
    `concurrent duplicate resolve must append exactly one NORMAL row. Appended: ${JSON.stringify(deloadAppends().map(a => a.rows[0][STATE_IDX]))}.`);
  assert.equal(await trainingState(), 'NORMAL', 'one resolve returns to NORMAL');
});

// P6 (control) — sequential second resolve is refused by the state machine.
test('#1794 P6 (control): sequential duplicate resolve is refused 409', async () => {
  reset();
  seedPostDeload();

  const first = await post('/api/deload/resolve', { write_id: 'w-resolve-6a' });
  assert.equal(first.response.status, 200, `first resolve must succeed: ${JSON.stringify(first.body).slice(0, 300)}`);
  const second = await post('/api/deload/resolve', { write_id: 'w-resolve-6b' });
  assert.equal(second.response.status, 409, `second resolve must be refused as an illegal move: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(deloadAppends().length, 1, 'the refused resolve appends nothing');
});
