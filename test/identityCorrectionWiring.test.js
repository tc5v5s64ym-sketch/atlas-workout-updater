'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// Real identityCorrection module — UMD exports cleanly under Node
const identityCorrection = require(path.join(repoRoot, 'public', 'identityCorrection.js'));

// Node has no CustomEvent; provide a minimal stand-in
class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

// ---------------------------------------------------------------------------
// Harness: extract tryApplyIdentityCorrection + its dependencies from app.js
// so we can drive them in Node without a browser.
//
// Slices pulled from app.js (all pure function declarations):
//   slicePEE  — plannedExerciseEntries / plannedExerciseOrder / remainingPlannedExercises
//   sliceLC   — liftCodeFromCatalog / firstUnloggedPlannedLift / currentPlannedExercise /
//               buildRowsFromSessionLog / resolveCompletedIdentity
//   sliceRCE  — resolveCatalogExercise
//   sliceTAIC — tryApplyIdentityCorrection / announceIdentityCorrection
//
// Injected: document (fake, with exercise-catalog options), window (fake, carries
// identityCorrection), CustomEvent (FakeCustomEvent above).
// Stubbed:  renderActiveSessionBanner (DOM renderer, not under test),
//           getCanonicalSession (needs window.activeSession — unused in this path).
// ---------------------------------------------------------------------------
function loadCorrectionHarness(catalogOptions) {
  const slicePEE = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('function isPlanCloseoutAwaitingSave()')
  );
  const sliceLC = appSrc.slice(
    appSrc.indexOf('function liftCodeFromCatalog('),
    appSrc.indexOf('function emitSetLogged(')
  );
  const sliceRCE = appSrc.slice(
    appSrc.indexOf('function resolveCatalogExercise('),
    appSrc.indexOf('function skipPlannedExercise(')
  );
  const sliceTAIC = appSrc.slice(
    appSrc.indexOf('// ── P0 PR 4:'),
    appSrc.indexOf('function renderActiveSessionBanner(')
  );

  assert.ok(slicePEE.includes('plannedExerciseEntries'), 'slicePEE must contain plannedExerciseEntries');
  assert.ok(sliceLC.includes('resolveCompletedIdentity'), 'sliceLC must contain resolveCompletedIdentity');
  assert.ok(sliceRCE.includes('resolveCatalogExercise'), 'sliceRCE must contain resolveCatalogExercise');
  assert.ok(sliceTAIC.includes('tryApplyIdentityCorrection'), 'sliceTAIC must contain tryApplyIdentityCorrection');

  const events = [];

  // Catalog options: array of [value (canonical name), label (lift_code)]
  const fakeOpts = (catalogOptions || []).map(([value, label]) => ({ value, label }));
  const fakeCatalog = { options: fakeOpts };
  const fakeBanner = { hidden: false, innerHTML: '', appendChild: () => {} };
  const fakeDoc = {
    getElementById: id =>
      id === 'exercise-catalog' ? fakeCatalog :
      id === 'active-session-banner' ? fakeBanner : null,
    dispatchEvent: evt => events.push(evt),
  };
  const fakeWindow = { identityCorrection };

  // Pass events array as a parameter so the factory body can access it
  // (new Function creates an isolated scope; outer-closure vars are not reachable).
  const factory = new Function('document', 'window', 'CustomEvent', 'events', `
    // State vars mirroring app.js outer scope
    let activePlannedSession = null;
    let lastIntentData = null;
    let coachSuggestionEngaged = false;
    let sessionLog = [];
    let sessionCompleted = [];
    let pendingSubstitution = null;

    // Stubs for functions outside the slices that are referenced by code in sliceLC
    // but not exercised by tryApplyIdentityCorrection's actual call path.
    function getCanonicalSession() { return null; }
    function renderActiveSessionBanner() {}

    ${slicePEE}
    ${sliceLC}
    ${sliceRCE}
    ${sliceTAIC}

    return {
      setSessionLog:      log  => { sessionLog      = log.map(e => Object.assign({}, e)); },
      getSessionLog:      ()   => sessionLog.map(e => Object.assign({}, e)),
      setSessionCompleted: arr => { sessionCompleted = arr.slice(); },
      getSessionCompleted: ()  => sessionCompleted.slice(),
      setActivePlannedSession: s => { activePlannedSession = s; },
      tryApplyIdentityCorrection,
      getEvents: () => events.slice(),
    };
  `);

  return factory(fakeDoc, fakeWindow, FakeCustomEvent, events);
}

