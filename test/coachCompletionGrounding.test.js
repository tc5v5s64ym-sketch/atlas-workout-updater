'use strict';

// ---------------------------------------------------------------------------
// Completed-work grounding — Soul Corpus V2 Session 12.
//
// Conducting the fifteen-session Soul Corpus through the real browser client produced two
// fabrications on one session:
//
//   1. After the athlete's goodbye ("Ok. That's... actually the first workout plan that
//      doesn't stress me out. Later.") Atlas replied
//        "Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift:
//         0 x 10 @ RIR 2 … Plank: 0 x 30 @ RIR 0 … You have completed the workout."
//      Three prescribed-but-never-performed slots were rendered as actual sets at zero
//      load, and the workout was declared complete while `plan_state.isComplete` was false.
//
//   2. One turn earlier, "You've logged 3 sessions so far" — three EXERCISES in ONE
//      session converted into three HISTORICAL sessions, while the engine's
//      `session_count` was 0.
//
// The deterministic verdicts were present and forwarded the whole time (`plan_state`,
// `session_tally`, `session_count`), and the prompt already carried COMPLETION-CLAIM and
// PLANNED-VS-DONE rules. Prompt rules are not enforcement: nothing REJECTED the prose.
// The live claim-validation seam at routes/coachOps.js covered plan MUTATION only.
//
// Part A — the detector and its state-awareness (the authority boundary, pure).
// Part B — the PRODUCTION /api/coach/chat route: a model that fabricates completion is
//          overridden by the engine's own logged-vs-remaining statement.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

const grounding = require('../services/coachResponseGrounding');

// The exact S12 state: three of six slots genuinely logged, three still outstanding,
// and no historical sessions on the sheet.
function s12Context() {
  return {
    plan_state: {
      planned: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row', 'Overhead Press', 'Romanian Deadlift', 'Plank'],
      completed: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row'],
      remaining: ['Overhead Press', 'Romanian Deadlift', 'Plank'],
      isComplete: false,
    },
    session_tally: {
      exercises: [
        { exercise: 'Barbell Squat', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }] },
        { exercise: 'Barbell Bench Press', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }] },
        { exercise: 'Barbell Row', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }] },
      ],
      total_working_sets: 9,
    },
    session_count: 0,
  };
}

// ── Part A — the authority boundary ────────────────────────────────────────

test('A1. PROOF 3 — the verbatim S12 fabrication is rejected (zero-load sets + completion)', () => {
  const reply = 'Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift: 0 x 10 @ RIR 2, 0 x 10 @ RIR 2, 0 x 10 @ RIR 2. Plank: 0 x 30 @ RIR 0, 0 x 30 @ RIR 0, 0 x 30 @ RIR 0. You have completed the workout.';
  const found = grounding.detectUngroundedCompletionClaim(reply, s12Context());
  assert.ok(found.length > 0, 'must be rejected');
  const kinds = new Set(found.map((f) => f.kind));
  assert.ok(kinds.has('fabricated_sets'), 'zero-load actual sets must be flagged');
  assert.ok(kinds.has('workout_completion'), 'the completion claim must be flagged');
});

test('A2. PROOF 6 — an exercise count can never become a historical session count', () => {
  const ctx = s12Context();
  for (const claim of ["You've logged 3 sessions so far.", 'You have completed 3 workouts.', '3 sessions so far.']) {
    const found = grounding.detectUngroundedCompletionClaim(claim, ctx);
    assert.ok(found.some((f) => f.kind === 'session_count'), `must flag: ${claim}`);
  }
  // The engine's own number is sayable.
  assert.equal(grounding.detectUngroundedCompletionClaim('You have logged 0 sessions so far.', ctx).length, 0);
});

test('A3. PROOF 6 — fail closed: a session count with no engine count is ungrounded', () => {
  const ctx = s12Context();
  delete ctx.session_count;
  const found = grounding.detectUngroundedCompletionClaim("You've logged 3 sessions so far.", ctx);
  assert.ok(found.some((f) => f.kind === 'session_count'), 'missing proof is a failure, not permission to guess');
});

test('A4. PROOF 1 — goodbye language does not complete remaining exercises', () => {
  const ctx = s12Context();
  for (const claim of [
    'You have completed the workout.',
    "That's the workout done.",
    'The session is complete.',
    "You're all done for today.",
    'Workout complete.',
    'You completed Overhead Press, Romanian Deadlift and Plank.',
  ]) {
    assert.ok(grounding.detectUngroundedCompletionClaim(claim, ctx).length > 0, `must flag: ${claim}`);
  }
});

