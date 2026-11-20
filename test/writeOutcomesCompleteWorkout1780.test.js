'use strict';

// #1780 [P1] Write_Outcomes ledger — slice 3b: writer wiring for
// POST /api/complete-workout (multipart), at the route with the real Express
// app and sheets.js stubbed in memory (the #1629 idiom) plus a modeled ledger
// surface (the slice-1 commit fake, lifted to the sheets.js interface:
// commitAtomicBatch applies appendCells + addNamedRange atomically and
// rejects a duplicate marker name with a 400, exactly like Google).
//
// Each probe asserts the WIRED outcome, so every ledger probe FAILS on the
// pre-wiring tree (the route ignores operation_id: the two legacy appends
// run, no outcome row exists, no ledger fields are returned).
//
// Pinned here:
//   · A complete-workout save with a valid operation_id commits the Log rows
//     + the Effort row + outcome + marker in ONE atomic batch — zero legacy
//     appendRows calls — and the response names the operation, the marker,
//     and ledger_outcome 'committed'; a batchUpdate returns no ranges, so
//     logAppendedRange/effortAppendedRange are null and the ledger read-back
//     is the verification.
//   · A retry of the same operation_id after the receipt store is lost
//     replays committed and appends nothing (Q3 at the route).
//   · The same operation_id with different log rows is refused (409) and
//     writes nothing.
//   · A malformed operation_id is a 400 and an operation_id from another
//     cutover is a 409 on this route; both write nothing.
//   · A save with no operation_id takes the legacy path unchanged: the two
//     sequential appends run and no outcome row is minted.
//   · An effort-only ledger save commits Effort + outcome + marker in ONE
//     batch with no Log append.
//   · A ledger commit that cannot be built (Effort tab unknown to the
//     ledger) writes nothing — no partial commit: zero Log rows, zero
//     outcome rows, HTTP 500 unverified.
//   · A preview (test_mode) carrying an operation_id touches no ledger:
//     no batch, no outcome row.
//   · A retry of a complete-workout operation after its save was undone
//     answers reverted and appends nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resetIdempotencyStore } = require('../services/idempotency');
const { resetSessionClaims } = require('../services/sessionWriteClaim');
const {
  logCleanedColumns,
  effortColumns,
  modalityLogColumns,
  sessionPlansColumns,
} = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1780-complete-workout-idempotency.json');
const CUTOVER = '11111111-2222-4333-8444-555555555555';
process.env.ATLAS_WRITE_OUTCOMES_CUTOVER_ID = CUTOVER;

const OP_OTHER_CUTOVER = 'atlas-op-v1:99999999-8888-4777-8666-555555555555:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_CW = `atlas-op-v1:${CUTOVER}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const OP_CW2 = `atlas-op-v1:${CUTOVER}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
const OP_CW_UNDO = `atlas-op-v1:${CUTOVER}:dddddddd-dddd-4ddd-8ddd-dddddddddddd`;

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench|bench press'],
];

// --- Modeled sheet ----------------------------------------------------------

const SHEET = {};
const SHEET_IDS = {};
const TAB_BY_SHEET_ID = {};
let NEXT_SHEET_ID = 1;
const NAMED_RANGES = [];
const state = {
  appends: [],            // every legacy appendRows call: { tab, rows }
  batches: [],            // every commitAtomicBatch call: { requests }
  deletes: [],            // every legacy deleteRowsByRange call: { tab, startIndex, endIndex }
  logCompositeKeys: [],   // session||exercise||set keys the Log tab holds
  effortSessionIds: [],   // session_ids the Effort tab holds
};

function resetSheet() {
  for (const k of Object.keys(SHEET)) delete SHEET[k];
  SHEET.Log_Cleaned = [[...logCleanedColumns]];
  SHEET.Effort = [[...effortColumns]];
  SHEET.Exercise_Catalog = exerciseCatalogRows.map((r) => [...r]);
  SHEET.Session_Plans = [[...sessionPlansColumns]];
  SHEET.Modality_Log = [[...modalityLogColumns]];
  SHEET.Coaching_Notes = [['date', 'note']];
  for (const k of Object.keys(SHEET_IDS)) delete SHEET_IDS[k];
  SHEET_IDS.Log_Cleaned = 1;
  SHEET_IDS.Effort = 2;
  SHEET_IDS.Exercise_Catalog = 3;
  SHEET_IDS.Session_Plans = 4;
  SHEET_IDS.Modality_Log = 5;
  SHEET_IDS.Coaching_Notes = 6;
  for (const k of Object.keys(TAB_BY_SHEET_ID)) delete TAB_BY_SHEET_ID[k];
  TAB_BY_SHEET_ID[1] = 'Log_Cleaned';
  TAB_BY_SHEET_ID[2] = 'Effort';
  TAB_BY_SHEET_ID[3] = 'Exercise_Catalog';
  TAB_BY_SHEET_ID[4] = 'Session_Plans';
  TAB_BY_SHEET_ID[5] = 'Modality_Log';
  TAB_BY_SHEET_ID[6] = 'Coaching_Notes';
  NEXT_SHEET_ID = 7;
  NAMED_RANGES.length = 0;
  state.appends = [];
  state.batches = [];
  state.deletes = [];
  state.logCompositeKeys = [];
  state.effortSessionIds = [];
}

