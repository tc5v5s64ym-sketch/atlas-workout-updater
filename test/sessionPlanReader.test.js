'use strict';

// Decision Desk #952 (Option A) — Session_Plans PR-C: reader/fold module.
//
// Folds append-only Session_Plans event ROWS (as sheets.getSheetRows returns them,
// header stripped) by (session_id + plan_version + plan_item_id), last-wins, into
// the shape detectDrift's plannedVsCompleted argument expects
// ([{ date, planned:string[], completed:string[] }], newest LAST). Pure: no I/O —
// the live capture read is a later wiring slice. Rows here are produced by the PR-A
// builders (round-trip) plus hand-crafted malformed rows.
//
// Pins (owner): completion is derived from ITEM OUTCOMES, not closeout_status;
// finalized/abandoned/partial/substituted/skipped/still-open all supported; a
// DUPLICATE idempotency_key collapses (the #958-review authoritative-dedup carry-over);
// malformed OR same-key/different-content events FAIL CLOSED (that session is excluded
// from the drift-shaped output).

const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionPlansColumns } = require('../config/columns');
const {
  buildPlanAcceptedEvents, buildItemOutcomeEvent, buildSessionCloseoutEvent,
} = require('../services/sessionPlanEvents');
const {
  foldSessionPlans, toPlannedVsCompleted, readPlannedVsCompleted,
} = require('../services/sessionPlanReader');

const IDX = Object.fromEntries(sessionPlansColumns.map((c, i) => [c, i]));
const S = (over = {}) => ({ session_id: 'S1', session_date: '2026-07-01', plan_version: 'v1', ...over });
const items = [
  { plan_item_id: 'i1', planned_order: 1, planned_lift_code: 'BEN01', movement_pattern: 'horizontal_push' },
  { plan_item_id: 'i2', planned_order: 2, planned_lift_code: 'SQ01', movement_pattern: 'squat' },
];
// Build a full session's rows: plan_accepted for each item + item outcomes + closeout.
function sessionRows(session, outcomes /* {i1:'completed', i2:{outcome:'substituted', performed:'LP01'}} */, closeout) {
  const rows = buildPlanAcceptedEvents(session, items, { recordedAt: 'r0' });
  let n = 1;
  for (const it of items) {
    const o = outcomes[it.plan_item_id];
    if (!o) continue;
    const outcome = typeof o === 'string' ? o : o.outcome;
    const performed_lift_code = typeof o === 'object' ? o.performed : undefined;
    rows.push(buildItemOutcomeEvent(session, { ...it, outcome, performed_lift_code }, { recordedAt: `r${n++}` }));
  }
  if (closeout) rows.push(buildSessionCloseoutEvent(session, closeout, { recordedAt: `rz` }));
  return rows;
}

// ── completion from item outcomes ─────────────────────────────────────────────

test('finalized + all completed: planned = all, completed = all', () => {
  const rows = sessionRows(S(), { i1: 'completed', i2: 'completed' }, 'finalized');
  const folded = foldSessionPlans(rows);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].status, 'finalized');
  assert.deepEqual(folded[0].planned.sort(), ['BEN01', 'SQ01']);
  assert.deepEqual(folded[0].completed.sort(), ['BEN01', 'SQ01']);
});

test('skipped item is NOT in completed (plan_deviation input)', () => {
  const rows = sessionRows(S(), { i1: 'completed', i2: 'skipped' }, 'finalized');
  const [f] = foldSessionPlans(rows);
  assert.deepEqual(f.planned.sort(), ['BEN01', 'SQ01']);
  assert.deepEqual(f.completed, ['BEN01'], 'skipped SQ01 is planned-but-not-completed');
});

