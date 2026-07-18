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

  // F10S1: getCanonicalSession replays completions through planSlotStatuses itself.
  const { planSlotStatuses, remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function('window', 'planSlotStatuses', 'remainingSlotNames', 'variantSatisfies', `
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
  return factory({ activeSession: AS }, planSlotStatuses, remainingSlotNames, variantSatisfies);
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
  // F10S1: the slots prescribe 3 sets each, so the log carries the FULL 3 sets per
  // lift — completion now requires the count, not merely an attributed name.
  h.setSessionLog([
    { exercise: 'Lat Pulldown', weight: 120, reps: 10, rir: 2 },
    { exercise: 'Lat Pulldown', weight: 120, reps: 10, rir: 2 },
    { exercise: 'Lat Pulldown', weight: 120, reps: 9, rir: 1 },
    { exercise: 'Pec Deck', weight: 90, reps: 12, rir: 1 },
    { exercise: 'Pec Deck', weight: 90, reps: 12, rir: 1 },
    { exercise: 'Pec Deck', weight: 90, reps: 11, rir: 1 },
  ]);
  h.setSessionCompleted(['Lat Pulldown', 'Pec Deck']);
}

const SCENARIO_LOG = [
  { exercise: 'Lat Pulldown', weight: 120, reps: 10, rir: 2 },
  { exercise: 'Lat Pulldown', weight: 120, reps: 10, rir: 2 },
  { exercise: 'Lat Pulldown', weight: 120, reps: 9, rir: 1 },
  { exercise: 'Pec Deck', weight: 90, reps: 12, rir: 1 },
  { exercise: 'Pec Deck', weight: 90, reps: 12, rir: 1 },
  { exercise: 'Pec Deck', weight: 90, reps: 11, rir: 1 },
];

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

  // 1) The selector itself (same inputs as the surfaces, incl. the per-set log —
  //    F10S1): pi_1 + pi_2 done at their full set counts, pi_3 (the SECOND Lat
  //    Pulldown) pending.
  const statuses = SEL.planSlotStatuses(plan, completed, SCENARIO_LOG);
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

test('F10S1 SMOKE REPRODUCE: one set of a 3-set slot leaves it IN PROGRESS on every surface (rail, next-up, recap, handoff)', () => {
  const h = loadSurfaceHarness();
  h.setActivePlannedSession({
    accepted: true, session_id: 'S1', plan_version: 'pv_x', index: 0,
    exercises: [
      { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', weight: 245, reps: 6, sets: 3 },
      { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'BSQ01', plan_item_id: 'pi_bsq', weight: 225, reps: 5, sets: 3 },
    ],
    items: [
      { plan_item_id: 'pi_rdl', planned_lift_code: 'RDL01', outcome: 'planned' },
      { plan_item_id: 'pi_bsq', planned_lift_code: 'BSQ01', outcome: 'planned' },
    ],
  });
  const oneSet = [{ exercise: 'Romanian Deadlift', weight: 245, reps: 6, rir: 3 }];
  h.setSessionLog(oneSet);
  h.setSessionCompleted(['Romanian Deadlift']);

  const plan = {
    exercises: [
      { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', sets: 3 },
      { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'BSQ01', plan_item_id: 'pi_bsq', sets: 3 },
    ],
  };
  // The selector: RDL is attributed but IN PROGRESS (1 of 3), never completed.
  const statuses = SEL.planSlotStatuses(plan, ['Romanian Deadlift'], oneSet);
  assert.equal(statuses[0].status, 'pending');
  assert.equal(statuses[0].performedSets, 1);
  assert.equal(statuses[0].requiredSets, 3);

  // Real app.js surfaces agree — RDL stays remaining and IS next-up (the handoff/
  // closeout guards see an unfinished plan).
  assert.deepEqual(h.remainingPlannedExercises(), ['Romanian Deadlift', 'Back Squat']);
  assert.equal(h.firstUnloggedPlannedLift(), 'Romanian Deadlift');
  assert.equal(h.isPlanCloseoutAwaitingSave(), false);
  const recap = h.canonicalSessionRecap();
  assert.ok(!recap.completed.includes('Romanian Deadlift'), 'recap does NOT report the in-progress lift as completed');
  assert.deepEqual(recap.remaining, ['Romanian Deadlift', 'Back Squat'], 'recap remaining matches the selector');

  // The rail: the in-progress slot renders as the CURRENT card with the set counter.
  const cards = WS.buildSheetCards({ planned: plan.exercises, statuses, log: oneSet });
  assert.deepEqual(cards.map(c => c.status), ['current', 'pending'], 'no card is done after one of three sets');
  assert.match(WS.cardDetailText(cards[0]), /set 2\/3/, 'the current card shows the in-progress set counter');
});

test('F10S1: log-one-set-then-Done never duplicates the lift in the canonical session/recap (Codex P2)', () => {
  const h = loadSurfaceHarness();
  h.setActivePlannedSession({
    accepted: true, session_id: 'S1', plan_version: 'pv_x', index: 0,
    exercises: [
      { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', sets: 3 },
      { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'BSQ01', plan_item_id: 'pi_bsq', sets: 3 },
    ],
    // The athlete logged one set, then tapped Done — the explicit id lane completes it.
    items: [
      { plan_item_id: 'pi_rdl', planned_lift_code: 'RDL01', outcome: 'completed' },
      { plan_item_id: 'pi_bsq', planned_lift_code: 'BSQ01', outcome: 'planned' },
    ],
  });
  h.setSessionLog([{ exercise: 'Romanian Deadlift', weight: 245, reps: 6, rir: 3 }]);
  h.setSessionCompleted(['Romanian Deadlift']);

  const recap = h.canonicalSessionRecap();
  const rdlCount = recap.completed.filter(n => n === 'Romanian Deadlift').length;
  assert.equal(rdlCount, 1, 'the explicitly-Done planned lift appears exactly ONCE (no off-plan duplicate)');
  assert.deepEqual(recap.remaining, ['Back Squat'], 'only the untouched slot remains');
});

test('F10S1: the rail counter counts alias rows via their stamped canonical identity (Codex P2)', () => {
  // Raw alias rows ("RDL") carry canonical "Romanian Deadlift" from emitSetLogged; the
  // rail card's set counter must tick on them exactly as the completion selector does.
  const aliasLog = [
    { exercise: 'RDL', canonical: 'Romanian Deadlift', weight: 245, reps: 6, rir: 3 },
    { exercise: 'RDL', canonical: 'Romanian Deadlift', weight: 245, reps: 6, rir: 3 },
  ];
  const plan = { exercises: [{ name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', sets: 3 }] };
  const statuses = SEL.planSlotStatuses(plan, ['Romanian Deadlift'], aliasLog);
  assert.equal(statuses[0].status, 'pending');
  assert.equal(statuses[0].performedSets, 2, 'the selector counts the alias rows');
  const cards = WS.buildSheetCards({ planned: plan.exercises, statuses, log: aliasLog });
  assert.equal(cards[0].logged.count, 2, 'the rail counts the same rows');
  assert.match(WS.cardDetailText(cards[0]), /set 3\/3/, 'the counter reflects 2 done, 3rd up');
});
