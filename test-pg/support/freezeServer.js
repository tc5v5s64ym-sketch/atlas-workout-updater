'use strict';

// A REAL Atlas server process, for the S3 write-freeze proofs (§6.2 P8, P9, P11).
//
// P8 demands that activation be proven WITHOUT a restart, and "proven by process
// start identity, not by behaviour alone". That cannot be done inside one test
// process: the parent has to hold a genuinely separate, genuinely long-lived
// server, change the row underneath it, and watch THAT process change its answer.
// So this child boots the real index.js against the real disposable Postgres
// database, as the real atlas_app role, and prints its identity on stdout.
//
// ONLY Google Sheets and the vision parser are stubbed. The Supabase adapter is
// the real one — the freeze read is a real query, over a real pooled connection,
// as the real least-privileged role. That is the whole point.

process.env.ATLAS_API_KEY = process.env.ATLAS_API_KEY || 'pg-proof-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';

// Every Sheets mutation is counted in-process and reported on demand, so the
// parent can prove a frozen request produced NO append without trusting the
// child's word about its own control flow.
const calls = { append: [], delete: [], update: [] };
const fakeSheets = {
  validateConfig: () => {},
  appendRows: async (tabName, rows) => {
    calls.append.push({ tabName, rows });
    return { data: { updates: { updatedRows: rows.length, updatedRange: `${tabName}!A2:L${1 + rows.length}` } } };
  },
  deleteRowsByRange: async (...args) => { calls.delete.push(args); return { rowsDeleted: 1 }; },
  updateColumnCells: async (...args) => { calls.update.push(args); return { updatedCells: 1 }; },
  getExerciseCatalog: async () => [
    ['exercise', 'muscle_group', 'lift_code', 'canonical_exercise'],
    ['back squat', 'legs', 'SQ01', 'Back Squat'],
  ],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort', 'Coaching_Notes', 'Constraints', 'Bodyweight'],
  invalidateTabCache: () => {},
  ensureSheetTab: async () => {},
  readRange: async () => [],
  runWithReadContext: (fn) => fn(),
  declareRequestRanges: () => {},
  currentRequestIdentity: () => null,
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
  isTransientReadError: () => false,
  isTransientAppendError: () => false,
  classifySheetsReadError: () => 'unknown',
  sheetsReadFailureClass: () => 'unknown',
  confirmTabMissing: async () => false,
  getHeaderRow: async () => [],
  getSafeSpreadsheetConfig: () => ({}),
  CATALOG_CACHE_TTL_MS: 60_000,
  _resetExerciseCatalogCache: () => {},
  _exerciseCatalogCacheStats: () => ({ hits: 0, fetches: 0 }),
};
require.cache[require.resolve('../../sheets')] = {
  id: require.resolve('../../sheets'), filename: require.resolve('../../sheets'), loaded: true, exports: fakeSheets,
};
require.cache[require.resolve('../../services/vision')] = {
  id: require.resolve('../../services/vision'), filename: require.resolve('../../services/vision'), loaded: true,
  exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) },
};

const http = require('http');
// THE PROCESS IDENTITY IS THE ADAPTER'S NOW. It used to come from the file-backed
// receipt store, which minted its own id for the migration seam; that store is gone
// and `atlas.write_receipts` records `owner_instance_id` instead. The id answers the
// same question this proof asks — "is this the same process that served before the
// freeze?" — and it is now the id the receipt state machine actually uses.
const { INSTANCE_ID } = require('../../services/supabaseAdapter');
const { app } = require('../../index');

// The proof surface is a SEPARATE server on its own port, deliberately NOT an
// Express route on the app.
//
// Two reasons. It could not work as a route anyway — index.js registers a 404
// catch-all `app.use` at the end of the file, so anything added after `require`ing
// it is unreachable. And more importantly, the app under test must be the real
// app: adding an introspection endpoint to it would mean the process the parent
// measures is not the process production runs.
//
// It reports facts about the CHILD PROCESS that the parent has no other way to
// read: its identity, and the Sheets mutations it has actually performed.
const proof = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    pid: process.pid,
    process_id: INSTANCE_ID,
    sheet_calls: { append: calls.append.length, delete: calls.delete.length, update: calls.update.length },
  }));
});

const server = app.listen(0, '127.0.0.1', () => {
  proof.listen(0, '127.0.0.1', () => {
    process.stdout.write(`READY ${server.address().port} ${proof.address().port} ${process.pid} ${INSTANCE_ID}\n`);
  });
});

// The parent kills this child when it is done with it.
process.on('SIGTERM', () => {
  proof.close();
  server.close(() => process.exit(0));
});
