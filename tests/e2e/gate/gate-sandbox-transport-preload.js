'use strict';
// Gate harness — sandbox-live transport stand-in (issue #1659).
//
// Installed via NODE_OPTIONS=--require before gate-server loads, so the
// harness's require('../../../sheets') resolves to this fake transport. The
// guard under test stays the REAL buildGuardedSheets() in gate-server.js;
// only the Google transport behind it is faked — the same seam the default
// in-memory stub posture uses. No network, no credentials, nothing reaches a
// workbook.
//
// What it answers, and why each is needed:
//   - getSafeSpreadsheetConfig('test') → the declared sandbox (the guard's
//     call-time sandbox re-check and the preflight's workbook verification);
//   - getSpreadsheetTabs() → the canned tab list, including Modality_Log (the
//     route's tab-existence check and the preflight's WRITABLE_TABS presence
//     loop);
//   - getHeaderRow(tab) → the contract columns (the preflight's header checks);
//   - appendRows() → a recorded success (the guard records the append before
//     delegating here, so GET /__gate/state shows exactly what "landed").
// Everything else is an empty-but-shaped answer so app boot and the driven
// routes never touch a missing export.
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const sheetsPath = path.join(repoRoot, 'sheets.js');
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6 } = require(
  path.join(repoRoot, 'config', 'sandboxSheet.js'),
);
const {
  logCleanedColumns,
  effortColumns,
  sessionPlansColumns,
  sessionPlanSetsColumns,
  modalityLogColumns,
} = require(path.join(repoRoot, 'config', 'columns.js'));

const TABS = [
  'Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary',
  'Bodyweight', 'Coaching_Notes', 'Constraints', 'Deload_State', 'Modality_Log',
  'Session_Plans', 'Session_Plan_Sets',
];
const HEADERS = {
  Log_Cleaned: logCleanedColumns,
  Effort: effortColumns,
  Session_Plans: sessionPlansColumns,
  Session_Plan_Sets: sessionPlanSetsColumns,
  Modality_Log: modalityLogColumns,
};

// Materialized rows per tab, header first — so the durable verifier's
// session-filtered read-back sees what the guard let through, exactly as the
// workbook would. The default in-memory stub posture materializes
// Session_Plan_Sets the same way; this is the same idea, behind the guard.
const materialized = new Map(); // tabName -> array of rows (contract header at [0])
function materialize(tabName, rows) {
  if (!materialized.has(tabName)) {
    const header = HEADERS[tabName] || [];
    materialized.set(tabName, header.length ? [[...header]] : []);
  }
  for (const r of rows) materialized.get(tabName).push([...r]);
}
function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseRange(range) {
  const m = String(range || '').match(/^([^!]+)!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  if (!m) return null;
  return {
    tab: m[1],
    startCol: colToIndex(m[2]),
    startRow: m[3] ? Number(m[3]) : 1,
    endCol: m[4] ? colToIndex(m[4]) : colToIndex(m[2]),
    endRow: m[5] ? Number(m[5]) : null,
  };
}
function readMaterialized({ tab, startCol, startRow, endCol, endRow }) {
  const rows = materialized.get(tab) || [];
  // A bare column range (B:B) reads the whole column, one cell per row.
  if (endRow === null) {
    return rows.map((row) => [row[startCol] === undefined ? '' : row[startCol]]);
  }
  const out = [];
  for (let i = startRow; i <= endRow; i += 1) {
    const row = rows[i - 1] || [];
    const sliced = [];
    for (let c = startCol; c <= endCol; c += 1) sliced.push(row[c] === undefined ? '' : row[c]);
    out.push(sliced);
  }
  return out;
}

const fakeSheets = {
  appendRows: async (tabName, rows) => {
    materialize(tabName, rows);
    return {
      data: { updates: { updatedRange: `${tabName}!A100:L${99 + rows.length}`, updatedRows: rows.length } },
    };
  },
  readRange: async (range) => {
    const r = String(range || '');
    const parsed = parseRange(r);
    if (parsed && materialized.has(parsed.tab)) return readMaterialized(parsed);
    if (r.startsWith('Session_Plans!')) return [[...sessionPlansColumns]];
    if (r.startsWith('Session_Plan_Sets!A1:A1')) return [[sessionPlanSetsColumns[0]]];
    if (r.startsWith('Session_Plan_Sets!')) return [[...sessionPlanSetsColumns]];
    return [];
  },
  getSpreadsheetTabs: async () => [...TABS],
  getHeaderRow: async (tabName) => [...(HEADERS[tabName] || [])],
  getSafeSpreadsheetConfig: () => ({
    canVerify: true,
    source: 'GOOGLE_SHEETS_ID',
    idLast6: SANDBOX_SPREADSHEET_ID_LAST6,
    id: SANDBOX_SPREADSHEET_ID,
    exactIdExposed: true,
    isSandboxSheet: true,
  }),
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  ensureSheetTab: async () => ({ existed: true }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  isTransientAppendError: () => false,
  retryWithBackoff: async (fn) => fn(),
  sheetsReadFailureClass: () => null,
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};

require.cache[sheetsPath] = {
  id: sheetsPath,
  filename: sheetsPath,
  loaded: true,
  exports: fakeSheets,
};
