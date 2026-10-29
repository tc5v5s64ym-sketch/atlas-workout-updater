'use strict';

// F-SB4 Session 3, second scored FAIL (run fsb4b-s3-20261029T082343-D0E7E0) —
// plan_state.completed semantics at the client/server contract seam.
//
// Ground truth at the "What do I have left?" ask: Incline DB Press 2/3 sets and
// Seated Row 1/2 sets logged, so remaining was [Incline DB Press, Seated Row,
// Bicep Curl]. The engine answered [Bicep Curl]. Cause: the client assembled
// plan_state with `remaining` from the multiplicity-aware slot selector but
// `completed` from getSessionCompleted() — every exercise with >=1 logged set.
// The server contract reads plan_state.completed as prescription-complete
// ("plan_state.completed always wins" — services/coachResponseGrounding.js
// completedExerciseKeys) and subtracts it from remaining, so the two partially
// logged lifts, forwarded in BOTH lists, dropped out of remaining.
//
// Fix pinned here: plan_state.completed is forwarded as the SELECTOR's
// completed-slot verdict (completedSlotNames — fully-complete slots only),
// mirroring how `remaining` is already forwarded. plan_completed (the legacy
// field), the atlas:set-logged handoff event, and every client surface keep
// the >=1-set getSessionCompleted() list from its existing source, unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { planStateFromContext } = require('../services/sessionPlanExecutor');
const grounding = require('../services/coachResponseGrounding');

let S;
test.before(async () => { S = await import('../src/app/planSlotStatuses.js'); });

