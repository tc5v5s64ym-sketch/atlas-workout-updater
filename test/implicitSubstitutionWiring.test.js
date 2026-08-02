'use strict';

// Production bug (2026-07-11): with Back Squat active, "I don't want to do squats,
// give me something else." marked Back Squat SKIPPED and advanced to the next
// exercise. The decline lane emitted { action:'skip' }; the fix classifies an
// implicit substitution and wires it to the deterministic recommender.
//
// F-SB3 (owner ruling 2026-08-02) changed WHAT that lane does. It used to apply the
// swap immediately, so an engine recommendation and an accepted decision were the same
// event — a second acceptance model beside the gated proposal. It now stages the ONE
// pending proposal and mutates nothing; acceptance is what mutates, through the single
// applySessionSubstitution transition.
//
// End-to-end harness (mirrors planSkipWiring): slice the real
// applySessionSubstitution → … → tryProposeImplicitSubstitution block out of the built
// public/app.js and drive it in Node with the REAL planMutationIntent +
// activeReplacement modules and a STUBBED /api/suggest-substitute (the server
// recommender is exercised in its own unit + route tests; here we prove the WIRING,
// the no-mutation guarantee, and the acceptance transition).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STORE_SHIM } = require('./helpers/storeShim');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

let planMutationIntent;
let activeReplacement;
test.before(async () => {
  planMutationIntent = await import('../src/app/planMutationIntent.js');
  activeReplacement = await import('../src/app/activeReplacement.js');
});

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
  assert.ok(slice.includes('function tryProposeImplicitSubstitution('), 'slice must contain tryProposeImplicitSubstitution');
  assert.ok(slice.includes('function tryApplyPlanMutation('), 'slice must contain tryApplyPlanMutation');

  const events = [];
  const fakeDoc = { getElementById: () => null, dispatchEvent: evt => events.push(evt) };
  const fakeWindow = { planMutationIntent, activeReplacement };
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
      tryProposeImplicitSubstitution,
      tryApplyPlanMutation,
      approvePendingReplacement,
      getProposal: () => getPendingReplacement(),
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

test('E2E: "I don\'t want to do squats, give me something else." PROPOSES a substitute and mutates nothing', async () => {
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());

  const handled = await h.tryProposeImplicitSubstitution("I don't want to do squats, give me something else.");

  assert.equal(handled, true, 'the implicit substitution is handled deterministically');
  // F-SB3 requirement A — the plan is UNTOUCHED. Back Squat stays, and stays current.
  assert.deepEqual(h.getExercises(), ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'],
    'the recommendation mutates nothing');
  assert.equal(h.getCurrent(), 'Back Squat', 'the declined lift is still the active exercise until acceptance');
  assert.notEqual(h.getSlot(1).reason, 'substituted', 'no slot is marked substituted before acceptance');

  // ONE bounded pending proposal names both sides of the swap.
  const proposal = h.getProposal();
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.source.name, 'Back Squat');
  assert.equal(proposal.replacement.name, 'Leg Press');
  assert.ok(!/something/i.test(proposal.replacement.name), 'no literal "something else" replacement');

  // The deterministic recommender was consulted for the real target with the intent signal.
  assert.equal(apiState.calls.length, 1);
  assert.equal(apiState.calls[0].path, '/api/suggest-substitute');
  assert.equal(apiState.calls[0].body.current_exercise, 'Back Squat');
  assert.equal(apiState.calls[0].body.intent, 'substitute');

  // The proposal is SURFACED with the Approve / Keep-it affordance, and the prose carries
  // no completed-mutation claim (requirement A).
  const proposed = h.getEvents().filter(e => e.type === 'atlas:replacement-proposed');
  assert.equal(proposed.length, 1, 'exactly one proposal is surfaced');
  assert.match(proposed[0].detail.line, /Replace Back Squat with Leg Press/);
  assert.ok(!/\b(swapped|replaced|noted|updated|changed)\b/i.test(proposed[0].detail.line),
    'a recommendation never claims a completed swap');
  assert.equal(h.getEvents().filter(e => e.type === 'atlas:plan-mutated').length, 0,
    'nothing is announced as mutated');
});

