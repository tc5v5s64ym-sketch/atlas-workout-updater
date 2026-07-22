'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// PR-08: ES module now — dynamic import (Node 20 CI has no require(esm)).
let isSessionStateQuestion, isPlannedLiftQuestion, isPlanReference, isPlanModificationRequest;
let isWorkoutGenerationRequest, extractGenerationConstraints;
test.before(async () => {
  ({ isSessionStateQuestion, isPlannedLiftQuestion, isPlanReference, isPlanModificationRequest,
     isWorkoutGenerationRequest, extractGenerationConstraints } = await import('../src/app/sessionQuestion.js'));
});

const repoRoot = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// P0 — Active Session Context Integrity: the classifier must flag live
// workout-state questions (so the caller routes them to the session-aware coach
// instead of the generic SME) while leaving explicit education alone.
// ---------------------------------------------------------------------------

test('session-shaped workout-state questions are flagged', () => {
  const sessionQuestions = [
    'Weight? Reps? RIR?',
    'How much am I lifting, how many reps, how many sets?',
    'RIR?',
    'Reps?',
    'Sets?',
    'Weight?',
    'How much?',
    'How much weight?',
    'What am I doing next?',
    'What exercise is next?',
    "What's next?",
    'what next',
    "What's the target?",
    'what is the target',
    'What am I lifting?',
    'how many reps',
    'how many sets',
    'What should I do now?',
    'what now',
    'skip that',
    'rack busy',
    'the rack is busy',
    'legs are toast',
    "I'll do leg press instead",
    'do RDL instead',
  ];
  for (const q of sessionQuestions) {
    assert.equal(isSessionStateQuestion(q), true, `expected session-shaped: ${JSON.stringify(q)}`);
  }
});

test('explicit educational questions are NOT flagged (SME education preserved)', () => {
  const educationQuestions = [
    'What does RIR mean?',
    'Explain RPE.',
    'What rep range builds strength?',
    'What is training volume?',
    'Teach me about deloading.',
    'What is progressive overload?',
    'How does hypertrophy work?',
    'What is the difference between strength and power training?',
    'Why do we deload?',
  ];
  for (const q of educationQuestions) {
    assert.equal(isSessionStateQuestion(q), false, `expected educational (not session-shaped): ${JSON.stringify(q)}`);
  }
});

test('empty / non-string input is not flagged', () => {
  assert.equal(isSessionStateQuestion(''), false);
  assert.equal(isSessionStateQuestion('   '), false);
  assert.equal(isSessionStateQuestion(null), false);
  assert.equal(isSessionStateQuestion(undefined), false);
  assert.equal(isSessionStateQuestion(42), false);
});

test('plain logging text and non-session chatter are not flagged', () => {
  // Bare logs / statements should keep their existing (non-session-routed) handling.
  assert.equal(isSessionStateQuestion('bench 225 5/2'), false);
  assert.equal(isSessionStateQuestion('crushed that set'), false);
  assert.equal(isSessionStateQuestion('thanks coach'), false);
});

// ---------------------------------------------------------------------------
// Routing precedence: getChatReply must gate the SME call on an active workout
// AND a session-shaped message, so live workout questions reach /api/coach/chat
// first. Source-introspection (the IIFE is browser-only) — matches the repo's
// existing frontend-wiring test pattern.
// ---------------------------------------------------------------------------

