'use strict';

// #1780 [P1] Write_Outcomes ledger — Part B: the commit/lookup orchestrator
// against a FULLY MODELED fake Sheets client (real sheets.js + real
// services/writeOutcomes.js, only `googleapis` faked — the #1764 pattern).
// Appends push rows, deletes splice them, named ranges persist, so the
// acceptance probes run through the real mechanism with real state
// transitions. Each probe asserts the FIXED outcome, so every probe FAILS
// at the s3 head (no ledger module) until the build lands.
//
// The restart in Q3 is modeled honestly: the module holds NO process state
// — the only durable record is the modeled sheet — so a "different process"
// is just a fresh lookup against the same sheet. If the answer survives
// that, it survives a free-plan restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { logCleanedColumns, effortColumns } = require('../config/columns');

const CUTOVER = '11111111-2222-4333-8444-555555555555';
const LOG_SESSION_COL = logCleanedColumns.indexOf('session_id');

// One shared modeled sheet per file; each test writes under its own session
// id. Write_Outcomes starts ABSENT — the first commit must create it, with
// the immutable header, or the build has not earned its tab.
const SHEET = {
  Log_Cleaned: [[...logCleanedColumns]],
  Effort: [[...effortColumns]],
};
const SHEET_IDS = { Log_Cleaned: 1, Effort: 2 };
let NEXT_SHEET_ID = 3;
const TAB_BY_SHEET_ID = { 1: 'Log_Cleaned', 2: 'Effort' };
const NAMED_RANGES = [];
const FAULT = { failBatchAfterCommit: false };

function colToIdx(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

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

function readRangeValues(range, majorDimension) {
  const parsed = parseA1(range);
  if (!parsed) throw new Error(`Unable to parse range: ${range}`);
  const rows = SHEET[parsed.tab];
  if (!rows) throw new Error(`Unable to parse range: ${range}`);
  let out;
  if (/!1:1$/.test(range)) {
    // A tab that exists but holds no rows yet (freshly created) reads as an
    // empty header, not a crash — ensureSheetTab seeds it right after.
    out = rows.length ? [rows[0].slice()] : [];
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

function snapshotSheet() {
  return {
    sheet: Object.fromEntries(Object.entries(SHEET).map(([k, v]) => [k, v.map((r) => [...r])])),
    named: NAMED_RANGES.map((nr) => ({ ...nr, range: { ...nr.range } })),
    ids: { ...SHEET_IDS },
    byId: { ...TAB_BY_SHEET_ID },
    nextId: NEXT_SHEET_ID,
  };
}

// A batchUpdate is ATOMIC: the whole request list lands or nothing does.
// The fake restores the snapshot on any request failure, so a duplicate
// marker name mid-list cannot leave the data and outcome rows behind.
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

function cellToPlain(cell) {
  if (!cell || typeof cell !== 'object') return '';
  const v = cell.userEnteredValue || {};
  if (v.stringValue !== undefined) return String(v.stringValue);
  if (v.numberValue !== undefined) return String(v.numberValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return '';
}

function applyBatchUpdate(requestBody) {
  for (const req of (requestBody && requestBody.requests) || []) {
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
    } else if (req.deleteDimension) {
      const dim = req.deleteDimension.range;
      const tab = TAB_BY_SHEET_ID[dim.sheetId];
      if (!tab || dim.dimension !== 'ROWS') throw new Error('Unsupported deleteDimension request in fake');
      SHEET[tab].splice(dim.startIndex, dim.endIndex - dim.startIndex);
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
}

function makeFake() {
  return {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: Object.keys(SHEET).map((title) => ({
            properties: { title, sheetId: SHEET_IDS[title] },
          })),
          namedRanges: NAMED_RANGES.map((nr) => ({ name: nr.name, range: { ...nr.range } })),
        },
      }),
      batchUpdate: async ({ requestBody }) => {
        const snap = snapshotSheet();
        try {
          applyBatchUpdate(requestBody);
        } catch (error) {
          restoreSheet(snap);
          throw error;
        }
        if (FAULT.failBatchAfterCommit) {
          FAULT.failBatchAfterCommit = false;
          const err = new Error('Backend Error');
          err.status = 500;
          throw err;
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
          if (!SHEET[tab]) SHEET[tab] = [];
          for (const r of requestBody.values || []) {
            SHEET[tab].push(r.map((v) => (v === null || v === undefined ? '' : String(v))));
          }
          return { data: { updates: { updatedRows: (requestBody.values || []).length } } };
        },
        update: async ({ range, requestBody }) => {
          const parsed = parseA1(range);
          if (!parsed) throw new Error(`Unable to parse range: ${range}`);
          if (!SHEET[parsed.tab]) SHEET[parsed.tab] = [];
          const values = requestBody.values || [];
          values.forEach((row, i) => {
            SHEET[parsed.tab][parsed.startRow - 1 + i] = row.map((v) => (v === null || v === undefined ? '' : String(v)));
          });
          return { data: {} };
        },
        batchUpdate: async () => ({ data: { totalUpdatedCells: 0 } }),
      },
    },
  };
}

// The cache injection must land BEFORE sheets.js / writeOutcomes.js load,
// because sheets.js requires googleapis at module scope.
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true,
  exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, sheets: () => makeFake() } },
};

