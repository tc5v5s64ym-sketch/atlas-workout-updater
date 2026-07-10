'use strict';

// Decision Desk #952 (Option A) — Session_Plans PR-A: schema contract + pure
// event builders + idempotency. No Sheets I/O, no wiring, no drift detection here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EVENT_TYPES, OUTCOMES, ITEM_OUTCOMES, CLOSEOUT_STATUSES,
  idempotencyKey, toRow,
  buildPlanAcceptedEvents, buildItemOutcomeEvent, buildSessionCloseoutEvent,
} = require('../services/sessionPlanEvents');
const { sessionPlansColumns } = require('../config/columns');
const { optionalSheetTabs } = require('../config/sheetContract');

const SESSION = { session_id: 'S-2026-07-10', session_date: '2026-07-10', plan_version: 'v1' };
const IDX = Object.fromEntries(sessionPlansColumns.map((c, i) => [c, i]));

// ── Contract ──────────────────────────────────────────────────────────────────

test('contract: owner-approved column order (13), exact', () => {
  assert.deepEqual(sessionPlansColumns, [
    'idempotency_key', 'session_id', 'session_date', 'plan_version', 'event_type',
    'plan_item_id', 'planned_order', 'planned_lift_code', 'movement_pattern',
    'outcome', 'performed_lift_code', 'closeout_status', 'recorded_at',
  ]);
});

test('contract: Session_Plans is an OPTIONAL tab (503 until it exists)', () => {
  assert.ok(optionalSheetTabs.includes('Session_Plans'));
});

test('contract: frozen vocabularies', () => {
  assert.deepEqual(EVENT_TYPES, ['plan_accepted', 'item_outcome', 'session_closeout']);
  assert.deepEqual(OUTCOMES, ['planned', 'completed', 'skipped', 'substituted']);
  assert.deepEqual(ITEM_OUTCOMES, ['completed', 'skipped', 'substituted']);
  assert.deepEqual(CLOSEOUT_STATUSES, ['finalized', 'abandoned']);
  for (const frozen of [EVENT_TYPES, OUTCOMES, CLOSEOUT_STATUSES]) {
    assert.throws(() => frozen.push('x'), 'vocabularies must be frozen');
  }
});

test('toRow: orders fields into the contract layout; key at index 0', () => {
  const row = toRow({ event_type: 'session_closeout', session_id: 'S1', plan_version: 'v1', closeout_status: 'finalized' });
  assert.equal(row.length, sessionPlansColumns.length);
  assert.equal(row[IDX.event_type], 'session_closeout');
  assert.equal(row[IDX.closeout_status], 'finalized');
  assert.equal(row[IDX.idempotency_key].length, 16, 'idempotency_key is a 16-hex digest');
  assert.equal(row[IDX.plan_item_id], '', 'unset fields blank, never undefined');
});

// ── plan_accepted ───────────────────────────────────────────────────────────

test('plan_accepted: one row per item in order, outcome=planned', () => {
  const items = [
    { plan_item_id: 'i1', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' },
    { plan_item_id: 'i2', planned_order: 2, planned_lift_code: 'SQ01', movement_pattern: 'squat' },
  ];
  const rows = buildPlanAcceptedEvents(SESSION, items, { recordedAt: '2026-07-10T18:00:00Z' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0][IDX.event_type], 'plan_accepted');
  assert.equal(rows[0][IDX.outcome], 'planned');
  assert.equal(rows[0][IDX.planned_lift_code], 'BEN01');
  assert.equal(rows[0][IDX.planned_order], '1');
  assert.equal(rows[0][IDX.performed_lift_code], '', 'no performed code on plan_accepted');
  assert.equal(rows[1][IDX.plan_item_id], 'i2');
});

test('plan_accepted: canonical lift CODES only — free-text/whitespace rejected', () => {
  assert.throws(() => buildPlanAcceptedEvents(SESSION, [{ plan_item_id: 'i1', planned_lift_code: 'Bench Press' }]), /canonical lift code/);
  assert.throws(() => buildPlanAcceptedEvents(SESSION, [{ plan_item_id: 'i1', planned_lift_code: '' }]), /canonical lift code/);
  assert.throws(() => buildPlanAcceptedEvents(SESSION, [{ planned_lift_code: 'BEN01' }]), /plan_item_id is required/);
});

// ── item_outcome ────────────────────────────────────────────────────────────

test('item_outcome: completed/skipped carry no performed code', () => {
  for (const outcome of ['completed', 'skipped']) {
    const row = buildItemOutcomeEvent(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome });
    assert.equal(row[IDX.event_type], 'item_outcome');
    assert.equal(row[IDX.outcome], outcome);
    assert.equal(row[IDX.performed_lift_code], '');
  }
});

test('item_outcome: substituted REQUIRES a canonical performed_lift_code', () => {
  const row = buildItemOutcomeEvent(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'substituted', performed_lift_code: 'DBP01' });
  assert.equal(row[IDX.outcome], 'substituted');
  assert.equal(row[IDX.performed_lift_code], 'DBP01');
  assert.throws(() => buildItemOutcomeEvent(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'substituted' }), /performed_lift_code/);
  // a performed code on a non-substituted outcome is rejected (contract clarity)
  assert.throws(() => buildItemOutcomeEvent(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'completed', performed_lift_code: 'DBP01' }), /only valid when outcome is substituted/);
});

