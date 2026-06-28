'use strict';

// B2 — Canonical active session state: the SAVE payload derives from the canonical
// session.
//
// QA campaign finding B2 (docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md; BACKLOG.md):
// "surfaces (parser/UI/coach/preview/save) must derive from one canonical
// active-session representation." The trust-critical contradictions (plan-card drift,
// success-card vs 'didn't catch') shipped in PR #652/#653. This closes the named
// residual: the end-of-session manual save payload mapped the RAW
// `activePlannedSession.exercises` holder (public/app.js, comment: "Fix deferred")
// while its mid-session sibling already derived from the canonical session via
// currentPlannedExercise(). That was the last raw-holder read on the SAVE surface.
//
// Fix: the closeout `plan_exercises` derives from getCanonicalSession() through the
// pure planExercisesFromCanonical() — the same canonical model the card / coach /
// preview read — and excludes off-plan inserts so a logged accessory is never sent
// as a PRESCRIBED substitution source. Behavior-preserving for inferPrescribedPairs
// (completed + pending planned slots are both kept), but the save payload can no
// longer drift from the visible session. No write-path / trust-loop / proof-field /
// schema / parser change.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// The canonical session model is UMD — the browser IIFE and the tests run the
// IDENTICAL logic (same pattern as the other activeSession tests).
const activeSession = require('../public/activeSession');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// Extract the pure planExercisesFromCanonical() from app.js (same technique as
// test/activeSessionSurfaceConsistency.test.js — the browser IIFE has no export).
function loadPlanExercisesFromCanonical() {
  const start = appSrc.indexOf('function planExercisesFromCanonical(');
  assert.ok(start !== -1, 'planExercisesFromCanonical must exist in app.js');
  const end = appSrc.indexOf('\nfunction ', start + 1);
  const fnSrc = appSrc.slice(start, end === -1 ? start + 1200 : end);
  // Newline before the return: the slice may end on a // comment line, which would
  // otherwise swallow an appended same-line statement.
  return new Function(`${fnSrc}\n; return planExercisesFromCanonical;`)();
}

// Build a canonical session the way getCanonicalSession() does: start from a plan,
// replay logged completions (a logged name that doesn't match a planned slot is an
// off-plan insert), so the test exercises the real shape the save payload sees.
function canonicalFrom(plannedExercises, loggedNames) {
  let s = activeSession.createActiveSession({ exercises: plannedExercises });
  for (const name of loggedNames) {
    const after = activeSession.markCompleted(s, name);
    s = after !== s ? after : activeSession.markCompleted(activeSession.insertExercise(s, { name }), name);
  }
  return s;
}

// ── 1. The save payload comes from the canonical model, not the raw holder ────────

test('b2-save: the closeout plan_exercises is derived from getCanonicalSession()', () => {
  const start = appSrc.indexOf('if (activePlannedSession && activePlannedSession.exercises.length > 0) {');
  // Find the manual/closeout block (the one that assigns payload.plan_exercises).
  let idx = appSrc.indexOf('payload.plan_exercises');
  assert.ok(idx !== -1, 'the closeout plan_exercises assignment must exist');
  // Slice a window around the assignment for structural assertions.
  const blockStart = appSrc.lastIndexOf('if (activePlannedSession', idx);
  const block = appSrc.slice(blockStart, idx + 400);
  assert.ok(/getCanonicalSession\(\)/.test(block),
    'the closeout payload must read the canonical session');
  assert.ok(/planExercisesFromCanonical\(/.test(block),
    'the closeout payload must map the canonical session via planExercisesFromCanonical');
  assert.ok(start !== -1, 'the planned-session guard remains');
});

test('b2-save: the deferred "Fix deferred" note and the raw-map-only path are gone', () => {
  assert.equal((appSrc.match(/Sends the full plan/g) || []).length, 0,
    'the deferred full-plan comment must be removed');
  // The raw map survives only as the fallback inside a ternary, never as the sole
  // unconditional assignment.
  assert.ok(/canonicalPlan\.length\s*\?\s*canonicalPlan/.test(appSrc),
    'the canonical plan is preferred, with the raw plan only as a fallback');
});

// ── 2. planExercisesFromCanonical: planned-origin only, completed + pending kept ──

test('b2-save: payload keeps completed + pending planned slots (both needed for inference)', () => {
  const build = loadPlanExercisesFromCanonical();
  // Plan: Bench (logged → completed), Deadlift (not logged → pending), OHP (pending).
  const session = canonicalFrom(
    [{ name: 'Bench Press', liftCode: 'BP01' }, { name: 'Deadlift', liftCode: 'DL01' }, { name: 'Overhead Press' }],
    ['Bench Press']
  );
  const payload = build(session);
  assert.deepEqual(payload, [
    { name: 'Bench Press', lift_code: 'BP01' }, // completed planned — kept so its logged row is exact-matched/claimed
    { name: 'Deadlift', lift_code: 'DL01' },    // pending planned — legitimate substitution source
    { name: 'Overhead Press' },                 // pending planned, no lift_code → no lift_code key
  ]);
});

test('b2-save: an off-plan insert is excluded — never a prescribed substitution source', () => {
  const build = loadPlanExercisesFromCanonical();
  // Bench is planned+logged; Hammer Curls is an off-plan insert (not in the plan).
  const session = canonicalFrom(
    [{ name: 'Bench Press', liftCode: 'BP01' }],
    ['Bench Press', 'Hammer Curls']
  );
  const names = build(session).map(p => p.name);
  assert.ok(names.includes('Bench Press'), 'the planned lift is kept');
  assert.ok(!names.includes('Hammer Curls'),
    'the off-plan insert must NOT appear in plan_exercises (it is logged work, not a prescription)');
  // Sanity: the insert really is represented in the canonical session (as inserted).
  const inserted = session.exercises.find(e => /hammer curls/i.test(e.name));
  assert.ok(inserted && inserted.source === 'inserted', 'the insert is in the canonical session as inserted');
});

test('b2-save: lift_code is preserved and omitted correctly', () => {
  const build = loadPlanExercisesFromCanonical();
  const session = activeSession.createActiveSession({
    exercises: [{ name: 'Squat', liftCode: 'SQ01' }, { name: 'Lunge' }]
  });
  assert.deepEqual(build(session), [{ name: 'Squat', lift_code: 'SQ01' }, { name: 'Lunge' }]);
});

test('b2-save: a missing / empty canonical session yields an empty payload (caller falls back)', () => {
  const build = loadPlanExercisesFromCanonical();
  assert.deepEqual(build(null), []);
  assert.deepEqual(build(undefined), []);
  assert.deepEqual(build({}), []);
  assert.deepEqual(build({ exercises: [] }), []);
});

// ── 3. End-to-end agreement: the save payload equals what the card/coach would see ─
// The whole point of B2: the planned-origin set the save payload sends is exactly the
// planned-origin set of the canonical session every other surface derives from.

test('b2-save: save payload names == canonical planned-origin names (no drift)', () => {
  const build = loadPlanExercisesFromCanonical();
  const session = canonicalFrom(
    [{ name: 'Bench Press' }, { name: 'Deadlift' }, { name: 'Rows' }],
    ['Bench Press', 'Curls'] // Curls = off-plan insert
  );
  const payloadNames = build(session).map(p => p.name).sort();
  const canonicalPlannedNames = session.exercises
    .filter(e => e.source !== 'inserted')
    .map(e => e.name)
    .sort();
  assert.deepEqual(payloadNames, canonicalPlannedNames,
    'the save payload derives the same planned-origin exercises as the canonical session');
});
