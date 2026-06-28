'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// Real activeSession module — UMD exports cleanly under Node (same as the E2E test).
const AS = require(path.join(repoRoot, 'public', 'activeSession.js'));

// ===========================================================================
// B2 — canonical active session state: the PLAN CARD surface.
//
// The active-session banner (the "plan card") rendered its current step from the
// raw `activePlannedSession.index` cursor. A logged set advances only the canonical
// session (sessionCompleted); the index cursor lagged until "Next exercise →" was
// tapped — so the plan card showed a just-logged lift as still-current while the
// composer, next-up router, and save payload had already moved on (visible state
// drift). syncPlannedIndexToCanonical() reconciles the cursor forward to the
// canonical current (first unlogged planned lift) so the plan card derives from the
// SAME canonical session as every other surface.
// ===========================================================================

// ── Behavioral: syncPlannedIndexToCanonical reconciles the cursor ─────────────
// Slice the helper + its two dependencies (getCanonicalSession, plannedExerciseEntries)
// and drive them in Node against the real activeSession.js model — no browser/DOM.
function loadPlanCardHarness() {
  const sliceGCS = appSrc.slice(
    appSrc.indexOf('function getCanonicalSession()'),
    appSrc.indexOf('function getCoachSuggestionEngaged()')
  );
  const sliceSYNC = appSrc.slice(
    appSrc.indexOf('function syncPlannedIndexToCanonical()'),
    appSrc.indexOf('function advancePlannedSession()')
  );
  const slicePEE = appSrc.slice(
    appSrc.indexOf('function plannedExerciseEntries()'),
    appSrc.indexOf('function plannedExerciseOrder()')
  );

  assert.ok(sliceGCS.includes('getCanonicalSession'), 'sliceGCS must contain getCanonicalSession');
  assert.ok(sliceSYNC.includes('syncPlannedIndexToCanonical'), 'sliceSYNC must contain the helper');
  assert.ok(slicePEE.includes('plannedExerciseEntries'), 'slicePEE must contain plannedExerciseEntries');

  const factory = new Function('window', `
    let activePlannedSession = null;
    let sessionCompleted = [];
    let lastIntentData = null;
    let coachSuggestionEngaged = false;

    ${slicePEE}
    ${sliceGCS}
    ${sliceSYNC}

    return {
      setPlan: (exercises, index) => { activePlannedSession = { exercises, index: index || 0 }; },
      setCompleted: arr => { sessionCompleted = arr.slice(); },
      getIndex: () => (activePlannedSession ? activePlannedSession.index : null),
      currentName: () => {
        if (!activePlannedSession) return null;
        const e = activePlannedSession.exercises[activePlannedSession.index];
        return e ? (e.canonicalName || e.name) : null;
      },
      canonicalCurrentName: () => {
        const s = getCanonicalSession();
        const cur = s && window.activeSession.currentExercise(s);
        return cur ? cur.name : null;
      },
      syncPlannedIndexToCanonical,
    };
  `);

  return factory({ activeSession: AS });
}

const PLAN = () => [
  { name: 'Bench Press',  canonicalName: 'Bench Press',  liftCode: 'BEN01' },
  { name: 'Seated Row',   canonicalName: 'Seated Row',   liftCode: 'ROW01' },
  { name: 'Lat Pulldown', canonicalName: 'Lat Pulldown', liftCode: 'LAT01' },
];

test('plan card: cursor advances to the canonical current after a logged set', () => {
  const h = loadPlanCardHarness();
  h.setPlan(PLAN(), 0);
  // Before logging, the cursor and the canonical current agree on Bench Press.
  assert.equal(h.currentName(), 'Bench Press', 'cursor starts on Bench Press');
  assert.equal(h.canonicalCurrentName(), 'Bench Press', 'canonical current is Bench Press');

  // Log Bench: the canonical session advances to Seated Row, but the index cursor
  // would lag at Bench until "Next exercise →" is tapped. The sync closes that gap.
  h.setCompleted(['Bench Press']);
  assert.equal(h.canonicalCurrentName(), 'Seated Row', 'canonical current moved to Seated Row');
  h.syncPlannedIndexToCanonical();
  assert.equal(h.getIndex(), 1, 'cursor reconciled to the Seated Row slot');
  assert.equal(h.currentName(), 'Seated Row', 'plan card now shows the canonical current');
});