// ===========================================================================
// Behavioral tests — drive tryApplyIdentityCorrection and inspect mutations
// ===========================================================================

// 1. Basic relabel: trailing run of the mis-logged exercise is renamed
test('IC wiring: "sorry that was lat pulldown" relabels all trailing sessionLog entries', () => {
  const h = loadCorrectionHarness([
    ['Lat Pulldown', 'LAT01'],
    ['Deadlift',     'DL01'],
  ]);
  h.setSessionLog([
    { exercise: 'Deadlift', weight: '315', reps: '5', rir: '2' },
    { exercise: 'Deadlift', weight: '315', reps: '4', rir: '3' },
  ]);
  h.setSessionCompleted(['Deadlift']);

  const result = h.tryApplyIdentityCorrection('sorry that was lat pulldown');

  assert.equal(result, true, 'must return true');
  const log = h.getSessionLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].exercise, 'Lat Pulldown', 'first set relabeled');
  assert.equal(log[1].exercise, 'Lat Pulldown', 'second set relabeled');
});

// 2. sessionCompleted reflects the correction — stale name removed, new name added
test('IC wiring: sessionCompleted drops stale name and adds corrected name', () => {
  const h = loadCorrectionHarness([
    ['Squat', 'SQ01'],
    ['Leg Press', 'LP01'],
  ]);
  h.setSessionLog([
    { exercise: 'Leg Press', weight: '200', reps: '10', rir: '2' },
  ]);
  h.setSessionCompleted(['Leg Press']);

  h.tryApplyIdentityCorrection('actually that was squats');

  const completed = h.getSessionCompleted();
  assert.ok(completed.includes('Squat'),     'corrected name added to sessionCompleted');
  assert.ok(!completed.includes('Leg Press'), 'stale name removed from sessionCompleted');
});

// 3. Only the trailing run is relabeled — earlier logged sets of a DIFFERENT exercise stay
test('IC wiring: only trailing run relabeled; earlier entries of different exercise stay', () => {
  const h = loadCorrectionHarness([
    ['Lat Pulldown', 'LAT01'],
    ['Deadlift',     'DL01'],
    ['Bench Press',  'BEN01'],
  ]);
  // Deadlift was logged first, then two Bench Press sets were logged last.
  h.setSessionLog([
    { exercise: 'Deadlift',    weight: '315', reps: '5', rir: '2' },
    { exercise: 'Bench Press', weight: '185', reps: '8', rir: '2' },
    { exercise: 'Bench Press', weight: '185', reps: '7', rir: '3' },
  ]);
  h.setSessionCompleted(['Deadlift', 'Bench Press']);

  const result = h.tryApplyIdentityCorrection('i meant lat pulldown');

  assert.equal(result, true);
  const log = h.getSessionLog();
  assert.equal(log[0].exercise, 'Deadlift',     'earlier Deadlift entry untouched');
  assert.equal(log[1].exercise, 'Lat Pulldown', 'first Bench set relabeled');
  assert.equal(log[2].exercise, 'Lat Pulldown', 'second Bench set relabeled');

  const completed = h.getSessionCompleted();
  assert.ok(completed.includes('Deadlift'),     'earlier exercise stays in sessionCompleted');
  assert.ok(completed.includes('Lat Pulldown'), 'corrected name in sessionCompleted');
  assert.ok(!completed.includes('Bench Press'), 'stale Bench Press removed from sessionCompleted');
});

