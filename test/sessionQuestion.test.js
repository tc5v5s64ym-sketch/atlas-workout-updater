'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isSessionStateQuestion, isPlannedLiftQuestion } = require('../public/sessionQuestion');

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
  // question OR a named-planned-lift value question (e.g. "what's the RIR for bench?").
  assert.match(src, /skipSme\s*=\s*hasActiveWorkout\s*&&\s*\(sessionShaped\s*\|\|\s*plannedLiftValue\)/,
    'skipSme should require an active workout AND (session-shaped OR a planned-lift value question)');
  assert.match(src, /sessionQuestion\.isPlannedLiftQuestion\(message,\s*planLiftNames\)/,
    'getChatReply should classify named-planned-lift value questions via isPlannedLiftQuestion');
  assert.match(src, /if\s*\(\s*!skipSme\s*\)\s*try\s*\{/,
    'the /api/coach/ask SME block should run only when not skipped');

  // The session-aware coach path is still present as the fall-through / target.
  assert.match(src, /\/api\/coach\/chat/, 'the session-aware coach path must remain');
});

test('the new script is wired into the shell (index.html + service worker)', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /<script src="sessionQuestion\.js"><\/script>/,
    'index.html must load sessionQuestion.js');
  // Loaded before coach-conversation.js so the global exists when getChatReply runs.
  assert.ok(
    html.indexOf('sessionQuestion.js') < html.indexOf('coach-conversation.js'),
    'sessionQuestion.js must load before coach-conversation.js');

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