// ── The run, reconstructed ────────────────────────────────────────────────────
// Post-substitution active plan (the Bench Press slot retains its plan_item_id
// and carries the substitute identity + the staged 3-set prescription).
const ACTIVE_PLAN = {
  exercises: [
    { name: 'Back Squat', canonicalName: 'Back Squat', liftCode: 'BSQ01', plan_item_id: 'pi_bsq', sets: 2 },
    { name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01', plan_item_id: 'pi_ohp', sets: 2 },
    { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01', plan_item_id: 'pi_rdl', sets: 2 },
    { name: 'Incline DB Press', canonicalName: 'Incline DB Press', liftCode: 'IDP01', plan_item_id: 'pi_bench', sets: 3 },
    { name: 'Seated Row', canonicalName: 'Seated Row', liftCode: 'SRW01', plan_item_id: 'pi_row', sets: 2 },
    { name: 'Bicep Curl', canonicalName: 'Bicep Curl', liftCode: 'BCP01', plan_item_id: 'pi_curl', sets: 2 },
  ],
  items: [],
};
const PLANNED = ACTIVE_PLAN.exercises.map(e => e.name);
const CURRENT_PLAN = ACTIVE_PLAN.exercises.map(e => ({ name: e.name, sets: e.sets }));

// getSessionCompleted() at the ask — name-deduped, every exercise with >=1
// logged set, resolved identities, log order (Face Pull is off-plan work).
const ANY_SET_COMPLETED = ['Back Squat', 'Overhead Press', 'Romanian Deadlift', 'Seated Row', 'Incline DB Press', 'Face Pull'];

// The per-set session log at the ask, in the shape app.js pushes it (raw
// exercise + resolved canonical identity). Incline 2/3, Seated Row 1/2.
const row = (exercise, canonical) => ({ exercise, canonical: canonical || exercise, weight: 100, reps: 5, rir: 2 });
const SESSION_LOG = [
  row('Back Squat'), row('Back Squat'),
  row('Overhead Press'), row('Overhead Press'),
  row('RDL', 'Romanian Deadlift'), row('RDL', 'Romanian Deadlift'),
  row('Seated Row'),
  row('Incline DB Press'), row('Incline DB Press'),
  row('Face Pull'),
];

// The client session_tally for the same buffer (raw spellings — the deadlift
// tallies as "RDL", exactly as in the served reply).
const SESSION_TALLY = {
  exercises: [
    { exercise: 'Back Squat', sets: 2 },
    { exercise: 'Overhead Press', sets: 2 },
    { exercise: 'RDL', sets: 2 },
    { exercise: 'Seated Row', sets: 1 },
    { exercise: 'Incline DB Press', sets: 2 },
    { exercise: 'Face Pull', sets: 1 },
  ],
  total_working_sets: 10,
};

// The route's derivation, exactly as routeMessageToCoach assembles it: planned
// from the canonical order, remaining + completed from the ONE selector.
function assembleClientContext(completed) {
  const remaining = S.remainingSlotNames(ACTIVE_PLAN, ANY_SET_COMPLETED, SESSION_LOG);
  const plan_state = { planned: PLANNED, completed, remaining, isComplete: remaining.length === 0 };
  return {
    plan_state: planStateFromContext({ current_plan: CURRENT_PLAN, plan_completed: ANY_SET_COMPLETED, plan_state }),
    current_plan: CURRENT_PLAN,
    session_tally: SESSION_TALLY,
  };
}

// ── Pin 1 — the selector verdict on the reconstructed run ────────────────────

test('pin 1: completedSlotNames returns only the fully-complete slots of the failed run', () => {
  const completed = S.completedSlotNames(ACTIVE_PLAN, ANY_SET_COMPLETED, SESSION_LOG);
  assert.deepEqual(completed, ['Back Squat', 'Overhead Press', 'Romanian Deadlift'],
    'prescription-complete slots only — the partially logged Incline (2/3) and Seated Row (1/2) are NOT completed');
  const remaining = S.remainingSlotNames(ACTIVE_PLAN, ANY_SET_COMPLETED, SESSION_LOG);
  assert.deepEqual(remaining, ['Incline DB Press', 'Seated Row', 'Bicep Curl']);
  assert.deepEqual(completed.filter(n => remaining.includes(n)), [],
    'completed and remaining are disjoint under the selector verdict');
  const incline = S.planSlotStatuses(ACTIVE_PLAN, ANY_SET_COMPLETED, SESSION_LOG)
    .find(s => s.name === 'Incline DB Press');
  assert.equal(incline.status, 'pending');
  assert.equal(incline.performedSets, 2);
  assert.equal(incline.requiredSets, 3);
});

// ── Pin 2 — the grounded statement over the client-assembled context ─────────

test('pin 2 (bug reproduced): the BASE assembly (>=1-set completed) makes the statement drop the partial lifts', () => {
  const stmt = grounding.buildGroundedSessionStateStatement(assembleClientContext([...ANY_SET_COMPLETED]));
  assert.equal(stmt,
    'Logged this session: Back Squat, Overhead Press, RDL, Seated Row, Incline DB Press, Face Pull. ' +
    'Still remaining: Bicep Curl. ' +
    'Those are still planned, not done — nothing counts as completed until it\'s logged.',
    'the served reply of run D0E7E0, byte-for-byte (206 chars)');
  assert.equal(stmt.length, 206);
});

test('pin 2: the FIXED assembly (selector completed) names the true remaining lifts', () => {
  const completed = S.completedSlotNames(ACTIVE_PLAN, ANY_SET_COMPLETED, SESSION_LOG);
  const stmt = grounding.buildGroundedSessionStateStatement(assembleClientContext(completed));
  assert.equal(stmt,
    'Logged this session: Back Squat, Overhead Press, RDL, Seated Row, Incline DB Press, Face Pull. ' +
    'Still remaining: Incline DB Press, Seated Row, Bicep Curl. ' +
    'Those are still planned, not done — nothing counts as completed until it\'s logged.');
});

test('pin 2 (wiring): routeMessageToCoach forwards plan_state.completed from the selector helper', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'app.js'), 'utf8');
  const start = appSrc.indexOf('function routeMessageToCoach(');
  const block = appSrc.slice(start, start + 3000);
  assert.match(block, /context\.plan_state = \{/, 'routeMessageToCoach sends plan_state');
  const psBlock = block.slice(block.indexOf('context.plan_state = {'), block.indexOf('};', block.indexOf('context.plan_state = {')));
  assert.match(psBlock, /completed: completedPlannedExercises\(\)/,
    'plan_state.completed is the selector completed-slot verdict');
  assert.doesNotMatch(psBlock, /getSessionCompleted\(\)/,
    'plan_state.completed no longer sources the >=1-set list');
  assert.match(block, /const remaining = remainingPlannedExercises\(\)/, 'remaining still derives from the ONE selector');
});