function cellToPlain(cell) {
  if (!cell || typeof cell !== 'object') return '';
  const v = cell.userEnteredValue || {};
  if (v.stringValue !== undefined) return String(v.stringValue);
  if (v.numberValue !== undefined) return String(v.numberValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return '';
}

function snapshotSheet() {
  return {
    sheet: Object.fromEntries(Object.entries(SHEET).map(([k, v]) => [k, v.map((r) => [...r])])),
    named: NAMED_RANGES.map((nr) => ({ ...nr, range: { ...nr.range } })),
    ids: { ...SHEET_IDS },
    byId: { ...TAB_BY_SHEET_ID },
    nextId: NEXT_SHEET_ID,
    keys: [...state.logCompositeKeys],
    efforts: [...state.effortSessionIds],
  };
}

function restoreSheet(snap) {
  for (const k of Object.keys(SHEET)) delete SHEET[k];
  for (const [k, v] of Object.entries(snap.sheet)) SHEET[k] = v;
  NAMED_RANGES.length = 0;
  NAMED_RANGES.push(...snap.named);
  for (const k of Object.keys(SHEET_IDS)) delete SHEET_IDS[k];
  Object.assign(SHEET_IDS, snap.ids);
  for (const k of Object.keys(TAB_BY_SHEET_ID)) delete TAB_BY_SHEET_ID[k];
  Object.assign(TAB_BY_SHEET_ID, snap.byId);
  NEXT_SHEET_ID = snap.nextId;
  state.logCompositeKeys = [...snap.keys];
  state.effortSessionIds = [...snap.efforts];
}

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
    state.appends.push({ tab, rows: rows.map((r) => [...r]) });
    if (!SHEET[tab]) SHEET[tab] = [];
    for (const row of rows) SHEET[tab].push([...row]);
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
  commitAtomicBatch: async (requests) => {
    state.batches.push({ requests: JSON.parse(JSON.stringify(requests)) });
    const snap = snapshotSheet();
    try {
      for (const req of requests || []) {
        if (req.appendCells) {
          const tab = TAB_BY_SHEET_ID[req.appendCells.sheetId];
          if (!tab) throw new Error(`appendCells to unknown sheetId ${req.appendCells.sheetId}`);
          if (!SHEET[tab]) SHEET[tab] = [];
          for (const row of req.appendCells.rows || []) {
            const plain = row.map(cellToPlain);
            SHEET[tab].push(plain);
            if (tab === 'Log_Cleaned') {
              const key = `${plain[1]}||${plain[2]}||${plain[6]}`.toLowerCase();
              if (!state.logCompositeKeys.includes(key)) state.logCompositeKeys.push(key);
            }
            if (tab === 'Effort' && plain[1] && !state.effortSessionIds.includes(String(plain[1]))) {
              state.effortSessionIds.push(String(plain[1]));
            }
          }
        } else if (req.deleteDimension) {
          const range = req.deleteDimension.range || {};
          const tab = TAB_BY_SHEET_ID[range.sheetId];
          if (!tab) throw new Error(`deleteDimension on unknown sheetId ${range.sheetId}`);
          if (range.dimension !== 'ROWS') throw new Error(`deleteDimension only models ROWS, got ${range.dimension}`);
          if (!SHEET[tab]) throw new Error(`deleteDimension on missing tab ${tab}`);
          // Grid indices are 0-based INCLUDING the header row, so they line
          // up with the modeled array (header at index 0).
          SHEET[tab].splice(range.startIndex, range.endIndex - range.startIndex);
        } else if (req.addNamedRange) {
          const nr = req.addNamedRange.namedRange;
          if (NAMED_RANGES.some((e) => e.name === nr.name)) {
            const err = new Error(`Invalid requests[0].addNamedRange: A named range with the name "${nr.name}" already exists.`);
            err.status = 400;
            throw err;
          }
          NAMED_RANGES.push({ name: nr.name, range: { ...nr.range } });
        } else if (req.addSheet) {
          const title = req.addSheet.properties.title;
          if (!SHEET[title]) {
            SHEET[title] = [];
            const id = NEXT_SHEET_ID++;
            SHEET_IDS[title] = id;
            TAB_BY_SHEET_ID[id] = title;
          }
        } else {
          throw new Error(`Unsupported batchUpdate request in fake: ${Object.keys(req)[0]}`);
        }
      }
    } catch (error) {
      restoreSheet(snap);
      throw error;
    }
    return { data: {} };
  },
  getNamedRanges: async () => NAMED_RANGES.map((nr) => ({ name: nr.name, range: { ...nr.range } })),
  getSpreadsheetSheetIds: async () => new Map(Object.entries(SHEET_IDS)),
  ensureSheetTab: async (tab, header) => {
    if (!SHEET[tab]) {
      SHEET[tab] = [Array.isArray(header) ? [...header] : []];
      const id = NEXT_SHEET_ID++;
      SHEET_IDS[tab] = id;
      TAB_BY_SHEET_ID[id] = tab;
      return { existed: false };
    }
    return { existed: true };
  },
  readRange: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async (tab, startIndex, endIndex) => {
    state.deletes.push({ tab, startIndex, endIndex });
    if (!SHEET[tab]) throw new Error(`deleteRowsByRange on missing tab ${tab}`);
    SHEET[tab].splice(startIndex, endIndex - startIndex);
    return { ok: true };
  },
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows.map((r) => [...r]),
  getEffortSessionIds: async () => [...state.effortSessionIds],
  getLogCompositeKeys: async () => [...state.logCompositeKeys],
  getRecentRows: async () => [],
  getSheetRows: async (tab) => {
    if (!SHEET[tab]) return [];
    return SHEET[tab].slice(1).map((r) => [...r]);
  },
  getHeaderRow: async (tab) => {
    if (!SHEET[tab] || SHEET[tab].length === 0) return [];
    return [...SHEET[tab][0]];
  },
  getSpreadsheetTabs: async () => Object.keys(SHEET),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async (fn) => fn(),
  sheetsReadFailureClass: () => null,
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const { app } = require('../index');

function reset() {
  resetIdempotencyStore();
  resetSessionClaims();
  resetSheet();
}

let server;
let baseUrl;
const originalConsoleLog = console.log;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const BENCH_ROWS = [
  { exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 },
  { exercise: 'Bench Press', set_number: 2, weight: 235, reps: 5, rir: 2 },
];
function logRowsOnSheet() {
  return (SHEET.Log_Cleaned || []).slice(1).length;
}

function effortRowsOnSheet() {
  return (SHEET.Effort || []).slice(1).length;
}

function outcomeRows() {
  return (SHEET.Write_Outcomes || []).slice(1);
}

function undoBody({ sessionId, operationId, targetOperationId, rowsToDelete, range } = {}) {
  const body = { session_id: sessionId, rows_to_delete: rowsToDelete, confirm_delete: true };
  if (range) body.log_appended_range = range;
  if (operationId) body.operation_id = operationId;
  if (targetOperationId) body.target_operation_id = targetOperationId;
  return body;
}


// ── complete-workout (multipart) ────────────────────────────────────────────

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

function cwFields({ sessionId, writeId, operationId, rows, effort, testMode } = {}) {
  const fields = {
    date: '2026-06-26',
    session_id: sessionId,
    write_id: writeId,
    log_rows_json: JSON.stringify(rows === undefined ? BENCH_ROWS : rows),
  };
  if (effort !== null && effort !== undefined) {
    fields.effort_json = JSON.stringify({
      date: '2026-06-26', session_id: sessionId, duration: '00:45:00',
      active_calories: 400, total_calories: '', average_hr: '', peak_hr: '',
      location: '', notes: '',
    });
  }
  if (operationId) fields.operation_id = operationId;
  if (testMode) fields.test_mode = 'true';
  return fields;
}

function cwData(res) {
  return (res.body && res.body.data && res.body.data.data) || {};
}

test('#1780 slice 3b: a ledger complete-workout commits Log + Effort + outcome + marker in ONE atomic batch', async () => {
  reset();
  const res = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-A', writeId: '1780-cw-w1', operationId: OP_CW, effort: true,
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = cwData(res);
  assert.equal(data.operation_id, OP_CW);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(data.ledger_marker, 'atlas_receipt_commit_1');
  // A batchUpdate returns no ranges, so a ledger save claims none; the
  // ledger read-back is the verification.
  assert.equal(data.logAppendedRange, null);
  assert.equal(data.effortAppendedRange, null);
  assert.equal(data.log_rows_written, 2);
  assert.equal(data.effort_rows_written, 1);
  assert.equal(data.log_write_verification.verified, true);
  assert.equal(data.log_write_verification.method, 'write_outcomes_ledger');
  assert.equal(data.effort_write_verification.verified, true);
  assert.equal(data.effort_write_verification.method, 'write_outcomes_ledger');
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(state.appends.length, 0, `expected zero legacy appendRows calls, got ${state.appends.length}`);
  assert.equal(state.batches.length, 1, 'exactly one atomic batch');
  const batch = state.batches[0].requests;
  const appends = batch.filter((r) => r.appendCells);
  assert.equal(appends.length, 3, 'Log + Effort + outcome appendCells');
  assert.equal(appends[0].appendCells.sheetId, SHEET_IDS.Log_Cleaned, 'Log appends first');
  assert.equal(appends[1].appendCells.sheetId, SHEET_IDS.Effort, 'Effort appends second');
  assert.equal(appends[2].appendCells.sheetId, SHEET_IDS.Write_Outcomes, 'outcome appends last');
  assert.equal(batch.filter((r) => r.addNamedRange).length, 1, 'one generation marker');
  assert.equal(batch.filter((r) => r.addNamedRange)[0].addNamedRange.namedRange.name, 'atlas_receipt_commit_1');
  assert.equal(outcomeRows().length, 1, 'one outcome row');
  assert.equal(outcomeRows()[0][0], OP_CW);
  assert.equal(outcomeRows()[0][1], 'save');
});

test('#1780 slice 3b: a retry of the same operation_id after the receipt store is lost replays committed and appends nothing', async () => {
  reset();
  const first = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-B', writeId: '1780-cw-w2a', operationId: OP_CW, effort: true,
  }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(cwData(first).ledger_outcome, 'committed');
  // The receipt store is lost (restart); the sheet and ledger survive.
  resetIdempotencyStore();
  const retry = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-B', writeId: '1780-cw-w2b', operationId: OP_CW, effort: true,
  }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const data = cwData(retry);
  assert.equal(data.duplicate_write, true);
  assert.equal(data.operation_id, OP_CW);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(data.log_rows_written, 2);
  assert.equal(data.effort_rows_written, 1);
  assert.equal(logRowsOnSheet(), 2, 'no second Log append');
  assert.equal(effortRowsOnSheet(), 1, 'no second Effort append');
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 1, 'the retry committed no second batch');
  assert.equal(outcomeRows().length, 1, 'no second outcome row');
});