test('E2E: ACCEPTANCE applies the swap in place, exactly once, and only then claims success', async () => {
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  await h.tryProposeImplicitSubstitution("I don't want to do squats, give me something else.");

  assert.equal(h.approvePendingReplacement(), true);

  const names = h.getExercises();
  assert.deepEqual(names, ['Romanian Deadlift', 'Leg Press', 'Single-Leg Seated Leg Press', 'Seated Row'],
    'the substitute takes the SAME planned position; remaining order preserved');
  assert.ok(!names.includes('Back Squat'), 'the source leaves remaining work');
  assert.equal(h.getSlot(1).reason, 'substituted', 'the slot is marked substituted, not skipped');
  assert.equal(h.getCurrent(), 'Leg Press', 'the substitute is now the active exercise');
  assert.ok(
    h.getEvents().some(e => e.type === 'atlas:plan-mutated' && /Replaced Back Squat with Leg Press/.test(e.detail.summary)),
    'the success claim comes AFTER the canonical mutation succeeded'
  );
  assert.equal(h.getProposal(), null, 'the proposal is consumed');

  // Idempotent: a second acceptance cannot re-apply or re-claim.
  const before = h.getEvents().length;
  assert.equal(h.approvePendingReplacement(), false, 'no proposal left to accept');
  assert.equal(h.getEvents().length, before, 'nothing further is announced');
});

