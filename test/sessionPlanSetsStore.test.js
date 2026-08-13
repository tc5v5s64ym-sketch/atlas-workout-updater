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
const {
  installWorkoutAuthorityStub, resetWorkoutAuthorityStub, workoutAuthorityStore,
  failWorkoutAuthorityReads,
} = require('./helpers/stubWorkoutAuthority');

// ── fake sheets (stateful; counts calls so dry-run "never touches the sheet" is provable) ──
const state = { tabs: ['Session_Plan_Sets'], rows: [], appends: [], updates: [], a1: [['idempotency_key']], calls: 0, updateCellsResult: null, failGetTabs: false, failGetRows: false };
function reset({ tabs = ['Session_Plan_Sets'], rows = [], a1 = [['idempotency_key']] } = {}) {
  state.tabs = tabs; state.rows = rows.slice(); state.appends = []; state.updates = []; state.a1 = a1; state.calls = 0; state.updateCellsResult = null; state.failGetTabs = false; state.failGetRows = false;
}
// The fake models the REAL failure shapes. The store no longer probes `spreadsheets.get`
// before reading: a successful rows read proves presence, and only `confirmTabMissing` —
// which needs its own successful tab listing — may conclude absence. So a missing tab
// must surface as Google's unresolved-range rejection, and `failGetTabs` now models the
// listing being unavailable, which must mean "could not confirm", never "absent".
const RANGE_UNRESOLVED = (tab) => new Error(`Unable to parse range: ${tab}!A:Z`);
const fakeSheets = {
  getSpreadsheetTabs: async () => { state.calls += 1; if (state.failGetTabs) throw new Error('metadata outage'); return state.tabs.slice(); },
  getSheetRows: async (tab) => { state.calls += 1; if (state.failGetRows) throw new Error('read outage'); if (!state.tabs.includes(tab)) throw RANGE_UNRESOLVED(tab); return state.rows.slice(); },
  confirmTabMissing: async (error, tab) => {
    if (!/Unable to parse range/i.test(String(error && error.message))) return false;
    if (state.failGetTabs) return false;         // could not look ⇒ never evidence of absence
    return !state.tabs.includes(tab);
  },
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

// The workout authority is Supabase since the S4 cutover, so stubbing sheets.js no
// longer controls the plan-set ledger. sheetsFallback seeds this suite's existing
// fixture into the double, so no test's data changes — only where the store reads it
// from. Re-installed on every reload, because the double resets its rows with it.
installWorkoutAuthorityStub();
const storePath = require.resolve('../services/sessionPlanSetsStore');
function loadStore({ writeEnabled }) {
  // The ledger rows live in the authority double, seeded from this suite's own
  // fixture rather than read through the sheets fake — the store reads no tab now.
  resetWorkoutAuthorityStub({ planSets: state.rows.map((r) => r.slice()) });
  delete require.cache[storePath];
  if (writeEnabled) process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';
  else delete process.env.SESSION_PLAN_SETS_WRITE_ENABLED;
  return require('../services/sessionPlanSetsStore');
}

const IDX = Object.fromEntries(sessionPlanSetsColumns.map((c, i) => [c, i]));
const SESSION = { session_id: 'S1', session_date: '2026-07-16' };
const DIP = [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 3, target_weight: 65, target_reps: 5, target_rir: 2 }];

// ── DRY-RUN by default (the F10A safety guarantee) ──────────────────────────────

test('default: checkpointAcceptedPlan writes Supabase and NEVER touches Sheets', async () => {
  reset();
  const store = loadStore({ writeEnabled: false });
  const r = await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't' });
  assert.equal(r.sheet_written, true);
  assert.equal(r.written, 3);
  assert.equal(state.calls, 0, 'no Sheets call at all');
  assert.equal(workoutAuthorityStore().planSets[0][IDX.recommendation_source], 'accepted');
  assert.equal(workoutAuthorityStore().planSets[0][IDX.set_index], '1');
});

