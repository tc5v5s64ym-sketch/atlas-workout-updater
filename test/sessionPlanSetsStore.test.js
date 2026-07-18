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
const state = { tabs: ['Session_Plan_Sets'], rows: [], appends: [], a1: [['idempotency_key']], calls: 0 };
function reset({ tabs = ['Session_Plan_Sets'], rows = [], a1 = [['idempotency_key']] } = {}) {
  state.tabs = tabs; state.rows = rows.slice(); state.appends = []; state.a1 = a1; state.calls = 0;
}
const fakeSheets = {
  getSpreadsheetTabs: async () => { state.calls += 1; return state.tabs.slice(); },
  getSheetRows: async (tab) => { state.calls += 1; if (!state.tabs.includes(tab)) throw new Error('tab missing'); return state.rows.slice(); },
  appendRows: async (tab, rows) => { state.calls += 1; state.appends.push({ tab, rows }); if (state.tabs.includes(tab)) state.rows.push(...rows); return `${tab}!A1`; },
  readRange: async () => { state.calls += 1; return state.a1; },
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
