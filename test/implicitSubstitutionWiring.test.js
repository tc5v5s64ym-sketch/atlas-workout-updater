'use strict';

// Production bug (2026-07-11): with Back Squat active, "I don't want to do squats,
// give me something else." marked Back Squat SKIPPED and advanced to the next
// exercise. The decline lane emitted { action:'skip' }; the fix classifies an
// implicit substitution and wires it to the deterministic recommender + the existing
// in-place executor.
//
// End-to-end harness (mirrors planSkipWiring): slice the real
// applySessionSubstitution → … → tryApplyImplicitSubstitution block out of the built
// public/app.js and drive it in Node with the REAL planMutationIntent module and a
// STUBBED /api/suggest-substitute (the server recommender is exercised in its own
// unit + route tests; here we prove the WIRING and the in-place plan mutation).

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

// Load the mutation slice with an injectable async `api`. `apiState.recommendation`
// is what /api/suggest-substitute returns; `apiState.calls` records the request bodies.
function loadHarness(apiState) {
  const slice = appSrc.slice(
    appSrc.indexOf('function applySessionSubstitution('),
    appSrc.indexOf('// ── P0 PR 4: deterministic exercise-identity correction')
  );
  assert.ok(slice.includes('function tryApplyImplicitSubstitution('), 'slice must contain tryApplyImplicitSubstitution');
  assert.ok(slice.includes('function tryApplyPlanMutation('), 'slice must contain tryApplyPlanMutation');

  const events = [];
  const fakeDoc = { getElementById: () => null, dispatchEvent: evt => events.push(evt) };
  const fakeWindow = { planMutationIntent };
  const api = async (pathArg, opts) => {
    apiState.calls.push({ path: pathArg, body: JSON.parse((opts && opts.body) || '{}') });
    return { data: { recommendation: apiState.recommendation } };
  };

  const factory = new Function('document', 'window', 'CustomEvent', 'events', 'api', `
    ${STORE_SHIM}
    let lastIntentData = null;
    function renderActiveSessionBanner() {}
    function getCanonicalSession() { return null; }           // → fallback plan-entries path
    function firstUnloggedPlannedLift() {
      const s = getActivePlannedSession();
      const e = s && s.exercises && s.exercises[s.index];
      return e ? (e.canonicalName || e.name) : null;
    }
    function plannedExerciseEntries() { return []; }
    function normalizePlanExercise(x) { return x; }
    function liftCodeFromCatalog() { return ''; }
    function emitPlanItemOutcome() {}                          // PR-G1 outcome sink (no id in fixtures)

    ${slice}

    return {
      setActivePlannedSession: s => { activePlannedSession = s; },
      getExercises: () => (activePlannedSession ? activePlannedSession.exercises.map(e => e.name) : []),
      getCurrent: () => { const s = activePlannedSession; const e = s && s.exercises[s.index]; return e ? (e.canonicalName || e.name) : null; },
      getSlot: i => (activePlannedSession ? activePlannedSession.exercises[i] : null),
      tryApplyImplicitSubstitution,
      tryApplyPlanMutation,
      getEvents: () => events.slice(),
    };
  `);
  return factory(fakeDoc, fakeWindow, FakeCustomEvent, events, api);
}

