'use strict';

// F10D — closeout seal INTEGRATION (sandbox posture): the real Express app with
// sheets stubbed in-memory, a Session_Plan_Sets tab PRESENT, and the owner flag
// SESSION_PLAN_SETS_WRITE_ENABLED=1 — proving the live seal semantics end-to-end
// through /api/log-workout without any real sheet existing anywhere.
//
// Proves (owner directive, 2026-07-18): visible-plan-to-ledger parity; visible-
// actual-to-Log_Cleaned parity; the seal rides the SAME approved write_id; seal
// failure never yields a false "fully verified closeout"; a fresh-write_id retry
// HEALS an unsealed closeout without re-appending; malformed ledger history fails
// the seal closed; a same-write_id retry replays idempotently.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetIdempotencyStore } = require('../services/idempotency');
const { logCleanedColumns, effortColumns, sessionPlanSetsColumns } = require('../config/columns');

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'test-private-key-stub';
process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_VISION_RATE_LIMIT_MAX = '1000000';
process.env.ATLAS_LOGIN_RATE_LIMIT_MAX = '1000000';
// The SANDBOX posture this file exists for: the ledger live-write lane is ON and
// the (stubbed) tab exists. Nothing real is reachable — sheets.js is replaced.
process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';

const SEAL_IDX = sessionPlanSetsColumns.indexOf('closeout_write_id');

const state = {
  planSetRows: [],       // Session_Plan_Sets data rows (header stripped)
  appends: [],           // every appendRows call
  updates: [],           // every updateColumnCells call
  updateCellsResult: null, // force a seal-proof mismatch when set
  failEffortAppend: false,
  failTabsProbe: false,    // metadata outage — the seal must fail closed
  logCompositeKeys: [],
};

const exerciseCatalogRows = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise', 'Original_Variants'],
  ['Weighted Dip', 'Chest', 'DIP01', 'Weighted Dip', 'weighted dip|weighted dips|dips'],
];

