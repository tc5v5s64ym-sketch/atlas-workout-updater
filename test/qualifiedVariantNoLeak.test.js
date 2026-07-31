'use strict';

// ---------------------------------------------------------------------------
// An explicitly named VARIANT must never be answered with the base lift's data.
//
// PROVEN leak (verified on main at b5321d9, before this change). With a planned Back
// Squat 3×5 @ 315 and a Back Squat history, "how much for zercher squat?" returned:
//
//   resolveLiftName            -> "Back Squat"
//   answerPlannedLiftQuestion  -> "Back Squat today: 315 lbs."
//   answerTotalRepsQuestion    -> "Back Squat today: 15 total reps planned (3 sets × 5)."
//   buildSessionQuestionAnswer -> "Back Squat: no planned target — recommended for your
//                                  next set: 405 lbs."   (engine target from Back Squat history)
//   resolveTurnExercises       -> ["Back Squat"]          (Back Squat's diagnostics to the model)
//
// So it leaked prescribed weight, planned volume, an engine recommendation derived from
// another lift's history, and the grounding context — under a lift name the athlete never
// asked about. Front, Goblet and Hack Squat, Close-Grip and Paused Bench, and Deficit and
// Sumo Deadlift all leaked the same way.
//
// The rule pinned here: when the message names a DIFFERENT real exercise than the alias the
// parser matched, the coaching read path resolves nothing and asks. Legitimate aliases,
// abbreviations, and contextual shorthand are untouched.
//
// Part A drives the real answer path. Part B drives the real grounding path. Part C
// re-implements the pre-fix resolution and proves these fixtures genuinely leaked, so the
// greens above are not vacuous.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveLiftName,
  answerPlannedLiftQuestion,
  answerTotalRepsQuestion,
  buildSessionQuestionAnswer,
} = require('../services/sessionQuestionAnswer');
const grounding = require('../services/coachResponseGrounding');
const { canonicalizeExerciseName } = require('../services/workoutTextParser');
const { namesDifferentExercise, kbExerciseId } = require('../services/explicitExerciseReference');

const PLAN = {
  current_plan: [
    { name: 'Back Squat', sets: 3, reps: 5, weight: 315, rir: 2 },
    { name: 'Bench Press', sets: 3, reps: 8, weight: 185, rir: 2 },
  ],
  plan_completed: [],
};
const HISTORY = [{ role: 'user', text: 'back squat 315 5/2' }];
// A generous engine stub: if a lift resolves at all, a number is available to leak.
const ENGINE = (name) => ({ exercise_name: name, weight: 405, reps: 3, sets: 5, rir: 1 });

// Each is a real, distinct exercise in the KB whose name contains a base lift's alias.
const QUALIFIED_VARIANTS = [
  'zercher squat', 'zercher squats',
  'front squat', 'front squats',
  'goblet squat', 'goblet squats',
  'hack squat', 'hack squats',
  'close grip bench',
  'paused bench',
  'deficit deadlift',
  'sumo deadlift',
];

// ── Part A — the answer path ───────────────────────────────────────────────

test('1. a named variant resolves to NOTHING — it never becomes the base lift', () => {
  for (const variant of QUALIFIED_VARIANTS) {
    const message = `how much for ${variant}?`;
    assert.equal(resolveLiftName(message, HISTORY, PLAN), null, message);
  }
});

test('2. a named variant leaks no prescribed weight, planned volume, or engine number', () => {
  for (const variant of QUALIFIED_VARIANTS) {
    const message = `how much for ${variant}?`;
    assert.equal(answerPlannedLiftQuestion(message, PLAN), null, message);
    assert.equal(answerTotalRepsQuestion(`total reps for ${variant}?`, { history: HISTORY, clientContext: PLAN }), null, message);

    const answer = buildSessionQuestionAnswer(message, { history: HISTORY, clientContext: PLAN, resolveTarget: ENGINE });
    assert.ok(answer, `${message} must be answered, not silently dropped`);
    assert.doesNotMatch(answer, /back squat|bench press/i, `${message} named another lift`);
    assert.doesNotMatch(answer, /315|405|185/, `${message} quoted another lift's numbers`);
    assert.match(answer, /which lift/i, `${message} must ask`);
  }
});

test('3. the ask names the variant the athlete actually typed', () => {
  const answer = buildSessionQuestionAnswer('how much for zercher squat?', { history: HISTORY, clientContext: PLAN });
  assert.match(answer, /zercher squat/i);
});

test('4. legitimate names, aliases and abbreviations still resolve', () => {
  const expected = [
    ['how much for squat?', 'Back Squat'],
    ['how much for squats?', 'Back Squat'],
    ['how much for back squat?', 'Back Squat'],
    ['how much for bench?', 'Bench Press'],
    ['why did you program bench press?', 'Bench Press'],
    ['how much for barbell rows?', 'Bent-Over Row'],
    ['how much for seated rows?', 'Seated Row'],
    ['how much for rdl?', 'RDL'],
    ['how much for romanian deadlift?', 'RDL'],
    ['how much for incline bench?', 'Incline Bench Press'],
    ['and reps for overhead press?', 'Overhead Press'],
  ];
  for (const [message, lift] of expected) {
    assert.equal(resolveLiftName(message, HISTORY, PLAN), lift, message);
  }
  // A real plan answer still comes back for a legitimately named lift.
  assert.match(answerPlannedLiftQuestion('how much for back squat?', PLAN), /Back Squat today: 315 lbs/);
});