test('#1780 slice 3b: the same operation_id with different log rows is refused (409) and writes nothing', async () => {
  reset();
  const first = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-C', writeId: '1780-cw-w3a', operationId: OP_CW, effort: true,
  }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  resetIdempotencyStore();
  const otherRows = [{ exercise: 'Bench Press', set_number: 1, weight: 185, reps: 8, rir: 1 }];
  const retry = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-C', writeId: '1780-cw-w3b', operationId: OP_CW, rows: otherRows, effort: true,
  }));
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.body.details.code, 'operation_id_payload_mismatch');
  assert.equal(logRowsOnSheet(), 2, 'the committed rows stand; nothing new');
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(state.batches.length, 1, 'no second batch');
  assert.equal(outcomeRows().length, 1);
});

test('#1780 slice 3b: a malformed operation_id is a 400 and an other-cutover ID is a 409; both write nothing', async () => {
  reset();
  const bad = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-D', writeId: '1780-cw-w4a', operationId: 'not-an-operation-id', effort: true,
  }));
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.details.code, 'operation_id_invalid');
  const other = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-D', writeId: '1780-cw-w4b', operationId: OP_OTHER_CUTOVER, effort: true,
  }));
  assert.equal(other.status, 409, JSON.stringify(other.body));
  assert.equal(other.body.details.code, 'operation_id_cutover_mismatch');
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 0);
  assert.equal(outcomeRows().length, 0);
});

