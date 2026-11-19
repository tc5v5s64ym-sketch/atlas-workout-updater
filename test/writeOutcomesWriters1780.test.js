'use strict';

// #1780 [P1] Write_Outcomes ledger — slice 3a: writer wiring for
// POST /api/log-workout/undo-last, POST /api/log-modality and
// POST /api/coaching-notes, at the route with the real Express app and
// sheets.js stubbed in memory (the #1629 idiom) plus a modeled ledger
// surface (the slice-1 commit fake, lifted to the sheets.js interface:
// commitAtomicBatch applies appendCells + deleteDimension + addNamedRange
// atomically and rejects a duplicate marker name with a 400, exactly like
// Google).
//
// Each probe asserts the WIRED outcome, so every ledger probe FAILS on the
// pre-wiring tree (the route ignores operation_id: undo-last requires a
// positional range, modality/coaching-notes take the legacy append path,
// no outcome row exists, no ledger fields are returned).
//
// Pinned here:
//   · An undo carrying a fresh operation_id + the save's target_operation_id
//     (and NO positional range — a ledger save returns none) derives the
//     target rows from the ledger evidence + the live sheet and commits the
//     Effort + Log deletes + undo outcome + marker in ONE atomic batch —
//     zero legacy deleteRowsByRange calls — and the response names the undo
//     operation, the marker, and ledger_outcome 'reverted'.
//   · A retry of the same undo operation_id after the receipt store is lost
//     replays already-undone and deletes nothing (Q3 at the route).
//   · A second undo operation targeting an already-reverted save answers
//     already-undone and deletes nothing; it mints no second undo row.
//   · The same undo operation_id with a different payload is refused (409)
//     and deletes nothing.
//   · An undo operation_id without a target is a 400; an undo targeting a
//     save with no ledger row is a 409; both delete nothing.
//   · An undo with a positional range AND an operation_id + target commits
//     the given range atomically (the range path is kept, not replaced).
//   · An undo with no operation_id takes the legacy path unchanged: the
//     legacy deletes run and no undo outcome row is minted.
//   · A modality save with a valid operation_id commits the Modality_Log row
//     + outcome + marker in ONE atomic batch — zero legacy appendRows calls.
//   · A modality retry after the receipt store is lost replays committed and
//     appends nothing; the same operation_id with different text is refused.
//   · A modality save whose row is already on the sheet (legacy first save)
//     commits an outcome-only batch — the row is not duplicated.
//   · A coaching-note save with a valid operation_id commits the note row +
//     outcome + marker in ONE atomic batch — zero legacy appendRows calls;
//     its retry replays committed; a different note under the same ID is refused.
//   · Modality / coaching-notes saves with no operation_id take the legacy
//     path unchanged. A malformed operation_id is a 400 and an operation_id
//     from another cutover is a 409 on all three routes; both write nothing.

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
const { canonicalPayloadHash, encodeOutcomeRow } = require('../services/writeOutcomes');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1780-writers-idempotency.json');
const CUTOVER = '11111111-2222-4333-8444-555555555555';
process.env.ATLAS_WRITE_OUTCOMES_CUTOVER_ID = CUTOVER;

const OP_A = `atlas-op-v1:${CUTOVER}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const OP_UNDO = `atlas-op-v1:${CUTOVER}:dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
const OP_UNDO2 = `atlas-op-v1:${CUTOVER}:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`;
const OP_MOD = `atlas-op-v1:${CUTOVER}:22222222-2222-4222-8222-222222222222`;
const OP_NOTE = `atlas-op-v1:${CUTOVER}:33333333-3333-4333-8333-333333333333`;
const OP_OTHER_CUTOVER = 'atlas-op-v1:99999999-8888-4777-8666-555555555555:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
const EFFORT_ROW = ['2026-06-26', 'placeholder', 45, 300, 400, 120, 150, 'Home', ''];

function logRowsOnSheet() {
  return (SHEET.Log_Cleaned || []).slice(1).length;
}

function effortRowsOnSheet() {
  return (SHEET.Effort || []).slice(1).length;
}

function modalityRowsOnSheet() {
  return (SHEET.Modality_Log || []).slice(1).length;
}

function noteRowsOnSheet() {
  return (SHEET.Coaching_Notes || []).slice(1).length;
}

function outcomeRows() {
  return (SHEET.Write_Outcomes || []).slice(1);
}

