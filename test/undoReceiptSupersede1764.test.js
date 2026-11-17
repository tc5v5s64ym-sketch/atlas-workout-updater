'use strict';

// #1764 Part 1 [P1][Astra D04] — VERIFY FIRST: undo does not supersede the
// save receipt — a deleted workout replays as verified success.
//
// The Astra Ultra re-audit (2026-11-14, at 66fec920) captured it: save ->
// successful undo -> retry of the original save ID returns
// {sheet_write:'skipped_duplicate', original_sheet_write:'success',
// idempotency_status:'completed',
// log_write_verification:{verified:true}} with Log_Cleaned [] and Effort [].
// The receipt survives the undo and the retry replays historical proof as
// current saved state.
//
// Invariant to enforce (issue #1764): a confirmed undo marks the affected
// save outcome as reverted; a retry can never present historical proof as
// current saved state.
//
// Part 1 scope (receipts design-proof, issue comment 6897178508): supersede
// the local save receipt after a confirmed undo; reverify workbook state
// before replaying success; when local history is lost, the answer is
// unknown/absent — never verified success over an empty record. No schema
// dependency; Part 2 (#1780, Write_Outcomes ledger) is a separate build.
//
// Proved here at the live path: real POSTs against the real Express app with
// only `googleapis` faked, over a FULLY MODELED sheet — appends push rows,
// deletes splice them, reads return live state — so save -> undo -> retry
// runs through the real endpoints with real state transitions. Each probe
// asserts the FIXED outcome, so every probe that exercises the lie FAILS at
// the s3 head until the fix lands.
//
// Variant set (issue acceptance): six same-ID/fresh-ID resave variants —
// with/without Effort row, decimal and string loads, date/session variants.
// After undo, the same-ID retry must report the reverted state, and a
// genuine resave must land exactly once. Plus: double undo, receipt/
// workbook contradictions, receipt-destroying restart.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { logCleanedColumns, effortColumns, sessionPlansColumns } = require('../config/columns');

const DATE = '2026-11-16';
const LOG_SESSION_COL = logCleanedColumns.indexOf('session_id');
const EFFORT_SESSION_COL = effortColumns.indexOf('session_id');

// One shared modeled sheet per file; each test writes under its own session
// id so the duplicate guards never see another test's rows.
const SHEET = {
  Log_Cleaned: [[...logCleanedColumns]],
  Effort: [[...effortColumns]],
  Exercise_Catalog: [
    ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
    ['Back Squat', 'Back Squat', 'Legs', 'SQ01'],
  ],
  Session_Plans: [[...sessionPlansColumns]],
  Coaching_Notes: [['date', 'note']],
  Modality_Log: [[...require('../config/columns').modalityLogColumns]],
};

// Distinct sheet ids per tab, so deleteDimension requests identify their tab.
const SHEET_IDS = {};
Object.keys(SHEET).forEach((tab, i) => { SHEET_IDS[tab] = i + 1; });
const TAB_BY_SHEET_ID = {};
Object.entries(SHEET_IDS).forEach(([tab, id]) => { TAB_BY_SHEET_ID[id] = tab; });

const appendCalls = [];