test('A5. PROOF 2 — remaining slots stay remaining: honest framings pass unchanged', () => {
  const ctx = s12Context();
  for (const ok of [
    'The plan still shows Overhead Press, Romanian Deadlift, and Plank remaining.',
    'Overhead Press, Romanian Deadlift and Plank are still to come.',
    'Still remaining: Overhead Press 3 sets of 8 reps.',
    'Next up is Overhead Press, 3 sets of 8 at RIR 2 planned.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A5b. prescription prose about a remaining slot is never an actual-work claim', () => {
  const ctx = s12Context();
  // Caught in review by test/coachChatGrounding.test.js: an earlier draft keyed on set
  // NUMERALS, which rejected truthful planning prose. Numbers describe a prescription at
  // least as often as a performance, so only an explicit completed-work assertion counts.
  for (const ok of [
    'The plan calls for 200 for 10 reps at 1 RIR on Overhead Press to increase volume on a lift that has stalled.',
    'Overhead Press: 3 sets of 8 at RIR 2 — that is the target.',
    "You'll do Romanian Deadlift for 3 sets of 10.",
    'Plank is 3 sets of 30 seconds on the plan.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A5c. an RIR figure of 0 is not a zero LOAD', () => {
  const ctx = s12Context();
  assert.equal(grounding.detectUngroundedCompletionClaim('Barbell Squat: 45 at RIR 0 x 8.', ctx).length, 0);
  // But a genuine zero-load actual set still is one.
  assert.ok(grounding.detectUngroundedCompletionClaim('Plank: 0 x 30.', ctx).length > 0);
});

test('A6. PROOF 4 — genuinely completed exercises remain intact and sayable', () => {
  const ctx = s12Context();
  for (const ok of [
    'Barbell Squat: 45 x 8 at RIR 2, three sets.',
    'You logged Barbell Squat, Barbell Bench Press and Barbell Row today.',
    'You completed Barbell Squat.',
    'Nine working sets logged this session.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A7. PROOF 5 — completion is sayable once, and only once, the engine says so', () => {
  const ctx = s12Context();
  assert.ok(grounding.detectUngroundedCompletionClaim('You have completed the workout.', ctx).length > 0);
  const done = s12Context();
  done.plan_state.completed = done.plan_state.planned.slice();
  done.plan_state.remaining = [];
  done.plan_state.isComplete = true;
  assert.equal(grounding.detectUngroundedCompletionClaim('You have completed the workout.', done).length, 0,
    'a real completion must not be suppressed');
  assert.equal(grounding.workoutIsComplete(done), true);
  assert.equal(grounding.workoutIsComplete(ctx), false);
});

test('A8. PROOF 5 — fail closed: no authoritative session state means no completion claim', () => {
  for (const ctx of [{}, { plan_state: null }, { plan_state: { planned: [], completed: [], remaining: [], isComplete: false } }]) {
    assert.ok(grounding.detectUngroundedCompletionClaim('You have completed the workout.', ctx).length > 0,
      'absent state must not read as complete');
  }
});

test('A9. state-awareness: proposals, questions, quotations and negations are not claims', () => {
  const ctx = s12Context();
  for (const ok of [
    'Do you want me to mark the workout complete?',
    'I can mark the workout complete if you like.',
    "You said you'd completed the workout.",
    "You haven't completed the workout yet.",
    'Nothing is complete yet.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A9b. Codex #1225 P1 — a false completion asserted in ONE clause is caught, whatever the rest of the sentence does', () => {
  const ctx = s12Context();
  // Sentence-level state-awareness was too coarse: a question mark or a modal ANYWHERE in
  // the sentence excused the asserted clause, so these reached the athlete unchanged.
  for (const claim of [
    'You completed the workout, so should we cool down?',
    'You completed the workout, so you should cool down.',
    'You have completed the workout, but let me know if you want more.',
    'You have completed the workout; I can queue up next week if you like.',
    'Nice work — you completed the workout, and I could write it up now.',
  ]) {
    assert.ok(grounding.detectUngroundedCompletionClaim(claim, ctx).length > 0, `must flag: ${claim}`);
  }
});

test('A9c. Codex #1225 P1 — clause splitting adds detections without inventing them', () => {
  const ctx = s12Context();
  for (const ok of [
    // A genuine whole-sentence proposal or negation stays safe once split.
    "You haven't completed the workout, so let's keep going.",
    'Do you want me to say you completed the workout?',
    // An ordinary list is one clause — no comma-conjunction boundary inside it.
    'Barbell Squat, Barbell Bench Press and Barbell Row are logged.',
  ]) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('A9d. Codex #1225 P2 — a current-session count is not judged against the HISTORICAL count', () => {
  const done = s12Context();
  done.plan_state.completed = done.plan_state.planned.slice();
  done.plan_state.remaining = [];
  done.plan_state.isComplete = true;
  // session_count counts PREVIOUSLY logged sessions and excludes the in-progress one, so
  // this truthful line must not be rejected just because it differs from that number.
  for (const ok of ['You completed 1 workout today.', "That's 1 session done today.", 'You have logged 1 workout this session.']) {
    assert.equal(grounding.detectUngroundedCompletionClaim(ok, done).length, 0, `must NOT flag: ${ok}`);
  }
  // The historical claim is still caught — it carries no current-session framing.
  assert.ok(grounding.detectUngroundedCompletionClaim("You've logged 3 sessions so far.", done).length > 0);
});

test('A10. the deterministic replacement states logged and remaining, and claims nothing', () => {
  const statement = grounding.buildGroundedSessionStateStatement(s12Context());
  assert.match(statement, /Barbell Squat/);
  assert.match(statement, /Still remaining/);
  assert.match(statement, /Overhead Press/);
  assert.doesNotMatch(statement, /completed the workout/i);
  assert.doesNotMatch(statement, /\b0\s*x\s*\d+/);
  // No authoritative state → says so rather than inventing one.
  assert.match(grounding.buildGroundedSessionStateStatement({}), /don't have an authoritative record/);
});

test('A11. remainingExerciseNames trusts the tally over a stale remaining list', () => {
  const ctx = s12Context();
  ctx.plan_state.remaining = ['Overhead Press', 'Romanian Deadlift', 'Plank', 'Barbell Row'];
  const remaining = grounding.remainingExerciseNames(ctx);
  assert.ok(!remaining.includes('Barbell Row'), 'a logged lift is never reported as remaining');
  assert.deepEqual(remaining, ['Overhead Press', 'Romanian Deadlift', 'Plank']);
});

// Prescription-aware completion. A tally row is finished work only when the logged
// set count reaches the prescribed set count on the same context's current_plan.
// A11 above is unchanged: it has no current_plan, so the tally still proves the
// stale Barbell Row is not remaining.

function partialPlanContext() {
  return {
    current_plan: [
      { name: 'Seated Row', sets: 3, reps: 10, weight: 140, rir: 2 },
      { name: 'Incline DB Press', sets: 3, reps: 8, weight: 50, rir: 2 },
    ],
    plan_state: {
      planned: ['Seated Row', 'Incline DB Press'],
      completed: [],
      remaining: ['Seated Row', 'Incline DB Press'],
      isComplete: false,
    },
    session_tally: {
      exercises: [
        { exercise: 'Seated Row', sets: 1 },
        { exercise: 'Incline DB Press', sets: 1 },
      ],
    },
  };
}

test('A12. a partially logged planned lift stays remaining and is named under Still remaining', () => {
  const ctx = partialPlanContext();
  const remaining = grounding.remainingExerciseNames(ctx);
  assert.ok(remaining.includes('Seated Row'), '1 of 3 prescribed sets is not finished work');
  assert.ok(remaining.includes('Incline DB Press'), '1 of 3 prescribed sets is not finished work');
  assert.deepEqual(remaining, ['Seated Row', 'Incline DB Press']);
  const statement = grounding.buildGroundedSessionStateStatement(ctx);
  assert.match(statement, /Still remaining: Seated Row, Incline DB Press/);
});

test('A13. a planned lift logged to its prescribed set count leaves remaining', () => {
  const ctx = partialPlanContext();
  ctx.session_tally.exercises = [
    { exercise: 'Seated Row', sets: 3 },
    { exercise: 'Incline DB Press', sets: 1 },
  ];
  const remaining = grounding.remainingExerciseNames(ctx);
  assert.ok(!remaining.includes('Seated Row'), '3 of 3 prescribed sets is finished work');
  assert.deepEqual(remaining, ['Incline DB Press']);
});

test('A14. an off-plan logged lift in a stale remaining list leaves remaining', () => {
  const ctx = partialPlanContext();
  ctx.plan_state.planned = ['Seated Row', 'Incline DB Press', 'Face Pull'];
  ctx.plan_state.remaining = ['Seated Row', 'Incline DB Press', 'Face Pull'];
  ctx.session_tally.exercises = [{ exercise: 'Face Pull', sets: 2 }];
  const remaining = grounding.remainingExerciseNames(ctx);
  assert.ok(!remaining.includes('Face Pull'), 'no prescription is known, so any logged set completes it');
  assert.deepEqual(remaining, ['Seated Row', 'Incline DB Press']);
});

test('A15. a tally row with 0 sets does not complete a planned lift', () => {
  const ctx = partialPlanContext();
  ctx.session_tally.exercises = [{ exercise: 'Seated Row', sets: 0 }];
  const remaining = grounding.remainingExerciseNames(ctx);
  assert.ok(remaining.includes('Seated Row'));
  assert.deepEqual(remaining, ['Seated Row', 'Incline DB Press']);
});

test('A16. plan_state.completed keeps a lift out of remaining regardless of the tally', () => {
  const ctx = partialPlanContext();
  ctx.plan_state.completed = ['Seated Row'];
  ctx.session_tally.exercises = [{ exercise: 'Seated Row', sets: 1 }];
  const remaining = grounding.remainingExerciseNames(ctx);
  assert.ok(!remaining.includes('Seated Row'), 'plan_state.completed stays authoritative');
  assert.deepEqual(remaining, ['Incline DB Press']);
});

// ── Part C — recap-number grounding (Astra #1662, P1-4) ────────────────────
//
// services/coachResponseGrounding.js:494-563 checks completion / zero-load
// invention / remaining lifts / historical counts — not nonzero per-set
// numerical equivalence. The audit's constructed state (accepted RDL 275x6x3;
// retained rows 285x6 @2 x3) lets both "The RDLs are also logged as planned."
// and "You logged Romanian Deadlift at 275 for 6 reps across 3 sets." pass,
// and "bench 25x10 as planned" passes over actual 25x8 rows. The coach is
// instructed to use session_tally, but an instruction is not a validator.
//
// The detector judges recap/confirmation prose against the retained rows in
// session_tally (the authoritative record) and, for "as planned" claims,
// against the current_plan entry. Only an explicit completed-work assertion
// counts — a bare set enumeration is prescription as often as performance
// (A5b), so it is never judged here.

function recapContext() {
  return {
    current_plan: [
      { name: 'Romanian Deadlift', sets: 3, reps: 6, weight: 275, rir: 2 },
      { name: 'Barbell Bench Press', sets: 3, reps: 8, weight: 25, rir: 2 },
    ],
    plan_state: {
      planned: ['Romanian Deadlift', 'Barbell Bench Press'],
      completed: ['Romanian Deadlift', 'Barbell Bench Press'],
      remaining: [],
      isComplete: true,
    },
    session_tally: {
      exercises: [
        { exercise: 'Romanian Deadlift', sets: 3, per_set: [{ weight: 285, reps: 6, rir: 2 }, { weight: 285, reps: 6, rir: 2 }, { weight: 285, reps: 6, rir: 2 }], planned: true },
        { exercise: 'Barbell Bench Press', sets: 3, per_set: [{ weight: 25, reps: 8, rir: 2 }, { weight: 25, reps: 8, rir: 2 }, { weight: 25, reps: 8, rir: 2 }], planned: true },
      ],
      total_working_sets: 6,
    },
    session_count: 0,
  };
}

test('C1. Astra #1662 — "logged as planned" is judged against the plan, not taken on trust', () => {
  const ctx = recapContext();
  // Accepted 275x6x3, retained 285x6 @2 x3: the tally does NOT match the plan.
  const found = grounding.detectUngroundedRecapNumbers('The RDLs are also logged as planned.', ctx);
  assert.ok(found.some((f) => f.kind === 'recap_as_planned'), 'as-planned over mismatched rows must be flagged');
});

test('C2. Astra #1662 — a recap asserting the accepted (wrong) weight is flagged', () => {
  const ctx = recapContext();
  const found = grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 275 for 6 reps across 3 sets.', ctx);
  assert.ok(found.some((f) => f.kind === 'recap_numbers'), '275 asserted over retained 285 must be flagged');
});

test('C3. Astra #1662 — a recap asserting the retained numbers passes', () => {
  const ctx = recapContext();
  for (const ok of [
    'You logged Romanian Deadlift at 285 for 6 reps across 3 sets.',
    'You logged Barbell Bench Press at 25 for 8 reps across 3 sets.',
  ]) {
    assert.equal(grounding.detectUngroundedRecapNumbers(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('C4. Astra #1662 — the Priya equivalent: "bench 25x10 as planned" over 25x8 rows', () => {
  const ctx = recapContext();
  const found = grounding.detectUngroundedRecapNumbers('You logged bench 25x10 as planned.', ctx);
  assert.ok(found.some((f) => f.kind === 'recap_numbers'), '10 reps asserted over retained 8 must be flagged');
});

test('C5. Astra #1662 — a wrong set count is flagged; an ambiguous NxN with a true reading passes', () => {
  const ctx = recapContext();
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 285 for 6 reps across 2 sets.', ctx).length > 0,
    '2 sets asserted over 3 retained must be flagged');
  // "25x8" is ambiguous (weight x reps vs sets x reps); the weight reading matches
  // the retained rows, so the claim is grounded and must not be rejected.
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged bench 25x8.', ctx).length, 0,
    'an ambiguous shape with a true reading is grounded');
});

test('C6. #1709 — history IS judged: last-week numbers must match a recorded session', () => {
  const ctx = recapContext();
  // No recent_sessions in this context: a history claim has no recorded
  // session to bind to, so it fails closed (the old "never judged here" rule
  // is what let invented history reach the athlete).
  assert.ok(grounding.detectUngroundedRecapNumbers('Last week you logged Romanian Deadlift at 315 for 5 reps across 3 sets.', ctx).length > 0,
    'invented history with no recorded session must be flagged');
  // The same numbers grounded by a recorded session pass.
  const withHistory = { ...ctx, recent_sessions: [{ date: '2026-11-02', exercises: ['Romanian Deadlift'], sets: 3, volume: 4725, lift_sets: { 'Romanian Deadlift': [{ weight: 315, reps: 5, rir: 2 }, { weight: 315, reps: 5, rir: 2 }, { weight: 315, reps: 5, rir: 2 }] } }] };
  assert.equal(grounding.detectUngroundedRecapNumbers('Last week you logged Romanian Deadlift at 315 for 5 reps across 3 sets.', withHistory).length, 0,
    'history matching a recorded session is grounded');
  // … and numbers contradicting that recorded session are flagged.
  assert.ok(grounding.detectUngroundedRecapNumbers('Last week you logged Romanian Deadlift at 335 for 5 reps across 3 sets.', withHistory).length > 0,
    'history contradicting the recorded session must be flagged');
});

test('C6b. pre-review F1 — "a moment ago" is this session, not history', () => {
  const ctx = recapContext();
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 275 for 6 reps a moment ago.', ctx).length > 0,
    'a bare "ago" must not excuse a this-session recap');
});

test('C6c. pre-review F2 — "in the books" is a completion idiom and its numbers are judged', () => {
  const ctx = recapContext();
  assert.ok(grounding.detectUngroundedRecapNumbers('Romanian Deadlift 275 x 6 in the books.', ctx).length > 0,
    'wrong numbers in the books must be flagged');
  assert.equal(grounding.detectUngroundedRecapNumbers('Romanian Deadlift 285 x 6 in the books.', ctx).length, 0,
    'the retained numbers in the books are grounded');
});

test('C7. Astra #1662 — prescription prose and bare enumeration are never recap claims (A5b)', () => {
  const ctx = recapContext();
  for (const ok of [
    'The plan calls for 275 for 6 reps on Romanian Deadlift.',
    'Romanian Deadlift: 285 x 6 @ RIR 2, three sets.',
    'You logged Romanian Deadlift today.',
  ]) {
    assert.equal(grounding.detectUngroundedRecapNumbers(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

test('C8. Astra #1662 — fail closed: numbers asserted with no retained rows are ungrounded', () => {
  const ctx = recapContext();
  delete ctx.session_tally;
  const found = grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 275 for 6 reps across 3 sets.', ctx);
  assert.ok(found.some((f) => f.kind === 'recap_numbers'), 'no tally to check against is a failure, not permission to guess');
});

test('C9. Astra #1662 — a true "as planned" passes when tally and plan agree', () => {
  const ctx = recapContext();
  ctx.current_plan[0].weight = 285; // the plan itself now shows the retained load
  assert.equal(grounding.detectUngroundedRecapNumbers('The RDLs are also logged as planned.', ctx).length, 0,
    'tally matching the plan is a grounded as-planned claim');
});

test('C10. Astra #1662 — "as planned" fails for an off-plan extra, but its own rows still ground numbers', () => {
  const ctx = recapContext();
  ctx.session_tally.exercises.push({ exercise: 'Face Pull', sets: 2, per_set: [{ weight: 40, reps: 10, rir: 2 }, { weight: 40, reps: 10, rir: 2 }], planned: false });
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Face Pull as planned.', ctx).length > 0,
    'an off-plan lift was never planned, so as-planned is false');
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Face Pull at 40 for 10 reps across 2 sets.', ctx).length, 0,
    'the extra lift’s own retained rows still ground its numbers');
});

test('C11. Re-audit #1662 — a multi-lift clause is judged per lift, not skipped', () => {
  const ctx = recapContext();
  // The re-audit counterexample: a false RDL number beside a true bench
  // number passed every guard because the clause named two lifts. Each
  // per-lift assertion is now judged against its own retained rows.
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 275 for 6 reps and bench press at 25 for 8 reps.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'false RDL number in a multi-lift clause must be flagged');
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 285 for 6 reps and bench press at 99 for 8 reps.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'false bench number in a multi-lift clause must be flagged');
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 285 for 6 reps and bench press at 25 for 8 reps.', ctx).length, 0,
    'both-true multi-lift recap is grounded');
  // Alias-named lifts judge the same way ("RDLs" resolves per token — the
  // whole-message alias resolution alone returns one canonical key).
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged RDLs at 275 for 6 reps and bench press at 25 for 8 reps.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'false RDL number via alias in a multi-lift clause must be flagged');
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged RDLs at 285 for 6 reps and bench press at 25 for 8 reps.', ctx).length, 0,
    'both-true alias multi-lift recap is grounded');
  // Comma-joined per-lift assertions judge the same way.
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift 275 x 6, bench press 25 x 8.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'comma-joined false RDL number must be flagged');
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift 285 x 6, bench press 25 x 8.', ctx).length, 0,
    'comma-joined both-true recap is grounded');
  // "As planned" is judged per lift across the conjunction: the plan shows
  // RDL 275 against retained 285, so the joint claim is false for RDL.
  assert.ok(grounding.detectUngroundedRecapNumbers('The RDLs and bench are also logged as planned.', ctx)
    .some((f) => f.kind === 'recap_as_planned'), 'joint as-planned fails when one lift disagrees with its plan');
  ctx.current_plan[0].weight = 285; // the plan itself now shows the retained load
  assert.equal(grounding.detectUngroundedRecapNumbers('The RDLs and bench are also logged as planned.', ctx).length, 0,
    'joint as-planned passes when every lift agrees with its plan');
});

test('C14. Re-audit #1662 — exact exercise identity first, no variant collapse', () => {
  // Tally order: Barbell Bench Press 60.6x8x3 first, then Dumbbell Bench
  // Press 27.5x8x3. The KB canonicalizer collapses both variants to
  // "Bench Press", so a canonical-only lookup resolved by tally order and
  // judged every recap against the barbell rows.
  const ctx = recapContext();
  ctx.current_plan = [
    { name: 'Barbell Bench Press', sets: 3, reps: 8, weight: 60.6, rir: 2 },
    { name: 'Dumbbell Bench Press', sets: 3, reps: 8, weight: 27.5, rir: 2 },
  ];
  ctx.session_tally.exercises = [
    { exercise: 'Barbell Bench Press', sets: 3, per_set: [{ weight: 60.6, reps: 8, rir: 2 }, { weight: 60.6, reps: 8, rir: 2 }, { weight: 60.6, reps: 8, rir: 2 }], planned: true },
    { exercise: 'Dumbbell Bench Press', sets: 3, per_set: [{ weight: 27.5, reps: 8, rir: 2 }, { weight: 27.5, reps: 8, rir: 2 }, { weight: 27.5, reps: 8, rir: 2 }], planned: true },
  ];
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Dumbbell Bench Press at 27.5 for 8 reps across 3 sets.', ctx).length, 0,
    'true dumbbell recap must NOT be flagged');
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Barbell Bench Press at 60.6 for 8 reps across 3 sets.', ctx).length, 0,
    'true barbell recap must NOT be flagged');
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Dumbbell Bench Press at 60.6 for 8 reps across 3 sets.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'barbell weight asserted over the dumbbell rows must be flagged');
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Barbell Bench Press at 27.5 for 8 reps across 3 sets.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'dumbbell weight asserted over the barbell rows must be flagged');
  // A bare "bench press" names neither variant distinctively while both are
  // in the tally: fail closed rather than guessing a variant.
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged bench press at 27.5 for 8 reps across 3 sets.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'ambiguous bare-variant recap fails closed');
});

test('C15. Re-audit #1662 — decimal tokens carry their units (kg normalizes to lb)', () => {
  const ctx = recapContext();
  ctx.session_tally.exercises.push(
    { exercise: 'Seated Row', sets: 3, per_set: [{ weight: 60.6, reps: 8, rir: 2 }, { weight: 60.6, reps: 8, rir: 2 }, { weight: 60.6, reps: 8, rir: 2 }], planned: true },
  );
  // Retained Seated Row 60.6 lb x8x3 is 27.5 kg: the honest kg recap passes.
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Seated Row at 27.5 kg for 8 reps across 3 sets.', ctx).length, 0,
    'honest 27.5 kg recap (= 60.6 lb) must NOT be flagged');
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Seated Row 27.5 kg x 8 x 3.', ctx).length, 0,
    'honest kg triple-x recap must NOT be flagged');
  // A kg number is not a lb number: 60.6 kg is 133.6 lb, 100 kg is 220.5 lb.
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Seated Row at 60.6 kg for 8 reps across 3 sets.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'false 60.6 kg recap must be flagged');
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Seated Row 100 kg for 8 reps across 3 sets.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'false 100 kg recap must be flagged (bare N kg is a weight, not a dropped token)');
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Seated Row 60.6 kg x 8 x 3.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'false kg triple-x recap must be flagged');
  // A weight in a unit the validator cannot normalize is unvalidated, not absent.
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Seated Row at 100 stone for 8 reps across 3 sets.', ctx)
    .some((f) => f.kind === 'recap_numbers'), 'unhandled weight unit fails closed');
  // Unitless / lb shapes are unchanged.
  assert.equal(grounding.detectUngroundedRecapNumbers('You logged Seated Row at 60.6 for 8 reps across 3 sets.', ctx).length, 0,
    'honest unitless recap still passes');
});

test('C13. Hammy review F1 — decimal weights are parsed, not truncated to integers', () => {
  const ctx = recapContext();
  // Decimal retained weights: the kg-conversion shape (workoutTextParser.js:64
  // converts decimal kg to lb rounded to 1 decimal), so every kg-logged lift
  // carries a decimal retained weight. The decimal lifts use names whose
  // canonical keys collide with no other tally entry (see note below).
  ctx.session_tally.exercises.push(
    { exercise: 'Seated Row', sets: 3, per_set: [{ weight: 27.5, reps: 8, rir: 2 }, { weight: 27.5, reps: 8, rir: 2 }, { weight: 27.5, reps: 8, rir: 2 }], planned: true },
    { exercise: 'Lat Pulldown', sets: 3, per_set: [{ weight: 60.6, reps: 8, rir: 2 }, { weight: 60.6, reps: 8, rir: 2 }, { weight: 60.6, reps: 8, rir: 2 }], planned: true },
  );
  // True decimals pass, in every weight-token shape: "at N", triple-x, "N lb".
  for (const ok of [
    'You logged Seated Row at 27.5 for 8 reps across 3 sets.',
    'You logged Seated Row 27.5x8x3.',
    'You logged Seated Row at 27.5 lb for 8 reps across 3 sets.',
    'You logged Lat Pulldown at 60.6 for 8 reps across 3 sets.',
  ]) {
    assert.equal(grounding.detectUngroundedRecapNumbers(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
  // Wrong decimals are still flagged — the decimal must match, not just be present.
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged Romanian Deadlift at 27.5 for 6 reps across 3 sets.', ctx)
    .some((f) => f.kind === 'recap_numbers'), '27.5 asserted over retained 285 must be flagged');
  assert.ok(grounding.detectUngroundedRecapNumbers('You logged bench 27.5x8.', ctx)
    .some((f) => f.kind === 'recap_numbers'), '27.5x8 asserted over retained 25x8 must be flagged');
});
// NOTE (re-audit #1662 re-fix, C14): tallyEntryForLift / planEntryForLift
// now match by exact exercise identity first and fall back to the canonical
// key only when it resolves uniquely, so a session carrying both bench
// variants judges each recap against its own variant's rows. The decimal
// tokens stay pinned here with collision-free lift names so the two concerns
// stay separate in the tests.

test('C12. Astra #1662 — state-awareness: proposals, questions, quotations and negations are not recap claims', () => {
  const ctx = recapContext();
  for (const ok of [
    'Do you want me to log Romanian Deadlift at 275 for 6 reps?',
    'I can log Romanian Deadlift at 275 for you if you like.',
    "You said you logged Romanian Deadlift at 275 for 6 reps.",
    "You haven't logged Romanian Deadlift at 275 for 6 reps yet.",
    'You logged Romanian Deadlift at 285 for 6 reps, so should we move on?',
  ]) {
    assert.equal(grounding.detectUngroundedRecapNumbers(ok, ctx).length, 0, `must NOT flag: ${ok}`);
  }
});

// ── Part B — the production route ──────────────────────────────────────────

process.env.ATLAS_API_KEY = 'test-api-key';
process.env.GOOGLE_SHEETS_ID = 'stub-sheet';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-private-key-sheets-is-stubbed';
delete process.env.ATLAS_INTERACTION_TRACE;

const writeAttempts = [];
const fakeSheets = {
  validateConfig: () => {},
  // PROOF 10 — a read-only coach turn that reaches a write is a test failure, not a pass.
  appendRows: async (tab, rows) => { writeAttempts.push({ tab, rows }); throw new Error('no writes on the coach chat path'); },
  deleteRowsByRange: async () => { throw new Error('no deletes'); },
  getExerciseCatalog: async () => [],
  getEffortSessionIds: async () => [],
  getLogCompositeKeys: async () => [],
  getRecentRows: async () => [],
  getSheetRows: async () => [],
  getSpreadsheetTabs: async () => ['Log_Cleaned', 'Effort'],
  logSheetName: 'Log_Cleaned',
  effortSheetName: 'Effort',
};
require.cache[require.resolve('../sheets')] = { id: require.resolve('../sheets'), filename: require.resolve('../sheets'), loaded: true, exports: fakeSheets };
require.cache[require.resolve('../services/vision')] = { id: require.resolve('../services/vision'), filename: require.resolve('../services/vision'), loaded: true, exports: { parseWorkoutScreenshot: async () => ({ parsed_metrics: {} }) } };

// The model is the adversary here: it returns exactly what S12 produced.
const coachState = { reply: null };
require.cache[require.resolve('../services/coach')] = {
  id: require.resolve('../services/coach'), filename: require.resolve('../services/coach'), loaded: true,
  exports: {
    isConfigured: () => true,
    coachModel: () => 'gemini-2.5-flash-lite',
    generateCoachMessage: async () => null,
    generatePlanMessage: async () => null,
    generateChatReply: async () => ({ reply: coachState.reply }),
    findRegisterViolations: () => [],
    looksLikePrClaim: () => false,
    sanitizeFacts: (f) => f,
    sanitizeChatContext: (c) => c,
  },
};

const originalConsoleLog = console.log;
const { app } = require('../index');
let server; let baseUrl;

test.before(async () => {
  console.log = () => {};
  server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  try { if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))); }
  finally { console.log = originalConsoleLog; }
});

const S12_PLAN = [
  { name: 'Barbell Squat', sets: 3, reps: 8, rir: 2 },
  { name: 'Barbell Bench Press', sets: 3, reps: 8, rir: 2 },
  { name: 'Barbell Row', sets: 3, reps: 8, rir: 2 },
  { name: 'Overhead Press', sets: 3, reps: 8, rir: 2 },
  { name: 'Romanian Deadlift', sets: 3, reps: 10, rir: 2 },
  { name: 'Plank', sets: 3, reps: 30, rir: 0 },
];

async function chat(message, reply) {
  coachState.reply = reply;
  writeAttempts.length = 0;
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'test-api-key', 'x-atlas-request-origin': 'probe' },
    body: JSON.stringify({
      message,
      context: {
        current_plan: S12_PLAN,
        plan_completed: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row'],
        plan_state: {
          planned: S12_PLAN.map((e) => e.name),
          completed: ['Barbell Squat', 'Barbell Bench Press', 'Barbell Row'],
          remaining: ['Overhead Press', 'Romanian Deadlift', 'Plank'],
          isComplete: false,
        },
        session_tally: {
          exercises: [
            { exercise: 'Barbell Squat', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }], planned: true },
            { exercise: 'Barbell Bench Press', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }], planned: true },
            { exercise: 'Barbell Row', sets: 3, per_set: [{ weight: 45, reps: 8, rir: 2 }], planned: true },
          ],
          total_working_sets: 9,
        },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, data: body && body.data ? body.data : {} };
}