const writeOutcomes = require('../services/writeOutcomes');

function logRow(sessionId, setNumber = 1) {
  const row = new Array(logCleanedColumns.length).fill('');
  row[LOG_SESSION_COL] = sessionId;
  row[logCleanedColumns.indexOf('exercise')] = 'Back Squat';
  row[logCleanedColumns.indexOf('set_number')] = setNumber;
  row[logCleanedColumns.indexOf('weight')] = 225;
  row[logCleanedColumns.indexOf('reps')] = 5;
  return row;
}

function logRowsFor(sessionId) {
  return SHEET.Log_Cleaned.slice(1).filter((r) => r[LOG_SESSION_COL] === sessionId);
}

function outcomeRows() {
  return (SHEET.Write_Outcomes || []).slice(1);
}

async function save(sessionId, operationId, extra = {}) {
  const rows = [logRow(sessionId, 1), logRow(sessionId, 2)];
  return writeOutcomes.commitOperation(require('../sheets'), {
    cutoverId: CUTOVER,
    operationId,
    kind: 'save',
    payload: { session_id: sessionId, rows },
    evidence: { v: 1, status: 'committed', tabs: ['Log_Cleaned'], rows: 2 },
    dataAppends: [{ tab: 'Log_Cleaned', rows }],
    ...extra,
  });
}

async function undoSave(sessionId, saveOperationId, undoOperationId, rowCount = 2) {
  const rows = logRowsFor(sessionId);
  assert.ok(rows.length >= rowCount, 'undo needs rows on the sheet');
  const startIndex = SHEET.Log_Cleaned.findIndex((r) => r[LOG_SESSION_COL] === sessionId);
  return writeOutcomes.commitOperation(require('../sheets'), {
    cutoverId: CUTOVER,
    operationId: undoOperationId,
    kind: 'undo',
    payload: { undo: saveOperationId, session_id: sessionId },
    targetOperationId: saveOperationId,
    evidence: { v: 1, status: 'reverted', deleted: { tab: 'Log_Cleaned', rows: rowCount } },
    dataAppends: [],
    dataRequests: [{
      deleteDimension: {
        range: { sheetId: SHEET_IDS.Log_Cleaned, dimension: 'ROWS', startIndex, endIndex: startIndex + rowCount },
      },
    }],
  });
}

function opId() {
  return `atlas-op-v1:${CUTOVER}:${crypto.randomUUID()}`;
}

// ── Q3: restart case ──────────────────────────────────────────────────────

test('#1780 Q3: save, undo, restart, original-ID retry answers reverted from the ledger — no re-append', async () => {
  const sessionId = '1780-Q3';
  const saveId = opId();
  const undoId = opId();
  const committed = await save(sessionId, saveId);
  assert.equal(committed.outcome, 'committed');
  assert.equal(committed.replayed, false);
  assert.equal(logRowsFor(sessionId).length, 2);

  const undone = await undoSave(sessionId, saveId, undoId);
  assert.equal(undone.outcome, 'reverted');
  assert.equal(logRowsFor(sessionId).length, 0, 'undo deleted the rows in the same atomic commit');

  // The restart: no process state survives — the lookup below reads ONLY the
  // modeled sheet, exactly what a fresh process after a free-plan restart sees.
  const retry = await save(sessionId, saveId);
  assert.equal(retry.outcome, 'reverted');
  assert.equal(retry.replayed, true);
  assert.equal(logRowsFor(sessionId).length, 0, 'retry appended nothing');
  assert.equal(outcomeRows().filter((r) => r[0] === saveId).length, 1, 'exactly one save outcome row');
});

// ── Q4: twin lifecycle ────────────────────────────────────────────────────