test('getChatReply gates the SME on active-session + session-shaped message', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');

  // Uses the shared classifier.
  assert.match(src, /sessionQuestion\.isSessionStateQuestion\(message\)/,
    'getChatReply should classify the message via sessionQuestion.isSessionStateQuestion');

  // Derives an active-workout signal from the chat context.
  assert.match(src, /hasActiveWorkout/, 'should compute an active-workout signal');
  assert.match(src, /current_plan/, 'active-workout signal should consider current_plan');
  assert.match(src, /current_preview/, 'active-workout signal should consider current_preview');
  assert.match(src, /plan_completed/, 'active-workout signal should consider plan_completed');
  // A free-form coaching conversation (prior turns exist) also counts as active
  // context — otherwise session shorthand leaks to SME mid-conversation (the
  // 2026-06-20 "RIR?" live-test failure).
  assert.match(src, /inCoachingConversation/, 'an ongoing conversation should count as active context');
  assert.match(src, /Array\.isArray\(history\)\s*&&\s*history\.length\s*>\s*0/,
    'inCoachingConversation should be derived from a non-empty history');

  // The SME call is skipped only with an active workout AND either a bare-shaped
  // question OR a named-planned-lift value question ("what's the RIR for bench?")
  // OR a plan reference/correction ("that isn't what you planned", "you said 195")
  // OR a plan-modification request ("can we change it to 3 sets of 6?").
  assert.match(src, /skipSme\s*=\s*hasActiveWorkout\s*&&\s*\(sessionShaped\s*\|\|\s*plannedLiftValue\s*\|\|\s*planReference\s*\|\|\s*planModification\)/,
    'skipSme should require an active workout AND (session-shaped OR a planned-lift value question OR a plan reference/correction OR a plan-modification request)');
  assert.match(src, /sessionQuestion\.isPlannedLiftQuestion\(message,\s*planLiftNames\)/,
    'getChatReply should classify named-planned-lift value questions via isPlannedLiftQuestion');
  assert.match(src, /sessionQuestion\.isPlanReference\(message\)/,
    'getChatReply should classify plan references/corrections via isPlanReference');
  assert.match(src, /sessionQuestion\.isPlanModificationRequest\(message\)/,
    'getChatReply should classify plan-modification requests via isPlanModificationRequest');
  assert.match(src, /if\s*\(\s*!skipSme\s*\)\s*try\s*\{/,
    'the /api/coach/ask SME block should run only when not skipped');

  // The session-aware coach path is still present as the fall-through / target.
  assert.match(src, /\/api\/coach\/chat/, 'the session-aware coach path must remain');
});

test('the new script is wired into the shell (index.html + service worker)', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  // PR-08: sessionQuestion is an ES module imported by coach-conversation.js, so
  // the ES module graph guarantees it evaluates before coach-conversation's body
  // runs (getChatReply) — stronger than the old script-tag ordering.
  assert.match(html, /<script type="module" src="atlasEntry\.js"><\/script>/, 'index.html must load the module entry');
  const cc = fs.readFileSync(path.join(repoRoot, 'public', 'coach-conversation.js'), 'utf8');
  assert.match(cc, /import \* as sessionQuestion from '\.\/sessionQuestion\.js'/,
    'coach-conversation.js must import sessionQuestion.js');

  const sw = fs.readFileSync(path.join(repoRoot, 'public', 'sw.js'), 'utf8');
  assert.match(sw, /sessionQuestion\.js/, 'service worker shell should include sessionQuestion.js');
});

// ---------------------------------------------------------------------------
// isPlannedLiftQuestion — named-lift value questions that the bare-shape
// classifier misses ("what's the RIR for bench?"). Catches them ONLY when the
// named lift is in the live plan/preview, so the caller can route to the
// session-aware coach instead of the generic SME. (2026-06-21 live failure.)
// ---------------------------------------------------------------------------

test('isPlannedLiftQuestion flags named-planned-lift value questions', () => {
  const lifts = ['Bench Press'];
  for (const q of ["What's the RIR for bench?", 'How many reps for bench?', 'How much weight for bench?']) {
    assert.equal(isPlannedLiftQuestion(q, lifts), true, `expected planned-lift question: ${JSON.stringify(q)}`);
  }
});

test('isPlannedLiftQuestion leaves pure education alone (no lift named)', () => {
  const lifts = ['Bench Press'];
  for (const q of ['What is RIR?', 'What does RIR mean?', 'Explain RPE.']) {
    assert.equal(isPlannedLiftQuestion(q, lifts), false, `education should not be a planned-lift question: ${JSON.stringify(q)}`);
  }
});

test('isPlannedLiftQuestion defers history questions to history', () => {
  const lifts = ['Bench Press'];
  assert.equal(isPlannedLiftQuestion('How much did I bench last time?', lifts), false);
  assert.equal(isPlannedLiftQuestion('What did I bench previously?', lifts), false);
});

test('isPlannedLiftQuestion ignores lifts not in the live plan', () => {
  // Squat is named but not on today's plan → not a current-plan question.
  assert.equal(isPlannedLiftQuestion("What's the RIR for squat?", ['Bench Press']), false);
});

test('isPlannedLiftQuestion is safe on empty / missing inputs', () => {
  assert.equal(isPlannedLiftQuestion('', ['Bench Press']), false);
  assert.equal(isPlannedLiftQuestion("What's the RIR for bench?", null), false);
  assert.equal(isPlannedLiftQuestion("What's the RIR for bench?", []), false);
  assert.equal(isPlannedLiftQuestion(null, ['Bench Press']), false);
});

