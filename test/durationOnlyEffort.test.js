'use strict';

// #1635 — DURATION-ONLY FINISH WRITES A PARTIAL EFFORT ROW.
//
// Ruling (Dale 2026-11-10, issue comment 6766656009): when a user finishes with
// duration only ("Done. 58 min."), the app records the Effort row with that
// duration and calories / heart rate recorded as unknown (absent) — never
// invented, and the finish is never refused for missing calories/HR. This
// governs the genuine user-supplied duration on the manual-effort path; it
// does not change #1708 (model/vision-invented durations stay blocked at the
// boundary).
//
// Proved here at the live path: a real POST /api/log-workout against the real
// Express app with only `googleapis` faked (same stub pattern as
// test/appendWriteProof.test.js). The client half — collectManualEffort
// accepting a partially-filled form — is pinned in
// test/finishLineCloseout.test.js, which owns the #1626 closeout contract.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { logCleanedColumns, effortColumns } = require('../config/columns');

const DATE = '2026-11-10';
const DURATION = '00:58:00';

const SESSION_COL = effortColumns.indexOf('session_id');
const DURATION_COL = effortColumns.indexOf('duration');
const ACTIVE_COL = effortColumns.indexOf('active_calories');
const TOTAL_COL = effortColumns.indexOf('total_calories');
const AVG_HR_COL = effortColumns.indexOf('average_hr');
const PEAK_HR_COL = effortColumns.indexOf('peak_hr');

// One shared fake sheet per file; each test writes under its own session id so
// the duplicate guards never see another test's rows.
const SHEET = {
  Log_Cleaned: [[...logCleanedColumns]],
  Effort: [[...effortColumns]],
  Exercise_Catalog: [
    ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
    ['Back Squat', 'Back Squat', 'Legs', 'SQ01'],
  ],
};

