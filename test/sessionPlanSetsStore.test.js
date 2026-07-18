'use strict';

// F10A — Session_Plan_Sets creation-time checkpoint store (dry-run).
// Tests inject a fake sheets module (require.cache) so no real Sheets I/O runs. Pins:
//   - DRY-RUN by default (SESSION_PLAN_SETS_WRITE_ENABLED off): every checkpoint
//     returns the W1–W3 proof (sheet_written:false, no_write_confirmed:true) and
//     NEVER touches the sheet — the F10A safety guarantee (no first real write).
//   - the built rows match the ledger contract.
//   - the LIVE path (owner-enabled at F10D) appends idempotently, 503/no-ops on a
//     missing tab, and fails closed on a revision collision — proven now so F10D only
//     flips the flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionPlanSetsColumns } = require('../config/columns');

// ── fake sheets (stateful; counts calls so dry-run "never touches the sheet" is provable) ──
const state = { tabs: ['Session_Plan_Sets'], rows: [], appends: [], updates: [], a1: [['idempotency_key']], calls: 0, updateCellsResult: null, failGetTabs: false, failGetRows: false };
function reset({ tabs = ['Session_Plan_Sets'], rows = [], a1 = [['idempotency_key']] } = {}) {
  state.tabs = tabs; state.rows = rows.slice(); state.appends = []; state.updates = []; state.a1 = a1; state.calls = 0; state.updateCellsResult = null; state.failGetTabs = false; state.failGetRows = false;
}
const fakeSheets = {
  getSpreadsheetTabs: async () => { state.calls += 1; if (state.failGetTabs) throw new Error('metadata outage'); return state.tabs.slice(); },
  getSheetRows: async (tab) => { state.calls += 1; if (state.failGetRows) throw new Error('read outage'); if (!state.tabs.includes(tab)) throw new Error('tab missing'); return state.rows.slice(); },
  // Mirror the REAL sheets.appendRows return shape: the raw Google API response
  // object, whose authoritative write-proof is data.updates.{updatedRange,updatedRows}.
  appendRows: async (tab, rows) => {
    state.calls += 1; state.appends.push({ tab, rows });
    let updatedRange = null;
    if (state.tabs.includes(tab)) {
      const start = state.rows.length + 2; // +1 header, +1 to 1-based
      state.rows.push(...rows);
      updatedRange = `${tab}!A${start}:P${start + rows.length - 1}`;
    }
    return { data: { updates: { updatedRange, updatedRows: rows.length } } };
  },
  readRange: async () => { state.calls += 1; return state.a1; },
  // Mirror the REAL sheets.updateColumnCells (F10D): a bounded batch update of ONE
  // column's cells — cells: [{row, value}], row = 1-based SHEET row (header = 1).
  // Applies to the in-memory rows (data row = sheet row - 2) and returns the raw
  // API-shaped proof { data: { totalUpdatedCells } }.
  updateColumnCells: async (tab, column, cells) => {
    state.calls += 1; state.updates.push({ tab, column, cells });
    if (state.tabs.includes(tab)) {
      const colIdx = column.charCodeAt(0) - 65;
      for (const c of cells) {
        const dataIdx = c.row - 2;
        if (state.rows[dataIdx]) state.rows[dataIdx][colIdx] = c.value;
      }
    }
    const total = state.updateCellsResult ? state.updateCellsResult.totalUpdatedCells : cells.length;
    return { data: { totalUpdatedCells: total } };
  },
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const storePath = require.resolve('../services/sessionPlanSetsStore');
function loadStore({ writeEnabled }) {
  delete require.cache[storePath];
  if (writeEnabled) process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';
  else delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
  return require('../services/sessionPlanSetsStore');
}

const IDX = Object.fromEntries(sessionPlanSetsColumns.map((c, i) => [c, i]));
const SESSION = { session_id: 'S1', session_date: '2026-07-16' };
const DIP = [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 }];

// ── DRY-RUN by default (the F10A safety guarantee) ──────────────────────────────

test('dry-run default: checkpointAcceptedPlan returns the no-write proof and NEVER touches the sheet', async () => {
  reset();
  const store = loadStore({ writeEnabled: false });
  const r = await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't' });
  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.reason, 'write_disabled');
  assert.equal(r.would_write, 3, 'the three dip set-rows it WOULD write');
  assert.equal(state.calls, 0, 'no Sheets call at all in dry-run — no first real write');
  assert.equal(r.rows[0][IDX.recommendation_source], 'accepted');
  assert.equal(r.rows[0][IDX.set_index], '1');
});

test('dry-run default: checkpointRevision returns the no-write proof, sheet untouched', async () => {
  reset();
  const store = loadStore({ writeEnabled: false });
  const L = require('../services/sessionPlanLedger');
  const supersedes_key = L.idempotencyKey({ session_id: 'S1', plan_version: 1, plan_item_id: 'pi_dip', set_index: 2 });
  const r = await store.checkpointRevision(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2, target_set_count: 3,
    target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision', supersedes_key,
  }, { recordedAt: 't' });
  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(r.would_write, 1);
  assert.equal(state.calls, 0);
});

