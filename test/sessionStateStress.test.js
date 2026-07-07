'use strict';

// ===========================================================================
// P4 — Session-State Stress Testing
// (Trust-Critical Coach Interaction Layer; docs/ACTIVE_ROADMAP.md)
//
// GOAL: prove that for messy, real-world human inputs Atlas keeps ACTIVE
// WORKOUT STATE prioritized over generic chat / education — the trust failure
// that started this workstream (Atlas answering "RIR?" mid-set with a textbook
// definition instead of the live prescription).
//
// This suite is the system-level stress corpus the roadmap names ("rack busy",
// "I'll do RDL instead", "skip that", "legs are toast", "what now", "how much",
// "what am I doing next"). It exercises the deterministic routing/answering
// guards TOGETHER against that corpus, where the per-module tests
// (sessionQuestion / sessionQuestionAnswer / recoveryRouting / messageIntent)
// each cover one helper in isolation.
//
// All helpers under test are PURE (no I/O, no LLM, no Sheets) — so these
// assertions hold whether or not the Gemini coach is available, which is the
// whole point: session shorthand must never dead-end at generic education or
// motivation hype just because the LLM is down.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

// PR-08: ES module now — dynamic import (Node 20 CI has no require(esm)).
let isSessionStateQuestion, isPlannedLiftQuestion;
test.before(async () => {
  ({ isSessionStateQuestion, isPlannedLiftQuestion } = await import('../src/app/sessionQuestion.js'));
});
const {
  answerBareShorthand,
  isBareSessionShorthand,
  answerPlannedLiftQuestion,
} = require('../services/sessionQuestionAnswer');
const { isTirednessExpression, buildTirednessRecoveryAnswer } = require('../services/recoveryRouting');
const { classifyMessageIntent } = require('../services/messageIntent');

// --- shared live-session fixtures -----------------------------------------
// Active preview of a single lift (the lifter is mid-set on Bench Press).
const PREVIEW_CTX = { current_preview: [{ exercise: 'Bench Press', weight: 185, reps: 8, rir: 2 }] };
// Active plan with one lift (carries sets, which a preview row does not).
const SINGLE_PLAN_CTX = { current_plan: [{ name: 'Bench Press', weight: 185, reps: 8, sets: 3, rir: 2 }] };
// Active plan with two lifts and no preview → the "current" lift is ambiguous.
const TWO_PLAN_CTX = {
  current_plan: [
    { name: 'Bench Press', weight: 185, reps: 8, sets: 3, rir: 2 },
    { name: 'Barbell Row', weight: 135, reps: 10, sets: 3, rir: 2 },
  ],
};

// ---------------------------------------------------------------------------
// 1. The roadmap's messy corpus is classified as session-shaped, so the caller
//    routes it to the session-aware coach instead of the generic SME education.
// ---------------------------------------------------------------------------

test('P4: messy human session inputs all route to session context (not SME education)', () => {
  const corpus = [
    'rack busy',
    'the rack is busy',
    'rack is taken',
    "I'll do RDL instead",
    'do leg press instead',
    'skip that',
    'skip ahead',
    'legs are toast',
    'quads are fried',
    'what now',
    'how much',
    'how much weight',
    'what am I doing next',
    'what next',
    "what's next",
    'how many reps',
    'how many sets',
    'what should I do now',
    'whats the target',
  ];
  for (const m of corpus) {
    assert.equal(isSessionStateQuestion(m), true,
      `messy session input must route to session context: ${JSON.stringify(m)}`);
  }
});

test('P4: generic education is NOT hijacked by session routing (SME path preserved)', () => {
  // Negative control: the stress corpus must not swallow real education — those
  // keep their existing SME-first routing.
  const education = [
    'what does RIR mean?',
    'what is training volume?',
    'what rep range builds strength?',
    'explain RPE',
    'teach me about deloading',
    'why do we deload?',
    'how does hypertrophy work?',
  ];
  for (const m of education) {
    assert.equal(isSessionStateQuestion(m), false,
      `education must stay on the SME path: ${JSON.stringify(m)}`);
  }
});

