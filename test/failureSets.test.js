'use strict';

// Regression — RIR 0 (failure) sets must be DETECTED from a session's logged sets so
// the coach can acknowledge failure work. Flight Recorder evidence: the lifter took
// dips to failure (RIR 0) and asked "Why till failure for dips?" / "So why ask me to
// don't failure with dips?" — the coach had no failure signal in its context.
// Pure detector; no loads invented, no progression math touched.

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectFailureSets, sessionSetsFromContext, isFailureRir } = require('../services/failureSets');

test('isFailureRir: RIR 0 and negative are failure; >=1, null, blank, NaN are not', () => {
  assert.equal(isFailureRir(0), true);
  assert.equal(isFailureRir(-1), true);
  assert.equal(isFailureRir('0'), true);
  assert.equal(isFailureRir(1), false);
  assert.equal(isFailureRir(2), false);
  assert.equal(isFailureRir(null), false);
  assert.equal(isFailureRir(''), false);
  assert.equal(isFailureRir(undefined), false);
});

test('detectFailureSets: flags the exercise with an RIR 0 set, not the RIR-2 ones', () => {
  const sets = [
    { exercise: 'Bench Press', weight: 225, reps: 5, rir: 2 },
    { exercise: 'Weighted Dip', weight: 60, reps: 8, rir: 0 }, // to failure
    { exercise: 'Weighted Dip', weight: 60, reps: 6, rir: 0 }, // to failure
    { exercise: 'Lateral Raise', weight: 15, reps: 15, rir: 1 }
  ];
  const failed = detectFailureSets(sets);
  assert.equal(failed.length, 1, 'only the failure exercise is flagged');
  assert.equal(failed[0].exercise, 'Weighted Dip');
  assert.equal(failed[0].failure_count, 2);
  assert.deepEqual(failed[0].sets, [
    { weight: 60, reps: 8, rir: 0 },
    { weight: 60, reps: 6, rir: 0 }
  ]);
});

test('detectFailureSets: no failure sets → empty (a normal RIR 1-3 session)', () => {
  const failed = detectFailureSets([
    { exercise: 'Squat', weight: 315, reps: 5, rir: 2 },
    { exercise: 'Row', weight: 135, reps: 10, rir: 3 }
  ]);
  assert.deepEqual(failed, []);
});

test('detectFailureSets: negative RIR (past failure) counts; blanks/junk skipped, no loads invented', () => {
  const failed = detectFailureSets([
    { exercise: 'Dips', weight: 'bw', reps: 8, rir: -1 }, // ground past failure; weight not numeric
    { exercise: '', weight: 100, reps: 5, rir: 0 },       // no name → skip
    { exercise: 'Curl', weight: 30, reps: 12, rir: null } // unknown RIR → not failure
  ]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].exercise, 'Dips');
  assert.equal(failed[0].sets[0].weight, null, 'non-numeric load is null, never invented');
  assert.equal(failed[0].sets[0].rir, -1);
});

test('sessionSetsFromContext: pulls the live preview sets (the current session), not history', () => {
  const context = {
    current_preview: [
      { exercise: 'Weighted Dip', weight: 60, reps: 8, rir: 0 },
      { exercise: 'Lateral Raise', weight: 15, reps: 15, rir: 1 }
    ],
    recent_sessions: [{ date: '2026-06-01', lift_sets: { 'Bench Press': [{ weight: 135, reps: 10, rir: 0 }] } }]
  };
  const sets = sessionSetsFromContext(context);
  const failed = detectFailureSets(sets);
  assert.equal(failed.length, 1, 'only the live-session dips failure is surfaced, not old saved history');
  assert.equal(failed[0].exercise, 'Weighted Dip');
});

// The signal must survive sanitization and reach the coach's chat prompt.
const coach = require('../services/coach');

test('sanitizeChatContext preserves failure_sets (whitelisted), drops junk fields', () => {
  const sanitized = coach.sanitizeChatContext({
    failure_sets: [
      { exercise: 'Weighted Dip', failure_count: 2, sets: [{ weight: 60, reps: 8, rir: 0 }], secret: 'drop-me' }
    ]
  });
  assert.ok(Array.isArray(sanitized.failure_sets), 'failure_sets is carried through');
  assert.equal(sanitized.failure_sets.length, 1);
  assert.equal(sanitized.failure_sets[0].exercise, 'Weighted Dip');
  assert.equal(sanitized.failure_sets[0].failure_count, 2);
  assert.equal(sanitized.failure_sets[0].sets[0].rir, 0);
  assert.equal(sanitized.failure_sets[0].secret, undefined, 'only whitelisted fields survive');
});

test('chat system prompt instructs the coach to acknowledge failure work without inventing loads', () => {
  const prompt = String(coach.buildChatSystemPrompt({ session_count: 5 }));
  assert.match(prompt, /failure_sets/, 'prompt references the failure_sets signal');
  assert.match(prompt, /reps in reserve/i, 'prompt gives the manage-fatigue guidance');
  assert.match(prompt, /never invent a load|invents no loads|never invent/i, 'prompt forbids inventing loads');
});
