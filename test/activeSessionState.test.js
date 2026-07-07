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

// PR-08: activeSession + planMutationIntent are ES modules now — preload their
// namespaces once (Node 20 CI has no require(esm)). The per-test lazy accessors
// below read these preloaded namespaces, which the before-hook fills first.
let AS_NS, PM_NS;
test.before(async () => {
  AS_NS = await import('../src/app/activeSession.js');
  PM_NS = await import('../src/app/planMutationIntent.js');
});

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
  return AS_NS;
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

test('AC7: correcting a logged identity relabels the entry in session state', () => {
  const { createActiveSession, markCompleted, correctIdentity, completedExercises } = loadActiveSession();
  let s = createActiveSession({ exercises: COACHES_PICK });
  // A set mis-logged as Deadlift that was actually Lat Pulldown ("sorry, that was lat pulls").
  s = markCompleted(s, 'Deadlift');
  s = correctIdentity(s, { from: 'Deadlift', to: 'Lat Pulldown' });
  const done = completedExercises(s).map(e => e.name);
  assert.ok(done.includes('Lat Pulldown'), 'the logged entry is now Lat Pulldown');
  assert.ok(!done.includes('Deadlift'), 'the wrong Deadlift identity is gone');
});

test('AC8/AC9: inserted accessories are represented as inserted entries in the queue', () => {
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

test('AC10: the fully-modified session resolves to a clean, writable completed set', () => {
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
  const { createActiveSession, currentExercise, remaining } = AS_NS;
  const s = createActiveSession({ exercises: ['Deadlift', '', { name: 'Overhead Press', liftCode: 'OHP01' }, null] });
  assert.equal(remaining(s).length, 2, 'blank/null entries are dropped');
  assert.equal(currentExercise(s).name, 'Deadlift');
  assert.equal(s.exercises[0].status, 'pending');
  assert.equal(s.exercises[0].source, 'planned');
  assert.equal(s.exercises[1].liftCode, 'OHP01', 'record liftCode is preserved');
});

test('activeSession: skipExercise removes a lift from current/remaining without completing it', () => {
  const { createActiveSession, skipExercise, currentExercise, remaining, completedExercises } = AS_NS;
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  s = skipExercise(s, 'Deadlift');
  assert.equal(currentExercise(s).name, 'Overhead Press', 'current advances past the skipped lift');
  assert.ok(!remaining(s).some(e => e.name === 'Deadlift'), 'skipped lift is no longer remaining');
  assert.ok(!completedExercises(s).some(e => e.name === 'Deadlift'), 'a skip is NOT a completion');
});

test('activeSession: mutations are pure (never mutate the input session)', () => {
  const { createActiveSession, replaceExercise, markCompleted } = AS_NS;
  const s0 = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  const s1 = replaceExercise(s0, 'Deadlift', { name: 'Back Squat' });
  const s2 = markCompleted(s1, 'Back Squat');
  assert.equal(s0.exercises[0].name, 'Deadlift', 'original session unchanged after replace');
  assert.equal(s0.exercises[0].status, 'pending', 'original session unchanged after markCompleted');
  assert.notEqual(s0, s1);
  assert.notEqual(s1, s2);
});

test('activeSession: replaceExercise is a no-op for an unknown target or an identical substitute', () => {
  const { createActiveSession, replaceExercise } = AS_NS;
  const s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  assert.equal(replaceExercise(s, 'Bench Press', { name: 'Squat' }), s, 'unknown target → same session');
  assert.equal(replaceExercise(s, 'Deadlift', { name: 'deadlift' }), s, 'same-name substitute → no-op');
});

test('activeSession: an ambiguous loose name never silently mutates the wrong slot (review #565)', () => {
  // eslint-disable-next-line no-unused-vars -- `remaining` imported for type completeness; not asserted in this test case
  const { createActiveSession, markCompleted, replaceExercise, skipExercise, completedExercises, remaining } = AS_NS;
  const s = createActiveSession({ exercises: ['Seated Row', 'Barbell Row', 'Overhead Press'] });

  // "Row" substring-matches BOTH rows → ambiguous → no-op (no guess).
  assert.equal(markCompleted(s, 'Row'), s, 'ambiguous markCompleted is a no-op');
  assert.equal(completedExercises(markCompleted(s, 'Row')).length, 0, 'nothing completed on ambiguity');
  assert.equal(replaceExercise(s, 'Row', { name: 'Cable Row' }), s, 'ambiguous replace is a no-op');
  assert.equal(skipExercise(s, 'Row'), s, 'ambiguous skip is a no-op');

  // An UNambiguous substring still resolves: only one "Press" here.
  const done = completedExercises(markCompleted(s, 'Press')).map(e => e.name);
  assert.deepEqual(done, ['Overhead Press'], 'a unique substring still completes the one match');

  // Exact name is unaffected by the ambiguity guard.
  assert.deepEqual(
    completedExercises(markCompleted(s, 'Seated Row')).map(e => e.name),
    ['Seated Row'],
    'exact name still completes the right slot'
  );
});

test('activeSession: findMatchIndex prefers liftCode over a loose name and refuses ambiguous substrings', () => {
  const { createActiveSession, findMatchIndex } = AS_NS;
  const s = createActiveSession({ exercises: [
    { name: 'Seated Row', liftCode: 'ROW01' },
    { name: 'Barbell Row', liftCode: 'BBR01' },
  ] });
  assert.equal(findMatchIndex(s.exercises, { name: 'whatever', liftCode: 'BBR01' }, false), 1, 'liftCode wins');
  assert.equal(findMatchIndex(s.exercises, 'Row', false), -1, 'ambiguous substring → -1 (no guess)');
  assert.equal(findMatchIndex(s.exercises, 'Seated Row', false), 0, 'exact name resolves');
});

test('correctIdentity: reconciles a mislabel onto a planned entry (no duplicate, planned one done)', () => {
  const { createActiveSession, markCompleted, correctIdentity, completedExercises, remaining } = AS_NS;
  let s = createActiveSession({ exercises: COACHES_PICK });
  s = markCompleted(s, 'Deadlift');                          // mis-logged as Deadlift
  s = correctIdentity(s, { from: 'Deadlift', to: 'Lat Pulldown' });
  const names = s.exercises.map(e => e.name);
  assert.equal(names.filter(n => n === 'Lat Pulldown').length, 1, 'no duplicate Lat Pulldown');
  assert.ok(!names.includes('Deadlift'), 'the wrong Deadlift label is gone');
  assert.deepEqual(completedExercises(s).map(e => e.name), ['Lat Pulldown'], 'the planned Lat Pulldown is now the completed one');
  assert.ok(!remaining(s).some(e => e.name === 'Lat Pulldown'), 'Lat Pulldown no longer shows as remaining');
});

test('correctIdentity: relabels in place when the corrected identity is not already in the plan', () => {
  const { createActiveSession, markCompleted, correctIdentity, completedExercises } = AS_NS;
  let s = createActiveSession({ exercises: ['Incline', 'Overhead Press'] });
  s = markCompleted(s, 'Incline');
  s = correctIdentity(s, { from: 'Incline', to: { name: 'Incline DB Press', liftCode: 'IDB01' } });
  const done = completedExercises(s);
  assert.deepEqual(done.map(e => e.name), ['Incline DB Press'], 'relabeled in place, status preserved');
  assert.equal(done[0].liftCode, 'IDB01', 'corrected liftCode carried over');
});

test('correctIdentity: no-op for unknown `from`, blank `to`, or an already-correct identity', () => {
  const { createActiveSession, correctIdentity } = AS_NS;
  const s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  assert.equal(correctIdentity(s, { from: 'Bench', to: 'Squat' }), s, 'unknown from → no-op');
  assert.equal(correctIdentity(s, { from: 'Deadlift', to: '' }), s, 'blank to → no-op');
  assert.equal(correctIdentity(s, { from: 'Deadlift', to: 'Deadlift' }), s, 'already-correct → no-op');
});

test('insertExercise: appends a finisher by default and inserts after a named entry on request', () => {
  const { createActiveSession, insertExercise, remaining } = AS_NS;
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  s = insertExercise(s, { name: 'Hanging Knee Raises' });            // default: end
  assert.deepEqual(remaining(s).map(e => e.name), ['Deadlift', 'Overhead Press', 'Hanging Knee Raises']);
  s = insertExercise(s, { name: 'Hammer Curls', liftCode: 'HC01' }, { after: 'Deadlift' });
  assert.deepEqual(remaining(s).map(e => e.name), ['Deadlift', 'Hammer Curls', 'Overhead Press', 'Hanging Knee Raises']);
  const inserted = s.exercises.filter(e => e.source === 'inserted');
  assert.equal(inserted.length, 2, 'both are tracked as inserted');
  assert.equal(s.exercises.find(e => e.name === 'Hammer Curls').liftCode, 'HC01', 'inserted liftCode preserved');
});

test('insertExercise: insert → markCompleted records an off-plan exercise as inserted+completed; blank is a no-op', () => {
  const { createActiveSession, insertExercise, markCompleted, completedExercises } = AS_NS;
  let s = createActiveSession({ exercises: ['Deadlift'] });
  assert.equal(insertExercise(s, ''), s, 'blank ref → no-op');
  s = insertExercise(s, { name: 'Side Bends' });
  s = markCompleted(s, 'Side Bends');
  const done = completedExercises(s).find(e => e.name === 'Side Bends');
  assert.ok(done && done.status === 'completed' && done.source === 'inserted', 'off-plan log is inserted+completed');
});

// ── Wiring guards (PR-565 review notes, hardened for the live mutation path) ───

test('guard: replaceExercise never re-opens a completed or skipped slot', () => {
  const { createActiveSession, markCompleted, skipExercise, replaceExercise, completedExercises } = AS_NS;
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  s = markCompleted(s, 'Deadlift');
  assert.equal(replaceExercise(s, 'Deadlift', { name: 'Back Squat' }), s, 'replacing a COMPLETED slot is a no-op');
  assert.deepEqual(completedExercises(s).map(e => e.name), ['Deadlift'], 'the finished slot is untouched');
  let s2 = skipExercise(createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] }), 'Deadlift');
  assert.equal(replaceExercise(s2, 'Deadlift', { name: 'Back Squat' }), s2, 'replacing a SKIPPED slot is a no-op');
});