// ---------------------------------------------------------------------------
// isPlanReference — plan DISPUTE / CORRECTION / reference to what Atlas planned,
// prescribed, recommended, or previously said. The 2026-07-21 production failure:
// a correction ("That isn't what you planned. You planned 3 sets at 8 reps.") is
// not a session-state QUESTION and carries no lift name, so it matched neither
// classifier above, fell to the generic SME, and got unrelated warm-up advice.
// The caller gates this on an active workout; this function judges message shape
// only, and must leave pure education alone.
// ---------------------------------------------------------------------------

test('isPlanReference flags plan corrections, disputes, and references', () => {
  const corrections = [
    // The exact production sentence (both apostrophe forms).
    'That isn’t what you planned. You planned 3 sets at 8 reps.',
    "That isn't what you planned. You planned 3 sets at 8 reps.",
    // Attribution to Atlas (verb-only, lift name omitted — the active exercise supplies it).
    'That isn’t what you planned.',
    'You planned 3 sets at 8 reps.',
    'No, you told me 10 reps.',
    'No, you told me 8 reps.',
    'That’s not the weight you gave me.',
    'That’s not the weight you gave me. You said 195.',
    'You had me at 1 RIR, not 2.',
    'That’s not what you said earlier.',
    'You programmed three sets, not four.',
    'You planned 2 RIR, not 1.',
    'Didn’t you prescribe seated rows at 1 RIR?',
    // suggest/recommend are the same coaching act (Codex P1, 2026-07-21).
    'That’s not what you suggested for my warm-up.',
    'You suggested 8 reps, not 10.',
    // Reference to "the plan"/"the workout" with a stating/comparison/numeric context.
    'I thought the plan said 200.',
    'Why is this different from the plan?',
    'The plan was 8 reps.',
    'Actually, the workout says 200 × 10.',
  ];
  for (const c of corrections) {
    assert.equal(isPlanReference(c), true, `expected plan reference/correction: ${JSON.stringify(c)}`);
  }
});

test('isPlanReference leaves pure education alone (SME education preserved)', () => {
  const education = [
    'What is RIR?',
    'What does RIR mean?',
    'How should I warm up?',
    'How should I warm up for seated rows?',
    'What is progressive overload?',
    'What muscles do seated rows work?',
    'What is a ramp set?',
    'What rep range builds strength?',
    'Explain RPE.',
    // An abstract mention of a "training plan" is not a reference to THE current plan.
    'How does a training plan work?',
    // A bare copula next to a plan noun is NOT a correction — evaluative education
    // stays on the SME's deterministic answer (Codex P1, 2026-07-21).
    'Was this workout good for hypertrophy?',
    'Is this workout good?',
    'Is my program working?',
    'Is this a hard session?',
  ];
  for (const q of education) {
    assert.equal(isPlanReference(q), false, `education must stay off the plan-reference route: ${JSON.stringify(q)}`);
  }
});

test('isPlanReference does not fire on ordinary logging shorthand or chatter', () => {
  assert.equal(isPlanReference('bench 225 5/2'), false);
  assert.equal(isPlanReference('seated row 200 10/1'), false);
  assert.equal(isPlanReference('crushed that set'), false);
  assert.equal(isPlanReference('thanks coach'), false);
});

test('isPlanReference is safe on empty / non-string input', () => {
  assert.equal(isPlanReference(''), false);
  assert.equal(isPlanReference('   '), false);
  assert.equal(isPlanReference(null), false);
  assert.equal(isPlanReference(undefined), false);
  assert.equal(isPlanReference(42), false);
});

// ---------------------------------------------------------------------------
// isPlanModificationRequest — the athlete asking to CHANGE the active plan. The
// 2026-07-22 production failure: a shorthand change request ("Can we change it to
// 3 sets of 6?") carried neither a lift name nor "plan", so the three classifiers
// above all missed it, `skipSme` was false, and it leaked to the generic SME —
// which returned a warm-up card, so the request never reached the proposal → approval
// flow. Mirrors services/coachResponseGrounding.isPlanModificationRequest exactly;
// education must stay off this route.
// ---------------------------------------------------------------------------

test('isPlanModificationRequest flags imperative and request-framed change requests', () => {
  const requests = [
    // Imperative (verb opens the clause).
    'Change it to 3x6.',
    'Make that 8 reps.',
    'Switch to Front Squat.',
    'Update the plan to 3 sets of 8.',
    'Lower it to 175.',
    "Let's bump it to 225.",
    // Request / desire framing (verb does not open the clause).
    'Can we change it to 3 sets of 6?',
    'Could we lower it to 175?',
    'I want to change it to 3 sets.',
    "I'd like to change the plan.",
    'Can you switch it to 8 reps?',
    'Please update it to 3x8.',
  ];
  for (const r of requests) {
    assert.equal(isPlanModificationRequest(r), true, `expected modification request: ${JSON.stringify(r)}`);
  }
});