// 4. Stale raw exercise name must not survive anywhere after correction
test('IC wiring: stale raw exercise name absent from both sessionLog and sessionCompleted', () => {
  const h = loadCorrectionHarness([
    ['Squat',             'SQ01'],
    ['Romanian Deadlift', 'RDL01'],
  ]);
  h.setSessionLog([
    { exercise: 'Romanian Deadlift', weight: '185', reps: '8', rir: '1' },
    { exercise: 'Romanian Deadlift', weight: '185', reps: '8', rir: '1' },
    { exercise: 'Romanian Deadlift', weight: '185', reps: '8', rir: '1' },
  ]);
  h.setSessionCompleted(['Romanian Deadlift']);

  h.tryApplyIdentityCorrection('sorry that was squats');

  const log = h.getSessionLog();
  const completed = h.getSessionCompleted();
  assert.ok(
    log.every(s => s.exercise !== 'Romanian Deadlift'),
    'no stale Romanian Deadlift in sessionLog'
  );
  assert.ok(!completed.includes('Romanian Deadlift'), 'no stale name in sessionCompleted');
});

// 5. atlas:identity-corrected event dispatched with correct from/to
test('IC wiring: announceIdentityCorrection dispatches atlas:identity-corrected event', () => {
  const h = loadCorrectionHarness([
    ['Squat',    'SQ01'],
    ['Deadlift', 'DL01'],
  ]);
  h.setSessionLog([{ exercise: 'Deadlift', weight: '315', reps: '5', rir: '2' }]);
  h.setSessionCompleted(['Deadlift']);

  h.tryApplyIdentityCorrection('sorry that was squats');

  const events = h.getEvents();
  assert.equal(events.length, 1, 'exactly one event dispatched');
  assert.equal(events[0].type, 'atlas:identity-corrected');
  assert.equal(events[0].detail.from, 'Deadlift', 'event.detail.from is the old name');
  assert.equal(events[0].detail.to,   'Squat',    'event.detail.to is the corrected name');
});

// 6. Catalog guard: phrase that is NOT in the catalog must fall through (return false)
test('IC wiring: phrase that is not a catalog exercise falls through (catalog guard)', () => {
  const h = loadCorrectionHarness([
    ['Lat Pulldown', 'LAT01'],
  ]);
  h.setSessionLog([{ exercise: 'Deadlift', weight: '315', reps: '5', rir: '2' }]);
  h.setSessionCompleted(['Deadlift']);

  const result = h.tryApplyIdentityCorrection('actually that was tough');

  assert.equal(result, false, 'unknown phrase must not relabel');
  assert.equal(h.getSessionLog()[0].exercise, 'Deadlift', 'sessionLog unchanged');
  assert.ok(h.getSessionCompleted().includes('Deadlift'), 'sessionCompleted unchanged');
  assert.equal(h.getEvents().length, 0, 'no event dispatched');
});

// 7. Non-correction phrasing (ordinary remark) falls through without side-effects
test('IC wiring: ordinary remark does not trigger identity correction', () => {
  const h = loadCorrectionHarness([['Squat', 'SQ01']]);
  h.setSessionLog([{ exercise: 'Deadlift', weight: '315', reps: '5', rir: '2' }]);

  const result = h.tryApplyIdentityCorrection('that was really heavy');

  assert.equal(result, false);
  assert.equal(h.getSessionLog()[0].exercise, 'Deadlift', 'sessionLog unchanged');
  assert.equal(h.getEvents().length, 0);
});

// 8. No-op when the corrected name already matches the logged name
test('IC wiring: no-op when corrected name matches the current logged exercise', () => {
  const h = loadCorrectionHarness([['Squat', 'SQ01']]);
  h.setSessionLog([{ exercise: 'Squat', weight: '225', reps: '5', rir: '2' }]);
  h.setSessionCompleted(['Squat']);

  const result = h.tryApplyIdentityCorrection('sorry that was squats');

  assert.equal(result, false, 'must return false — nothing to relabel');
  assert.equal(h.getEvents().length, 0, 'no event when name already matches');
});

// 9. Empty sessionLog — nothing to correct, must return false cleanly
test('IC wiring: empty sessionLog returns false without error', () => {
  const h = loadCorrectionHarness([['Squat', 'SQ01']]);
  // sessionLog is empty (default)

  const result = h.tryApplyIdentityCorrection('sorry that was squats');

  assert.equal(result, false);
  assert.equal(h.getEvents().length, 0);
});