test('guard: correctIdentity never downgrades a finished `to`, and never orphans a second logged set', () => {
  const { createActiveSession, markCompleted, correctIdentity, completedExercises, remaining } = AS_NS;

  // from pending + to completed → must NOT downgrade the completed `to`; the
  // redundant pending mislabel is reconciled away (kept completed, not re-opened).
  let s = createActiveSession({ exercises: ['Deadlift', 'Lat Pulldown'] });
  s = markCompleted(s, 'Lat Pulldown');                 // to is completed
  s = correctIdentity(s, { from: 'Deadlift', to: 'Lat Pulldown' }); // from is pending
  assert.equal(completedExercises(s).filter(e => e.name === 'Lat Pulldown').length, 1, 'the completed Lat Pulldown is preserved (not downgraded)');
  assert.ok(!remaining(s).some(e => e.name === 'Lat Pulldown'), 'Lat Pulldown is not re-opened as pending');
  assert.ok(!s.exercises.some(e => e.name === 'Deadlift'), 'the redundant pending mislabel is gone');

  // both completed (two separately-logged sets) → keep both, do not collapse/orphan.
  let s2 = createActiveSession({ exercises: ['Deadlift', 'Lat Pulldown'] });
  s2 = markCompleted(s2, 'Deadlift');
  s2 = markCompleted(s2, 'Lat Pulldown');
  s2 = correctIdentity(s2, { from: 'Deadlift', to: 'Lat Pulldown' });
  assert.equal(completedExercises(s2).filter(e => e.name === 'Lat Pulldown').length, 2, 'both logged sets kept (no orphan)');
});