function colToIdx(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

// Parse the A1 ranges sheets.js actually issues: `Tab!A:Z`, `Tab!B:G`,
// `Tab!B:B`, `Tab!1:1`, `Tab!A2:L3`. Returns the column span and the
// 1-based row span (null = whole tab), or null when unparseable.
function parseA1(range) {
  const s = String(range);
  let m = s.match(/^([^!]+)!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (m) {
    return {
      tab: m[1],
      startCol: colToIdx(m[2]),
      endCol: m[4] ? colToIdx(m[4]) : colToIdx(m[2]),
      startRow: Number(m[3]),
      endRow: m[5] ? Number(m[5]) : Number(m[3]),
    };
  }
  m = s.match(/^([^!]+)!([A-Z]+):([A-Z]+)$/);
  if (m) return { tab: m[1], startCol: colToIdx(m[2]), endCol: colToIdx(m[3]), startRow: null, endRow: null };
  m = s.match(/^([^!]+)!(\d+):(\d+)$/);
  if (m) return { tab: m[1], startCol: 0, endCol: 25, startRow: Number(m[2]), endRow: Number(m[3]) };
  return null;
}

// The values a values.get / batchGet for `range` would return from the live
// modeled sheet: rows sliced to the requested column and row spans. The real
// API returns only the cells inside the range, so the dedupe keys, the
// session-id column reads and the header reads all see exactly what the
// sheet holds — a fake that returned whole rows would hand
// getLogCompositeKeys the wrong columns.
function readRangeValues(range, majorDimension) {
  const parsed = parseA1(range);
  if (!parsed) throw new Error(`Unable to parse range: ${range}`);
  const rows = SHEET[parsed.tab];
  if (!rows) throw new Error(`Unable to parse range: ${range}`);
  let out;
  if (/!1:1$/.test(range)) {
    out = [rows[0].slice()];
  } else {
    const sliced = rows.map((r) => r.slice(parsed.startCol, parsed.endCol + 1));
    out = parsed.startRow === null
      ? sliced
      : sliced.slice(parsed.startRow - 1, parsed.endRow);
  }
  if (majorDimension === 'COLUMNS') {
    const width = Math.max(0, ...out.map((r) => r.length));
    const cols = [];
    for (let c = 0; c < width; c++) cols.push(out.map((r) => (r[c] === undefined ? '' : r[c])));
    return cols;
  }
  return out.map((r) => [...r]);
}

function honestReceipt(tab, values) {
  const n = values.length;
  const last = SHEET[tab].length + n;
  return { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:L${last}` };
}

function makeFake() {
  return {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: Object.keys(SHEET).map((title) => ({
            properties: { title, sheetId: SHEET_IDS[title] },
          })),
        },
      }),
      batchUpdate: async ({ requestBody }) => {
        for (const req of (requestBody && requestBody.requests) || []) {
          if (req.deleteDimension) {
            const dim = req.deleteDimension.range;
            const tab = TAB_BY_SHEET_ID[dim.sheetId];
            if (!tab || dim.dimension !== 'ROWS') throw new Error('Unsupported deleteDimension request in fake');
            // Indices are 0-based sheet rows (row 1 = header = index 0);
            // SHEET arrays hold the header at index 0, so splice directly.
            SHEET[tab].splice(dim.startIndex, dim.endIndex - dim.startIndex);
          }
          // addSheet (ensureSheetTab) is a no-op here: no test creates a tab.
        }
        return { data: {} };
      },
      values: {
        get: async ({ range, majorDimension }) => ({
          data: { values: readRangeValues(range, majorDimension) },
        }),
        batchGet: async ({ ranges }) => ({
          data: {
            valueRanges: ranges.map((range) => ({ range, values: readRangeValues(range) })),
          },
        }),
        append: async ({ range, requestBody }) => {
          const tab = String(range).split('!')[0];
          const values = requestBody.values || [];
          appendCalls.push({ tab, rows: values.length });
          if (!SHEET[tab]) SHEET[tab] = [];
          const updates = honestReceipt(tab, values);
          for (const r of values) SHEET[tab].push(r.map((v) => (v === null || v === undefined ? '' : String(v))));
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

async function baseUrl() {
  if (!serverPromise) {
    process.env.ATLAS_API_KEY = 'test-key-1764';
    process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
    process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
    process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1764-undo-receipt-idempotency.json');

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
    // response, and NO append. Reset ONCE per file run, not per test: the retry
    // probes need the first write's receipt to survive until the retry posts.
    require('../services/idempotency').resetIdempotencyStore();
  }
  const { base } = await serverPromise;
  return base;
}

async function postJson(route, body) {
  const base = await baseUrl();
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-key-1764' },
    body: JSON.stringify(body),
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

function effortRow(sessionId) {
  return {
    date: DATE,
    session_id: sessionId,
    duration: 58,
    active_calories: 320,
    total_calories: 420,
    average_hr: 120,
    peak_hr: 150,
  };
}

function logRowsFor(sessionId) {
  return SHEET.Log_Cleaned.slice(1).filter((r) => r[LOG_SESSION_COL] === sessionId);
}

function effortRowsFor(sessionId) {
  return SHEET.Effort.slice(1).filter((r) => r[EFFORT_SESSION_COL] === sessionId);
}

async function saveAndUndo(sessionId, writeId, extra = {}) {
  const payload = logWorkoutPayload(sessionId, writeId, extra);
  const before = appendCalls.length;
  const save = await postJson('/api/log-workout', payload);
  assert.equal(save.res.status, 200, JSON.stringify(save.body));
  assert.equal(save.body.status, 'ok');
  assert.equal(save.body.data.sheet_write, 'success', JSON.stringify(save.body));
  assert.equal(save.body.data.log_write_verification.verified, true, JSON.stringify(save.body));
  const logRange = save.body.data.logAppendedRange;
  const logRowsWritten = save.body.data.log_rows_written;
  assert.ok(logRange, 'save returns its appended range for undo');
  assert.equal(logRowsFor(sessionId).length, logRowsWritten, 'rows are on the modeled sheet');
  if (extra.effort_row) {
    assert.equal(effortRowsFor(sessionId).length, 1, 'effort row is on the modeled sheet');
  }

  const undo = await postJson('/api/log-workout/undo-last', {
    log_appended_range: logRange,
    session_id: sessionId,
    rows_to_delete: logRowsWritten,
    confirm_delete: true,
  });
  assert.equal(undo.res.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.data.rows_deleted, logRowsWritten, JSON.stringify(undo.body));
  assert.equal(logRowsFor(sessionId).length, 0, 'undo removed the log rows from the sheet');
  assert.equal(effortRowsFor(sessionId).length, 0, 'undo removed the effort row from the sheet');
  return { payload, save, undo, appendCallsBefore: before };
}

// The fixed outcome for a same-ID retry of a save a confirmed undo removed:
// HTTP 200, but the body states the save no longer stands — `reverted`, never
// a replayed success, never a verified:true over an empty record.
function assertReverted(res, body, writeId) {
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'ok');
  const data = body.data;
  assert.equal(data.duplicate_write, true, JSON.stringify(body));
  assert.equal(data.write_id, writeId, JSON.stringify(body));
  assert.equal(data.idempotency_status, 'reverted', JSON.stringify(body));
  assert.equal(data.sheet_write, 'reverted', JSON.stringify(body));
  assert.equal(data.sheet_written, false, JSON.stringify(body));
  assert.equal(data.save_reverted, true, JSON.stringify(body));
  assert.ok(data.log_write_verification, 'the reverted answer carries a verdict, not silence');
  assert.equal(data.log_write_verification.verified, false, JSON.stringify(body));
  assert.equal(data.log_write_verification.reason, 'save_reverted', JSON.stringify(body));
}

// The fixed outcome for a same-ID retry whose receipt contradicts the
// workbook (rows gone with no undo on record): HTTP 500 unverified — the
// receipt cannot be confirmed, so no success is claimed over an empty record.
function assertContradictionUnverified(res, body) {
  assert.equal(res.status, 500, JSON.stringify(body));
  assert.ok(body.details, 'the unverified outcome is surfaced in the error details');
  assert.equal(body.details.sheet_write, 'unverified', JSON.stringify(body));
  assert.equal(body.details.idempotency_status, 'unverified', JSON.stringify(body));
  assert.equal(body.details.proof_mismatch, true, JSON.stringify(body));
}

// ── Variant set: save -> undo -> same-ID retry must report reverted,
// and a genuine fresh-ID resave must land exactly once ────────────────────

test('#1764 Part 1: no-Effort save, undo, same-ID retry reports reverted; fresh resave lands once', async () => {
  const sessionId = '1764-V1-NOEFFORT';
  const writeId = 'write-1764-v1';
  const { payload } = await saveAndUndo(sessionId, writeId);

  const retry = await postJson('/api/log-workout', payload);
  assertReverted(retry.res, retry.body, writeId);
  assert.equal(appendCalls.filter((c) => c.tab === 'Log_Cleaned').length, 1, 'retry appended nothing');

  const resave = await postJson('/api/log-workout', { ...payload, write_id: 'write-1764-v1-resave' });
  assert.equal(resave.res.status, 200, JSON.stringify(resave.body));
  assert.equal(resave.body.data.sheet_write, 'success', JSON.stringify(resave.body));
  assert.equal(resave.body.data.duplicate_write, false, JSON.stringify(resave.body));
  assert.equal(resave.body.data.log_rows_written, 2, JSON.stringify(resave.body));
  assert.equal(logRowsFor(sessionId).length, 2, 'resave landed exactly once');
  assert.equal(appendCalls.filter((c) => c.tab === 'Log_Cleaned').length, 2, 'exactly one resave append');
});

test('#1764 Part 1: with-Effort save, undo, same-ID retry reports reverted; fresh resave lands once', async () => {
  const sessionId = '1764-V2-EFFORT';
  const writeId = 'write-1764-v2';
  const { payload } = await saveAndUndo(sessionId, writeId, { effort_row: effortRow(sessionId) });

  const retry = await postJson('/api/log-workout', payload);
  assertReverted(retry.res, retry.body, writeId);

  const resave = await postJson('/api/log-workout', { ...payload, write_id: 'write-1764-v2-resave' });
  assert.equal(resave.res.status, 200, JSON.stringify(resave.body));
  assert.equal(resave.body.data.sheet_write, 'success', JSON.stringify(resave.body));
  assert.equal(logRowsFor(sessionId).length, 2, 'resave landed exactly once');
  assert.equal(effortRowsFor(sessionId).length, 1, 'effort resave landed exactly once');
});

test('#1764 Part 1: decimal loads, undo, same-ID retry reports reverted', async () => {
  const sessionId = '1764-V3-DECIMAL';
  const writeId = 'write-1764-v3';
  const payload = logWorkoutPayload(sessionId, writeId, {
    log_rows: [
      { exercise: 'Back Squat', set_number: 1, weight: 137.5, reps: 5, rir: 2 },
      { exercise: 'Back Squat', set_number: 2, weight: 137.5, reps: 5, rir: 2 },
    ],
  });
  const save = await postJson('/api/log-workout', payload);
  assert.equal(save.res.status, 200, JSON.stringify(save.body));
  const undo = await postJson('/api/log-workout/undo-last', {
    log_appended_range: save.body.data.logAppendedRange,
    session_id: sessionId,
    rows_to_delete: 2,
    confirm_delete: true,
  });
  assert.equal(undo.res.status, 200, JSON.stringify(undo.body));
  assert.equal(logRowsFor(sessionId).length, 0, 'undo removed the decimal-load rows');

  const retry = await postJson('/api/log-workout', payload);
  assertReverted(retry.res, retry.body, writeId);
});

test('#1764 Part 1: string loads, undo, same-ID retry reports reverted', async () => {
  const sessionId = '1764-V4-STRING';
  const writeId = 'write-1764-v4';
  const payload = logWorkoutPayload(sessionId, writeId, {
    log_rows: [
      { exercise: 'Back Squat', set_number: 1, weight: '225.5', reps: '5', rir: 2 },
      { exercise: 'Back Squat', set_number: 2, weight: '225.5', reps: '5', rir: 2 },
    ],
  });
  const save = await postJson('/api/log-workout', payload);
  assert.equal(save.res.status, 200, JSON.stringify(save.body));
  const undo = await postJson('/api/log-workout/undo-last', {
    log_appended_range: save.body.data.logAppendedRange,
    session_id: sessionId,
    rows_to_delete: 2,
    confirm_delete: true,
  });
  assert.equal(undo.res.status, 200, JSON.stringify(undo.body));
  assert.equal(logRowsFor(sessionId).length, 0, 'undo removed the string-load rows');

  const retry = await postJson('/api/log-workout', payload);
  assertReverted(retry.res, retry.body, writeId);
});

test('#1764 Part 1: different date, undo, same-ID retry reports reverted', async () => {
  const sessionId = '1764-V5-DATE';
  const writeId = 'write-1764-v5';
  const payload = logWorkoutPayload(sessionId, writeId, { date: '2026-11-15' });
  const save = await postJson('/api/log-workout', payload);
  assert.equal(save.res.status, 200, JSON.stringify(save.body));
  const undo = await postJson('/api/log-workout/undo-last', {
    log_appended_range: save.body.data.logAppendedRange,
    session_id: sessionId,
    rows_to_delete: 2,
    confirm_delete: true,
  });
  assert.equal(undo.res.status, 200, JSON.stringify(undo.body));

  const retry = await postJson('/api/log-workout', payload);
  assertReverted(retry.res, retry.body, writeId);
});

test('#1764 Part 1: different session, undo, same-ID retry reports reverted', async () => {
  const sessionId = '1764-V6-SESSION-9f2c4a1e';
  const writeId = 'write-1764-v6';
  const { payload } = await saveAndUndo(sessionId, writeId);

  const retry = await postJson('/api/log-workout', payload);
  assertReverted(retry.res, retry.body, writeId);
});

// ── Double undo: the receipt stays reverted, the second undo refuses ──────

test('#1764 Part 1: double undo keeps the receipt reverted; second undo refuses', async () => {
  const sessionId = '1764-DOUBLE-UNDO';
  const writeId = 'write-1764-double';
  const { payload, save } = await saveAndUndo(sessionId, writeId);

  const secondUndo = await postJson('/api/log-workout/undo-last', {
    log_appended_range: save.body.data.logAppendedRange,
    session_id: sessionId,
    rows_to_delete: 2,
    confirm_delete: true,
  });
  assert.equal(secondUndo.res.status, 409, JSON.stringify(secondUndo.body));

  const retry = await postJson('/api/log-workout', payload);
  assertReverted(retry.res, retry.body, writeId);
});

// ── Receipt/workbook contradictions: rows gone with no undo on record ──────

test('#1764 Part 1: receipt contradicts the workbook (rows deleted outside undo) — retry is unverified, never success', async () => {
  const sessionId = '1764-CONTRADICTION';
  const writeId = 'write-1764-contradiction';
  const payload = logWorkoutPayload(sessionId, writeId, { effort_row: effortRow(sessionId) });
  const save = await postJson('/api/log-workout', payload);
  assert.equal(save.res.status, 200, JSON.stringify(save.body));
  assert.equal(logRowsFor(sessionId).length, 2);
  assert.equal(effortRowsFor(sessionId).length, 1);

  // External deletion: the rows vanish with no undo-last call, so no receipt
  // was superseded — the retry must still refuse to replay the success.
  SHEET.Log_Cleaned = SHEET.Log_Cleaned.filter((r) => r[LOG_SESSION_COL] !== sessionId);
  SHEET.Effort = SHEET.Effort.filter((r) => r[EFFORT_SESSION_COL] !== sessionId);
  assert.equal(logRowsFor(sessionId).length, 0);
  assert.equal(effortRowsFor(sessionId).length, 0);

  const retry = await postJson('/api/log-workout', payload);
  assertContradictionUnverified(retry.res, retry.body);
});

test('#1764 Part 1: Effort row deleted outside undo — retry is unverified, never success', async () => {
  const sessionId = '1764-CONTRADICTION-EFFORT';
  const writeId = 'write-1764-contradiction-effort';
  const payload = logWorkoutPayload(sessionId, writeId, { effort_row: effortRow(sessionId) });
  const save = await postJson('/api/log-workout', payload);
  assert.equal(save.res.status, 200, JSON.stringify(save.body));
  assert.equal(effortRowsFor(sessionId).length, 1);

  // Only the Effort row vanishes. The Log rows survive, but the receipt
  // claims both — replaying it would still present a save that no longer
  // stands in full.
  SHEET.Effort = SHEET.Effort.filter((r) => r[EFFORT_SESSION_COL] !== sessionId);
  assert.equal(effortRowsFor(sessionId).length, 0);
  assert.equal(logRowsFor(sessionId).length, 2);

  const retry = await postJson('/api/log-workout', payload);
  assertContradictionUnverified(retry.res, retry.body);
});

// ── Receipt-destroying restart: no receipt, no replayed success ────────────

test('#1764 Part 1: receipt-destroying restart after undo — same-ID retry re-saves honestly, never replays success over an empty record', async () => {
  const sessionId = '1764-RESTART';
  const writeId = 'write-1764-restart';
  const { payload } = await saveAndUndo(sessionId, writeId);
  assert.equal(logRowsFor(sessionId).length, 0, 'undo removed the rows');

  // The restart destroys the receipt store (the /tmp file is ephemeral on the
  // free plan, and a crashed process may hold a receipt only in memory).
  require('../services/idempotency').resetIdempotencyStore();

  const retry = await postJson('/api/log-workout', payload);
  assert.equal(retry.res.status, 200, JSON.stringify(retry.body));
  // No receipt survives, so this is a FRESH write, not a replay: it re-saves
  // the workout (the rows are genuinely on the sheet again) and says so.
  assert.equal(retry.body.data.duplicate_write, false, JSON.stringify(retry.body));
  assert.equal(retry.body.data.sheet_write, 'success', JSON.stringify(retry.body));
  assert.equal(retry.body.data.log_rows_written, 2, JSON.stringify(retry.body));
  assert.equal(logRowsFor(sessionId).length, 2, 'retry re-saved exactly once');
});
