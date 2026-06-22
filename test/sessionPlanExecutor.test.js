'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const { computePlanState, nextExerciseFromPlan, nextRemainingExercise, isPlanComplete, applySubstitution, planStateFromContext, detectSessionCloseQuestion, buildSessionCloseAnswer } = require('../services/sessionPlanExecutor');

/* ===== Shape ===== */

test('computePlanState: returns object with planned, completed, remaining, isComplete', () => {
  const s = computePlanState(['Bench', 'Rows'], []);
  assert.ok('planned'    in s);
  assert.ok('completed'  in s);
  assert.ok('remaining'  in s);
  assert.ok('isComplete' in s);
});

/* ===== Empty / guard cases ===== */

test('computePlanState: empty planned and completed → all arrays empty, isComplete false', () => {
  const s = computePlanState([], []);
  assert.deepEqual(s.planned,   []);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, false);
});

test('computePlanState: null planned → treated as empty', () => {
  const s = computePlanState(null, []);
  assert.deepEqual(s.planned, []);
  assert.equal(s.isComplete, false);
});

test('computePlanState: null completed → treated as empty', () => {
  const s = computePlanState(['Bench'], null);
  assert.deepEqual(s.remaining, ['Bench']);
  assert.equal(s.isComplete, false);
});

test('computePlanState: non-string entries in planned are silently dropped', () => {
  const s = computePlanState([null, 42, 'Bench', undefined, ''], []);
  assert.deepEqual(s.planned,   ['Bench']);
  assert.deepEqual(s.remaining, ['Bench']);
});

test('computePlanState: non-string entries in completed are silently dropped', () => {
  const s = computePlanState(['Bench'], [null, 42, undefined, '']);
  assert.deepEqual(s.remaining, ['Bench']);
});

test('computePlanState: whitespace-only strings are dropped from both lists', () => {
  const s = computePlanState(['   ', 'Bench'], ['   ']);
  assert.deepEqual(s.planned, ['Bench']);
  assert.equal(s.isComplete, false);
});

/* ===== Core behaviour ===== */

test('computePlanState: no completions → all planned are remaining', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows', 'Face Pull'], []);
  assert.deepEqual(s.remaining, ['Lat Pulldown', 'Rows', 'Face Pull']);
  assert.equal(s.isComplete, false);
});

