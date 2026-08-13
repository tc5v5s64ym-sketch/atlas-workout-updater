'use strict';

// PR1 — sheets.js adapter contract tests.
//
// sheets.js is the Google Sheets I/O layer. Every other test in this repo
// *stubs* it, so its own functions (range construction, the undo row-index
// math, header handling, private-key normalization) were never exercised. This
// file does the inverse: it injects a fake `googleapis` module into the require
// cache BEFORE loading the REAL sheets.js, so the adapter runs end-to-end
// against an in-memory client. No live spreadsheet, no network.
//
// These are pure contract tests over CURRENT behaviour — they assert what the
// adapter sends to the Sheets API, not that the API does anything. They do not
// change sheets.js. If one ever fails, that is a finding to report, not a cue to
// edit sheets.js inside this PR.

const test = require('node:test');
const assert = require('node:assert/strict');

// --- Env must be set before sheets.js is required: it captures these at load. ---
// Set unconditionally (not `|| default`) so the spreadsheetId / client_email
// equality assertions are hermetic — a real GOOGLE_SHEETS_ID exported in the
// environment must not leak in and fail the test. node:test isolates each file
// in its own process, so overriding here cannot affect other suites.
process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
// Literal backslash-n sequences, exactly how a PEM key arrives via env. We use
// a neutral fixture (NOT a real PEM header) on purpose: getPrivateKey() only
// un-escapes `\n`, so this exercises the full contract without tripping the
// repo's private-key secret scanner on a fake key.
process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\nKEYLINE3\\n';

// --- Fake googleapis. Records every request so tests can assert the payload. ---
const calls = {
  append: [],
  valuesGet: [],
  valuesUpdate: [],
  spreadsheetsGet: [],
  batchUpdate: [],
  sheetsFactory: []
};

// Per-test responses (reset in beforeEach via resetFake()).
let appendResponse;
let valuesGetResponse;
let spreadsheetsGetResponse;

function resetFake() {
  calls.append.length = 0;
  calls.valuesGet.length = 0;
  calls.valuesUpdate.length = 0;
  calls.spreadsheetsGet.length = 0;
  calls.batchUpdate.length = 0;
  calls.sheetsFactory.length = 0;
  appendResponse = { data: { updates: { updatedRows: 1, updatedRange: "'Tab'!A2:L2" } } };
  valuesGetResponse = { data: { values: [] } };
  spreadsheetsGetResponse = { data: { sheets: [] } };
}
resetFake();

const fakeSheetsClient = {
  spreadsheets: {
    get: async (args) => { calls.spreadsheetsGet.push(args); return spreadsheetsGetResponse; },
    batchUpdate: async (args) => { calls.batchUpdate.push(args); return { data: {} }; },
    values: {
      append: async (args) => { calls.append.push(args); return appendResponse; },
      get: async (args) => { calls.valuesGet.push(args); return valuesGetResponse; },
      update: async (args) => { calls.valuesUpdate.push(args); return { data: {} }; }
    }
  }
};

// Records the credentials sheets.js builds, so getPrivateKey()'s effect is observable.
let lastGoogleAuthConfig = null;

const fakeGoogle = {
  auth: {
    // sheets.js does `new google.auth.GoogleAuth({...})` then `await auth.getClient()`.
    GoogleAuth: class FakeGoogleAuth {
      constructor(config) { lastGoogleAuthConfig = config; }
      async getClient() { return { __fakeAuthClient: true }; }
    }
  },
  sheets: (opts) => { calls.sheetsFactory.push(opts); return fakeSheetsClient; }
};

const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath,
  filename: googleapisPath,
  loaded: true,
  exports: { google: fakeGoogle }
};

// Now load the REAL adapter against the fake client.
const sheets = require('../sheets');

test.beforeEach(() => resetFake());

// ---------------------------------------------------------------------------
// getPrivateKey — newline un-escaping
// ---------------------------------------------------------------------------
test('getSheetsClient builds auth credentials whose key has real newlines (getPrivateKey un-escapes \\n)', async () => {
  lastGoogleAuthConfig = null;
  await sheets.appendRows('Log_Cleaned', [['a']]); // forces getSheetsClient()

  assert.ok(lastGoogleAuthConfig, 'GoogleAuth should have been constructed');
  assert.equal(lastGoogleAuthConfig.credentials.client_email, 'svc@example.iam.gserviceaccount.com');
  const key = lastGoogleAuthConfig.credentials.private_key;
  assert.ok(!key.includes('\\n'), 'no literal backslash-n should remain');
  assert.ok(key.includes('\n'), 'real newlines should be present');
  assert.equal(key, 'KEYLINE1\nKEYLINE2\nKEYLINE3\n');
});

// ---------------------------------------------------------------------------
// appendRows — range construction + request shape + empty guard
// ---------------------------------------------------------------------------
test('appendRows targets `${tab}!A1` with RAW / INSERT_ROWS and the given rows', async () => {
  const rows = [['2026-06-29', 'sess', 'Bench', 'bench_press']];
  await sheets.appendRows('Log_Cleaned', rows);

  assert.equal(calls.append.length, 1);
  const req = calls.append[0];
  assert.equal(req.spreadsheetId, 'test-spreadsheet-id');
  assert.equal(req.range, 'Log_Cleaned!A1');
  assert.equal(req.valueInputOption, 'RAW');
  assert.equal(req.insertDataOption, 'INSERT_ROWS');
  assert.deepEqual(req.requestBody.values, rows);
});

