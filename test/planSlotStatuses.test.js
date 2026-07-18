'use strict';

// F10 — Authoritative planned-slot completion identity (src/app/planSlotStatuses.js).
// Pure/DI, runs in Node with no DOM. Pins the owner-approved completion semantics:
// one canonical plan_item_id-keyed per-slot selector that every completion/remaining
// surface derives from. Covers the required cases: substituted variant, alias,
// duplicate planned names, substring collision (ambiguity refusal), out-of-order
// completion, skip then log, reload/fold, and the explicit id-keyed outcome lane.

const test = require('node:test');
const assert = require('node:assert/strict');

let mod;
test.before(async () => { mod = await import('../src/app/planSlotStatuses.js'); });

// Accepted plan with tagged plan_item_ids on each execution slot (planAcceptance.js
// tags exercises 1:1 with items). `items[]` carries the explicit-outcome lane.
function plan(exercises, items) {
  return { accepted: true, session_id: 'S1', plan_version: 'pv_x', exercises, items: items || [] };
}
const ex = (name, liftCode, planItemId) => ({ name, canonicalName: name, liftCode: liftCode || '', plan_item_id: planItemId || null });
const statusByName = (rows) => rows.map(r => [r.name, r.status]);

// ── AC2 — duplicate planned names stay slot-distinct ──────────────────────────────

test('duplicate names: one logged set completes exactly ONE of two same-named slots', () => {
  const p = plan([ex('Lat Pulldown', 'LAT01', 'pi_1'), ex('Cable Row', 'ROW01', 'pi_2'), ex('Lat Pulldown', 'LAT01', 'pi_3')]);
  const rows = mod.planSlotStatuses(p, ['Lat Pulldown']);
  // The FIRST Lat Pulldown slot (pi_1) is completed; pi_3 stays pending.
  assert.deepEqual(statusByName(rows), [['Lat Pulldown', 'completed'], ['Cable Row', 'pending'], ['Lat Pulldown', 'pending']]);
  assert.deepEqual(mod.remainingSlotNames(p, ['Lat Pulldown']), ['Cable Row', 'Lat Pulldown']);
  assert.equal(mod.isPlanComplete(p, ['Lat Pulldown']), false);
  // Slot identity is by plan_item_id: pi_1 complete, pi_3 not.
  assert.equal(mod.isSlotComplete(p, ['Lat Pulldown'], 'pi_1'), true);
  assert.equal(mod.isSlotComplete(p, ['Lat Pulldown'], 'pi_3'), false);
});

test('duplicate names: both slots complete only once both are logged (order preserved)', () => {
  const p = plan([ex('Lat Pulldown', 'LAT01', 'pi_1'), ex('Cable Row', 'ROW01', 'pi_2'), ex('Lat Pulldown', 'LAT01', 'pi_3')]);
  const done = ['Lat Pulldown', 'Cable Row', 'Lat Pulldown'];
  assert.deepEqual(mod.remainingSlotNames(p, done), []);
  assert.equal(mod.isPlanComplete(p, done), true);
});

// ── AC3 — exact identity outranks substring; ambiguous substring refuses ──────────

test('substring collision: an ambiguous substring resolves NOTHING (SESS-5, no guess)', () => {
  // "Row" substring-matches BOTH "Barbell Row" and "Seated Row" — refuse rather than
  // silently complete the wrong slot.
  const p = plan([ex('Barbell Row', 'BBR01', 'pi_1'), ex('Seated Row', 'SR01', 'pi_2')]);
  const rows = mod.planSlotStatuses(p, ['Row']);
  assert.deepEqual(statusByName(rows), [['Barbell Row', 'pending'], ['Seated Row', 'pending']]);
});

test('exact outranks substring: an exact name completes its slot even when it substrings another', () => {
  // "Bench Press" is a substring of "Incline Bench Press"; the EXACT slot wins.
  const p = plan([ex('Incline Bench Press', 'IBP01', 'pi_1'), ex('Bench Press', 'BP01', 'pi_2')]);
  const rows = mod.planSlotStatuses(p, ['Bench Press']);
  assert.deepEqual(statusByName(rows), [['Incline Bench Press', 'pending'], ['Bench Press', 'completed']]);
});

test('unique substring still resolves (alias tier) when exactly one slot matches', () => {
  const p = plan([ex('Lat Pulldown', 'LAT01', 'pi_1'), ex('Face Pull', 'FP01', 'pi_2')]);
  // "Lat pull" substrings only "Lat Pulldown" → unique → attribute.
  assert.deepEqual(mod.remainingSlotNames(p, ['Lat pull']), ['Face Pull']);
});

// ── AC1 — substitution / variant satisfies the ORIGINAL planned slot ──────────────

test('variant satisfies base slot: "Incline Dumbbell Flyes" completes the "Dumbbell Flyes" slot', () => {
  const p = plan([ex('Dumbbell Flyes', 'DBF01', 'pi_1'), ex('Triceps Pushdown', 'TP01', 'pi_2')]);
  assert.deepEqual(mod.remainingSlotNames(p, ['Incline Dumbbell Flyes']), ['Triceps Pushdown']);
  assert.equal(mod.isSlotComplete(p, ['Incline Dumbbell Flyes'], 'pi_1'), true);
});

test('variant guard: a DIFFERENT lift that merely ends with the base does NOT satisfy it', () => {
  // "Romanian Deadlift" must not complete a bare "Deadlift" slot (distinct movement).
  const p = plan([ex('Deadlift', 'DL01', 'pi_1')]);
  assert.deepEqual(mod.remainingSlotNames(p, ['Romanian Deadlift']), ['Deadlift']);
});