// ── Pin 3 — no drift for the legitimate >=1-set consumers ────────────────────

test('pin 3a: a fully-logged session produces a byte-identical statement under both assemblies', () => {
  const fullLog = [
    row('Back Squat'), row('Back Squat'),
    row('Overhead Press'), row('Overhead Press'),
    row('RDL', 'Romanian Deadlift'), row('RDL', 'Romanian Deadlift'),
    row('Incline DB Press'), row('Incline DB Press'), row('Incline DB Press'),
    row('Seated Row'), row('Seated Row'),
    row('Bicep Curl'), row('Bicep Curl'),
  ];
  const allCompleted = ['Back Squat', 'Overhead Press', 'Romanian Deadlift', 'Incline DB Press', 'Seated Row', 'Bicep Curl'];
  assert.deepEqual(S.completedSlotNames(ACTIVE_PLAN, allCompleted, fullLog), allCompleted,
    'when every logged lift is fully complete, the selector verdict equals the >=1-set list (plan order)');
  assert.deepEqual(S.remainingSlotNames(ACTIVE_PLAN, allCompleted, fullLog), []);
  const mk = (completed) => {
    const remaining = S.remainingSlotNames(ACTIVE_PLAN, allCompleted, fullLog);
    const plan_state = { planned: PLANNED, completed, remaining, isComplete: remaining.length === 0 };
    return grounding.buildGroundedSessionStateStatement({
      plan_state: planStateFromContext({ current_plan: CURRENT_PLAN, plan_completed: allCompleted, plan_state }),
      current_plan: CURRENT_PLAN,
      session_tally: SESSION_TALLY,
    });
  };
  const oldStmt = mk([...allCompleted]);
  const newStmt = mk(S.completedSlotNames(ACTIVE_PLAN, allCompleted, fullLog));
  assert.equal(newStmt, oldStmt, 'no drift when nothing is partially logged');
});

test('pin 3b: the >=1-set list still reaches its legitimate consumers from its existing sources', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'app.js'), 'utf8');
  const start = appSrc.indexOf('function routeMessageToCoach(');
  const block = appSrc.slice(start, start + 3000);
  // (i) the legacy plan_completed field — computePlanState's input — is unchanged.
  assert.match(block, /context\.plan_completed = \[\.\.\.getSessionCompleted\(\)\]/,
    'plan_completed keeps the >=1-set list');
  // (ii) the atlas:set-logged handoff event still carries the >=1-set list so the
  // handoff can reject a next-up that has any logged work.
  const evStart = appSrc.indexOf("dispatchEvent(new CustomEvent('atlas:set-logged'");
  assert.ok(evStart !== -1, 'the atlas:set-logged dispatch site exists');
  const evBlock = appSrc.slice(evStart, evStart + 2500);
  assert.match(evBlock, /completed: \[\.\.\.getSessionCompleted\(\)\]/,
    'the set-logged handoff event keeps the >=1-set list');
});

test('pin 3c: the legacy server path (plan_completed only, no plan_state) keeps >=1-set semantics', () => {
  const ps = planStateFromContext({
    current_plan: [{ name: 'Back Squat' }, { name: 'Seated Row' }],
    plan_completed: ['Back Squat'],
  });
  assert.deepEqual(ps.completed, ['Back Squat']);
  assert.deepEqual(ps.remaining, ['Seated Row']);
});
