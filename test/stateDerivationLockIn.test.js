'use strict';

// PR-24 slice 3 — lock-in: recap / skip / substitution status stay DERIVED from
// store-owned session state, with no independent shadow tracking.
//
// Slice-3 context (verification-gate finding, docs/REMEDIATION_PLAN_V2.md): the
// slice was scoped to "replace independently-tracked recap/skip/substitution
// status with computed derivations." The gate found there was nothing to migrate —
// all three are ALREADY derived-on-read from the store (`activePlannedSession`,
// `sessionCompleted`, `pendingSubstitution`), with no hand-maintained shadow that
// could drift. So slice 3 ships as these lock-in tests instead: they pin the
// derived-from-store ARCHITECTURE so a future change can't quietly reintroduce a
// parallel shadow copy (the exact scattered-state disease PR-24 exists to kill).
//
// These are structure/architecture guards, complementary to — not duplicating —
// the ADD-2/ADD-4/ADD-6 behavioral suites (planSkipWiring, activeSessionState,
// flightRecorderReplay), which lock the fix CORRECTNESS. Here we lock that the fix
// stays STORE-DERIVED.
//
// Out of scope (owner-directed): next-up / pin / handoff / remainingPlannedExercises
// behavior, the parser, the write path, save/approval, and the Sheet schema are all
// untouched. The known divergence between the two "remaining" derivations
// (remainingPlannedExercises vs canonicalSessionRecap's reconciled remaining) is
// filed as a backlog follow-up, NOT changed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildPlanMutationHarness } = require('./helpers/appSliceHarness');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'src', 'app', 'app.js'), 'utf8');
const activeSessionSrc = fs.readFileSync(path.join(repoRoot, 'src', 'app', 'activeSession.js'), 'utf8');

let AS;
test.before(async () => { AS = await import('../src/app/activeSession.js'); });

// Slice a function body out of app.js by its declaration marker up to the next
// `\nfunction ` at column 0 (app.js is a flat classic script, so top-level
// function declarations are the reliable boundaries).
function fnBody(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `expected to find ${decl}`);
  const next = src.indexOf('\nfunction ', start + decl.length);
  return src.slice(start, next === -1 ? undefined : next);
}

// ── A. Structural guards: no independent shadow was (re)introduced ───────────────

test('no top-level `let` shadow copy of recap/skip/substitution status exists in app.js', () => {
  // A hand-maintained module-level variable is exactly the scattered-state shape
  // PR-24 removes. Any of these names appearing as a top-level `let`/`var` would be
  // a reintroduced shadow that must be kept in sync by hand (and could drift from
  // the store). The real state lives in the store (activePlannedSession /
  // sessionCompleted / pendingSubstitution) or is derived-on-read by a function.
  const shadowLet = /\b(?:let|var)\s+(remainingPlannedExercises|skippedExercises|skippedSlots|skippedPlanned|substitutedSlots|substitutionStatus|sessionRecap|recapState|completedRemaining|remainingState)\b/;
  assert.doesNotMatch(appSrc, shadowLet, 'recap/skip/substitution status must not be a stored module-level shadow');
});

test('recap / remaining / plan-order are derived-on-read FUNCTIONS, not stored values', () => {
  // Declared as functions (recompute from the store each call), never as data.
  for (const decl of [
    'function canonicalSessionRecap()',
    'function getCanonicalSession()',
    'function remainingPlannedExercises()',
    'function plannedExerciseOrder()',
    'function plannedExerciseEntries()',
    'function firstUnloggedPlannedLift()',
  ]) {
    assert.ok(appSrc.includes(decl), `${decl} must exist as a derived-on-read function`);
  }
});