test('E2E control: no known substitute → falls through (nothing mutated), coach handles it', async () => {
  const apiState = { recommendation: null, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());

  const handled = await h.tryProposeImplicitSubstitution("I don't want to do squats, give me something else.");

  assert.equal(handled, false, 'no substitute → not handled here');
  assert.deepEqual(h.getExercises(), ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'], 'plan unchanged');
  assert.equal(h.getProposal(), null, 'nothing staged');
  assert.equal(h.getEvents().length, 0, 'nothing announced');
});

test('E2E control: duplicate-substitute follows existing governing behavior on ACCEPTANCE (dedupe splice)', async () => {
  // The recommender returns a lift already in the plan (Seated Row). Proposing it changes
  // nothing; accepting it hits the existing applySessionSubstitution dedupe, which removes
  // the Back Squat slot rather than duplicating Seated Row.
  const apiState = { recommendation: { recommendation: 'Seated Row', quality: 'acceptable', reason: 'x', next_target: null }, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());

  assert.equal(await h.tryProposeImplicitSubstitution("I don't want to do squats, give me something else."), true);
  assert.ok(h.getExercises().includes('Back Squat'), 'still untouched while pending');

  assert.equal(h.approvePendingReplacement(), true);
  const names = h.getExercises();
  assert.ok(!names.includes('Back Squat'), 'Back Squat slot removed');
  assert.equal(names.filter(n => n === 'Seated Row').length, 1, 'Seated Row is not duplicated (dedupe)');
  assert.deepEqual(names, ['Romanian Deadlift', 'Single-Leg Seated Leg Press', 'Seated Row']);
});

test('E2E control: a non-substitution message is not handled here', async () => {
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(await h.tryProposeImplicitSubstitution('how many reps should I do?'), false);
  assert.equal(apiState.calls.length, 0, 'the recommender is never consulted for a non-mutation');
  assert.equal(h.getProposal(), null);
});

test('E2E control: a TRUE skip still applies via the sync path; an explicit REPLACE is now gated (deferred)', () => {
  // "Skip back squats" — deterministic skip removes the slot (Back Squat gone, order kept).
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  let h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(h.tryApplyPlanMutation('Skip back squats'), true);
  assert.deepEqual(h.getExercises(), ['Romanian Deadlift', 'Single-Leg Seated Leg Press', 'Seated Row'], 'true skip removes only Back Squat');

  // "I don't want to do squats today" — governed PR-I2 decline still a true skip. A deliberate
  // skip stays DISTINCT from a substitution (F-SB3 negative test).
  h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(h.tryApplyPlanMutation("I don't want to do squats today"), true);
  assert.ok(!h.getExercises().includes('Back Squat'), 'plain decline still skips Back Squat');
  assert.equal(h.getProposal(), null, 'a skip never stages a substitution proposal');

  // "Swap back squats for leg press" — an explicit REPLACE is NO LONGER applied by the sync
  // skip lane (production trust fix FR-20260723031748: a direct replacement is a GATED
  // proposal, so the source must not be mutated here). tryApplyPlanMutation defers it.
  h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  assert.equal(h.tryApplyPlanMutation('swap back squats for leg press'), false, 'an explicit replace is deferred to the gated proposer');
  assert.ok(h.getExercises().includes('Back Squat'), 'Back Squat is NOT removed by the sync lane — it stays until approval');
});

test('E2E control: the sync mutation path DEFERS an implicit substitution (returns false)', () => {
  const apiState = { recommendation: LEG_PRESS_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());
  // tryApplyPlanMutation must NOT try to handle the 'substitute' action itself.
  assert.equal(h.tryApplyPlanMutation("I don't want to do squats, give me something else."), false);
  assert.deepEqual(h.getExercises(), ['Romanian Deadlift', 'Back Squat', 'Single-Leg Seated Leg Press', 'Seated Row'], 'sync path leaves it for the async handler');
});

// ── Context-aware substitution (live evidence 2026-07-11) ────────────────────
// The implicit substitution must send the remaining plan so the engine avoids a
// substitute that is redundant with the next slot (Single-Leg Seated Leg Press),
// and the returned NON-redundant pick (Goblet Squat) is what gets proposed and applied.
const GOBLET_REC = { recommendation: 'Goblet Squat', quality: 'acceptable', reason: 'Preserves the squat pattern with a lighter compound alternative.', next_target: null };

test('E2E context-aware: sends remaining_plan (next slot first) and proposes the non-redundant substitute', async () => {
  const apiState = { recommendation: GOBLET_REC, calls: [] };
  const h = loadHarness(apiState);
  h.setActivePlannedSession(fourExercisePlan());

  const handled = await h.tryProposeImplicitSubstitution("I don't want to do squats, give me something else.");

  assert.equal(handled, true);
  // The client forwarded the remaining workout (the next slot included) as context.
  assert.equal(apiState.calls.length, 1);
  assert.deepEqual(apiState.calls[0].body.remaining_plan, ['Single-Leg Seated Leg Press', 'Seated Row'],
    'remaining plan (after Back Squat) is sent so the engine can avoid redundancy');
  assert.equal(apiState.calls[0].body.current_exercise, 'Back Squat');
  assert.equal(h.getProposal().replacement.name, 'Goblet Squat', 'the non-redundant pick is what is proposed');

  // On acceptance it replaces Back Squat in place, becomes active, and the "…Leg Press"
  // neighbor is untouched (not duplicated).
  assert.equal(h.approvePendingReplacement(), true);
  const names = h.getExercises();
  assert.deepEqual(names, ['Romanian Deadlift', 'Goblet Squat', 'Single-Leg Seated Leg Press', 'Seated Row']);
  assert.ok(!names.includes('Back Squat'), 'Back Squat replaced, not skipped');
  assert.ok(!names.includes('Leg Press'), 'the redundant leg-press family is not what got inserted');
  assert.equal(h.getCurrent(), 'Goblet Squat', 'the non-redundant substitute is active');
  assert.ok(
    h.getEvents().some(e => e.type === 'atlas:plan-mutated' && /Replaced Back Squat with Goblet Squat/.test(e.detail.summary)),
    'the confirmation names the actual (non-redundant) replacement'
  );
});
