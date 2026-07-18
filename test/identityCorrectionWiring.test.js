'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// Real identityCorrection module — PR-08: ES module now, dynamic import (Node 20
// CI has no require(esm)). The namespace exposes the same named functions.
let identityCorrection;
test.before(async () => { identityCorrection = await import('../src/app/identityCorrection.js'); });

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
  // F10: slicePEE/sliceLC route completion through the authoritative selector.
  const { remainingSlotNames, variantSatisfies } = require('../src/app/planSlotStatuses.js');
  const factory = new Function('document', 'window', 'CustomEvent', 'events', 'remainingSlotNames', 'variantSatisfies', `
    // State vars mirroring app.js outer scope (PR-10: via the store shim)
    ${STORE_SHIM}
    let lastIntentData = null;
    let activeExercise = null;   // the exercise currently being discussed/clarified (ADD-5)
    // coachDiscussionSinceLog (ADD-5, PR-24 slice 2): now store-owned — the shim above
    // provides get/setCoachDiscussionSinceLog over its own local.

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
      setActiveExercise: name => { activeExercise = name || null; },
      setCoachDiscussionSinceLog,   // store-owned (shim-provided) — controls the ADD-5 focus flag
      tryApplyIdentityCorrection,
      getEvents: () => events.slice(),
    };
  `);

  return factory(fakeDoc, fakeWindow, FakeCustomEvent, events, remainingSlotNames, variantSatisfies);
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

// ── ADD-5: identity-correction targeting guard ───────────────────────────────
// A demonstrative correction must re-identify the lift IN FOCUS, and must never
// silently relabel a completed lift the correction does not clearly refer to. Live
// bug: Bench Press logged → incline flyes discussed → "I meant incline dumbbell
// flyes" corrupted the completed Bench Press rows into flyes.

// A1 (must-fix / spec 1): a later fly correction must NOT relabel a completed Bench.
test('ADD-5: later fly correction must NOT relabel a completed Bench Press; it asks', () => {
  const h = loadCorrectionHarness([
    ['Bench Press', 'BEN01'],
    ['Incline Dumbbell Fly', 'IDF01'],
  ]);
  h.setSessionLog([
    { exercise: 'Bench Press', weight: '185', reps: '8', rir: '2' },
    { exercise: 'Bench Press', weight: '185', reps: '7', rir: '2' },
  ]);
  h.setSessionCompleted(['Bench Press']);
  // The REAL live flow: after logging Bench the lifter DISCUSSED incline flyes (a
  // coach message). That route sets coachDiscussionSinceLog=true and nulls
  // activeExercise — so we drive the durable signal the app actually produces, NOT a
  // hand-set activeExercise the route would have cleared.
  h.setCoachDiscussionSinceLog(true);

  const result = h.tryApplyIdentityCorrection('i meant incline dumbbell flyes');

  const log = h.getSessionLog();
  assert.ok(log.every(s => s.exercise === 'Bench Press'), 'Bench Press rows must be untouched');
  assert.ok(h.getSessionCompleted().includes('Bench Press'), 'Bench stays completed');
  assert.ok(!h.getSessionCompleted().includes('Incline Dumbbell Fly'), 'no fly identity fabricated');
  const types = h.getEvents().map(e => e.type);
  assert.ok(types.includes('atlas:identity-correction-ambiguous'), 'must ask for clarification');
  assert.ok(!types.includes('atlas:identity-corrected'), 'must NOT announce a silent relabel');
  assert.equal(result, true, 'message is handled (by asking), not passed through to the coach');
});

// A2 (spec 2): the demonstrative form must never reach back to an EARLIER completed
// lift by a partial word match — only the in-focus / last-logged lift is eligible.
test('ADD-5: demonstrative correction never relabels an earlier completed lift by word overlap', () => {
  const h = loadCorrectionHarness([
    ['Bench Press', 'BEN01'],
    ['Overhead Press', 'OHP01'],
    ['Incline Bench Press', 'IBP01'],
  ]);
  h.setSessionLog([
    { exercise: 'Bench Press', weight: '185', reps: '8', rir: '2' },   // earlier
    { exercise: 'Overhead Press', weight: '95', reps: '8', rir: '2' },  // last-logged
  ]);
  h.setSessionCompleted(['Bench Press', 'Overhead Press']);

  h.tryApplyIdentityCorrection('i meant incline bench press');

  // "incline bench press" shares words with the earlier Bench Press — it must NOT be
  // chosen. Only the last-logged Overhead Press is the demonstrative target.
  const log = h.getSessionLog();
  assert.equal(log[0].exercise, 'Bench Press', 'earlier Bench Press is never touched');
  assert.ok(h.getSessionCompleted().includes('Bench Press'), 'earlier Bench stays completed');
});

// A3 (spec 3): with focus moved on, relabeling a completed lift needs explicit
// confirmation — Atlas asks rather than silently mutating.
test('ADD-5: relabeling a completed lift after focus moved on requires confirmation', () => {
  const h = loadCorrectionHarness([
    ['Deadlift', 'DL01'],
    ['Leg Curl', 'LC01'],
  ]);
  h.setSessionLog([{ exercise: 'Deadlift', weight: '315', reps: '5', rir: '2' }]);
  h.setSessionCompleted(['Deadlift']);
  h.setCoachDiscussionSinceLog(true); // the session moved on (coach discussion since the log)

  const result = h.tryApplyIdentityCorrection('actually that was leg curl');

  assert.equal(h.getSessionLog()[0].exercise, 'Deadlift', 'completed Deadlift not silently relabeled');
  assert.ok(h.getEvents().some(e => e.type === 'atlas:identity-correction-ambiguous'), 'asks');
  assert.equal(result, true, 'handled by asking');
});

