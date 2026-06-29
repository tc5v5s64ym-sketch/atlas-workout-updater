'use strict';

// PR1b — sheets.js adapter read-helper contract tests.
//
// Follow-up to test/sheets-adapter.test.js (PR1). Same approach: inject a fake
// `googleapis` before loading the REAL sheets.js so the read helpers run against
// an in-memory client (no live sheet, no network). PR1 covered the write/undo
// surface; this file covers the remaining read helpers that were still
// uncovered: getRecentRows, getHeaderRow, getSpreadsheetTabs,
// getExerciseCatalog, getEffortSessionIds, getLogCompositeKeys. (getColumnValues
// is module-private — not exported — so its range/COLUMNS/first-column contract
// is covered transitively through getEffortSessionIds and getLogCompositeKeys,
// which both assert the exact column range and the shaped output.)
//
// Pure contract tests over CURRENT behaviour — they assert what the adapter
// requests and how it shapes the response, not that the API does anything. They
// do not change sheets.js.

const test = require('node:test');
const assert = require('node:assert/strict');

// Env captured by sheets.js at load — set unconditionally so reads are hermetic.
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';

// --- Range-aware fake googleapis. values.get resolves by the requested range so
// multi-column readers (getLogCompositeKeys) can be driven per column. ---
const calls = { valuesGet: [], spreadsheetsGet: [] };
let rangeResponses = {};          // range string -> { data: { values } }
let defaultValuesResponse = { data: { values: [] } };
let spreadsheetsGetResponse = { data: { sheets: [] } };

function resetFake() {
  calls.valuesGet.length = 0;
  calls.spreadsheetsGet.length = 0;
  rangeResponses = {};
  defaultValuesResponse = { data: { values: [] } };
  spreadsheetsGetResponse = { data: { sheets: [] } };
}
resetFake();

const fakeSheetsClient = {
  spreadsheets: {
    get: async (args) => { calls.spreadsheetsGet.push(args); return spreadsheetsGetResponse; },
    batchUpdate: async () => ({ data: {} }),
    values: {
      get: async (args) => {
        calls.valuesGet.push(args);
        return Object.prototype.hasOwnProperty.call(rangeResponses, args.range)
          ? rangeResponses[args.range]
          : defaultValuesResponse;
      },
      append: async () => ({ data: { updates: {} } }),
      update: async () => ({ data: {} })
    }
  }
};

const fakeGoogle = {
  auth: { GoogleAuth: class { async getClient() { return {}; } } },
  sheets: () => fakeSheetsClient
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath,
  filename: googleapisPath,
  loaded: true,
  exports: { google: fakeGoogle }
};

const sheets = require('../sheets');

test.beforeEach(() => resetFake());

// ---------------------------------------------------------------------------
// getHeaderRow — `${tab}!1:1`, first row or []
// ---------------------------------------------------------------------------
test('getHeaderRow reads row 1 and returns the header array (or [])', async () => {
  rangeResponses['Log_Cleaned!1:1'] = { data: { values: [['date_clean', 'session_id', 'exercise']] } };
  assert.deepEqual(await sheets.getHeaderRow('Log_Cleaned'), ['date_clean', 'session_id', 'exercise']);
  assert.equal(calls.valuesGet[0].range, 'Log_Cleaned!1:1');

  resetFake();
  assert.deepEqual(await sheets.getHeaderRow('Empty'), []); // default empty -> []
});

// ---------------------------------------------------------------------------
// getRecentRows — `${tab}!A:Z`, header-strip, tail slice(-maxRows), undefined->''
// ---------------------------------------------------------------------------
test('getRecentRows strips the header, normalizes undefined cells, and tails the last maxRows', async () => {
  rangeResponses['Log_Cleaned!A:Z'] = {
    data: { values: [['h1', 'h2'], ['r1a', undefined], ['r2a', 'r2b'], ['r3a', 'r3b']] }
  };
  const out = await sheets.getRecentRows('Log_Cleaned', 2);
  assert.equal(calls.valuesGet[0].range, 'Log_Cleaned!A:Z');
  // last 2 data rows (header excluded); undefined would have normalized to '' if present in tail
  assert.deepEqual(out, [['r2a', 'r2b'], ['r3a', 'r3b']]);
});

