'use strict';

// #1775 — [P2][Astra A-03] Duration validation depends on JSON type;
// malformed colon strings collapse.
//
// Astra Ultra (Code) re-audit #3 (issue #1775, comment 6934001686): finding
// A05 graded NOT YET BUILT. Claim: string '-30' is rejected but numeric -30
// is accepted and written as '-1:-30:00'; numeric -0.5 becomes '-1:-1:-30';
// '1::30' becomes '00:01:30' and '::30:00' becomes '00:30:00' (empty
// components vanish). Boundary: services/duration.js — the numeric branch
// has no sign/domain check, and the string branch filters empty components
// before validating. Invariant: sign, domain and exact component structure
// are validated before formatting; empty components never disappear during
// validation; string and numeric inputs follow one grammar.
//
// The exact 9-malformed + 6-valid acceptance set lives in the
// coordinator-held evidence pack (astra-evidence-427b7945/); this file proves
// the 4 claim cases plus every further collapse / type variant derivable
// from the named mechanism, and the peer review re-runs the variant set
// (variant-probing rule).

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { normalizeDurationString } = require('../services/duration');
const { logCleanedColumns, effortColumns } = require('../config/columns');

// ── unit level: normalizeDurationString ─────────────────────────────────────

test('A-03 claim: negative numeric durations are refused, never written as negative HH:MM:SS', () => {
  // Base behavior: -30 -> '-1:-30:00', -0.5 -> '-1:-1:-30'.
  assert.throws(() => normalizeDurationString(-30), /Invalid duration/);
  assert.throws(() => normalizeDurationString(-0.5), /Invalid duration/);
  assert.throws(() => normalizeDurationString(-1), /Invalid duration/);
  assert.throws(() => normalizeDurationString(-90), /Invalid duration/);
});

test('A-03 claim: empty colon components are refused, never silently dropped', () => {
  // Base behavior: '1::30' -> '00:01:30', '::30:00' -> '00:30:00',
  // '1:30:' -> '00:01:30', '1::30:00' -> '01:30:00',
  // '30:' -> '00:30:00', ':30:00' -> '00:30:00'.
  for (const bad of ['1::30', '::30:00', '1:30:', '1::30:00', '30:', ':30:00', '1: :30']) {
    assert.throws(() => normalizeDurationString(bad), /Invalid duration format/, bad);
  }
});

test('A-03: non-string / non-number JSON values are refused (one grammar)', () => {
  // Base behavior: [30] -> '00:30:00', ['45:30'] -> '00:45:30' — a JSON
  // array was coerced through String() and accepted as a duration.
  assert.throws(() => normalizeDurationString([30]), /Invalid duration/);
  assert.throws(() => normalizeDurationString(['45:30']), /Invalid duration/);
  assert.throws(() => normalizeDurationString(true), /Invalid duration/);
  assert.throws(() => normalizeDurationString({}), /Invalid duration/);
  assert.throws(() => normalizeDurationString(NaN), /Invalid duration/);
  assert.throws(() => normalizeDurationString(Infinity), /Invalid duration/);
});

test('A-03: forms already refused stay refused', () => {
  // String '-30' is the type-dependence control: the string branch already
  // rejects a sign; the numeric branch must now agree.
  for (const bad of ['-30', '1:-30', '-1:30', '1:60', '1:60:00', '00:90:30',
    '1:30:00:00', ':30', 'not a duration', '1.5:30', '1:30.5']) {
    assert.throws(() => normalizeDurationString(bad), /Invalid duration/, bad);
  }
  assert.throws(() => normalizeDurationString(''), /duration is required/);
  assert.throws(() => normalizeDurationString(null), /duration is required/);
  assert.throws(() => normalizeDurationString(undefined), /duration is required/);
});

test('A-03: valid formats keep working (six acceptance formats + controls)', () => {
  assert.equal(normalizeDurationString(45), '00:45:00');
  assert.equal(normalizeDurationString('45'), '00:45:00');
  assert.equal(normalizeDurationString('53.75'), '00:53:45');
  assert.equal(normalizeDurationString('45:30'), '00:45:30');
  assert.equal(normalizeDurationString('1:05:09'), '01:05:09');
  assert.equal(normalizeDurationString('90:30'), '01:30:30');
  assert.equal(normalizeDurationString(0), '00:00:00');
  assert.equal(normalizeDurationString(0.5), '00:00:30');
  assert.equal(normalizeDurationString('00:45:00'), '00:45:00');
  assert.equal(normalizeDurationString('59:59'), '00:59:59');
  assert.equal(normalizeDurationString('125:05'), '02:05:05');
});