// A4 (spec 4): when the corrected identity is already its OWN logged group, the
// correction refers to that group — never the unrelated tail lift.
test('ADD-5: target already logged as its own group → tail lift untouched, asks', () => {
  const h = loadCorrectionHarness([
    ['Bench Press', 'BEN01'],
    ['Cable Fly', 'CF01'],
  ]);
  h.setSessionLog([
    { exercise: 'Cable Fly', weight: '30', reps: '12', rir: '2' },     // its own group
    { exercise: 'Bench Press', weight: '185', reps: '8', rir: '2' },    // last-logged
  ]);
  h.setSessionCompleted(['Cable Fly', 'Bench Press']);

  h.tryApplyIdentityCorrection('i meant cable fly');

  const log = h.getSessionLog();
  assert.equal(log[1].exercise, 'Bench Press', 'tail Bench Press must NOT become Cable Fly');
  assert.equal(log[0].exercise, 'Cable Fly', 'existing Cable Fly group unchanged');
  assert.ok(h.getEvents().some(e => e.type === 'atlas:identity-correction-ambiguous'), 'asks');
});

// A5 (spec 5): the legitimate flow still works — when the last-logged lift IS the
// focus (nothing newer), a demonstrative correction relabels it as before.
test('ADD-5: legitimate just-logged correction still relabels (focus is the tail lift)', () => {
  const h = loadCorrectionHarness([
    ['Squat', 'SQ01'],
    ['Front Squat', 'FSQ01'],
  ]);
  h.setSessionLog([{ exercise: 'Squat', weight: '225', reps: '5', rir: '2' }]);
  h.setSessionCompleted(['Squat']);
  h.setActiveExercise('Squat'); // the just-logged lift is still the active focus

  const result = h.tryApplyIdentityCorrection('sorry that was front squat');

  assert.equal(result, true, 'a genuine re-identification still applies');
  assert.equal(h.getSessionLog()[0].exercise, 'Front Squat', 'relabeled as before');
  assert.ok(h.getEvents().some(e => e.type === 'atlas:identity-corrected'), 'announces the relabel');
});

// A6: the activeExercise parse-context signal is a secondary trigger — when a
// distinct exercise is the live parse context, the completed tail lift is protected
// even without a coach-discussion turn.
test('ADD-5: a distinct active parse-context exercise also protects the tail lift', () => {
  const h = loadCorrectionHarness([
    ['Bench Press', 'BEN01'],
    ['Incline Dumbbell Fly', 'IDF01'],
  ]);
  h.setSessionLog([{ exercise: 'Bench Press', weight: '185', reps: '8', rir: '2' }]);
  h.setSessionCompleted(['Bench Press']);
  h.setActiveExercise('Incline Dumbbell Fly'); // distinct live parse context

  h.tryApplyIdentityCorrection('i meant incline dumbbell flyes');

  assert.equal(h.getSessionLog()[0].exercise, 'Bench Press', 'Bench Press untouched');
  assert.ok(h.getEvents().some(e => e.type === 'atlas:identity-correction-ambiguous'), 'asks');
});

// A7 (real routing, source-level): the durable focus signal that A1 drives is the
// one the live message handler actually produces — the discuss→coach route SETS it
// (activeExercise is nulled on that route, so it cannot be the signal), a logged set
// RESETS it in emitSetLogged, and the correction guard READS it. This ties the fix
// to real routing rather than a hand-set state.
test('ADD-5 (source): coachDiscussionSinceLog is set by the coach route, reset on log, read by the guard', () => {
  // (PR-24 slice 2: the flag is store-owned now — set/reset/read go through the
  //  get/setCoachDiscussionSinceLog store actions rather than a bare app.js `let`.)
  // (1) discuss→coach route sets it — immediately before the substitute/coach hand-off.
  const routeIdx = appSrc.indexOf('const suggested = await checkAndSuggestSubstitute(pendingChatText)');
  assert.ok(routeIdx !== -1, 'coach route present');
  const beforeRoute = appSrc.slice(routeIdx - 400, routeIdx);
  assert.match(beforeRoute, /setCoachDiscussionSinceLog\(true\)/, 'coach route sets the moved-on signal');

  // (2) activeExercise is NULLED on that same route (so it cannot be the signal).
  const afterRoute = appSrc.slice(routeIdx, routeIdx + 800);
  assert.match(afterRoute, /activeExercise = null/, 'coach route nulls activeExercise (why the durable flag is needed)');

  // (3) emitSetLogged resets it when a set is logged.
  const emit = appSrc.slice(appSrc.indexOf('function emitSetLogged('), appSrc.indexOf('function emitSetLogged(') + 3300);
  assert.match(emit, /setCoachDiscussionSinceLog\(false\)/, 'a logged set resets the moved-on signal');

  // (4) the correction guard reads it.
  const fn = appSrc.slice(appSrc.indexOf('function tryApplyIdentityCorrection('), appSrc.indexOf('function announceIdentityCorrection('));
  assert.match(fn, /const focusMovedOn = getCoachDiscussionSinceLog\(\)/, 'guard reads the moved-on signal');
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
