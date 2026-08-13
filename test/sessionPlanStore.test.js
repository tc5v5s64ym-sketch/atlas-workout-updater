'use strict';

// Decision Desk #952 (Option A) — the plan-event writer: idempotent and
// append-only. Pins: append-only; retry-idempotency (same event → skipped, no
// duplicate row); the revision-collision guard fails closed; closeout_status is
// blank on plan_accepted/item_outcome events.
//
// ── WHAT THE S4 CUTOVER CHANGED HERE, AND WHAT IT DID NOT ────────────────────
//
// The destination moved from the `Session_Plans` tab to `atlas.session_plan_events`,
// so this suite drives the store against the Supabase authority double rather than a
// fake `sheets.js`. Every behavioural pin above is UNCHANGED and still asserted.
//
// THREE PINS WENT WITH THE TAB, and each is gone because the condition it described
// cannot occur, not because it stopped mattering:
//
//   • `tab_missing` — a Google Sheets tab can genuinely be absent, and proving
//     absence needed its own metadata read. A table the migration created cannot be
//     absent at runtime. The field is still reported, permanently `false`, because
//     `services/turnWriteArtifact.js` branches on it.
//   • "an outage is not absence" — the same question. What survives, and is asserted
//     below, is the half that still has teeth: an unreadable authority FAILS rather
//     than silently appending against an empty index.
//   • the header row — a tab needed one seeded before its first data row so a later
//     read did not swallow it. A table has columns.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionPlansColumns } = require('../config/columns');

const {
  installWorkoutAuthorityStub,
  resetWorkoutAuthorityStub,
  workoutAuthorityStore,
  failWorkoutAuthorityReads,
} = require('./helpers/stubWorkoutAuthority');

installWorkoutAuthorityStub();
const store = require('../services/sessionPlanStore');

const IDX = Object.fromEntries(sessionPlansColumns.map((c, i) => [c, i]));
const SESSION = { session_id: 'S1', session_date: '2026-07-10', plan_version: 'v1' };
const ITEMS = [
  { plan_item_id: 'i1', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' },
  { plan_item_id: 'i2', planned_order: 2, planned_lift_code: 'SQ01', movement_pattern: 'squat' },
];

function reset() {
  resetWorkoutAuthorityStub();
  return workoutAuthorityStore();
}

// ── the authority must be readable ────────────────────────────────────────────

test('an unreadable authority FAILS the append rather than writing against an empty index', async () => {
  reset();
  failWorkoutAuthorityReads('Supabase unreachable');
  // Appending anyway would defeat the idempotency guard entirely: with no prior
  // events visible, a retry would look brand new and write the batch a second time.
  await assert.rejects(store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't' }), /unreachable/);
  assert.equal(workoutAuthorityStore().planEvents.length, 0, 'nothing was written');
});

test('tab_missing is reported false permanently — a migrated table cannot be absent', async () => {
  reset();
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't' });
  assert.equal(r.tab_missing, false);
});

// ── append + idempotency ──────────────────────────────────────────────────────

test('writePlanAccepted appends one row per item, and writes only the plan-event ledger', async () => {
  const s = reset();
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't' });
  assert.equal(r.written, 2);
  assert.equal(s.planEvents.length, 2);
  // The Save's own concepts are untouched: this writer never reaches logged sets or
  // the Effort row, exactly as it never reached Log_Cleaned or Effort before.
  assert.equal(s.loggedSets.length, 0);
  assert.equal(s.effort.length, 0);
  assert.equal(s.planEvents[0][IDX.event_type], 'plan_accepted');
  assert.equal(s.planEvents[0][IDX.outcome], 'planned');
  assert.equal(s.planEvents[0][IDX.closeout_status], '', 'closeout_status blank on plan_accepted');
});

test('retry is idempotent: re-writing the same events appends nothing new', async () => {
  const s = reset();
  await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't1' });
  const before = s.planEvents.length;
  const r = await store.writePlanAccepted(SESSION, ITEMS, { recordedAt: 't2-different-timestamp' });
  assert.equal(r.written, 0, 'no new rows on retry');
  assert.equal(r.skipped, 2);
  assert.equal(s.planEvents.length, before, 'append-only store is unchanged by a retry');
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
  const s = reset();
  const r = await store.writeItemOutcome(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'substituted', performed_lift_code: 'DBP01' }, { recordedAt: 't' });
  assert.equal(r.written, 1);
  assert.equal(s.planEvents[0][IDX.event_type], 'item_outcome');
  assert.equal(s.planEvents[0][IDX.outcome], 'substituted');
  assert.equal(s.planEvents[0][IDX.performed_lift_code], 'DBP01');
  assert.equal(s.planEvents[0][IDX.closeout_status], '', 'closeout_status blank on item_outcome');
});

test('writeSessionCloseout appends a session_closeout with finalized|abandoned only', async () => {
  const s = reset();
  const r = await store.writeSessionCloseout(SESSION, 'finalized', { recordedAt: 't' });
  assert.equal(r.written, 1);
  assert.equal(s.planEvents[0][IDX.event_type], 'session_closeout');
  assert.equal(s.planEvents[0][IDX.closeout_status], 'finalized');
  assert.equal(s.planEvents[0][IDX.plan_item_id], '', 'session-scoped: no item id');
  await assert.rejects(store.writeSessionCloseout(SESSION, 'done', { recordedAt: 't' }), /finalized\|abandoned/);
});