test('#1780 slice 3b: no operation_id takes the legacy path unchanged', async () => {
  reset();
  const res = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-E', writeId: '1780-cw-w5', effort: true,
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = cwData(res);
  assert.equal(data.operation_id, undefined);
  assert.equal(data.ledger_outcome, undefined);
  assert.ok(data.logAppendedRange, 'the legacy path still reports its append range');
  assert.equal(data.log_rows_written, 2);
  assert.equal(data.effort_rows_written, 1);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(state.appends.length, 2, 'the two sequential legacy appends run');
  assert.equal(state.appends[0].tab, 'Log_Cleaned');
  assert.equal(state.appends[1].tab, 'Effort');
  assert.equal(state.batches.length, 0, 'no ledger batch');
  assert.equal(outcomeRows().length, 0, 'no outcome row is minted');
});

test('#1780 slice 3b: an effort-only ledger save commits Effort + outcome + marker in ONE batch with no Log append', async () => {
  reset();
  const res = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-F', writeId: '1780-cw-w6', operationId: OP_CW2, rows: [], effort: true,
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = cwData(res);
  assert.equal(data.operation_id, OP_CW2);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(data.ledger_marker, 'atlas_receipt_commit_1');
  assert.equal(data.log_rows_written, 0);
  assert.equal(data.effort_rows_written, 1);
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 1, 'exactly one atomic batch');
  const batch = state.batches[0].requests;
  const appends = batch.filter((r) => r.appendCells);
  assert.equal(appends.length, 2, 'Effort + outcome appendCells only');
  assert.equal(appends[0].appendCells.sheetId, SHEET_IDS.Effort);
  assert.equal(appends[1].appendCells.sheetId, SHEET_IDS.Write_Outcomes);
  assert.equal(outcomeRows().length, 1);
});

