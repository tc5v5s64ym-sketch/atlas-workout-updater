'use strict';

// Decision Desk #952 (Option A) — Session_Plans PR-B: idempotent, append-only
// writer. Tests inject a fake sheets module (require.cache) so no real Sheets I/O
// runs. Pins: optional-tab 503/no-op; append-only; retry-idempotency (same event →
// skipped, no duplicate row); the revision-collision guard fails closed; only the
// Session_Plans tab is ever written (never Log_Cleaned/Effort); closeout_status is
// blank on plan_accepted/item_outcome events.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionPlansColumns } = require('../config/columns');

// ── fake sheets (stateful; reset per test) ────────────────────────────────────
const state = { tabs: ['Session_Plans'], rows: [], appends: [], a1: [['idempotency_key']], readError: null, listTabsFails: false };
function reset({ tabs = ['Session_Plans'], rows = [], a1 = [['idempotency_key']], readError = null, listTabsFails = false } = {}) {
  state.tabs = tabs; state.rows = rows.slice(); state.appends = []; state.a1 = a1;
  state.readError = readError; state.listTabsFails = listTabsFails;
}
// The fake models the REAL failure shapes, because the store now proves tab existence
// from the rows read itself rather than from a separate metadata probe. A genuinely
// missing tab makes Google reject the range ("Unable to parse range"), and only
// `confirmTabMissing` — which must successfully list the tabs — may conclude absence.
// A fake that threw a generic Error would let the store's ambiguity handling go untested.
const RANGE_UNRESOLVED = (tab) => new Error(`Unable to parse range: ${tab}!A:Z`);
const fakeSheets = {
  getSpreadsheetTabs: async () => state.tabs.slice(),
  getSheetRows: async (tab) => {
    if (state.readError) throw state.readError;
    if (!state.tabs.includes(tab)) throw RANGE_UNRESOLVED(tab);
    return state.rows.slice();
  },
  // The real classifier's contract: absence requires an unresolved range AND a successful
  // tab listing that does not contain the tab.
  confirmTabMissing: async (error, tab) => {
    if (!/Unable to parse range/i.test(String(error && error.message))) return false;
    if (state.listTabsFails) return false;   // could not look ⇒ never evidence of absence
    return !state.tabs.includes(tab);
  },
  appendRows: async (tab, rows) => { state.appends.push({ tab, rows }); if (tab === 'Session_Plans') state.rows.push(...rows); },
  readRange: async () => state.a1,
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const store = require('../services/sessionPlanStore');
const IDX = Object.fromEntries(sessionPlansColumns.map((c, i) => [c, i]));
const SESSION = { session_id: 'S1', session_date: '2026-07-10', plan_version: 'v1' };
const ITEMS = [
  { plan_item_id: 'i1', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' },
  { plan_item_id: 'i2', planned_order: 2, planned_lift_code: 'SQ01', movement_pattern: 'squat' },
];

// ── optional-tab gate ─────────────────────────────────────────────────────────

test('tab missing → 503/no-op: nothing is written, tab_missing reported', async () => {
  reset({ tabs: [] });
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't' });
  assert.equal(r.tab_missing, true);
  assert.equal(r.written, 0);
  assert.equal(state.appends.length, 0);
});

// An OUTAGE is not absence. `tab_missing` is a VERIFIED_EMPTY_SEAL_REASON, so a transient
// read failure — or an unresolved range that could not be confirmed because the tab listing
// itself failed — must never present as a missing tab.
test('a transient read failure is NOT reported as a missing tab', async () => {
  reset({ readError: Object.assign(new Error('Backend Error'), { status: 503 }) });
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't' });
  assert.equal(r.tab_missing, false, 'an outage must never read as a durable schema fact');
  assert.equal(r.written, 2, 'the append still proceeds under its own idempotency guard');
});

test('an unresolved range that cannot be CONFIRMED absent is not reported as missing', async () => {
  reset({ tabs: [], listTabsFails: true });
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't' });
  assert.equal(r.tab_missing, false, 'could not look ⇒ never evidence of absence');
});

