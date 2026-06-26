'use strict';

// P0 PR 2 — Active Session Wiring
// Source-introspection tests that verify the canonical-session wiring in app.js.
// These tests are intentionally structural (not behavioral) — they lock the wiring
// contracts that prevent the stale `exercises[index]` cursor from driving functional
// reads (substitute checks, plan payload) while a logged exercise is still shown in
// the banner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── currentPlannedExercise helper ───────────────────────────────────────────────

test('wiring: currentPlannedExercise() helper is defined in app.js', () => {
  assert.ok(
    appSrc.includes('function currentPlannedExercise()'),
    'currentPlannedExercise must be defined'
  );
});

test('wiring: currentPlannedExercise() uses getCanonicalSession() + AS.currentExercise()', () => {
  const start = appSrc.indexOf('function currentPlannedExercise()');
  assert.ok(start !== -1);
  // Read up to the next top-level function declaration.
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 1500 : next);
  assert.ok(body.includes('getCanonicalSession()'), 'must call getCanonicalSession()');
  assert.ok(body.includes('AS.currentExercise('), 'must call AS.currentExercise()');
});

test('wiring: currentPlannedExercise() has index fallback when AS unavailable', () => {
  const start = appSrc.indexOf('function currentPlannedExercise()');
  assert.ok(start !== -1);
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 1500 : next);
  // When window.activeSession is absent, must return exercises[index] not null.
  assert.ok(
    body.includes('activePlannedSession.exercises[activePlannedSession.index]'),
    'must fall back to exercises[index] when AS is unavailable'
  );
});

test('wiring: currentPlannedExercise() skips pending-swap exercise (Step 379 guard)', () => {
  const start = appSrc.indexOf('function currentPlannedExercise()');
  assert.ok(start !== -1);
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 1500 : next);
  // When pendingSubstitution is set, the swapped-out lift must be skipped so a second
  // conversational message doesn't re-send the taken lift as current_exercise.
  assert.ok(
    body.includes('pendingSubstitution'),
    'must check pendingSubstitution to skip the declared-taken lift'
  );
  assert.ok(
    body.includes('remainingPlannedExercises()'),
    'must use remainingPlannedExercises() to find the next unswapped lift'
  );
});

// ── checkAndSuggestSubstitute uses canonical session ───────────────────────────

test('wiring: checkAndSuggestSubstitute uses currentPlannedExercise(), not exercises[index]', () => {
  const start = appSrc.indexOf('async function checkAndSuggestSubstitute(');
  assert.ok(start !== -1, 'checkAndSuggestSubstitute must exist');
  const next = appSrc.indexOf('\nasync function ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 3000 : next);

  assert.ok(
    body.includes('currentPlannedExercise()'),
    'checkAndSuggestSubstitute must call currentPlannedExercise() for canonical current exercise'
  );
  // The stale index-based read must NOT be the primary current-exercise source.
  assert.ok(
    !body.includes('exercises[activePlannedSession.index]'),
    'checkAndSuggestSubstitute must NOT read the stale index cursor as the current exercise'
  );
});

// ── plan_exercises payload uses canonical session ───────────────────────────────

test('wiring: plan_exercises payload block uses currentPlannedExercise()', () => {
  // The mid-session plan_exercises block (subPayload.plan_exercises) must source the
  // current exercise from currentPlannedExercise() so a stale index cursor never
  // sends the wrong exercise to the coach.
  const anchor = 'subPayload.plan_exercises';
  const planIdx = appSrc.indexOf(anchor);
  assert.ok(planIdx !== -1, 'subPayload.plan_exercises must appear in app.js');
  // Capture ~200 chars before (the currentPlannedExercise call precedes the assignment).
  const block = appSrc.slice(planIdx - 200, planIdx + 200);
  assert.ok(
    block.includes('currentPlannedExercise()'),
    'plan_exercises block must call currentPlannedExercise() to derive the current step'
  );
});

// ── advancePlannedSession skip-vs-increment branch ────────────────────────────

test('wiring: advancePlannedSession skips unlogged exercises via skipPlannedExercise()', () => {
  const start = appSrc.indexOf('function advancePlannedSession()');
  assert.ok(start !== -1);
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 2000 : next);
  assert.ok(
    body.includes('skipPlannedExercise('),
    'advancePlannedSession must call skipPlannedExercise for unlogged exercises'
  );
  assert.ok(
    body.includes('completedSet'),
    'advancePlannedSession must check sessionCompleted membership before deciding skip vs advance'
  );
});

test('wiring: advancePlannedSession uses currentPlannedExercise() for startLift()', () => {
  const start = appSrc.indexOf('function advancePlannedSession()');
  assert.ok(start !== -1);
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 2000 : next);
  assert.ok(
    body.includes('currentPlannedExercise()'),
    'advancePlannedSession must use currentPlannedExercise() to drive startLift()'
  );
});

// ── renderActiveSessionBanner null guard ──────────────────────────────────────

test('wiring: renderActiveSessionBanner guards against a null current entry', () => {
  const start = appSrc.indexOf('function renderActiveSessionBanner(');
  assert.ok(start !== -1);
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 2000 : next);
  // The guard must hide the banner when exercises[index] is null/undefined.
  assert.ok(
    body.includes('banner.hidden = true'),
    'renderActiveSessionBanner must hide the banner when current exercise is null'
  );
});

// ── curName() in tryApplyPlanMutation uses firstUnloggedPlannedLift ──────────

test('wiring: tryApplyPlanMutation curName() uses firstUnloggedPlannedLift(), not only exercises[index]', () => {
  const start = appSrc.indexOf('function tryApplyPlanMutation(');
  assert.ok(start !== -1);
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 3000 : next);
  // After a mutation (splice/replace), firstUnloggedPlannedLift gives the correct
  // new current exercise. This prevents curName from returning a stale slot.
  assert.ok(
    body.includes('firstUnloggedPlannedLift()'),
    'tryApplyPlanMutation curName() must call firstUnloggedPlannedLift() for the post-mutation current exercise'
  );
});

// ── AC3: checkAndSuggestSubstitute stores prescription in pendingSubstitution ─

test('wiring: checkAndSuggestSubstitute stores rec.next_target as pendingSubstitution.prescription (AC3)', () => {
  const start = appSrc.indexOf('async function checkAndSuggestSubstitute(');
  assert.ok(start !== -1, 'checkAndSuggestSubstitute must exist');
  const next = appSrc.indexOf('\nasync function ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 2000 : next);
  // The prescription from the suggest-substitute API must be stored on
  // pendingSubstitution so applySessionSubstitution can populate the replacement
  // slot with weight/reps/sets instead of null (AC3).
  assert.ok(
    body.includes('prescription') && body.includes('rec.next_target'),
    'checkAndSuggestSubstitute must store rec.next_target as pendingSubstitution.prescription'
  );
});

test('wiring: applySessionSubstitution accepts prescription arg and uses it for weight/reps/sets (AC3)', () => {
  const start = appSrc.indexOf('function applySessionSubstitution(');
  assert.ok(start !== -1, 'applySessionSubstitution must exist');
  const next = appSrc.indexOf('\nfunction ', start + 1);
  const body = appSrc.slice(start, next === -1 ? start + 1500 : next);
  // Must accept a prescription argument.
  assert.ok(
    body.includes('prescription'),
    'applySessionSubstitution must accept and use a prescription argument'
  );
  // Must derive weight, reps, sets from the prescription when present.
  assert.ok(
    body.includes('p.weight') && body.includes('p.reps') && body.includes('p.sets'),
    'applySessionSubstitution must read weight/reps/sets from the prescription object'
  );
});