test('explicit test_mode is a dry-run even when live writes are enabled', async () => {
  reset();
  const store = loadStore({ writeEnabled: true });
  const r = await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't', test_mode: true });
  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(r.reason, 'test_mode');
  assert.equal(state.calls, 0, 'test_mode never writes');
});

// ── LIVE path (owner-enabled at F10D) — proven now so F10D only flips the flag ───

test('live: enabling the owner gate appends the checkpoint rows (only Session_Plan_Sets)', async () => {
  reset();
  const store = loadStore({ writeEnabled: true });
  const r = await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't' });
  assert.equal(r.sheet_written, true);
  assert.equal(r.no_write_confirmed, false);
  assert.equal(r.written, 3);
  assert.ok(state.appends.every(a => a.tab === 'Session_Plan_Sets'), 'never writes another tab');
  // The authoritative write proof is the A1 updatedRange, not the raw response object.
  assert.match(r.range, /^Session_Plan_Sets!A\d+:P\d+$/, 'range is the extracted A1 updatedRange');
  assert.equal(r.rows_written, 3);
});

test('live: retry is idempotent — same rows append nothing new', async () => {
  reset();
  const store = loadStore({ writeEnabled: true });
  await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't1' });
  const before = state.rows.length;
  const r = await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't2-different' });
  assert.equal(r.written, 0);
  assert.equal(r.skipped, 3);
  assert.equal(state.rows.length, before, 'append-only store unchanged by a retry');
});

test('live: a missing tab 503/no-ops (owner creates the tab; never auto-created)', async () => {
  reset({ tabs: [] });
  const store = loadStore({ writeEnabled: true });
  const r = await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't' });
  assert.equal(r.tab_missing, true);
  assert.equal(r.sheet_written, false);
  assert.equal(state.appends.length, 0);
});

test('live: a same-key row with DIFFERENT content fails closed (append-only, never mutate)', async () => {
  reset();
  const store = loadStore({ writeEnabled: true });
  const L = require('../services/sessionPlanLedger');
  // Seed a v1 set-1 row, then attempt a DIFFERENT-content row with the same identity key.
  const [seed] = L.buildAcceptedRows(SESSION, [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 1, target_weight: 65, target_reps: 5, target_rir: 2 }]);
  state.rows.push(seed);
  const clash = L.toRow({
    session_id: 'S1', session_date: '2026-07-16', plan_version: 1, plan_item_id: 'pi_dip', planned_lift_code: 'DIP01',
    set_index: 1, target_set_count: 1, target_weight: 999, target_reps: 5, target_rir: 2,
    recommendation_source: 'accepted', supersedes_key: '', confidence: 'reliable', closeout_write_id: '', recorded_at: 't',
  });
  await assert.rejects(() => store.checkpointAcceptedPlan(SESSION, [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 1, target_weight: 999, target_reps: 5, target_rir: 2 }], { recordedAt: 't' }), /revision collision/);
  assert.ok(clash); // (documents the identical-key/different-content shape the guard rejects)
});

// ── F10D — closeout SEAL (stamps closeout_write_id on existing rows; dry-run until
// owner-enabled). The seal is NOT the ledger's first persistence (design amendment
// A2): rows were checkpointed at creation; closeout binds them to the approved
// write via the SHARED closeout_write_id. Append-only discipline holds — the seal
// touches EXACTLY the one blank closeout_write_id cell per row, never row content.
// ─────────────────────────────────────────────────────────────────────────────────

function ledgerRowsFor(sessionId, { withSeal = '', items = null } = {}) {
  const L = require('../services/sessionPlanLedger');
  const rows = L.buildAcceptedRows(
    { session_id: sessionId, session_date: '2026-07-18' },
    items || [{ plan_item_id: `pi_${sessionId}`, planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 }],
    { recordedAt: 't' }
  );
  if (withSeal) for (const r of rows) r[IDX.closeout_write_id] = withSeal;
  return rows;
}

test('F10D seal dry-run default: reports what it WOULD seal, writes nothing, W1–W3 proof', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  const store = loadStore({ writeEnabled: false });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.reason, 'write_disabled');
  assert.equal(r.would_seal, 3, 'all three unstamped S1 rows');
  assert.equal(r.already_sealed, 0);
  assert.equal(state.appends.length, 0, 'no append');
  assert.equal((state.updates || []).length, 0, 'no cell update — dry-run never writes');
});

test('F10D seal dry-run: explicit test_mode short-circuits even with the flag on', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1', { test_mode: true });
  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(r.reason, 'test_mode');
  assert.equal((state.updates || []).length, 0);
});

