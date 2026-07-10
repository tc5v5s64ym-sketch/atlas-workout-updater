'use strict';

// PR-I5 — mid-plan completed-boundary eligibility (src/app/planCompletion.js).
// Pure/DI, runs in Node with no DOM. Pins the owner-approved "target last-logged
// item" behavior: a mid-plan item stays reachable after the cursor advances past it,
// multiple unresolved logged items surface sequentially (most-recent first), identity
// is carried by plan_item_id (duplicate lift codes stay unambiguous), a substituted
// slot completes the ORIGINAL plan_item_id while displaying the performed exercise,
// and logging evidence alone never marks anything completed (the caller's tap does).

const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => { mod = await import('../src/app/planCompletion.js'); });

// Two-item accepted plan; the cursor has already advanced to item 2 (Leg Extension),
// but Seated Row (item 1) was logged and is still outcome=planned.
function plan(overrides = {}) {
  return {
    accepted: true, session_id: 'S1', session_date: '2026-07-10', plan_version: 'pv_x1', index: 1,
    exercises: [
      { plan_item_id: 'pi_a', name: 'Seated Row', canonicalName: 'Seated Row', liftCode: 'ROW01' },
      { plan_item_id: 'pi_b', name: 'Leg Extension', canonicalName: 'Leg Extension', liftCode: 'LEX01' },
    ],
    items: [
      { plan_item_id: 'pi_a', planned_lift_code: 'ROW01', outcome: 'planned' },
      { plan_item_id: 'pi_b', planned_lift_code: 'LEX01', outcome: 'planned' },
    ],
    ...overrides,
  };
}

test('mid-plan item stays reachable after the cursor advances past it', () => {
  // Only Seated Row logged; cursor is on Leg Extension (index 1). Seated Row must
  // still be completable even though it is no longer the current slot.
  const t = mod.mostRecentCompletablePlanItem(plan(), ['Seated Row']);
  assert.equal(t && t.plan_item_id, 'pi_a');
  assert.equal(t.name, 'Seated Row');
});

test('multiple unresolved logged items surface sequentially — most recent first', () => {
  const p = plan();
  // Both logged, Leg Extension last → it is the most-recent completable.
  let t = mod.mostRecentCompletablePlanItem(p, ['Seated Row', 'Leg Extension']);
  assert.equal(t.plan_item_id, 'pi_b', 'last-logged wins');
  // Mark pi_b completed → the next-most-recent (Seated Row) becomes reachable.
  p.items.find(i => i.plan_item_id === 'pi_b').outcome = 'completed';
  t = mod.mostRecentCompletablePlanItem(p, ['Seated Row', 'Leg Extension']);
  assert.equal(t.plan_item_id, 'pi_a', 'after completing the latest, the prior logged item surfaces');
  // Complete pi_a too → nothing left completable.
  p.items.find(i => i.plan_item_id === 'pi_a').outcome = 'completed';
  assert.equal(mod.mostRecentCompletablePlanItem(p, ['Seated Row', 'Leg Extension']), null);
});

test('logging evidence alone never marks completed — it only makes an item ELIGIBLE', () => {
  // The helper NEVER mutates outcome; it just reports eligibility. Both items stay
  // outcome=planned after the call (the tap, not this, authors completion).
  const p = plan();
  mod.mostRecentCompletablePlanItem(p, ['Seated Row', 'Leg Extension']);
  assert.equal(p.items.find(i => i.plan_item_id === 'pi_a').outcome, 'planned');
  assert.equal(p.items.find(i => i.plan_item_id === 'pi_b').outcome, 'planned');
});

test('an unlogged item is never completable (no fabricated evidence)', () => {
  // Nothing logged → nothing completable, even though both are outcome=planned.
  assert.equal(mod.mostRecentCompletablePlanItem(plan(), []), null);
  // Only Leg Extension logged → Seated Row (unlogged) is not offered.
  const t = mod.mostRecentCompletablePlanItem(plan(), ['Leg Extension']);
  assert.equal(t.plan_item_id, 'pi_b');
});