// 10. Question phrasing must not trigger correction (classifyIdentityCorrection guard)
test('IC wiring: question phrasing does not trigger identity correction', () => {
  const h = loadCorrectionHarness([['Squat', 'SQ01'], ['Deadlift', 'DL01']]);
  h.setSessionLog([{ exercise: 'Deadlift', weight: '315', reps: '5', rir: '2' }]);

  const result = h.tryApplyIdentityCorrection('was that squats?');

  assert.equal(result, false, 'question must not relabel');
  assert.equal(h.getSessionLog()[0].exercise, 'Deadlift');
});

// ── "X is Y" typo tolerance (owner live find 2026-07-03) ─────────────────────

// 13. LIVE REPRO: "Sorry slslp is single leg seated leg prep" relabels the
// buffered Slslp group to the PLAN name, bridging the typo ('prep' → 'press').
test('IC wiring: typo\'d "sorry slslp is single leg seated leg prep" relabels via the plan', () => {
  const h = loadCorrectionHarness([
    ['Leg Extension', 'LE01'],
  ]);
  h.setActivePlannedSession({
    label: 'Leg day',
    exercises: [
      { name: 'Single-Leg Seated Leg Press', canonicalName: 'Single-Leg Seated Leg Press', liftCode: '' },
      { name: 'Leg Extension', canonicalName: 'Leg Extension', liftCode: 'LE01' },
    ],
    index: 0,
  });
  h.setSessionLog([
    { exercise: 'Slslp', weight: '70', reps: '15', rir: '2' },
    { exercise: 'Slslp', weight: '70', reps: '15', rir: '2' },
    { exercise: 'Slslp', weight: '70', reps: '15', rir: '2' },
    { exercise: 'Slslp', weight: '70', reps: '15', rir: '2' },
  ]);
  h.setSessionCompleted(['Slslp']);

  const result = h.tryApplyIdentityCorrection('Sorry slslp is single leg seated leg prep');

  assert.equal(result, true, 'the typo\'d correction must be handled deterministically');
  const log = h.getSessionLog();
  assert.ok(log.every(s => s.exercise === 'Single-Leg Seated Leg Press'), 'all four sets relabeled');
  const completed = h.getSessionCompleted();
  assert.ok(completed.includes('Single-Leg Seated Leg Press'), 'corrected name in sessionCompleted');
  assert.ok(!completed.includes('Slslp'), 'stale Slslp removed');
  const events = h.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.from, 'Slslp');
  assert.equal(events[0].detail.to, 'Single-Leg Seated Leg Press');
});

// 14. The from-named form relabels the WHOLE group even when later sets of a
// different lift were logged after it (the live incident's re-log shape).
test('IC wiring: "X is Y" relabels a non-trailing buffered group', () => {
  const h = loadCorrectionHarness([
    ['Single-Leg Seated Leg Press', 'SLP01'],
    ['Leg Extension', 'LE01'],
  ]);
  h.setSessionLog([
    { exercise: 'Slslp', weight: '70', reps: '15', rir: '2' },
    { exercise: 'Slslp', weight: '70', reps: '15', rir: '2' },
    { exercise: 'Leg Extension', weight: '90', reps: '12', rir: '2' },
  ]);
  h.setSessionCompleted(['Slslp', 'Leg Extension']);

  const result = h.tryApplyIdentityCorrection('slslp is single leg seated leg press');

  assert.equal(result, true);
  const log = h.getSessionLog();
  assert.equal(log[0].exercise, 'Single-Leg Seated Leg Press', 'first buffered set relabeled');
  assert.equal(log[1].exercise, 'Single-Leg Seated Leg Press', 'second buffered set relabeled');
  assert.equal(log[2].exercise, 'Leg Extension', 'the other lift is untouched');
});

