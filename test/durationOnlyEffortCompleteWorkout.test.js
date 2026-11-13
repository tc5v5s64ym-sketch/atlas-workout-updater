'use strict';

// #1743 — VERIFY FIRST: #1635 CLIENT PATH — TYPED DURATION-ONLY FINISH WITH
// NO SETS.
//
// Suspicion 6 from the Fable 5.2 re-audit (UNVERIFIED, not executed to a sink):
// a typed duration-only finish with no sets may fail on the client — the API
// returns 400 'activeCalories is required'. #1635 shipped (PR #1725) on the
// strength of API-level tests against /api/log-workout; this file proves the
// REAL client path: the effort-only closeout the client submits when the
// manual-effort form holds a duration and nothing else and there are zero
// logged sets — POST /api/complete-workout (multipart) with log_rows_json=[]
// and effort_json exactly as collectManualEffort builds it (snake_case,
// blanks as '').
//
// Dale's ruling (2026-11-10, #1635 comment 6766656009) governs here too:
// a duration-only finish writes a partial Effort row — calories / heart rate
// recorded as unknown (absent), never invented, and the finish is never
// refused for missing calories/HR. The ruling covers the genuine
// user-supplied duration on the manual-effort path; #1708 is untouched
// (model/vision-invented durations stay blocked at the boundary).
//
// Proved here at the live path: a real POST /api/complete-workout against
// the real Express app with only `googleapis` faked (same stub pattern as
// test/durationOnlyEffort.test.js).

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { logCleanedColumns, effortColumns } = require('../config/columns');

const DATE = '2026-11-12';
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

async function postCompleteWorkout(t, fields) {
  if (!serverPromise) {
    process.env.ATLAS_API_KEY = 'test-api-key';
    process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
    process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1743-duration-only-idempotency.json');

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
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${base}/api/complete-workout`, {
    method: 'POST',
    headers: { 'x-atlas-api-key': 'test-api-key' },
    body: form,
  });
  return { res, body: await res.json() };
}

function effortRowsFor(sessionId) {
  return SHEET.Effort.slice(1).filter((r) => r[SESSION_COL] === sessionId);
}

function logRowsFor(sessionId) {
  return SHEET.Log_Cleaned.slice(1).filter((r) => r[1] === sessionId);
}

// The exact payload collectManualEffort (src/app/app.js) builds for a
// duration-only form: snake_case, unfilled numerics as ''.
function effortOnlyFields(sessionId, effortOverrides, extra = {}) {
  return {
    date: DATE,
    session_id: sessionId,
    log_rows_json: '[]',
    effort_json: JSON.stringify({
      date: DATE,
      session_id: sessionId,
      duration: DURATION,
      active_calories: '',
      total_calories: '',
      average_hr: '',
      peak_hr: '',
      location: '',
      notes: '',
      ...effortOverrides,
    }),
    ...extra,
  };
}

test('duration-only effort-only dry-run succeeds: partial Effort row preview, calories/HR unknown', async (t) => {
  const sessionId = '20261112-PM-01';
  const { res, body } = await postCompleteWorkout(t, effortOnlyFields(sessionId, {}, { test_mode: 'true' }));
  assert.equal(res.status, 200, JSON.stringify(body));
  const data = body?.data?.data;
  assert.equal(data?.effort_only, true, JSON.stringify(body));
  assert.equal(data?.no_write_confirmed, true, JSON.stringify(body));
  const row = data?.effort_row;
  assert.ok(Array.isArray(row), 'dry-run returns the Effort row preview');
  assert.equal(row[DURATION_COL], DURATION);
  assert.equal(row[ACTIVE_COL], '', 'active calories unknown, not invented');
  assert.equal(row[TOTAL_COL], '', 'total calories unknown, not invented');
  assert.equal(row[AVG_HR_COL], '', 'average HR unknown, not invented');
  assert.equal(row[PEAK_HR_COL], '', 'peak HR unknown, not invented');
  assert.equal(data?.parsed_effort?.duration, DURATION);
  assert.equal(data?.parsed_effort?.activeCalories, '', 'normalized metrics keep calories unknown');
  assert.equal(effortRowsFor(sessionId).length, 0, 'dry-run writes nothing');
});

test('duration + a subset of fields keeps the supplied values and leaves the rest unknown', async (t) => {
  const sessionId = '20261112-PM-02';
  const { res, body } = await postCompleteWorkout(t, effortOnlyFields(sessionId, { active_calories: 650 }, { test_mode: 'true' }));
  assert.equal(res.status, 200, JSON.stringify(body));
  const row = body?.data?.data?.effort_row;
  assert.equal(row[DURATION_COL], DURATION);
  assert.equal(row[ACTIVE_COL], 650, 'the supplied value is kept as given');
  assert.equal(row[TOTAL_COL], '');
  assert.equal(row[AVG_HR_COL], '');
  assert.equal(row[PEAK_HR_COL], '');
});

test('duration-only effort-only live write appends exactly one partial Effort row and zero Log rows', async (t) => {
  const sessionId = '20261112-PM-03';
  const { res, body } = await postCompleteWorkout(t, effortOnlyFields(sessionId, {}, { write_id: 'w_1743_duration_only_live' }));
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body?.data?.data?.effort_rows_written, 1, JSON.stringify(body));
  assert.equal(body?.data?.data?.log_rows_written, 0, JSON.stringify(body));
  assert.equal(logRowsFor(sessionId).length, 0, 'no Log rows for a sets-free finish');
  const rows = effortRowsFor(sessionId);
  assert.equal(rows.length, 1, 'exactly one Effort row for the session');
  assert.equal(rows[0][DURATION_COL], DURATION);
  assert.equal(rows[0][ACTIVE_COL], '', 'active calories unknown, not invented');
  assert.equal(rows[0][TOTAL_COL], '', 'total calories unknown, not invented');
  assert.equal(rows[0][AVG_HR_COL], '', 'average HR unknown, not invented');
  assert.equal(rows[0][PEAK_HR_COL], '', 'peak HR unknown, not invented');
});

// ── the refusals the ruling does NOT lift ────────────────────────────────────

test('a supplied out-of-bounds calorie value is still refused', async (t) => {
  const sessionId = '20261112-PM-04';
  const { res, body } = await postCompleteWorkout(t, effortOnlyFields(sessionId, { active_calories: 99999 }, { test_mode: 'true' }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.details || ''), /activeCalories must be between 1 and 3000/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});

test('manual effort with no duration is still refused', async (t) => {
  const sessionId = '20261112-PM-05';
  const { res, body } = await postCompleteWorkout(t, effortOnlyFields(sessionId, { duration: '', active_calories: 650 }, { test_mode: 'true' }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.details || ''), /duration is required/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});