function makeFake() {
  return {
    spreadsheets: {
      get: async () => ({ data: { sheets: Object.keys(SHEET).map((title) => ({ properties: { title, sheetId: 1 } })) } }),
      batchUpdate: async () => ({ data: {} }),
      values: {
        get: async ({ range }) => {
          const tab = String(range).split('!')[0];
          const rows = SHEET[tab];
          if (!rows) throw new Error(`Unable to parse range: ${range}`);
          return { data: { values: /!1:1$/.test(range) ? [rows[0]] : rows } };
        },
        batchGet: async ({ ranges }) => ({
          data: {
            valueRanges: ranges.map((range) => {
              const tab = String(range).split('!')[0];
              const rows = SHEET[tab] || [];
              return { range, values: /!1:1$/.test(range) ? [rows[0]] : rows };
            }),
          },
        }),
        append: async ({ range, requestBody }) => {
          const tab = String(range).split('!')[0];
          if (!SHEET[tab]) SHEET[tab] = [];
          for (const r of requestBody.values) SHEET[tab].push(r.map((v) => (v === null || v === undefined ? '' : String(v))));
          const n = requestBody.values.length;
          const last = SHEET[tab].length;
          const updates = { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:L${last}` };
          return { data: { updates } };
        },
        update: async () => ({ data: {} }),
        batchUpdate: async () => ({ data: { totalUpdatedCells: 0 } }),
      },
    },
  };
}

let serverPromise = null;

// The server is shared by every test in this file and closed once, when the
// file finishes — a per-test close would refuse the later tests' connections.
after(async () => {
  if (serverPromise) {
    const { server } = await serverPromise;
    await new Promise((resolve) => server.close(resolve));
  }
});

async function postLogWorkout(t, payload) {
  if (!serverPromise) {
    process.env.ATLAS_API_KEY = 'test-api-key';
    process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
    process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1635-duration-only-idempotency.json');

    const googleapisPath = require.resolve('googleapis');
    require.cache[googleapisPath] = {
      id: googleapisPath, filename: googleapisPath, loaded: true,
      exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, sheets: () => makeFake() } },
    };
    const { app } = require('../index');
    serverPromise = (async () => {
      const server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
      return { server, base: `http://127.0.0.1:${server.address().port}` };
    })();
  }
  // The idempotency store persists to disk and rehydrates, so a write_id from an
  // earlier run of this file would be replayed as a duplicate — the recorded
  // response, and NO append.
  require('../services/idempotency').resetIdempotencyStore();
  const { base } = await serverPromise;
  const res = await fetch(`${base}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json() };
}

function effortRowsFor(sessionId) {
  return SHEET.Effort.slice(1).filter((r) => r[SESSION_COL] === sessionId);
}

function logPayload(sessionId, writeId, effortRow) {
  return {
    date: DATE,
    session_id: sessionId,
    write_id: writeId,
    log_rows: [
      { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
    ],
    ...(effortRow === undefined ? {} : { effort_row: effortRow }),
  };
}

test('duration-only effort_row writes a partial Effort row (calories/HR unknown, never invented)', async (t) => {
  const sessionId = '20261110-AM-01';
  const { res, body } = await postLogWorkout(t, logPayload(sessionId, 'w_1635_duration_only', {
    date: DATE,
    session_id: sessionId,
    duration: DURATION,
  }));
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body?.data?.effort_rows_written, 1, JSON.stringify(body));
  const rows = effortRowsFor(sessionId);
  assert.equal(rows.length, 1, 'exactly one Effort row for the session');
  assert.equal(rows[0][DURATION_COL], DURATION);
  assert.equal(rows[0][ACTIVE_COL], '', 'active calories unknown, not invented');
  assert.equal(rows[0][TOTAL_COL], '', 'total calories unknown, not invented');
  assert.equal(rows[0][AVG_HR_COL], '', 'average HR unknown, not invented');
  assert.equal(rows[0][PEAK_HR_COL], '', 'peak HR unknown, not invented');
});

test('duration + a subset of fields writes the supplied values and leaves the rest unknown', async (t) => {
  const sessionId = '20261110-AM-02';
  const { res, body } = await postLogWorkout(t, logPayload(sessionId, 'w_1635_duration_plus_cal', {
    date: DATE,
    session_id: sessionId,
    duration: DURATION,
    active_calories: 650,
  }));
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body?.data?.effort_rows_written, 1, JSON.stringify(body));
  const rows = effortRowsFor(sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][DURATION_COL], DURATION);
  assert.equal(rows[0][ACTIVE_COL], '650', 'the supplied value is written as given');
  assert.equal(rows[0][TOTAL_COL], '');
  assert.equal(rows[0][AVG_HR_COL], '');
  assert.equal(rows[0][PEAK_HR_COL], '');
});

test('array-form duration-only row writes the same partial row', async (t) => {
  const sessionId = '20261110-AM-03';
  const row = new Array(effortColumns.length).fill('');
  row[effortColumns.indexOf('date')] = DATE;
  row[SESSION_COL] = sessionId;
  row[DURATION_COL] = DURATION;
  const { res, body } = await postLogWorkout(t, logPayload(sessionId, 'w_1635_array_form', row));
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body?.data?.effort_rows_written, 1, JSON.stringify(body));
  const rows = effortRowsFor(sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][DURATION_COL], DURATION);
  assert.equal(rows[0][ACTIVE_COL], '');
  assert.equal(rows[0][AVG_HR_COL], '');
});

// ── the refusals the ruling does NOT lift ────────────────────────────────────

test('a supplied out-of-bounds calorie value is still refused', async (t) => {
  const sessionId = '20261110-AM-04';
  const { res, body } = await postLogWorkout(t, logPayload(sessionId, 'w_1635_bad_cal', {
    date: DATE,
    session_id: sessionId,
    duration: DURATION,
    active_calories: 99999,
  }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.message || ''), /active_calories must be between 1 and 3000/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});

test('an effort row with no duration is still refused', async (t) => {
  const sessionId = '20261110-AM-05';
  const { res, body } = await postLogWorkout(t, logPayload(sessionId, 'w_1635_no_duration', {
    date: DATE,
    session_id: sessionId,
    active_calories: 650,
  }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.message || ''), /Missing required effort row field: duration/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});