test('substituted item: completed carries the PERFORMED code, not the planned', () => {
  const rows = sessionRows(S(), { i1: 'completed', i2: { outcome: 'substituted', performed: 'LP01' } }, 'finalized');
  const [f] = foldSessionPlans(rows);
  assert.deepEqual(f.planned.sort(), ['BEN01', 'SQ01']);
  assert.deepEqual(f.completed.sort(), ['BEN01', 'LP01'], 'the substitute LP01 was actually performed');
});

test('completion is derived from outcomes, NOT closeout_status (finalized ≠ all done)', () => {
  // Session finalized but one item skipped — finalized must not imply completion.
  const rows = sessionRows(S(), { i1: 'completed', i2: 'skipped' }, 'finalized');
  const [f] = foldSessionPlans(rows);
  assert.equal(f.status, 'finalized');
  assert.notEqual(f.completed.length, f.planned.length, 'finalized does not mean every item completed');
});

// ── session states ────────────────────────────────────────────────────────────

test('abandoned session is supported and marked abandoned', () => {
  const rows = sessionRows(S(), { i1: 'completed' }, 'abandoned');
  const [f] = foldSessionPlans(rows);
  assert.equal(f.status, 'abandoned');
});

test('still-open session (no closeout) is status open; excluded from the closed drift view', () => {
  const rows = sessionRows(S(), { i1: 'completed' }, null); // no closeout, i2 still planned
  const [f] = foldSessionPlans(rows);
  assert.equal(f.status, 'open');
  // closedOnly (default) → open sessions are not fed to drift…
  assert.equal(toPlannedVsCompleted([f]).length, 0);
  // …but are available when explicitly requested.
  assert.equal(toPlannedVsCompleted([f], { closedOnly: false }).length, 1);
});

// ── last-wins fold ────────────────────────────────────────────────────────────

test('last-wins: a later item_outcome overrides an earlier one for the same item', () => {
  const rows = buildPlanAcceptedEvents(S(), [items[0]], { recordedAt: 'r0' });
  rows.push(buildItemOutcomeEvent(S(), { ...items[0], outcome: 'completed' }, { recordedAt: 'r1' }));
  rows.push(buildItemOutcomeEvent(S(), { ...items[0], outcome: 'skipped' }, { recordedAt: 'r2' })); // correction
  rows.push(buildSessionCloseoutEvent(S(), 'finalized', { recordedAt: 'rz' }));
  const [f] = foldSessionPlans(rows);
  assert.deepEqual(f.completed, [], 'the later skip wins over the earlier complete');
  assert.equal(f.items.find(i => i.plan_item_id === 'i1').outcome, 'skipped');
});

// ── substituted → completed composition (the owner-approved Done boundary) ─────
// PR #974 made "Done with this exercise" reachable for a substituted slot (it
// completes the ORIGINAL plan_item_id), so `substituted` followed by `completed`
// on one item is a normal athlete flow: swap the lift, log it, tap Done. The fold
// must keep the deviation visible — an explicit Done finishes the item, it does
// NOT un-substitute it. `completed` still lists the lift actually PERFORMED.

test('substituted then Done: completed carries the PERFORMED code — Done never erases the substitution', () => {
  const rows = buildPlanAcceptedEvents(S(), [items[1]], { recordedAt: 'r0' });          // SQ01 planned
  rows.push(buildItemOutcomeEvent(S(), { ...items[1], outcome: 'substituted', performed_lift_code: 'LP01' }, { recordedAt: 'r1' }));
  rows.push(buildItemOutcomeEvent(S(), { ...items[1], outcome: 'completed' }, { recordedAt: 'r2' })); // explicit "Done with this exercise"
  rows.push(buildSessionCloseoutEvent(S(), 'finalized', { recordedAt: 'rz' }));
  const [f] = foldSessionPlans(rows);
  const it = f.items.find(i => i.plan_item_id === 'i2');
  assert.equal(it.outcome, 'completed', 'last-wins: the explicit Done is the final outcome');
  assert.equal(it.performed_lift_code, 'LP01', 'the performed substitute survives the Done');
  assert.deepEqual(f.planned, ['SQ01']);
  assert.deepEqual(f.completed, ['LP01'], 'the athlete performed LP01, not the planned SQ01');
});

