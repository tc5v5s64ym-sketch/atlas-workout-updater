'use strict';

// Production bug (2026-07-11): with RDL, Back Squat, Single-Leg Seated Leg Press and
// Seated Row completed and Leg Extension the ONLY pending slot — but the header/cursor
// still stale on Seated Row — "Swap leg extensions out for something else." produced
// NO substitution. Atlas said "Plan updated" (the LLM fallback), yet Leg Extension
// remained. Root cause: recommendSubstitute('Leg Extension') returned null (no catalog
// entry), so the deterministic implicit-substitution path fell through to the LLM.
//
// This E2E drives the REAL mutation slice out of the built public/app.js with the REAL
// planMutationIntent classifier and the REAL substitutionRecommender behind the
// /api/suggest-substitute stub — plus a REAL canonical session (activeSession.js) that
// derives completion from a logged-set list, so the stale index cursor is exercised
// exactly as production. It locks in the four diagnosed facets: target resolution,
// active-index repair, mutation result, and confirmation truthfulness.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');
const { recommendSubstitute } = require('../services/substitutionRecommender');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

let planMutationIntent, activeSession;
test.before(async () => {
  planMutationIntent = await import('../src/app/planMutationIntent.js');
  activeSession = await import('../src/app/activeSession.js');
});

class FakeCustomEvent {
  constructor(type, init) { this.type = type; this.detail = (init && init.detail) || {}; }
}

// Load the mutation slice with a FAITHFUL canonical session: getCanonicalSession derives
// from the CURRENT (possibly just-mutated) plan + a fixed completed-set, so the stale
// index cursor and the derived "current lift" behave as production. The api stub routes
// /api/suggest-substitute to the REAL recommender.
function loadHarness(completed) {
  const slice = appSrc.slice(
    appSrc.indexOf('function applySessionSubstitution('),
    appSrc.indexOf('// ── P0 PR 4: deterministic exercise-identity correction')
  );

  const events = [];
  const calls = [];
  const fakeDoc = { getElementById: () => null, dispatchEvent: evt => events.push(evt) };
  const fakeWindow = { planMutationIntent, activeSession };
  const api = async (pathArg, opts) => {
    const body = JSON.parse((opts && opts.body) || '{}');
    calls.push({ path: pathArg, body });
    const rec = recommendSubstitute(body.current_exercise, { avoid: body.remaining_plan || [] });
    return { data: { recommendation: rec ? { ...rec, next_target: null } : null } };
  };

  const factory = new Function('document', 'window', 'CustomEvent', 'events', 'api', 'AS', 'COMPLETED', 'calls', `
    ${STORE_SHIM}
    let lastIntentData = null;
    function renderActiveSessionBanner() { syncPlannedIndexToCanonical(); }
    function plannedExerciseEntries() {
      const s = getActivePlannedSession();
      return s && Array.isArray(s.exercises)
        ? s.exercises.map(e => ({ name: e.canonicalName || e.name, canonical: e.canonicalName || e.name, liftCode: e.liftCode || '' }))
        : [];
    }
    function getCanonicalSession() {
      let s = AS.createActiveSession({ exercises: plannedExerciseEntries().map(e => ({ name: e.name, liftCode: e.liftCode })) });
      for (const n of COMPLETED) s = AS.markCompleted(s, n);
      return s;
    }
    function remainingPlannedExercises() { return AS.remaining(getCanonicalSession()).map(e => e.name); }
    function firstUnloggedPlannedLift() { return remainingPlannedExercises()[0] || null; }
    // Forward-only cursor reconciliation (mirrors app.js syncPlannedIndexToCanonical).
    function syncPlannedIndexToCanonical() {
      const s = getActivePlannedSession();
      if (!s || !Array.isArray(s.exercises)) return;
      const cur = AS.currentExercise(getCanonicalSession());
      if (!cur) return;
      const key = String(cur.name || '').toLowerCase();
      const target = s.exercises.findIndex(e => (e.canonicalName || e.name || '').toLowerCase() === key);
      if (target > s.index) s.index = target;
    }
    function normalizePlanExercise(x) { return x; }
    function emitPlanItemOutcome() {}

    ${slice}

    return {
      setActivePlannedSession: s => { activePlannedSession = s; },
      getExercises: () => (activePlannedSession ? activePlannedSession.exercises.map(e => e.name) : []),
      // The lift the header/composer would show: the reconciled cursor slot.
      bannerCurrent: () => { syncPlannedIndexToCanonical(); const s = activePlannedSession; const e = s && s.exercises[s.index]; return e ? (e.canonicalName || e.name) : null; },
      getIndex: () => activePlannedSession && activePlannedSession.index,
      firstUnlogged: () => firstUnloggedPlannedLift(),
      tryApplyImplicitSubstitution,
      tryApplyPlanMutation,
      getEvents: () => events.slice(),
      getCalls: () => calls.slice(),
    };
  `);
  return factory(fakeDoc, fakeWindow, FakeCustomEvent, events, api, activeSession, completed, calls);
}

