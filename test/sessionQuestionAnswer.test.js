'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionQuestionAnswer, buildSessionAdviceFallback, attributesAsked, resolveLiftName, answerBareShorthand, isBareSessionShorthand, isCurrentExercisePrescriptionQuestion, answerCurrentExercisePrescription, answerPlannedLiftQuestion, answerTotalRepsQuestion } = require('../services/sessionQuestionAnswer');

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

test('answers a multi-attribute question from the engine, labeled a next-set recommendation', () => {
  // No accepted plan in context — the engine value is a live recommendation, so F09F
  // words it as one (never as today's plan).
  const ans = buildSessionQuestionAnswer('Going to do bench 225 how many reps and rir should I do?', {
    resolveTarget: resolveBench
  });
  assert.equal(ans, 'Bench Press: no planned target — recommended for your next set: 5 reps, RIR 2.');
});

test('answers "how much?" with the engine weight, labeled a next-set recommendation', () => {
  const ans = buildSessionQuestionAnswer('how much?', {
    history: [{ role: 'user', text: 'Going to do bench next' }],
    resolveTarget: resolveBench
  });
  assert.equal(ans, 'Bench Press: no planned target — recommended for your next set: 230 lbs.');
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

test('buildSessionAdviceFallback words an engine target only for advice-shaped lift questions', () => {
  const ans = buildSessionAdviceFallback('Should I go heavier on bench?', {
    resolveTarget: () => ({
      exercise_name: 'Bench Press',
      weight: 230,
      reps: 5,
      sets: 3,
      rir: 2,
      reasoning: 'RIR 2 with stable reps over two sessions.'
    })
  });
  assert.equal(ans, 'Bench Press: use 230 lbs, 5 reps, 3 sets, RIR 2. Engine read: RIR 2 with stable reps over two sessions.');
});

test('buildSessionAdviceFallback defers when the lift or target cannot be resolved', () => {
  assert.equal(buildSessionAdviceFallback('Should I go heavier?', { resolveTarget: resolveBench }), null);
  assert.equal(buildSessionAdviceFallback('Should I go heavier on bench?', { resolveTarget: () => null }), null);
  assert.equal(buildSessionAdviceFallback('Bench reps?', { resolveTarget: resolveBench }), null);
});

test('returns null when the lift cannot be resolved', () => {
  assert.equal(buildSessionQuestionAnswer('RIR?', { resolveTarget: resolveBench }), null);
});

test('says "no reliable target available" when neither plan nor engine can ground it', () => {
  // A lift is named and an attribute asked, but there is no accepted plan target and
  // the engine has nothing — the honest floor (F09F), never a guess.
  const ans = buildSessionQuestionAnswer('bench rir?', { resolveTarget: () => null });
  assert.equal(ans, 'Bench Press: no reliable target available.');
});

test('only includes asked attributes that the engine actually knows (labeled a recommendation)', () => {
  // Asks reps + rir, but the engine target has no rir → only reps is reported, and
  // since there is no accepted plan it is labeled a next-set recommendation.
  const ans = buildSessionQuestionAnswer('bench reps and rir?', {
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: null })
  });
  assert.equal(ans, 'Bench Press: no planned target — recommended for your next set: 5 reps.');
});

// ── F09F (PLAN-COACH-SPLIT-1): explicit target provenance ─────────────────────
// Every deterministic answer's target is exactly one of: the ACCEPTED PLAN, a
// REVISED NEXT-SET RECOMMENDATION (live engine), or NO RELIABLE TARGET. A performed
// or previewed value is NEVER echoed as the plan; a live engine value is only ever
// surfaced labeled as a next-set recommendation, never merged into plan wording.

const RECO_RE = /recommend/i;              // the revised-next-recommendation label
const NEXT_SET_RE = /next set/i;
const NO_TARGET_RE = /no reliable target available/i;

test('F09F(1): accepted plan target A wins over a performed value B (plan stays A)', () => {
  // Plan says 205; the athlete performed 185 (preview) and the engine, re-reading the
  // performed set, would now say 190. The answer must be the ACCEPTED PLAN's 205 —
  // never the performed 185 or the recomputed 190.
  const ctx = {
    current_plan: [{ name: 'Bench Press', weight: 205, reps: 5, sets: 3, rir: 2 }],
    current_preview: [{ exercise: 'Bench Press', weight: 185, reps: 5, rir: 1 }]
  };
  const ans = buildSessionQuestionAnswer('how much for bench?', {
    clientContext: ctx,
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 190, reps: 5, sets: 3, rir: 2 })
  });
  assert.equal(ans, 'Bench Press: 205 lbs.');
  assert.doesNotMatch(ans, /185|190/, 'never the performed or recomputed value');
  // The plan-first lane agrees.
  assert.equal(answerPlannedLiftQuestion('how much for bench?', ctx), 'Bench Press today: 205 lbs.');
});

