'use strict';

// #1780 [P1] Write_Outcomes ledger — slice 2a: writer wiring for
// POST /api/log-workout, at the route with the real Express app and
// sheets.js stubbed in memory (the #1629 idiom) plus a modeled ledger
// surface (the slice-1 commit fake, lifted to the sheets.js interface:
// commitAtomicBatch applies appendCells + addNamedRange atomically and
// rejects a duplicate marker name with a 400, exactly like Google).
//
// Each probe asserts the WIRED outcome, so every ledger probe FAILS on the
// pre-wiring tree (the route ignores operation_id: the legacy appends run,
// no outcome row exists, no ledger fields are returned).
//
// Pinned here:
//   · A save carrying a valid operation_id commits Log + Effort + outcome +
//     marker in ONE atomic batch — zero legacy appendRows calls — and the
//     response names the operation, the marker, and the ledger read-back as
//     its verification.
//   · A dry-run preview carrying an operation_id writes nothing.
//   · A retry of the same operation_id after the receipt store is lost
//     (resetIdempotencyStore models the free-plan restart) replays the
//     committed outcome from the ledger and writes nothing (Q5 at the route).
//   · The same operation_id with a different payload is refused (409) and
//     writes nothing.
//   · A deliberate identical second save under a NEW operation_id is refused
//     by the route's existing duplicate-session guard (409) — the ledger
//     would allow it, the route's session rule wins, and no second outcome
//     row is minted.
//   · A malformed operation_id is a 400; an operation_id from another
//     cutover is a 409; both write nothing.
//   · A save with no operation_id takes the legacy path unchanged: the
//     legacy appends run and no Write_Outcomes tab is created.
//   · A save whose ledger row is superseded by an undo answers reverted
//     (200), never the success it once was.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resetIdempotencyStore } = require('../services/idempotency');
const { resetSessionClaims } = require('../services/sessionWriteClaim');
const { logCleanedColumns, effortColumns } = require('../config/columns');
const { canonicalPayloadHash, encodeOutcomeRow } = require('../services/writeOutcomes');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1780-route-idempotency.json');
const CUTOVER = '11111111-2222-4333-8444-555555555555';
process.env.ATLAS_WRITE_OUTCOMES_CUTOVER_ID = CUTOVER;

const OP_A = `atlas-op-v1:${CUTOVER}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const OP_B = `atlas-op-v1:${CUTOVER}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
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
  logCompositeKeys: [],   // session||exercise||set keys the Log tab holds
  effortSessionIds: [],   // session_ids the Effort tab holds
};