test('item_outcome: rejects an out-of-vocabulary or planned outcome', () => {
  assert.throws(() => buildItemOutcomeEvent(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'planned' }), /completed\|skipped\|substituted/);
  assert.throws(() => buildItemOutcomeEvent(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'quit' }), /completed\|skipped\|substituted/);
});

// ── session_closeout ────────────────────────────────────────────────────────

test('session_closeout: finalized/abandoned only; session-scoped (no item fields)', () => {
  const row = buildSessionCloseoutEvent(SESSION, 'finalized', { recordedAt: '2026-07-10T19:00:00Z' });
  assert.equal(row[IDX.event_type], 'session_closeout');
  assert.equal(row[IDX.closeout_status], 'finalized');
  assert.equal(row[IDX.plan_item_id], '');
  assert.equal(row[IDX.planned_lift_code], '');
  assert.equal(row[IDX.outcome], '');
  assert.equal(buildSessionCloseoutEvent(SESSION, 'abandoned')[IDX.closeout_status], 'abandoned');
  assert.throws(() => buildSessionCloseoutEvent(SESSION, 'done'), /finalized\|abandoned/);
});

// ── session required fields ─────────────────────────────────────────────────

test('every builder requires session_id + plan_version', () => {
  assert.throws(() => buildPlanAcceptedEvents({ plan_version: 'v1' }, [{ plan_item_id: 'i', planned_lift_code: 'B' }]), /session_id is required/);
  assert.throws(() => buildSessionCloseoutEvent({ session_id: 'S1' }, 'finalized'), /plan_version is required/);
});

// ── idempotency (the durability contract) ────────────────────────────────────

test('idempotency: deterministic + retry-safe; timestamp does NOT affect the key', () => {
  const items = [{ plan_item_id: 'i1', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' }];
  const a = buildPlanAcceptedEvents(SESSION, items, { recordedAt: '2026-07-10T18:00:00Z' })[0];
  const b = buildPlanAcceptedEvents(SESSION, items, { recordedAt: '2099-01-01T00:00:00Z' })[0];
  // Same logical event, different recorded_at → identical idempotency_key (retry-safe).
  assert.equal(a[IDX.idempotency_key], b[IDX.idempotency_key]);
  assert.notEqual(a[IDX.recorded_at], b[IDX.recorded_at]);
});

test('idempotency: a genuinely different event hashes differently', () => {
  const base = { plan_item_id: 'i1', planned_lift_code: 'BEN01' };
  const completed = buildItemOutcomeEvent(SESSION, { ...base, outcome: 'completed' })[IDX.idempotency_key];
  const skipped = buildItemOutcomeEvent(SESSION, { ...base, outcome: 'skipped' })[IDX.idempotency_key];
  const subDbp = buildItemOutcomeEvent(SESSION, { ...base, outcome: 'substituted', performed_lift_code: 'DBP01' })[IDX.idempotency_key];
  const subInc = buildItemOutcomeEvent(SESSION, { ...base, outcome: 'substituted', performed_lift_code: 'INC01' })[IDX.idempotency_key];
  const keys = [completed, skipped, subDbp, subInc];
  assert.equal(new Set(keys).size, keys.length, 'distinct outcomes/substitutes → distinct keys');
  // plan_accepted for the same item is a distinct event type → distinct key too.
  const accepted = buildPlanAcceptedEvents(SESSION, [base])[0][IDX.idempotency_key];
  assert.ok(!keys.includes(accepted));
});

test('idempotency: key is stable across the different fold dimensions', () => {
  // Different session or plan_version → different key (folds are per session+version+item).
  const item = { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'completed' };
  const k1 = buildItemOutcomeEvent(SESSION, item)[IDX.idempotency_key];
  const k2 = buildItemOutcomeEvent({ ...SESSION, plan_version: 'v2' }, item)[IDX.idempotency_key];
  const k3 = buildItemOutcomeEvent({ ...SESSION, session_id: 'S-OTHER' }, item)[IDX.idempotency_key];
  assert.equal(new Set([k1, k2, k3]).size, 3);
  // exposed idempotencyKey() matches the row's embedded key
  assert.equal(idempotencyKey({ event_type: 'item_outcome', session_id: SESSION.session_id, plan_version: SESSION.plan_version, plan_item_id: 'i1', outcome: 'completed', performed_lift_code: '', closeout_status: '' }), k1);
});

test('idempotency: golden hashes are pinned (any delimiter/field/order change is a regression)', () => {
  // The idempotency_key must stay stable FOREVER — it dedups against already-written
  // rows and the PR-C reader folds on it. Pin the absolute digest for fixed events so
  // an accidental change to the KEY_DELIM byte, the field set, or the field order is
  // caught here instead of silently re-keying the tab. (Review #956.)
  assert.equal(buildPlanAcceptedEvents(SESSION, [{ plan_item_id: 'i1', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' }])[0][IDX.idempotency_key], 'b66f4b794ea54b23');
  assert.equal(buildItemOutcomeEvent(SESSION, { plan_item_id: 'i1', planned_lift_code: 'BEN01', outcome: 'completed' })[IDX.idempotency_key], 'e9b9f567a59f0014');
  assert.equal(buildSessionCloseoutEvent(SESSION, 'finalized')[IDX.idempotency_key], 'e0344432eee1f7ec');
});
