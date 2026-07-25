'use strict';

// #1173 item 3 — the DUPLICATE-CLOSEOUT branch, with the Session Plan lanes LIVE.
//
// This is the gap #1173 recorded as item 3, and the reason it was a separate item: the
// all-rows-duplicate branch in index.js correlates when `ledger_seal` or `session_plans_closeout`
// is present, and that gate rested on reasoning alone. Exercising it needs the lanes enabled and a
// seal fixture — a heavier harness than test/turnCorrelationIntegration.test.js carries, which is
// why that file could only reach this branch with both lanes OFF (a dry-run seal, `status:'disabled'`)
// and said so rather than implying a live stamp.
//
// Here the seal REALLY stamps and the closeout event REALLY appends, so this proves the two things
// the lanes-off case could not:
//   • the branch's correlation gate fires on a genuine sealed sidecar write;
//   • the projected evidence reports that write truthfully — `ledger_seal_sheet_written: true`,
//     a positive `ledger_seal_sealed` count, `sealed_ok: true`, and `captured: true` — which is
//     exactly what the pre-#1173 record could not carry, since both envelopes are nested objects
//     the scalar-only filter dropped.
//
// Built from the test/closeoutSealIntegration.test.js harness (sandbox posture: lanes on, a
// STUBBED Session_Plan_Sets tab, nothing real reachable because sheets.js is replaced). It is a
// separate file deliberately: that suite proves owner-directive seal semantics across 400+ lines,
// and enabling the correlation shadow globally there would perturb it for no benefit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetIdempotencyStore } = require('../services/idempotency');
const { logCleanedColumns, effortColumns, sessionPlanSetsColumns, sessionPlansColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// The SANDBOX posture this file exists for: both sidecar lanes are LIVE and the (stubbed) tabs
// exist, so the seal genuinely stamps and the closeout event genuinely appends.
process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';
process.env.ATLAS_SESSION_PLANS_WRITE = '1';
// The correlation record is shadow-gated like the packet/trace shadow, so this must run with the
// shadow ON — otherwise it would prove only that a disabled feature stays silent.
process.env.ATLAS_INTERACTION_TRACE = 'shadow';

const SEAL_IDX = sessionPlanSetsColumns.indexOf('closeout_write_id');

const state = {
  planSetRows: [],
  appends: [],
  updates: [],
  logCompositeKeys: [],
};

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Weighted Dip', 'Chest', 'DIP01', 'Weighted Dip', 'weighted dip|weighted dips|dips'],
];