test('metamorphic: tapping Done after a substitution must not change the drift history', () => {
  const base = buildPlanAcceptedEvents(S(), [items[1]], { recordedAt: 'r0' });
  base.push(buildItemOutcomeEvent(S(), { ...items[1], outcome: 'substituted', performed_lift_code: 'LP01' }, { recordedAt: 'r1' }));
  const close = buildSessionCloseoutEvent(S(), 'finalized', { recordedAt: 'rz' });
  const withoutDone = readPlannedVsCompleted([...base, close]);
  const withDone = readPlannedVsCompleted([
    ...base,
    buildItemOutcomeEvent(S(), { ...items[1], outcome: 'completed' }, { recordedAt: 'r2' }),
    close,
  ]);
  assert.deepEqual(withDone, withoutDone, 'the Done tap adds no history — the recorded deviation is identical');
});

test('completed with NO prior substitution is unchanged: planned code, no performed code', () => {
  const rows = sessionRows(S(), { i1: 'completed' }, 'finalized');
  const [f] = foldSessionPlans(rows);
  const it = f.items.find(i => i.plan_item_id === 'i1');
  assert.equal(it.performed_lift_code, null);
  assert.deepEqual(f.completed, ['BEN01']);
});

test('skipped after substituted: nothing performed — completed empty, performed code cleared', () => {
  const rows = buildPlanAcceptedEvents(S(), [items[1]], { recordedAt: 'r0' });
  rows.push(buildItemOutcomeEvent(S(), { ...items[1], outcome: 'substituted', performed_lift_code: 'LP01' }, { recordedAt: 'r1' }));
  rows.push(buildItemOutcomeEvent(S(), { ...items[1], outcome: 'skipped' }, { recordedAt: 'r2' })); // bailed on the substitute too
  rows.push(buildSessionCloseoutEvent(S(), 'finalized', { recordedAt: 'rz' }));
  const [f] = foldSessionPlans(rows);
  const it = f.items.find(i => i.plan_item_id === 'i2');
  assert.equal(it.outcome, 'skipped');
  assert.equal(it.performed_lift_code, null);
  assert.deepEqual(f.completed, []);
});

test('completed then substituted (correction order): the later substitution wins with its performed code', () => {
  const rows = buildPlanAcceptedEvents(S(), [items[1]], { recordedAt: 'r0' });
  rows.push(buildItemOutcomeEvent(S(), { ...items[1], outcome: 'completed' }, { recordedAt: 'r1' }));
  rows.push(buildItemOutcomeEvent(S(), { ...items[1], outcome: 'substituted', performed_lift_code: 'LP01' }, { recordedAt: 'r2' }));
  rows.push(buildSessionCloseoutEvent(S(), 'finalized', { recordedAt: 'rz' }));
  const [f] = foldSessionPlans(rows);
  assert.deepEqual(f.completed, ['LP01']);
});

// ── authoritative dedup (#958-review carry-over) ──────────────────────────────

test('duplicate idempotency_key rows collapse — no double count', () => {
  const rows = sessionRows(S(), { i1: 'completed', i2: 'completed' }, 'finalized');
  const doubled = [...rows, ...rows.map(r => r.slice())]; // every event written twice
  const folded = foldSessionPlans(doubled);
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].completed.sort(), ['BEN01', 'SQ01'], 'a doubled write is invisible after the fold');
  assert.equal(folded[0].items.length, 2, 'items not duplicated');
});

// ── fail closed ───────────────────────────────────────────────────────────────

