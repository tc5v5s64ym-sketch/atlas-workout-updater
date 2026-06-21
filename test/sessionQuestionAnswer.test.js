'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionQuestionAnswer, attributesAsked, resolveLiftName, answerBareShorthand, isBareSessionShorthand, answerPlannedLiftQuestion } = require('../services/sessionQuestionAnswer');

// Engine target stub — stands in for recommendNextSet-derived numbers.
const benchTarget = { exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 2 };
const resolveBench = (name) => (/bench/i.test(name) ? benchTarget : null);

test('attributesAsked detects each shorthand and combinations', () => {
  assert.deepEqual(attributesAsked('RIR?'), ['rir']);
  assert.deepEqual(attributesAsked('reps?'), ['reps']);
  assert.deepEqual(attributesAsked('sets?'), ['sets']);
  assert.deepEqual(attributesAsked('how much?'), ['weight']);
  assert.deepEqual(attributesAsked('how many reps and rir should I do?').sort(), ['reps', 'rir']);
  assert.deepEqual(attributesAsked('hey coach'), []);
});

test('answers a multi-attribute question from the lift named in the message', () => {
  const ans = buildSessionQuestionAnswer('Going to do bench 225 how many reps and rir should I do?', {
    resolveTarget: resolveBench
  });
  assert.equal(ans, 'Bench Press: 5 reps, RIR 2.');
});

test('answers "how much?" with the engine weight when the lift is in recent history', () => {
  const ans = buildSessionQuestionAnswer('how much?', {
    history: [{ role: 'user', text: 'Going to do bench next' }],
    resolveTarget: resolveBench
  });
  assert.equal(ans, 'Bench Press: 230 lbs.');
});

test('resolves the lift from the client preview/plan and prefers its target (no Sheets)', () => {
  const ans = buildSessionQuestionAnswer('RIR?', {
    clientContext: { current_plan: [{ name: 'Overhead Press', weight: 116, reps: 10, sets: 3, rir: 2 }] },
    resolveTarget: () => { throw new Error('should not be called — context target wins'); }
  });
  assert.equal(ans, 'Overhead Press: RIR 2.');
});

test('falls back to the engine when the context target lacks the asked attribute', () => {
  // Plan carries the lift with rir/reps/weight but NO sets; user asks "sets?".
  // Should consult the engine for the set count instead of dead-ending.
  const ans = buildSessionQuestionAnswer('sets?', {
    clientContext: { current_plan: [{ name: 'Bench Press', weight: 225, reps: 5, sets: null, rir: 2 }] },
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 2 })
  });
  assert.equal(ans, 'Bench Press: 3 sets.');
});

test('context values win over the engine where both are present', () => {
  // Asks weight (context has it) + sets (only engine has it) → context weight, engine sets.
  const ans = buildSessionQuestionAnswer('weight and sets?', {
    clientContext: { current_plan: [{ name: 'Bench Press', weight: 225, reps: 5, sets: null, rir: 2 }] },
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 999, reps: 5, sets: 3, rir: 2 })
  });
  assert.equal(ans, 'Bench Press: 225 lbs, 3 sets.');
});

test('returns null when no session attribute is asked (defers to caller fallback)', () => {
  assert.equal(buildSessionQuestionAnswer('what should we do about my deadlift form', { resolveTarget: resolveBench }), null);
});

test('returns null when the lift cannot be resolved', () => {
  assert.equal(buildSessionQuestionAnswer('RIR?', { resolveTarget: resolveBench }), null);
});

test('returns null when no target is available for the resolved lift', () => {
  const ans = buildSessionQuestionAnswer('bench rir?', { resolveTarget: () => null });
  assert.equal(ans, null);
});

test('only includes asked attributes that the engine actually knows', () => {
  // Asks reps + rir, but the target has no rir → only reps is reported.
  const ans = buildSessionQuestionAnswer('bench reps and rir?', {
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: null })
  });
  assert.equal(ans, 'Bench Press: 5 reps.');
});

test('resolveLiftName prefers the message over history over context', () => {
  assert.equal(
    resolveLiftName('do bench now', [{ text: 'earlier we did squat' }], { current_plan: [{ name: 'Deadlift' }] }),
    'Bench Press'
  );
  assert.equal(
    resolveLiftName('RIR?', [{ text: 'going with rdl today' }], { current_plan: [{ name: 'Deadlift' }] }),
    'RDL'
  );
});

// ---------------------------------------------------------------------------
// answerBareShorthand — bare in-session shorthand resolves to the CURRENT lift
// (whether or not Gemini is up), asks when ambiguous, and defers when there is
// no active lift context. (#449 follow-up, 2026-06-21.)
// ---------------------------------------------------------------------------

test('isBareSessionShorthand matches pure shorthand only', () => {
  for (const q of ['RIR?', 'reps?', 'Sets?', 'Weight?', 'How much?', 'How much weight?', 'How many sets?', 'how many reps']) {
    assert.equal(isBareSessionShorthand(q), true, `bare: ${q}`);
  }
  for (const q of ['how much should I sleep?', 'For deadlifts how many RIR?', 'what does RIR mean?', 'how is my bench trending?']) {
    assert.equal(isBareSessionShorthand(q), false, `not bare: ${q}`);
  }
});

test('bare shorthand answers from the current planned lift', () => {
  const ctx = { current_plan: [{ name: 'Deadlift', weight: 245, reps: 7, sets: 3, rir: 2 }] };
  assert.deepEqual(answerBareShorthand('RIR?', ctx), { kind: 'answer', text: 'Deadlift: RIR 2.' });
  assert.deepEqual(answerBareShorthand('Reps?', ctx), { kind: 'answer', text: 'Deadlift: 7 reps.' });
  assert.deepEqual(answerBareShorthand('How much?', ctx), { kind: 'answer', text: 'Deadlift: 245 lbs.' });
  assert.deepEqual(answerBareShorthand('How much weight?', ctx), { kind: 'answer', text: 'Deadlift: 245 lbs.' });
  assert.deepEqual(answerBareShorthand('How many sets?', ctx), { kind: 'answer', text: 'Deadlift: 3 sets.' });
});

