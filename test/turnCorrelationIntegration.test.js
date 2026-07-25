'use strict';

// #1165 INTEGRATION — the correlation seam through the REAL /api/log-workout route, with
// sheets stubbed in memory. The unit tests (test/turnCorrelation.test.js) prove the module;
// this file proves the WIRING, which is where the historical failure actually lives: the
// coach turn ends on a read-only route, so unless the write route really resolves and emits,
// write_proof stays absent no matter how correct the helper is.
//
// Proves, through the served route:
//   • a valid claim (server-issued, same session, fresh) emits ONE correlation record whose
//     proof fields match the response body verbatim;
//   • the dry-run path correlates too, carrying the W1–W3 no-write proof;
//   • every fail-closed case (unknown / cross-session / stale / malformed / absent) emits
//     NOTHING — and the write still succeeds unchanged, because correlation is telemetry
//     riding alongside the trust loop, never part of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { logCleanedColumns, effortColumns, sessionPlansColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
// The correlation record is shadow-gated exactly like the packet/trace shadow, so the
// integration must run with the shadow ON — otherwise it would prove only that a disabled
// feature stays silent.
process.env.ATLAS_INTERACTION_TRACE = 'shadow';

const state = { appends: [] };

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    return { data: { updates: { updatedRange: `${tab}!A100:L${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async (range) => {
    if (String(range).startsWith('Session_Plans!')) return [[...sessionPlansColumns]];
    return [];
  },
  updateColumnCells: async () => ({ data: { totalUpdatedCells: 0 } }),
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => ([
    ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
    ['Bench Press', 'Chest', 'BEN01', 'Bench Press', 'bench press|bench'],
  ]),
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getHeaderRow: async tab => {
    if (tab === 'Log_Cleaned') return [...logCleanedColumns];
    if (tab === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort'],
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const tc = require('../services/turnCorrelation');
const { app } = require('../index');

const SESSION_ID = 'TC-INT-1';
const OTHER_SESSION = 'TC-INT-2';
const TURN_ID = 'turn:2026-07-25T12:00:00.000Z_7_int001';

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function logRows() {
  return [{ exercise: 'Bench Press', weight: 225, reps: 5, rir: 2, set_number: 1 }];
}

async function postWrite(body) {
  const res = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// A dry-run keeps every assertion write-free while still exercising the identical
// correlation seam (the resolve → record path is shared by both returns).
function dryRunPayload(extra) {
  return {
    session_id: SESSION_ID,
    date: '2026-07-25',
    test_mode: true,
    log_rows: logRows(),
    ...extra,
  };
}

test('a valid claim correlates the dry-run W1–W3 proof to the turn', async () => {
  tc._resetForTesting();
  tc.issueTurn(TURN_ID, SESSION_ID);

  const { status, body } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200);
  assert.equal(body.data.no_write_confirmed, true, 'the dry-run proof must be intact');
  assert.equal(body.data.sheet_written, false);

  const records = tc.recentWriteProofs();
  assert.equal(records.length, 1, 'exactly one correlation record');
  const rec = records[0];
  assert.equal(rec.turn_id, TURN_ID);
  assert.equal(rec.session_id, SESSION_ID);
  assert.equal(rec.route, '/api/log-workout');
  // The proof is the ROUTE's, copied verbatim — this is the join the Phase-4 gate asked for.
  assert.equal(rec.proof.no_write_confirmed, true);
  assert.equal(rec.proof.sheet_written, false);
  assert.equal(rec.proof.test_mode, true);
  // The row previews on that body are arrays and must not survive into the record.
  assert.ok(!('log_rows_preview' in rec.proof));
  assert.ok(!JSON.stringify(rec).includes('Bench Press'), 'no workout data in the record');
});

test('fail-closed: a claim the server never issued correlates nothing, and the write is unaffected', async () => {
  tc._resetForTesting(); // nothing issued
  const { status, body } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200, 'the write must still succeed');
  assert.equal(body.data.no_write_confirmed, true);
  assert.equal(tc.recentWriteProofs().length, 0, 'an unknown id must correlate nothing');
});

test('fail-closed: a turn issued for ANOTHER session cannot be claimed (no contamination)', async () => {
  tc._resetForTesting();
  tc.issueTurn(TURN_ID, OTHER_SESSION);
  const { status } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200);
  assert.equal(tc.recentWriteProofs().length, 0, 'cross-session correlation must never be recorded');
});

test('fail-closed: a stale turn cannot be claimed', async () => {
  tc._resetForTesting();
  // Issued far enough in the past that the claim is outside the freshness window.
  tc.issueTurn(TURN_ID, SESSION_ID, { nowMs: Date.now() - (tc.DEFAULT_MAX_AGE_MS + 60_000) });
  const { status } = await postWrite(dryRunPayload({ correlation: { turn_id: TURN_ID } }));
  assert.equal(status, 200);
  assert.equal(tc.recentWriteProofs().length, 0, 'a stale turn must correlate nothing');
});

test('fail-closed: malformed and absent claims correlate nothing, and never break the write', async () => {
  for (const correlation of [undefined, null, 'turn:whatever', {}, { turn_id: 'nope' }, { turn_id: 12 }]) {
    tc._resetForTesting();
    tc.issueTurn(TURN_ID, SESSION_ID);
    const payload = dryRunPayload({});
    if (correlation !== undefined) payload.correlation = correlation;
    const { status, body } = await postWrite(payload);
    assert.equal(status, 200, `write must succeed for ${JSON.stringify(correlation)}`);
    assert.equal(body.data.no_write_confirmed, true);
    assert.equal(tc.recentWriteProofs().length, 0, `must correlate nothing for ${JSON.stringify(correlation)}`);
  }
});

test('a live write correlates its success proof, including the appended range', async () => {
  tc._resetForTesting();
  state.appends.length = 0;
  tc.issueTurn(TURN_ID, SESSION_ID);

  const { status, body } = await postWrite({
    session_id: SESSION_ID,
    date: '2026-07-25',
    write_id: 'wid-int-1',
    log_rows: logRows(),
    correlation: { turn_id: TURN_ID },
  });
  assert.equal(status, 200);
  assert.equal(body.data.sheet_write, 'success');

  const records = tc.recentWriteProofs();
  assert.equal(records.length, 1);
  assert.equal(records[0].turn_id, TURN_ID);
  assert.equal(records[0].proof.sheet_write, 'success');
  // The appended range is the write's identity and the undo's authority — the single most
  // useful thing to have joined to the turn.
  assert.equal(records[0].proof.logAppendedRange, body.data.logAppendedRange);
  assert.ok(!JSON.stringify(records[0]).includes('stub-sheet'), 'no Sheet ID in the record');
});