function saveBody(sessionId, writeId, operationId, rows = BENCH_ROWS, effort = EFFORT_ROW) {
  const body = {
    session_id: sessionId,
    date: '2026-06-26',
    log_rows: rows,
    write_id: writeId,
  };
  if (effort !== null && effort !== undefined) body.effort_row = effort;
  if (operationId) body.operation_id = operationId;
  return body;
}

async function seedLedgerSave(sessionId, writeId, operationId) {
  const res = await post('/api/log-workout', saveBody(sessionId, writeId, operationId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.ledger_outcome, 'committed');
  return res.body.data;
}

function undoBody({ sessionId, operationId, targetOperationId, rowsToDelete, range } = {}) {
  const body = { session_id: sessionId, rows_to_delete: rowsToDelete, confirm_delete: true };
  if (range) body.log_appended_range = range;
  if (operationId) body.operation_id = operationId;
  if (targetOperationId) body.target_operation_id = targetOperationId;
  return body;
}

// ── undo-last ─────────────────────────────────────────────────────────────

test('#1780 slice 3a: a ledger undo (operation_id + target, no range) commits Effort + Log deletes + outcome + marker in ONE atomic batch', async () => {
  reset();
  const save = await seedLedgerSave('1780-UNDO-A', '1780-undo-w-save', OP_A);
  assert.equal(save.log_rows_written, 2);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(state.batches.length, 1, 'the seed save commits exactly one batch');

  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-A', operationId: OP_UNDO, targetOperationId: OP_A, rowsToDelete: 2,
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data || res.body;
  assert.equal(data.rows_deleted, 2);
  assert.equal(data.operation_id, OP_UNDO);
  assert.equal(data.ledger_outcome, 'reverted');
  assert.equal(data.ledger_marker, 'atlas_receipt_commit_2');
  // The rows are gone from both tabs; zero legacy deletes ran.
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(state.deletes.length, 0, `expected no legacy deleteRowsByRange calls, got ${state.deletes.length}`);
  assert.equal(state.batches.length, 2, 'exactly one undo batch on top of the save batch');
  // The undo batch deletes both tabs and mints the undo outcome + marker.
  const undoBatch = state.batches[1].requests;
  const deletes = undoBatch.filter((r) => r.deleteDimension);
  assert.equal(deletes.length, 2, 'the undo batch must carry one deleteDimension per tab');
  assert.equal(deletes[0].deleteDimension.range.sheetId, SHEET_IDS.Effort, 'Effort deletes first, as on the legacy path');
  assert.equal(deletes[1].deleteDimension.range.sheetId, SHEET_IDS.Log_Cleaned);
  assert.equal(outcomeRows().length, 2, 'save + undo outcome rows');
  assert.equal(outcomeRows()[1][0], OP_UNDO);
  assert.equal(outcomeRows()[1][1], 'undo');
  assert.equal(outcomeRows()[1][3], OP_A, 'the undo outcome targets the save');
  assert.equal(NAMED_RANGES.length, 2);
  assert.equal(NAMED_RANGES[1].name, 'atlas_receipt_commit_2');
});

test('#1780 slice 3a: retry of the same undo operation_id after the receipt store is lost replays already-undone and deletes nothing (Q3)', async () => {
  reset();
  await seedLedgerSave('1780-UNDO-Q3', '1780-undo-w-q3', OP_A);
  const first = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-Q3', operationId: OP_UNDO, targetOperationId: OP_A, rowsToDelete: 2,
  }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(logRowsOnSheet(), 0);
  // The free-plan restart: the in-memory/file receipt store is gone, but the
  // sheet — and the ledger on it — survives.
  resetIdempotencyStore();
  resetSessionClaims();
  const retry = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-Q3', operationId: OP_UNDO, targetOperationId: OP_A, rowsToDelete: 2,
  }));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const data = retry.body.data || retry.body;
  assert.equal(data.already_undone, true);
  assert.equal(data.ledger_outcome, 'reverted');
  assert.equal(data.duplicate_write, true);
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(outcomeRows().length, 2, 'the retry must not mint a second undo row');
  assert.equal(state.batches.length, 2, 'the retry must not commit a second batch');
});

