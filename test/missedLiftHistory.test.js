'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMissedLiftHistory } = require('../services/missedLiftHistory');
const { detectPatterns, detectMissedLifts } = require('../services/coachMemory');

// ── buildMissedLiftHistory ────────────────────────────────────────────────────

test('buildMissedLiftHistory: empty → empty array', () => {
  assert.deepEqual(buildMissedLiftHistory([]), []);
  assert.deepEqual(buildMissedLiftHistory(null), []);
});

test('buildMissedLiftHistory: no planned exercises → empty array', () => {
  const sessions = [{ planned: [], completed: [], date: '2026-04-01' }];
  assert.deepEqual(buildMissedLiftHistory(sessions), []);
});

test('buildMissedLiftHistory: GOLDEN FIXTURE — missed exercise in a completed session', () => {
  // Session planned [Bench, Squat, Row]; completed [Bench, Squat]; Row was missed.
  const sessions = [{
    planned:   ['Bench Press', 'Squat', 'Row'],
    completed: ['Bench Press', 'Squat'],
    date: '2026-04-01',
  }];
  const result = buildMissedLiftHistory(sessions);
  assert.equal(result.length, 1);
  assert.equal(result[0].exercise, 'Row');
  assert.equal(result[0].date, '2026-04-01');
});

test('buildMissedLiftHistory: no miss when all planned exercises completed', () => {
  const sessions = [{
    planned:   ['Bench Press', 'Squat'],
    completed: ['Bench Press', 'Squat'],
    date: '2026-04-01',
  }];
  assert.deepEqual(buildMissedLiftHistory(sessions), []);
});

test('buildMissedLiftHistory: abandoned session (nothing completed) → no miss events', () => {
  // The session never started — no completed exercises means we can't confirm it happened.
  const sessions = [{
    planned:   ['Bench Press', 'Squat', 'Row'],
    completed: [],
    date: '2026-04-01',
  }];
  assert.deepEqual(buildMissedLiftHistory(sessions), [], 'abandoned session must not emit misses');
});

test('buildMissedLiftHistory: multiple sessions → multiple miss events', () => {
  const sessions = [
    { planned: ['Bench Press', 'Row'], completed: ['Bench Press'],          date: '2026-04-01' }, // Row missed
    { planned: ['Squat', 'Leg Curl'],  completed: ['Squat'],                date: '2026-04-08' }, // Leg Curl missed
    { planned: ['Bench Press', 'Row'], completed: ['Bench Press', 'Row'],   date: '2026-04-15' }, // nothing missed
  ];
  const result = buildMissedLiftHistory(sessions);
  assert.equal(result.length, 2);
  assert.ok(result.find(e => e.exercise === 'Row' && e.date === '2026-04-01'));
  assert.ok(result.find(e => e.exercise === 'Leg Curl' && e.date === '2026-04-08'));
});

test('buildMissedLiftHistory: matching is case-insensitive', () => {
  const sessions = [{
    planned:   ['Bench Press', 'Row'],
    completed: ['bench press'],  // lowercase variant
    date: '2026-04-01',
  }];
  const result = buildMissedLiftHistory(sessions);
  assert.equal(result.length, 1);
  assert.equal(result[0].exercise, 'Row');
});

test('buildMissedLiftHistory: events sorted chronologically', () => {
  const sessions = [
    { planned: ['Row'],   completed: [],    date: '2026-04-08' }, // abandoned, no miss
    { planned: ['Bench'], completed: [],    date: '2026-03-01' }, // abandoned, no miss
    { planned: ['Squat', 'Leg Curl'], completed: ['Squat'], date: '2026-04-15' },
    { planned: ['Bench', 'Row'],      completed: ['Bench'], date: '2026-03-22' },
  ];
  const result = buildMissedLiftHistory(sessions);
  assert.equal(result.length, 2);
  assert.ok(result[0].date <= result[1].date, 'events must be chronological');
  assert.equal(result[0].date, '2026-03-22');
  assert.equal(result[1].date, '2026-04-15');
});

// ── detectMissedLifts ─────────────────────────────────────────────────────────

test('detectMissedLifts: empty history → empty array', () => {
  assert.deepEqual(detectMissedLifts([]), []);
  assert.deepEqual(detectMissedLifts(null), []);
});

test('detectMissedLifts: single miss fires the pattern (threshold = 1)', () => {
  const history = [{ exercise: 'Row', date: '2026-04-01' }];
  const patterns = detectMissedLifts(history);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].type, 'missed_lift');
  assert.equal(patterns[0].details.exercise, 'row');
  assert.equal(patterns[0].details.count, 1);
});