test('B1. PROOF 7/8 — the S12 goodbye turn: the model cannot override deterministic completion', async () => {
  const fabricated = 'Overhead Press: 0 x 8 @ RIR 2, 0 x 8 @ RIR 2, 0 x 8 @ RIR 2. Romanian Deadlift: 0 x 10 @ RIR 2, 0 x 10 @ RIR 2, 0 x 10 @ RIR 2. Plank: 0 x 30 @ RIR 0, 0 x 30 @ RIR 0, 0 x 30 @ RIR 0. You have completed the workout.';
  const { status, data } = await chat("Ok. That's... actually the first workout plan that doesn't stress me out. Later.", fabricated);
  assert.equal(status, 200);
  // PROOF 3 — no fabricated zero-load actual set reaches visible output.
  assert.doesNotMatch(String(data.message || ''), /\b0\s*(?:x|×)\s*\d+/);
  // PROOF 5/7 — completion is not declared.
  assert.doesNotMatch(String(data.message || ''), /completed the workout/i);
  // The engine, not the model, owns the replacement.
  assert.equal(data.source, 'engine');
  // PROOF 2 — remaining slots are still reported as remaining.
  assert.match(String(data.message || ''), /Still remaining/);
  assert.match(String(data.message || ''), /Overhead Press/);
  // PROOF 4 — genuinely completed work survives.
  assert.match(String(data.message || ''), /Barbell Squat/);
  // A turn that fabricates completed work carries no trustworthy proposal.
  assert.equal(data.propose_edit, null);
  assert.equal(data.propose_plan_edit, null);
  // PROOF 10 — no Sheet write was attempted.
  assert.equal(writeAttempts.length, 0);
});

