'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { computePlanState, nextExerciseFromPlan } = require('../services/sessionPlanExecutor');

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