test('computePlanState: all exercises completed → remaining is empty, isComplete true', () => {
  const s = computePlanState(['Bench', 'Rows'], ['Bench', 'Rows']);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

test('computePlanState: one of two exercises completed → remaining contains the other', () => {
  const s = computePlanState(['Bench', 'Rows'], ['Bench']);
  assert.deepEqual(s.remaining, ['Rows']);
  assert.equal(s.isComplete, false);
});

/* ===== Acceptance scenario (PR 357) ===== */

test('acceptance: plan=[Lat Pulldown, Rows], completed=[Rows] → Lat Pulldown remains, isComplete false', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows'], ['Rows']);
  assert.deepEqual(s.remaining, ['Lat Pulldown']);
  assert.deepEqual(s.completed, ['Rows']);
  assert.equal(s.isComplete, false);
});

test('acceptance: completing Lat Pulldown after Rows → session is complete', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows'], ['Rows', 'Lat Pulldown']);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

/* ===== Case-insensitivity ===== */

test('computePlanState: matching is case-insensitive', () => {
  const s = computePlanState(['Lat Pulldown', 'Rows'], ['lat pulldown']);
  assert.deepEqual(s.remaining, ['Rows']);
});

test('computePlanState: mixed-case completed matches planned regardless of casing', () => {
  const s = computePlanState(['Bench Press', 'Deadlift'], ['BENCH PRESS', 'deadlift']);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

/* ===== Ordering preservation ===== */

test('computePlanState: remaining preserves the original planned order', () => {
  const s = computePlanState(['Squat', 'Bench', 'Deadlift', 'Rows'], ['Bench']);
  assert.deepEqual(s.remaining, ['Squat', 'Deadlift', 'Rows']);
});

/* ===== Extras in completed (user-added exercises not in plan) ===== */

test('computePlanState: completed may include exercises not in planned (added work) — remaining unaffected', () => {
  const s = computePlanState(['Bench', 'Rows'], ['Bench', 'Shrugs']);
  assert.deepEqual(s.remaining, ['Rows']);
  assert.ok(s.completed.includes('Shrugs'));
});

/* ===== isComplete edge cases ===== */

test('computePlanState: empty planned list is NOT isComplete even with non-empty completed', () => {
  const s = computePlanState([], ['Bench', 'Rows']);
  assert.equal(s.isComplete, false);
});

test('computePlanState: single exercise plan, not yet done → isComplete false', () => {
  const s = computePlanState(['Deadlift'], []);
  assert.equal(s.isComplete, false);
});

test('computePlanState: single exercise plan, completed → isComplete true', () => {
  const s = computePlanState(['Deadlift'], ['Deadlift']);
  assert.equal(s.isComplete, true);
});

// ---------------------------------------------------------------------------
// Fix #1 — API plan authority (PR 360 review)
//
// nextExerciseFromPlan replicates the lookup block in getNextExerciseInPlan
// (public/coach-conversation.js). When an exercise IS found in the API plan,
// that match is authoritative: the last entry returns null (no handoff) and
// the fallback to activePlannedSession must NOT be consulted. Only when no
// match exists (found:false) should the caller use its fallback.
// ---------------------------------------------------------------------------

test('Fix #1: final exercise in API plan → found:true, next:null (no spurious handoff)', () => {
  // Regression for the bug where idx===keys.length-1 fell through to the
  // activePlannedSession fallback and could announce a false "Moving on" prompt.
  const map = new Map([
    ['bench press',   { exercise_name: 'Bench Press' }],
    ['lat pulldown',  { exercise_name: 'Lat Pulldown' }],
    ['lateral raise', { exercise_name: 'Lateral Raise' }],
  ]);
  const result = nextExerciseFromPlan(map, 'lateral raise');
  assert.equal(result.found, true, 'last exercise must be found');
  assert.equal(result.next, null, 'last exercise must produce no handoff (null next)');
});

test('Fix #1: middle exercise in API plan → found:true, next is the following entry', () => {
  const map = new Map([
    ['bench press',   { exercise_name: 'Bench Press' }],
    ['lat pulldown',  { exercise_name: 'Lat Pulldown' }],
    ['lateral raise', { exercise_name: 'Lateral Raise' }],
  ]);
  const result = nextExerciseFromPlan(map, 'bench press');
  assert.equal(result.found, true);
  assert.equal(result.next, 'Lat Pulldown');
});

test('Fix #1: exercise NOT in API plan → found:false (fallback must run)', () => {
  // When no match exists, getNextExerciseInPlan must fall back to
  // activePlannedSession. The found:false signal triggers that branch.
  const map = new Map([
    ['bench press',   { exercise_name: 'Bench Press' }],
    ['lat pulldown',  { exercise_name: 'Lat Pulldown' }],
  ]);
  const result = nextExerciseFromPlan(map, 'deadlift');
  assert.equal(result.found, false, 'unmatched exercise must signal fallback');
  assert.equal('next' in result, false, 'no next field when not found');
});

test('Fix #1: empty map → found:false (fallback must run)', () => {
  const result = nextExerciseFromPlan(new Map(), 'Bench Press');
  assert.equal(result.found, false);
});

test('Fix #1: null map → found:false (fallback must run)', () => {
  const result = nextExerciseFromPlan(null, 'Bench Press');
  assert.equal(result.found, false);
});

// ---------------------------------------------------------------------------
// Fix #2 — Completion identity alignment (PR 360 review)
//
// currentPlanForChat() emits {name: canonical_exercise || exercise} — canonical
// name first. The server's buildChatContext uses those names as planNames for
// computePlanState. resolveCompletedIdentity must write the SAME canonical name
// into sessionCompleted so computePlanState can match them.
//
// Scenario: plan entry display name = "Rows", canonical_exercise = "Barbell Row".
//   currentPlanForChat emits:  { name: 'Barbell Row' }   (canonical_exercise wins)
//   resolveCompletedIdentity returns: 'Barbell Row'       (canonicalName || name)
//   sessionCompleted = ['Barbell Row']
//   computePlanState(['Barbell Row'], ['Barbell Row']) → isComplete:true
//
// The test below validates the computePlanState side of this chain — that when
// planned names use canonical_exercise, a matching completed entry marks it done.
// ---------------------------------------------------------------------------

test('Fix #2: canonical name in plan_names matches canonical name in plan_completed → isComplete true', () => {
  // currentPlanForChat emits canonical_exercise ('Barbell Row'), not display name ('Rows').
  // sessionCompleted must carry the same canonical string.
  const planNames     = ['Barbell Row'];   // from currentPlanForChat → canonical_exercise
  const sessionCompleted = ['Barbell Row']; // from resolveCompletedIdentity → canonicalName
  const s = computePlanState(planNames, sessionCompleted);
  assert.deepEqual(s.remaining, [], 'canonical names must match end-to-end');
  assert.equal(s.isComplete, true);
});

test('Fix #2: display name in plan_completed does NOT match canonical name in plan_names (the bug this fixes)', () => {
  // Before the fix, resolveCompletedIdentity returned match.name (display name: 'Rows')
  // while currentPlanForChat emitted canonical_exercise ('Barbell Row').
  // Those strings don't match → exercise never marked complete.
  const planNames        = ['Barbell Row'];  // canonical (from currentPlanForChat)
  const sessionCompleted = ['Rows'];         // display name (pre-fix value) — WRONG
  const s = computePlanState(planNames, sessionCompleted);
  assert.deepEqual(s.remaining, ['Barbell Row'], 'display name must NOT match canonical — this was the bug');
  assert.equal(s.isComplete, false);
});

test('Fix #2: lift_code match bridges display-name vs canonical-name mismatch in computePlanState', () => {
  // When both plan entry and completed entry carry the same lift_code, computePlanState
  // can bridge the name mismatch. This is the object-input path (PR 358b).
  const planned   = [{ name: 'Rows', liftCode: 'barbell_row' }];
  const completed = [{ name: 'Barbell Row', liftCode: 'barbell_row' }];
  const s = computePlanState(planned, completed);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

// ---------------------------------------------------------------------------
// PR 364 — Out-of-order session closeout
//
// Bug: plan [A, B, C], user logs A then C (skipping B) then B. After B the
// full plan is done, but `getNextExerciseInPlan('B')` returns C (next in plan
// order) — a completed exercise — and Atlas showed "Moving on — next up: C"
// instead of the session closeout.
//
// Fix: check planNowComplete (all planned names present in sessionCompleted)
// BEFORE the handoff. These tests verify the computePlanState / isPlanComplete
// side of that contract; the browser-side check in coach-conversation.js
// mirrors this logic inline.
// ---------------------------------------------------------------------------

test('PR 364: out-of-order A→C→B: after all three, plan [A,B,C] is complete', () => {
  const s = computePlanState(['A', 'B', 'C'], ['A', 'C', 'B']);
  assert.deepEqual(s.remaining, []);
  assert.equal(s.isComplete, true);
});

test('PR 364: out-of-order A→C: plan [A,B,C] is NOT yet complete', () => {
  const s = computePlanState(['A', 'B', 'C'], ['A', 'C']);
  assert.deepEqual(s.remaining, ['B']);
  assert.equal(s.isComplete, false);
});

test('PR 364: isPlanComplete — plan [A,B,C] completed out of order as [A,C,B] → true', () => {
  assert.equal(isPlanComplete(['A', 'B', 'C'], ['A', 'C', 'B']), true);
});

test('PR 364: isPlanComplete — plan [A,B,C] with only A and C done → false', () => {
  assert.equal(isPlanComplete(['A', 'B', 'C'], ['A', 'C']), false);
});

test('PR 364: isPlanComplete — empty planned list → false (no closeout without a plan)', () => {
  assert.equal(isPlanComplete([], ['A', 'B', 'C']), false);
});

/* ===== Step 372: applySubstitution — in-session swap updates session state ===== */

// The headline app-test failure: planned Lat Pulldown, user says "Lat bar is
// taken so I'll do seated rows instead". Once accepted, the planned session
// state must mark Lat Pulldown as substituted and Seated Row as the active slot.
test('applySubstitution: Lat Pulldown → Seated Row is accepted and recorded', () => {
  const planned = ['Bench Press', 'Lat Pulldown', 'Leg Curl'];
  const r = applySubstitution(planned, 'Lat Pulldown', 'Seated Row');
  assert.equal(r.applied, true);
  assert.deepEqual(r.substituted, [{ from: 'Lat Pulldown', to: 'Seated Row' }]);
  // Seated Row occupies the prescribed slot, order preserved.
  assert.deepEqual(r.planned.map(p => p.name), ['Bench Press', 'Seated Row', 'Leg Curl']);
});

test('applySubstitution: prescribed exercise is no longer shown as remaining', () => {
  const r = applySubstitution(['Bench Press', 'Lat Pulldown', 'Leg Curl'], 'Lat Pulldown', 'Seated Row');
  const state = computePlanState(r.planned, []);
  assert.ok(!state.remaining.includes('Lat Pulldown'), 'Lat Pulldown must drop out of remaining');
  assert.ok(state.remaining.includes('Seated Row'), 'Seated Row must appear in remaining until logged');
});

test('applySubstitution: logging the substitute advances the session correctly', () => {
  const r = applySubstitution(['Bench Press', 'Lat Pulldown', 'Leg Curl'], 'Lat Pulldown', 'Seated Row');
  // User logs the Seated Row → it is completed; the swapped-out lift never returns.
  const after = computePlanState(r.planned, ['Seated Row']);
  assert.ok(!after.remaining.includes('Seated Row'), 'logged substitute must leave remaining');
  assert.ok(!after.remaining.includes('Lat Pulldown'), 'swapped-out lift must never reappear');
  assert.deepEqual(after.remaining, ['Bench Press', 'Leg Curl']);
  assert.equal(after.isComplete, false);
});

test('applySubstitution: substitute liftCode rides along so a differently-named log still matches', () => {
  // Plan slot becomes Seated Row w/ code CSR01; user later logs it canonicalised
  // as "Cable Seated Row" carrying the same code → computePlanState marks it done.
  const r = applySubstitution(['Lat Pulldown'], 'Lat Pulldown', { name: 'Seated Row', liftCode: 'CSR01' });
  assert.equal(r.applied, true);
  const after = computePlanState(r.planned, [{ name: 'Cable Seated Row', liftCode: 'CSR01' }]);
  assert.equal(after.isComplete, true, 'liftCode identity must close the substituted slot');
});

test('applySubstitution: matches the prescribed slot by liftCode when names differ', () => {
  const planned = [{ name: 'Rows', liftCode: 'LPD01' }];
  const r = applySubstitution(planned, { name: 'Lat Pulldown', liftCode: 'LPD01' }, 'Seated Row');
  assert.equal(r.applied, true);
  assert.deepEqual(r.planned.map(p => p.name), ['Seated Row']);
});

test('applySubstitution: prescribed not in plan → no-op (this is an add, not a swap)', () => {
  const r = applySubstitution(['Bench Press', 'Leg Curl'], 'Lat Pulldown', 'Seated Row');
  assert.equal(r.applied, false);
  assert.deepEqual(r.substituted, []);
  assert.deepEqual(r.planned.map(p => p.name), ['Bench Press', 'Leg Curl']);
});

test('applySubstitution: substitute identical to prescribed → no-op', () => {
  const r = applySubstitution(['Lat Pulldown'], 'Lat Pulldown', 'lat pulldown');
  assert.equal(r.applied, false);
  assert.deepEqual(r.substituted, []);
});

test('applySubstitution: blank prescribed or substitute → no-op', () => {
  assert.equal(applySubstitution(['Bench'], '', 'Rows').applied, false);
  assert.equal(applySubstitution(['Bench'], 'Bench', '').applied, false);
});

test('applySubstitution: does not mutate the input planned array', () => {
  const planned = ['Bench Press', 'Lat Pulldown'];
  const snapshot = JSON.parse(JSON.stringify(planned));
  applySubstitution(planned, 'Lat Pulldown', 'Seated Row');
  assert.deepEqual(planned, snapshot, 'input array must be untouched');
});

test('applySubstitution: sequential swaps compose (two slots substituted)', () => {
  const r1 = applySubstitution(['Lat Pulldown', 'Leg Curl'], 'Lat Pulldown', 'Seated Row');
  const r2 = applySubstitution(r1.planned, 'Leg Curl', 'Nordic Curl');
  assert.equal(r2.applied, true);
  assert.deepEqual(r2.planned.map(p => p.name), ['Seated Row', 'Nordic Curl']);
});

test('applySubstitution: substituting to an already-planned exercise does not duplicate it', () => {
  // CODEX Step 372 review: plan [Bench, Lat Pulldown], swap Lat Pulldown → Bench
  // must not yield [Bench, Bench] (one logged Bench would falsely close two slots).
  const r = applySubstitution(['Bench Press', 'Lat Pulldown'], 'Lat Pulldown', 'Bench Press');
  assert.equal(r.applied, true);
  assert.deepEqual(r.substituted, [{ from: 'Lat Pulldown', to: 'Bench Press' }]);
  assert.deepEqual(r.planned.map(p => p.name), ['Bench Press'], 'prescribed slot dropped, no duplicate');
  const state = computePlanState(r.planned, ['Bench Press']);
  assert.equal(state.isComplete, true);
  assert.deepEqual(state.remaining, []);
});

test('applySubstitution: dedupe guard also matches an existing slot by liftCode', () => {
  const planned = [{ name: 'Cable Row', liftCode: 'CSR01' }, { name: 'Lat Pulldown', liftCode: 'LPD01' }];
  const r = applySubstitution(planned, 'Lat Pulldown', { name: 'Seated Row', liftCode: 'CSR01' });
  assert.equal(r.applied, true);
  assert.deepEqual(r.planned.map(p => p.name), ['Cable Row'], 'liftCode dup dropped the prescribed slot');
});

/* ===== Step 373b: clampCursorAfterRemoval — live-session cursor follows a spliced slot ===== */

const { clampCursorAfterRemoval } = require('../services/sessionPlanExecutor');

test('clampCursorAfterRemoval: removing the current+last slot clamps the cursor in-bounds', () => {
  // The crash case: index === removedIdx === last (len 3 → newLength 2).
  // Naive `> idx` decrement misses (equal, not greater) → out of bounds.
  assert.equal(clampCursorAfterRemoval(2, 2, 2), 1);
});

test('clampCursorAfterRemoval: cursor after the removed slot shifts left by one', () => {
  assert.equal(clampCursorAfterRemoval(3, 1, 3), 2);
});

test('clampCursorAfterRemoval: cursor before the removed slot is unchanged', () => {
  assert.equal(clampCursorAfterRemoval(0, 2, 2), 0);
});

test('clampCursorAfterRemoval: cursor equal to a non-last removed slot is unchanged (next entry slides in)', () => {
  // plan [A,B,C], cursor on B (idx1), remove B → [A,C]; cursor 1 now points at C.
  assert.equal(clampCursorAfterRemoval(1, 1, 2), 1);
});

test('clampCursorAfterRemoval: empty result clamps to 0', () => {
  assert.equal(clampCursorAfterRemoval(0, 0, 0), 0);
});

test('clampCursorAfterRemoval: non-integer index defaults to 0', () => {
  assert.equal(clampCursorAfterRemoval(undefined, 0, 1), 0);
});

/* ===== Step 377 — planStateFromContext (shared gate) ===== */

test('step-377: planStateFromContext returns plan_state when current_plan + plan_completed ([]) are present', () => {
  const ps = planStateFromContext({
    current_plan: [{ name: 'Deadlift' }, { name: 'Lat Pulldown' }],
    plan_completed: []
  });
  assert.ok(ps, 'an empty plan_completed is authoritative — not null');
  assert.deepEqual(ps.remaining, ['Deadlift', 'Lat Pulldown']);
  assert.equal(ps.isComplete, false);
});

test('step-377: planStateFromContext gates to null when plan_completed is ABSENT (stale-data guard)', () => {
  const ps = planStateFromContext({
    current_plan: [{ name: 'Deadlift' }, { name: 'Lat Pulldown' }]
    // plan_completed intentionally missing
  });
  assert.equal(ps, null, 'no completed-tracking wired → no authoritative state');
});

test('step-377: planStateFromContext returns null when current_plan is empty', () => {
  assert.equal(planStateFromContext({ current_plan: [], plan_completed: [] }), null);
  assert.equal(planStateFromContext({}), null);
  assert.equal(planStateFromContext(null), null);
});

test('step-377: planStateFromContext accepts string plan entries and drops completed lifts', () => {
  const ps = planStateFromContext({
    current_plan: ['Deadlift', 'Lat Pulldown'],
    plan_completed: ['Deadlift']
  });
  assert.deepEqual(ps.remaining, ['Lat Pulldown']);
  assert.deepEqual(ps.completed, ['Deadlift']);
});

/* ===== Step 377 — detectSessionCloseQuestion ===== */

test('step-377: detectSessionCloseQuestion matches the named failure and close-question variants', () => {
  const yes = [
    'Ok so we are done?',
    'are we done?',
    'we done?',
    "we're done right",
    "I'm done",
    'am i done',
    'all done?',
    "that's it?",
    'thats everything',
    'is that all?',
    'is that everything',
    'are we finished?',
    'wrapped up?',
    'done for the day?'
  ];
  for (const m of yes) assert.equal(detectSessionCloseQuestion(m), true, `should detect: ${m}`);
});

test('step-377: detectSessionCloseQuestion does NOT fire on planning / logging messages', () => {
  const no = [
    'what should I do today?',
    'how is my bench trending?',
    'Bench 225 5/2 5/2',
    'lat pulldown machine is busy, doing rows next',
    'should I deload?',
    '',
    null
  ];
  for (const m of no) assert.equal(detectSessionCloseQuestion(m), false, `should NOT detect: ${m}`);
});

/* ===== Step 377 — buildSessionCloseAnswer ===== */

test('step-377: buildSessionCloseAnswer confirms a complete session and points at the save step', () => {
  const ps = computePlanState(['Deadlift', 'Lat Pulldown'], ['Deadlift', 'Lat Pulldown']);
  const ans = buildSessionCloseAnswer('Ok so we are done?', ps);
  assert.match(ans, /done/i);
  assert.match(ans, /2 exercises complete/i, 'names the completed count');
  assert.match(ans, /log it/i, 'points at the save step');
});

test('step-377: buildSessionCloseAnswer names the outstanding lifts when work remains', () => {
  const ps = computePlanState(['Deadlift', 'Lat Pulldown', 'Bench'], ['Deadlift']);
  const ans = buildSessionCloseAnswer('are we done?', ps);
  assert.match(ans, /not done/i);
  assert.match(ans, /Lat Pulldown/);
  assert.match(ans, /Bench/);
  assert.ok(!/Deadlift/.test(ans), 'completed lift is not listed as remaining');
});

test('step-377: buildSessionCloseAnswer singular grammar for one remaining / one complete', () => {
  const oneLeft = buildSessionCloseAnswer('done?', computePlanState(['Deadlift', 'Bench'], ['Deadlift']));
  assert.match(oneLeft, /1 still on your list/i);
  assert.match(oneLeft, /Knock it out/i);
  const oneDone = buildSessionCloseAnswer('done?', computePlanState(['Deadlift'], ['Deadlift']));
  assert.match(oneDone, /1 exercise complete/i, 'singular "exercise" for a one-lift plan');
});

test('step-377: buildSessionCloseAnswer returns null when the question is not a close question', () => {
  const ps = computePlanState(['Deadlift'], []);
  assert.equal(buildSessionCloseAnswer('what should I do today?', ps), null);
});

test('step-377: buildSessionCloseAnswer returns null when there is no authoritative plan state', () => {
  assert.equal(buildSessionCloseAnswer('are we done?', null), null);
  assert.equal(buildSessionCloseAnswer('are we done?', computePlanState([], [])), null, 'empty plan → no answer');
});

/* ===== nextRemainingExercise — next-up cursor (visible order, skip logged) ===== */
// Live bug (2026-06-21): after logging Bench, the handoff said "next up: Face Pull"
// (a later accessory) instead of Seated Row, because the old lookup used API-plan
// map order and never skipped already-logged lifts. Next-up must follow the
// VISIBLE planned order and point at the first UNLOGGED exercise.
const VISIBLE_PLAN = ['Bench Press', 'Seated Row', 'Weighted Dip', 'Lat Pulldown', 'Incline DB Press', 'Face Pull'];

test('nextRemainingExercise: after Bench is logged, next up is Seated Row (not a later accessory)', () => {
  assert.equal(nextRemainingExercise(VISIBLE_PLAN, ['Bench Press']), 'Seated Row');
});

test('nextRemainingExercise: advances in visible order as lifts are logged', () => {
  assert.equal(nextRemainingExercise(VISIBLE_PLAN, ['Bench Press', 'Seated Row']), 'Weighted Dip');
  assert.equal(nextRemainingExercise(VISIBLE_PLAN, ['Bench Press', 'Seated Row', 'Weighted Dip']), 'Lat Pulldown');
});

test('nextRemainingExercise: out-of-order logging never points back at a completed lift', () => {
  // Logged Face Pull first (out of order) → next up is the first still-unlogged in
  // plan order (Bench Press), never the already-done Face Pull.
  assert.equal(nextRemainingExercise(VISIBLE_PLAN, ['Face Pull']), 'Bench Press');
  // Bench + Face Pull done → next is Seated Row, not Face Pull again.
  assert.equal(nextRemainingExercise(VISIBLE_PLAN, ['Bench Press', 'Face Pull']), 'Seated Row');
});

test('nextRemainingExercise: null when the plan is complete or empty', () => {
  assert.equal(nextRemainingExercise(VISIBLE_PLAN, VISIBLE_PLAN), null);
  assert.equal(nextRemainingExercise([], []), null);
});

test('nextRemainingExercise: matches by lift_code too (plan "Rows" logged as "Barbell Row")', () => {
  const planned = [{ name: 'Rows', liftCode: 'ROW01' }, { name: 'Bench', liftCode: 'BEN01' }];
  assert.equal(nextRemainingExercise(planned, [{ name: 'Barbell Row', liftCode: 'ROW01' }]), 'Bench');
});

/* ===== Frontend wiring: app.js computes nextPlanned, coach-conversation uses it ===== */
test('app.js next-up follows the visible plan order (started OR coach-suggested) minus completed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /nextPlanned/, 'emitSetLogged should compute a nextPlanned field');
  assert.match(src, /const nextPlanned = firstUnloggedPlannedLift\(\)/, 'nextPlanned comes from firstUnloggedPlannedLift');
  // The order source is the started session OR the cached coach-suggested plan, so
  // next-up works even without "Start Session".
  assert.match(src, /function plannedExerciseOrder\(\)/, 'a shared plan-order helper exists');
  assert.match(src, /activePlannedSession\.exercises\.map\(/, 'order uses the started session when present');
  assert.match(src, /lastIntentData[\s\S]*?recommended/, 'order falls back to the cached coach-suggested plan');
  assert.match(src, /!sessionCompleted\.some\(/, 'next-up skips already-completed exercises');
  assert.match(src, /detail:\s*\{[\s\S]*nextPlanned/, 'nextPlanned must be included in the set-logged event detail');
});

test('coach-conversation.js prefers detail.nextPlanned for the next-up handoff', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'coach-conversation.js'), 'utf8');
  assert.match(src, /detail\.nextPlanned\s*\|\|\s*await getNextExerciseInPlan/,
    'handoff should use detail.nextPlanned first, falling back to the API-plan lookup only for freeform');
});