test('#1780 slice 3a: a second undo operation targeting an already-reverted save answers already-undone and deletes nothing', async () => {
  reset();
  await seedLedgerSave('1780-UNDO-REV', '1780-undo-w-rev', OP_A);
  const first = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-REV', operationId: OP_UNDO, targetOperationId: OP_A, rowsToDelete: 2,
  }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-REV', operationId: OP_UNDO2, targetOperationId: OP_A, rowsToDelete: 2,
  }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const data = second.body.data || second.body;
  assert.equal(data.already_undone, true);
  assert.equal(data.ledger_outcome, 'reverted');
  assert.equal(outcomeRows().length, 2, 'the second undo mints no undo row');
  assert.equal(state.batches.length, 2, 'the second undo commits no batch');
});

test('#1780 slice 3a: an undo whose rows_to_delete disagrees with the target save is refused and deletes nothing', async () => {
  reset();
  await seedLedgerSave('1780-UNDO-MM', '1780-undo-w-mm', OP_A);
  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-MM', operationId: OP_UNDO, targetOperationId: OP_A, rowsToDelete: 1,
  }));
  // rows_to_delete 1 disagrees with the 2-row save: the undo is refused
  // before any delete (the range derivation cannot match the count).
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: an undo operation_id without a target is a 400 and deletes nothing', async () => {
  reset();
  await seedLedgerSave('1780-UNDO-NT', '1780-undo-w-nt', OP_A);
  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-NT', operationId: OP_UNDO, rowsToDelete: 2,
  }));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /undo_without_target/);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: an undo targeting a save with no ledger row is a 409 and deletes nothing', async () => {
  reset();
  await seedLedgerSave('1780-UNDO-TM', '1780-undo-w-tm', OP_A);
  const ghost = `atlas-op-v1:${CUTOVER}:ffffffff-ffff-4fff-8fff-ffffffffffff`;
  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-TM', operationId: OP_UNDO, targetOperationId: ghost, rowsToDelete: 2,
  }));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /undo_target_missing/);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: an undo with a positional range AND an operation_id + target commits the given range atomically', async () => {
  reset();
  // Seed the save outcome row the way the ledger would have minted it, and
  // the rows it stands for, at known sheet positions.
  const saveRow = encodeOutcomeRow({
    operationId: OP_A,
    kind: 'save',
    payloadHash: canonicalPayloadHash({
      session_id: '1780-UNDO-RANGE', date: '2026-06-26',
      log_rows: BENCH_ROWS, effort_row: EFFORT_ROW,
    }),
    targetOperationId: null,
    evidence: { session_id: '1780-UNDO-RANGE', marker: 'atlas_receipt_commit_1', log_rows: 2, effort: true },
  });
  SHEET.Write_Outcomes = [[...require('../services/writeOutcomes').WRITE_OUTCOMES_HEADER], saveRow];
  SHEET_IDS.Write_Outcomes = 10;
  TAB_BY_SHEET_ID[10] = 'Write_Outcomes';
  NAMED_RANGES.push({
    name: 'atlas_receipt_commit_1',
    range: { sheetId: 10, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
  });
  const save = await post('/api/log-workout', saveBody('1780-UNDO-RANGE', '1780-undo-w-range', null));
  assert.equal(save.status, 200, JSON.stringify(save.body));
  // The legacy save above appended the rows at sheet rows 2-3; the undo
  // targets them by that range. (The seeded outcome row is what the undo
  // looks the target up in; the legacy save's own rows stand for it.)
  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-RANGE', operationId: OP_UNDO, targetOperationId: OP_A,
    rowsToDelete: 2, range: 'Log_Cleaned!A2:L3',
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data || res.body;
  assert.equal(data.rows_deleted, 2);
  assert.equal(data.ledger_outcome, 'reverted');
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(state.deletes.length, 0, 'the ranged ledger undo must not use legacy deletes');
  assert.equal(outcomeRows().length, 2);
  assert.equal(outcomeRows()[1][1], 'undo');
});

