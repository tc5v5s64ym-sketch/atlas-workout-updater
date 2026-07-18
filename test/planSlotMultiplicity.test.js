'use strict';

// F10S1 — planned-slot completion MULTIPLICITY (owner card, 2026-07-18 smoke gate).
// One performed set must not complete an entire multi-set planned slot: completion
// must respect the slot's required set count (per plan_item_id), derived from the
// accepted plan's `sets` and the per-set session log. The July 18 failure: one RDL
// set completed the whole 3-set RDL slot.
//
// Contract pinned here (selector level — src/app/planSlotStatuses.js):
//  - a slot with a known required set count completes only when the performed-set
//    count for its attributed identity reaches that count; below it the slot stays
//    PENDING (in progress) and exposes performedSets/requiredSets for surfaces;
//  - the explicit id-outcome lane ("Done with this exercise" / skip) stays
//    AUTHORITATIVE and completes regardless of counts;
//  - a slot with NO known set count keeps the legacy rule (any attributed log
//    completes it) — freestyle/unaccepted plans are unchanged;
//  - with no sessionLog supplied (legacy callers), behavior is unchanged;
//  - attribution itself is unchanged (exact > liftCode > variant > unique
//    abbreviation, ambiguity refusal, duplicate-name slot distinctness).

const test = require('node:test');
const assert = require('node:assert/strict');

let S;
test.before(async () => { S = await import('../src/app/planSlotStatuses.js'); });

const row = (exercise) => ({ exercise, weight: 245, reps: 6, rir: 3 });
const PLAN = {
  exercises: [
    { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', sets: 3 },
    { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'BSQ01', plan_item_id: 'pi_bsq', sets: 3 },
  ],
};

test('SMOKE REPRODUCE: one RDL set does NOT complete the 3-set RDL slot (in progress)', () => {
  const log = [row('Romanian Deadlift')];
  const statuses = S.planSlotStatuses(PLAN, ['Romanian Deadlift'], log);
  assert.equal(statuses[0].status, 'pending', 'the slot is IN PROGRESS, not complete');
  assert.equal(statuses[0].performedSets, 1, 'one of three sets performed');
  assert.equal(statuses[0].requiredSets, 3);
  // The surfaces derived from the selector agree:
  assert.deepEqual(S.remainingSlotNames(PLAN, ['Romanian Deadlift'], log), ['Romanian Deadlift', 'Back Squat'],
    'RDL is still remaining (next-up stays on it)');
  assert.equal(S.firstUnloggedSlot(PLAN, ['Romanian Deadlift'], log).plan_item_id, 'pi_rdl');
  assert.equal(S.isSlotComplete(PLAN, ['Romanian Deadlift'], 'pi_rdl', log), false);
  assert.equal(S.isPlanComplete(PLAN, ['Romanian Deadlift'], log), false);
});

test('the slot completes exactly at its required set count', () => {
  const two = [row('Romanian Deadlift'), row('Romanian Deadlift')];
  const three = [...two, row('Romanian Deadlift')];
  assert.equal(S.planSlotStatuses(PLAN, ['Romanian Deadlift'], two)[0].status, 'pending', '2/3 still in progress');
  const done = S.planSlotStatuses(PLAN, ['Romanian Deadlift'], three);
  assert.equal(done[0].status, 'completed', '3/3 completes');
  assert.equal(done[0].performedSets, 3);
  assert.deepEqual(S.remainingSlotNames(PLAN, ['Romanian Deadlift'], three), ['Back Squat']);
});

test('over-logging never blocks completion (4 sets on a 3-set slot is complete)', () => {
  const four = [row('Romanian Deadlift'), row('Romanian Deadlift'), row('Romanian Deadlift'), row('Romanian Deadlift')];
  assert.equal(S.planSlotStatuses(PLAN, ['Romanian Deadlift'], four)[0].status, 'completed');
});

test('the explicit id-outcome lane stays AUTHORITATIVE (Done completes a 1-of-3 slot)', () => {
  const plan = { ...PLAN, items: [{ plan_item_id: 'pi_rdl', outcome: 'completed' }] };
  const statuses = S.planSlotStatuses(plan, ['Romanian Deadlift'], [row('Romanian Deadlift')]);
  assert.equal(statuses[0].status, 'completed', 'an explicit Done outranks the count');
});

test('a slot with NO set count keeps the legacy rule (one attributed log completes it)', () => {
  const plan = { exercises: [{ name: 'Cable Row', plan_item_id: 'pi_cr' }] };
  const statuses = S.planSlotStatuses(plan, ['Cable Row'], [row('Cable Row')]);
  assert.equal(statuses[0].status, 'completed');
});

test('legacy callers (no sessionLog) keep the old behavior even with a set count', () => {
  const statuses = S.planSlotStatuses(PLAN, ['Romanian Deadlift']);
  assert.equal(statuses[0].status, 'completed', 'no per-set evidence supplied → attribution completes');
});

test('a recognized variant counts its own logged rows toward the base slot', () => {
  const plan = { exercises: [{ name: 'Dumbbell Press', plan_item_id: 'pi_dp', sets: 2 }] };
  const one = [row('Incline Dumbbell Press')];
  const two = [row('Incline Dumbbell Press'), row('Incline Dumbbell Press')];
  assert.equal(S.planSlotStatuses(plan, ['Incline Dumbbell Press'], one)[0].status, 'pending', '1/2 in progress');
  assert.equal(S.planSlotStatuses(plan, ['Incline Dumbbell Press'], two)[0].status, 'completed', '2/2 completes via the variant identity');
});

test('an attributed name with NO normKey-matching rows floors at 1 performed set (alias logging stays in progress, never zero)', () => {
  // The resolved completion identity can differ from every raw row name (alias logging).
  // Attribution succeeded, so at least one set happened — floor the count at 1 and stay
  // in progress; the explicit Done lane is the escape hatch.
  const log = [row('RDL')]; // raw alias rows; completion resolved to the full name
  const statuses = S.planSlotStatuses(PLAN, ['Romanian Deadlift'], log);
  assert.equal(statuses[0].status, 'pending');
  assert.equal(statuses[0].performedSets, 1, 'floored at 1, not 0');
});

test('duplicate-name slots stay distinct under counting (first absorbs the counts; second needs its own evidence)', () => {
  const plan = {
    exercises: [
      { name: 'Lat Pulldown', plan_item_id: 'pi_1', sets: 2 },
      { name: 'Lat Pulldown', plan_item_id: 'pi_2', sets: 2 },
    ],
  };
  const two = [row('Lat Pulldown'), row('Lat Pulldown')];
  const statuses = S.planSlotStatuses(plan, ['Lat Pulldown'], two);
  assert.equal(statuses[0].status, 'completed', 'the single deduped name completes the FIRST slot at its count');
  assert.equal(statuses[1].status, 'pending', 'the second identical slot never completes from name multiplicity');
});

test('every slot exposes attribution (attributedName) so off-plan detection means "attaches nowhere", not "completes nothing"', () => {
  const log = [row('Romanian Deadlift')];
  const statuses = S.planSlotStatuses(PLAN, ['Romanian Deadlift'], log);
  assert.equal(statuses[0].attributedName, 'Romanian Deadlift', 'the in-progress slot reports its attributed identity');
  assert.equal(statuses[1].attributedName, null);
});