test('plan card: cursor follows multiple logged sets in order', () => {
  const h = loadPlanCardHarness();
  h.setPlan(PLAN(), 0);
  h.setCompleted(['Bench Press', 'Seated Row']);
  h.syncPlannedIndexToCanonical();
  assert.equal(h.currentName(), 'Lat Pulldown', 'cursor advances past both logged lifts to Lat Pulldown');
  assert.equal(h.canonicalCurrentName(), 'Lat Pulldown', 'plan card matches the canonical current');
});

test('plan card: sync is a no-op before anything is logged', () => {
  const h = loadPlanCardHarness();
  h.setPlan(PLAN(), 0);
  h.syncPlannedIndexToCanonical();
  assert.equal(h.getIndex(), 0, 'cursor stays on the first lift when nothing is logged');
});

test('plan card: sync is forward-only — never rewinds a deliberate swap-advance', () => {
  const h = loadPlanCardHarness();
  // A declared swap (Step 379) advances the cursor PAST the swapped-out lift before
  // its substitute is logged, so index (2) is ahead of the canonical current (slot 0,
  // still pending). The sync must NOT rewind the cursor back to slot 0.
  h.setPlan(PLAN(), 2);
  assert.equal(h.canonicalCurrentName(), 'Bench Press', 'canonical current is the still-pending slot 0');
  h.syncPlannedIndexToCanonical();
  assert.equal(h.getIndex(), 2, 'cursor is not rewound below its current position');
});

test('plan card: sync leaves the cursor put once every planned lift is logged', () => {
  const h = loadPlanCardHarness();
  h.setPlan(PLAN(), 0);
  h.setCompleted(['Bench Press', 'Seated Row', 'Lat Pulldown']);
  // Canonical currentExercise is null (nothing pending) — the sync must not overrun.
  assert.equal(h.canonicalCurrentName(), null, 'no canonical current once all are logged');
  h.syncPlannedIndexToCanonical();
  const idx = h.getIndex();
  assert.ok(idx >= 0 && idx <= 2, 'cursor stays within bounds when the plan is complete');
});

// ── Structural wiring: the plan card + post-log refresh route through the sync ──

test('wiring: renderActiveSessionBanner reconciles via syncPlannedIndexToCanonical', () => {
  const start = appSrc.indexOf('function renderActiveSessionBanner()');
  assert.ok(start !== -1, 'renderActiveSessionBanner must exist');
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 1200 : next);
  assert.ok(
    body.includes('syncPlannedIndexToCanonical()'),
    'renderActiveSessionBanner must reconcile the cursor to the canonical current'
  );
});

test('wiring: syncPlannedIndexToCanonical is forward-only and derives from the canonical session', () => {
  const start = appSrc.indexOf('function syncPlannedIndexToCanonical()');
  assert.ok(start !== -1, 'helper must exist');
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 1200 : next);
  assert.ok(body.includes('getCanonicalSession()'), 'must derive from getCanonicalSession()');
  assert.ok(body.includes('currentExercise('), 'must read the canonical current exercise');
  assert.ok(
    body.includes('target > activePlannedSession.index'),
    'must only advance forward (never rewind a deliberate swap-advance)'
  );
});

test('wiring: emitSetLogged refreshes the plan card after a logged set (guarded)', () => {
  const start = appSrc.indexOf('function emitSetLogged(');
  assert.ok(start !== -1, 'emitSetLogged must exist');
  const next = appSrc.indexOf('\nasync function fetchReaction(', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 4000 : next);
  assert.ok(
    body.includes("typeof renderActiveSessionBanner === 'function'") &&
    body.includes('renderActiveSessionBanner()'),
    'emitSetLogged must refresh the plan card after logging, guarded for the test harness'
  );
});