test('#1780 slice 3a: an undo with no operation_id takes the legacy path and mints no undo outcome row', async () => {
  reset();
  const save = await post('/api/log-workout', saveBody('1780-UNDO-LEGACY', '1780-undo-w-legacy', null));
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-LEGACY', rowsToDelete: 2, range: 'Log_Cleaned!A2:L3',
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(state.deletes.length, 2, 'the legacy path still deletes Effort + Log by range');
  assert.equal(SHEET.Write_Outcomes, undefined, 'a legacy undo must not create the ledger tab');
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 3a: a malformed undo operation_id is a 400 and deletes nothing', async () => {
  reset();
  await seedLedgerSave('1780-UNDO-BAD', '1780-undo-w-bad', OP_A);
  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-BAD', operationId: 'not-an-operation-id', targetOperationId: OP_A, rowsToDelete: 2,
  }));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /operation_id_invalid/);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: an undo operation_id from another cutover is a 409 and deletes nothing', async () => {
  reset();
  await seedLedgerSave('1780-UNDO-XC', '1780-undo-w-xc', OP_A);
  const res = await post('/api/log-workout/undo-last', undoBody({
    sessionId: '1780-UNDO-XC', operationId: OP_OTHER_CUTOVER, targetOperationId: OP_A, rowsToDelete: 2,
  }));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /operation_id_cutover_mismatch/);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

// ── log-modality ────────────────────────────────────────────────────────────

const MODALITY_TEXT = 'Run 5 km 32:10 RPE 7 avg HR 151';
const MODALITY_TEXT_2 = 'Elliptical 30 min RPE 6 avg HR 142';

function modalityBody(sessionId, writeId, operationId, text = MODALITY_TEXT) {
  const body = { text, session_id: sessionId, date: '2026-06-26', write_id: writeId };
  if (operationId) body.operation_id = operationId;
  return body;
}

test('#1780 slice 3a: a modality save with a valid operation_id commits the row + outcome + marker in ONE atomic batch', async () => {
  reset();
  const res = await post('/api/log-modality', modalityBody('1780-MOD-A', '1780-mod-w-a', OP_MOD));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.sheet_write, 'success');
  assert.equal(data.operation_id, OP_MOD);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(data.ledger_marker, 'atlas_receipt_commit_1');
  assert.equal(modalityRowsOnSheet(), 1);
  assert.equal(state.appends.length, 0, `expected no legacy appendRows calls, got ${state.appends.length}`);
  assert.equal(state.batches.length, 1, 'exactly one atomic batch');
  assert.equal(outcomeRows().length, 1);
  assert.equal(outcomeRows()[0][0], OP_MOD);
  assert.equal(outcomeRows()[0][1], 'save');
  assert.equal(NAMED_RANGES.length, 1);
});

test('#1780 slice 3a: a modality retry after the receipt store is lost replays committed and appends nothing', async () => {
  reset();
  const first = await post('/api/log-modality', modalityBody('1780-MOD-Q5', '1780-mod-w-q5', OP_MOD));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  resetIdempotencyStore();
  resetSessionClaims();
  const retry = await post('/api/log-modality', modalityBody('1780-MOD-Q5', '1780-mod-w-q5', OP_MOD));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.ledger_outcome, 'committed');
  assert.equal(retry.body.data.duplicate_write, true);
  assert.equal(modalityRowsOnSheet(), 1, 'the retry must not append a second row');
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: the same modality operation_id with different text is refused and appends nothing', async () => {
  reset();
  const first = await post('/api/log-modality', modalityBody('1780-MOD-MM', '1780-mod-w-mm', OP_MOD));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retry = await post('/api/log-modality', modalityBody('1780-MOD-MM', '1780-mod-w-mm-2', OP_MOD, MODALITY_TEXT_2));
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.match(JSON.stringify(retry.body), /operation_id_payload_mismatch/);
  assert.equal(modalityRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: a modality save whose row is already on the sheet commits an outcome-only batch and does not duplicate the row', async () => {
  reset();
  // The row landed by a legacy save (no operation_id): same text, session,
  // date. The ledger attempt finds it by read-back and records its outcome
  // without appending a second row.
  const legacy = await post('/api/log-modality', modalityBody('1780-MOD-RB', '1780-mod-w-rb-legacy', null));
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(modalityRowsOnSheet(), 1);
  const res = await post('/api/log-modality', modalityBody('1780-MOD-RB', '1780-mod-w-rb', OP_MOD));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.sheet_write, 'success');
  assert.equal(res.body.data.ledger_outcome, 'committed');
  assert.equal(res.body.data.verified_by_readback, true);
  assert.equal(modalityRowsOnSheet(), 1, 'the row must not be duplicated');
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1, 'exactly one outcome-only batch');
  const batch = state.batches[0].requests;
  assert.equal(batch.filter((r) => r.appendCells && TAB_BY_SHEET_ID[r.appendCells.sheetId] === 'Modality_Log').length, 0,
    'the outcome-only batch appends no Modality_Log row');
});