test('5. contextual shorthand still uses the active referent', () => {
  for (const message of ['how much?', 'what weight?', 'and reps?', 'how many sets?', 'rir?',
    'how much for the last set?', 'what weight for warmup?', 'how much for the next one?']) {
    assert.equal(resolveLiftName(message, HISTORY, PLAN), 'Back Squat', message);
  }
});

test('6. a prior turn about a VARIANT is not evidence for the base lift', () => {
  // The referent scan is held to the same standard as the message.
  const variantHistory = [{ role: 'user', text: 'how much for front squat?' }];
  assert.equal(resolveLiftName('how much?', variantHistory, { current_plan: [] }), null);
  // With a plan present the plan still answers — the point is only that the variant turn
  // never supplies "Back Squat" as the referent.
  assert.equal(resolveLiftName('how much?', variantHistory, PLAN), 'Back Squat');
});

// ── Part B — the grounding path ────────────────────────────────────────────

test('7. a named variant gets NO lift diagnostics, and never the base lift\'s', () => {
  for (const message of [
    'how much for zercher squat?',
    'why did you program front squat?',
    'why did you program goblet squats?',
    'how much for close grip bench?',
    'how much for hack squats?',
  ]) {
    assert.deepEqual(grounding.resolveTurnExercises(message, PLAN), [], message);
  }
});

test('8. grounding still narrows to a legitimately named lift, and still falls back', () => {
  assert.deepEqual(grounding.resolveTurnExercises('how much for squat?', PLAN), ['Back Squat']);
  assert.deepEqual(grounding.resolveTurnExercises('why did you program bench press?', PLAN), ['Bench Press']);
  // A genuine TWO-lift turn keeps both, so the ambiguity lanes still see it as ambiguous.
  assert.deepEqual(grounding.resolveTurnExercises('how are bench press and back squat?', PLAN), ['Back Squat', 'Bench Press']);
  // A bare turn still gets the whole plan.
  assert.deepEqual(grounding.resolveTurnExercises('any problems?', PLAN), ['Back Squat', 'Bench Press']);
});

// ── the predicate itself ───────────────────────────────────────────────────

test('9. the qualifier check requires the KB to say so, and requires overlap', () => {
  // A variant that shares a word with the matched lift and is a different KB exercise.
  assert.equal(namesDifferentExercise('how much for zercher squat?', 'Back Squat'), true);
  assert.equal(namesDifferentExercise('how much for close grip bench?', 'Bench Press'), true);
  // The same lift by another name is NOT a different exercise.
  assert.equal(namesDifferentExercise('how much for squat?', 'Back Squat'), false);
  assert.equal(namesDifferentExercise('how much for bench press?', 'Bench Press'), false);
  // A SECOND lift in the sentence shares no word with the matched one — that is an
  // ambiguous multi-lift turn, not a qualification, so it must not fire.
  assert.equal(namesDifferentExercise('how are bench press and back squat?', 'Back Squat'), false);
  assert.equal(namesDifferentExercise('how are bench press and back squat?', 'Bench Press'), false);
  // Ordinary words the KB does not know make no claim at all — this is what keeps verbs
  // ("program") and conversation from being read as exercise names.
  assert.equal(namesDifferentExercise('why did you program bench press?', 'Bench Press'), false);
  assert.equal(namesDifferentExercise('how much water should i drink?', 'Back Squat'), false);
  assert.equal(namesDifferentExercise('how much for the last set?', 'Back Squat'), false);
  assert.equal(kbExerciseId('program bench press'), null);
});

// ── Part C — the same fixtures against the PRE-FIX resolution ──────────────

// Resolution exactly as it stood before this change: whatever the parser's lenient,
// match-anywhere canonicalizer returned. Kept so Part A cannot pass vacuously.
function preFixResolve(message) {
  const hit = canonicalizeExerciseName(message);
  return (hit && hit.canonicalName) || null;
}

test('10. the fixtures reproduce the leak: pre-fix, every variant resolved to the base lift', () => {
  const expectedBase = {
    'zercher squat': 'Back Squat', 'front squat': 'Back Squat', 'goblet squat': 'Back Squat',
    'hack squat': 'Back Squat', 'close grip bench': 'Bench Press', 'paused bench': 'Bench Press',
    'deficit deadlift': 'Deadlift', 'sumo deadlift': 'Deadlift',
  };
  for (const [variant, base] of Object.entries(expectedBase)) {
    const message = `how much for ${variant}?`;
    assert.equal(preFixResolve(message), base,
      `${message} must have resolved to ${base} before the fix`);
    assert.equal(resolveLiftName(message, HISTORY, PLAN), null,
      `${message} must resolve to nothing now`);
  }
  // And the behaviour the fix must NOT change: both agree on every legitimate name.
  for (const message of ['how much for squat?', 'how much for bench?', 'how much for seated row?',
    'how much for rdl?', 'how much for incline bench?']) {
    assert.equal(resolveLiftName(message, HISTORY, PLAN), preFixResolve(message), message);
  }
});