test('isPlanModificationRequest leaves education alone (never an active-plan mutation)', () => {
  const education = [
    'What is progressive overload?',
    'How do I change my grip?',
    'Can changing rep ranges build muscle?',
    'What does RIR mean?',
    'How should I warm up for seated rows?',
    'Does changing tempo matter?',
  ];
  for (const q of education) {
    assert.equal(isPlanModificationRequest(q), false, `education must not be a modification request: ${JSON.stringify(q)}`);
  }
});

test('isPlanModificationRequest does not fire on factual disputes/explanations (preserves #1126 routing)', () => {
  // A dispute/explanation is handled by isPlanReference / isPlannedLiftQuestion, not here.
  assert.equal(isPlanModificationRequest("That isn't what you planned. You planned 3 sets at 6 reps."), false);
  assert.equal(isPlanModificationRequest('You set the plan to 3x8.'), false);
  assert.equal(isPlanModificationRequest('Why did you program bench press for 175 at 9 reps?'), false);
});

test('isPlanModificationRequest is safe on empty / non-string input', () => {
  assert.equal(isPlanModificationRequest(''), false);
  assert.equal(isPlanModificationRequest('   '), false);
  assert.equal(isPlanModificationRequest(null), false);
  assert.equal(isPlanModificationRequest(undefined), false);
  assert.equal(isPlanModificationRequest(42), false);
});

// ---------------------------------------------------------------------------
// isWorkoutGenerationRequest — a request to CREATE / PLAN a new session. The
// 2026-07-22 production failure: "Plan me a workout but have it start with back
// squats" leaked to the free-form /api/coach/chat lane, which had the model write
// an incomplete pseudo-plan (no plan_version, no canonical lift codes) the client
// wrongly treated as an active plan. Generation must instead route to the
// AUTHORITATIVE recommendation pipeline. Education/how-to, disputes, corrections,
// and plan-MODIFICATION requests must NOT match (they keep their #1126–#1128 routes).
// ---------------------------------------------------------------------------

test('isWorkoutGenerationRequest flags create/plan-a-workout requests', () => {
  const requests = [
    // The exact production phrase.
    'Plan me a workout but have it start with back squats.',
    'Plan me a workout.',
    'Build me a pull workout.',
    'Make me a push session.',
    'Create a leg day.',
    'Generate a full body workout.',
    'Design me an upper body session.',
    'Put together a workout for me.',
    'Give me a workout.',
    'Program a lower body session.',
    // Direct "what should I train" asks.
    'What should I train today?',
    'What are we training today?',
    'What are we doing today?',
    "What's the plan today?",
  ];
  for (const r of requests) {
    assert.equal(isWorkoutGenerationRequest(r), true, `expected generation request: ${JSON.stringify(r)}`);
  }
});

test('isWorkoutGenerationRequest leaves education/how-to alone', () => {
  const education = [
    'How do I plan a workout?',
    'How should I build a workout?',
    'How to program a push day?',
    'What is a good workout split?',
    'Why do we plan workouts around movement patterns?',
  ];
  for (const q of education) {
    assert.equal(isWorkoutGenerationRequest(q), false, `education must not be a generation request: ${JSON.stringify(q)}`);
  }
});

test('isWorkoutGenerationRequest does not fire on disputes/corrections/modifications (#1126–#1128 preserved)', () => {
  const others = [
    // dispute / correction (isPlanReference route)
    "That isn't what you planned. You planned 3 sets at 8 reps.",
    'You said 195.',
    // plan-modification (isPlanModificationRequest route)
    'Can we change it to 3 sets of 6?',
    'Switch to Front Squat.',
    'Make that 8 reps.',
    // ordinary logging shorthand / chatter
    'bench 225 5/2',
    'crushed that set',
    'thanks coach',
  ];
  for (const q of others) {
    assert.equal(isWorkoutGenerationRequest(q), false, `non-generation turn must stay off the generation route: ${JSON.stringify(q)}`);
  }
});

test('isWorkoutGenerationRequest is safe on empty / non-string input', () => {
  assert.equal(isWorkoutGenerationRequest(''), false);
  assert.equal(isWorkoutGenerationRequest('   '), false);
  assert.equal(isWorkoutGenerationRequest(null), false);
  assert.equal(isWorkoutGenerationRequest(undefined), false);
  assert.equal(isWorkoutGenerationRequest(42), false);
});