test('SKIP is derived: skipPlannedExercise splices the store plan, keeps no separate skipped state', () => {
  const body = fnBody(appSrc, 'function skipPlannedExercise(name)');
  // The skip is expressed by removing the slot from the store-owned plan…
  assert.match(body, /getActivePlannedSession\(\)\.exercises\.splice\(/,
    'a skip must splice the slot out of the store-owned activePlannedSession');
  // …never by writing a parallel "skipped" collection.
  assert.doesNotMatch(body, /\bskipped\w*\s*(?:=|\.push\(|\.add\()/,
    'a skip must not record into a separate skipped shadow collection');
});

test('RECAP is derived: canonicalSessionRecap reads the store via getCanonicalSession + reconciles', () => {
  const body = fnBody(appSrc, 'function canonicalSessionRecap()');
  assert.match(body, /getCanonicalSession\(\)/, 'recap must derive from the canonical session');
  assert.match(body, /reconcileSubstitutedRemaining/, 'recap remaining must run the ADD-4 variant reconciliation');
  assert.doesNotMatch(body, /\b(?:let|const)\s+\w*[Rr]ecap\w*\s*=\s*(?:\[|\{)/,
    'recap must not build from a stored recap object');
});

test('RECAP source: getCanonicalSession rebuilds from store (plan entries + sessionCompleted), no cache', () => {
  const body = fnBody(appSrc, 'function getCanonicalSession()');
  assert.match(body, /plannedExerciseEntries\(\)/, 'plan side derives from the store-backed plan entries');
  assert.match(body, /getSessionCompleted\(\)/, 'completion side replays the store sessionCompleted buffer');
  // It builds a fresh local session each call (AS.createActiveSession) rather than
  // reading/patching a retained module-level session object.
  assert.match(body, /createActiveSession\(/, 'a fresh canonical session is built on each call');
  assert.doesNotMatch(body, /\bcanonicalSessionCache\b|\b_canonicalSession\b/, 'no retained canonical-session cache');
});

test('REMAINING is derived: remainingPlannedExercises filters store order by the store completed set', () => {
  const body = fnBody(appSrc, 'function remainingPlannedExercises()');
  assert.match(body, /getSessionCompleted\(\)/, 'completion comes from the store buffer');
  assert.match(body, /plannedExerciseOrder\(\)/, 'the order comes from the store-derived plan order');
});

test('SUBSTITUTION reconciliation is single-sourced in activeSession.js (app.js only calls it)', () => {
  // The "a logged variant satisfies its base slot" logic must have exactly one home,
  // so recap and any future caller reconcile identically. app.js must not carry its
  // own copy — it calls AS.reconcileSubstitutedRemaining.
  assert.doesNotMatch(appSrc, /function\s+reconcileSubstitutedRemaining\b/,
    'app.js must not define its own copy of the reconciliation');
  assert.match(appSrc, /AS\.reconcileSubstitutedRemaining\(/, 'app.js calls the single activeSession.js implementation');
  assert.match(activeSessionSrc, /function reconcileSubstitutedRemaining\(/, 'the one implementation lives in activeSession.js');
});

// ── B. Behavioral: the derivations recompute from state on read (no memoized shadow) ──

test('SKIP behavioral: a spoken skip is reflected purely by the slot leaving the store plan', async () => {
  const h = await buildPlanMutationHarness();
  h.setActivePlannedSession({
    label: 'Pull day',
    exercises: [
      { name: 'Overhead Press', canonicalName: 'Overhead Press', liftCode: 'OHP01' },
      { name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01' },
      { name: 'Bench Press', canonicalName: 'Bench Press', liftCode: 'BEN01' },
    ],
    index: 0,
  });
  assert.ok(h.getExercises().includes('Romanian Deadlift'), 'precondition: RDL is in the store plan');

  assert.equal(h.tryApplyPlanMutation('no RDLs for me today'), true);

  // The ONLY record of the skip is the slot's absence from the store plan — a second
  // read gives the same store-derived answer (there is no stale shadow to resurrect it).
  assert.deepEqual(h.getExercises(), ['Overhead Press', 'Bench Press']);
  assert.deepEqual(h.getExercises(), ['Overhead Press', 'Bench Press'], 'stable across reads — no shadow');
});

test('RECAP/REMAINING behavioral: reconciled remaining is a pure function of (completed, remaining)', () => {
  // Same inputs → same output; changed inputs → changed output; nothing retained
  // between calls. This is the "derived-on-read, no memo" property the recap relies on.
  const base = AS.reconcileSubstitutedRemaining(['Overhead Press'], ['Dumbbell Flyes']);
  assert.deepEqual(base, ['Dumbbell Flyes'], 'base slot remains when only unrelated work is logged');

  // Log the variant → the base slot is reconciled away (ADD-4), recomputed from inputs.
  const afterVariant = AS.reconcileSubstitutedRemaining(['Overhead Press', 'Incline Dumbbell Flyes'], ['Dumbbell Flyes']);
  assert.deepEqual(afterVariant, [], 'a logged variant satisfies the base slot on re-derivation');

  // Idempotent / stateless: re-running the first call still gives the first answer.
  assert.deepEqual(AS.reconcileSubstitutedRemaining(['Overhead Press'], ['Dumbbell Flyes']), ['Dumbbell Flyes'],
    'no state carried between calls');
});

test('SUBSTITUTION behavioral: a canonical session derives completed/remaining from store inputs alone', () => {
  // Build the canonical model the recap uses, purely from (plan names, completed
  // names) — the same store-sourced inputs getCanonicalSession() feeds it — and show
  // remaining tracks the inputs with no external state.
  function canonicalRemaining(planNames, completedNames) {
    let s = AS.createActiveSession({ exercises: planNames.map(n => ({ name: n })) });
    for (const name of completedNames) {
      const after = AS.markCompleted(s, name);
      s = after !== s ? after : AS.markCompleted(AS.insertExercise(s, { name }), name);
    }
    const completed = AS.completedExercises(s).map(e => e.name).filter(Boolean);
    const remainingRaw = AS.remaining(s).map(e => e.name).filter(Boolean);
    return AS.reconcileSubstitutedRemaining(completed, remainingRaw);
  }
  // Nothing logged → everything remains.
  assert.deepEqual(canonicalRemaining(['Bench Press', 'Row'], []), ['Bench Press', 'Row']);
  // Log a variant of a planned slot → that slot is satisfied on re-derivation
  // ("Incline Dumbbell Flyes" is a recognized variant of the "Dumbbell Flyes" slot).
  assert.deepEqual(canonicalRemaining(['Dumbbell Flyes', 'Row'], ['Incline Dumbbell Flyes']), ['Row']);
});