// The exact production fixture: 5 planned, 4 completed, Leg Extension pending & LAST,
// and the index cursor STALE on Seated Row (idx 3) rather than Leg Extension (idx 4).
function legDayPlan() {
  return {
    label: 'Leg day',
    exercises: [
      { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01' },
      { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'SQ01' },
      { name: 'Single-Leg Seated Leg Press', canonicalName: 'Single-Leg Seated Leg Press', liftCode: 'SLLP01' },
      { name: 'Seated Row', canonicalName: 'Seated Row', liftCode: 'ROW01' },
      { name: 'Leg Extension', canonicalName: 'Leg Extension', liftCode: 'LEGEXT01' },
    ],
    index: 3, // STALE — points at the already-completed Seated Row
  };
}
const COMPLETED = ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'];

test('E2E: "Swap leg extensions out for something else." substitutes Leg Extension in place despite the stale cursor', async () => {
  const h = loadHarness(COMPLETED);
  h.setActivePlannedSession(legDayPlan());

  const handled = await h.tryApplyImplicitSubstitution('Swap leg extensions out for something else.');

  // Confirmation truthfulness: handled deterministically → never falls through to the
  // LLM chat path that falsely said "Plan updated".
  assert.equal(handled, true, 'the implicit substitution is handled deterministically (no LLM fallthrough)');

  // Target resolution: the NAMED pending exercise resolved (Leg Extension), NOT the
  // stale cursor's Seated Row — the recommender was asked about Leg Extension.
  const calls = h.getCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/suggest-substitute');
  assert.equal(calls[0].body.current_exercise, 'Leg Extension');
  assert.equal(calls[0].body.intent, 'substitute');

  // Mutation result: Leg Extension is REPLACED in place by a valid substitute — the
  // list length is unchanged and Seated Row (the stale cursor's lift) is untouched.
  const names = h.getExercises();
  assert.ok(!names.includes('Leg Extension'), 'Leg Extension is gone (replaced, not left in place)');
  assert.equal(names.length, 5, 'in-place replace — no slot added or dropped');
  assert.deepEqual(names.slice(0, 4), ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'], 'the completed slots are preserved in order');
  const sub = names[4];
  assert.ok(['Leg Press', 'Hack Squat', 'Goblet Squat'].includes(sub), `a valid quad substitute took the slot, got ${sub}`);

  // Active-index repair: the substitute becomes the active lift even though the cursor
  // was stale on Seated Row (idx 3) — the header/composer now point at the substitute.
  assert.equal(h.firstUnlogged(), sub, 'the substitute is the first unlogged (current) lift');
  assert.equal(h.bannerCurrent(), sub, 'the header/cursor is repaired onto the substitute');
  assert.equal(h.getIndex(), 4, 'the cursor advanced off the stale Seated Row to the substitute slot');

  // Confirmation truthfulness: the announced summary names the ACTUAL swap that happened.
  const mutated = h.getEvents().filter(e => e.type === 'atlas:plan-mutated');
  assert.equal(mutated.length, 1, 'exactly one truthful mutation announcement');
  assert.equal(mutated[0].detail.summary, `Swapped Leg Extension → ${sub}.`);
  assert.equal(mutated[0].detail.current, sub, 'the composer re-points to the substitute');
});

test('E2E control: preserved behavior — a plain named skip still works with the stale cursor', () => {
  // "Skip leg extensions" removes the pending slot; Seated Row (stale cursor lift) and
  // the other completed slots are untouched. Proves the skip lane is unregressed.
  const h = loadHarness(COMPLETED);
  h.setActivePlannedSession(legDayPlan());

  assert.equal(h.tryApplyPlanMutation('Skip leg extensions'), true);
  const names = h.getExercises();
  assert.ok(!names.includes('Leg Extension'), 'Leg Extension skipped (removed)');
  assert.deepEqual(names, ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'], 'only the named slot was removed');
  assert.equal(h.getCalls().length, 0, 'a skip never consults the recommender endpoint');
});

test('E2E control: preserved behavior — an explicit NAMED current-slot swap still applies in place', async () => {
  // "Swap leg extensions for leg press" — an explicit named substitute goes through the
  // sync mutation path (no recommender call) and replaces the slot in place.
  const h = loadHarness(COMPLETED);
  h.setActivePlannedSession(legDayPlan());

  assert.equal(h.tryApplyPlanMutation('swap leg extensions for leg press'), true);
  const names = h.getExercises();
  assert.ok(!names.includes('Leg Extension'), 'Leg Extension replaced');
  assert.ok(names.some(n => n.toLowerCase() === 'leg press'), 'the named substitute took the slot');
  assert.equal(h.getCalls().length, 0, 'the explicit named path never calls the recommender endpoint');
});