test('getRecentRows returns [] when only a header row exists', async () => {
  rangeResponses['Tab!A:Z'] = { data: { values: [['only-header']] } };
  assert.deepEqual(await sheets.getRecentRows('Tab'), []);
});

// ---------------------------------------------------------------------------
// getExerciseCatalog — `Exercise_Catalog!A:Z`, raw values (incl. header) or []
// ---------------------------------------------------------------------------
test('getExerciseCatalog reads Exercise_Catalog!A:Z and returns all rows verbatim (header included)', async () => {
  rangeResponses['Exercise_Catalog!A:Z'] = {
    data: { values: [['Canonical_Name', 'Lift_Code'], ['Bench Press', 'BP01']] }
  };
  const out = await sheets.getExerciseCatalog();
  assert.equal(calls.valuesGet[0].range, 'Exercise_Catalog!A:Z');
  assert.deepEqual(out, [['Canonical_Name', 'Lift_Code'], ['Bench Press', 'BP01']]);

  resetFake();
  assert.deepEqual(await sheets.getExerciseCatalog(), []); // default empty -> []
});

// ---------------------------------------------------------------------------
// getSpreadsheetTabs — sheet titles, String()-coerced
// ---------------------------------------------------------------------------
test('getSpreadsheetTabs returns each sheet title as a string', async () => {
  spreadsheetsGetResponse = {
    data: { sheets: [
      { properties: { title: 'Log_Cleaned' } },
      { properties: { title: 'Effort' } },
      { properties: { title: 123 } } // coerced to string
    ] }
  };
  assert.deepEqual(await sheets.getSpreadsheetTabs(), ['Log_Cleaned', 'Effort', '123']);
  assert.equal(calls.spreadsheetsGet[0].fields, 'sheets.properties');

  resetFake();
  assert.deepEqual(await sheets.getSpreadsheetTabs(), []); // no sheets -> []
});

// ---------------------------------------------------------------------------
// getEffortSessionIds — Effort col B, trimmed, header + blanks dropped
// ---------------------------------------------------------------------------
test('getEffortSessionIds reads Effort column B and drops blanks and the "session id" header', async () => {
  rangeResponses['Effort!B:B'] = {
    data: { values: [['Session ID', 'sess-1', '  sess-2  ', '', 'sess-3']] }
  };
  const out = await sheets.getEffortSessionIds();
  assert.equal(calls.valuesGet[0].range, 'Effort!B:B');
  assert.equal(calls.valuesGet[0].majorDimension, 'COLUMNS'); // via module-private getColumnValues
  assert.deepEqual(out, ['sess-1', 'sess-2', 'sess-3']); // header + blank removed, trimmed
});

// ---------------------------------------------------------------------------
// getLogCompositeKeys — B/C/G joined, header rows skipped, lowercased
// ---------------------------------------------------------------------------
test('getLogCompositeKeys builds lowercased session||exercise||set keys, skipping header and incomplete rows', async () => {
  rangeResponses['Log_Cleaned!B:B'] = { data: { values: [['session_id', 'S1', 'S2', 'S3']] } };
  rangeResponses['Log_Cleaned!C:C'] = { data: { values: [['exercise', 'Bench', 'Squat', '']] } };
  rangeResponses['Log_Cleaned!G:G'] = { data: { values: [['set_number', '1', '2', '3']] } };

  const out = await sheets.getLogCompositeKeys();

  // Row 0 is a header (matches session id / exercise / set_number) -> skipped.
  // Row 3 has an empty exercise -> skipped (all three fields required).
  assert.deepEqual(out, ['s1||bench||1', 's2||squat||2']);
});

test('getLogCompositeKeys tolerates ragged columns and returns [] when nothing complete', async () => {
  rangeResponses['Log_Cleaned!B:B'] = { data: { values: [['S1', 'S2']] } };
  rangeResponses['Log_Cleaned!C:C'] = { data: { values: [['Bench']] } };       // shorter
  rangeResponses['Log_Cleaned!G:G'] = { data: { values: [[]] } };              // empty

  // Only index 0 could pair, but set_number is missing -> dropped.
  assert.deepEqual(await sheets.getLogCompositeKeys(), []);
});