// Fixture: RDL (completed, index behind) · Back Squat (CURRENT, index 1) ·
// Single-Leg Seated Leg Press · Seated Row. Deliberately includes a "…Leg Press" slot
// to prove the "Leg Press" substitute does NOT collide with it.
function fourExercisePlan() {
  return {
    label: 'Leg day',
    exercises: [
      { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01' },
      { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'SQ01' },
      { name: 'Single-Leg Seated Leg Press', canonicalName: 'Single-Leg Seated Leg Press', liftCode: 'SLLP01' },
      { name: 'Seated Row', canonicalName: 'Seated Row', liftCode: 'ROW01' },
    ],
    index: 1, // Back Squat is the current exercise
  };
}
const LEG_PRESS_REC = { recommendation: 'Leg Press', quality: 'acceptable', reason: 'Preserves the squat pattern with a lighter compound alternative.', next_target: null };

test('E2E: "I don\'t want to do squats, give me something else." substitutes Back Squat in place', async () => {
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());

  const handled = await h.tryApplyImplicitSubstitution("I don't want to do squats, give me something else.");

  assert.equal(handled, true, 'the implicit substitution is handled deterministically');
  const names = h.getExercises();
  // Back Squat is NOT skipped/advanced-past — it is REPLACED in place by the substitute.
  assert.ok(!names.includes('Back Squat'), 'Back Squat is no longer a slot (replaced, not skipped-and-kept)');
  assert.ok(names.includes('Leg Press'), 'a deterministic substitute (Leg Press) took the slot');
  // Current slot replaced IN PLACE (index 1) and remaining order preserved.
  assert.deepEqual(names, ['Romanian Deadlift', 'Leg Press', 'Single-Leg Seated Leg Press', 'Seated Row']);
  assert.equal(h.getCurrent(), 'Leg Press', 'the substitute is the active exercise');
  assert.equal(h.getSlot(1).reason, 'substituted', 'the slot is marked substituted, not skipped');
  // No phantom "something else" exercise was created.
  assert.ok(!names.some(n => /something/i.test(n)), 'no literal "something else" slot');
  // The deterministic recommender was consulted for the real target with the intent signal.
  assert.equal(apiState.calls.length, 1);
  assert.equal(apiState.calls[0].path, '/api/suggest-substitute');
  assert.equal(apiState.calls[0].body.current_exercise, 'Back Squat');
  assert.equal(apiState.calls[0].body.intent, 'substitute');
  // Athlete-facing confirmation identifies the replacement.
  assert.ok(
    h.getEvents().some(e => e.type === 'atlas:plan-mutated' && /Swapped Back Squat → Leg Press/.test(e.detail.summary)),
    'the swap is announced for the coach to confirm'
  );
});

test('E2E control: no known substitute → falls through (nothing mutated), coach handles it', async () => {
  const apiState = { recommendation: null, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());

  const handled = await h.tryApplyImplicitSubstitution("I don't want to do squats, give me something else.");

  assert.equal(handled, false, 'no substitute → not handled here');
  assert.deepEqual(h.getExercises(), ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'], 'plan unchanged');
  assert.equal(h.getEvents().length, 0, 'nothing announced');
});

test('E2E control: duplicate-substitute follows existing governing behavior (dedupe splice, no duplicate slot)', async () => {
  // The recommender returns a lift already in the plan (Seated Row) — the existing
  // applySessionSubstitution dedupe removes the Back Squat slot rather than duplicating.
  const apiState = { recommendation: { recommendation: 'Seated Row', quality: 'acceptable', reason: 'x', next_target: null }, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());

  const handled = await h.tryApplyImplicitSubstitution("I don't want to do squats, give me something else.");

  assert.equal(handled, true);
  const names = h.getExercises();
  assert.ok(!names.includes('Back Squat'), 'Back Squat slot removed');
  assert.equal(names.filter(n => n === 'Seated Row').length, 1, 'Seated Row is not duplicated (dedupe)');
  assert.deepEqual(names, ['Romanian Deadlift', 'Single-Leg Seated Leg Press', 'Seated Row']);
});

test('E2E control: a non-substitution message is not handled here', async () => {
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(await h.tryApplyImplicitSubstitution('how many reps should I do?'), false);
  assert.equal(apiState.calls.length, 0, 'the recommender is never consulted for a non-mutation');
});

test('E2E control: TRUE skip and explicit NAMED replace still work via the sync path (unchanged)', () => {
  // "Skip back squats" — deterministic skip removes the slot (Back Squat gone, order kept).
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  let h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(h.tryApplyPlanMutation('Skip back squats'), true);
  assert.deepEqual(h.getExercises(), ['Romanian Deadlift', 'Single-Leg Seated Leg Press', 'Seated Row'], 'true skip removes only Back Squat');

  // "I don't want to do squats today" — governed PR-I2 decline still a true skip.
  h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(h.tryApplyPlanMutation("I don't want to do squats today"), true);
  assert.ok(!h.getExercises().includes('Back Squat'), 'plain decline still skips Back Squat');

  // "Swap back squats for leg press" — explicit NAMED substitution applies in place.
  h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(h.tryApplyPlanMutation('swap back squats for leg press'), true);
  const names = h.getExercises();
  assert.ok(names.includes('leg press') || names.includes('Leg Press'), 'named substitute took the slot');
  assert.ok(!names.includes('Back Squat'), 'Back Squat replaced');
  assert.equal(apiState.calls.length, 0, 'the named path never calls the recommender endpoint');
});

test('E2E control: the sync mutation path DEFERS an implicit substitution (returns false)', () => {
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  // tryApplyPlanMutation must NOT try to handle the 'substitute' action itself.
  assert.equal(h.tryApplyPlanMutation("I don't want to do squats, give me something else."), false);
  assert.deepEqual(h.getExercises(), ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'], 'sync path leaves it for the async handler');
});