function resetSheet() {
  for (const k of Object.keys(SHEET)) delete SHEET[k];
  SHEET.Log_Cleaned = [[...logCleanedColumns]];
  SHEET.Effort = [[...effortColumns]];
  SHEET.Exercise_Catalog = exerciseCatalogRows.map((r) => [...r]);
  for (const k of Object.keys(SHEET_IDS)) delete SHEET_IDS[k];
  SHEET_IDS.Log_Cleaned = 1;
  SHEET_IDS.Effort = 2;
  SHEET_IDS.Exercise_Catalog = 3;
  for (const k of Object.keys(TAB_BY_SHEET_ID)) delete TAB_BY_SHEET_ID[k];
  TAB_BY_SHEET_ID[1] = 'Log_Cleaned';
  TAB_BY_SHEET_ID[2] = 'Effort';
  TAB_BY_SHEET_ID[3] = 'Exercise_Catalog';
  NEXT_SHEET_ID = 4;
  NAMED_RANGES.length = 0;
  state.appends = [];
  state.batches = [];
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
  deleteRowsByRange: async () => ({ ok: true }),
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

async function postLogWorkout(body) {
  const res = await fetch(`${baseUrl}/api/log-workout`, {
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

test('#1780 slice 2a: a save with a valid operation_id commits Log + Effort + outcome + marker in ONE atomic batch', async () => {
  reset();
  const res = await postLogWorkout(saveBody('1780-ROUTE-A', '1780-route-w-a', OP_A));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.sheet_write, 'success');
  assert.equal(data.operation_id, OP_A);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(data.ledger_marker, 'atlas_receipt_commit_1');
  assert.equal(data.log_rows_written, 2);
  assert.equal(data.effort_rows_written, 1);
  assert.equal(data.log_write_verification && data.log_write_verification.verified, true);
  assert.equal(data.log_write_verification.method, 'write_outcomes_ledger');
  // Zero legacy appends: the data went through the atomic batch only.
  assert.equal(state.appends.length, 0, `expected no legacy appendRows calls, got ${state.appends.length}`);
  assert.equal(state.batches.length, 1, 'exactly one atomic batch');
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  // Exactly one outcome row, for this operation, kind save.
  assert.equal(outcomeRows().length, 1);
  assert.equal(outcomeRows()[0][0], OP_A);
  assert.equal(outcomeRows()[0][1], 'save');
  assert.equal(NAMED_RANGES.length, 1);
  assert.equal(NAMED_RANGES[0].name, 'atlas_receipt_commit_1');
});

test('#1780 slice 2a: a dry-run preview carrying an operation_id writes nothing', async () => {
  reset();
  const body = saveBody('1780-ROUTE-PREVIEW', '1780-route-w-preview', OP_A);
  body.test_mode = 'true';
  const res = await postLogWorkout(body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.test_mode, true);
  assert.equal(state.batches.length, 0, 'a preview must not commit a batch');
  assert.equal(state.appends.length, 0, 'a preview must not append');
  assert.equal(SHEET.Write_Outcomes, undefined, 'a preview must not create the ledger tab');
});

test('#1780 slice 2a: retry of the same operation_id after the receipt store is lost replays committed and writes nothing (Q5)', async () => {
  reset();
  const body = saveBody('1780-ROUTE-Q5', '1780-route-w-q5', OP_A);
  const first = await postLogWorkout(body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.ledger_outcome, 'committed');
  // The free-plan restart: the in-memory/file receipt store is gone, but the
  // sheet — and the ledger on it — survives.
  resetIdempotencyStore();
  resetSessionClaims();
  const retry = await postLogWorkout(body);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.ledger_outcome, 'committed');
  assert.equal(retry.body.data.duplicate_write, true);
  assert.equal(retry.body.data.sheet_written, false);
  assert.equal(logRowsOnSheet(), 2, 'the retry must not append a second copy');
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1, 'the retry must not mint a second outcome row');
  assert.equal(state.batches.length, 1, 'the retry must not commit a second batch');
});

test('#1780 slice 2a: the same operation_id with a different payload is refused and writes nothing', async () => {
  reset();
  const first = await postLogWorkout(saveBody('1780-ROUTE-MM', '1780-route-w-mm', OP_A));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const changed = [
    { exercise: 'Bench Press', set_number: 1, weight: 999, reps: 5, rir: 2 },
    { exercise: 'Bench Press', set_number: 2, weight: 235, reps: 5, rir: 2 },
  ];
  const retry = await postLogWorkout(saveBody('1780-ROUTE-MM', '1780-route-w-mm-2', OP_A, changed));
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.match(JSON.stringify(retry.body), /operation_id_payload_mismatch/);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 2a: a deliberate identical second save under a NEW operation_id is refused by the duplicate-session guard, with no second outcome row', async () => {
  reset();
  const first = await postLogWorkout(saveBody('1780-ROUTE-B', '1780-route-w-b1', OP_A));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await postLogWorkout(saveBody('1780-ROUTE-B', '1780-route-w-b2', OP_B));
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(JSON.stringify(second.body), /Duplicate session/);
  assert.equal(logRowsOnSheet(), 2);
  assert.equal(effortRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1, 'the refused second save mints no outcome row');
  assert.equal(state.batches.length, 1);
});

test('#1780 slice 2a: a malformed operation_id is a 400 and writes nothing', async () => {
  reset();
  const res = await postLogWorkout(saveBody('1780-ROUTE-BAD', '1780-route-w-bad', 'not-an-operation-id'));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 2a: an operation_id from another cutover is a 409 and writes nothing', async () => {
  reset();
  const res = await postLogWorkout(saveBody('1780-ROUTE-XC', '1780-route-w-xc', OP_OTHER_CUTOVER));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(JSON.stringify(res.body), /operation_id_cutover_mismatch/);
  assert.equal(logRowsOnSheet(), 0);
  assert.equal(effortRowsOnSheet(), 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 2a: a save with no operation_id takes the legacy path and creates no ledger tab', async () => {
  reset();
  const res = await postLogWorkout(saveBody('1780-ROUTE-LEGACY', '1780-route-w-legacy', null));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.sheet_write, 'success');
  assert.equal(res.body.data.operation_id, undefined);
  assert.equal(state.appends.length, 2, 'the legacy path still uses appendRows for Log + Effort');
  assert.equal(state.batches.length, 0);
  assert.equal(SHEET.Write_Outcomes, undefined, 'a legacy save must not create the ledger tab');
});

test('#1780 slice 2a: a save whose ledger row is superseded by an undo answers reverted, never success', async () => {
  reset();
  const first = await postLogWorkout(saveBody('1780-ROUTE-REV', '1780-route-w-rev', OP_A));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // The undo-last wiring lands in slice 2b; seed the undo outcome row the
  // way that slice will mint it, so this probe pins the route's reverted arm.
  const undoOp = `atlas-op-v1:${CUTOVER}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
  const undoRow = encodeOutcomeRow({
    operationId: undoOp,
    kind: 'undo',
    payloadHash: canonicalPayloadHash({ undo: '1780-ROUTE-REV' }),
    targetOperationId: OP_A,
    evidence: { session_id: '1780-ROUTE-REV', marker: 'atlas_receipt_commit_2' },
  });
  SHEET.Write_Outcomes.push(undoRow);
  NAMED_RANGES.push({
    name: 'atlas_receipt_commit_2',
    range: { sheetId: SHEET_IDS.Write_Outcomes, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
  });
  resetIdempotencyStore();
  resetSessionClaims();
  const retry = await postLogWorkout(saveBody('1780-ROUTE-REV', '1780-route-w-rev-2', OP_A));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.ledger_outcome, 'reverted');
  assert.equal(retry.body.data.sheet_write, 'reverted');
  assert.equal(retry.body.data.sheet_written, false);
  assert.equal(logRowsOnSheet(), 2, 'the reverted replay must not append');
  assert.equal(outcomeRows().length, 2, 'the reverted replay must not mint another outcome row');
});
