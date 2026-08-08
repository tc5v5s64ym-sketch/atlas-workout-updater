'use strict';

// The child process for the §6.1 P5 process-death proof.
//
// It boots the REAL Atlas app (real routes, real parser, real trust loop, real
// proof fields) and performs a REAL Save through POST /api/log-workout, then
// DIES IN THE EXACT WINDOW the gate names: after the Sheets append has returned
// success, and before the shadow write reaches Supabase.
//
// ── HOW THE WINDOW IS HIT DETERMINISTICALLY ───────────────────────────────────
// Not by an external kill and a hopeful sleep — that would be a race, and a race
// is not a proof. The seam is the same require.cache injection the api-smoke
// suite has always used: services/supabaseAdapter.js is replaced BEFORE the app
// loads with one whose shadowSave calls process.exit(9). So the production code
// under test is entirely unmodified — there is no fault-injection branch in
// index.js or in services/migrationShadow.js — and the death lands exactly
// between the two operations by construction.
//
// The stubbed Sheets client writes every appended row to a JSON FILE, because the
// point of the proof is that the Sheets rows SURVIVE the death while the Supabase
// rows never arrived. An in-memory stub would die with the process and prove
// nothing.
//
// Nothing here reaches Google. No credential is loaded and no client is ever
// constructed, exactly as the gate harness arranges.

const fs = require('fs');
const path = require('path');

const SHEETS_FILE = process.env.ATLAS_DEATH_SHEETS_FILE;
const MODE = process.env.ATLAS_DEATH_MODE || 'die';
if (!SHEETS_FILE) throw new Error('ATLAS_DEATH_SHEETS_FILE is required');

// dotenv must not repopulate anything this harness decides, exactly as the
// Playwright gate server neutralises it.
try {
  const dotenvPath = require.resolve('dotenv');
  require.cache[dotenvPath] = {
    id: dotenvPath, filename: dotenvPath, loaded: true,
    exports: { config: () => ({ parsed: {} }), parse: () => ({}) },
  };
} catch { /* not installed */ }

process.env.ATLAS_API_KEY = 'death-proof-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ATLAS_FLIGHT_RECORDER;

// ── The durable Sheets stub ───────────────────────────────────────────────────

function loadTabs() {
  try {
    return JSON.parse(fs.readFileSync(SHEETS_FILE, 'utf8'));
  } catch {
    return { Log_Cleaned: [], Effort: [], Session_Plans: [], Session_Plan_Sets: [], Exercise_Catalog: [] };
  }
}

function saveTabs(tabs) {
  fs.mkdirSync(path.dirname(SHEETS_FILE), { recursive: true });
  fs.writeFileSync(SHEETS_FILE, JSON.stringify(tabs, null, 2));
}

const EXERCISE_CATALOG = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'back squat|squat|squats'],
];

function columnLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const fakeSheets = {
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
  async appendRows(tabName, rows) {
    const tabs = loadTabs();
    if (!tabs[tabName]) tabs[tabName] = [];
    const startRow = tabs[tabName].length + 2; // row 1 is the header
    tabs[tabName].push(...rows.map((row) => row.map((cell) => (cell === undefined ? '' : String(cell)))));
    // fsync-equivalent durability: the file is rewritten and closed before this
    // resolves, so the rows outlive the death that follows.
    saveTabs(tabs);
    const endRow = startRow + rows.length - 1;
    const lastCol = columnLetter(Math.max(1, (rows[0] || []).length));
    return {
      data: {
        updates: {
          updatedRange: `${tabName}!A${startRow}:${lastCol}${endRow}`,
          updatedRows: rows.length,
          updatedColumns: (rows[0] || []).length,
          updatedCells: rows.length * (rows[0] || []).length,
        },
      },
    };
  },
  async getSheetRows(tabName) {
    if (tabName === 'Exercise_Catalog') return EXERCISE_CATALOG.slice(1);
    return loadTabs()[tabName] || [];
  },
  async getRecentRows(tabName) {
    return (loadTabs()[tabName] || []).slice(-100);
  },
  async getExerciseCatalog() {
    return EXERCISE_CATALOG.slice(1).map((row) => ({
      exercise: row[0], muscle_group: row[1], lift_code: row[2], canonical_exercise: row[3],
    }));
  },
  async getEffortSessionIds() {
    return (loadTabs().Effort || []).map((row) => row[1]).filter(Boolean);
  },
  async getLogCompositeKeys() {
    return (loadTabs().Log_Cleaned || []).map(
      (row) => `${String(row[1] || '').trim().toLowerCase()}||${String(row[2] || '').trim().toLowerCase()}||${String(row[6] || '').trim()}`
    );
  },
  async getHeaderRow() { return []; },
  async getSpreadsheetTabs() { return ['Log_Cleaned', 'Effort', 'Exercise_Catalog']; },
  async readRange() { return []; },
  async updateColumnCells() { return { data: { totalUpdatedCells: 0 } }; },
  async deleteRowsByRange() { return { data: {} }; },
  async ensureSheetTab() { return { created: false }; },
  async confirmTabMissing() { return false; },
  async readWithRetry(fn) { return fn(); },
  validateConfig() { return true; },
  getSafeSpreadsheetConfig() { return { canVerify: true, spreadsheetIdLast6: 'stub00' }; },
  isTransientAppendError() { return false; },
  isTransientReadError() { return false; },
  classifySheetsReadError() { return 'unknown'; },
  sheetsReadFailureClass() { return 'unknown'; },
  async retryWithBackoff(fn) { return fn(); },
  // Signature matches sheets.js: runWithReadContext(fn, request).
  runWithReadContext(fn) { return fn(); },
  currentRequestIdentity() { return null; },
  declareRequestRanges() {},
  invalidateTabCache() {},
  CATALOG_CACHE_TTL_MS: 60000,
  _resetExerciseCatalogCache() {},
  _exerciseCatalogCacheStats() { return {}; },
};

const sheetsPath = require.resolve('../../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

// ── The poisoned adapter: THE DEATH, in the exact window ─────────────────────

const realAdapterPath = require.resolve('../../services/supabaseAdapter');
const realAdapter = require(realAdapterPath);

require.cache[realAdapterPath] = {
  id: realAdapterPath,
  filename: realAdapterPath,
  loaded: true,
  exports: {
    ...realAdapter,
    isShadowWriteEnabled: () => true,
    async shadowSave(args) {
      if (MODE === 'die') {
        // The Sheets append has already returned success and its rows are on
        // disk. Supabase has not been touched. This is the window.
        process.stdout.write('DIED_IN_WINDOW\n');
        process.exit(9);
      }
      return realAdapter.shadowSave(args);
    },
  },
};

// ── Boot the real app and perform a real Save ─────────────────────────────────

const { app } = require('../../index');

const SESSION_ID = process.env.ATLAS_DEATH_SESSION_ID;
const DATE = process.env.ATLAS_DEATH_DATE;

const PAYLOAD = {
  session_id: SESSION_ID,
  date: DATE,
  write_id: process.env.ATLAS_DEATH_WRITE_ID,
  log_rows: [
    { date_clean: DATE, session_id: SESSION_ID, exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' },
    { date_clean: DATE, session_id: SESSION_ID, exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2, notes: '' },
  ],
};

const server = app.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/log-workout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'death-proof-key' },
      body: JSON.stringify(PAYLOAD),
    });
    // The RAW body text, so a byte-identity comparison is genuinely a
    // byte comparison rather than a comparison of two re-serialisations.
    const text = await response.text();
    process.stdout.write(`RESPONSE ${response.status} ${text}\n`);
    // Reached only in the 'survive' mode, where the shadow write is real.
    const migrationShadow = require('../../services/migrationShadow');
    await migrationShadow._drain();
    server.close(() => process.exit(0));
  } catch (err) {
    process.stdout.write(`REQUEST_FAILED ${err.message}\n`);
    process.exit(3);
  }
});
