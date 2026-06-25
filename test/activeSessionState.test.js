'use strict';

// P0 — Active Workout State Unification (diagnosis PR 1).
//
// These tests pin the canonical active-session contract from the live-gym repro
// (Coach's Pick → replace Deadlift with Back Squat → log Squat → OHP → corrected
// Lat Pulldown → insert Hammer Curls → insert Knee Raises → preview/save). See
// docs/ACTIVE_SESSION_STATE_DIAGNOSIS.md.
//
// The canonical model `public/activeSession.js` lands across PR 2 (create/replace/
// skip/markCompleted + selectors) and later slices (correctIdentity PR 4, insert PR 5).
// The not-yet-built operations are pinned by `node:test` TODO tests: each lazily
// require()s the module inside its body and calls the missing op, so until it exists
// the test is a TODO-failure (reported under `# todo`, NOT `# fail`), keeping CI green.
// Each subsequent PR removes that test's `todo` marker as it implements the capability.
//
// The first block PASSES today: it documents that the *server-side* swap seam
// (services/sessionPlanExecutor.js) already models the Deadlift→Squat swap
// correctly — i.e. the bug is NOT the math, it is that the client never routes
// mutations through one canonical object.

const test = require('node:test');
const assert = require('node:assert/strict');

const COACHES_PICK = [
  'Deadlift', 'Overhead Press', 'Seated Row',
  'Lat Pulldown', 'Leg Extension', 'Single-Leg Leg Curl',
];

// ── Building block (PASSES): the server seam already models the swap ───────────
// Proves the divergence is integration-level (no single source of truth), not a
// flaw in the underlying plan math.

test('server seam: applySubstitution + computePlanState model the Deadlift→Squat swap', () => {
  const { applySubstitution, computePlanState, nextRemainingExercise } =
    require('../services/sessionPlanExecutor');

  const swapped = applySubstitution(COACHES_PICK, 'Deadlift', 'Back Squat');
  assert.equal(swapped.applied, true, 'swap should apply to the planned list');
  const names = swapped.planned.map(r => r.name);
  assert.deepEqual(names.slice(0, 2), ['Back Squat', 'Overhead Press'],
    'Back Squat replaces Deadlift in place, order preserved');
  assert.ok(!names.includes('Deadlift'), 'Deadlift is gone from the mutated plan');

  // After logging Back Squat, the next remaining is OHP — not Deadlift.
  const next = nextRemainingExercise(swapped.planned, ['Back Squat']);
  assert.equal(next, 'Overhead Press', 'next-up follows the MUTATED queue');

  const state = computePlanState(swapped.planned, ['Back Squat', 'Overhead Press']);
  assert.equal(state.remaining[0], 'Seated Row', 'next-up keeps following the mutated queue');
});

// ── Canonical ActiveSession contract (TODO until PR 2+) ───────────────────────
// One authoritative object; every consumer (composer, next-up, recap, write rows)
// derives from it. Lazy-require inside each test so the missing module is a
// contained TODO-failure, not a file-level crash.

function loadActiveSession() {
  // eslint-disable-next-line global-require
  return require('../public/activeSession');
}

test('AC1/AC2/AC4: replace makes the substitute the current exercise (composer prefill)', () => {
  const { createActiveSession, replaceExercise, currentExercise } = loadActiveSession();
  let s = createActiveSession({ exercises: COACHES_PICK });
  assert.equal(currentExercise(s).name, 'Deadlift', 'Coach\'s Pick starts on Deadlift');
  s = replaceExercise(s, 'Deadlift', { name: 'Back Squat' });
  // The composer must immediately derive Back Squat — never the stale Deadlift.
  assert.equal(currentExercise(s).name, 'Back Squat');
});

test('AC5/AC6: next-up follows the mutated queue after logging the substitute', () => {
  const { createActiveSession, replaceExercise, markCompleted, nextUp } = loadActiveSession();
  let s = createActiveSession({ exercises: COACHES_PICK });
  s = replaceExercise(s, 'Deadlift', { name: 'Back Squat' });
  s = markCompleted(s, 'Back Squat');
  assert.equal(nextUp(s).name, 'Overhead Press', 'next-up is OHP, not Deadlift');
  s = markCompleted(s, 'Overhead Press');
  assert.equal(nextUp(s).name, 'Seated Row', 'next-up keeps following the mutated queue');
});

test('AC11: a session with logged work is never reported as "no plan"', () => {
  const { createActiveSession, markCompleted, remaining, completedExercises } = loadActiveSession();
  let s = createActiveSession({ exercises: COACHES_PICK });
  s = markCompleted(s, 'Deadlift');
  assert.ok(completedExercises(s).length >= 1, 'the session knows work was logged');
  assert.ok(remaining(s).length >= 1, 'the session still has a plan — not "no session plan"');
});

test('AC7: correcting a logged identity relabels the entry in session state', { todo: 'PR4 — identity correction' }, () => {
  const { createActiveSession, markCompleted, correctIdentity, completedExercises } = loadActiveSession();
  let s = createActiveSession({ exercises: COACHES_PICK });
  // A set mis-logged as Deadlift that was actually Lat Pulldown ("sorry, that was lat pulls").
  s = markCompleted(s, 'Deadlift');
  s = correctIdentity(s, { from: 'Deadlift', to: 'Lat Pulldown' });
  const done = completedExercises(s).map(e => e.name);
  assert.ok(done.includes('Lat Pulldown'), 'the logged entry is now Lat Pulldown');
  assert.ok(!done.includes('Deadlift'), 'the wrong Deadlift identity is gone');
});