const fakeSheets = {
  appendRows: async (tab, rows) => {
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    return { data: { updates: { updatedRange: `${tab}!A100:L${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async (range) => {
    if (String(range).startsWith('Session_Plans!')) return [[...sessionPlansColumns]];
    return [];
  },
  updateColumnCells: async (tab, column, cells) => {
    state.updates.push({ tab, column, cells: cells.map(c => ({ ...c })) });
    for (const c of cells) {
      const dataIdx = c.row - 2;
      if (state.planSetRows[dataIdx]) state.planSetRows[dataIdx][column.charCodeAt(0) - 65] = c.value;
    }
    return { data: { totalUpdatedCells: cells.length } };
  },
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [...state.logCompositeKeys],
  getRecentRows: async () => [],
  getSheetRows: async tab => {
    if (tab === 'Session_Plan_Sets') return state.planSetRows.map(r => [...r]);
    // Serve appended Session_Plans rows back so the capture layer's read-before-append
    // idempotency behaves exactly as it does against the real sheet.
    if (tab === 'Session_Plans') return state.appends.filter(a => a.tab === 'Session_Plans').flatMap(a => a.rows).map(r => [...r]);
    return [];
  },
  getHeaderRow: async tab => {
    if (tab === 'Log_Cleaned') return [...logCleanedColumns];
    if (tab === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => ([
    'Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Constraints', 'Deload_State', 'Session_Plans', 'Session_Plan_Sets',
  ]),
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const L = require('../services/sessionPlanLedger');
const tc = require('../services/turnCorrelation');
const { app } = require('../index');

const SESSION_ID = 'CO-DUPE-1';
const SESSION_DATE = '2026-07-18';
const TURN_ID = 'turn:2026-07-25T13:00:00.000Z_9_dupe01';
// A canonical accepted-plan token: `pv_` + UUID, exactly as src/app/planAcceptance.js mints them.
// The projection validates this shape (#1173 item 2), so a made-up token would be withheld and the
// discriminator assertion below would prove nothing.
const PLAN_VERSION = 'pv_7c9e6679-7425-40de-944b-e07fc1f90ae7';

const DIP_ACTUALS = [
  { exercise: 'Weighted Dip', set_number: 1, weight: 60, reps: 5, rir: 2 },
  { exercise: 'Weighted Dip', set_number: 2, weight: 60, reps: 5, rir: 2 },
  { exercise: 'Weighted Dip', set_number: 3, weight: 60, reps: 5, rir: 2 },
];

const CLOSEOUT_CONTEXT = {
  plan_version: PLAN_VERSION,
  items: [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', name: 'Weighted Dip', outcome: 'completed' }],
};

// Five unsealed ledger rows for this session, so the seal has real work to do.
function seedLedger() {
  const session = { session_id: SESSION_ID, session_date: SESSION_DATE };
  const rows = L.buildAcceptedRows(session, [
    { plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 },
  ], { recordedAt: 't1' });
  for (const set_index of [2, 3]) {
    rows.push(L.buildRevisionRow(session, {
      plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index, plan_version: 2, target_set_count: 3,
      target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision',
    }, { recordedAt: 't2' }));
  }
  state.planSetRows = rows;
}

// Composite keys are `session_id||exercise||set_number`, lowercased (index.js
// partitionLogRowsByExisting). Seeding all three makes EVERY intended log row a duplicate, which
// with no Effort row is exactly the all-rows-duplicate branch.
function everyLogRowAlreadyLogged() {
  return DIP_ACTUALS.map(r => `${SESSION_ID.toLowerCase()}||${r.exercise.toLowerCase()}||${r.set_number}`);
}

function reset() {
  resetIdempotencyStore();
  tc._resetForTesting();
  state.appends = [];
  state.updates = [];
  state.logCompositeKeys = [];
  seedLedger();
}

let server;
let baseUrl;
const originalConsoleLog = console.log;

test.before(async () => {
  console.log = () => {};
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
  } finally {
    console.log = originalConsoleLog;
  }
});

async function post(payload) {
  const response = await fetch(`${baseUrl}/api/log-workout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json(), headers: response.headers };
}

function closeoutPayload(extra = {}) {
  return {
    session_id: SESSION_ID,
    date: SESSION_DATE,
    log_rows: DIP_ACTUALS,
    closeout_context: CLOSEOUT_CONTEXT,
    ...extra,
  };
}

// The preview establishes the turn↔write pairing (#1173 item 1) and hands back its token, exactly
// as the client will in slice 2. Its payload identity must match the live write's, which it does:
// `test_mode` and `write_id` are both outside the fingerprint by design.
async function previewForToken() {
  // The dry-run must carry the claim: a preview with no `correlation` has nothing to pair, so no
  // token is minted. `correlation` is outside the payload fingerprint, so carrying a different
  // envelope here than on the live write does not disturb the identity match.
  const { headers } = await post(closeoutPayload({ test_mode: true, correlation: { turn_id: TURN_ID } }));
  return headers.get(tc.PAIRING_TOKEN_HEADER);
}

test('the duplicate-closeout branch: a REAL seal + closeout event, with the projected evidence to prove it', async () => {
  reset();
  tc.issueTurn(TURN_ID, SESSION_ID);
  const pairingToken = await previewForToken();
  assert.ok(pairingToken, 'the dry-run must hand back a pairing token');

  // Now every intended log row is already on the sheet. With no Effort row, the approve lands in
  // the all-rows-duplicate branch — which still seals and still records the closeout event.
  state.logCompositeKeys = everyLogRowAlreadyLogged();
  const appendsBefore = state.appends.length;

  const { response, body } = await post(closeoutPayload({
    write_id: 'w-dupe-live-1',
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  }));

  assert.equal(response.status, 200);
  const d = body.data;
  // It really is the branch under test.
  assert.equal(d.all_rows_duplicate, true, 'this must be the all-rows-duplicate branch');
  assert.equal(d.log_rows_written, 0, 'and it appended no Log_Cleaned rows');
  assert.equal(d.sheet_write, 'skipped_duplicate');
  assert.equal(
    state.appends.filter(a => a.tab === 'Log_Cleaned').length, 0,
    'no Log_Cleaned append happened at all',
  );

  // …and yet it performed a genuine SEALED SIDECAR WRITE. This is what the lanes-off case could
  // not reach, and it is the write the correlation trigger was added to capture.
  assert.equal(d.ledger_seal.sheet_written, true, 'the seal really stamped');
  assert.equal(d.ledger_seal.sealed_ok, true);
  assert.ok(d.ledger_seal.sealed > 0, `the seal stamped rows, got ${d.ledger_seal.sealed}`);
  assert.ok(state.updates.length > 0, 'a real updateColumnCells call happened');
  assert.equal(d.session_plans_closeout.captured, true, 'the closeout event was captured');
  assert.ok(
    state.appends.length > appendsBefore,
    'and a Session_Plans row was appended',
  );

  // THE POINT OF #1173 ITEM 2, now proven on a live stamp: the emitted record carries the seal and
  // closeout evidence. Before the projections it reported log_rows_written:0 and nothing else, so
  // it could not prove the very write it was emitted for.
  const records = tc.recentWriteProofs();
  assert.equal(records.length, 2, 'the preview record, then the duplicate-closeout record');
  const rec = records[1];
  assert.equal(rec.turn_id, TURN_ID);
  assert.equal(rec.session_id, SESSION_ID);

  // Asserted against the SERVED body, not hardcoded, so the record cannot drift from the response.
  assert.equal(rec.proof.ledger_seal_sheet_written, d.ledger_seal.sheet_written);
  assert.equal(rec.proof.ledger_seal_sealed, d.ledger_seal.sealed);
  assert.equal(rec.proof.ledger_seal_sealed_ok, d.ledger_seal.sealed_ok);
  assert.equal(rec.proof.ledger_seal_already_sealed, d.ledger_seal.already_sealed);
  assert.equal(rec.proof.session_plans_closeout_status, d.session_plans_closeout.status);
  assert.equal(rec.proof.session_plans_closeout_captured, true);
  assert.equal(rec.proof.session_plans_closeout_written, d.session_plans_closeout.written);
  // The row discriminator, which is why plan_version is projected at all: without it the artifact
  // join cannot say WHICH session_closeout row this record refers to.
  assert.equal(rec.proof.session_plans_closeout_plan_version, PLAN_VERSION);

  // The binding is preview-established, and the seal rode the approved write_id.
  assert.equal(rec.pairing.established_at_preview, true);
  assert.equal(rec.pairing.payload_bound, true);
  assert.equal(rec.proof.write_id, 'w-dupe-live-1');

  // Project, never pass through: no nested envelope, no workout data, no Sheet id.
  assert.ok(!('ledger_seal' in rec.proof), 'the nested seal envelope must not be carried');
  assert.ok(!('session_plans_closeout' in rec.proof));
  const serialized = JSON.stringify(rec);
  assert.ok(!serialized.includes('Weighted Dip'), 'no workout data in the record');
  assert.ok(!serialized.includes('stub-sheet'), 'no Sheet id in the record');
});

test('a duplicate replay that seals NOTHING new still reports honestly', async () => {
  reset();
  tc.issueTurn(TURN_ID, SESSION_ID);
  const pairingToken = await previewForToken();
  state.logCompositeKeys = everyLogRowAlreadyLogged();

  // Pre-seal every ledger row under THIS write_id, so the seal is an idempotent replay: verified,
  // but it writes nothing. The record must not read as a fresh stamp.
  const writeId = 'w-dupe-live-2';
  state.planSetRows = state.planSetRows.map(r => {
    const row = [...r];
    row[SEAL_IDX] = writeId;
    return row;
  });
  const updatesBefore = state.updates.length;

  const { response, body } = await post(closeoutPayload({
    write_id: writeId,
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  }));
  assert.equal(response.status, 200);
  const d = body.data;
  assert.equal(d.ledger_seal.sealed_ok, true, 'an already-sealed ledger is verified');
  assert.equal(d.ledger_seal.sheet_written, false, 'but nothing was written');
  assert.equal(state.updates.length, updatesBefore, 'and no cell update was issued');

  const rec = tc.recentWriteProofs().slice(-1)[0];
  // Verified-but-wrote-nothing must be distinguishable from a fresh stamp in the record itself —
  // otherwise the artifact would read an idempotent replay as a new sealed write.
  assert.equal(rec.proof.ledger_seal_sealed_ok, true);
  assert.equal(rec.proof.ledger_seal_sheet_written, false);
  assert.equal(rec.proof.ledger_seal_sealed, 0);
  assert.ok(rec.proof.ledger_seal_already_sealed > 0, 'the already-sealed count carries the truth');
});

test('a FAILED seal never lets the record read as a verified closeout', async () => {
  reset();
  tc.issueTurn(TURN_ID, SESSION_ID);
  const pairingToken = await previewForToken();
  state.logCompositeKeys = everyLogRowAlreadyLogged();

  // A row already sealed by a DIFFERENT closeout: the seal must fail closed and never re-seal.
  state.planSetRows[0] = (() => { const r = [...state.planSetRows[0]]; r[SEAL_IDX] = 'w-someone-elses'; return r; })();

  const { body } = await post(closeoutPayload({
    write_id: 'w-dupe-live-3',
    correlation: { turn_id: TURN_ID, pairing_token: pairingToken },
  }));
  const d = body.data;
  assert.equal(d.ledger_seal.sealed_ok, false, 'a conflicting seal fails closed');
  assert.equal(d.closeout_fully_verified, false);

  const rec = tc.recentWriteProofs().slice(-1)[0];
  assert.equal(rec.proof.ledger_seal_sealed_ok, false, 'the record must carry the failure');
  assert.equal(rec.proof.closeout_fully_verified, false);
  assert.equal(rec.proof.ledger_seal_reason, d.ledger_seal.reason);
  // The conflicting write id is the one piece of that envelope that must NEVER be published: it
  // names another closeout, and it arrives as an array the projection does not whitelist.
  assert.ok(!('ledger_seal_conflicting_write_ids' in rec.proof));
  assert.ok(!JSON.stringify(rec).includes('w-someone-elses'), 'no foreign write id in the record');
});