test('#1780 slice 3b: a ledger commit that cannot be built writes nothing — no partial commit', async () => {
  reset();
  // The Effort tab is unknown to the ledger's sheet-id map, so the atomic
  // commit cannot be built: the Log rows must not land on their own.
  const savedEffortId = SHEET_IDS.Effort;
  delete SHEET_IDS.Effort;
  delete TAB_BY_SHEET_ID[2];
  try {
    const res = await postCompleteWorkout(cwFields({
      sessionId: '1780-CW-G', writeId: '1780-cw-w7', operationId: OP_CW, effort: true,
    }));
    assert.equal(res.status, 500, JSON.stringify(res.body));
    // The route surfaces the ledger's own code for the unbuildable commit.
    assert.equal(res.body.details.code, 'unknown_tab');
    assert.equal(logRowsOnSheet(), 0, 'no partial Log commit');
    assert.equal(effortRowsOnSheet(), 0);
    assert.equal(outcomeRows().length, 0, 'no outcome row for a failed commit');
    assert.equal(state.appends.length, 0);
    assert.equal(state.batches.length, 0);
  } finally {
    SHEET_IDS.Effort = savedEffortId;
    TAB_BY_SHEET_ID[2] = 'Effort';
  }
});

test('#1780 slice 3b: a preview (test_mode) carrying an operation_id touches no ledger', async () => {
  reset();
  const res = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-H', writeId: '1780-cw-w8', operationId: OP_CW, effort: true, testMode: true,
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 0, 'no ledger batch on a preview');
  assert.equal(outcomeRows().length, 0, 'no outcome row on a preview');
});

test('#1780 slice 3b: a retry of a complete-workout operation after its save was undone answers reverted and appends nothing', async () => {
  reset();
  const first = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-I', writeId: '1780-cw-w9a', operationId: OP_CW, effort: true,
  }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(cwData(first).ledger_outcome, 'committed');
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  // Undo the save through the ledger undo (no positional range).
  const undo = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-CW-I', operationId: OP_CW_UNDO, targetOperationId: OP_CW, rowsToDelete: 2,
  }));
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  resetIdempotencyStore();
  const retry = await postCompleteWorkout(cwFields({
    sessionId: '1780-CW-I', writeId: '1780-cw-w9b', operationId: OP_CW, effort: true,
  }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const data = cwData(retry);
  assert.equal(data.duplicate_write, true);
  assert.equal(data.operation_id, OP_CW);
  assert.equal(data.ledger_outcome, 'reverted');
  assert.equal(logRowsOnSheet(), 0, 'the undone rows are not resurrected');
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 2, 'save batch + undo batch only; the retry committed none');
  assert.equal(outcomeRows().length, 2, 'save + undo outcome rows only');
});