test('AC8/AC9: inserted accessories are represented as inserted entries in the queue', { todo: 'PR5 — insert/finisher handling' }, () => {
  const { createActiveSession, insertExercise, markCompleted, completedExercises } = loadActiveSession();
  let s = createActiveSession({ exercises: COACHES_PICK });
  s = insertExercise(s, { name: 'Hammer Curls' });
  s = markCompleted(s, 'Hammer Curls');
  s = insertExercise(s, { name: 'Hanging Knee Raises' });
  s = markCompleted(s, 'Hanging Knee Raises');
  const done = completedExercises(s);
  const curls = done.find(e => e.name === 'Hammer Curls');
  const raises = done.find(e => e.name === 'Hanging Knee Raises');
  assert.ok(curls && curls.source === 'inserted', 'Hammer Curls tracked as inserted');
  assert.ok(raises && raises.source === 'inserted', 'Knee Raises tracked as inserted (core finisher)');
});

test('AC10: the fully-modified session resolves to a clean, writable completed set', { todo: 'PR5 — recap/save for modified sessions' }, () => {
  const { createActiveSession, replaceExercise, markCompleted, correctIdentity, insertExercise, completedExercises } = loadActiveSession();
  let s = createActiveSession({ exercises: COACHES_PICK });
  s = replaceExercise(s, 'Deadlift', { name: 'Back Squat' });
  s = markCompleted(s, 'Back Squat');
  s = markCompleted(s, 'Overhead Press');
  s = markCompleted(s, 'Lat Pulldown');
  s = correctIdentity(s, { from: 'Lat Pulldown', to: 'Lat Pulldown' }); // no-op identity confirm
  s = insertExercise(s, { name: 'Hammer Curls' });
  s = markCompleted(s, 'Hammer Curls');
  s = insertExercise(s, { name: 'Hanging Knee Raises' });
  s = markCompleted(s, 'Hanging Knee Raises');
  const done = completedExercises(s).map(e => e.name);
  // Every logged thing is present and Deadlift (replaced) is not falsely recorded.
  for (const name of ['Back Squat', 'Overhead Press', 'Lat Pulldown', 'Hammer Curls', 'Hanging Knee Raises']) {
    assert.ok(done.includes(name), `${name} present in the completed set`);
  }
  assert.ok(!done.includes('Deadlift'), 'the replaced Deadlift is not recorded as completed');
});

// ── Canonical module primitives (PR 2, passing) ───────────────────────────────

test('activeSession: createActiveSession seeds pending/planned entries and drops blanks', () => {
  const { createActiveSession, currentExercise, remaining } = require('../public/activeSession');
  const s = createActiveSession({ exercises: ['Deadlift', '', { name: 'Overhead Press', liftCode: 'OHP01' }, null] });
  assert.equal(remaining(s).length, 2, 'blank/null entries are dropped');
  assert.equal(currentExercise(s).name, 'Deadlift');
  assert.equal(s.exercises[0].status, 'pending');
  assert.equal(s.exercises[0].source, 'planned');
  assert.equal(s.exercises[1].liftCode, 'OHP01', 'record liftCode is preserved');
});

test('activeSession: skipExercise removes a lift from current/remaining without completing it', () => {
  const { createActiveSession, skipExercise, currentExercise, remaining, completedExercises } = require('../public/activeSession');
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  s = skipExercise(s, 'Deadlift');
  assert.equal(currentExercise(s).name, 'Overhead Press', 'current advances past the skipped lift');
  assert.ok(!remaining(s).some(e => e.name === 'Deadlift'), 'skipped lift is no longer remaining');
  assert.ok(!completedExercises(s).some(e => e.name === 'Deadlift'), 'a skip is NOT a completion');
});

test('activeSession: mutations are pure (never mutate the input session)', () => {
  const { createActiveSession, replaceExercise, markCompleted } = require('../public/activeSession');
  const s0 = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  const s1 = replaceExercise(s0, 'Deadlift', { name: 'Back Squat' });
  const s2 = markCompleted(s1, 'Back Squat');
  assert.equal(s0.exercises[0].name, 'Deadlift', 'original session unchanged after replace');
  assert.equal(s0.exercises[0].status, 'pending', 'original session unchanged after markCompleted');
  assert.notEqual(s0, s1);
  assert.notEqual(s1, s2);
});

test('activeSession: replaceExercise is a no-op for an unknown target or an identical substitute', () => {
  const { createActiveSession, replaceExercise } = require('../public/activeSession');
  const s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  assert.equal(replaceExercise(s, 'Bench Press', { name: 'Squat' }), s, 'unknown target → same session');
  assert.equal(replaceExercise(s, 'Deadlift', { name: 'deadlift' }), s, 'same-name substitute → no-op');
});

test('activeSession: isComplete flips only when the plan exists and nothing pending remains', () => {
  const { createActiveSession, markCompleted, skipExercise, isComplete } = require('../public/activeSession');
  assert.equal(isComplete(createActiveSession({ exercises: [] })), false, 'empty plan is not "complete"');
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  assert.equal(isComplete(s), false);
  s = markCompleted(s, 'Deadlift');
  s = skipExercise(s, 'Overhead Press');
  assert.equal(isComplete(s), true, 'completed + skipped leaves nothing pending');
});