const fakeSheets = {
  appendRows: async (tab, rows) => {
    if (tab === 'Effort' && state.failEffortAppend) throw new Error('Simulated Effort append failure');
    state.appends.push({ tab, rows: rows.map(r => [...r]) });
    return { data: { updates: { updatedRange: `${tab}!A100:L${99 + rows.length}`, updatedRows: rows.length } } };
  },
  readRange: async () => [],
  updateColumnCells: async (tab, column, cells) => {
    state.updates.push({ tab, column, cells: cells.map(c => ({ ...c })) });
    for (const c of cells) {
      const dataIdx = c.row - 2;
      if (state.planSetRows[dataIdx]) state.planSetRows[dataIdx][column.charCodeAt(0) - 65] = c.value;
    }
    const total = state.updateCellsResult ? state.updateCellsResult.totalUpdatedCells : cells.length;
    return { data: { totalUpdatedCells: total } };
  },
  deleteRowsByRange: async () => ({ ok: true }),
  validateConfig: () => {},
  getExerciseCatalog: async () => exerciseCatalogRows,
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [...state.logCompositeKeys],
  getRecentRows: async () => [],
  getSheetRows: async tab => {
    if (tab === 'Session_Plan_Sets') return state.planSetRows.map(r => [...r]);
    return [];
  },
  getHeaderRow: async tab => {
    if (tab === 'Log_Cleaned') return [...logCleanedColumns];
    if (tab === 'Effort') return [...effortColumns];
    return [];
  },
  getSpreadsheetTabs: async () => {
    if (state.failTabsProbe) throw new Error('metadata outage');
    return [
      'Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Constraints', 'Deload_State', 'Session_Plans', 'Session_Plan_Sets'
    ];
  },
  ensureSheetTab: async () => ({ existed: true }),
  getSafeSpreadsheetConfig: () => ({ sheetId: 'stub-sheet', configured: true }),
  isTransientAppendError: () => false,
  retryWithBackoff: async fn => fn(),
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort'
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const L = require('../services/sessionPlanLedger');
const { app } = require('../index');

const SESSION_ID = 'CO-LIVE-1';

// The owner's July-16 canonical ledger: dips 65×5 ×3 accepted (v1), then Atlas
// explicitly revised sets 2–3 to 60 (v2). Five rows total, none sealed.
function seedDipsLedger() {
  const session = { session_id: SESSION_ID, session_date: '2026-07-18' };
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

function reset() {
  resetIdempotencyStore();
  state.appends = [];
  state.updates = [];
  state.updateCellsResult = null;
  state.failEffortAppend = false;
  state.failTabsProbe = false;
  state.logCompositeKeys = [];
  seedDipsLedger();
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

async function post(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': process.env.ATLAS_API_KEY },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

const DIP_ACTUALS = [
  { exercise: 'Weighted Dip', set_number: 1, weight: 60, reps: 5, rir: 2 },
  { exercise: 'Weighted Dip', set_number: 2, weight: 60, reps: 5, rir: 2 },
  { exercise: 'Weighted Dip', set_number: 3, weight: 60, reps: 5, rir: 2 },
];
const CLOSEOUT_CONTEXT = { items: [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', name: 'Weighted Dip', outcome: 'completed' }] };

function closeoutPayload(extra = {}) {
  return {
    session_id: SESSION_ID, date: '2026-07-18',
    log_rows: DIP_ACTUALS, closeout_context: CLOSEOUT_CONTEXT,
    ...extra
  };
}

test('closeout DRY-RUN with a stored ledger: both truths, per-set diffs, seal preview — and zero writes', async () => {
  reset();
  const { response, body } = await post('/api/log-workout', closeoutPayload({ test_mode: true }));
  assert.equal(response.status, 200);
  const d = body.data;
  assert.equal(d.no_write_confirmed, true);
  const s = d.closeout_summary;
  assert.equal(s.has_stored_plan, true);
  const item = s.items.find(i => i.plan_item_id === 'pi_dip');
  // Visible-plan parity: the confirmation's targets are EXACTLY the ledger's.
  assert.deepEqual(item.original_sets.map(x => x.target_weight), [65, 65, 65]);
  assert.deepEqual(item.effective_sets.map(x => x.target_weight), [65, 60, 60]);
  assert.deepEqual(item.target_vs_actual.map(x => x.weight_delta), [-5, 0, 0]);
  // Visible-actual parity: the exact rows the write will append are echoed.
  assert.deepEqual(s.rows_to_write.log, d.log_rows_preview);
  // Seal preview: all five ledger rows would be sealed; none written yet.
  assert.equal(s.rows_to_seal.count, 5);
  assert.equal(d.ledger_seal_preview.dry_run, true);
  assert.equal(d.ledger_seal_preview.reason, 'test_mode');
  assert.equal(state.appends.length, 0, 'a dry-run never appends');
  assert.equal(state.updates.length, 0, 'a dry-run never seals');
});

test('APPROVED closeout: Log rows append verbatim AND the ledger seals under the SAME write_id', async () => {
  reset();
  const { response, body } = await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-live-1' }));
  assert.equal(response.status, 200);
  const d = body.data;
  assert.equal(d.sheet_write, 'success');
  assert.equal(d.log_rows_written, 3);
  // Visible-actual-to-Log_Cleaned parity: what was appended IS what the preview
  // promised (same formatter, same rows — byte-identical arrays).
  const appended = state.appends.find(a => a.tab === 'Log_Cleaned');
  assert.ok(appended);
  assert.equal(appended.rows.length, 3);
  assert.ok(appended.rows.every(r => String(r[2]) === 'Weighted Dip' && String(r[7]) === '60'), 'actuals keep the performed 60');
  // The seal: all five ledger rows stamped with the SAME approved write_id.
  assert.ok(d.ledger_seal);
  assert.equal(d.ledger_seal.sealed_ok, true);
  assert.equal(d.ledger_seal.sealed, 5);
  assert.equal(d.closeout_fully_verified, true);
  assert.equal(state.updates.length, 1);
  assert.ok(state.updates[0].cells.every(c => c.value === 'w-co-live-1'));
  assert.ok(state.planSetRows.every(r => r[SEAL_IDX] === 'w-co-live-1'), 'every ledger row now carries the closeout_write_id');
  // The ledger CONTENT is untouched — the seal is a bind, never a rewrite.
  assert.equal(state.planSetRows[0][sessionPlanSetsColumns.indexOf('target_weight')], '65', 'v1 target still 65 — the performed 60 never rewrote the plan');
});

test('same-write_id retry replays idempotently: no second append, no second seal, original response echoed', async () => {
  reset();
  await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-live-2' }));
  const appendsAfterFirst = state.appends.length;
  const updatesAfterFirst = state.updates.length;
  const { response, body } = await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-live-2' }));
  assert.equal(response.status, 200);
  assert.equal(body.data.duplicate_write, true);
  assert.equal(body.data.sheet_write, 'skipped_duplicate');
  assert.equal(body.data.original_sheet_write, 'success');
  assert.equal(body.data.ledger_seal.sealed_ok, true, 'the replay echoes the original verified seal');
  assert.equal(state.appends.length, appendsAfterFirst, 'nothing re-appended');
  assert.equal(state.updates.length, updatesAfterFirst, 'nothing re-sealed');
});

test('seal failure after committed appends: honest partial — closeout_fully_verified false, write still reported truthfully', async () => {
  reset();
  state.updateCellsResult = { totalUpdatedCells: 2 }; // server claims 2 of 5 → proof mismatch
  const { response, body } = await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-live-3' }));
  assert.equal(response.status, 200);
  const d = body.data;
  assert.equal(d.sheet_write, 'success', 'the committed Log append is still reported');
  assert.equal(d.log_rows_written, 3);
  assert.equal(d.ledger_seal.sealed_ok, false);
  assert.equal(d.ledger_seal.reason, 'seal_proof_mismatch');
  assert.equal(d.closeout_fully_verified, false, 'a ledger failure NEVER claims a fully verified closeout');
});

test('a fresh-write_id retry HEALS an unsealed closeout through the all-duplicate lane — zero re-appends', async () => {
  reset();
  state.updateCellsResult = { totalUpdatedCells: 2 };
  await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-live-4' }));
  // The mismatch path stamped cells in the fake regardless of the claimed count —
  // reset the stamps so the heal genuinely has blank cells to stamp.
  for (const r of state.planSetRows) r[SEAL_IDX] = '';
  state.updateCellsResult = null;
  // The rows are on the sheet now; the retry sees them as duplicates.
  state.logCompositeKeys = DIP_ACTUALS.map(a => `${SESSION_ID.toLowerCase()}||weighted dip||${a.set_number}`);
  const appendsBefore = state.appends.length;
  const { response, body } = await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-live-4-retry' }));
  assert.equal(response.status, 200);
  const d = body.data;
  assert.equal(d.all_rows_duplicate, true, 'nothing new to append');
  assert.equal(d.ledger_seal.sealed_ok, true, 'the retry sealed the ledger');
  assert.equal(d.ledger_seal.sealed, 5);
  assert.equal(d.closeout_fully_verified, true);
  assert.equal(state.appends.length, appendsBefore, 'the heal appended NOTHING');
  assert.ok(state.planSetRows.every(r => r[SEAL_IDX] === 'w-co-live-4-retry'));
});

test('partial append failure (Effort fails after Log): fail-closed 500, no seal attempted; the ledger stays unbound for the heal', async () => {
  reset();
  state.failEffortAppend = true;
  const { response, body } = await post('/api/log-workout', closeoutPayload({
    write_id: 'w-co-live-5',
    effort_row: {
      date: '2026-07-18', session_id: SESSION_ID, duration: '00:40:00',
      active_calories: 400, total_calories: 500, average_hr: 140, peak_hr: 165, location: 'Work'
    }
  }));
  assert.equal(response.status, 500);
  assert.equal(body.details.sheet_write, 'partial');
  assert.equal(body.details.log_rows_written, 3, 'the Log append had already committed');
  assert.equal(state.updates.length, 0, 'no seal on a failed closeout — nothing claims verification');
  assert.ok(state.planSetRows.every(r => r[SEAL_IDX] === ''), 'the ledger stays unbound until a successful closeout');
});

test('malformed ledger chain: the summary flags it and the live seal fails closed — never a partial stamp', async () => {
  reset();
  state.planSetRows.push(state.planSetRows[0].slice()); // duplicate (item,set,version)
  const dry = await post('/api/log-workout', closeoutPayload({ test_mode: true }));
  assert.equal(dry.body.data.closeout_summary.malformed, true, 'the confirmation SHOWS the malformed history');
  const live = await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-live-6' }));
  assert.equal(live.response.status, 200);
  assert.equal(live.body.data.sheet_write, 'success', 'the actuals still saved');
  assert.equal(live.body.data.ledger_seal.sealed_ok, false);
  assert.equal(live.body.data.ledger_seal.reason, 'malformed_chain');
  assert.ok(live.body.data.ledger_seal.diagnostics, 'diagnostics identify the offending chain');
  assert.equal(live.body.data.closeout_fully_verified, false);
  assert.equal(state.updates.length, 0, 'nothing stamped');
});

// ── Codex P1 pair (PR #1068): verification never lies about the ledger ───────────

test('P1-A: a ledger READ OUTAGE during the approved closeout fails closed — never a verified closeout', async () => {
  reset();
  state.failTabsProbe = true;
  const { response, body } = await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-p1a' }));
  assert.equal(response.status, 200);
  const d = body.data;
  assert.equal(d.sheet_write, 'success', 'the committed Log append is still reported truthfully');
  assert.equal(d.ledger_seal.sealed_ok, false);
  assert.equal(d.ledger_seal.reason, 'ledger_read_failed');
  assert.equal(d.ledger_seal.no_ledger, undefined, 'an outage is NOT "no ledger"');
  assert.equal(d.closeout_fully_verified, false);
  assert.equal(state.updates.length, 0, 'nothing stamped blind');
});

test('P1-B: a PLANNED closeout with zero ledger rows is NOT fully verified (a lost checkpoint never masquerades)', async () => {
  reset();
  state.planSetRows = []; // the tab exists, but this session checkpointed nothing
  const { response, body } = await post('/api/log-workout', closeoutPayload({ write_id: 'w-co-p1b' }));
  assert.equal(response.status, 200);
  const d = body.data;
  assert.equal(d.sheet_write, 'success');
  assert.equal(d.ledger_seal.no_ledger, true);
  assert.equal(d.ledger_seal.sealed_ok, true, 'the empty seal itself is honest');
  assert.equal(d.closeout_fully_verified, false, 'planned items + no ledger rows = NOT verified');
});

test('P1-B guard: a FREESTYLE closeout (no planned items) with no ledger rows stays fully verified', async () => {
  reset();
  state.planSetRows = [];
  const { response, body } = await post('/api/log-workout', {
    session_id: SESSION_ID, date: '2026-07-18', write_id: 'w-co-p1b2',
    log_rows: DIP_ACTUALS, closeout_context: { items: [] }
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.ledger_seal.no_ledger, true);
  assert.equal(body.data.closeout_fully_verified, true, 'nothing was planned, nothing is missing');
});
