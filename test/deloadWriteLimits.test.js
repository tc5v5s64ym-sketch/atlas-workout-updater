'use strict';

// #1794 — the three deload lifecycle writes ride the tight WRITE rate-limit
// bucket (60 per 10 min by default) with the other write routes, not only the
// general /api limiter (300/min). A double-tap is two requests; the bucket is
// the backstop that bounds a runaway retry loop even when no write_id is sent.
//
// The bucket is shared across every path in the write list, so this file uses a
// tiny bucket (2) and counts its own requests: two deload writes pass, the
// third is refused 429 before any handler runs. The deload READ
// (GET /api/deload/status) is not in the list and must still answer once the
// write bucket is exhausted — the freeze/limiter work never sweeps reads in.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ATLAS_API_KEY = 'test-api-key-stub';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '2';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// Per-process receipt file: a previous run's completed write_ids must never
// replay into this run (the store persists to disk by design).
process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
  require('node:os').tmpdir(), `atlas-deload-write-limits-${process.pid}.json`);

const DELOAD_HEADER = ['updated_at', 'training_state', 'deload_protocol', 'deload_reason', 'deload_start_date', 'deload_sessions_remaining', 'deload_exit_criteria'];

// Minimal Deload_State model: header + data rows, in sheet order. Appends are
// visible to later reads, which is what the state machine decides on.
const state = { deloadSheet: [[...DELOAD_HEADER]] };

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
    if (tab === 'Deload_State') {
      for (const r of rows) state.deloadSheet.push([...r]);
    }
    return { data: { updates: { updatedRange: `${tab}!A100:${endColumnFor(rows)}${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => [
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
    ['Back Squat', 'Legs', 'SQ01', 'Back Squat', 'back squat|squat|squats'],
  ],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async (tab) => {
    if (tab === 'Deload_State') return state.deloadSheet.slice(1).map(r => [...r]);
    return [];
  },
  getHeaderRow: async () => [],
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Deload_State'],
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const { app } = require('../index');

let server;
let baseUrl;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });

async function post(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(payload || {}),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { /* non-JSON error body */ }
  return { response, body };
}

test('#1794: the third deload write in a tiny bucket is refused 429', async () => {
  // Write 1 passes the limiter and applies (NORMAL → DELOAD_ACTIVE).
  const first = await post('/api/deload/begin', { focus: 'strength', sessions_remaining: 3 });
  assert.equal(first.response.status, 200, `first begin must succeed: ${JSON.stringify(first.body).slice(0, 200)}`);
  // Write 2 passes the limiter and reaches the handler — the state machine
  // refuses it (already deloading), which still consumed a bucket token.
  const second = await post('/api/deload/begin', { focus: 'strength', sessions_remaining: 3 });
  assert.equal(second.response.status, 409, `second begin must reach the state machine: ${JSON.stringify(second.body).slice(0, 200)}`);
  // Write 3 never reaches a handler: the write bucket is spent.
  const third = await post('/api/deload/advance', {});
  assert.equal(third.response.status, 429, `third write must be rate-limited: ${JSON.stringify(third.body).slice(0, 200)}`);
  assert.equal(third.body.message, 'Too many requests');
});

test('#1794: the deload read still answers once the write bucket is spent', async () => {
  const response = await fetch(`${baseUrl}/api/deload/status`, {
    headers: { 'x-atlas-api-key': process.env.ATLAS_API_KEY },
  });
  assert.equal(response.status, 200, 'GET /api/deload/status is not a write and must not draw from the write bucket');
  const body = await response.json();
  assert.equal(body.data.state.training_state, 'DELOAD_ACTIVE');
});