// 15. "X is Y" where X is NOT a buffered lift must fall through untouched — an
// ordinary statement is not a correction just because it contains "is".
test('IC wiring: "X is Y" with an unknown X falls through', () => {
  const h = loadCorrectionHarness([
    ['Bicep Curl', 'BC01'],
  ]);
  h.setSessionLog([{ exercise: 'Squat', weight: '225', reps: '5', rir: '2' }]);
  h.setSessionCompleted(['Squat']);

  const result = h.tryApplyIdentityCorrection('curls is bicep curl');

  assert.equal(result, false, 'X not in the buffer → not an identity correction');
  assert.equal(h.getSessionLog()[0].exercise, 'Squat', 'sessionLog unchanged');
  assert.equal(h.getEvents().length, 0, 'no event dispatched');
});

// 16. Ambiguity refusal: a correction phrase word-subset-matching TWO plan slots
// relabels nothing (mirrors resolveCatalogExercise's refuse-on-ambiguity).
test('IC wiring: ambiguous typo-tier target refuses to relabel', () => {
  const h = loadCorrectionHarness([]);
  h.setActivePlannedSession({
    label: 'Push day',
    exercises: [
      { name: 'Incline Barbell Press', canonicalName: 'Incline Barbell Press', liftCode: '' },
      { name: 'Incline Dumbbell Press', canonicalName: 'Incline Dumbbell Press', liftCode: '' },
    ],
    index: 0,
  });
  h.setSessionLog([{ exercise: 'Ibp', weight: '135', reps: '8', rir: '2' }]);
  h.setSessionCompleted(['Ibp']);

  const result = h.tryApplyIdentityCorrection('sorry ibp is incline press');

  assert.equal(result, false, 'two candidate slots → refuse rather than guess');
  assert.equal(h.getSessionLog()[0].exercise, 'Ibp', 'sessionLog unchanged');
});

// 17. Catalog tier still backs the typo tolerance when no plan is active.
test('IC wiring: typo\'d correction resolves against the CATALOG when no plan exists', () => {
  const h = loadCorrectionHarness([
    ['Single-Leg Seated Leg Press', 'SLP01'],
    ['Leg Extension', 'LE01'],
  ]);
  h.setSessionLog([{ exercise: 'Slslp', weight: '70', reps: '15', rir: '2' }]);
  h.setSessionCompleted(['Slslp']);

  const result = h.tryApplyIdentityCorrection('sorry slslp is single leg seated leg prep');

  assert.equal(result, true, 'catalog word-subset/typo tier must bridge the typo');
  assert.equal(h.getSessionLog()[0].exercise, 'Single-Leg Seated Leg Press');
});

// 11. Source introspection — tryApplyIdentityCorrection must never call a write path
test('IC wiring (source): tryApplyIdentityCorrection never touches the write path', () => {
  const start = appSrc.indexOf('function tryApplyIdentityCorrection(');
  const end   = appSrc.indexOf('function announceIdentityCorrection(');
  const fnSrc = appSrc.slice(start, end);
  assert.ok(fnSrc.length > 0, 'function must be found');
  assert.ok(!fnSrc.includes("fetch("),         'must not call fetch()');
  assert.ok(!fnSrc.includes('writeLog'),        'must not call writeLog');
  assert.ok(!fnSrc.includes('/api/log-workout'), 'must not reference log-workout endpoint');
  assert.ok(!fnSrc.includes('sheet_write'),      'must not reference sheet_write proof field');
});

// 12. Source introspection — announceIdentityCorrection must not alter plan mutation state
test('IC wiring (source): announceIdentityCorrection does not change plan or session data', () => {
  const start = appSrc.indexOf('function announceIdentityCorrection(');
  const end   = appSrc.indexOf('function renderActiveSessionBanner(');
  const fnSrc = appSrc.slice(start, end);
  assert.ok(fnSrc.length > 0, 'function must be found');
  assert.ok(!fnSrc.includes('sessionLog'),      'must not mutate sessionLog');
  assert.ok(!fnSrc.includes('sessionCompleted'), 'must not mutate sessionCompleted');
  assert.ok(!fnSrc.includes('activePlannedSession'), 'must not mutate activePlannedSession');
});
