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
let AS;
test.before(async () => { AS = await import('../src/app/activeSession.js'); });

// ===========================================================================
// P0-PR7 — End-to-end regression (AC10 full path)
//
// Exercises ALL five mutation operations in sequence on the same session,
// then verifies the canonical session + recap that the save path would see.
//
// Scenario:
//   Coach's Pick plan: [Deadlift, Overhead Press, Pull-Ups]
//
//   1. replaceExercise:   Deadlift → Back Squat        (AC 2)
//   2. markCompleted:     Back Squat done               (AC 5)
//   3. markCompleted:     Overhead Press done           (AC 6)
//   4. markCompleted:     Pull-Ups done (will be fixed) (AC 7 pre-correction)
//   5. correctIdentity:   Pull-Ups → Lat Pulldown       (AC 7)
//   6. insertExercise +
//      markCompleted:     Hammer Curls inserted         (AC 8)
//   7. insertExercise +
//      markCompleted:     Knee Raises inserted          (AC 9)
//
// Layer 1 — pure activeSession.js: confirms final session object state.
// Layer 2 — getCanonicalSession + canonicalSessionRecap: confirms the
//   plan+log state the real app arrives at produces a correct canonical
//   session and recap (the data the save path consumes — AC 10).
// ===========================================================================

// ---------------------------------------------------------------------------
// Layer 1 helper
// ---------------------------------------------------------------------------
function buildE2ESession() {
  let s = AS.createActiveSession({ exercises: [
    { name: 'Deadlift',        liftCode: 'DL01'  },
    { name: 'Overhead Press',  liftCode: 'OHP01' },
    { name: 'Pull-Ups',        liftCode: 'PU01'  },
  ]});
  s = AS.replaceExercise(s, 'Deadlift', { name: 'Back Squat', liftCode: 'SQ01' });
  s = AS.markCompleted(s, 'Back Squat');
  s = AS.markCompleted(s, 'Overhead Press');
  s = AS.markCompleted(s, 'Pull-Ups');
  s = AS.correctIdentity(s, { from: 'Pull-Ups', to: 'Lat Pulldown' });
  s = AS.insertExercise(s, { name: 'Hammer Curls', liftCode: 'HC01' });
  s = AS.markCompleted(s, 'Hammer Curls');
  s = AS.insertExercise(s, { name: 'Knee Raises', liftCode: 'KR01' });
  s = AS.markCompleted(s, 'Knee Raises');
  return s;
}