test('retired flag OFF cannot disable a revision checkpoint', async () => {
  reset();
  const store = loadStore({ writeEnabled: false });
  const L = require('../services/sessionPlanLedger');
  const supersedes_key = L.idempotencyKey({ session_id: 'S1', plan_version: 1, plan_item_id: 'pi_dip', set_index: 2 });
  const r = await store.checkpointRevision(SESSION, {
    plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', set_index: 2, plan_version: 2, target_set_count: 3,
    target_weight: 60, target_reps: 5, target_rir: 2, recommendation_source: 'live_revision', supersedes_key,
  }, { recordedAt: 't' });
  assert.equal(r.sheet_written, true);
  assert.equal(r.written, 1);
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
  assert.equal(state.appends.length, 0, 'the ledger is Supabase — no Google Sheets append');
  // NO RANGE, and that is the honest value. The authoritative proof used to be the
  // A1 `updatedRange` the Sheets append returned; the rows land in Supabase now, so
  // there is no range to report and reporting one would be a false proof field. The
  // row count is what carries the proof.
  assert.equal(r.range, null, 'a range is a Sheets concept and there is no Sheets write');
  assert.equal(r.rows_written, 3);
  assert.equal(workoutAuthorityStore().planSets.length, 3);
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

// `tab_missing` retired with the tab: a Sheets tab can genuinely be absent and a
// migrated table cannot, so the field is reported permanently false. The guarantee
// that outlived it is the one below — an unreadable authority fails closed rather
// than appending against an index it could not read, which would defeat the
// idempotency guard entirely.
test('live: an unreadable ledger fails closed and writes nothing', async () => {
  reset();
  const store = loadStore({ writeEnabled: true });
  failWorkoutAuthorityReads('Supabase unreachable');
  const r = await store.checkpointAcceptedPlan(SESSION, DIP, { recordedAt: 't' });
  assert.equal(r.reason, 'ledger_read_failed');
  assert.equal(r.tab_missing, false, 'an outage is never a durable schema fact');
  assert.equal(r.sheet_written, false);
  assert.equal(r.no_write_confirmed, true);
  assert.equal(workoutAuthorityStore().planSets.length, 0);
});

test('live: a same-key row with DIFFERENT content fails closed (append-only, never mutate)', async () => {
  reset();
  const store = loadStore({ writeEnabled: true });
  const L = require('../services/sessionPlanLedger');
  // Seed a v1 set-1 row, then attempt a DIFFERENT-content row with the same identity key.
  const [seed] = L.buildAcceptedRows(SESSION, [{ plan_item_id: 'pi_dip', planned_lift_code: 'DIP01', target_set_count: 1, target_weight: 65, target_reps: 5, target_rir: 2 }]);
  // Into the authority, which is where the store reads its prior rows from.
  workoutAuthorityStore().planSets.push(seed);
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

test('the retired flag cannot disable the authoritative closeout seal', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  const store = loadStore({ writeEnabled: false });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sheet_written, true);
  assert.equal(r.sealed_ok, true);
  assert.equal(r.sealed, 3, 'all three unstamped S1 rows');
  assert.equal(r.already_sealed, 0);
  assert.equal(state.appends.length, 0, 'no append');
  assert.equal((state.updates || []).length, 0, 'the seal never writes a Sheets cell');
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
  assert.equal(r.sealed_ok, true, 'the stamped count matches the intended count');
  assert.equal(state.appends.length, 0, 'a seal never appends');
  assert.equal((state.updates || []).length, 0, 'and it never writes a Sheets cell');
  // THE SEAL IS A PREDICATE NOW, NOT A SET OF ROW POSITIONS. It used to compute each
  // row's sheet position from a fresh read and stamp those cells by column letter —
  // the one place production wrote by POSITION. What is asserted is the same fact it
  // always was, read off the rows instead of off the request: this session's rows
  // carry the seal, their content is untouched, and no other session's rows moved.
  const rows = workoutAuthorityStore().planSets;
  const s1 = rows.filter((row) => row[IDX.session_id] === 'S1');
  const s2 = rows.filter((row) => row[IDX.session_id] === 'S2');
  assert.equal(s1.length, 3);
  for (const row of s1) {
    assert.equal(row[IDX.closeout_write_id], 'w-close-1');
    assert.equal(row[IDX.target_weight], '65', 'content column untouched by the seal');
  }
  for (const row of s2) assert.equal(row[IDX.closeout_write_id], '', 'S2 rows untouched');
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

test('F10D seal: a stamped-count mismatch fails closed (never a false verified seal)', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  const store = loadStore({ writeEnabled: true });
  // The authority reports one stamped row where the seal decided on three. The proof
  // is unchanged in KIND — the seal claims success only when those two agree — and
  // only the unit moved, from updated cells to stamped rows.
  workoutAuthorityStore().sealCountOverride = 1;
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed_ok, false);
  assert.equal(r.reason, 'seal_proof_mismatch');
  workoutAuthorityStore().sealCountOverride = null;
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
  // All three carry the seal afterwards; two of them were stamped by this call.
  const sealed = workoutAuthorityStore().planSets.filter((row) => row[IDX.closeout_write_id] === 'w-close-1');
  assert.equal(sealed.length, 3);
});

// ── Codex P1 (PR #1068): an UNREADABLE ledger is never a verified (empty) seal ──
// A confirmed-absent tab is a legacy no-op; a READ FAILURE (metadata probe or row
// read) is a ledger failure and must fail closed — closeout_fully_verified hangs
// off sealed_ok, so a transient Sheets outage must never claim verification.

// The tab-absence half of this contract retired with the tab: a migrated table cannot
// be absent at runtime, so there is nothing left to CONFIRM. The half that carried the
// trust guarantee is unchanged and is what these three hold — an unreadable ledger is
// never a verified empty one, because `closeout_fully_verified` hangs off `sealed_ok`.
test('F10D seal: an unreadable ledger fails CLOSED, never a verified no_ledger', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  const store = loadStore({ writeEnabled: true });
  failWorkoutAuthorityReads('Supabase unreachable');
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.sealed_ok, false);
  assert.equal(r.reason, 'ledger_read_failed');
  assert.equal(r.no_ledger, undefined, 'an unreadable ledger is NOT "no ledger"');
  assert.equal((state.updates || []).length, 0);
});

test('F10D seal: a session with NO rows is a verified-empty seal, not a failure', async () => {
  reset({ rows: ledgerRowsFor('S9') });   // another session's rows only
  const store = loadStore({ writeEnabled: true });
  const r = await store.sealCloseout(SESSION, 'w-close-1');
  assert.equal(r.no_ledger, true);
  assert.equal(r.sealed, 0);
  assert.equal(r.sealed_ok, true, 'nothing to seal is a verified (empty) seal');
});

test('F10D readLedgerRows: an unreadable ledger returns null (read-failed), not [] (no rows)', async () => {
  reset({ rows: ledgerRowsFor('S1') });
  const store = loadStore({ writeEnabled: false });
  failWorkoutAuthorityReads('Supabase unreachable');
  assert.equal(await store.readLedgerRows('S1'), null,
    'unreadable must be null; [] would claim the session genuinely has no ledger rows');
});

// And the other side of the same contract: a session that genuinely has no rows is
// reported as an empty ledger rather than as a failure.
test('F10D readLedgerRows: a session with no rows returns [] (no ledger), not null', async () => {
  reset({ rows: [] });
  const store = loadStore({ writeEnabled: false });
  assert.deepEqual(await store.readLedgerRows('S1'), []);
});
