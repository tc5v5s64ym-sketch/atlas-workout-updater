'use strict';

// #1762 [P1][Astra D02] — VERIFY FIRST: an invalid or zero-row append still
// mints a success receipt.
//
// The Astra Ultra re-audit (2026-11-14, at 66fec920) captured it: a zero-row
// adapter result -> {sheet_write:'success', idempotency_status:'completed',
// log_rows_written:0, log_write_verification:{verified:false,
// reason:'no_row_count'}} with an empty Log table, and a multipart append
// reporting updatedRange 'Wrong_Tab!A2:L2' -> sheet_write success with the
// target Log table empty. The receipt then replays that success on retry.
// Modality and note writes accept zero-row proof too.
//
// Invariant to enforce (issue #1762): one append-proof verdict controls every
// writer's HTTP outcome and persisted receipt, for every requested table. A
// proof that does not establish the requested rows in the requested table is
// a failed write, everywhere.
//
// Proved here at the live path: real POSTs against the real Express app with
// only `googleapis` faked (same stub pattern as test/appendWriteProof.test.js),
// with the fake append returning the malformed receipt shapes from the audit.
// Each probe asserts the FIXED outcome, so every probe FAILS at the s3 head
// until the verdict gates the outcome.
//
// Variant set (issue acceptance): zero / missing / string row counts; wrong
// tab, wrong span, unparseable range, non-A start; across all four writers
// (log-workout, complete-workout/multipart, log-modality, coaching-notes);
// first-write AND retry outcomes both truthful.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { logCleanedColumns, effortColumns, modalityLogColumns } = require('../config/columns');

const DATE = '2026-11-16';
const LOG_SESSION_COL = logCleanedColumns.indexOf('session_id');

// One shared fake sheet per file; each test writes under its own session id so
// the duplicate guards never see another test's rows.
const SHEET = {
  Log_Cleaned: [[...logCleanedColumns]],
  Effort: [[...effortColumns]],
  Exercise_Catalog: [
    ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
    ['Back Squat', 'Back Squat', 'Legs', 'SQ01'],
  ],
  Modality_Log: [[...modalityLogColumns]],
  Coaching_Notes: [['date', 'note']],
};

// Per-tab append override: tab -> (values) => { updates, pushRows }.
// Absent = the honest append: push the values, return a self-consistent receipt.
const appendOverrides = new Map();
const appendCalls = [];

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