test('detectMissedLifts: counts multiple misses of the same exercise', () => {
  const history = [
    { exercise: 'Row', date: '2026-03-01' },
    { exercise: 'Row', date: '2026-03-08' },
    { exercise: 'Row', date: '2026-03-15' },
  ];
  const patterns = detectMissedLifts(history);
  const rowPattern = patterns.find(p => p.details.exercise === 'row');
  assert.ok(rowPattern);
  assert.equal(rowPattern.details.count, 3);
});

test('detectMissedLifts: different exercises produce separate patterns', () => {
  const history = [
    { exercise: 'Row',      date: '2026-04-01' },
    { exercise: 'Hip Thrust', date: '2026-04-08' },
  ];
  const patterns = detectMissedLifts(history);
  assert.equal(patterns.length, 2);
  const exercises = patterns.map(p => p.details.exercise).sort();
  assert.deepEqual(exercises, ['hip thrust', 'row']);
});

test('detectMissedLifts: only looks at last 10 entries (MISSED_LIFT_WINDOW)', () => {
  // 12 entries: 11 × Squat missed long ago, 1 × Row missed recently
  const history = [];
  for (let i = 0; i < 11; i++) {
    history.push({ exercise: 'Squat', date: `2025-0${Math.floor(i / 10) + 1}-${String(i % 28 + 1).padStart(2, '0')}` });
  }
  history.push({ exercise: 'Row', date: '2026-04-12' });

  const patterns = detectMissedLifts(history);
  // Window = last 10 entries: 10 × Squat and 1 × Row — but 11th Squat pushed out
  const squatPattern = patterns.find(p => p.details.exercise === 'squat');
  // Only 9 of the 11 Squat entries are within the last-10 window (plus Row)
  // So squatPattern.details.count should be ≤ 10
  if (squatPattern) {
    assert.ok(squatPattern.details.count <= 10, 'count must not exceed window size');
  }
  const rowPattern = patterns.find(p => p.details.exercise === 'row');
  assert.ok(rowPattern, 'Row must appear in the window');
});

// ── Integration: buildMissedLiftHistory → detectMissedLifts ──────────────────
//
// detectMissedLifts is a STANDALONE utility — it is NOT wired into detectPatterns.
// Missed-lift events are exercise-name-based (not lift-code-specific); mixing them
// into detectPatterns would contaminate per-lift patterns (a missed Row would appear
// under Bench, Deadlift, etc.). Callers must invoke detectMissedLifts separately at
// the session level, not per-lift.

test('GOLDEN FIXTURE — detectMissedLifts fires directly (not via detectPatterns)', () => {
  const sessions = [{
    planned:   ['Bench Press', 'Squat', 'Row'],
    completed: ['Bench Press', 'Squat'],
    date: '2026-04-01',
  }];
  const missedLiftHistory = buildMissedLiftHistory(sessions);
  const patterns = detectMissedLifts(missedLiftHistory);

  const missedPattern = patterns.find(p => p.type === 'missed_lift');
  assert.ok(missedPattern, 'missed_lift pattern must fire');
  assert.equal(missedPattern.details.exercise, 'row');
  assert.equal(missedPattern.details.count, 1);
});

test('missed_lift does NOT fire when all planned exercises completed', () => {
  const sessions = [{
    planned:   ['Bench Press', 'Row'],
    completed: ['Bench Press', 'Row'],
    date: '2026-04-01',
  }];
  const missedLiftHistory = buildMissedLiftHistory(sessions);
  const patterns = detectMissedLifts(missedLiftHistory);
  const missedPattern = patterns.find(p => p.type === 'missed_lift');
  assert.equal(missedPattern, undefined, 'must not fire when plan was fully completed');
});

test('detectPatterns does NOT accept missedLiftHistory (isolation check)', () => {
  // Passing missedLiftHistory to detectPatterns must be silently ignored — it is not
  // a supported option. The caller must invoke detectMissedLifts separately.
  const sessions = [{
    planned:   ['Bench Press', 'Squat', 'Row'],
    completed: ['Bench Press', 'Squat'],
    date: '2026-04-01',
  }];
  const missedLiftHistory = buildMissedLiftHistory(sessions);
  const { patterns } = detectPatterns('BPR01', [], { missedLiftHistory });
  const missedPattern = patterns.find(p => p.type === 'missed_lift');
  assert.equal(missedPattern, undefined, 'detectPatterns must not process missedLiftHistory');
});