test('a malformed event fails closed: its session is excluded from the drift view', () => {
  const rows = sessionRows(S(), { i1: 'completed', i2: 'completed' }, 'finalized');
  const bad = rows[1].slice(); bad[IDX.event_type] = 'not_a_real_event'; // corrupt one row
  const folded = foldSessionPlans([...rows, bad]);
  const f = folded.find(s => s.session_id === 'S1');
  assert.equal(f.status, 'error', 'a corrupt event marks the whole session unreadable');
  assert.equal(toPlannedVsCompleted(folded).length, 0, 'error sessions never reach drift (fail closed)');
});

test('a row truncated AFTER its identity columns still fails closed (attributed via early cols)', () => {
  // #959 review: a hand-edit that drops trailing cells leaves session_id/plan_version
  // readable — the session must be marked error, not silently skipped (fail open).
  const rows = sessionRows(S(), { i1: 'completed', i2: 'completed' }, 'finalized');
  const truncated = rows[1].slice(0, IDX.plan_version + 1); // keep through plan_version, drop the rest
  const folded = foldSessionPlans([...rows, truncated]);
  assert.equal(folded.find(s => s.session_id === 'S1').status, 'error');
  assert.equal(toPlannedVsCompleted(folded).length, 0, 'a session with a truncated row never reaches drift');
});

test('same idempotency_key with different content fails closed (conflict)', () => {
  const base = buildPlanAcceptedEvents(S(), [items[0]], { recordedAt: 'r0' })[0];
  const conflict = base.slice(); conflict[IDX.planned_lift_code] = 'INC01'; // same key, changed lift
  const folded = foldSessionPlans([base, conflict, buildSessionCloseoutEvent(S(), 'finalized', { recordedAt: 'rz' })]);
  assert.equal(folded.find(s => s.session_id === 'S1').status, 'error');
});

// ── drift shape + ordering + totality ─────────────────────────────────────────

test('toPlannedVsCompleted returns exactly {date,planned,completed}, newest last, non-empty plans', () => {
  const s1 = sessionRows(S({ session_id: 'A', session_date: '2026-06-01' }), { i1: 'completed', i2: 'skipped' }, 'finalized');
  const s2 = sessionRows(S({ session_id: 'B', session_date: '2026-06-08' }), { i1: 'completed', i2: 'completed' }, 'finalized');
  const out = readPlannedVsCompleted([...s1, ...s2]);
  assert.equal(out.length, 2);
  assert.deepEqual(Object.keys(out[0]).sort(), ['completed', 'date', 'planned']);
  assert.equal(out[out.length - 1].date, '2026-06-08', 'newest session is last');
});

test('totality: garbage/empty input → [] and never throws', () => {
  for (const g of [null, undefined, 42, [], [[]], [['x']], ['not-an-array']]) {
    assert.doesNotThrow(() => foldSessionPlans(g));
    assert.deepEqual(readPlannedVsCompleted(g), []);
  }
});

// ── PR-B5a Part 2a: FINALIZED-ONLY drift projection ───────────────────────────
// The drift/challenge signal may consider only authoritative CLOSED (finalized)
// training history. Abandoned/open/error sessions are excluded so a bailed or
// in-progress session can never manufacture a pattern streak or deviation.

const { readFinalizedPlannedVsCompleted } = require('../services/sessionPlanReader');