test('B2. PROOF 6 — the exercise-count-as-session-count claim is replaced on the live route', async () => {
  const { status, data } = await chat("Should I just say I'll come Thursday? I hate saying it and then not.", "You've logged 3 sessions so far. Keep the streak going.");
  assert.equal(status, 200);
  assert.doesNotMatch(String(data.message || ''), /3 sessions/i);
  assert.equal(data.source, 'engine');
  assert.equal(writeAttempts.length, 0);
});

test('B3. PROOF 4 — a grounded reply is passed through untouched', async () => {
  const honest = 'Squat, Bench Press and Row are logged — nine working sets. Overhead Press, Romanian Deadlift and Plank are still remaining.';
  const { status, data } = await chat('Where am I at?', honest);
  assert.equal(status, 200);
  assert.equal(data.message, honest, 'an honest reply must not be rewritten');
  assert.equal(data.source, 'gemini');
  assert.equal(writeAttempts.length, 0);
});

test('B4. the mutation backstop still runs — this PR adds a lane, it does not replace one', async () => {
  const { status, data } = await chat('Change bench to 3x8', 'The plan was updated. It now calls for 3 sets of 8.');
  assert.equal(status, 200);
  assert.equal(data.source, 'engine');
  assert.doesNotMatch(String(data.message || ''), /was updated/i);
  assert.equal(writeAttempts.length, 0);
});

