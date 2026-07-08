'use strict';

// Shared harness builders for the PR-23 Flight-Recorder replay tests
// (test/flightRecorderReplay.test.js). These are faithful extractions of the
// slice+eval harnesses already proven in test/restoredSessionDiscard.test.js,
// test/planSkipWiring.test.js, and test/identityCorrectionWiring.test.js — copied
// here, not reinvented, so the replay harness drives the exact same real app.js
// code paths those regression-lock tests already verify. If app.js's function
// layout changes, update the markers here AND in those three files together.
//
// app.js is a giant non-modular classic script, so these harnesses extract a
// slice of its raw source text between two function-declaration markers and
// `eval` it via `new Function(...)` with fake document/window/CustomEvent shims
// (see test/helpers/storeShim.js for the shared session/plan state shim).

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { STORE_SHIM } = require('./storeShim');

const repoRoot = path.join(__dirname, '..', '..');

let _appSrc = null;
function readAppSource() {
  if (_appSrc === null) {
    _appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  }
  return _appSrc;
}

class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

let _planMutationIntent = null;
async function loadPlanMutationIntent() {
  if (!_planMutationIntent) _planMutationIntent = await import('../../src/app/planMutationIntent.js');
  return _planMutationIntent;
}

let _identityCorrection = null;
async function loadIdentityCorrection() {
  if (!_identityCorrection) _identityCorrection = await import('../../src/app/identityCorrection.js');
  return _identityCorrection;
}

// ADD-1 (PR10 regression addendum §1) — discardRestoredSession must clear the
// restored-session pin from both state and UI. Mirrors
// test/restoredSessionDiscard.test.js::loadDiscardHarness exactly.
function buildRestoredSessionHarness({ noticeText } = {}) {
  const appSrc = readAppSource();
  const sliceEnd = appSrc.slice(
    appSrc.indexOf('function endPlannedSession()'),
    appSrc.indexOf('function normalizePlanEditExercise(')
  );
  const sliceDiscard = appSrc.slice(
    appSrc.indexOf('function clearSessionSnapshot()'),
    appSrc.indexOf('function restoreSessionToView()')
  );
  assert.ok(sliceDiscard.includes('function discardRestoredSession()'), 'slice must contain discardRestoredSession');
  assert.ok(sliceDiscard.includes('function clearSessionSnapshot()'), 'slice must contain clearSessionSnapshot');
  assert.ok(sliceEnd.includes('function endPlannedSession()'), 'slice must contain endPlannedSession');

  const events = [];
  const cleared = { snapshot: false };
  const notice = { hidden: false, innerHTML: `<span>${noticeText || 'Session restored'}</span>` };
  const sessionIdEl = { value: 'sess-replay-fixture' };
  const banner = { hidden: false, innerHTML: '' };
  const fakeDoc = {
    getElementById: id =>
      id === 'session-resume-notice' ? notice :
      id === 'log-session-id' ? sessionIdEl :
      id === 'active-session-banner' ? banner : null,
    dispatchEvent: evt => events.push(evt),
  };

  const factory = new Function('document', 'CustomEvent', 'events', 'cleared', `
    ${STORE_SHIM}
    let closeoutScreenshotFile = 'f', closeoutScreenshotEffort = {}, closeoutScreenshotDateSource = 'x';
    function clearPersistedSnapshot() { cleared.snapshot = true; }
    function renderActiveSessionBanner() {}
    function api() { return Promise.resolve({}); }

    ${sliceEnd}
    ${sliceDiscard}

    return {
      setSessionLog: log => { sessionLog = log.slice(); },
      getSessionLog: () => sessionLog.slice(),
      setActivePlannedSession: s => { activePlannedSession = s; },
      getActivePlannedSession: () => activePlannedSession,
      discardRestoredSession,
    };
  `);
  const api = factory(fakeDoc, FakeCustomEvent, events, cleared);

  return {
    setSessionLog: api.setSessionLog,
    getSessionLog: api.getSessionLog,
    setActivePlannedSession: api.setActivePlannedSession,
    getActivePlannedSession: api.getActivePlannedSession,
    discardRestoredSession: api.discardRestoredSession,
    isNoticeHidden: () => notice.hidden,
    sessionIdValue: () => sessionIdEl.value,
    isSnapshotCleared: () => cleared.snapshot,
    getEvents: () => events.slice(),
  };
}

// ADD-2 (PR10 regression addendum §2) — a spoken negation-style skip must become
// real session state. Mirrors test/planSkipWiring.test.js::loadMutationHarness.
async function buildPlanMutationHarness() {
  const appSrc = readAppSource();
  const planMutationIntent = await loadPlanMutationIntent();
  const slice = appSrc.slice(
    appSrc.indexOf('function applySessionSubstitution('),
    appSrc.indexOf('// ── P0 PR 4: deterministic exercise-identity correction')
  );
  assert.ok(slice.includes('function tryApplyPlanMutation('), 'slice must contain tryApplyPlanMutation');
  assert.ok(slice.includes('function skipPlannedExercise('), 'slice must contain skipPlannedExercise');

  const events = [];
  const fakeDoc = { getElementById: () => null, dispatchEvent: evt => events.push(evt) };
  const fakeWindow = { planMutationIntent };

  const factory = new Function('document', 'window', 'CustomEvent', 'events', `
    ${STORE_SHIM}
    let lastIntentData = null;
    function renderActiveSessionBanner() {}
    function getCanonicalSession() { return null; }
    function firstUnloggedPlannedLift() {
      const s = getActivePlannedSession();
      const e = s && s.exercises && s.exercises[s.index];
      return e ? (e.canonicalName || e.name) : null;
    }
    function plannedExerciseEntries() { return []; }
    function normalizePlanExercise(x) { return x; }
    function liftCodeFromCatalog() { return ''; }

    ${slice}

    return {
      setActivePlannedSession: s => { activePlannedSession = s; },
      getExercises: () => (activePlannedSession ? activePlannedSession.exercises.map(e => e.name) : []),
      tryApplyPlanMutation,
      getEvents: () => events.slice(),
    };
  `);
  return factory(fakeDoc, fakeWindow, FakeCustomEvent, events);
}

// ADD-5 (PR10 regression addendum §5) — a demonstrative correction must target
// the active/latest ambiguous item, never silently relabel a completed lift it
// does not clearly refer to. Mirrors
// test/identityCorrectionWiring.test.js::loadCorrectionHarness.
async function buildIdentityCorrectionHarness(catalogOptions) {
  const appSrc = readAppSource();
  const identityCorrection = await loadIdentityCorrection();
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

  const factory = new Function('document', 'window', 'CustomEvent', 'events', `
    ${STORE_SHIM}
    let lastIntentData = null;
    let activeExercise = null;
    // coachDiscussionSinceLog (ADD-5, PR-24 slice 2): store-owned — the shim provides
    // get/setCoachDiscussionSinceLog over its own local.

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

  return factory(fakeDoc, fakeWindow, FakeCustomEvent, events);
}

module.exports = {
  readAppSource,
  FakeCustomEvent,
  buildRestoredSessionHarness,
  buildPlanMutationHarness,
  buildIdentityCorrectionHarness,
};