test('P4: plain logging / chatter is not mistaken for a session question', () => {
  for (const m of ['bench 225 5/2', 'crushed that set', 'thanks coach', 'logged it']) {
    assert.equal(isSessionStateQuestion(m), false, `not a session question: ${JSON.stringify(m)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Bare in-session shorthand ("RIR?", "How much?") is answered from the LIVE
//    lift — deterministically, independent of the LLM. This is the exact
//    2026-06-20 failure: mid-set shorthand returning generic education.
// ---------------------------------------------------------------------------

test('P4: bare shorthand answers from the live preview lift (no LLM)', () => {
  assert.deepEqual(answerBareShorthand('RIR?', PREVIEW_CTX), { kind: 'answer', text: 'Bench Press: RIR 2.' });
  assert.deepEqual(answerBareShorthand('Reps?', PREVIEW_CTX), { kind: 'answer', text: 'Bench Press: 8 reps.' });
  assert.deepEqual(answerBareShorthand('How much?', PREVIEW_CTX), { kind: 'answer', text: 'Bench Press: 185 lbs.' });
  assert.deepEqual(answerBareShorthand('How much weight?', PREVIEW_CTX), { kind: 'answer', text: 'Bench Press: 185 lbs.' });
  assert.deepEqual(answerBareShorthand('Weight?', PREVIEW_CTX), { kind: 'answer', text: 'Bench Press: 185 lbs.' });
});

test('P4: bare "sets?" answers from the plan (which carries sets)', () => {
  // A preview row has no set count, so "sets?" defers there (documented) — but a
  // live plan carries it and must answer deterministically.
  assert.deepEqual(answerBareShorthand('How many sets?', SINGLE_PLAN_CTX), { kind: 'answer', text: 'Bench Press: 3 sets.' });
  assert.deepEqual(answerBareShorthand('Sets?', SINGLE_PLAN_CTX), { kind: 'answer', text: 'Bench Press: 3 sets.' });
});

test('P4: an ambiguous current lift asks which one — never guesses a wrong lift', () => {
  // Two planned lifts, no preview → the engine must NOT silently answer with one
  // lift's numbers; it asks which lift (trust: no fabricated prescription).
  const rir = answerBareShorthand('RIR?', TWO_PLAN_CTX);
  assert.equal(rir.kind, 'clarify');
  assert.match(rir.text, /which lift/i);
  assert.match(rir.text, /Bench Press/);
  assert.match(rir.text, /Barbell Row/);
});

test('P4: off-topic tokens do NOT resolve a session answer (graceful degrade)', () => {
  // "how much should I sleep?" / "what is RIR?" contain attribute tokens but are
  // not bare shorthand — they must defer (null), so education still fires.
  assert.equal(answerBareShorthand('how much should I sleep?', PREVIEW_CTX), null);
  assert.equal(answerBareShorthand('what is RIR?', PREVIEW_CTX), null);
  assert.equal(isBareSessionShorthand('how much should I sleep?'), false);
});

// ---------------------------------------------------------------------------
// 3. Named-lift value questions answer from the live PLAN — beating both generic
//    education and past history (the "current plan wins" rule).
// ---------------------------------------------------------------------------

test('P4: a named planned-lift value question answers from the plan', () => {
  assert.equal(answerPlannedLiftQuestion('what is the rir for bench press', SINGLE_PLAN_CTX), 'Bench Press today: RIR 2.');
  assert.equal(answerPlannedLiftQuestion('how many reps for bench press', SINGLE_PLAN_CTX), 'Bench Press today: 8 reps.');
  // And the caller's classifier agrees it is a planned-lift question.
  assert.equal(isPlannedLiftQuestion('how many reps for bench', ['Bench Press']), true);
});

test('P4: history and pure-education framings defer (plan answer steps aside)', () => {
  // Past-tense belongs to history; "what is RIR" (no lift named) stays education.
  assert.equal(answerPlannedLiftQuestion('how much did I bench last time', SINGLE_PLAN_CTX), null);
  assert.equal(answerPlannedLiftQuestion('what is RIR', SINGLE_PLAN_CTX), null);
  assert.equal(isPlannedLiftQuestion('how much did I bench last time?', ['Bench Press']), false);
  assert.equal(isPlannedLiftQuestion('what is RIR?', ['Bench Press']), false);
});

// ---------------------------------------------------------------------------
// 4. "I'm tired" routes to recovery and NEVER to motivation hype — the engine
//    owns the read; the LLM is bypassed so it can't cheerlead a tired lifter.
// ---------------------------------------------------------------------------

test('P4: first-person fatigue is detected across messy phrasings', () => {
  for (const m of ['legs are toast', 'arms are cooked', 'I am wiped', "I'm exhausted", 'cooked', 'im drained', 'running on empty']) {
    assert.equal(isTirednessExpression(m), true, `should read as tired: ${JSON.stringify(m)}`);
  }
});

test('P4: impatience, negation, and analytical questions are NOT routed as fatigue', () => {
  for (const m of ['tired of waiting', "I'm not tired", 'why am I so tired lately?', 'beat my PR today']) {
    assert.equal(isTirednessExpression(m), false, `must not route as fatigue: ${JSON.stringify(m)}`);
  }
});

test('P4: recovery answer never hypes and never invents a lift-specific load', () => {
  const HYPE = /push through|you got this|you got it|crush it|beast mode|no excuses|dig deep|tough it out|power through|don'?t quit/i;
  const LOAD = /\b\d+\s*lbs?\b/i; // a fabricated weight prescription must never appear
  const branches = [
    // elevated volume + back-to-back + flagged pattern
    buildTirednessRecoveryAnswer({
      fatigueStatus: { status: 'high' },
      readiness: [{ pattern: 'horizontal_push', status: 'fatigued' }],
      daysSinceLastSession: 1,
    }),
    // trained today
    buildTirednessRecoveryAnswer({ fatigueStatus: { status: 'high' }, daysSinceLastSession: 0 }),
    // logs look recovered (honest, still no pressure)
    buildTirednessRecoveryAnswer({ fatigueStatus: { status: 'normal' }, daysSinceLastSession: 3 }),
    // no strong signal / no history
    buildTirednessRecoveryAnswer({}),
  ];
  for (const reply of branches) {
    assert.ok(reply && reply.length > 0, 'recovery reply is always non-empty');
    assert.doesNotMatch(reply, HYPE, `recovery reply must never hype: ${JSON.stringify(reply)}`);
    assert.doesNotMatch(reply, LOAD, `recovery reply must not invent a load: ${JSON.stringify(reply)}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Phantom-set floor under messy input (AC8): a question logs nothing, an
//    unresolved lift is not saved, and a real set still logs even when it also
//    asks a question. Session intent never fabricates a logged set.
// ---------------------------------------------------------------------------

test('P4: messy questions never fabricate a logged set, but real sets still log', () => {
  // Pure session questions from the corpus → answer, log nothing.
  for (const q of ['what should I do next?', 'how much?', 'what now?']) {
    const r = classifyMessageIntent(q, { hasResolvedLift: false, hasSetTokens: false });
    assert.equal(r.suppressLog, true, `pure question must not log: ${JSON.stringify(q)}`);
    assert.equal(r.reason, 'question');
  }
  // A real, resolved set that ALSO asks a question still logs (the both-case).
  const both = classifyMessageIntent('crushed 235x8, should I go up?', { hasResolvedLift: true, hasSetTokens: true });
  assert.equal(both.suppressLog, false);
  assert.equal(both.reason, null);
  // Set tokens under an unresolved lift are not saved (Atlas asks which lift).
  const unresolved = classifyMessageIntent('zercher thrust 95 8/2', { hasResolvedLift: false, hasSetTokens: true });
  assert.equal(unresolved.suppressLog, true);
  assert.equal(unresolved.reason, 'unresolved_lift');
});