function honestReceipt(tab, values) {
  const n = values.length;
  const last = SHEET[tab].length + n;
  return { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:${endColumnFor(values)}${last}` };
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
          const values = requestBody.values || [];
          appendCalls.push({ tab, rows: values.length });
          const override = appendOverrides.get(tab);
          if (override) {
            const { updates, pushRows } = override(values);
            if (pushRows) {
              if (!SHEET[tab]) SHEET[tab] = [];
              for (const r of pushRows) SHEET[tab].push(r.map((v) => (v === null || v === undefined ? '' : String(v))));
            }
            return { data: { updates } };
          }
          if (!SHEET[tab]) SHEET[tab] = [];
          for (const r of values) SHEET[tab].push(r.map((v) => (v === null || v === undefined ? '' : String(v))));
          return { data: { updates: honestReceipt(tab, values) } };
        },
        update: async () => ({ data: {} }),
        batchUpdate: async () => ({ data: { totalUpdatedCells: 0 } }),
      },
    },
  };
}

// ── malformed receipt shapes (the audit's variant set) ──────────────────────
// Each models an append the API reports as done while nothing lands in the
// requested table: the rows are NOT pushed, only the receipt is returned.

function zeroRows(tab) {
  return (values) => ({
    updates: { updatedRows: 0, updatedRange: `${tab}!A200:L${199 + values.length}` },
    pushRows: null,
  });
}
function wrongTab(tab) {
  return (values) => ({
    updates: { updatedRows: values.length, updatedRange: `Wrong_Tab!A2:L${1 + values.length}` },
    pushRows: null,
  });
}
function stringRows(tab) {
  return (values) => ({
    updates: { updatedRows: 'two', updatedRange: `${tab}!A200:L${199 + values.length}` },
    pushRows: null,
  });
}
function missingRows(tab) {
  return (values) => ({
    updates: { updatedRange: `${tab}!A200:L${199 + values.length}` },
    pushRows: null,
  });
}
function nonAStart(tab) {
  return (values) => ({
    updates: { updatedRows: values.length, updatedRange: `${tab}!B200:L${199 + values.length}` },
    pushRows: null,
  });
}
function wrongSpan(tab) {
  return (values) => ({
    // Span is 1 row (A200:L200) while the count claims values.length rows.
    updates: { updatedRows: values.length, updatedRange: `${tab}!A200:L200` },
    pushRows: null,
  });
}
function unparseableRange(tab) {
  return (values) => ({
    updates: { updatedRows: values.length, updatedRange: 'not a range at all' },
    pushRows: null,
  });
}

let serverPromise = null;

after(async () => {
  if (serverPromise) {
    const { server } = await serverPromise;
    await new Promise((resolve) => server.close(resolve));
  }
});

async function baseUrl(t) {
  if (!serverPromise) {
    process.env.ATLAS_API_KEY = 'test-api-key';
    process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
    process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1762-append-proof-idempotency.json');

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
    // The idempotency store persists to disk and rehydrates, so a write_id from an
    // earlier run of this file would be replayed as a duplicate — the recorded
    // response, and NO append. Reset ONCE per file run, not per call: the retry
    // probes need the first write's receipt to survive until the retry posts.
    require('../services/idempotency').resetIdempotencyStore();
  }
  const { base } = await serverPromise;
  return base;
}

async function postJson(t, route, body) {
  const base = await baseUrl(t);
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

async function postCompleteWorkout(t, fields) {
  const base = await baseUrl(t);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const res = await fetch(`${base}/api/complete-workout`, {
    method: 'POST',
    headers: { 'x-atlas-api-key': 'test-api-key' },
    body: form,
  });
  return { res, body: await res.json() };
}

function logWorkoutPayload(sessionId, writeId, extra = {}) {
  return {
    date: DATE,
    session_id: sessionId,
    write_id: writeId,
    log_rows: [
      { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
      { exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2 },
    ],
    ...extra,
  };
}

function logRowsFor(sessionId) {
  return SHEET.Log_Cleaned.slice(1).filter((r) => r[LOG_SESSION_COL] === sessionId);
}

// The fixed outcome for a write whose append proof does not establish the
// requested rows in the requested table: HTTP 500, unverified — never a
// success receipt, never idempotency_status completed.
function assertUnverified(t, res, body, reason) {
  assert.equal(res.status, 500, JSON.stringify(body));
  assert.ok(body.details, 'the unverified outcome is surfaced in the error details');
  assert.equal(body.details.sheet_write, 'unverified', JSON.stringify(body));
  assert.equal(body.details.idempotency_status, 'unverified', JSON.stringify(body));
  if (reason) {
    // Both verdicts ride on a two-tab write; the FAILED one is the one that
    // must name the reason (the other verifies by design).
    const verdicts = [
      body.details.log_write_verification,
      body.details.effort_write_verification,
      body.details.modality_write_verification,
      body.details.note_write_verification,
    ].filter(Boolean);
    const verdict = verdicts.find((v) => v.verified === false) || verdicts[0];
    assert.ok(verdict, 'the failed verdict is attached');
    assert.equal(verdict.verified, false, JSON.stringify(body));
    assert.equal(verdict.reason, reason, JSON.stringify(body));
  }
}

// ── /api/log-workout ────────────────────────────────────────────────────────

test('#1762 log-workout: a zero-row append is a failed write, not a success receipt', async (t) => {
  const sessionId = '20261116-D02-ZERO-1';
  appendOverrides.set('Log_Cleaned', zeroRows('Log_Cleaned'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_zero_1'));
    assertUnverified(t, res, body, 'no_row_count');
    assert.equal(logRowsFor(sessionId).length, 0, 'nothing landed in the Log table');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 log-workout: a wrong-tab append is a failed write', async (t) => {
  const sessionId = '20261116-D02-TAB-1';
  appendOverrides.set('Log_Cleaned', wrongTab('Log_Cleaned'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_tab_1'));
    assertUnverified(t, res, body, 'wrong_tab');
    assert.equal(logRowsFor(sessionId).length, 0, 'nothing landed in the Log table');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 log-workout: a string row count is a failed write', async (t) => {
  const sessionId = '20261116-D02-STR-1';
  appendOverrides.set('Log_Cleaned', stringRows('Log_Cleaned'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_str_1'));
    assertUnverified(t, res, body, 'no_row_count');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 log-workout: a missing row count is a failed write', async (t) => {
  const sessionId = '20261116-D02-MISS-1';
  appendOverrides.set('Log_Cleaned', missingRows('Log_Cleaned'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_miss_1'));
    assertUnverified(t, res, body, 'no_row_count');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 log-workout: a non-A start is a failed write', async (t) => {
  const sessionId = '20261116-D02-NONA-1';
  appendOverrides.set('Log_Cleaned', nonAStart('Log_Cleaned'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_nona_1'));
    assertUnverified(t, res, body, 'range_does_not_start_at_column_a');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 log-workout: a range span disagreeing with the row count is a failed write', async (t) => {
  const sessionId = '20261116-D02-SPAN-1';
  appendOverrides.set('Log_Cleaned', wrongSpan('Log_Cleaned'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_span_1'));
    assertUnverified(t, res, body, 'range_span_disagrees_with_row_count');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 log-workout: an unparseable range is a failed write', async (t) => {
  const sessionId = '20261116-D02-RANGE-1';
  appendOverrides.set('Log_Cleaned', unparseableRange('Log_Cleaned'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_range_1'));
    assertUnverified(t, res, body, 'range_unparseable');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 log-workout: a zero-row Effort append is a failed write even when the Log rows landed', async (t) => {
  const sessionId = '20261116-D02-EFF-1';
  appendOverrides.set('Effort', zeroRows('Effort'));
  try {
    const { res, body } = await postJson(t, '/api/log-workout',
      logWorkoutPayload(sessionId, 'w_1762_eff_1', {
        effort_row: { date: DATE, session_id: sessionId, duration: '00:45:00', active_calories: 400 },
      }));
    assertUnverified(t, res, body, 'no_row_count');
    assert.equal(logRowsFor(sessionId).length, 2, 'the Log rows did land — the write is unverified, not failed');
  } finally {
    appendOverrides.delete('Effort');
  }
});

test('#1762 log-workout: a retry of a zero-row first write replays unverified, never a saved success', async (t) => {
  const sessionId = '20261116-D02-RETRY-1';
  const writeId = 'w_1762_retry_1';
  appendOverrides.set('Log_Cleaned', zeroRows('Log_Cleaned'));
  try {
    const first = await postJson(t, '/api/log-workout', logWorkoutPayload(sessionId, writeId));
    assertUnverified(t, first.res, first.body, 'no_row_count');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
  const callsBefore = appendCalls.filter((c) => c.tab === 'Log_Cleaned').length;
  const retry = await postJson(t, '/api/log-workout', logWorkoutPayload(sessionId, writeId));
  assert.equal(retry.res.status, 500, JSON.stringify(retry.body));
  assert.ok(retry.body.details, 'the retry outcome is surfaced in the error details');
  assert.equal(retry.body.details.sheet_write, 'unverified', 'retry stays unverified, not skipped_duplicate');
  assert.equal(retry.body.details.idempotency_status, 'unverified', JSON.stringify(retry.body));
  assert.equal(
    appendCalls.filter((c) => c.tab === 'Log_Cleaned').length, callsBefore,
    'an unverified retry must not append');
  assert.equal(logRowsFor(sessionId).length, 0, 'nothing landed in the Log table');
});

// ── /api/complete-workout (multipart) ───────────────────────────────────────

test('#1762 complete-workout: a wrong-tab Log append is a failed write', async (t) => {
  const sessionId = '20261116-D02-CW-1';
  appendOverrides.set('Log_Cleaned', wrongTab('Log_Cleaned'));
  try {
    const { res, body } = await postCompleteWorkout(t, {
      date: DATE,
      session_id: sessionId,
      write_id: 'w_1762_cw_1',
      log_rows_json: JSON.stringify([
        { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
      ]),
      effort_json: JSON.stringify({
        date: DATE, session_id: sessionId, duration: '00:45:00',
        active_calories: 400, total_calories: '', average_hr: '', peak_hr: '',
        location: '', notes: '',
      }),
    });
    assertUnverified(t, res, body, 'wrong_tab');
    assert.equal(logRowsFor(sessionId).length, 0, 'nothing landed in the Log table');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 complete-workout: a Log range span disagreeing with the row count is a failed write', async (t) => {
  const sessionId = '20261116-D02-CW-3';
  appendOverrides.set('Log_Cleaned', wrongSpan('Log_Cleaned'));
  try {
    const { res, body } = await postCompleteWorkout(t, {
      date: DATE,
      session_id: sessionId,
      write_id: 'w_1762_cw_3',
      log_rows_json: JSON.stringify([
        { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
        { exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2 },
      ]),
      effort_json: JSON.stringify({
        date: DATE, session_id: sessionId, duration: '00:45:00',
        active_calories: 400, total_calories: '', average_hr: '', peak_hr: '',
        location: '', notes: '',
      }),
    });
    assertUnverified(t, res, body, 'range_span_disagrees_with_row_count');
    assert.equal(logRowsFor(sessionId).length, 0, 'nothing landed in the Log table');
  } finally {
    appendOverrides.delete('Log_Cleaned');
  }
});

test('#1762 complete-workout: a zero-row Effort append is a failed write', async (t) => {
  const sessionId = '20261116-D02-CW-2';
  appendOverrides.set('Effort', zeroRows('Effort'));
  try {
    const { res, body } = await postCompleteWorkout(t, {
      date: DATE,
      session_id: sessionId,
      write_id: 'w_1762_cw_2',
      log_rows_json: JSON.stringify([
        { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
      ]),
      effort_json: JSON.stringify({
        date: DATE, session_id: sessionId, duration: '00:45:00',
        active_calories: 400, total_calories: '', average_hr: '', peak_hr: '',
        location: '', notes: '',
      }),
    });
    assertUnverified(t, res, body, 'no_row_count');
  } finally {
    appendOverrides.delete('Effort');
  }
});

// ── /api/log-modality ───────────────────────────────────────────────────────

test('#1762 log-modality: a zero-row append is a failed write, not a success receipt', async (t) => {
  appendOverrides.set('Modality_Log', zeroRows('Modality_Log'));
  try {
    const { res, body } = await postJson(t, '/api/log-modality', {
      text: 'Run 5 km 30:00', session_id: '20261116-D02-MOD-1', date: DATE, write_id: 'w_1762_mod_1',
    });
    assertUnverified(t, res, body, 'no_row_count');
    assert.equal(SHEET.Modality_Log.length, 1, 'nothing landed in Modality_Log');
  } finally {
    appendOverrides.delete('Modality_Log');
  }
});

// ── the receipt store itself ────────────────────────────────────────────────
// #1762: the verdict must gate the STORED receipt too, and a retry must
// reconcile the stored receipt before replaying it — a route that attaches a
// failed verdict and still claims success must not be able to persist the lie,
// and a receipt stored as completed before this fix must replay as the
// unverified outcome its own verdict states.

test('#1762 idempotency: completeWrite never stores completed when a failed verdict is attached', () => {
  const { beginWrite, completeWrite, peekWrite, resetIdempotencyStore } = require('../services/idempotency');
  resetIdempotencyStore();
  const begun = beginWrite('w_1762_store_1', { endpoint: '/api/log-workout' });
  assert.equal(begun.duplicate, false);
  assert.equal(completeWrite('w_1762_store_1', begun.token, {
    sheet_write: 'success',
    idempotency_status: 'completed',
    log_rows_written: 0,
    log_write_verification: { verified: false, authority: 'append_receipt', reason: 'no_row_count', range: 'Log_Cleaned!A200:L201', rows_written: 0, rows_submitted: 2 },
  }), true);
  const stored = peekWrite('w_1762_store_1');
  assert.equal(stored.status, 'unverified', 'a failed verdict is never stored as completed');
  assert.equal(stored.response.sheet_write, 'unverified');
  assert.equal(stored.response.idempotency_status, 'unverified');
  assert.equal(stored.response.proof_mismatch, true);
});

test('#1762 idempotency: completeWrite keeps a verified success completed', () => {
  const { beginWrite, completeWrite, peekWrite, resetIdempotencyStore } = require('../services/idempotency');
  resetIdempotencyStore();
  const begun = beginWrite('w_1762_store_2', { endpoint: '/api/log-workout' });
  assert.equal(completeWrite('w_1762_store_2', begun.token, {
    sheet_write: 'success',
    idempotency_status: 'completed',
    log_rows_written: 2,
    log_write_verification: { verified: true, authority: 'append_receipt', reason: null, range: 'Log_Cleaned!A200:L201', rows_written: 2, rows_submitted: 2 },
  }), true);
  const stored = peekWrite('w_1762_store_2');
  assert.equal(stored.status, 'completed');
  assert.equal(stored.response.sheet_write, 'success');
});

test('#1762 idempotency: duplicateReplay reconciles a pre-fix completed receipt with a failed verdict', () => {
  const { duplicateReplay } = require('../services/idempotency');
  // A receipt persisted before this fix: stored status completed, sheet_write
  // success — but its own attached verdict says the write never verified.
  const record = {
    status: 'completed',
    response: {
      sheet_write: 'success',
      idempotency_status: 'completed',
      log_rows_written: 0,
      log_write_verification: { verified: false, authority: 'append_receipt', reason: 'no_row_count', range: 'Log_Cleaned!A200:L201', rows_written: 0, rows_submitted: 2 },
    },
  };
  const replay = duplicateReplay(record, 'w_1762_store_3');
  assert.equal(replay.terminal, true, 'the lie replays as terminal, not as a saved success');
  assert.equal(replay.httpStatus, 500);
  assert.equal(replay.body.sheet_write, 'unverified');
  assert.equal(replay.body.idempotency_status, 'unverified');
});

test('#1762 idempotency: duplicateReplay still replays a clean completed receipt as success', () => {
  const { duplicateReplay } = require('../services/idempotency');
  const record = {
    status: 'completed',
    response: {
      sheet_write: 'success',
      idempotency_status: 'completed',
      log_rows_written: 2,
      log_write_verification: { verified: true, authority: 'append_receipt', reason: null, range: 'Log_Cleaned!A200:L201', rows_written: 2, rows_submitted: 2 },
    },
  };
  const replay = duplicateReplay(record, 'w_1762_store_4');
  assert.equal(replay.terminal, false);
  assert.equal(replay.completed, true);
  assert.equal(replay.httpStatus, 200);
});

test('#1762 log-modality: a wrong-tab append is a failed write', async (t) => {
  appendOverrides.set('Modality_Log', wrongTab('Modality_Log'));
  try {
    const { res, body } = await postJson(t, '/api/log-modality', {
      text: 'Run 5 km 30:00', session_id: '20261116-D02-MOD-2', date: DATE, write_id: 'w_1762_mod_2',
    });
    assertUnverified(t, res, body, 'wrong_tab');
    assert.equal(SHEET.Modality_Log.length, 1, 'nothing landed in Modality_Log');
  } finally {
    appendOverrides.delete('Modality_Log');
  }
});

// ── /api/coaching-notes ─────────────────────────────────────────────────────

test('#1762 coaching-notes: a zero-row append is a failed write, not a success receipt', async (t) => {
  appendOverrides.set('Coaching_Notes', zeroRows('Coaching_Notes'));
  try {
    const { res, body } = await postJson(t, '/api/coaching-notes', {
      note: 'Legs felt strong today, steady breathing throughout.',
      write_id: 'w_1762_note_1',
    });
    assertUnverified(t, res, body, 'no_row_count');
    assert.equal(SHEET.Coaching_Notes.length, 1, 'nothing landed in Coaching_Notes');
  } finally {
    appendOverrides.delete('Coaching_Notes');
  }
});

test('#1762 coaching-notes: a wrong-tab append is a failed write', async (t) => {
  appendOverrides.set('Coaching_Notes', wrongTab('Coaching_Notes'));
  try {
    const { res, body } = await postJson(t, '/api/coaching-notes', {
      note: 'Legs felt strong today, steady breathing throughout.',
      write_id: 'w_1762_note_2',
    });
    assertUnverified(t, res, body, 'wrong_tab');
    assert.equal(SHEET.Coaching_Notes.length, 1, 'nothing landed in Coaching_Notes');
  } finally {
    appendOverrides.delete('Coaching_Notes');
  }
});

test('#1762 coaching-notes: a retry of a zero-row first write replays unverified, never a saved success', async (t) => {
  const writeId = 'w_1762_note_retry_1';
  const payload = {
    note: 'Legs felt strong today, steady breathing throughout.',
    write_id: writeId,
  };
  appendOverrides.set('Coaching_Notes', zeroRows('Coaching_Notes'));
  try {
    const first = await postJson(t, '/api/coaching-notes', payload);
    assertUnverified(t, first.res, first.body, 'no_row_count');
  } finally {
    appendOverrides.delete('Coaching_Notes');
  }
  const callsBefore = appendCalls.filter((c) => c.tab === 'Coaching_Notes').length;
  const retry = await postJson(t, '/api/coaching-notes', payload);
  assert.equal(retry.res.status, 500, JSON.stringify(retry.body));
  assert.ok(retry.body.details, 'the retry outcome is surfaced in the error details');
  assert.equal(retry.body.details.sheet_write, 'unverified', 'retry stays unverified, not a 200 replay');
  assert.equal(retry.body.details.idempotency_status, 'unverified', JSON.stringify(retry.body));
  assert.equal(
    appendCalls.filter((c) => c.tab === 'Coaching_Notes').length, callsBefore,
    'an unverified retry must not append');
});
