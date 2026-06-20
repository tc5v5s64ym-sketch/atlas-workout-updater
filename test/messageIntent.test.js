const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMessageIntent, isQuestionText } = require('../services/messageIntent');

// ── isQuestionText ───────────────────────────────────────────────────────────

test('isQuestionText: trailing ? is a question', () => {
  assert.equal(isQuestionText('should I go up?'), true);
  assert.equal(isQuestionText('225x5'), false);
});

test('isQuestionText: interrogative openers and phrases', () => {
  assert.equal(isQuestionText("Didn't you suggest 225 5/2 x3"), true);
  assert.equal(isQuestionText('what is my squat progression'), true);
  assert.equal(isQuestionText('how much should I bench'), true);
  assert.equal(isQuestionText('should i deload'), true);
});

test('isQuestionText: a bare past-tense log is NOT a question', () => {
  // "did 225x5" means "I did 225 for 5" — must stay loggable, not a question.
  assert.equal(isQuestionText('did 225x5'), false);
  assert.equal(isQuestionText('done with squats'), false);
});

test('isQuestionText: openers do not fire on lift names that merely share letters', () => {
  assert.equal(isQuestionText('arnold press 50 8/2'), false); // not "are"
  assert.equal(isQuestionText('iso row 120 10'), false);      // not "is"
  assert.equal(isQuestionText('cable fly 30 12'), false);     // not "can"
});

// ── classifyMessageIntent — the AC8 credibility floor ────────────────────────

test('AC8: a pure question is answered, never logged', () => {
  // The documented 2026-06-16 phantom-set bug. "Didn't you suggest…" carries set
  // tokens but resolves to NO real lift — it must not be saved or "which lift?"d;
  // it is a question.
  const r = classifyMessageIntent("Didn't you suggest 225 5/2 x3", {
    hasResolvedLift: false, hasSetTokens: true
  });
  assert.equal(r.suppressLog, true);
  assert.equal(r.reason, 'question');
  assert.equal(r.isQuestion, true);
});

test('AC8: a mid-session stat question logs nothing', () => {
  const r = classifyMessageIntent("what's my squat progression over 3 months?", {
    hasResolvedLift: false, hasSetTokens: false
  });
  assert.equal(r.suppressLog, true);
  assert.equal(r.reason, 'question');
});

test('AC8: a real resolved set logs AND can also be a question (both-case)', () => {
  // "Crushed 235x8, should I go up?" — a genuine set with a question attached.
  // The set is real (resolved lift + tokens) so it logs; suppression does not fire.
  const r = classifyMessageIntent('Crushed 235x8, should I go up?', {
    hasResolvedLift: true, hasSetTokens: true
  });
  assert.equal(r.suppressLog, false);
  assert.equal(r.reason, null);
  assert.equal(r.isQuestion, true); // the caller may still answer it
});

test('AC8: an unresolved lift is not saved — ask which one', () => {
  // Not a question, but the lead name did not resolve to a known lift. Never
  // fabricate a phantom exercise; ask which lift instead.
  const r = classifyMessageIntent('zercher thrust 95 8/2', {
    hasResolvedLift: false, hasSetTokens: true
  });
  assert.equal(r.suppressLog, true);
  assert.equal(r.reason, 'unresolved_lift');
});

test('AC8: a normal resolved set logs cleanly', () => {
  const r = classifyMessageIntent('Bench 225 5/2', {
    hasResolvedLift: true, hasSetTokens: true
  });
  assert.equal(r.suppressLog, false);
  assert.equal(r.reason, null);
  assert.equal(r.isQuestion, false);
});

test('AC8: a continuation set (active exercise, no lead name) logs', () => {
  // "205 5/3" mid-session inherits the active lift → resolved + tokens → logs.
  const r = classifyMessageIntent('205 5/3', {
    hasResolvedLift: true, hasSetTokens: true
  });
  assert.equal(r.suppressLog, false);
  assert.equal(r.reason, null);
});

test('AC8: a greeting or chatter with nothing to log is not suppressed', () => {
  const r = classifyMessageIntent('feeling strong today', {
    hasResolvedLift: false, hasSetTokens: false
  });
  assert.equal(r.suppressLog, false);
  assert.equal(r.reason, null);
});