test('guard: hasLoggedWork distinguishes a real session from an all-skipped one', () => {
  const { createActiveSession, skipExercise, markCompleted, isComplete, hasLoggedWork } = AS_NS;
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  s = skipExercise(s, 'Deadlift');
  s = skipExercise(s, 'Overhead Press');
  assert.equal(isComplete(s), true, 'nothing pending → isComplete true');
  assert.equal(hasLoggedWork(s), false, 'but nothing was logged → not a real session');
  const t = markCompleted(createActiveSession({ exercises: ['Deadlift'] }), 'Deadlift');
  assert.equal(hasLoggedWork(t), true, 'a completed exercise counts as logged work');
});

test('activeSession: isComplete flips only when the plan exists and nothing pending remains', () => {
  const { createActiveSession, markCompleted, skipExercise, isComplete } = AS_NS;
  assert.equal(isComplete(createActiveSession({ exercises: [] })), false, 'empty plan is not "complete"');
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press'] });
  assert.equal(isComplete(s), false);
  s = markCompleted(s, 'Deadlift');
  s = skipExercise(s, 'Overhead Press');
  assert.equal(isComplete(s), true, 'completed + skipped leaves nothing pending');
});

// ── Sub-PR 2b CARRY-OVER GUARD: a swap/skip can't re-open already-logged work ──
// The live path (tryApplyPlanMutation) resolves targets via resolvePlanTargets
// against getCanonicalSession(), which marks logged lifts completed. This pins the
// model+resolver seam: once a lift is logged (completed), it is invisible to a
// later swap/skip target — so an accepted mutation can never re-open finished work.
test('guard 2b: a logged (completed) lift is never a swap/skip target (no re-opening)', () => {
  const { createActiveSession, markCompleted } = AS_NS;
  const { resolvePlanTargets } = PM_NS;

  // Build the canonical session the way getCanonicalSession() does, then log one lift.
  let s = createActiveSession({ exercises: ['Deadlift', 'Overhead Press', 'Seated Row'] });
  s = markCompleted(s, 'Deadlift');                       // Deadlift is now logged work

  // resolvePlanTargets is fed the model's own entries (status carried through).
  const entries = s.exercises.map(e => ({ name: e.name, status: e.status }));
  assert.deepEqual(resolvePlanTargets('deadlift', entries), [], 'a completed lift cannot be re-targeted (skip/swap)');
  assert.deepEqual(resolvePlanTargets('overhead press', entries), ['Overhead Press'], 'a still-pending lift resolves normally');
  // A compound target spanning a completed + pending lift only resolves the pending one.
  assert.deepEqual(resolvePlanTargets('deadlift/overhead press', entries), ['Overhead Press'], 'the finished half of a compound target is dropped');
});
