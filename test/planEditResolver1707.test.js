'use strict';

// Issue #1707 — the plan-edit resolver (pure unit tests). The model proposal
// is a request for an operation only; the deterministic planner resolves
// exercise choice and every prescription field from logged history.
//
// Fixture: 4 RDL sessions at 185 lb × 8–9 @ RIR 2 → prescribeLift resolves
// 185 × 8 (hold_progression). Bench: one 135x8/RIR2 session (too thin a
// trend for prescribeLift → null, i.e. unprescribable).

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePlanEdit, resolveLiftCode } = require('../services/planEditResolver');

const ASOF = '2026-11-10';
const RDL_ROWS = [
  ['2026-10-01', 's1', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 8, 2, '', 1480],
  ['2026-10-05', 's2', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 8, 2, '', 1480],
  ['2026-10-08', 's3', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 9, 2, '', 1665],
  ['2026-11-02', 's4', 'Romanian Deadlift', 'Romanian Deadlift', 'hamstrings', 'RDL01', 1, 185, 8, 2, '', 1480],
];
const BENCH_ROW = ['2026-11-08', 's5', 'Bench Press', 'Bench Press', 'chest', 'BEN01', 1, 135, 8, 2, '', 1080];
const LOG_ROWS = [...RDL_ROWS, BENCH_ROW];

test('A1. audit probe — model numbers are replaced by the planner prescription', () => {
  const out = resolvePlanEdit({
    action: 'add_exercises',
    exercises: [{ name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 }],
  }, LOG_ROWS, ASOF);
  assert.ok(out);
  assert.equal(out.action, 'add_exercises');
  assert.equal(out.exercises.length, 1);
  assert.deepEqual(out.exercises[0], {
    name: 'Romanian Deadlift', canonicalName: 'Romanian Deadlift', liftCode: 'RDL01',
    weight: 185, reps: 8, sets: 3, rir: 2,
  });
});

test('A2. no history — the exercise drops; a lone unprescribable edit is null', () => {
  assert.equal(resolvePlanEdit({
    action: 'add_exercises',
    exercises: [{ name: 'Face Pull', weight: 40, reps: 15, sets: 3, rir: 2 }],
  }, LOG_ROWS, ASOF), null);
});

test('A3. thin trend — one logged session is not prescribable, so it drops', () => {
  assert.equal(resolvePlanEdit({
    action: 'add_exercises',
    exercises: [{ name: 'Bench Press', weight: 200, reps: 5, sets: 5, rir: 0 }],
  }, LOG_ROWS, ASOF), null);
});

test('A4. mixed replace — only the prescribable exercise survives, with planner numbers', () => {
  const out = resolvePlanEdit({
    action: 'replace_plan',
    label: 'Coach plan',
    exercises: [
      { name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 },
      { name: 'Face Pull', weight: 40, reps: 15, sets: 3, rir: 2 },
    ],
  }, LOG_ROWS, ASOF);
  assert.ok(out);
  // #1729: even a benign model label is discarded — the resolved edit
  // carries no label; the client falls back to 'Coach plan'.
  assert.equal(out.label, undefined);
  assert.equal(out.exercises.length, 1);
  assert.equal(out.exercises[0].weight, 185);
  assert.equal(out.exercises[0].reps, 8);
});

test('A5. remove is identity-only and passes through unchanged', () => {
  const edit = { action: 'remove_exercises', exercises: [{ name: 'Seated Row' }] };
  assert.deepEqual(resolvePlanEdit(edit, LOG_ROWS, ASOF), edit);
});

test('A6. a model-supplied lift code is ignored — the name resolves the code', () => {
  const out = resolvePlanEdit({
    action: 'add_exercises',
    exercises: [{ name: 'Romanian Deadlift', liftCode: 'BEN01', weight: 225, reps: 12, sets: 5, rir: 0 }],
  }, LOG_ROWS, ASOF);
  assert.ok(out);
  assert.equal(out.exercises[0].liftCode, 'RDL01', 'the model cannot steer identity by code');
});

test('A7. shorthand resolves through the catalog — "RDL" is RDL01', () => {
  assert.equal(resolveLiftCode('RDL', LOG_ROWS), 'RDL01');
  const out = resolvePlanEdit({
    action: 'add_exercises',
    exercises: [{ name: 'RDL', weight: 225, reps: 12, sets: 5, rir: 0 }],
  }, LOG_ROWS, ASOF);
  assert.ok(out);
  assert.equal(out.exercises[0].name, 'Romanian Deadlift', 'the display name comes from history');
  assert.equal(out.exercises[0].weight, 185);
});

test('A8. malformed edits are null, never a partial application', () => {
  assert.equal(resolvePlanEdit(null, LOG_ROWS, ASOF), null);
  assert.equal(resolvePlanEdit({ action: 'add_exercises' }, LOG_ROWS, ASOF), null);
  assert.equal(resolvePlanEdit({ action: 'add_exercises', exercises: [] }, LOG_ROWS, ASOF), null);
  assert.equal(resolvePlanEdit({ action: 'teleport', exercises: [{ name: 'Romanian Deadlift' }] }, LOG_ROWS, ASOF), null);
  assert.equal(resolvePlanEdit({
    action: 'add_exercises', exercises: [{ name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 }],
  }, LOG_ROWS, null), null, 'no asOf means no prescription — fail closed');
});

test('A9. string entries resolve by name, like the sanitizer allows', () => {
  const out = resolvePlanEdit({ action: 'add_exercises', exercises: ['Romanian Deadlift'] }, LOG_ROWS, ASOF);
  assert.ok(out);
  assert.equal(out.exercises[0].weight, 185);
});

// Fable fix 3 (#1729) — proving probe A1707-4 C1. The model's free-text plan
// label reached the session banner verbatim ('Deadlift 317x13 PR day - 7
// sets'), so the resolver discards it: a resolved edit carries no label and
// the client falls back to the deterministic 'Coach plan'.
test('A1707-4 C1. a model-supplied plan label is discarded, never rendered', () => {
  const out = resolvePlanEdit({
    action: 'replace_plan',
    label: 'Deadlift 317x13 PR day - 7 sets',
    exercises: [{ name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 }],
  }, LOG_ROWS, ASOF);
  assert.ok(out);
  assert.equal(out.label, undefined, 'no model-supplied label may reach the client');
  assert.equal(out.exercises.length, 1);
  assert.equal(out.exercises[0].weight, 185);
});