// ── Part D — the remaining-work lane (F-SB4 Session 3) ─────────────────────
//
// Run fsb4b-s3-20261029T055908-69D1E9 failed condition 8: the athlete asked
// "What do I have left?" and NO deterministic lane claimed the phrasing, so the
// model answered from the tally with a bare set-fact enumeration naming NONE of
// the remaining lifts — while the correct plan_state.remaining (Incline DB
// Press, Seated Row, Bicep Curl) sat in its own snapshot unused. The judge's
// expectation was verified correct three ways. These tests rebuild that exact
// state: Incline DB Press is the substituted slot (3 prescribed sets, 2 logged),
// Seated Row is partial (1 of 2), Bicep Curl untouched (0 of 2).

const S3_PLAN = [
  { name: 'Back Squat', sets: 2, reps: 5, rir: 2 },
  { name: 'Overhead Press', sets: 2, reps: 6, rir: 2 },
  { name: 'Romanian Deadlift', sets: 2, reps: 5, rir: 2 },
  { name: 'Incline DB Press', sets: 3, reps: 8, rir: 2 },
  { name: 'Seated Row', sets: 2, reps: 8, rir: 2 },
  { name: 'Bicep Curl', sets: 2, reps: 10, rir: 2 },
];
const S3_CONTEXT = {
  current_plan: S3_PLAN,
  plan_completed: ['Back Squat', 'Overhead Press', 'Romanian Deadlift'],
  plan_state: {
    planned: S3_PLAN.map((e) => e.name),
    completed: ['Back Squat', 'Overhead Press', 'Romanian Deadlift'],
    remaining: ['Incline DB Press', 'Seated Row', 'Bicep Curl'],
    isComplete: false,
  },
  session_tally: {
    exercises: [
      { exercise: 'Back Squat', sets: 2, per_set: [{ weight: 225, reps: 5, rir: 2 }], planned: true },
      { exercise: 'Overhead Press', sets: 2, per_set: [{ weight: 110, reps: 6, rir: 2 }], planned: true },
      { exercise: 'Romanian Deadlift', sets: 2, per_set: [{ weight: 235, reps: 5, rir: 2 }], planned: true },
      { exercise: 'Incline DB Press', sets: 2, per_set: [{ weight: 60, reps: 8, rir: 2 }], planned: true },
      { exercise: 'Seated Row', sets: 1, per_set: [{ weight: 160, reps: 8, rir: 2 }], planned: true },
    ],
    total_working_sets: 9,
  },
};
// The failed run's exact model reply: a recap of logged sets naming no remaining lift.
const S3_ENUMERATION = 'Back Squat 225 x 5 @ RIR 2, Overhead Press 110 x 6 @ RIR 2, Overhead Press 110 x 6 @ RIR 2, Romanian Deadlift 235 x 5 @ RIR 2, Romanian Deadlift 235 x 5 @ RIR 2';