test('substituted slot retains plan_item_id: logging the substitute completes the ORIGINAL slot', () => {
  // applySessionSubstitution swaps the slot name to the substitute but KEEPS pi_1 and
  // records item.outcome='substituted'. Logging the substitute completes pi_1.
  const p = plan(
    [ex('Pec Deck', 'PD01', 'pi_1'), ex('Triceps Pushdown', 'TP01', 'pi_2')],
    [{ plan_item_id: 'pi_1', outcome: 'substituted', performed_lift_code: 'PD01' }, { plan_item_id: 'pi_2', outcome: 'planned' }],
  );
  // Before the substitute is logged, the (substituted) slot is still remaining.
  assert.deepEqual(mod.remainingSlotNames(p, []), ['Pec Deck', 'Triceps Pushdown']);
  // After logging it, pi_1 completes.
  assert.equal(mod.isSlotComplete(p, ['Pec Deck'], 'pi_1'), true);
  assert.deepEqual(mod.remainingSlotNames(p, ['Pec Deck']), ['Triceps Pushdown']);
});

// ── AC5 — the explicit id-keyed item-outcome lane is authoritative ────────────────

test('explicit completed outcome: a "Done with this exercise" slot is complete without a name match', () => {
  const p = plan(
    [ex('Hanging Leg Raise', 'HLR01', 'pi_1'), ex('Plank', 'PL01', 'pi_2')],
    [{ plan_item_id: 'pi_1', outcome: 'completed' }],
  );
  const rows = mod.planSlotStatuses(p, []);
  assert.deepEqual(statusByName(rows), [['Hanging Leg Raise', 'completed'], ['Plank', 'pending']]);
});

test('explicit skipped outcome: a skipped slot is not remaining and not completed', () => {
  const p = plan(
    [ex('Barbell Row', 'BBR01', 'pi_1'), ex('Shrug', 'SH01', 'pi_2')],
    [{ plan_item_id: 'pi_1', outcome: 'skipped' }],
  );
  assert.deepEqual(mod.remainingSlotNames(p, []), ['Shrug']);
  assert.equal(mod.isSlotComplete(p, [], 'pi_1'), false);
  assert.equal(mod.isPlanComplete(p, ['Shrug']), true); // skipped resolved + Shrug logged
});

// ── out-of-order completion, alias, plural, and reload/fold ───────────────────────

test('out-of-order: logging slot C then A leaves B remaining, in plan order', () => {
  const p = plan([ex('A', 'A01', 'pi_a'), ex('B', 'B01', 'pi_b'), ex('C', 'C01', 'pi_c')]);
  assert.deepEqual(mod.remainingSlotNames(p, ['C', 'A']), ['B']);
});

test('plural logged name completes its singular slot without collapsing distinct lifts', () => {
  const p = plan([ex('Lateral Raise', 'LR01', 'pi_1'), ex('Barbell Curl', 'BC01', 'pi_2')]);
  assert.deepEqual(mod.remainingSlotNames(p, ['Lateral Raises']), ['Barbell Curl']);
  // "press" must never be singularized to "pres" and collide.
  const p2 = plan([ex('Bench Press', 'BP01', 'pi_1'), ex('Incline Bench Press', 'IBP01', 'pi_2')]);
  assert.deepEqual(mod.remainingSlotNames(p2, ['Bench Press']), ['Incline Bench Press']);
});

test('reload/fold: attribution is a pure function of (plan, completedNames) — stable across calls', () => {
  const p = plan([ex('Lat Pulldown', 'LAT01', 'pi_1'), ex('Lat Pulldown', 'LAT01', 'pi_2')]);
  const a = mod.planSlotStatuses(p, ['Lat Pulldown']);
  const b = mod.planSlotStatuses(p, ['Lat Pulldown']);
  assert.deepEqual(a, b);
  assert.equal(a[0].status, 'completed');
  assert.equal(a[1].status, 'pending');
});

// ── hard-case (c): an unaccepted plan (no plan_item_id) still fails closed safely ─

test('unaccepted plan (no plan_item_id): position-keyed distinctness still holds', () => {
  const p = { exercises: [ex('Lat Pulldown', 'LAT01', null), ex('Lat Pulldown', 'LAT01', null)] };
  const rows = mod.planSlotStatuses(p, ['Lat Pulldown']);
  assert.deepEqual(rows.map(r => r.status), ['completed', 'pending']);
  // No id → isSlotComplete fails closed (there is no id to key on).
  assert.equal(mod.isSlotComplete(p, ['Lat Pulldown'], ''), false);
});

test('lift_code evidence attributes a logged completion carrying a code', () => {
  const p = plan([ex('Romanian Deadlift', 'RDL01', 'pi_1'), ex('Leg Curl', 'LC01', 'pi_2')]);
  // A completion object carrying the code (F10A/B forward-compat) attributes by code
  // even when the display name differs.
  assert.deepEqual(mod.remainingSlotNames(p, [{ name: 'RDL', liftCode: 'RDL01' }]), ['Leg Curl']);
});

// ── guards ────────────────────────────────────────────────────────────────────────

test('empty / malformed inputs never throw and yield sane defaults', () => {
  assert.deepEqual(mod.planSlotStatuses(null, null), []);
  assert.deepEqual(mod.remainingSlotNames(undefined, undefined), []);
  assert.equal(mod.firstUnloggedSlot({ exercises: [] }, []), null);
  assert.equal(mod.isPlanComplete({ exercises: [] }, []), false);
});
