'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// Real activeSession module — PR-08: ES module now, dynamic import (Node 20 CI
// has no require(esm)). The namespace exposes the same named functions.
let activeSession;
test.before(async () => { activeSession = await import('../src/app/activeSession.js'); });

// ---------------------------------------------------------------------------
// Harness: extract getCanonicalSession + canonicalSessionRecap from app.js
// and drive them in Node without a browser.
//
// Slices pulled from app.js:
//   slicePEE  — plannedExerciseEntries / plannedExerciseOrder / remainingPlannedExercises
//   sliceGCS  — getCanonicalSession (the insert/finisher wiring lives here)
//   sliceCSR  — canonicalSessionRecap (stops before the `let sessionLog` declarations
//               that would shadow the factory's state vars)
//
// Injected: window (carries activeSession module)
// State vars: activePlannedSession, sessionCompleted, lastIntentData, coachSuggestionEngaged
// ---------------------------------------------------------------------------
function loadInsertFinisherHarness() {
  const slicePEE = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('function isPlanCloseoutAwaitingSave()')
  );
  const sliceGCS = appSrc.slice(
    appSrc.indexOf('function getCanonicalSession()'),
    appSrc.indexOf('function applySessionSubstitution(')
  );
  // Stop before `// In-workout:` so the `let sessionLog/sessionCompleted` variable
  // declarations that follow don't shadow the factory's own state vars.
  const sliceCSR = appSrc.slice(
    appSrc.indexOf('function canonicalSessionRecap()'),
    appSrc.indexOf('// In-workout:', appSrc.indexOf('function canonicalSessionRecap()'))
  );

  assert.ok(slicePEE.includes('plannedExerciseEntries'), 'slicePEE must contain plannedExerciseEntries');
  assert.ok(sliceGCS.includes('getCanonicalSession'),    'sliceGCS must contain getCanonicalSession');
  assert.ok(sliceCSR.includes('canonicalSessionRecap'),  'sliceCSR must contain canonicalSessionRecap');

  // F10: canonicalSessionRecap → remainingPlannedExercises → remainingSlotNames.
  // F10S1: getCanonicalSession replays completions through planSlotStatuses.
  const { planSlotStatuses, remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function('window', 'planSlotStatuses', 'remainingSlotNames', 'variantSatisfies', `
    ${STORE_SHIM}
    let lastIntentData = null;

    ${slicePEE}
    ${sliceGCS}
    ${sliceCSR}

    return {
      setActivePlannedSession: s => { activePlannedSession = s ? JSON.parse(JSON.stringify(s)) : null; },
      setSessionCompleted:     arr => { sessionCompleted = arr.slice(); },
      getCanonicalSession,
      canonicalSessionRecap,
    };
  `);

  const fakeWindow = { activeSession };
  return factory(fakeWindow, planSlotStatuses, remainingSlotNames, variantSatisfies);
}

// ===========================================================================
// Behavioral tests
// ===========================================================================

// 1. Off-plan exercise in sessionCompleted gets source:'inserted' in the canonical session
test('Insert wiring: off-plan exercise in sessionCompleted gets source:inserted', () => {
  const h = loadInsertFinisherHarness();
  h.setActivePlannedSession({ exercises: [
    { name: 'Deadlift',    canonicalName: 'Deadlift',    liftCode: 'DL01'  },
    { name: 'Bench Press', canonicalName: 'Bench Press', liftCode: 'BEN01' },
  ]});
  h.setSessionCompleted(['Deadlift', 'Bench Press', 'Hammer Curls']);

  const s = h.getCanonicalSession();
  assert.ok(s, 'canonical session must not be null');

  const completed = activeSession.completedExercises(s);
  const inserted = completed.find(e => e.name === 'Hammer Curls');
  assert.ok(inserted, 'Hammer Curls must appear in completedExercises');
  assert.equal(inserted.source, 'inserted', 'off-plan exercise must have source:inserted');
});

// 2. Planned exercises do NOT get source:'inserted'
test('Insert wiring: planned exercises do not get source:inserted', () => {
  const h = loadInsertFinisherHarness();
  h.setActivePlannedSession({ exercises: [
    { name: 'Squat', canonicalName: 'Squat', liftCode: 'SQ01' },
  ]});
  h.setSessionCompleted(['Squat']);

  const s = h.getCanonicalSession();
  const completed = activeSession.completedExercises(s);
  const sq = completed.find(e => e.name === 'Squat');
  assert.ok(sq, 'Squat must be in completedExercises');
  assert.notEqual(sq.source, 'inserted', 'planned exercise must not have source:inserted');
});

// 3. canonicalSessionRecap includes inserted finisher in completed[]
test('Insert wiring: canonicalSessionRecap includes inserted finisher in completed', () => {
  const h = loadInsertFinisherHarness();
  h.setActivePlannedSession({ exercises: [
    { name: 'Deadlift', canonicalName: 'Deadlift', liftCode: 'DL01' },
  ]});
  h.setSessionCompleted(['Deadlift', 'Knee Raises']);

  const recap = h.canonicalSessionRecap();
  assert.ok(recap, 'recap must not be null');
  assert.ok(recap.completed.includes('Deadlift'),   'Deadlift in completed');
  assert.ok(recap.completed.includes('Knee Raises'), 'Knee Raises (off-plan finisher) in completed');
});