test('the actively-previewed lift is the current lift (wins over a multi-lift plan)', () => {
  const ctx = {
    current_preview: [{ exercise: 'Leg Press', weight: 300, reps: 10, rir: 1 }],
    current_plan: [{ name: 'Deadlift', rir: 2 }, { name: 'Leg Press', rir: 1 }]
  };
  assert.deepEqual(answerBareShorthand('RIR?', ctx), { kind: 'answer', text: 'Leg Press: RIR 1.' });
});

test('ambiguous active context asks which lift instead of guessing', () => {
  const ctx = { current_plan: [{ name: 'Deadlift', rir: 2 }, { name: 'Leg Press', rir: 1 }] };
  assert.deepEqual(answerBareShorthand('RIR?', ctx), { kind: 'clarify', text: 'For which lift — Deadlift or Leg Press?' });
});

test('no active lift context defers (null) so education can apply', () => {
  assert.equal(answerBareShorthand('RIR?', {}), null);
  assert.equal(answerBareShorthand('RIR?', null), null);
});

test('non-bare shorthand defers (null) — named-lift and off-topic go to the normal flow', () => {
  const ctx = { current_plan: [{ name: 'Deadlift', rir: 2 }] };
  assert.equal(answerBareShorthand('For deadlifts how many RIR?', ctx), null);
  assert.equal(answerBareShorthand('how much should I sleep?', ctx), null);
});

test('bare shorthand fills a missing attribute from the engine when context lacks it', () => {
  const ctx = { current_plan: [{ name: 'Deadlift', rir: 2 }] }; // no sets in plan
  const res = answerBareShorthand('How many sets?', ctx, () => ({ exercise_name: 'Deadlift', sets: 3 }));
  assert.deepEqual(res, { kind: 'answer', text: 'Deadlift: 3 sets.' });
});

// ── answerPlannedLiftQuestion — current plan beats history & education ─────────
// Live bug (2026-06-21): with Bench Press 230×5 @ RIR 2 on screen, "what's the RIR
// for bench?" returned generic RIR education and "how many reps for bench?" answered
// from past history, instead of from today's plan.
const planCtx = { current_plan: [{ name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 2 }] };

test('answerPlannedLiftQuestion: named planned lift → RIR from the current plan', () => {
  assert.equal(answerPlannedLiftQuestion("What's the RIR for bench?", planCtx), 'Bench Press today: RIR 2.');
});

test('answerPlannedLiftQuestion: named planned lift → reps from the current plan', () => {
  assert.equal(answerPlannedLiftQuestion('How many reps for bench?', planCtx), 'Bench Press today: 5 reps.');
});

test('answerPlannedLiftQuestion: named planned lift → weight from the current plan', () => {
  assert.equal(answerPlannedLiftQuestion('How much weight for bench?', planCtx), 'Bench Press today: 230 lbs.');
});

test('answerPlannedLiftQuestion: a concept question with no named lift defers (education stays)', () => {
  // "What is RIR?" names no lift → null, so the SME education path is untouched.
  assert.equal(answerPlannedLiftQuestion('What is RIR?', planCtx), null);
  assert.equal(answerPlannedLiftQuestion('What does RIR mean?', planCtx), null);
});

test('answerPlannedLiftQuestion: a past-tense question defers to history', () => {
  // History owns "last time / previous" — the plan must not answer these.
  assert.equal(answerPlannedLiftQuestion('How much did I bench last time?', planCtx), null);
  assert.equal(answerPlannedLiftQuestion('What did I bench previously?', planCtx), null);
});

test('answerPlannedLiftQuestion: a lift NOT in the plan defers (no fabricated answer)', () => {
  // Squat is named but not in today's plan → null (caller clarifies / uses history),
  // never a guessed value. Also no plan[0] fallback: it must match the named lift.
  assert.equal(answerPlannedLiftQuestion("What's the RIR for squat?", planCtx), null);
});

test('answerPlannedLiftQuestion: no plan context → defers', () => {
  assert.equal(answerPlannedLiftQuestion("What's the RIR for bench?", null), null);
  assert.equal(answerPlannedLiftQuestion("What's the RIR for bench?", {}), null);
});

test('answerPlannedLiftQuestion: reasoning/advice framings defer to the coach', () => {
  // Running before Gemini, a value lookup must NOT swallow "why / should / increase"
  // questions — those want coaching judgement, so they fall through to Gemini.
  assert.equal(answerPlannedLiftQuestion('why is the RIR for bench so low today?', planCtx), null);
  assert.equal(answerPlannedLiftQuestion('how much should I increase bench by?', planCtx), null);
  assert.equal(answerPlannedLiftQuestion('should I go heavier on bench?', planCtx), null);
  // But a plain value lookup still answers from the plan.
  assert.equal(answerPlannedLiftQuestion("What's the RIR for bench?", planCtx), 'Bench Press today: RIR 2.');
});

test('answerPlannedLiftQuestion: a lift name containing an advice-like word still answers', () => {
  // "raise"/"lower" are NOT advice words (they collide with lift names like
  // Lateral Raise) — a direct value lookup for such a lift is still answered.
  const ctx = { current_plan: [{ name: 'Lateral Raises', weight: 25, reps: 15, sets: 3, rir: 1 }] };
  assert.equal(answerPlannedLiftQuestion("What's the RIR for lateral raise?", ctx), 'Lateral Raises today: RIR 1.');
});