test('F10D seal live: stamps ONLY this session\'s unstamped rows, exact cell proof, other sessions untouched', async () => {
  const mine = ledgerRowsFor('S1');
  const other = ledgerRowsFor('S2');
  reset({ rows: [...other, ...mine] });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sheet_written, true);
  assert.equal(r.sealed, 3);
  assert.equal(r.already_sealed, 0);
  assert.equal(r.sealed_ok, true, 'updated-cell proof matches the intended count');
  assert.equal(state.appends.length, 0, 'a seal never appends');
  const upd = state.updates || [];
  assert.equal(upd.length, 1, 'one bounded column update call');
  assert.equal(upd[0].column, 'O', 'closeout_write_id is column O (15th of 16)');
  // other-session rows occupy data rows 0..2 → sheet rows 2..4; mine are 5..7.
  assert.deepEqual(upd[0].cells.map(c => c.row).sort((a, b) => a - b), [5, 6, 7]);
  assert.ok(upd[0].cells.every(c => c.value === 'w-close-1'));
  // The in-memory sheet reflects the stamp; row CONTENT is untouched.
  for (const row of state.rows.slice(3)) {
    assert.equal(row[IDX.closeout_write_id], 'w-close-1');
    assert.equal(row[IDX.target_weight], '65', 'content column untouched by the seal');
  }
  for (const row of state.rows.slice(0, 3)) assert.equal(row[IDX.closeout_write_id], '', 'S2 rows untouched');
});

test('F10D seal live retry (same closeout_write_id): idempotent — nothing re-stamped, ok result', async () => {
  reset({ rows: ledgerRowsFor('S1', { withSeal: 'w-close-1' }) });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sheet_written, false, 'no cells needed stamping');
  assert.equal(r.sealed, 0);
  assert.equal(r.already_sealed, 3);
  assert.equal(r.sealed_ok, true, 'an idempotent replay is a VERIFIED seal');
  assert.equal((state.updates || []).length, 0);
});

test('F10D seal: a DIFFERENT existing closeout_write_id fails closed — never re-seal', async () => {
  reset({ rows: ledgerRowsFor('S1', { withSeal: 'w-OTHER' }) });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed_ok, false);
  assert.equal(r.reason, 'conflicting_seal');
  assert.equal(r.sheet_written, false);
  assert.equal((state.updates || []).length, 0, 'fail closed — no update');
});

test('F10D seal: a malformed revision chain fails closed with diagnostics — no partial seal', async () => {
  const rows = ledgerRowsFor('S1');
  rows.push(rows[0].slice()); // duplicate (item, set, version) row → duplicate_version
  reset({ rows });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed_ok, false);
  assert.equal(r.reason, 'malformed_chain');
  assert.ok(r.diagnostics, 'diagnostics identify the offending chain');
  assert.equal((state.updates || []).length, 0, 'no cell was stamped');
});

test('F10D seal: an updated-cell-count mismatch fails closed (never a false verified seal)', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  state.updateCellsResult = { totalUpdatedCells: 1 }; // server claims 1, we intended 3
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed_ok, false);
  assert.equal(r.reason, 'seal_proof_mismatch');
  state.updateCellsResult = null;
});

test('F10D seal: live with the tab missing → no_ledger no-op (legacy session, not an error)', async () => {
  reset({ tabs: [], rows: [] });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.no_ledger, true);
  assert.equal(r.sealed, 0);
  assert.equal(r.sealed_ok, true, 'nothing to seal is a verified (empty) seal');
  assert.equal((state.updates || []).length, 0);
});

test('F10D seal: a session with NO ledger rows (tab exists) → no_ledger, verified-empty', async () => {
  reset({ rows: ledgerRowsFor('S9') });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.no_ledger, true);
  assert.equal(r.sealed, 0);
  assert.equal(r.sealed_ok, true);
});

test('F10D seal: mixed already-sealed + blank rows stamps only the blanks', async () => {
  const rows = ledgerRowsFor('S1');
  rows[0][IDX.closeout_write_id] = 'w-close-1'; // set 1 already sealed by the same closeout
  reset({ rows });
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed, 2);
  assert.equal(r.already_sealed, 1);
  assert.equal(r.sealed_ok, true);
  const upd = state.updates || [];
  assert.deepEqual(upd[0].cells.map(c => c.row).sort((a, b) => a - b), [3, 4], 'rows 2 and 3 of the tab data (sheet rows 3,4)');
});

// ── Codex P1 (PR #1068): an UNREADABLE ledger is never a verified (empty) seal ──
// A confirmed-absent tab is a legacy no-op; a READ FAILURE (metadata probe or row
// read) is a ledger failure and must fail closed — closeout_fully_verified hangs
// off sealed_ok, so a transient Sheets outage must never claim verification.

test('F10D seal: a metadata-probe failure fails CLOSED (ledger_read_failed), never a verified no_ledger', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  state.failGetTabs = true;
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed_ok, false);
  assert.equal(r.reason, 'ledger_read_failed');
  assert.equal(r.no_ledger, undefined, 'an outage is NOT "no ledger"');
  assert.equal((state.updates || []).length, 0);
});

test('F10D seal: a row-read failure (tab present) fails CLOSED, never a verified no_ledger', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  state.failGetRows = true;
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed_ok, false);
  assert.equal(r.reason, 'ledger_read_failed');
  assert.equal((state.updates || []).length, 0);
});

test('F10D readLedgerRows: a metadata-probe failure returns null (read-failed), not [] (no rows)', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  state.failGetTabs = true;
  const store = loadStore({ writeEnabled: false });
  assert.equal(await store.readLedgerRows('S1'), null);
});