// 4. All-skipped session (empty sessionCompleted) → canonicalSessionRecap returns null
test('Insert wiring: all-skipped session → canonicalSessionRecap returns null', () => {
  const h = loadInsertFinisherHarness();
  h.setActivePlannedSession({ exercises: [
    { name: 'Squat',    canonicalName: 'Squat',    liftCode: 'SQ01' },
    { name: 'Deadlift', canonicalName: 'Deadlift', liftCode: 'DL01' },
  ]});
  // sessionCompleted stays empty — nothing was logged

  const recap = h.canonicalSessionRecap();
  assert.equal(recap, null, 'all-skipped session must return null from canonicalSessionRecap');
});

// 5. Fully-modified session recap: correct completed/remaining split
test('Insert wiring: fully-modified session recap shows correct completed and remaining', () => {
  const h = loadInsertFinisherHarness();
  h.setActivePlannedSession({ exercises: [
    { name: 'Squat',       canonicalName: 'Squat',       liftCode: 'SQ01'  },
    { name: 'Bench Press', canonicalName: 'Bench Press', liftCode: 'BEN01' },
    { name: 'Deadlift',    canonicalName: 'Deadlift',    liftCode: 'DL01'  },
  ]});
  // Logged Squat and Deadlift (skipped Bench Press); added off-plan Hammer Curls
  h.setSessionCompleted(['Squat', 'Deadlift', 'Hammer Curls']);

  const recap = h.canonicalSessionRecap();
  assert.ok(recap, 'recap must not be null');
  assert.ok(recap.completed.includes('Squat'),        'Squat in completed');
  assert.ok(recap.completed.includes('Deadlift'),     'Deadlift in completed');
  assert.ok(recap.completed.includes('Hammer Curls'), 'off-plan Hammer Curls in completed');
  assert.ok(recap.remaining.includes('Bench Press'),  'skipped Bench Press in remaining');
  assert.ok(!recap.completed.includes('Bench Press'), 'Bench Press not in completed');
});

// 6. Freestyle session (no plan, only off-plan work) → recap shows all in completed, none remaining
test('Insert wiring: freestyle session with no plan → all logged in completed, none remaining', () => {
  const h = loadInsertFinisherHarness();
  // No planned session set — activePlannedSession stays null
  h.setSessionCompleted(['Cable Row', 'Lat Pulldown']);

  const recap = h.canonicalSessionRecap();
  assert.ok(recap, 'recap must not be null for freestyle session');
  assert.ok(recap.completed.includes('Cable Row'),    'Cable Row in completed');
  assert.ok(recap.completed.includes('Lat Pulldown'), 'Lat Pulldown in completed');
  assert.equal(recap.remaining.length, 0, 'no remaining for freestyle session');
});

// 7. No plan and no completed → getCanonicalSession returns null
test('Insert wiring: no plan and no completed → getCanonicalSession returns null', () => {
  const h = loadInsertFinisherHarness();
  const s = h.getCanonicalSession();
  assert.equal(s, null, 'must return null when nothing is active');
});

// 8. Multiple off-plan inserts all appear in recap
test('Insert wiring: multiple off-plan inserts all appear in canonicalSessionRecap.completed', () => {
  const h = loadInsertFinisherHarness();
  h.setActivePlannedSession({ exercises: [
    { name: 'Squat', canonicalName: 'Squat', liftCode: 'SQ01' },
  ]});
  h.setSessionCompleted(['Squat', 'Hammer Curls', 'Knee Raises', 'Face Pulls']);

  const recap = h.canonicalSessionRecap();
  assert.ok(recap, 'recap must not be null');
  assert.ok(recap.completed.includes('Squat'),        'Squat in completed');
  assert.ok(recap.completed.includes('Hammer Curls'), 'Hammer Curls in completed');
  assert.ok(recap.completed.includes('Knee Raises'),  'Knee Raises in completed');
  assert.ok(recap.completed.includes('Face Pulls'),   'Face Pulls in completed');
  assert.equal(recap.remaining.length, 0, 'no remaining after all exercises completed');
});

// 9. Source introspection — getCanonicalSession must never call a write path
test('Insert wiring (source): getCanonicalSession never touches the write path', () => {
  const start = appSrc.indexOf('function getCanonicalSession()');
  const end   = appSrc.indexOf('function applySessionSubstitution(');
  const fnSrc = appSrc.slice(start, end);
  assert.ok(fnSrc.length > 0, 'function must be found');
  assert.ok(!fnSrc.includes('fetch('),            'must not call fetch()');
  assert.ok(!fnSrc.includes('writeLog'),           'must not call writeLog');
  assert.ok(!fnSrc.includes('/api/log-workout'),   'must not reference log-workout endpoint');
  assert.ok(!fnSrc.includes('sheet_write'),        'must not reference sheet_write proof field');
});

// 10. Source introspection — canonicalSessionRecap must not mutate plan/session state
test('Insert wiring (source): canonicalSessionRecap does not mutate plan or session state', () => {
  const start  = appSrc.indexOf('function canonicalSessionRecap()');
  // Use '// In-workout:' to scope tightly to the function body only — the variable
  // declarations that follow (let sessionLog, let sessionCompleted, …) are not
  // part of canonicalSessionRecap and must not be included in the check.
  const end    = appSrc.indexOf('// In-workout:', start);
  const fnSrc  = appSrc.slice(start, end);
  assert.ok(fnSrc.length > 0, 'function must be found');
  assert.ok(!fnSrc.includes('sessionLog ='),           'must not assign sessionLog');
  assert.ok(!fnSrc.includes('sessionCompleted ='),     'must not assign sessionCompleted');
  assert.ok(!fnSrc.includes('activePlannedSession ='), 'must not assign activePlannedSession');
  assert.ok(!fnSrc.includes('fetch('),                 'must not call fetch()');
});
