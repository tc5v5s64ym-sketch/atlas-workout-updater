'use strict';

// Plan-context parsing (issue #1685) — the parse receives the session plan.
//
// The client sends its real plan as `context.todayPlan` (see planForParse in
// src/app/app.js); the goldens seam sends the golden's declared plan lines.
// Both shapes are accepted: objects { name, weight, reps, sets, rir } and
// slash-notation plan lines ('Goblet Squat 35 10/2 x3'). Every rule below is
// fail-closed: a plan that does not uniquely match, a turn that does not state
// what the rule needs, or a shape with unaccounted numbers falls through to
// the existing ask — never a guess, never a partial log.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkoutText } = require('../services/workoutTextParser');

const PRIYA_PLAN_LINES = [
  'Goblet Squat 35 10/2 x3',
  'Dumbbell Bench Press 25 10 x3',
  'One-Arm Row 30 10 x3',
];
const PRIYA_PLAN_OBJS = [
  { name: 'Goblet Squat', weight: 35, reps: 10, sets: 3, rir: 2 },
  { name: 'Dumbbell Bench Press', weight: 25, reps: 10, sets: 3, rir: 2 },
  { name: 'One-Arm Row', weight: 30, reps: 10, sets: 3, rir: 2 },
];

const compact = (r) => (r.sets || []).map(s => [s.weight, s.reps, s.rir]);

// ── C1: unique-family resolution ────────────────────────────────────────────

test('C1: bare Rows resolves to the plan\'s unique row (slash, no prose)', () => {
  const r = parseWorkoutText('Rows 95 10/2 x3', { todayPlan: ['Seated Row 95 10/2 x3'] });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Seated Row');
  assert.deepEqual(compact(r), [[95, 10, 2], [95, 10, 2], [95, 10, 2]]);
});

test('C1: bare press resolves to the plan\'s unique press', () => {
  const r = parseWorkoutText('press 115 6/2 x3', { todayPlan: ['Overhead Press 115 6/2 x3'] });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Overhead Press');
  assert.deepEqual(compact(r), [[115, 6, 2], [115, 6, 2], [115, 6, 2]]);
});