// ── route level: the write sink ─────────────────────────────────────────────
// Same harness as test/durationOnlyEffortCompleteWorkout.test.js: a real POST
// /api/complete-workout against the real Express app with only `googleapis`
// faked. A malformed duration must be refused before any write.

const DATE = '2026-11-12';
const DURATION = '00:58:00';

const SESSION_COL = effortColumns.indexOf('session_id');
const DURATION_COL = effortColumns.indexOf('duration');

const SHEET = {
  Log_Cleaned: [[...logCleanedColumns]],
  Effort: [[...effortColumns]],
  Exercise_Catalog: [
    ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
    ['Back Squat', 'Back Squat', 'Legs', 'SQ01'],
  ],
};

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
          const updates = { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:${endColumnFor(requestBody.values)}${last}` };
          return { data: { updates } };
        },
        update: async () => ({ data: {} }),
        batchUpdate: async () => ({ data: { totalUpdatedCells: 0 } }),
      },
    },
  };
}

let serverPromise = null;

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
    process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1775-duration-idempotency.json');

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

function effortFields(sessionId, effortOverrides) {
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
    test_mode: 'true',
  };
}

test('A-03 route: numeric -30 duration is refused at /api/complete-workout and writes nothing', async (t) => {
  const sessionId = '20261112-A03-01';
  const { res, body } = await postCompleteWorkout(t, effortFields(sessionId, { duration: -30 }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.details || ''), /Invalid duration/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});

test('A-03 route: collapsed string 1::30 is refused at /api/complete-workout and writes nothing', async (t) => {
  const sessionId = '20261112-A03-02';
  const { res, body } = await postCompleteWorkout(t, effortFields(sessionId, { duration: '1::30' }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.details || ''), /Invalid duration/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});

test('A-03 route: valid duration-only finish still succeeds (control)', async (t) => {
  const sessionId = '20261112-A03-03';
  const { res, body } = await postCompleteWorkout(t, effortFields(sessionId, {}));
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body?.data?.data?.effort_row?.[DURATION_COL], DURATION);
  assert.equal(effortRowsFor(sessionId).length, 0, 'dry-run writes nothing');
});

// ── route level: the log-workout half (Sunny BLOCKING on PR #1807) ──────────
// /api/log-workout takes effort_row straight from the JSON payload and
// formats it via formatEffortRow → normalizeEffortRow, which copied
// duration verbatim — normalizeDurationString was never called on this
// route, so the same malformed forms reached the Effort row through the
// ordinary save flow. The duration must go through the same grammar here.
async function postLogWorkout(t, fields) {
  if (!serverPromise) {
    // Same server bootstrap as postCompleteWorkout (shared serverPromise).
    await postCompleteWorkout(t, effortFields('20261112-A03-bootstrap', {}));
  }
  require('../services/idempotency').resetIdempotencyStore();
  const { base } = await serverPromise;
  const res = await fetch(`${base}/api/log-workout`, {
    method: 'POST',
    headers: { 'x-atlas-api-key': 'test-api-key', 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });
  return { res, body: await res.json() };
}

function logWorkoutFields(sessionId, effortOverrides) {
  return {
    date: DATE,
    session_id: sessionId,
    log_rows: [{
      date: DATE, session_id: sessionId, exercise: 'Back Squat',
      set: 1, weight: 225, reps: 5, rir: 2,
    }],
    effort_row: {
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
    },
    test_mode: true,
  };
}

test('A-03 route: numeric -30 duration is refused at /api/log-workout and writes nothing', async (t) => {
  const sessionId = '20261112-A03-11';
  const { res, body } = await postLogWorkout(t, logWorkoutFields(sessionId, { duration: -30 }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.message || ''), /Invalid duration/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});

test('A-03 route: collapsed string 1::30 is refused at /api/log-workout and writes nothing', async (t) => {
  const sessionId = '20261112-A03-12';
  const { res, body } = await postLogWorkout(t, logWorkoutFields(sessionId, { duration: '1::30' }));
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.match(String(body?.message || ''), /Invalid duration/);
  assert.equal(effortRowsFor(sessionId).length, 0, 'no Effort row is written on refusal');
});

test('A-03 route: valid duration is normalized at /api/log-workout (control)', async (t) => {
  const sessionId = '20261112-A03-13';
  const { res, body } = await postLogWorkout(t, logWorkoutFields(sessionId, { duration: 45 }));
  assert.equal(res.status, 200, JSON.stringify(body));
  // Numeric 45 is canonicalized to HH:MM:SS in the dry-run preview —
  // the same grammar as /api/complete-workout, not passed through raw.
  assert.equal(body?.data?.effort_row_preview?.[DURATION_COL], '00:45:00');
  assert.equal(effortRowsFor(sessionId).length, 0, 'dry-run writes nothing');
});