// ---------------------------------------------------------------------------
// Layer 2 helper
// Same harness pattern as insertFinisherWiring.test.js — extracts
// getCanonicalSession + canonicalSessionRecap from app.js slices and drives
// them in Node without a browser.
// ---------------------------------------------------------------------------
function loadE2EHarness() {
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

  // F10: canonicalSessionRecap → remainingPlannedExercises → remainingSlotNames (the
  // authoritative slot selector). Inject its pure implementation into the harness.
  const { remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function('window', 'remainingSlotNames', 'variantSatisfies', `
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

  return factory({ activeSession: AS }, remainingSlotNames, variantSatisfies);
}

// Layer 2 setup — mirrors the real app state after all session mutations:
//   activePlannedSession.exercises = [Back Squat, OHP, Pull-Ups]
//     (Deadlift was swapped out by applySessionSubstitution)
//   sessionCompleted = ['Back Squat', 'Overhead Press', 'Lat Pulldown', 'Hammer Curls', 'Knee Raises']
//     (tryApplyIdentityCorrection replaced 'Pull-Ups' with 'Lat Pulldown')
function setupE2EHarness(h) {
  h.setActivePlannedSession({ exercises: [
    { name: 'Back Squat',     canonicalName: 'Back Squat',     liftCode: 'SQ01'  },
    { name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01' },
    { name: 'Pull-Ups',       canonicalName: 'Pull-Ups',       liftCode: 'PU01'  },
  ]});
  h.setSessionCompleted(['Back Squat', 'Overhead Press', 'Lat Pulldown', 'Hammer Curls', 'Knee Raises']);
}

// ===========================================================================
// Layer 1 — pure activeSession.js operations chain
// ===========================================================================

test('E2E (L1): substitute replaces Deadlift slot with Back Squat at position 0', () => {
  const s = buildE2ESession();
  assert.equal(s.exercises[0].name,   'Back Squat',   'slot 0 is Back Squat');
  assert.equal(s.exercises[0].source, 'substituted',  'Back Squat source is substituted');
  assert.equal(s.exercises[0].status, 'completed',    'Back Squat is completed');
});

test('E2E (L1): Deadlift not present in exercises after substitute', () => {
  const s = buildE2ESession();
  assert.equal(s.exercises.find(e => e.name === 'Deadlift'), undefined,
    'Deadlift removed from session after substitute');
});

test('E2E (L1): OHP stays planned and is completed', () => {
  const s = buildE2ESession();
  const ohp = s.exercises.find(e => e.name === 'Overhead Press');
  assert.ok(ohp, 'OHP must be in exercises');
  assert.equal(ohp.source, 'planned',   'OHP source is planned');
  assert.equal(ohp.status, 'completed', 'OHP is completed');
});

test('E2E (L1): identity correction renames Pull-Ups → Lat Pulldown in-place', () => {
  const s = buildE2ESession();
  assert.equal(s.exercises.find(e => e.name === 'Pull-Ups'), undefined,
    'Pull-Ups not present after correction');
  const latPull = s.exercises.find(e => e.name === 'Lat Pulldown');
  assert.ok(latPull, 'Lat Pulldown must be in exercises after correction');
  assert.equal(latPull.status, 'completed', 'Lat Pulldown is completed');
  assert.equal(latPull.source, 'planned',   'Lat Pulldown retains source:planned (relabeled in-place)');
});

test('E2E (L1): inserted finishers have source:inserted and are completed', () => {
  const s = buildE2ESession();
  const hc = s.exercises.find(e => e.name === 'Hammer Curls');
  const kr = s.exercises.find(e => e.name === 'Knee Raises');
  assert.ok(hc, 'Hammer Curls must be in exercises');
  assert.ok(kr, 'Knee Raises must be in exercises');
  assert.equal(hc.source, 'inserted',  'Hammer Curls source is inserted');
  assert.equal(kr.source, 'inserted',  'Knee Raises source is inserted');
  assert.equal(hc.status, 'completed', 'Hammer Curls is completed');
  assert.equal(kr.status, 'completed', 'Knee Raises is completed');
});

test('E2E (L1): no remaining after full session — isComplete and hasLoggedWork true', () => {
  const s = buildE2ESession();
  assert.equal(AS.remaining(s).length, 0,    'no remaining');
  assert.equal(AS.isComplete(s),       true,  'isComplete is true');
  assert.equal(AS.hasLoggedWork(s),    true,  'hasLoggedWork is true');
});

test('E2E (L1): completedExercises returns exactly the 5 logged entries', () => {
  const s = buildE2ESession();
  const completed = AS.completedExercises(s);
  assert.equal(completed.length, 5, '5 completed entries — Back Squat, OHP, Lat Pulldown, Hammer Curls, Knee Raises');
  const names = completed.map(e => e.name);
  assert.ok(names.includes('Back Squat'),      'Back Squat in completed');
  assert.ok(names.includes('Overhead Press'),  'OHP in completed');
  assert.ok(names.includes('Lat Pulldown'),    'Lat Pulldown (corrected from Pull-Ups) in completed');
  assert.ok(names.includes('Hammer Curls'),    'Hammer Curls in completed');
  assert.ok(names.includes('Knee Raises'),     'Knee Raises in completed');
  assert.ok(!names.includes('Deadlift'),       'Deadlift not in completed (substituted out)');
  assert.ok(!names.includes('Pull-Ups'),       'Pull-Ups not in completed (corrected to Lat Pulldown)');
});

// ===========================================================================
// Layer 2 — getCanonicalSession + canonicalSessionRecap
// (mirrors the real app's plan+log state after all mutations)
//
// After identity correction, sessionCompleted has 'Lat Pulldown' but the plan
// still has 'Pull-Ups'. getCanonicalSession() treats 'Lat Pulldown' as an
// off-plan insert (no substring overlap with 'Pull-Ups') and leaves 'Pull-Ups'
// pending → it appears in remaining. The save path sees 5 completed exercises;
// no phantom data; no crash. (AC 10.)
// ===========================================================================

test('E2E (L2): getCanonicalSession — planned lifts completed, off-plan inserts present', () => {
  const h = loadE2EHarness();
  setupE2EHarness(h);
  const s = h.getCanonicalSession();
  assert.ok(s, 'canonical session must not be null');

  const names = AS.completedExercises(s).map(e => e.name);
  assert.ok(names.includes('Back Squat'),     'Back Squat completed in canonical session');
  assert.ok(names.includes('Overhead Press'), 'OHP completed in canonical session');
  assert.ok(names.includes('Lat Pulldown'),   'Lat Pulldown inserted+completed');
  assert.ok(names.includes('Hammer Curls'),   'Hammer Curls inserted+completed');
  assert.ok(names.includes('Knee Raises'),    'Knee Raises inserted+completed');
});

test('E2E (L2): off-plan entries in canonical session have source:inserted', () => {
  const h = loadE2EHarness();
  setupE2EHarness(h);
  const s = h.getCanonicalSession();
  const completed = AS.completedExercises(s);

  const latPull = completed.find(e => e.name === 'Lat Pulldown');
  const hammerC = completed.find(e => e.name === 'Hammer Curls');
  const kneeR   = completed.find(e => e.name === 'Knee Raises');
  assert.ok(latPull,  'Lat Pulldown found in completed');
  assert.ok(hammerC,  'Hammer Curls found in completed');
  assert.ok(kneeR,    'Knee Raises found in completed');
  assert.equal(latPull.source, 'inserted', 'Lat Pulldown source:inserted');
  assert.equal(hammerC.source, 'inserted', 'Hammer Curls source:inserted');
  assert.equal(kneeR.source,   'inserted', 'Knee Raises source:inserted');
});

test('E2E (L2): canonicalSessionRecap — completed includes all 5 logged exercises', () => {
  const h = loadE2EHarness();
  setupE2EHarness(h);
  const recap = h.canonicalSessionRecap();
  assert.ok(recap, 'recap must not be null');
  assert.ok(recap.completed.includes('Back Squat'),     'Back Squat in recap.completed');
  assert.ok(recap.completed.includes('Overhead Press'), 'OHP in recap.completed');
  assert.ok(recap.completed.includes('Lat Pulldown'),   'Lat Pulldown (corrected) in recap.completed');
  assert.ok(recap.completed.includes('Hammer Curls'),   'Hammer Curls in recap.completed');
  assert.ok(recap.completed.includes('Knee Raises'),    'Knee Raises in recap.completed');
  assert.ok(!recap.completed.includes('Deadlift'),      'Deadlift not in completed');
  assert.ok(!recap.completed.includes('Pull-Ups'),      'Pull-Ups not in completed (log name was corrected)');
});

test('E2E (L2): canonicalSessionRecap — Pull-Ups planned slot appears in remaining', () => {
  const h = loadE2EHarness();
  setupE2EHarness(h);
  const recap = h.canonicalSessionRecap();
  assert.ok(recap, 'recap must not be null');
  // The Pull-Ups SLOT was planned but never matched by that name in sessionCompleted
  // (the log was corrected to 'Lat Pulldown', which shares no substring with 'Pull-Ups').
  // Pull-Ups therefore stays pending → appears in remaining. The save path sees 5
  // completed entries without phantom duplicates.
  assert.ok(recap.remaining.includes('Pull-Ups'),
    'Pull-Ups in remaining (planned slot not matched by corrected log name)');
});

// ===========================================================================
// Source introspection — write-path safety
// ===========================================================================

test('E2E (source): getCanonicalSession never touches the write path', () => {
  const start = appSrc.indexOf('function getCanonicalSession()');
  const end   = appSrc.indexOf('function applySessionSubstitution(');
  const fnSrc = appSrc.slice(start, end);
  assert.ok(fnSrc.length > 0, 'function must be found');
  assert.ok(!fnSrc.includes('fetch('),          'must not call fetch()');
  assert.ok(!fnSrc.includes('writeLog'),         'must not call writeLog');
  assert.ok(!fnSrc.includes('/api/log-workout'), 'must not reference log-workout endpoint');
  assert.ok(!fnSrc.includes('sheet_write'),      'must not reference sheet_write proof field');
});

test('E2E (source): canonicalSessionRecap does not mutate plan or session state', () => {
  const start = appSrc.indexOf('function canonicalSessionRecap()');
  const end   = appSrc.indexOf('// In-workout:', start);
  const fnSrc = appSrc.slice(start, end);
  assert.ok(fnSrc.length > 0, 'function must be found');
  assert.ok(!fnSrc.includes('sessionLog ='),           'must not assign sessionLog');
  assert.ok(!fnSrc.includes('sessionCompleted ='),     'must not assign sessionCompleted');
  assert.ok(!fnSrc.includes('activePlannedSession ='), 'must not assign activePlannedSession');
  assert.ok(!fnSrc.includes('fetch('),                 'must not call fetch()');
});