test('#1780 Q4: twin lifecycle — retry A replays, deliberate B lands twice, undo A, retry B succeeds, retry A reverts', async () => {
  const sessionId = '1780-Q4';
  const a = opId();
  const b = opId();
  const first = await save(sessionId, a);
  assert.equal(first.outcome, 'committed');
  assert.equal(logRowsFor(sessionId).length, 2);

  const retryA1 = await save(sessionId, a);
  assert.equal(retryA1.outcome, 'committed');
  assert.equal(retryA1.replayed, true);
  assert.equal(logRowsFor(sessionId).length, 2, 'retry A appended nothing');

  const second = await save(sessionId, b);
  assert.equal(second.outcome, 'committed');
  assert.equal(second.replayed, false);
  assert.equal(logRowsFor(sessionId).length, 4, 'deliberate identical save B lands a second row set');

  await undoSave(sessionId, a, opId());
  assert.equal(logRowsFor(sessionId).length, 2, 'undo A removed exactly one row set');

  const retryB = await save(sessionId, b);
  assert.equal(retryB.outcome, 'committed');
  assert.equal(retryB.replayed, true);
  assert.equal(logRowsFor(sessionId).length, 2, 'retry B appended nothing');

  const retryA2 = await save(sessionId, a);
  assert.equal(retryA2.outcome, 'reverted');
  assert.equal(retryA2.replayed, true);
  assert.equal(logRowsFor(sessionId).length, 2, 'retry A after undo appended nothing');
});

// ── Probe 3: concurrent same-ID saves ─────────────────────────────────────

test('#1780 probe 3: concurrent same-ID saves commit exactly one row set', async () => {
  const sessionId = '1780-P3';
  const id = opId();
  const [r1, r2] = await Promise.all([save(sessionId, id), save(sessionId, id)]);
  assert.equal(r1.outcome, 'committed');
  assert.equal(r2.outcome, 'committed');
  assert.equal([r1.replayed, r2.replayed].filter(Boolean).length, 1, 'exactly one of the two replayed');
  assert.equal(logRowsFor(sessionId).length, 2, 'exactly one row set on the sheet');
  assert.equal(outcomeRows().filter((r) => r[0] === id).length, 1, 'exactly one outcome row');
});

// ── Probe 4: delayed request vs the permanent markers ─────────────────────

test('#1780 probe 4: a request prepared before an undo is rejected by the markers — zero writes, then re-prepare lands', async () => {
  const sessionId = '1780-P4';
  const a = opId();
  const b = opId();
  await save(sessionId, a);
  assert.equal(logRowsFor(sessionId).length, 2);

  // Prepare B while the generation stands where the last commit left it.
  // Markers are permanent and accumulate across this file, so the expected
  // name is computed from the live generation, never hardcoded.
  const sheets = require('../sheets');
  const genBefore = NAMED_RANGES.length;
  const prepared = await writeOutcomes.prepareOperation(sheets, {
    cutoverId: CUTOVER,
    operationId: b,
    kind: 'save',
    payload: { session_id: sessionId, rows: [logRow(sessionId, 1)] },
    evidence: { v: 1, status: 'committed', tabs: ['Log_Cleaned'], rows: 1 },
    dataAppends: [{ tab: 'Log_Cleaned', rows: [logRow(sessionId, 1)] }],
  });
  assert.equal(prepared.markerName, `atlas_receipt_commit_${genBefore + 1}`);

  // The undo lands first and takes marker _2.
  await undoSave(sessionId, a, opId());
  assert.equal(logRowsFor(sessionId).length, 0);

  // B's prepared commit now collides with the undo's marker: the whole batch
  // is refused atomically — no data row, no outcome row.
  await assert.rejects(
    () => writeOutcomes.commitPrepared(sheets, prepared),
    (err) => err && err.code === 'fence_rejected',
  );
  assert.equal(logRowsFor(sessionId).length, 0, 'fenced commit wrote no data');
  assert.equal(outcomeRows().filter((r) => r[0] === b).length, 0, 'fenced commit wrote no outcome');

  // Re-preparing after the fence lands cleanly on the next marker. (The
  // save helper writes its standard 2-row payload; the fenced 1-row prepare
  // committed nothing, so the fresh commit carries the caller's payload.)
  const landed = await save(sessionId, b);
  assert.equal(landed.outcome, 'committed');
  assert.equal(landed.replayed, false);
  assert.equal(logRowsFor(sessionId).length, 2);
});

// ── Probe 5: restart between commit and ack ───────────────────────────────

test('#1780 probe 5: restart between batch commit and HTTP ack — retry reconciles to the committed outcome, no duplicate', async () => {
  const sessionId = '1780-P5';
  const id = opId();
  FAULT.failBatchAfterCommit = true;
  await assert.rejects(
    () => save(sessionId, id),
    (err) => err && (err.status === 500 || /backend/i.test(err.message)),
  );
  assert.equal(logRowsFor(sessionId).length, 2, 'the batch committed before the ack was lost');
  assert.equal(outcomeRows().filter((r) => r[0] === id).length, 1);

  const retry = await save(sessionId, id);
  assert.equal(retry.outcome, 'committed');
  assert.equal(retry.replayed, true);
  assert.equal(logRowsFor(sessionId).length, 2, 'reconciling retry appended nothing');
});