test('F09F(2): no accepted target — a performed preview value is NOT echoed as a prescription', () => {
  // Bench is not in today's accepted plan; only a performed preview row exists (185).
  // With no engine target either, the answer must NOT present 185 as a target.
  const ctx = { current_preview: [{ exercise: 'Bench Press', weight: 185, reps: 5, rir: 1 }] };
  const ans = buildSessionQuestionAnswer('how much for bench?', {
    clientContext: ctx,
    resolveTarget: () => null
  });
  assert.doesNotMatch(String(ans), /185/, 'a performed value is never a prescription');
  assert.match(String(ans), NO_TARGET_RE);
  // The plan-first lane defers (null) for an off-plan lift so the LLM can still answer.
  assert.equal(answerPlannedLiftQuestion('how much for bench?', ctx), null);
});

test('F09F(3): no accepted target + a valid engine value → labeled next-set recommendation', () => {
  // No accepted plan target for bench, but the engine has a live recommendation. It
  // must be surfaced explicitly as a recommendation for the NEXT set, not as the plan.
  const ans = buildSessionQuestionAnswer('how much for bench?', {
    clientContext: { current_plan: [] },
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 2 })
  });
  assert.match(ans, /230 lbs/);
  assert.match(ans, RECO_RE, 'labeled as a recommendation');
  assert.match(ans, NEXT_SET_RE, 'scoped to the next set');
  assert.doesNotMatch(ans, /today: 230|Bench Press: 230 lbs\.$/, 'not worded as the accepted plan');
});

test('F09F(4): no plan and no engine target → "no reliable target available"', () => {
  const ans = buildSessionQuestionAnswer('rir for bench?', {
    clientContext: { current_plan: [] },
    resolveTarget: () => null
  });
  assert.equal(ans, 'Bench Press: no reliable target available.');
});

test('F09F(5): a revision is scoped to the NEXT set and never rewrites the completed set', () => {
  // Accepted plan A (205) is what the completed set was prescribed at; a live engine
  // revision (190, from the performed set) is only ever offered for the next set.
  const planCtxA = { current_plan: [{ name: 'Bench Press', weight: 205, reps: 5, sets: 3, rir: 2 }] };
  // The completed set's planned target stays A — never overwritten by the performed value.
  assert.equal(answerPlannedLiftQuestion('how much for bench?', planCtxA), 'Bench Press today: 205 lbs.');
  // When the same lift has no accepted target, the engine revision is explicitly next-set scoped.
  const revision = buildSessionQuestionAnswer('how much for bench?', {
    clientContext: { current_plan: [] },
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 190, reps: 5, sets: 3, rir: 2 })
  });
  assert.match(revision, NEXT_SET_RE);
  assert.doesNotMatch(revision, /205/, 'the revision does not restate the completed-set target');
});