test('#1780 slice 3a: a modality save with no operation_id takes the legacy path and creates no ledger tab', async () => {
  reset();
  const res = await post('/api/log-modality', modalityBody('1780-MOD-LEGACY', '1780-mod-w-legacy', null));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.sheet_write, 'success');
  assert.equal(res.body.data.operation_id, undefined);
  assert.equal(state.appends.length, 1);
  assert.equal(state.batches.length, 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
});

test('#1780 slice 3a: a malformed modality operation_id is a 400 and writes nothing', async () => {
  reset();
  const res = await post('/api/log-modality', modalityBody('1780-MOD-BAD', '1780-mod-w-bad', 'not-an-operation-id'));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(modalityRowsOnSheet(), 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 3a: a modality operation_id from another cutover is a 409 and writes nothing', async () => {
  reset();
  const res = await post('/api/log-modality', modalityBody('1780-MOD-XC', '1780-mod-w-xc', OP_OTHER_CUTOVER));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /operation_id_cutover_mismatch/);
  assert.equal(modalityRowsOnSheet(), 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
  assert.equal(state.batches.length, 0);
});

// ── coaching-notes ─────────────────────────────────────────────────────────

function noteBody(writeId, operationId, note = 'Focus on bracing before the pull.') {
  const body = { note, write_id: writeId };
  if (operationId) body.operation_id = operationId;
  return body;
}

test('#1780 slice 3a: a coaching-note save with a valid operation_id commits the note + outcome + marker in ONE atomic batch', async () => {
  reset();
  const res = await post('/api/coaching-notes', noteBody('1780-note-w-a', OP_NOTE));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.sheet_written, true);
  assert.equal(data.operation_id, OP_NOTE);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(data.ledger_marker, 'atlas_receipt_commit_1');
  assert.equal(noteRowsOnSheet(), 1);
  assert.equal(state.appends.length, 0, `expected no legacy appendRows calls, got ${state.appends.length}`);
  assert.equal(state.batches.length, 1, 'exactly one atomic batch');
  assert.equal(outcomeRows().length, 1);
  assert.equal(outcomeRows()[0][0], OP_NOTE);
  assert.equal(outcomeRows()[0][1], 'save');
  assert.equal(NAMED_RANGES.length, 1);
});

test('#1780 slice 3a: a coaching-note retry after the receipt store is lost replays committed and appends nothing', async () => {
  reset();
  const first = await post('/api/coaching-notes', noteBody('1780-note-w-q5', OP_NOTE));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  resetIdempotencyStore();
  resetSessionClaims();
  const retry = await post('/api/coaching-notes', noteBody('1780-note-w-q5', OP_NOTE));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.ledger_outcome, 'committed');
  assert.equal(retry.body.data.duplicate_write, true);
  assert.equal(noteRowsOnSheet(), 1, 'the retry must not append a second note');
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: the same coaching-note operation_id with a different note is refused and appends nothing', async () => {
  reset();
  const first = await post('/api/coaching-notes', noteBody('1780-note-w-mm', OP_NOTE));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retry = await post('/api/coaching-notes', noteBody('1780-note-w-mm-2', OP_NOTE, 'Keep the chest up on the squat.'));
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.match(JSON.stringify(retry.body), /operation_id_payload_mismatch/);
  assert.equal(noteRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 3a: a coaching-note save with no operation_id takes the legacy path and creates no ledger tab', async () => {
  reset();
  const res = await post('/api/coaching-notes', noteBody('1780-note-w-legacy', null));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.sheet_written, true);
  assert.equal(res.body.data.operation_id, undefined);
  assert.equal(state.appends.length, 1);
  assert.equal(state.batches.length, 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
});

test('#1780 slice 3a: a malformed coaching-note operation_id is a 400 and writes nothing', async () => {
  reset();
  const res = await post('/api/coaching-notes', noteBody('1780-note-w-bad', 'not-an-operation-id'));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(noteRowsOnSheet(), 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 3a: a coaching-note operation_id from another cutover is a 409 and writes nothing', async () => {
  reset();
  const res = await post('/api/coaching-notes', noteBody('1780-note-w-xc', OP_OTHER_CUTOVER));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /operation_id_cutover_mismatch/);
  assert.equal(noteRowsOnSheet(), 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
  assert.equal(state.batches.length, 0);
});