// ── Probe 6: legacy coexistence ───────────────────────────────────────────

test('#1780 probe 6: pre-cutover rows stay untouched; an undo against an ambiguous legacy row set is refused', async () => {
  const sessionId = '1780-P6-LEGACY';
  // A legacy row: on the sheet before the cutover, with no operation ID.
  SHEET.Log_Cleaned.push(logRow(sessionId, 1));
  assert.equal(logRowsFor(sessionId).length, 1);

  await assert.rejects(
    () => writeOutcomes.commitOperation(require('../sheets'), {
      cutoverId: CUTOVER,
      operationId: opId(),
      kind: 'undo',
      payload: { undo: 'legacy', session_id: sessionId },
      targetOperationId: null,
      legacyTarget: true,
      evidence: { v: 1, status: 'reverted' },
      dataAppends: [],
      dataRequests: [],
    }),
    (err) => err && err.code === 'legacy_undo_refused',
  );
  assert.equal(logRowsFor(sessionId).length, 1, 'refused legacy undo deleted nothing');

  // A cutover-era save alongside the legacy row still works.
  const id = opId();
  const committed = await save(sessionId, id);
  assert.equal(committed.outcome, 'committed');
  assert.equal(logRowsFor(sessionId).length, 3);
});

// ── Known limit: oversized evidence ───────────────────────────────────────

test('#1780 limit: oversized evidence fails closed with zero writes', async () => {
  const sessionId = '1780-OVERSIZE';
  const id = opId();
  await assert.rejects(
    () => writeOutcomes.commitOperation(require('../sheets'), {
      cutoverId: CUTOVER,
      operationId: id,
      kind: 'save',
      payload: { session_id: sessionId, rows: [logRow(sessionId, 1)] },
      evidence: { v: 1, note: 'x'.repeat(45000) },
      dataAppends: [{ tab: 'Log_Cleaned', rows: [logRow(sessionId, 1)] }],
    }),
    (err) => err && err.code === 'evidence_oversize',
  );
  assert.equal(logRowsFor(sessionId).length, 0, 'oversized commit wrote no data');
  assert.equal(outcomeRows().filter((r) => r[0] === id).length, 0, 'oversized commit wrote no outcome');
});

// ── Fail-closed: same ID, different payload ───────────────────────────────

test('#1780 fail-closed: same operation ID with a different payload is refused, never committed', async () => {
  const sessionId = '1780-MISMATCH';
  const id = opId();
  await save(sessionId, id);
  assert.equal(logRowsFor(sessionId).length, 2);
  await assert.rejects(
    () => writeOutcomes.commitOperation(require('../sheets'), {
      cutoverId: CUTOVER,
      operationId: id,
      kind: 'save',
      payload: { session_id: sessionId, rows: [logRow(sessionId, 9)] },
      evidence: { v: 1, status: 'committed' },
      dataAppends: [{ tab: 'Log_Cleaned', rows: [logRow(sessionId, 9)] }],
    }),
    (err) => err && err.code === 'operation_id_payload_mismatch',
  );
  assert.equal(logRowsFor(sessionId).length, 2, 'mismatched retry appended nothing');
});

// ── Fail-closed: corrupt outcome rows and header mismatch ─────────────────

test('#1780 fail-closed: a corrupt outcome row stops every commit', async () => {
  const sessionId = '1780-CORRUPT';
  // A corrupt row already in the ledger (bad evidence JSON).
  SHEET.Write_Outcomes.push(['atlas-op-v1:bad:row', 'save', 'a'.repeat(64), '', 'not json']);
  await assert.rejects(
    () => save(sessionId, opId()),
    (err) => err && err.code === 'outcome_row_corrupt',
  );
  assert.equal(logRowsFor(sessionId).length, 0, 'corrupt ledger wrote no data');
  // Remove the corrupt row so later tests in this file see a clean ledger.
  SHEET.Write_Outcomes = SHEET.Write_Outcomes.filter((r) => r[0] !== 'atlas-op-v1:bad:row');
});

test('#1780 fail-closed: a Write_Outcomes header that is not the immutable header stops every commit', async () => {
  const sessionId = '1780-HEADER';
  const savedHeader = SHEET.Write_Outcomes[0];
  SHEET.Write_Outcomes[0] = ['operation_id', 'kind', 'payload_hash', 'target_operation_id', 'evidence'];
  await assert.rejects(
    () => save(sessionId, opId()),
    (err) => err && err.code === 'write_outcomes_header_mismatch',
  );
  assert.equal(logRowsFor(sessionId).length, 0, 'header-mismatched commit wrote no data');
  SHEET.Write_Outcomes[0] = savedHeader;
});