// ---------------------------------------------------------------------------
// 2026-07-22 production routing gap (deployed 9f72ee5): telemetry classified these
// three real athlete messages as generate_workout, but the browser classifier returned
// false because "work out" was written as TWO words — so they leaked to /api/coach/chat.
// The fix normalizes the equivalent noun spellings (workout | work out | work-out) before
// matching. These lock in the exact production messages and the equivalence.
// ---------------------------------------------------------------------------

const PROD_GEN_MESSAGES = [
  'Plan me a work out but have it start with bench press',
  'Plan me a work out but have it start with squats',
  'Plan me a work out but have it start with lat pull',
];

test('isWorkoutGenerationRequest recognizes the exact two-word "work out" production messages', () => {
  for (const m of PROD_GEN_MESSAGES) {
    assert.equal(isWorkoutGenerationRequest(m), true, `two-word "work out" must route to generation: ${JSON.stringify(m)}`);
  }
});

test('isWorkoutGenerationRequest treats workout / work out / work-out as the same noun', () => {
  assert.equal(isWorkoutGenerationRequest('Plan me a workout'), true);
  assert.equal(isWorkoutGenerationRequest('Plan me a work out'), true);
  assert.equal(isWorkoutGenerationRequest('Plan me a work-out'), true);
  // Multiple internal spaces (mobile keyboards) still normalize.
  assert.equal(isWorkoutGenerationRequest('Plan me a work  out'), true);
});

test('isWorkoutGenerationRequest preserves education for the two-word spelling (no plan generated)', () => {
  const education = [
    'How do I work out?',            // how-to — education, never a plan
    'How do I plan a workout?',      // how-to — education
    'What muscles does this work out?', // "work out" as a VERB about a movement — not a plan request
  ];
  for (const q of education) {
    assert.equal(isWorkoutGenerationRequest(q), false, `education must not generate a plan: ${JSON.stringify(q)}`);
  }
});

test('extractGenerationConstraints preserves the requested first exercise for the two-word messages', () => {
  assert.equal(extractGenerationConstraints(PROD_GEN_MESSAGES[0]).firstExercise, 'bench press');
  assert.equal(extractGenerationConstraints(PROD_GEN_MESSAGES[1]).firstExercise, 'squats');
  assert.equal(extractGenerationConstraints(PROD_GEN_MESSAGES[2]).firstExercise, 'lat pull');
});

// ---------------------------------------------------------------------------
// extractGenerationConstraints — the structured planning INPUTS carried by a
// generation request: a requested FIRST exercise ("start with back squats") and a
// focus / movement pattern ("pull workout", "upper body", "leg day"). These become
// query params to the authoritative pipeline; they are NEVER a model-built plan.
// ---------------------------------------------------------------------------

test('extractGenerationConstraints pulls the requested first exercise', () => {
  assert.deepEqual(
    extractGenerationConstraints('Plan me a workout but have it start with back squats.'),
    { firstExercise: 'back squats' });
  assert.deepEqual(
    extractGenerationConstraints('Build me a session beginning with the deadlift, then accessories.'),
    { firstExercise: 'deadlift' });
  assert.deepEqual(
    extractGenerationConstraints('Make me a workout, open with bench press please.'),
    { firstExercise: 'bench press' });
});

test('extractGenerationConstraints pulls the focus / movement pattern', () => {
  assert.equal(extractGenerationConstraints('Build me a pull workout.').focus, 'pull');
  assert.equal(extractGenerationConstraints('Plan me a push day.').focus, 'push');
  assert.equal(extractGenerationConstraints('Give me an upper body session.').focus, 'upper_body');
  assert.equal(extractGenerationConstraints('Make me a leg day.').focus, 'lower_body');
  assert.equal(extractGenerationConstraints('Design a full body workout.').focus, 'full_body');
});

test('extractGenerationConstraints does not mistake a lift name for a focus', () => {
  // "leg press" contains "leg" but is NOT a lower-body FOCUS keyword — only an
  // explicit "leg day" / "legs" sets lower_body (avoids the 2026-07-22 mis-extraction).
  const c = extractGenerationConstraints('Plan a session, start with the leg press.');
  assert.equal(c.focus, undefined, 'a bare "leg press" first-exercise must not set a lower-body focus');
  assert.equal(c.firstExercise, 'leg press');
});

test('extractGenerationConstraints returns an empty object when there are no constraints', () => {
  assert.deepEqual(extractGenerationConstraints('Plan me a workout.'), {});
  assert.deepEqual(extractGenerationConstraints(''), {});
  assert.deepEqual(extractGenerationConstraints(null), {});
});
