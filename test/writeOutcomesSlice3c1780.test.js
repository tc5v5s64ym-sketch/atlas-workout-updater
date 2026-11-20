'use strict';

// #1780 [P1] Write_Outcomes ledger — slice 3c: writer wiring for
// POST /api/bodyweight, POST /api/constraints, and the Session_Plans
// closeout-event store (POST /api/session-plans/accept|outcome|closeout
// plus the server-emitted finalized closeout inside POST /api/log-workout),
// at the route with the real Express app and sheets.js stubbed in memory
// (the #1629 idiom) plus a modeled ledger surface (the slice-1 commit fake,
// lifted to the sheets.js interface: commitAtomicBatch applies appendCells
// + addNamedRange atomically and rejects a duplicate marker name with a 400,
// exactly like Google).
//
// Each probe asserts the WIRED outcome, so every ledger probe FAILS on the
// pre-wiring tree (the routes ignore operation_id: bodyweight/constraints
// take the legacy append path, the Session_Plans store appends without a
// ledger outcome, no outcome row exists, no ledger fields are returned).
//
// Pinned here:
//   · A bodyweight save with a valid operation_id commits the Bodyweight row
//     + outcome + marker in ONE atomic batch — zero legacy appendRows calls
//     — and the response names the operation, the marker, and
//     ledger_outcome 'committed'.
//   · A bodyweight retry after the receipt store is lost replays committed
//     and appends nothing (Q3); the same operation_id with a different weight
//     is refused (409) and appends nothing.
//   · A bodyweight preview (test_mode) never touches the ledger, even when
//     it carries an operation_id.
//   · A constraint save with a valid operation_id commits the Constraints row
//     + outcome + marker in ONE atomic batch — zero legacy appendRows calls;
//     its retry replays committed; a different rule under the same ID is
//     refused.
//   · Bodyweight / constraints saves with no operation_id take the legacy
//     path unchanged. A malformed operation_id is a 400 and an operation_id
//     from another cutover is a 409 on both routes; both write nothing.
//   · A Session_Plans closeout with a valid operation_id commits the event
//     row + outcome + marker in ONE atomic batch — zero legacy appendRows
//     calls — and the proof envelope names the ledger operation, outcome and
//     marker. Accept (N rows) and outcome (1 row) behave the same way.
//   · A Session_Plans retry under the same operation_id replays committed
//     and appends nothing; the same operation_id with a different status is
//     refused (an error envelope naming the payload mismatch — the capture
//     layer answers 200 with an envelope, never a bare HTTP error) and
//     appends nothing. A FRESH operation_id for an already-captured event
//     commits an outcome-only batch — the row is not duplicated.
//   · Session_Plans saves with no operation_id take the legacy path
//     unchanged. A malformed operation_id is a 400 and an operation_id from
//     another cutover is a 409 on all three routes; both write nothing.
//   · With ATLAS_SESSION_PLANS_WRITE off, a valid operation_id still answers
//     the disabled envelope and mints no outcome row.
//   · A ledger POST /api/log-workout with closeout_context also commits the
//     server-emitted finalized closeout through the ledger (its own fresh
//     operation): one Session_Plans row, a second outcome row. A retry of the
//     same save operation replays the save and commits the closeout
//     outcome-only — still exactly one closeout row.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resetIdempotencyStore } = require('../services/idempotency');
const { resetSessionClaims } = require('../services/sessionWriteClaim');
// #1791 — a live /api/log-workout write requires the signed preview digest.
const { postLiveLogWorkout } = require('./helpers/previewDigest');
const {
  logCleanedColumns,
  effortColumns,
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
process.env.ATLAS_IDEMPOTENCY_FILE = path.join(os.tmpdir(), 'atlas-1780-slice3c-idempotency.json');
process.env.ATLAS_SESSION_PLANS_WRITE = '1';
const CUTOVER = '11111111-2222-4333-8444-555555555555';
process.env.ATLAS_WRITE_OUTCOMES_CUTOVER_ID = CUTOVER;

const OP_BW = `atlas-op-v1:${CUTOVER}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const OP_CON = `atlas-op-v1:${CUTOVER}:cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
const OP_SP_ACCEPT = `atlas-op-v1:${CUTOVER}:11111111-1111-4111-8111-111111111111`;
const OP_SP_OUTCOME = `atlas-op-v1:${CUTOVER}:22222222-2222-4222-8222-222222222222`;
const OP_SP_CLOSE = `atlas-op-v1:${CUTOVER}:33333333-3333-4333-8333-333333333333`;
const OP_SP_CLOSE2 = `atlas-op-v1:${CUTOVER}:33333333-3333-4333-8333-333333333334`;
const OP_SAVE = `atlas-op-v1:${CUTOVER}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const OP_OTHER_CUTOVER = 'atlas-op-v1:99999999-8888-4777-8666-555555555555:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_MALFORMED = 'not-an-operation-id';

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
};

function resetSheet() {
  for (const k of Object.keys(SHEET)) delete SHEET[k];
  SHEET.Log_Cleaned = [[...logCleanedColumns]];
  SHEET.Effort = [[...effortColumns]];
  SHEET.Exercise_Catalog = exerciseCatalogRows.map((r) => [...r]);
  SHEET.Session_Plans = [[...sessionPlansColumns]];
  SHEET.Bodyweight = [['date', 'weight', 'notes']];
  SHEET.Constraints = [['date', 'kind', 'target', 'rule', 'note']];
  for (const k of Object.keys(SHEET_IDS)) delete SHEET_IDS[k];
  SHEET_IDS.Log_Cleaned = 1;
  SHEET_IDS.Effort = 2;
  SHEET_IDS.Exercise_Catalog = 3;
  SHEET_IDS.Session_Plans = 4;
  SHEET_IDS.Bodyweight = 5;
  SHEET_IDS.Constraints = 6;
  for (const k of Object.keys(TAB_BY_SHEET_ID)) delete TAB_BY_SHEET_ID[k];
  TAB_BY_SHEET_ID[1] = 'Log_Cleaned';
  TAB_BY_SHEET_ID[2] = 'Effort';
  TAB_BY_SHEET_ID[3] = 'Exercise_Catalog';
  TAB_BY_SHEET_ID[4] = 'Session_Plans';
  TAB_BY_SHEET_ID[5] = 'Bodyweight';
  TAB_BY_SHEET_ID[6] = 'Constraints';
  NEXT_SHEET_ID = 7;
  NAMED_RANGES.length = 0;
  state.appends = [];
  state.batches = [];
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

// A1 range reader for the modeled sheet: single-letter columns only
// (Session_Plans!A1:M1 header reads and Session_Plans!A1:A1 header probes).
// Anything unparseable reads as empty, like the slice-3a fake.
function readA1Range(range) {
  const m = /^([^!]+)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(range || ''));
  if (!m) return [];
  const rows = SHEET[m[1]] || [];
  const c1 = m[2].charCodeAt(0) - 64;
  const c2 = m[4].charCodeAt(0) - 64;
  const r1 = Number(m[3]);
  const r2 = Number(m[5]);
  const out = [];
  for (let r = r1; r <= r2; r++) {
    const row = rows[r - 1] || [];
    out.push(row.slice(c1 - 1, c2));
  }
  return out;
}

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map((r) => [...r]) });
    if (!SHEET[tab]) SHEET[tab] = [];
    for (const row of rows) SHEET[tab].push([...row]);
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
            SHEET[tab].push(row.map(cellToPlain));
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
  readRange: async (range) => readA1Range(range),
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async (tab, startIndex, endIndex) => {
    if (!SHEET[tab]) throw new Error(`deleteRowsByRange on missing tab ${tab}`);
    SHEET[tab].splice(startIndex, endIndex - startIndex);
    return { ok: true };
  },
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows.map((r) => [...r]),
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
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
  confirmTabMissing: async () => false,
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

function bodyweightRowsOnSheet() {
  return (SHEET.Bodyweight || []).slice(1).length;
}

function constraintRowsOnSheet() {
  return (SHEET.Constraints || []).slice(1).length;
}

function sessionPlanRowsOnSheet() {
  return (SHEET.Session_Plans || []).slice(1).length;
}

function outcomeRows() {
  return (SHEET.Write_Outcomes || []).slice(1);
}

function batchAppendTabs(batch) {
  return (batch.requests || [])
    .filter((r) => r.appendCells)
    .map((r) => TAB_BY_SHEET_ID[r.appendCells.sheetId]);
}

function batchHasMarker(batch) {
  return (batch.requests || []).some((r) => r.addNamedRange
    && typeof r.addNamedRange.namedRange.name === 'string'
    && r.addNamedRange.namedRange.name.startsWith('atlas_receipt_commit_'));
}

function bwBody({ weight = 185, notes = 'morning', writeId = 'bw-w-1', operationId = null } = {}) {
  const body = { date: '2026-06-26', weight, notes, write_id: writeId };
  if (operationId) body.operation_id = operationId;
  return body;
}

function conBody({ kind = 'equipment', target = 'Bench Press', rule = 'avoid', note = '', writeId = 'con-w-1', operationId = null } = {}) {
  const body = { kind, target, rule, note, write_id: writeId };
  if (operationId) body.operation_id = operationId;
  return body;
}

const SP_SESSION = { session_id: '2026-06-26-AM-01', session_date: '2026-06-26', plan_version: 'pv_sp1' };

function spAcceptBody({ items = null, operationId = null } = {}) {
  const body = {
    ...SP_SESSION,
    items: items || [
      { plan_item_id: 'pi_bench', planned_lift_code: 'BEN01' },
      { plan_item_id: 'pi_row', planned_lift_code: 'ROW01' },
    ],
  };
  if (operationId) body.operation_id = operationId;
  return body;
}

function spOutcomeBody({ outcome = 'skipped', operationId = null } = {}) {
  const body = {
    ...SP_SESSION,
    item: { plan_item_id: 'pi_bench', planned_lift_code: 'BEN01', outcome },
  };
  if (operationId) body.operation_id = operationId;
  return body;
}

function spCloseoutBody({ closeoutStatus = 'finalized', operationId = null } = {}) {
  const body = { ...SP_SESSION, closeout_status: closeoutStatus };
  if (operationId) body.operation_id = operationId;
  return body;
}

// ── bodyweight ────────────────────────────────────────────────────────────

test('#1780 slice 3c: a bodyweight save with a valid operation_id commits the row + outcome + marker in ONE atomic batch', async () => {
  reset();
  const before = state.batches.length;
  const res = await post('/api/bodyweight', bwBody({ operationId: OP_BW }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.sheet_written, true);
  assert.equal(data.operation_id, OP_BW);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(typeof data.ledger_marker, 'string');
  assert.ok(data.ledger_marker.startsWith('atlas_receipt_commit_'));
  assert.deepEqual(data.bodyweight_write_verification, { verified: true, method: 'write_outcomes_ledger' });
  assert.equal(bodyweightRowsOnSheet(), 1);
  assert.deepEqual(SHEET.Bodyweight[1], ['2026-06-26', '185', 'morning']);
  assert.equal(state.appends.length, 0, 'no legacy appendRows call on the ledger path');
  assert.equal(state.batches.length, before + 1, 'exactly one atomic batch');
  const batch = state.batches[state.batches.length - 1];
  assert.deepEqual(batchAppendTabs(batch), ['Bodyweight', 'Write_Outcomes']);
  assert.ok(batchHasMarker(batch));
  assert.equal(outcomeRows().length, 1);
  assert.equal(outcomeRows()[0][0], OP_BW);
});

test('#1780 slice 3c: a bodyweight retry after the receipt store is lost replays committed and appends nothing (Q3)', async () => {
  reset();
  const first = await post('/api/bodyweight', bwBody({ operationId: OP_BW }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  resetIdempotencyStore(); // the receipt store is lost (restart)
  const batchesBefore = state.batches.length;
  const res = await post('/api/bodyweight', bwBody({ operationId: OP_BW }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.ledger_outcome, 'committed');
  assert.equal(res.body.data.duplicate_write, true);
  assert.equal(bodyweightRowsOnSheet(), 1, 'no second row');
  assert.equal(outcomeRows().length, 1, 'no second outcome row');
  assert.equal(state.batches.length, batchesBefore, 'the replay writes no batch');
});

test('#1780 slice 3c: the same bodyweight operation_id with a different weight is refused and appends nothing', async () => {
  reset();
  const first = await post('/api/bodyweight', bwBody({ operationId: OP_BW }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  resetIdempotencyStore();
  const res = await post('/api/bodyweight', bwBody({ weight: 190, writeId: 'bw-w-2', operationId: OP_BW }));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(bodyweightRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
});

test('#1780 slice 3c: a bodyweight save with no operation_id takes the legacy path and creates no ledger tab', async () => {
  reset();
  const res = await post('/api/bodyweight', bwBody({}));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.sheet_written, true);
  assert.equal(res.body.data.operation_id, undefined);
  assert.equal(bodyweightRowsOnSheet(), 1);
  assert.equal(state.appends.length, 1);
  assert.equal(SHEET.Write_Outcomes, undefined);
});

test('#1780 slice 3c: a malformed bodyweight operation_id is a 400 and writes nothing', async () => {
  reset();
  const res = await post('/api/bodyweight', bwBody({ operationId: OP_MALFORMED }));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(bodyweightRowsOnSheet(), 0);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 3c: a bodyweight operation_id from another cutover is a 409 and writes nothing', async () => {
  reset();
  const res = await post('/api/bodyweight', bwBody({ operationId: OP_OTHER_CUTOVER }));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(bodyweightRowsOnSheet(), 0);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 3c: a bodyweight preview never touches the ledger, even when it carries an operation_id', async () => {
  reset();
  const res = await post('/api/bodyweight', { ...bwBody({ operationId: OP_BW }), test_mode: 'true' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.test_mode, true);
  assert.equal(bodyweightRowsOnSheet(), 0);
  assert.equal(state.batches.length, 0);
  assert.equal(SHEET.Write_Outcomes, undefined);
});

// ── constraints ───────────────────────────────────────────────────────────

test('#1780 slice 3c: a constraint save with a valid operation_id commits the row + outcome + marker in ONE atomic batch', async () => {
  reset();
  const before = state.batches.length;
  const res = await post('/api/constraints', conBody({ operationId: OP_CON }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.sheet_written, true);
  assert.equal(data.operation_id, OP_CON);
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(typeof data.ledger_marker, 'string');
  assert.ok(data.ledger_marker.startsWith('atlas_receipt_commit_'));
  assert.deepEqual(data.constraint_write_verification, { verified: true, method: 'write_outcomes_ledger' });
  assert.equal(constraintRowsOnSheet(), 1);
  // The date is the server's local day (localTodayIso), not the body date.
  assert.deepEqual(SHEET.Constraints[1], [data.date, 'equipment', 'Bench Press', 'avoid', '']);
  assert.equal(state.appends.length, 0, 'no legacy appendRows call on the ledger path');
  assert.equal(state.batches.length, before + 1, 'exactly one atomic batch');
  const batch = state.batches[state.batches.length - 1];
  assert.deepEqual(batchAppendTabs(batch), ['Constraints', 'Write_Outcomes']);
  assert.ok(batchHasMarker(batch));
  assert.equal(outcomeRows().length, 1);
  assert.equal(outcomeRows()[0][0], OP_CON);
});

test('#1780 slice 3c: a constraint retry after the receipt store is lost replays committed and appends nothing (Q3)', async () => {
  reset();
  const first = await post('/api/constraints', conBody({ operationId: OP_CON }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  resetIdempotencyStore(); // the receipt store is lost (restart)
  const batchesBefore = state.batches.length;
  const res = await post('/api/constraints', conBody({ operationId: OP_CON }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.ledger_outcome, 'committed');
  assert.equal(res.body.data.duplicate_write, true);
  assert.equal(constraintRowsOnSheet(), 1, 'no second row');
  assert.equal(outcomeRows().length, 1, 'no second outcome row');
  assert.equal(state.batches.length, batchesBefore, 'the replay writes no batch');
});

test('#1780 slice 3c: the same constraint operation_id with a different rule is refused and appends nothing', async () => {
  reset();
  const first = await post('/api/constraints', conBody({ operationId: OP_CON }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  resetIdempotencyStore();
  const res = await post('/api/constraints', conBody({ rule: 'limit', writeId: 'con-w-2', operationId: OP_CON }));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(constraintRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
});

test('#1780 slice 3c: a constraint save with no operation_id takes the legacy path and creates no ledger tab', async () => {
  reset();
  const res = await post('/api/constraints', conBody({}));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.sheet_written, true);
  assert.equal(res.body.data.operation_id, undefined);
  assert.equal(constraintRowsOnSheet(), 1);
  assert.equal(state.appends.length, 1);
  assert.equal(SHEET.Write_Outcomes, undefined);
});

test('#1780 slice 3c: a malformed constraint operation_id is a 400 and an other-cutover one is a 409; both write nothing', async () => {
  reset();
  const bad = await post('/api/constraints', conBody({ operationId: OP_MALFORMED }));
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const other = await post('/api/constraints', conBody({ operationId: OP_OTHER_CUTOVER }));
  assert.equal(other.status, 409, JSON.stringify(other.body));
  assert.equal(constraintRowsOnSheet(), 0);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 0);
});

// ── Session_Plans ─────────────────────────────────────────────────────────

test('#1780 slice 3c: a Session_Plans closeout with a valid operation_id commits the row + outcome + marker in ONE atomic batch', async () => {
  reset();
  const before = state.batches.length;
  const res = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_SP_CLOSE }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const env = res.body.data.session_plans;
  assert.equal(env.status, 'written');
  assert.equal(env.captured, true);
  assert.equal(env.written, 1);
  assert.equal(env.ledger.operation_id, OP_SP_CLOSE);
  assert.equal(env.ledger.outcome, 'committed');
  assert.equal(typeof env.ledger.marker, 'string');
  assert.ok(env.ledger.marker.startsWith('atlas_receipt_commit_'));
  assert.equal(sessionPlanRowsOnSheet(), 1);
  assert.equal(state.appends.length, 0, 'no legacy appendRows call on the ledger path');
  assert.equal(state.batches.length, before + 1, 'exactly one atomic batch');
  const batch = state.batches[state.batches.length - 1];
  assert.deepEqual(batchAppendTabs(batch), ['Session_Plans', 'Write_Outcomes']);
  assert.ok(batchHasMarker(batch));
  assert.equal(outcomeRows().length, 1);
  assert.equal(outcomeRows()[0][0], OP_SP_CLOSE);
});

test('#1780 slice 3c: a Session_Plans closeout retry under the same operation_id replays committed and appends nothing (Q3)', async () => {
  reset();
  const first = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_SP_CLOSE }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const batchesBefore = state.batches.length;
  const res = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_SP_CLOSE }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const env = res.body.data.session_plans;
  // The event row is already on the sheet, so the store skips the data
  // write and the ledger replays the committed outcome: status 'skipped'
  // (nothing written this time), captured true, replayed true.
  assert.equal(env.status, 'skipped');
  assert.equal(env.captured, true);
  assert.equal(env.ledger.outcome, 'committed');
  assert.equal(env.ledger.replayed, true);
  assert.equal(sessionPlanRowsOnSheet(), 1, 'no second row');
  assert.equal(outcomeRows().length, 1, 'no second outcome row');
  assert.equal(state.batches.length, batchesBefore, 'the replay writes no batch');
});

test('#1780 slice 3c: the same Session_Plans operation_id with a different closeout status is refused and appends nothing', async () => {
  reset();
  const first = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_SP_CLOSE }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const batchesBefore = state.batches.length;
  // The capture layer answers with its failure-isolated envelope (HTTP 200):
  // the operation already committed with a different payload, so the retry
  // is refused — not a revision collision, not a new row.
  const res = await post('/api/session-plans/closeout', spCloseoutBody({ closeoutStatus: 'abandoned', operationId: OP_SP_CLOSE }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const env = res.body.data.session_plans;
  assert.equal(env.status, 'error');
  assert.equal(env.captured, false);
  assert.match(env.reason, /different payload/);
  assert.equal(sessionPlanRowsOnSheet(), 1);
  assert.equal(outcomeRows().length, 1);
  assert.equal(state.batches.length, batchesBefore, 'the refusal writes no batch');
});

test('#1780 slice 3c: a Session_Plans accept with a valid operation_id commits N rows + outcome + marker in ONE atomic batch', async () => {
  reset();
  const res = await post('/api/session-plans/accept', spAcceptBody({ operationId: OP_SP_ACCEPT }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const env = res.body.data.session_plans;
  assert.equal(env.status, 'written');
  assert.equal(env.captured, true);
  assert.equal(env.written, 2);
  assert.equal(env.ledger.operation_id, OP_SP_ACCEPT);
  assert.equal(env.ledger.outcome, 'committed');
  assert.equal(sessionPlanRowsOnSheet(), 2);
  assert.equal(state.appends.length, 0, 'no legacy appendRows call on the ledger path');
  assert.equal(state.batches.length, 1, 'exactly one atomic batch');
  assert.deepEqual(batchAppendTabs(state.batches[0]), ['Session_Plans', 'Write_Outcomes']);
  assert.ok(batchHasMarker(state.batches[0]));
  assert.equal(outcomeRows().length, 1);
});

test('#1780 slice 3c: a Session_Plans outcome with a valid operation_id commits the row + outcome + marker in ONE atomic batch', async () => {
  reset();
  const res = await post('/api/session-plans/outcome', spOutcomeBody({ operationId: OP_SP_OUTCOME }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const env = res.body.data.session_plans;
  assert.equal(env.status, 'written');
  assert.equal(env.captured, true);
  assert.equal(env.written, 1);
  assert.equal(env.ledger.operation_id, OP_SP_OUTCOME);
  assert.equal(env.ledger.outcome, 'committed');
  assert.equal(sessionPlanRowsOnSheet(), 1);
  assert.equal(state.appends.length, 0, 'no legacy appendRows call on the ledger path');
  assert.equal(state.batches.length, 1, 'exactly one atomic batch');
  assert.deepEqual(batchAppendTabs(state.batches[0]), ['Session_Plans', 'Write_Outcomes']);
  assert.equal(outcomeRows().length, 1);
});

test('#1780 slice 3c: a fresh operation_id for an already-captured Session_Plans event commits an outcome-only batch and does not duplicate the row', async () => {
  reset();
  const first = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_SP_CLOSE }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(sessionPlanRowsOnSheet(), 1);
  const batchesBefore = state.batches.length;
  // A deliberate second closeout of the same event: the store's deterministic
  // idempotency_key collapses it to the one row, so the ledger commits an
  // outcome-only batch — the event is recorded as already-captured, never
  // a second row. (Session_Plans events are identity-keyed; the Q4 twin
  // expectation of a second row does not apply here.)
  const res = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_SP_CLOSE2 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const env = res.body.data.session_plans;
  // Nothing written this time (the event row already stands): status
  // 'skipped', captured true — the ledger outcome is still committed.
  assert.equal(env.status, 'skipped');
  assert.equal(env.captured, true);
  assert.equal(env.written, 0);
  assert.equal(env.skipped, 1);
  assert.equal(env.ledger.operation_id, OP_SP_CLOSE2);
  assert.equal(env.ledger.outcome, 'committed');
  assert.equal(sessionPlanRowsOnSheet(), 1, 'still exactly one event row');
  assert.equal(outcomeRows().length, 2, 'one outcome per operation');
  assert.equal(state.batches.length, batchesBefore + 1, 'one outcome-only batch');
  assert.deepEqual(batchAppendTabs(state.batches[state.batches.length - 1]), ['Write_Outcomes']);
});

test('#1780 slice 3c: a Session_Plans closeout with no operation_id takes the legacy path and creates no ledger tab', async () => {
  reset();
  const res = await post('/api/session-plans/closeout', spCloseoutBody({}));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const env = res.body.data.session_plans;
  assert.equal(env.status, 'written');
  assert.equal(env.captured, true);
  assert.equal(env.ledger, null);
  assert.equal(sessionPlanRowsOnSheet(), 1);
  assert.equal(state.appends.length, 1);
  assert.equal(SHEET.Write_Outcomes, undefined);
});

test('#1780 slice 3c: a malformed Session_Plans operation_id is a 400 and an other-cutover one is a 409; both write nothing', async () => {
  reset();
  const bad = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_MALFORMED }));
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const other = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_OTHER_CUTOVER }));
  assert.equal(other.status, 409, JSON.stringify(other.body));
  assert.equal(sessionPlanRowsOnSheet(), 0);
  assert.equal(state.appends.length, 0);
  assert.equal(state.batches.length, 0);
});

test('#1780 slice 3c: with the Session_Plans flag off, a valid operation_id still answers disabled and mints no outcome row', async () => {
  reset();
  delete process.env.ATLAS_SESSION_PLANS_WRITE;
  try {
    const res = await post('/api/session-plans/closeout', spCloseoutBody({ operationId: OP_SP_CLOSE }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const env = res.body.data.session_plans;
    assert.equal(env.status, 'disabled');
    assert.equal(env.captured, false);
    assert.equal(sessionPlanRowsOnSheet(), 0);
    assert.equal(SHEET.Write_Outcomes, undefined);
    assert.equal(state.batches.length, 0);
  } finally {
    process.env.ATLAS_SESSION_PLANS_WRITE = '1';
  }
});

// ── server-emitted finalized closeout ─────────────────────────────────────

test('#1780 slice 3c: a ledger log-workout with closeout_context commits the server-emitted finalized closeout through the ledger', async () => {
  reset();
  const saveBody = {
    session_id: '1780-SP-CLOSE',
    date: '2026-06-26',
    log_rows: [{ exercise: 'Bench Press', set_number: 1, weight: 225, reps: 5, rir: 2 }],
    effort_row: ['2026-06-26', '1780-SP-CLOSE', 45, 300, 400, 120, 150, 'Home', ''],
    write_id: '1780-sp-close-w',
    operation_id: OP_SAVE,
    closeout_context: { plan_version: 'pv_sp1' },
  };
  const res = await postLiveLogWorkout(post, saveBody, 'slice-3c closeout save');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.ledger_outcome, 'committed');
  assert.equal(data.session_plans_closeout.status, 'written');
  assert.equal(data.session_plans_closeout.captured, true);
  assert.equal(data.session_plans_closeout.written, 1);
  assert.equal(sessionPlanRowsOnSheet(), 1);
  // Two outcome rows: the save's own operation, plus the closeout event's
  // fresh server-minted operation — a distinct operation for a distinct event.
  assert.equal(outcomeRows().length, 2);
  assert.equal(outcomeRows()[0][0], OP_SAVE);
  assert.notEqual(outcomeRows()[1][0], OP_SAVE);
  assert.equal(data.session_plans_closeout.ledger.operation_id, outcomeRows()[1][0]);
  assert.equal(state.appends.filter((a) => a.tab === 'Session_Plans').length, 0,
    'the closeout row never takes the legacy append path');

  // A retry of the same save operation replays the save and commits the
  // closeout outcome-only — still exactly one closeout row.
  resetIdempotencyStore();
  const retry = await postLiveLogWorkout(post, saveBody, 'slice-3c closeout retry');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(sessionPlanRowsOnSheet(), 1, 'no second closeout row');
  assert.equal(outcomeRows().length, 3, 'save + first closeout op + retry closeout op');
});