test('duplicate lift codes stay unambiguous — identity is the slot plan_item_id, not the code', () => {
  // Two DISTINCT accepted items share a lift code (ROW01) but have distinct ids/names.
  const p = {
    accepted: true, plan_version: 'pv_x1', index: 0,
    exercises: [
      { plan_item_id: 'pi_1', name: 'Seated Row', canonicalName: 'Seated Row', liftCode: 'ROW01' },
      { plan_item_id: 'pi_2', name: 'Chest-Supported Row', canonicalName: 'Chest-Supported Row', liftCode: 'ROW01' },
    ],
    items: [
      { plan_item_id: 'pi_1', planned_lift_code: 'ROW01', outcome: 'planned' },
      { plan_item_id: 'pi_2', planned_lift_code: 'ROW01', outcome: 'planned' },
    ],
  };
  // Log only the second one → its OWN plan_item_id is returned, not the first's.
  const t = mod.mostRecentCompletablePlanItem(p, ['Chest-Supported Row']);
  assert.equal(t.plan_item_id, 'pi_2', 'the logged same-code item resolves to its own id');
  assert.equal(t.name, 'Chest-Supported Row');
});

test('a substituted slot completes the ORIGINAL plan_item_id while displaying the performed exercise', () => {
  // Substitution keeps the original id on the slot (PR-G1) and shows the performed
  // name; its item.outcome stays 'planned' locally (only the sidecar got 'substituted').
  const p = plan({
    exercises: [
      // Seated Row was substituted with Bent Over Row — slot RETAINS pi_a.
      { plan_item_id: 'pi_a', name: 'Bent Over Row', canonicalName: 'Bent Over Row', liftCode: 'ROW02', reason: 'substituted' },
      { plan_item_id: 'pi_b', name: 'Leg Extension', canonicalName: 'Leg Extension', liftCode: 'LEX01' },
    ],
  });
  const t = mod.mostRecentCompletablePlanItem(p, ['Bent Over Row']);
  assert.equal(t.plan_item_id, 'pi_a', 'completion targets the ORIGINAL accepted item id');
  assert.equal(t.name, 'Bent Over Row', 'the button displays the performed exercise');
});

test('a completed item is never re-offered (no re-complete / double-tap)', () => {
  const p = plan();
  p.items.find(i => i.plan_item_id === 'pi_a').outcome = 'completed';
  // Seated Row done; only Leg Extension (if logged) remains.
  assert.equal(mod.mostRecentCompletablePlanItem(p, ['Seated Row']), null);
  assert.equal(mod.mostRecentCompletablePlanItem(p, ['Seated Row', 'Leg Extension']).plan_item_id, 'pi_b');
});

test('a skipped item (spliced from exercises) is never completable', () => {
  // skipPlannedExercise removes the slot; only Leg Extension remains in exercises.
  const p = plan({
    exercises: [{ plan_item_id: 'pi_b', name: 'Leg Extension', canonicalName: 'Leg Extension', liftCode: 'LEX01' }],
  });
  // Even if "Seated Row" appears in the log, its slot is gone → not completable.
  const t = mod.mostRecentCompletablePlanItem(p, ['Seated Row', 'Leg Extension']);
  assert.equal(t.plan_item_id, 'pi_b');
});

test('eligibility is index-independent — reachable regardless of the cursor position', () => {
  // Same plan+log, cursor at 0 vs 1 → identical result (never resolves by position).
  const log = ['Seated Row', 'Leg Extension'];
  const at0 = mod.mostRecentCompletablePlanItem(plan({ index: 0 }), log);
  const at1 = mod.mostRecentCompletablePlanItem(plan({ index: 1 }), log);
  assert.deepEqual(at0, at1);
  assert.equal(at0.plan_item_id, 'pi_b');
});

test('totality: garbage / unaccepted / empty → null, never throws', () => {
  for (const arg of [null, undefined, {}, { accepted: false, exercises: [] }, { accepted: true }, 42]) {
    assert.equal(mod.mostRecentCompletablePlanItem(arg, ['x']), null);
  }
  assert.equal(mod.mostRecentCompletablePlanItem(plan(), null), null);
});