// ── append + idempotency ──────────────────────────────────────────────────────

test('writePlanAccepted appends one row per item; only the Session_Plans tab is written', async () => {
  reset();
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't' });
  assert.equal(r.written, 2);
  assert.equal(state.rows.length, 2);
  assert.ok(state.appends.every(a => a.tab === 'Session_Plans'), 'never writes another tab');
  assert.equal(state.rows[0][IDX.event_type], 'plan_accepted');
  assert.equal(state.rows[0][IDX.outcome], 'planned');
  assert.equal(state.rows[0][IDX.closeout_status], '', 'closeout_status blank on plan_accepted');
});

test('retry is idempotent: re-writing the same events appends nothing new', async () => {
  reset();
  await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't1' });
  const before = state.rows.length;
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't2-different-timestamp' });
  assert.equal(r.written, 0, 'no new rows on retry');
  assert.equal(r.skipped, 2);
  assert.equal(state.rows.length, before, 'append-only store is unchanged by a retry');
});

test('a duplicate event within a single batch is collapsed', async () => {
  reset();
  const dup = [ITEMS[0], ITEMS[0]];
  const r = await store.writePlanAccepted(SESSION, dup, { recordedAt: 't' });
  assert.equal(r.written, 1);
  assert.equal(r.skipped, 1);
});

// ── revision-collision guard (fail closed) ────────────────────────────────────

test('revision collision fails closed: same (session,version,item) with a changed lift throws', async () => {
  reset();
  await store.writePlanAccepted(SESSION, [ITEMS[0]], { recordedAt: 't' }); // i1 = BEN01
  // Same plan_item_id + plan_version but a DIFFERENT planned lift → same idempotency
  // key (key omits planned_lift_code) but different content → must throw, not silently
  // dedup (which would drop the revision). The fix is to bump plan_version.
  await assert.rejects(
    store.writePlanAccepted(SESSION, [{ ...ITEMS[0], planned_lift_code: 'INC01' }], { recordedAt: 't' }),
    /revision collision/i
  );
  // Bumping plan_version resolves it (new key → new append).
  const r = await store.writePlanAccepted({ ...SESSION, plan_version: 'v2' }, [{ ...ITEMS[0], planned_lift_code: 'INC01' }], { recordedAt: 't' });
  assert.equal(r.written, 1);
});

// ── item_outcome + closeout ───────────────────────────────────────────────────

test('writeItemOutcome appends an item_outcome; substituted carries the performed code', async () => {
  reset();
  const r = await store.writeItemOutcome(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'substituted', performed_lift_code: 'DBP01' }, { recordedAt: 't' });
  assert.equal(r.written, 1);
  assert.equal(state.rows[0][IDX.event_type], 'item_outcome');
  assert.equal(state.rows[0][IDX.outcome], 'substituted');
  assert.equal(state.rows[0][IDX.performed_lift_code], 'DBP01');
  assert.equal(state.rows[0][IDX.closeout_status], '', 'closeout_status blank on item_outcome');
});

test('writeSessionCloseout appends a session_closeout with finalized|abandoned only', async () => {
  reset();
  const r = await store.writeSessionCloseout(SESSION, 'finalized', { recordedAt: 't' });
  assert.equal(r.written, 1);
  assert.equal(state.rows[0][IDX.event_type], 'session_closeout');
  assert.equal(state.rows[0][IDX.closeout_status], 'finalized');
  assert.equal(state.rows[0][IDX.plan_item_id], '', 'session-scoped: no item id');
  await assert.rejects(store.writeSessionCloseout(SESSION, 'done', { recordedAt: 't' }), /finalized\|abandoned/);
});

// ── header + read-failure safety ──────────────────────────────────────────────

test('an empty tab gets its header row before the first data append', async () => {
  reset({ a1: [] }); // no header present
  await store.writePlanAccepted(SESSION, [ITEMS[0]], { recordedAt: 't' });
  assert.deepEqual(state.appends[0].rows[0], [...sessionPlansColumns], 'header written first');
});