test('F09F(6): accepted-plan and missing-set-count behaviors stay green (engine fills only gaps)', () => {
  // A real accepted-plan lift missing only its set count: the engine fills the set
  // count and the answer is STILL worded as the plan (the lift IS planned) — no
  // recommendation label, no "no reliable target".
  const ans = buildSessionQuestionAnswer('sets?', {
    clientContext: { current_plan: [{ name: 'Bench Press', weight: 225, reps: 5, sets: null, rir: 2 }] },
    resolveTarget: () => ({ exercise_name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 2 })
  });
  assert.equal(ans, 'Bench Press: 3 sets.');
  assert.doesNotMatch(ans, RECO_RE);
  assert.doesNotMatch(ans, NO_TARGET_RE);
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

test('F10S3 SMOKE REPRODUCE: the selector verdict (plan_state.remaining) decides the current lift — an IN-PROGRESS multi-set lift still answers', () => {
  // 1 of 3 Back Squat sets logged: plan_completed carries 'Back Squat' (attribution
  // evidence), but the canonical selector says the slot is still REMAINING. The old
  // set-difference skipped it and answered from Overhead Press while the rail/pin
  // showed Back Squat in progress (Codex P2 on #1063).
  const ctx = {
    current_plan: [{ name: 'Back Squat', weight: 225, reps: 5, sets: 3, rir: 2 }, { name: 'Overhead Press', weight: 115, reps: 6, sets: 3, rir: 2 }],
    plan_completed: ['Back Squat'],
    plan_state: { planned: ['Back Squat', 'Overhead Press'], completed: ['Back Squat'], remaining: ['Back Squat', 'Overhead Press'], isComplete: false },
  };
  assert.deepEqual(answerBareShorthand('RIR?', ctx), { kind: 'answer', text: 'Back Squat: RIR 2.' },
    'mid-set "RIR?" answers for the in-progress lift the athlete is standing at');
  assert.deepEqual(answerBareShorthand('How much?', ctx), { kind: 'answer', text: 'Back Squat: 225 lbs.' });
});

test('F10S3: without plan_state the legacy plan_completed set-difference stands (old clients unchanged)', () => {
  const ctx = {
    current_plan: [{ name: 'Back Squat', rir: 2 }, { name: 'Overhead Press', rir: 2 }],
    plan_completed: ['Back Squat'],
  };
  assert.deepEqual(answerBareShorthand('RIR?', ctx), { kind: 'answer', text: 'Overhead Press: RIR 2.' });
});

test('non-bare shorthand defers (null) — named-lift and off-topic go to the normal flow', () => {
  const ctx = { current_plan: [{ name: 'Deadlift', rir: 2 }] };
  assert.equal(answerBareShorthand('For deadlifts how many RIR?', ctx), null);
  assert.equal(answerBareShorthand('how much should I sleep?', ctx), null);
});

// ---------------------------------------------------------------------------
// answerCurrentExercisePrescription — a BARE, no-lift-named COMPOUND prescription
// question ("What weight and how many reps?") is scoped to the single ACTIVE lift
// from session state, retiring the "all-six prescription dump" (Phase-3 divergence
// D3, FR-20260723120852-hw56ws9y turn 1). This is the compound shape the tight
// bare-shorthand gate excludes, so before this lane the turn reached Gemini with the
// whole current_plan and the model enumerated every exercise.
// ---------------------------------------------------------------------------

// A representative six-exercise active session with Bench Press current (remaining[0]).
function sixExercisePlanCtx() {
  return {
    current_plan: [
      { name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 3 },
      { name: 'Incline Press', weight: 150, reps: 8, sets: 3, rir: 2 },
      { name: 'Cable Fly', weight: 40, reps: 12, sets: 3, rir: 1 },
      { name: 'Triceps Pushdown', weight: 60, reps: 12, sets: 3, rir: 1 },
      { name: 'Lateral Raise', weight: 20, reps: 15, sets: 3, rir: 0 },
      { name: 'Overhead Press', weight: 115, reps: 6, sets: 3, rir: 2 },
    ],
    plan_state: { remaining: ['Bench Press', 'Incline Press', 'Cable Fly', 'Triceps Pushdown', 'Lateral Raise', 'Overhead Press'], isComplete: false },
  };
}

test('D3: a bare compound prescription question is scoped to the ACTIVE lift only — not the whole plan', () => {
  const ctx = sixExercisePlanCtx();
  const r = answerCurrentExercisePrescription('What weight and how many reps?', ctx);
  assert.deepEqual(r, { kind: 'answer', text: 'Bench Press: 230 lbs, 5 reps.' });
  // The "all-six dump" cannot recur: the answer names ONLY the active lift.
  for (const other of ['Incline Press', 'Cable Fly', 'Triceps Pushdown', 'Lateral Raise', 'Overhead Press']) {
    assert.ok(!r.text.includes(other), `answer must not enumerate ${other}`);
  }
});

test('D3: recognizes the compound/scoped shapes the tight bare gate misses; still rejects off-topic and education', () => {
  for (const q of ['What weight and how many reps?', 'weight and reps?', 'sets and reps', 'how many reps and rir?', "what's my weight, reps and rir", 'what is the weight for this lift?']) {
    assert.equal(isCurrentExercisePrescriptionQuestion(q), true, `should own: ${q}`);
    assert.equal(isBareSessionShorthand(q), false, `tight bare gate deliberately misses: ${q}`);
  }
  for (const q of ['what is RIR?', 'how much water do I drink?', 'how much protein and how many reps do I need?', 'why is my weight so low?', 'how many reps did I do last time?', 'what weight and reps for bench?', 'how do I bench?']) {
    assert.equal(isCurrentExercisePrescriptionQuestion(q), false, `must defer: ${q}`);
  }
});

test('D3: a single unscoped attribute ("what is RIR?") is NOT hijacked — education keeps the ambiguity', () => {
  assert.equal(answerCurrentExercisePrescription('what is RIR?', sixExercisePlanCtx()), null);
  // …but the same single attribute EXPLICITLY scoped to the current lift is answered.
  assert.deepEqual(
    answerCurrentExercisePrescription('what is the rir for this lift?', sixExercisePlanCtx()),
    { kind: 'answer', text: 'Bench Press: RIR 3.' });
});

test('D3: a named lift, history, or advice framing defers to the existing lanes', () => {
  const ctx = sixExercisePlanCtx();
  assert.equal(answerCurrentExercisePrescription('what weight and reps for bench?', ctx), null, 'named lift → named-lift lane');
  assert.equal(answerCurrentExercisePrescription('what weight and reps did I do last time?', ctx), null, 'history → history/LLM');
  assert.equal(answerCurrentExercisePrescription('should I increase the weight and reps?', ctx), null, 'advice → LLM');
});

test('D3: normal present-session phrasing is recognized, not just the anchored shape (Codex #1138 P2)', () => {
  const ctx = sixExercisePlanCtx();
  // A trailing present-session cue or a "should I do?" request suffix is still a bare
  // prescription question scoped to the active lift — it must not fall through to the dump.
  for (const q of [
    'what weight and reps today?',
    'what weight and how many reps should I do?',
    'weight and reps for today?',
    'what are the weight and reps right now?',
    'what weight and reps should I be doing?',
  ]) {
    assert.equal(isCurrentExercisePrescriptionQuestion(q), true, `should own: ${q}`);
    assert.deepEqual(answerCurrentExercisePrescription(q, ctx), { kind: 'answer', text: 'Bench Press: 230 lbs, 5 reps.' }, `scoped: ${q}`);
  }
  // …but a genuine ADVICE or off-topic framing whose content word survives the residue still defers.
  for (const q of ['should I go heavier on weight and reps?', 'what weight and reps are better?', 'how much protein and how many reps today?', 'why the weight and reps?']) {
    assert.equal(isCurrentExercisePrescriptionQuestion(q), false, `must defer: ${q}`);
  }
});

test('D3: an ambiguous current lift asks which one; no active session defers', () => {
  const ambiguous = { current_plan: [{ name: 'Deadlift', weight: 245, reps: 7, sets: 3, rir: 2 }, { name: 'Leg Press', weight: 300, reps: 10, sets: 3, rir: 1 }] };
  assert.deepEqual(answerCurrentExercisePrescription('weight and reps?', ambiguous), { kind: 'clarify', text: 'For which lift — Deadlift or Leg Press?' });
  assert.equal(answerCurrentExercisePrescription('weight and reps?', {}), null);
  assert.equal(answerCurrentExercisePrescription('weight and reps?', null), null);
});

test('D3: engine-fill supplies an attribute the plan lacks (missing set count) — parity with bare shorthand', () => {
  // The accepted plan lift carries weight/reps/rir but no set count; the engine resolver fills
  // only that gap, exactly like the bare-shorthand lane. The answer stays the PLAN's.
  const ctx = { current_plan: [{ name: 'Bench Press', weight: 230, reps: 5, sets: null, rir: 3 }], plan_state: { remaining: ['Bench Press'] } };
  const r = answerCurrentExercisePrescription('what are the weight, reps and sets?', ctx, () => ({ exercise_name: 'Bench Press', sets: 3 }));
  assert.equal(r.kind, 'answer');
  assert.ok(/230 lbs/.test(r.text) && /5 reps/.test(r.text) && /3 sets/.test(r.text), `engine-filled sets present: ${r.text}`);
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

// ── answerTotalRepsQuestion — engine-computed PLANNED total, never "you've done" ──
// Live bug (2026-06-21): bare "Total?" after discussing Face Pull → Gemini answered
// "You've done 45 reps of Face Pull today." — a fabricated, mis-tensed total for
// work not logged. The engine now owns the total (sets × reps) and labels it planned.
const totalCtx = { current_plan: [
  { name: 'Bench Press', weight: 230, reps: 5, sets: 3, rir: 2 },
  { name: 'Face Pull', weight: 40, reps: 15, sets: 3, rir: 1 },
] };

test('answerTotalRepsQuestion: named lift → engine-computed planned total', () => {
  assert.equal(
    answerTotalRepsQuestion('how many reps total for face pulls', { clientContext: totalCtx }),
    'Face Pull today: 45 total reps planned (3 sets × 15).'
  );
});

test('answerTotalRepsQuestion: bare "Total?" resolves the lift from recent turns', () => {
  const history = [
    { role: 'user', text: 'how many reps total for face pulls' },
    { role: 'assistant', text: 'Face Pull today: 15 reps.' },
  ];
  assert.equal(
    answerTotalRepsQuestion('Total?', { history, clientContext: totalCtx }),
    'Face Pull today: 45 total reps planned (3 sets × 15).'
  );
});

test('answerTotalRepsQuestion: the answer is labeled planned, never "you\'ve done"', () => {
  const ans = answerTotalRepsQuestion('total reps for bench?', { clientContext: totalCtx });
  assert.match(ans, /planned/);
  assert.doesNotMatch(ans, /you'?ve done|you did|you hit/i);
});

test('answerTotalRepsQuestion: answers reps-totals only — defers "total weight/volume"', () => {
  // A "total" question worded as weight or volume asks a different metric; answering
  // it with a rep count would be off-topic, so defer those to Gemini.
  assert.equal(answerTotalRepsQuestion('total weight for bench?', { clientContext: totalCtx }), null);
  assert.equal(answerTotalRepsQuestion("what's my total volume for bench?", { clientContext: totalCtx }), null);
  // "total sets" (sets asked, not reps) is also a different metric → defer.
  assert.equal(answerTotalRepsQuestion('total sets for bench?', { clientContext: totalCtx }), null);
  // A reps total (and a bare "total?") still answer.
  assert.equal(
    answerTotalRepsQuestion('how many reps total for bench?', { clientContext: totalCtx }),
    'Bench Press today: 15 total reps planned (3 sets × 5).'
  );
});

test('answerTotalRepsQuestion: defers when not a total question, past-tense, or unresolvable', () => {
  assert.equal(answerTotalRepsQuestion('how many reps for bench?', { clientContext: totalCtx }), null);
  assert.equal(answerTotalRepsQuestion('what was my total last time?', { clientContext: totalCtx }), null);
  assert.equal(answerTotalRepsQuestion('total?', { clientContext: {} }), null);
  // No sets in the plan → cannot total without fabricating.
  assert.equal(answerTotalRepsQuestion('total reps for bench?', { clientContext: { current_plan: [{ name: 'Bench Press', reps: 5, sets: null }] } }), null);
});

// --- Owner live find (2026-07-03): the plan's CURRENT STEP answers bare shorthand ---
// Mid-session "How much weight?" got "For which lift — Good Mornings, Back Squat,
// or Single-Leg Seated Leg Press?" while the session pin showed Good Mornings as
// current. plan_completed makes the current step unambiguous.

test('bare shorthand: a multi-lift plan answers from the FIRST not-completed step', () => {
  const ctx = {
    current_plan: [
      { name: 'Good Mornings', weight: null, reps: 10, sets: 3, rir: 3 },
      { name: 'Back Squat', weight: 225, reps: 8, sets: 3, rir: 2 },
      { name: 'Single-Leg Seated Leg Press', weight: 70, reps: 12, sets: 3, rir: 1 },
    ],
    plan_completed: [],
  };
  const r = answerBareShorthand('How many reps?', ctx);
  assert.equal(r && r.kind, 'answer', 'the current step answers — no clarify');
  assert.match(r.text, /^Good Mornings:/, 'the first pending step is the current lift');
});

test('bare shorthand: completed steps advance the current lift; no plan_completed keeps the old clarify', () => {
  const plan = [
    { name: 'Good Mornings', weight: null, reps: 10, sets: 3, rir: 3 },
    { name: 'Back Squat', weight: 225, reps: 8, sets: 3, rir: 2 },
  ];
  const advanced = answerBareShorthand('How many reps?', { current_plan: plan, plan_completed: ['Good Mornings'] });
  assert.equal(advanced && r_kind(advanced), 'answer');
  assert.match(advanced.text, /^Back Squat:/, 'done steps are skipped');
  const legacy = answerBareShorthand('How many reps?', { current_plan: plan });
  assert.equal(legacy && legacy.kind, 'clarify', 'without plan_completed the clarify behavior stands');
});

function r_kind(r) { return r && r.kind; }

test('chat swap follow-through: an applied plan edit re-points the composer via the mutation signal', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const app = fs2.readFileSync(path2.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const listener = app.slice(app.indexOf("document.addEventListener('atlas:plan-edit-proposed'"), app.indexOf("document.addEventListener('atlas:plan-edit-proposed'") + 900);
  assert.match(listener, /announcePlanMutation\('', firstUnloggedPlannedLift\(\)\)/,
    'the chat lane fires the SAME mutation signal as the deterministic lane (empty summary: no extra bubble, composer re-points)');
});
