'use strict';

// ADD-1 (PR10 regression addendum §1) — discarding a restored session clears the
// restored-session pin from BOTH state and UI. Regression lock: tapping the resume
// banner's trash (Discard restored session → discardRestoredSession) must hide the
// "Session restored — N sets logged (X)" notice, clear the buffered session + active
// plan, remove the persisted snapshot, and clear the session_id — no stale pin.
//
// Verification gate verdict: ALREADY FIXED in the current code (discardRestoredSession
// → clearSessionSnapshot() hides #session-resume-notice + clears the snapshot;
// endPlannedSession() clears the active plan/banner). This test guards it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

function loadDiscardHarness() {
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
  let cleared = { snapshot: false };
  // The resume-notice banner starts SHOWN (a restored session pin is on screen).
  const notice = { hidden: false, innerHTML: '<span>Session restored — 3 sets logged (Bench Press)</span>' };
  const sessionIdEl = { value: 'sess-2026-07-08-x' };
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
    // Store persistence half (owned by store.js) — stubbed to record the clear.
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
      state: () => ({ closeoutScreenshotFile }),
    };
  `);
  const api = factory(fakeDoc, FakeCustomEvent, events, cleared);
  return { api, notice, sessionIdEl, events, cleared };
}

test('ADD-1: discarding a restored session hides the pin and clears state', () => {
  const { api, notice, sessionIdEl, events, cleared } = loadDiscardHarness();
  // A restored session is on screen: pin shown, sets buffered, an active plan resumed.
  api.setSessionLog([{ exercise: 'Bench Press', weight: '185', reps: '8', rir: '2' }]);
  api.setActivePlannedSession({ label: 'Push day', exercises: [{ name: 'Bench Press' }], index: 0 });
  assert.equal(notice.hidden, false, 'precondition: the restored-session pin is visible');

  api.discardRestoredSession();

  // UI: the pin is gone.
  assert.equal(notice.hidden, true, 'the restored-session pin is hidden from the UI');
  // State: buffer + active plan + session_id cleared, snapshot removed.
  assert.deepEqual(api.getSessionLog(), [], 'the buffered session is cleared');
  assert.equal(api.getActivePlannedSession(), null, 'the active plan is cleared');
  assert.equal(sessionIdEl.value, '', 'the session_id is cleared');
  assert.equal(cleared.snapshot, true, 'the persisted snapshot is removed');
  // A session-reset is broadcast so every surface drops the stale session.
  assert.ok(events.some(e => e.type === 'atlas:session-reset'), 'atlas:session-reset is dispatched');
});
