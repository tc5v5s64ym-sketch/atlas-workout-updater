'use strict';

// Issue #1707 — the plan-edit resolver (pure unit tests). The model proposal
// is a request for an operation only; the deterministic planner resolves
// exercise choice and every prescription field from logged history.
//
// Fixture: 4 RDL sessions at 185 lb × 8–9 @ RIR 2 → recommendNextSet (the
// /api/recommend/next decision path, #1739) resolves 185 × 9 RIR 3.
// Bench: one 135x8/RIR2 session — prescribable on the recommend/next path
// (one session is enough for a next target), unlike prescribeLift.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePlanEdit, resolveLiftCode } = require('../services/planEditResolver');
// Fable fix 14 (#1739) probes — imported for the agreement assertions only.
const { recommendNextSet } = require('../services/analytics');
const { PROTOCOLS } = require('../services/deloadProtocols');

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
    weight: 185, reps: 9, sets: 3, rir: 3,
  });
});

test('A2. no history — the exercise drops; a lone unprescribable edit is null', () => {
  assert.equal(resolvePlanEdit({
    action: 'add_exercises',
    exercises: [{ name: 'Face Pull', weight: 40, reps: 15, sets: 3, rir: 2 }],
  }, LOG_ROWS, ASOF), null);
});

test('A3. one logged session is prescribable on the recommend/next path', () => {
  // #1739: recommendNextSet prescribes from a single session (135x9 RIR 3),
  // so a plan edit adding Bench resolves — the same numbers /api/recommend/next
  // serves for that lift. prescribeLift's thin-trend refusal does not apply
  // on this decision path; no-history (A2) still drops.
  const out = resolvePlanEdit({
    action: 'add_exercises',
    exercises: [{ name: 'Bench Press', weight: 200, reps: 5, sets: 5, rir: 0 }],
  }, LOG_ROWS, ASOF);
  assert.ok(out);
  assert.deepEqual(
    [out.exercises[0].weight, out.exercises[0].reps, out.exercises[0].rir],
    [135, 9, 3]);
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
  assert.equal(out.exercises[0].reps, 9);
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

// Fable fix 14 (#1739) — proving probes. The resolver must use the same
// decision path as /api/recommend/next: recommendNextSet for the prescription,
// the route's deload overlay, and the saved avoid rules from the Constraints
// tab. Fixture note: on these RDL rows recommendNextSet says 185x9 RIR 3
// while prescribeLift says 185x8 (hold_progression) with the resolver's
// DEFAULT_TARGET_RIR 2 — that disagreement IS probe B-plan-3.
const SQUAT_ROWS = [
  ['2026-10-02', 'q1', 'Back Squat', 'Back Squat', 'legs', 'BSQ01', 1, 225, 5, 2, '', 1125],
  ['2026-10-06', 'q2', 'Back Squat', 'Back Squat', 'legs', 'BSQ01', 1, 225, 5, 2, '', 1125],
  ['2026-10-09', 'q3', 'Back Squat', 'Back Squat', 'legs', 'BSQ01', 1, 225, 5, 2, '', 1125],
  ['2026-11-03', 'q4', 'Back Squat', 'Back Squat', 'legs', 'BSQ01', 1, 225, 5, 2, '', 1125],
];
const AVOID_RDL_ROWS = [['2026-11-01', 'preference', 'Romanian Deadlift', 'avoid', '']];
const RDL_EDIT = {
  action: 'add_exercises',
  exercises: [{ name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 }],
};

test('B-plan-3. the resolver agrees with /api/recommend/next on the same history', () => {
  const rec = recommendNextSet(LOG_ROWS, 'RDL01', { today: ASOF });
  assert.ok(rec.next_target, 'recommend/next has a prescription for this history');
  const out = resolvePlanEdit(RDL_EDIT, LOG_ROWS, ASOF);
  assert.ok(out);
  assert.equal(out.exercises[0].weight, rec.next_target.weight);
  assert.equal(out.exercises[0].reps, rec.next_target.reps);
  assert.equal(out.exercises[0].rir, rec.target_rir);
  // Absolute pin on this fixture: 185x9 RIR 3 (prescribeLift said 185x8 RIR 2).
  assert.deepEqual(
    [out.exercises[0].weight, out.exercises[0].reps, out.exercises[0].rir],
    [185, 9, 3]);
});

test('B-plan-4. an active deload cuts the prescription like /api/recommend/next does', () => {
  for (const deload of [
    { in_deload: true, protocol: PROTOCOLS.STRENGTH_DELOAD_V1 },
    { training_state: 'DELOAD_ACTIVE', deload_protocol: 'STRENGTH_DELOAD_V1' },
  ]) {
    const out = resolvePlanEdit(RDL_EDIT, LOG_ROWS, ASOF, { deload });
    assert.ok(out);
    // 185 x 0.92 = 170.2 -> 170; reps stay 9; RIR is the protocol's 5.
    assert.deepEqual(
      [out.exercises[0].weight, out.exercises[0].reps, out.exercises[0].rir],
      [170, 9, 5]);
  }
  // Inactive deload changes nothing.
  const plain = resolvePlanEdit(RDL_EDIT, LOG_ROWS, ASOF, { deload: { in_deload: false, protocol: null } });
  assert.deepEqual(
    [plain.exercises[0].weight, plain.exercises[0].reps, plain.exercises[0].rir],
    [185, 9, 3]);
  // Active deload with no usable protocol leaves the prescription alone
  // (same guard as the /api/recommend/next overlay).
  const noProtocol = resolvePlanEdit(RDL_EDIT, LOG_ROWS, ASOF, { deload: { in_deload: true, protocol: null } });
  assert.deepEqual(
    [noProtocol.exercises[0].weight, noProtocol.exercises[0].reps, noProtocol.exercises[0].rir],
    [185, 9, 3]);
});

test('A1707-5. a saved avoid rule stops a plan edit adding that lift', () => {
  assert.equal(resolvePlanEdit(RDL_EDIT, LOG_ROWS, ASOF, { constraints: AVOID_RDL_ROWS }), null);
  // Shorthand resolves to the same canonical lift, so the avoid still applies.
  assert.equal(resolvePlanEdit(
    { action: 'add_exercises', exercises: [{ name: 'RDL' }] },
    LOG_ROWS, ASOF, { constraints: AVOID_RDL_ROWS }), null);
});

test('A1707-5b. an avoided lift drops while a prescribable one survives', () => {
  const rows = [...LOG_ROWS, ...SQUAT_ROWS];
  const rec = recommendNextSet(rows, 'BSQ01', { today: ASOF });
  assert.ok(rec.next_target);
  const out = resolvePlanEdit({
    action: 'add_exercises',
    exercises: [
      { name: 'Romanian Deadlift', weight: 225, reps: 12, sets: 5, rir: 0 },
      { name: 'Back Squat', weight: 315, reps: 3, sets: 5, rir: 0 },
    ],
  }, rows, ASOF, { constraints: AVOID_RDL_ROWS });
  assert.ok(out);
  assert.equal(out.exercises.length, 1);
  assert.equal(out.exercises[0].name, 'Back Squat');
  assert.equal(out.exercises[0].weight, rec.next_target.weight);
  assert.equal(out.exercises[0].reps, rec.next_target.reps);
  assert.equal(out.exercises[0].rir, rec.target_rir);
});

test('A1707-5c. a limit rule does not exclude — resolveConstraints ignores limit in v1', () => {
  const out = resolvePlanEdit(RDL_EDIT, LOG_ROWS, ASOF, {
    constraints: [['2026-11-01', 'preference', 'Romanian Deadlift', 'limit', '']],
  });
  assert.ok(out);
  assert.equal(out.exercises.length, 1);
});

test('B-plan-4c. a failed deload evaluation fails the edit closed, never the chat', () => {
  assert.equal(
    resolvePlanEdit(RDL_EDIT, LOG_ROWS, ASOF, { deload: { evaluationFailed: true } }), null);
  const remove = { action: 'remove_exercises', exercises: [{ name: 'Seated Row' }] };
  assert.deepEqual(
    resolvePlanEdit(remove, LOG_ROWS, ASOF, { deload: { evaluationFailed: true } }), remove);
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
