'use strict';

// F10 — cross-surface parity (AC4): recap, next-up, pin, closeout, and the Workout
// Sheet must return the SAME status from the SAME plan_item_id-keyed selector. This
// drives the REAL app.js surfaces (remainingPlannedExercises, firstUnloggedPlannedLift,
// isPlanCloseoutAwaitingSave, canonicalSessionRecap — sliced from the built bundle) and
// the REAL Workout Sheet (workoutSheet.buildSheetCards) from ONE session state, on a
// scenario that stresses the historical failures together: DUPLICATE planned names +
// a SUBSTITUTED slot (identity retained). Every surface must agree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

let WS, SEL, AS;
test.before(async () => {
  WS = await import('../src/app/workoutSheet.js');
  SEL = await import('../src/app/planSlotStatuses.js');
  AS = await import('../src/app/activeSession.js');
});

// Slice the real remaining/closeout/next-up cluster + the canonical recap out of the
// built bundle and eval them with the store shim + injected selector helpers, exactly
// as the other app.js slice-harness tests do.
function loadSurfaceHarness() {
  const sliceRemain = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('function renderSessionPin()')
  );
  const sliceGCS = appSrc.slice(
    appSrc.indexOf('function getCanonicalSession()'),
    appSrc.indexOf('function applySessionSubstitution(')
  );
  const sliceRecap = appSrc.slice(
    appSrc.indexOf('function canonicalSessionRecap()'),
    appSrc.indexOf('// In-workout:', appSrc.indexOf('function canonicalSessionRecap()'))
  );
  assert.ok(sliceRemain.includes('function remainingPlannedExercises()'), 'slice must contain remainingPlannedExercises');
  assert.ok(sliceRemain.includes('function firstUnloggedPlannedLift()'), 'slice must contain firstUnloggedPlannedLift');
  assert.ok(sliceRemain.includes('function isPlanCloseoutAwaitingSave()'), 'slice must contain isPlanCloseoutAwaitingSave');
  assert.ok(sliceGCS.includes('function getCanonicalSession()'), 'slice must contain getCanonicalSession');
  assert.ok(sliceRecap.includes('function canonicalSessionRecap()'), 'slice must contain canonicalSessionRecap');

  const { remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function('window', 'remainingSlotNames', 'variantSatisfies', `
    ${STORE_SHIM}
    let lastIntentData = null;
    function getLocalDateString() { return '2026-07-18'; } // closeout-date helpers (defined, not exercised)
    ${sliceRemain}
    ${sliceGCS}
    ${sliceRecap}
    return {
      setActivePlannedSession: s => { activePlannedSession = s; },
      setSessionLog:           arr => { sessionLog = arr.slice(); },
      setSessionCompleted:     arr => { sessionCompleted = arr.slice(); },
      remainingPlannedExercises,
      firstUnloggedPlannedLift,
      isPlanCloseoutAwaitingSave,
      canonicalSessionRecap,
    };
  `);
  return factory({ activeSession: AS }, remainingSlotNames, variantSatisfies);
}

// Duplicate "Lat Pulldown" (pi_1, pi_3) + a substituted middle slot (pi_2 was swapped
// to Pec Deck, retaining its plan_item_id). The lifter logged the first Lat Pulldown
// and the substitute Pec Deck; the second Lat Pulldown is still to do.
function scenario(h) {
  h.setActivePlannedSession({
    accepted: true, session_id: 'S1', plan_version: 'pv_x', index: 0,
    exercises: [
      { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', liftCode: 'LAT01', plan_item_id: 'pi_1', weight: 120, reps: 10, sets: 3 },
      { name: 'Pec Deck', canonicalName: 'Pec Deck', liftCode: 'PD01', plan_item_id: 'pi_2', weight: 90, reps: 12, sets: 3 },
      { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', liftCode: 'LAT01', plan_item_id: 'pi_3', weight: 120, reps: 10, sets: 3 },
    ],
    items: [
      { plan_item_id: 'pi_1', planned_lift_code: 'LAT01', outcome: 'planned' },
      { plan_item_id: 'pi_2', planned_lift_code: 'CF01', outcome: 'substituted', performed_lift_code: 'PD01' },
      { plan_item_id: 'pi_3', planned_lift_code: 'LAT01', outcome: 'planned' },
    ],
  });
  h.setSessionLog([
    { exercise: 'Lat Pulldown', weight: 120, reps: 10, rir: 2 },
    { exercise: 'Pec Deck', weight: 90, reps: 12, rir: 1 },
  ]);
  h.setSessionCompleted(['Lat Pulldown', 'Pec Deck']);
}

test('F10 AC4: every surface reports the SAME remaining from the one selector (duplicate names + substitution)', () => {
  const h = loadSurfaceHarness();
  scenario(h);

  const plan = {
    exercises: [
      { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', liftCode: 'LAT01', plan_item_id: 'pi_1', weight: 120, reps: 10, sets: 3 },
      { name: 'Pec Deck', canonicalName: 'Pec Deck', liftCode: 'PD01', plan_item_id: 'pi_2', weight: 90, reps: 12, sets: 3 },
      { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', liftCode: 'LAT01', plan_item_id: 'pi_3', weight: 120, reps: 10, sets: 3 },
    ],
    items: [
      { plan_item_id: 'pi_1', outcome: 'planned' },
      { plan_item_id: 'pi_2', outcome: 'substituted', performed_lift_code: 'PD01' },
      { plan_item_id: 'pi_3', outcome: 'planned' },
    ],
  };
  const completed = ['Lat Pulldown', 'Pec Deck'];

  // 1) The selector itself: pi_1 + pi_2 done, pi_3 (the SECOND Lat Pulldown) pending.
  const statuses = SEL.planSlotStatuses(plan, completed);
  assert.deepEqual(statuses.map(s => [s.plan_item_id, s.status]),
    [['pi_1', 'completed'], ['pi_2', 'completed'], ['pi_3', 'pending']]);

  // 2) remaining / next-up / closeout (real app.js) agree with the selector.
  const remaining = h.remainingPlannedExercises();
  assert.deepEqual(remaining, ['Lat Pulldown'], 'exactly the second Lat Pulldown slot remains');
  assert.equal(h.firstUnloggedPlannedLift(), 'Lat Pulldown', 'next-up is the still-pending slot');
  assert.equal(h.isPlanCloseoutAwaitingSave(), false, 'not closeout-ready while one slot remains');

  // 3) The end-of-session recap (real app.js) reports the SAME remaining.
  const recap = h.canonicalSessionRecap();
  assert.deepEqual(recap.remaining, remaining, 'recap remaining === remainingPlannedExercises');
  assert.ok(recap.completed.includes('Lat Pulldown') && recap.completed.includes('Pec Deck'),
    'recap completed reflects the logged work (substitute included)');

  // 4) The Workout Sheet (real workoutSheet.buildSheetCards) reports the SAME per-slot
  //    status — done/done/pending — and its "current" card is exactly next-up.
  const cards = WS.buildSheetCards({ planned: plan.exercises, statuses, log: [] });
  assert.deepEqual(cards.map(c => c.status), ['done', 'done', 'current']);
  const currentCard = cards.find(c => c.status === 'current');
  assert.equal(currentCard.name, h.firstUnloggedPlannedLift(), 'the sheet current card === next-up');
  const sheetPending = cards.filter(c => c.status !== 'done').map(c => c.name);
  assert.deepEqual(sheetPending, remaining, 'sheet pending names === remainingPlannedExercises');
});