async function chatS3(message, reply) {
  coachState.reply = reply;
  writeAttempts.length = 0;
  const res = await fetch(`${baseUrl}/api/coach/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-atlas-api-key': 'test-api-key', 'x-atlas-request-origin': 'probe' },
    body: JSON.stringify({ message, context: S3_CONTEXT }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, data: body && body.data ? body.data : {} };
}

test('D1. the Session 3 turn: "What do I have left?" is answered deterministically, naming exactly the remaining lifts', async () => {
  const { status, data } = await chatS3('What do I have left?', S3_ENUMERATION);
  assert.equal(status, 200);
  // The engine, not the model, owns the answer — the enumeration never lands.
  assert.equal(data.source, 'engine');
  assert.doesNotMatch(String(data.message || ''), /225 x 5/);
  // Exactly the three remaining lifts are named as remaining — the partially
  // logged Incline DB Press (2 of 3) and Seated Row (1 of 2) included, per the
  // prescription-aware remaining rule.
  assert.match(String(data.message || ''), /Still remaining: Incline DB Press, Seated Row, Bicep Curl\./);
  assert.equal(data.propose_edit, null);
  assert.equal(data.propose_plan_edit, null);
  assert.equal(writeAttempts.length, 0);
});

test('D2. parity: the model-empty path answers the same phrasing with the same grounded statement', async () => {
  const { status, data } = await chatS3('What do I have left?', null);
  assert.equal(status, 200);
  assert.equal(data.source, 'engine');
  assert.match(String(data.message || ''), /Still remaining: Incline DB Press, Seated Row, Bicep Curl\./);
  assert.equal(writeAttempts.length, 0);
});

test('D3. Astra #1662 — a recap asserting the wrong retained numbers is replaced on the live route', async () => {
  // RDL is genuinely logged in this context (235 x 5 x 2), so the completion
  // backstop passes the prose — only the recap-number backstop can catch it.
  const { status, data } = await chatS3('How did the RDLs go?', 'You logged Romanian Deadlift at 275 for 5 reps across 2 sets. Nice work.');
  assert.equal(status, 200);
  assert.doesNotMatch(String(data.message || ''), /275/);
  assert.equal(data.source, 'engine');
  assert.equal(data.propose_edit, null);
  assert.equal(data.propose_plan_edit, null);
  assert.equal(writeAttempts.length, 0);
});

test('D4. Astra #1662 — a recap asserting the retained numbers passes through untouched', async () => {
  const honest = 'You logged Romanian Deadlift at 235 for 5 reps across 2 sets. Nice work.';
  const { status, data } = await chatS3('How did the RDLs go?', honest);
  assert.equal(status, 200);
  assert.equal(data.message, honest, 'an honest recap must not be rewritten');
  assert.equal(data.source, 'gemini');
  assert.equal(writeAttempts.length, 0);
});