test('C1: bare Bench resolves to the plan\'s dumbbell bench, not Bench Press', () => {
  const r = parseWorkoutText('Bench 25 10 x3', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Dumbbell Bench Press');
  assert.deepEqual(compact(r), [[25, 10, null], [25, 10, null], [25, 10, null]]);
});

test('C1: bare Incline resolves to the plan\'s incline lift', () => {
  const r = parseWorkoutText('Incline 75 8/2 x3', { todayPlan: ['Incline Dumbbell Bench Press 75 8/2 x3'] });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Incline Dumbbell Bench Press');
});

test('C1: prose lead squats resolves to the plan\'s squat', () => {
  const r = parseWorkoutText('Ok squats done!! I did the 35 pound one, 3 sets of 10.',
    { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Goblet Squat');
});

test('C1 negative: two plan rows — the bare lead still asks', () => {
  const r = parseWorkoutText('Rows 95 10/2 x3', {
    todayPlan: ['Seated Row 95 10/2 x3', 'Bent-Over Row 135 8/2 x3'],
  });
  assert.equal(r.intent, 'needs_clarification');
  assert.ok((r.warnings || []).includes('ambiguous_exercise_alias'));
});

test('C1 negative: no row in the plan — the bare lead still asks', () => {
  const r = parseWorkoutText('Rows 95 10/2 x3', { todayPlan: ['Bench Press 225 5/2 x3'] });
  assert.equal(r.intent, 'needs_clarification');
  assert.ok((r.warnings || []).includes('ambiguous_exercise_alias'));
});

test('C1 negative: no plan at all — existing behaviour stands', () => {
  const r = parseWorkoutText('Rows 95 10/2 x3');
  assert.equal(r.intent, 'needs_clarification');
  assert.ok((r.warnings || []).includes('ambiguous_exercise_alias'));
  const bench = parseWorkoutText('Bench 225 5/2 x3');
  assert.equal(bench.intent, 'log_sets');
  assert.equal(bench.canonical_name, 'Bench Press');
});

// ── C2: prose set shapes (no plan needed — the numbers are all stated) ─────

test('C2 shape A: pounds, reps each arm, sets — per-side load', () => {
  const r = parseWorkoutText('One-Arm Row 30 pounds, 10 each arm, 3 sets');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'One-Arm Row');
  assert.deepEqual(compact(r), [[30, 10, null], [30, 10, null], [30, 10, null]]);
  assert.ok(r.sets.every(s => s.load_note === 'per_hand'));
});

test('C2 shape B: pound one, N sets of M', () => {
  const r = parseWorkoutText('Goblet Squat 35 pound one, 3 sets of 10');
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'Goblet Squat');
  assert.deepEqual(compact(r), [[35, 10, null], [35, 10, null], [35, 10, null]]);
});

test('C2 negative: unaccounted numbers refuse the prose shape — asks, never a partial log', () => {
  const r = parseWorkoutText('One-Arm Row 30 pounds, 10 each arm, 3 sets, then 20 pounds');
  assert.equal(r.intent, 'needs_clarification');
});

// ── C3: the RIR register ────────────────────────────────────────────────────

test('C3: Tank answer applies to every set', () => {
  const r = parseWorkoutText('One-Arm Row 30 pounds, 10 each arm, 3 sets. Tank answer: 2.');
  assert.equal(r.intent, 'log_sets');
  assert.deepEqual(compact(r), [[30, 10, 2], [30, 10, 2], [30, 10, 2]]);
});

test('C3: the last-set answer applies to the last set only', () => {
  const r = parseWorkoutText('Goblet Squat 35 pound one, 3 sets of 10. Honestly the last set the answer was like... 1? Maybe 1.');
  assert.equal(r.intent, 'log_sets');
  assert.deepEqual(compact(r), [[35, 10, null], [35, 10, null], [35, 10, 1]]);
});

// ── C4: plan-deviation bail (coordinator ruling, comment 6729942980) ───────

const BENCH_BAIL = 'Bench question — on like rep 7 my left arm got wobbly and I stopped at 8 instead of 10. Is that bad?? I did that on all 3 sets basically.';

test('C4: bench bail logs plan weight with provenance, in both plan shapes', () => {
  for (const plan of [PRIYA_PLAN_LINES, PRIYA_PLAN_OBJS]) {
    const r = parseWorkoutText(BENCH_BAIL, { todayPlan: plan });
    assert.equal(r.intent, 'log_sets', JSON.stringify(plan));
    assert.equal(r.canonical_name, 'Dumbbell Bench Press');
    assert.deepEqual(compact(r), [[25, 8, null], [25, 8, null], [25, 8, null]]);
    assert.ok(r.sets.every(s => s.weight_source === 'plan'),
      'plan-supplied weight is marked, not passed off as user-typed');
  }
});

test('C4 negative: turn names no family — still asks', () => {
  const r = parseWorkoutText('I stopped at 8 instead of 10. I did that on all 3 sets basically.',
    { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'needs_clarification');
});

test('C4 negative: no deviation stated — still asks', () => {
  const r = parseWorkoutText('Bench question — my left arm got wobbly. Is that bad?? I did 10 on all 3 sets basically.',
    { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'needs_clarification');
});

test('C4 negative: deviation equals the plan reps — no bail to log', () => {
  const r = parseWorkoutText('Bench question — I stopped at 10 instead of 10. I did that on all 3 sets basically.',
    { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'needs_clarification');
});

test('C4 negative: two bench lifts in the plan — still asks', () => {
  const r = parseWorkoutText(BENCH_BAIL, {
    todayPlan: ['Bench Press 225 5/2 x3', 'Dumbbell Bench Press 25 10 x3'],
  });
  assert.equal(r.intent, 'needs_clarification');
});

test('C4 negative: weight stated in the turn — the plan weight is not used', () => {
  const r = parseWorkoutText('Bench 25 pounds, stopped at 8 instead of 10. I did that on all 3 sets basically.',
    { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'needs_clarification');
  assert.ok(!r.sets || !r.sets.some(s => s.weight_source === 'plan'));
});

// ── RIR-from-plan fill (C4-pattern): exact plan match only ────────────────

test('RIR fill: slash sets matching the plan exactly read RIR as prescribed', () => {
  const r = parseWorkoutText('Goblet Squat 35 10 x3', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'log_sets');
  assert.deepEqual(compact(r), [[35, 10, 2], [35, 10, 2], [35, 10, 2]]);
  assert.ok(r.sets.every(s => s.rir_source === 'plan'));
});

test('RIR fill: a stated RIR always wins over the plan', () => {
  const r = parseWorkoutText('Goblet Squat 35 10/1 x3', { todayPlan: PRIYA_PLAN_LINES });
  assert.deepEqual(compact(r), [[35, 10, 1], [35, 10, 1], [35, 10, 1]]);
  assert.ok(r.sets.every(s => s.rir_source === undefined));
});

test('RIR fill negative: a deviating turn keeps its null RIR', () => {
  const r = parseWorkoutText('Dumbbell Bench Press 25 8 x3', { todayPlan: PRIYA_PLAN_OBJS });
  assert.deepEqual(compact(r), [[25, 8, null], [25, 8, null], [25, 8, null]]);
  assert.ok(r.sets.every(s => s.rir_source === undefined));
});

test('RIR fill negative: plan states no RIR — nothing to fill', () => {
  const r = parseWorkoutText('Dumbbell Bench Press 25 10 x3', { todayPlan: PRIYA_PLAN_LINES });
  assert.deepEqual(compact(r), [[25, 10, null], [25, 10, null], [25, 10, null]]);
  assert.ok(r.sets.every(s => s.rir_source === undefined));
});

// ── Plan shapes + duplicates ────────────────────────────────────────────────

test('plan objects and plan lines agree on the Priya turns', () => {
  const turns = [
    'Ok squats done!! I did the 35 pound one, 3 sets of 10. Honestly the last set the answer was like... 1? Maybe 1.',
    BENCH_BAIL,
    'Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Plank 40 seconds!! That is a record for me.',
  ];
  for (const input of turns) {
    const fromLines = parseWorkoutText(input, { todayPlan: PRIYA_PLAN_LINES });
    const fromObjs = parseWorkoutText(input, { todayPlan: PRIYA_PLAN_OBJS });
    assert.equal(fromLines.intent, 'log_sets', input);
    assert.equal(fromObjs.intent, 'log_sets', input);
    assert.equal(fromLines.canonical_name, fromObjs.canonical_name, input);
    assert.deepEqual(compact(fromLines), compact(fromObjs), input);
  }
});

test('duplicate plan slots refuse the plan lookup', () => {
  const r = parseWorkoutText(BENCH_BAIL, {
    todayPlan: ['Dumbbell Bench Press 25 10 x3', 'Dumbbell Bench Press 25 10 x3'],
  });
  assert.equal(r.intent, 'needs_clarification');
});

// ── Adversarial pre-review findings (issue #1685) ───────────────────────────
// The pre-review demonstrated all four as silent wrong logs on the first
// build; each now refuses (asks) or logs correctly instead.

// Finding 1: a narrative mention of another lift before the logged lift must
// never donate its numbers to this lift — with or without a plan. Narrative
// AFTER the sets stays harmless.
test('pre-review F1: narrative mention of another lift before the shape asks', () => {
  for (const ctx of [{ todayPlan: PRIYA_PLAN_LINES }, {}]) {
    const r = parseWorkoutText('Squats destroyed me, rows 30 pounds, 10 each arm, 3 sets', ctx);
    assert.equal(r.intent, 'needs_clarification', JSON.stringify(ctx));
    assert.ok(!r.canonical_name, 'must not log Goblet/Back Squat');
  }
  const r = parseWorkoutText('Bench was fine, rows 30 pounds, 10 each arm, 3 sets', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'needs_clarification');
  assert.ok(!r.canonical_name, 'must not log Dumbbell Bench Press');
});

test('pre-review F1 control: narrative after the sets still logs', () => {
  const r = parseWorkoutText('Rows done, 30 pounds, 10 each arm, 3 sets. Squats were brutal.', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'One-Arm Row');
  assert.deepEqual(compact(r), [[30, 10, null], [30, 10, null], [30, 10, null]]);
});

// Finding 2: the dumbbell shorthand ('30s') states a weight — C4 must not
// log the plan weight over it, and must not mislabel a stated weight as
// plan-sourced.
test('pre-review F2: C4 refuses a shorthand weight in the turn', () => {
  for (const shorthand of ['30s', '25s']) {
    const r = parseWorkoutText(`Bench question — did the ${shorthand}, stopped at 8 instead of 10, all 3 sets basically.`, { todayPlan: PRIYA_PLAN_LINES });
    assert.equal(r.intent, 'needs_clarification', shorthand);
    assert.ok(!(r.sets || []).some((s) => s.weight_source === 'plan'), `${shorthand} must not log a plan-sourced weight`);
  }
});

// Finding 3: a second set-count mention means sets C4 would silently drop.
test('pre-review F3: C4 refuses extra stated sets', () => {
  const r = parseWorkoutText('Bench question — stopped at 8 instead of 10, all 3 sets basically. Also did 2 more sets at 20.', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'needs_clarification');
  assert.deepEqual(r.sets || [], [], 'no sets logged when extra sets are stated');
});

// Finding 4: a Tank answer restated with 'Maybe N.' must log, as the
// answer-was form already does.
test('pre-review F4: Tank answer with a Maybe restatement logs', () => {
  const r = parseWorkoutText('Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Maybe 2.', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'log_sets');
  assert.equal(r.canonical_name, 'One-Arm Row');
  assert.deepEqual(compact(r), [[30, 10, 2], [30, 10, 2], [30, 10, 2]]);
});

// Delta pre-review finding 1: a plural strong-alias mention of another lift
// ('deadlifts') is visible to the shape guard — the remainder is singularized
// before matching. Known limit, out of scope: plurals whose singular has no
// alias entry at all ('curls', 'lunges', 'raises', 'presses').
test('pre-review delta F1: plural mention of another lift before the shape asks', () => {
  const r = parseWorkoutText('Rows and deadlifts done, 30 pounds, 10 each arm, 3 sets', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'needs_clarification');
  assert.ok(!r.canonical_name, 'must not log One-Arm Row');
});

// ── #1699 BLOCKING regression (Hammy verdict 6732401425) ───────────────────
// resolveExerciseFromPlan stripped only the FIRST matched family word, so a
// multi-word lift typed as `W x R @RIR` with a live plan left a name word in
// the rest ('Romanian Deadlift' → 'Deadlift 245 x 6 @3') and parseSetGroups
// could not read the x-shape — the turn asked instead of logging. The live
// path always sends the plan now, so every multi-word lift typed this way
// failed. The fix strips every matched family word. The gate specs type
// exactly these three lifts in this shape (F10D-R, F10S-GATE).

const GATE_PLAN_LINES = [
  'Romanian Deadlift 245 6/3 x3',
  'Back Squat 225 5 x3',
  'Overhead Press 115 6 x3',
];
const GATE_PLAN_OBJS = [
  { name: 'Romanian Deadlift', weight: 245, reps: 6, sets: 3, rir: 3 },
  { name: 'Back Squat', weight: 225, reps: 5, sets: 3, rir: 2 },
  { name: 'Overhead Press', weight: 115, reps: 6, sets: 3, rir: 2 },
];

test('#1699 regression: x-shape with a live plan logs for multi-word lifts (RDL)', () => {
  for (const plan of [GATE_PLAN_LINES, GATE_PLAN_OBJS]) {
    const r = parseWorkoutText('Romanian Deadlift 245 x 6 @3', { todayPlan: plan });
    assert.equal(r.intent, 'log_sets', JSON.stringify(r));
    assert.equal(r.canonical_name, 'Romanian Deadlift');
    assert.deepEqual(compact(r), [[245, 6, 3]]);
  }
});

test('#1699 regression: x-shape with a live plan logs for multi-word lifts (Back Squat)', () => {
  for (const plan of [GATE_PLAN_LINES, GATE_PLAN_OBJS]) {
    const r = parseWorkoutText('Back Squat 225 x 5 @2', { todayPlan: plan });
    assert.equal(r.intent, 'log_sets', JSON.stringify(r));
    assert.equal(r.canonical_name, 'Back Squat');
    assert.deepEqual(compact(r), [[225, 5, 2]]);
  }
});

test('#1699 regression: x-shape with a live plan logs for multi-word lifts (Overhead Press)', () => {
  for (const plan of [GATE_PLAN_LINES, GATE_PLAN_OBJS]) {
    const r = parseWorkoutText('Overhead Press 115 x 6 @2', { todayPlan: plan });
    assert.equal(r.intent, 'log_sets', JSON.stringify(r));
    assert.equal(r.canonical_name, 'Overhead Press');
    assert.deepEqual(compact(r), [[115, 6, 2]]);
  }
});

test('#1699 regression: slash shape with a live plan still logs for multi-word lifts', () => {
  for (const plan of [GATE_PLAN_LINES, GATE_PLAN_OBJS]) {
    const r = parseWorkoutText('Romanian Deadlift 245 6/3 x3', { todayPlan: plan });
    assert.equal(r.intent, 'log_sets', JSON.stringify(r));
    assert.equal(r.canonical_name, 'Romanian Deadlift');
    assert.deepEqual(compact(r), [[245, 6, 3], [245, 6, 3], [245, 6, 3]]);
    const b = parseWorkoutText('Back Squat 225 5/2 x3', { todayPlan: plan });
    assert.equal(b.intent, 'log_sets', JSON.stringify(b));
    assert.equal(b.canonical_name, 'Back Squat');
    assert.deepEqual(compact(b), [[225, 5, 2], [225, 5, 2], [225, 5, 2]]);
  }
});

test('#1699 regression: a repeated family word in the head is stripped twice', () => {
  const r = parseWorkoutText('Squats squats 35 x 10 @2', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'log_sets', JSON.stringify(r));
  assert.equal(r.canonical_name, 'Goblet Squat');
  assert.deepEqual(compact(r), [[35, 10, 2]]);
  const b = parseWorkoutText('Bench bench 25 x 8 @2', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(b.intent, 'log_sets', JSON.stringify(b));
  assert.equal(b.canonical_name, 'Dumbbell Bench Press');
  assert.deepEqual(compact(b), [[25, 8, 2]]);
});

// ── #1699 follow-up: false-claim guard (F10D-A / F10S-GATE) ─────────────────
// A family-word match must not claim a turn that names a DIFFERENT lift in
// full. 'Bench Press 215 x 5 @2' contains the family word 'press', so it
// resolved to the plan's Overhead Press and left 'Bench' in the rest —
// unplanned work failed to log. 'Front Squat … instead of Back Squat'
// resolved to Back Squat and the substitution never bound. Both now fall
// through to the alias/unknown path and log the typed lift.

const F10D_PLAN_OBJS = [
  { name: 'Romanian Deadlift', weight: 245, reps: 6, sets: 2, rir: 3 },
  { name: 'Back Squat', weight: 225, reps: 5, sets: 1, rir: 2 },
  { name: 'Overhead Press', weight: 115, reps: 6, sets: 1, rir: 2 },
];

test('#1699 false-claim: a substitution names its own lift, not the plan lift it replaces', () => {
  const r = parseWorkoutText('Front Squat 185 x 7 @2 instead of Back Squat', { todayPlan: F10D_PLAN_OBJS });
  assert.equal(r.intent, 'log_sets', JSON.stringify(r));
  assert.equal(r.canonical_name, 'Front Squat');
  assert.deepEqual(compact(r), [[185, 7, 2]]);
  assert.deepEqual(r.substitution, { for: 'Back Squat' });
  const slash = parseWorkoutText('Front Squat 185 7/2 x3 instead of Back Squat', { todayPlan: F10D_PLAN_OBJS });
  assert.equal(slash.intent, 'log_sets', JSON.stringify(slash));
  assert.equal(slash.canonical_name, 'Front Squat');
  assert.deepEqual(compact(slash), [[185, 7, 2], [185, 7, 2], [185, 7, 2]]);
  assert.deepEqual(slash.substitution, { for: 'Back Squat' });
});

test('#1699 false-claim: unplanned work naming another lift logs under its own name', () => {
  const r = parseWorkoutText('Bench Press 215 x 5 @2', { todayPlan: F10D_PLAN_OBJS });
  assert.equal(r.intent, 'log_sets', JSON.stringify(r));
  assert.equal(r.canonical_name, 'Bench Press');
  assert.deepEqual(compact(r), [[215, 5, 2]]);
});

test('#1699 false-claim: a variant the plan does not hold logs as itself', () => {
  const r = parseWorkoutText('Close Grip Bench Press 225 x 5 @2', { todayPlan: F10D_PLAN_OBJS });
  assert.equal(r.intent, 'log_sets', JSON.stringify(r));
  assert.equal(r.canonical_name, 'Close Grip Bench Press');
  assert.deepEqual(compact(r), [[225, 5, 2]]);
});

test('#1699 false-claim control: a discourse opener before the family lead still resolves to the plan lift', () => {
  // Slash shape: it tolerates the leftover discourse word in the rest, so
  // the test pins the guard's decision (claim kept) rather than the x-shape
  // reader. (A discourse opener before an x-shape — 'Ok squats 35 x 10 @2'
  // — still asks: parseSetGroups cannot read any x-shape after a leftover
  // word, on both the plan and no-plan paths. Pre-existing limit, out of
  // scope for this fix; the prose Priya turn covers the discourse opener
  // through the prose shapes.)
  const r = parseWorkoutText('Ok squats 35 10/2 x3', { todayPlan: PRIYA_PLAN_LINES });
  assert.equal(r.intent, 'log_sets', JSON.stringify(r));
  assert.equal(r.canonical_name, 'Goblet Squat');
  assert.deepEqual(compact(r), [[35, 10, 2], [35, 10, 2], [35, 10, 2]]);
});

