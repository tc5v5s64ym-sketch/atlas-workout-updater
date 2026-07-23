'use strict';

// ADD-2 (PR10 regression addendum §2) — a spoken negation-style skip becomes REAL
// session state. "My lower back is a bit sore so no RDLs for me today" must remove
// the Romanian Deadlift (RDL01) slot from the active plan, not just get a coach reply.
//
// End-to-end harness (mirrors identityCorrectionWiring): slice the real
// applySessionSubstitution→…→tryApplyPlanMutation block out of app.js and drive it
// in Node with the REAL planMutationIntent module. getCanonicalSession is stubbed to
// null so the fallback plan-entries path runs — the exact path that now threads
// liftCode so resolvePlanTargets can reach the RDL slot by its code stem.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

let planMutationIntent;
test.before(async () => { planMutationIntent = await import('../src/app/planMutationIntent.js'); });

class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

function loadMutationHarness() {
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
    // Deps referenced by the slice but outside the mutation path under test.
    function renderActiveSessionBanner() {}
    function getCanonicalSession() { return null; }          // → fallback plan-entries path (carries liftCode)
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

function planWithRdl() {
  return {
    label: 'Pull day',
    exercises: [
      { name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01' },
      { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01' },
      { name: 'Bench Press', canonicalName: 'Bench Press', liftCode: 'BEN01' },
    ],
    index: 0,
  };
}

test('ADD-2: "no RDLs for me today" removes the RDL01 slot from the active plan', () => {
  const h = loadMutationHarness();
  h.setActivePlannedSession(planWithRdl());

  const result = h.tryApplyPlanMutation('no RDLs for me today');

  assert.equal(result, true, 'the spoken skip is handled deterministically');
  const names = h.getExercises();
  assert.ok(!names.includes('Romanian Deadlift'), 'RDL slot is removed from session state');
  assert.deepEqual(names, ['Overhead Press', 'Bench Press'], 'only the RDL slot left; others intact');
  assert.ok(
    h.getEvents().some(e => e.type === 'atlas:plan-mutated' && /Skipped Romanian Deadlift/.test(e.detail.summary)),
    'the mutation is announced for the coach to confirm'
  );
});

test('ADD-2: the same skip carried behind a reason clause still removes the slot', () => {
  const h = loadMutationHarness();
  h.setActivePlannedSession(planWithRdl());

  const result = h.tryApplyPlanMutation('My lower back is a bit sore so no RDLs for me today');

  assert.equal(result, true);
  assert.ok(!h.getExercises().includes('Romanian Deadlift'), 'RDL slot removed despite the leading reason');
});

// Wrong-target guard — the plan realistically holds BOTH a "Leg Press" slot and a
// "Single-Leg Seated Leg Press" slot (the exact pair the implicit-substitution
// redundancy fix cites as co-occurring live). A mutation that NAMES "leg press"
// must act on the exact slot, never the fuzzy single-leg variant that happens to
// come first in plan order.
function planWithLegPressVariants() {
  return {
    label: 'Leg day',
    exercises: [
      { name: 'Single-Leg Seated Leg Press', canonicalName: 'Single-Leg Seated Leg Press', liftCode: 'SLP01' },
      { name: 'Leg Extension', canonicalName: 'Leg Extension', liftCode: 'LEX01' },
      { name: 'Leg Press', canonicalName: 'Leg Press', liftCode: 'LEP01' },
    ],
    index: 0,
  };
}

test('wrong-target guard: "skip leg press" removes the EXACT Leg Press slot, never the single-leg variant', () => {
  const h = loadMutationHarness();
  h.setActivePlannedSession(planWithLegPressVariants());

  const result = h.tryApplyPlanMutation('skip leg press');

  assert.equal(result, true, 'the named skip is handled deterministically');
  assert.deepEqual(h.getExercises(), ['Single-Leg Seated Leg Press', 'Leg Extension'],
    'the exact "Leg Press" slot is removed; the un-named variant is untouched');
  assert.ok(
    h.getEvents().some(e => e.type === 'atlas:plan-mutated' && /Skipped Leg Press\./.test(e.detail.summary)),
    'the announced skip names the slot the athlete actually named'
  );
});

test('an explicit "swap X for Y" is now GATED — the sync skip lane defers it and mutates nothing', () => {
  const h = loadMutationHarness();
  h.setActivePlannedSession(planWithLegPressVariants());

  // Production trust fix FR-20260723031748: an explicit replacement is a gated proposal, so
  // the sync skip lane must NOT apply it in place. It defers; the plan is left intact.
  const result = h.tryApplyPlanMutation('swap leg press for hack squat');

  assert.equal(result, false, 'the explicit replace is deferred to the gated proposer');
  const names = h.getExercises();
  assert.ok(names.includes('Leg Press'), 'the named slot is NOT swapped out by the sync lane');
  assert.ok(names.includes('Single-Leg Seated Leg Press'), 'the un-named variant is untouched');
  assert.ok(!names.some(n => /hack squat/i.test(n)), 'no substitute is inserted before approval');
});

test('ADD-2: a non-plan "no X" (nothing in the plan matches) falls through, mutates nothing', () => {
  const h = loadMutationHarness();
  h.setActivePlannedSession(planWithRdl());

  const result = h.tryApplyPlanMutation('no thanks');

  assert.equal(result, false, 'no matching slot → falls through to the coach');
  assert.deepEqual(h.getExercises(), ['Overhead Press', 'Romanian Deadlift', 'Bench Press'], 'plan unchanged');
  assert.equal(h.getEvents().length, 0, 'no mutation announced');
});
