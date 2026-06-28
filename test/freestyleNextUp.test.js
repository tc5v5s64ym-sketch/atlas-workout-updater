'use strict';

// B4 — Freestyle logging must not auto-guide (owner live-test, 2026-06-28).
//
// When the user logs a set without an active plan or engaged Coach's Pick,
// handleSetLogged must parse, confirm, coach, and stop — it must NOT volunteer
// "Moving on — next up: X" by querying /api/plan/today.
//
// Root cause: the /api/plan/today fallback (`getNextExerciseInPlan`) was always
// called when `detail.nextPlanned` was null, even with an empty `plannedOrder`
// (freestyle). The fix gates the fallback on `hasEngagedPlan` so freestyle
// logging can never produce a next-up suggestion.
//
// Structural source-introspection tests — no jsdom dependency.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'coach-conversation.js'),
  'utf8'
);

const fnStart = src.indexOf('async function handleSetLogged(');
const fnEnd   = src.indexOf('async function handlePreviewReady(');
assert.ok(fnStart >= 0, 'handleSetLogged must exist in coach-conversation.js');
assert.ok(fnEnd > fnStart, 'handlePreviewReady must follow handleSetLogged');

const fnSrc = src.slice(fnStart, fnEnd);

test('handleSetLogged: derives hasEngagedPlan from detail.plannedOrder before computing nextEx', () => {
  assert.match(fnSrc, /const hasEngagedPlan = \(detail\.plannedOrder \|\| \[\]\)\.length > 0/,
    'must compute hasEngagedPlan from detail.plannedOrder so freestyle (empty array) is distinguished from guided');
});

test('handleSetLogged: only calls getNextExerciseInPlan when hasEngagedPlan is true', () => {
  assert.match(fnSrc, /hasEngagedPlan \? await getNextExerciseInPlan\(lastLogged\.exercise\) : null/,
    'getNextExerciseInPlan must be gated on hasEngagedPlan — freestyle logging must never trigger the plan lookup');
});

test('handleSetLogged: nextEx starts as null during freestyle (plannedOrder empty → hasEngagedPlan false)', () => {
  // The declaration must use hasEngagedPlan as the guard, not the unconditional fallback.
  assert.doesNotMatch(fnSrc, /let nextEx = detail\.nextPlanned \|\| await getNextExerciseInPlan/,
    'the old unconditional fallback must be gone — it fired during freestyle and produced unwanted next-up');
});

test('handleSetLogged: in-plan guard (inEngagedPlan) still rejects off-plan fallback next-up', () => {
  // Second line of defence: even when hasEngagedPlan is true and the fallback fires,
  // a returned lift that isn't in the engaged plan is still nulled out.
  assert.match(fnSrc, /inEngagedPlan/,
    'the inEngagedPlan guard must remain so an off-plan stored-program lift cannot override the closeout');
});

test('handleSetLogged: "Moving on — next up" handoff line still renders for guided sessions', () => {
  assert.match(fnSrc, /Moving on — next up: \$\{nextEx\}/,
    'the handoff line must still exist — it should render when nextEx is non-null (guided session only)');
});