test('PR-B5a-2a: the proven 7-row finalized canary folds to ROW01 completed, LEX01→LEP01 substituted, OHP01 skipped, finalized', () => {
  const canarySession = { session_id: '20260710-PM-01', session_date: '2026-07-10', plan_version: 'pv_3b2774fb' };
  const canaryItems = [
    { plan_item_id: 'pi_a', planned_order: 1, planned_lift_code: 'ROW01', movement_pattern: 'horizontal_pull' },
    { plan_item_id: 'pi_b', planned_order: 2, planned_lift_code: 'LEX01', movement_pattern: 'knee_extension' },
    { plan_item_id: 'pi_c', planned_order: 3, planned_lift_code: 'OHP01', movement_pattern: 'vertical_push' },
  ];
  const rows = [
    ...buildPlanAcceptedEvents(canarySession, canaryItems, { recordedAt: 'r0' }),                                     // 3 plan_accepted
    buildItemOutcomeEvent(canarySession, { ...canaryItems[0], outcome: 'completed' }, { recordedAt: 'r1' }),          // ROW01 completed
    buildItemOutcomeEvent(canarySession, { ...canaryItems[1], outcome: 'substituted', performed_lift_code: 'LEP01' }, { recordedAt: 'r2' }), // LEX01→LEP01
    buildItemOutcomeEvent(canarySession, { ...canaryItems[2], outcome: 'skipped' }, { recordedAt: 'r3' }),            // OHP01 skipped
    buildSessionCloseoutEvent(canarySession, 'finalized', { recordedAt: 'rz' }),                                      // finalized
  ];
  assert.equal(rows.length, 7, 'the canary is exactly 7 rows');

  const folded = foldSessionPlans(rows);
  assert.equal(folded.length, 1);
  const s = folded[0];
  assert.equal(s.status, 'finalized');
  const byId = Object.fromEntries(s.items.map(it => [it.plan_item_id, it]));
  assert.equal(byId.pi_a.outcome, 'completed');
  assert.equal(byId.pi_b.outcome, 'substituted');
  assert.equal(byId.pi_b.performed_lift_code, 'LEP01');
  assert.equal(byId.pi_c.outcome, 'skipped');

  const drift = readFinalizedPlannedVsCompleted(rows);
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0].planned, ['ROW01', 'LEX01', 'OHP01']);
  // completed = performed lifts: ROW01 (completed→planned code) + LEP01 (substituted→performed code); OHP01 skipped contributes nothing.
  assert.deepEqual(drift[0].completed, ['ROW01', 'LEP01']);
});

test('PR-B5a-2a: an abandoned session is EXCLUDED from finalized drift history (finalized kept)', () => {
  const fin = sessionRows(S({ session_id: 'FIN', session_date: '2026-07-02' }), { i1: 'completed', i2: 'completed' }, 'finalized');
  const aband = sessionRows(S({ session_id: 'ABANDON', session_date: '2026-07-03' }), { i1: 'skipped' }, 'abandoned');
  const drift = readFinalizedPlannedVsCompleted([...fin, ...aband]);
  assert.equal(drift.length, 1, 'only the finalized session survives');
  // sanity: the generic (default) reader still INCLUDES the abandoned session (unchanged behavior)
  assert.equal(readPlannedVsCompleted([...fin, ...aband]).length, 2);
});

test('PR-B5a-2a: open and error sessions are excluded from finalized drift history', () => {
  const fin = sessionRows(S({ session_id: 'FIN', session_date: '2026-07-02' }), { i1: 'completed', i2: 'completed' }, 'finalized');
  const open = sessionRows(S({ session_id: 'OPEN', session_date: '2026-07-04' }), { i1: 'completed' } /* no closeout → open */);
  // an error session: a plan_accepted row truncated below the 13-col contract
  const errRow = buildPlanAcceptedEvents(S({ session_id: 'ERR', session_date: '2026-07-05' }), [items[0]], { recordedAt: 'e0' })[0].slice(0, 5);
  const drift = readFinalizedPlannedVsCompleted([...fin, ...open, errRow]);
  assert.equal(drift.length, 1, 'only the finalized session survives (open + error dropped)');
});

test('PR-B5a-2a: identical replay rows deduplicate (no double-count)', () => {
  const fin = sessionRows(S({ session_id: 'FIN', session_date: '2026-07-02' }), { i1: 'completed', i2: 'skipped' }, 'finalized');
  const replayed = [...fin, ...fin]; // exact duplicate idempotency_key rows collapse
  const drift = readFinalizedPlannedVsCompleted(replayed);
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0].planned, ['BEN01', 'SQ01']);
  assert.deepEqual(drift[0].completed, ['BEN01']); // i2 skipped contributes nothing
});