test('appendRows rejects a non-array / empty rows payload without calling the API', async () => {
  await assert.rejects(() => sheets.appendRows('Log_Cleaned', []), /non-empty array/);
  await assert.rejects(() => sheets.appendRows('Log_Cleaned', null), /non-empty array/);
  assert.equal(calls.append.length, 0, 'no append request should be issued on a bad payload');
});

// ---------------------------------------------------------------------------
// readRange / getSheetRows — range construction
// ---------------------------------------------------------------------------
test('readRange passes the A1 range through verbatim and returns values (or [])', async () => {
  valuesGetResponse = { data: { values: [['h1', 'h2'], ['x', 'y']] } };
  const out = await sheets.readRange("Log_Cleaned!A2:L2");
  assert.equal(calls.valuesGet.length, 1);
  assert.equal(calls.valuesGet[0].range, "Log_Cleaned!A2:L2");
  assert.deepEqual(out, [['h1', 'h2'], ['x', 'y']]);

  resetFake();
  valuesGetResponse = { data: {} }; // no values key
  assert.deepEqual(await sheets.readRange('Tab!A1'), []);
});

test('getSheetRows reads `${tab}!A:Z`, drops the header row, and normalizes undefined cells', async () => {
  valuesGetResponse = {
    data: { values: [['date', 'exercise'], ['2026-06-29', undefined], ['2026-06-30', 'Squat']] }
  };
  const out = await sheets.getSheetRows('Log_Cleaned');
  assert.equal(calls.valuesGet[0].range, 'Log_Cleaned!A:Z');
  // header excluded, undefined cell -> ''
  assert.deepEqual(out, [['2026-06-29', ''], ['2026-06-30', 'Squat']]);
});

test('getSheetRows applies a finite maxRows from the TOP and returns [] when only a header exists', async () => {
  valuesGetResponse = { data: { values: [['h'], ['r1'], ['r2'], ['r3']] } };
  assert.deepEqual(await sheets.getSheetRows('Tab', 2), [['r1'], ['r2']]);

  resetFake();
  valuesGetResponse = { data: { values: [['only-header']] } };
  assert.deepEqual(await sheets.getSheetRows('Tab'), []);
});

// ---------------------------------------------------------------------------
// deleteRowsByRange IS GONE, and with it these two tests (design 5.4, 5.6).
// ---------------------------------------------------------------------------
//
// It was the undo backbone while undo removed Log_Cleaned rows by POSITION. A
// row-shifting delete is incompatible with the durable per-tab export allocations
// the Sheets mirror now depends on — removing a row slides every row below it,
// including a block already allocated to another session.
//
// Undo deletes by (session_id, write_id) in Supabase instead, which is identity
// rather than position. test/finalizedUndoGuard.test.js drives that path through
// the real route, and test-pg/ proves it against a real database.
// ---------------------------------------------------------------------------
// ensureSheetTab — must not mutate the wrong tab or clobber an existing header
// ---------------------------------------------------------------------------
test('ensureSheetTab does nothing destructive when the tab exists and already has a header', async () => {
  spreadsheetsGetResponse = { data: { sheets: [{ properties: { title: 'Constraints', sheetId: 7 } }] } };
  valuesGetResponse = { data: { values: [['date', 'kind', 'target', 'rule', 'note']] } };

  await sheets.ensureSheetTab('Constraints', ['date', 'kind', 'target', 'rule', 'note']);

  assert.equal(calls.batchUpdate.length, 0, 'existing tab => no addSheet');
  assert.equal(calls.valuesUpdate.length, 0, 'existing header => header must NOT be overwritten');
});

test('ensureSheetTab creates a missing tab by its own title and seeds the header at A1 once', async () => {
  // Tab absent at meta-read time; header read then comes back empty.
  spreadsheetsGetResponse = { data: { sheets: [{ properties: { title: 'Other', sheetId: 1 } }] } };
  valuesGetResponse = { data: { values: [] } };

  await sheets.ensureSheetTab('Constraints', ['date', 'kind', 'target', 'rule', 'note']);

  assert.equal(calls.batchUpdate.length, 1, 'missing tab => exactly one addSheet');
  const addReq = calls.batchUpdate[0].requestBody.requests[0].addSheet;
  assert.equal(addReq.properties.title, 'Constraints', 'addSheet must target the requested title');

  assert.equal(calls.valuesUpdate.length, 1, 'empty header => seed it');
  const upd = calls.valuesUpdate[0];
  assert.equal(upd.range, 'Constraints!A1');
  assert.deepEqual(upd.requestBody.values, [['date', 'kind', 'target', 'rule', 'note']]);
});

test('ensureSheetTab with no header argument never writes header values', async () => {
  spreadsheetsGetResponse = { data: { sheets: [] } };
  valuesGetResponse = { data: { values: [] } };

  await sheets.ensureSheetTab('NewTab'); // headerRow defaults to []

  assert.equal(calls.batchUpdate.length, 1, 'missing tab still gets created');
  assert.equal(calls.valuesUpdate.length, 0, 'no header arg => no header write, no header read');
  assert.equal(calls.valuesGet.length, 0);
});
