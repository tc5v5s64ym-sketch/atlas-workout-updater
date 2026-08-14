'use strict';

// POST /api/log-modality — the dry-run write-safety pin.
//
// WHY THIS FILE EXISTS. `test/liveSessionManifestContract.test.js` declares this
// route's request body `assembled`, which means its body is verified by a pinned
// branch OUTCOME rather than by an inline fixture. That pin lived in
// `test/liveSessionReadBudget.test.js`, which S4 deleted with the rest of the
// read-budget authority (design §5.4).
//
// Deleting a suite deletes the guarantees it carried. The manifest contract guard
// caught exactly that and went red, naming this route. The pin is restored here
// rather than the guard being relaxed: `POST /api/log-modality -> 200
// no_write:true` is a WRITE-SAFETY statement — a dry run must confirm it wrote
// nothing — and it is not the read budget's property to own.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';

const appended = [];

const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = {
  id: sheetsPath, filename: sheetsPath, loaded: true,
  exports: {
    validateConfig: () => {},
    appendRows: async (tab, rows) => {
      appended.push({ tab, rows });
      return { data: { updates: { updatedRows: rows.length, updatedRange: `${tab}!A2:L2` } } };
    },
    getSpreadsheetTabs: async () => ['Modality_Log'],
    getSheetRows: async () => [],
    getRecentRows: async () => [],
    getHeaderRow: async () => [],
    readRange: async () => [],
    getEffortSessionIds: async () => [],
    getLogCompositeKeys: async () => [],
    deleteRowsByRange: async () => ({}),
    invalidateTabCache: () => {},
    declareRequestRanges: () => {},
    // sheets.js signature is (fn, request) — not (ctx, fn). Getting this backwards
    // makes every request 500 with "fn is not a function".
    runWithReadContext: (fn) => fn(),
    currentRequestIdentity: () => null,
    logSheetName: 'Log_Cleaned',
    effortSheetName: 'Effort',
    classifySheetsReadError: () => null,
    sheetsReadFailureClass: () => null,
    getSafeSpreadsheetConfig: () => ({ canVerify: false, source: 'GOOGLE_SHEETS_ID' }),
  },
};

// Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
// blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
require('./helpers/stubExerciseCatalog').installExerciseCatalogStub();
// The workout authority is Supabase since the S4 cutover, so stubbing `sheets.js`
// no longer controls the logged sets, the Effort row, the plan ledgers or the write
// receipts. `sheetsFallback` seeds this suite's existing fixture into the double, so
// no test's data changes — only where the route reads it from.
require('./helpers/stubWorkoutAuthority').installWorkoutAuthorityStub({ sheetsFallback: true });
const { app } = require('../index');

let server; let baseUrl;
test.before(async () => {
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function post(url, body) {
  const res = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The pinned outcome, in the exact form the manifest contract guard looks for:
//   'POST /api/log-modality -> 200 no_write:true'
test('POST /api/log-modality -> 200 no_write:true — a dry run confirms it wrote nothing', async () => {
  appended.length = 0;

  const res = await post('/api/log-modality', {
    date: '2026-08-13',
    session_id: '20260813-AM-01',
    text: '20 min bike intervals',
    test_mode: true,
  });

  assert.equal(res.status, 200);
  // The proof field itself. A dry run that does not positively confirm the absence
  // of a write is indistinguishable from one whose write silently failed.
  assert.equal(res.body.data.no_write_confirmed, true);
  assert.equal(res.body.data.sheet_written, false);

  // And the structural half: nothing reached the Sheets client at all.
  assert.deepEqual(appended, [], 'a dry run must issue no append');
});

test('the dry run needs no write_id, and the live path still demands one', async () => {
  // The dry run returns before the write_id gate, which is why the pin above sends
  // none. The live path must still refuse without it, or the dry run's freedom
  // would have widened the write contract.
  const live = await post('/api/log-modality', {
    date: '2026-08-13',
    session_id: '20260813-AM-01',
    text: '20 min bike intervals',
  });
  assert.equal(live.status, 400);
  assert.match(String(live.body.message), /write_id is required/);
  assert.deepEqual(appended, [], 'a refused live write must append nothing');
});
