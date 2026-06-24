'use strict';

// Slice 3 — recovery routing (services/recoveryRouting.js). The deterministic
// engine owns a tired lifter's reply and routes on recovery; it never hypes.

const { test } = require('node:test');
const assert = require('node:assert');

const { isTirednessExpression, buildTirednessRecoveryAnswer } = require('../services/recoveryRouting');

const HYPE = /push through|you('?| )ve got this|you got this|no excuses|grind it out|dig deep|beast mode|crush it|let'?s go champ|keep grinding/i;

test('isTirednessExpression: detects genuine self-reported fatigue', () => {
  for (const m of [
    "I'm tired", 'I am exhausted today', 'legs are toast', "I'm wiped out", 'feeling drained',
    'no energy today', 'low energy', 'cooked', 'wrecked', 'I am beat up', 'shoulders are fried',
    'so gassed', 'totally smoked', 'running on empty', 'knackered', 'I feel exhausted', 'wiped',
  ]) {
    assert.equal(isTirednessExpression(m), true, `should detect: ${m}`);
  }
});

test('isTirednessExpression: ignores impatience and unrelated uses (no over-capture)', () => {
  for (const m of [
    'tired of waiting for a rack', "I'm sick and tired of these light weights", 'beat my PR today',
    'is the gym dead right now?', 'what is my bench trending?', 'how many reps for squat?',
    'deadlift felt great', 'dead bug for core', 'should I add weight?', '', '   ',
  ]) {
    assert.equal(isTirednessExpression(m), false, `should NOT detect: ${m}`);
  }
});

test('isTirednessExpression: negation does not route a not-tired lifter to recovery', () => {
  for (const m of [
    "I'm not tired today", 'not feeling tired, let'+"'"+'s go heavy', "I'm not that wrecked",
    'hardly tired', 'barely drained', 'no longer exhausted', "I'm not cooked at all",
  ]) {
    assert.equal(isTirednessExpression(m), false, `negation should NOT detect: ${m}`);
  }
});

test('isTirednessExpression: an analytical question about fatigue belongs to the coach, not the canned line', () => {
  for (const m of [
    'why am I always tired lately?', 'how come I get so exhausted mid-session?',
    'is it normal to feel this drained?', 'should I be this wiped after squats?',
  ]) {
    assert.equal(isTirednessExpression(m), false, `question should NOT short-circuit: ${m}`);
  }
});

test('buildTirednessRecoveryAnswer: elevated weekly load → pull-back, grounded, no hype', () => {
  const a = buildTirednessRecoveryAnswer({ fatigueStatus: { status: 'high' } });
  assert.match(a, /above your usual volume/);
  assert.match(a, /pull-back|lighter|reserve|rest/i);
  assert.doesNotMatch(a, HYPE);
});

test('buildTirednessRecoveryAnswer: back-to-back training is named', () => {
  assert.match(buildTirednessRecoveryAnswer({ daysSinceLastSession: 0 }), /already trained today/);
  assert.match(buildTirednessRecoveryAnswer({ daysSinceLastSession: 1 }), /trained yesterday/);
});

test('buildTirednessRecoveryAnswer: fatigued patterns are named from the readiness snapshot', () => {
  const a = buildTirednessRecoveryAnswer({ readiness: [
    { pattern: 'horizontal push', status: 'fatigued' },
    { pattern: 'squat', status: 'ready' },
  ] });
  assert.match(a, /horizontal push/);
  assert.match(a, /flagged fatigued/);
  assert.doesNotMatch(a, HYPE);
});

test('buildTirednessRecoveryAnswer: well-rested logs are acknowledged honestly (no forced grind)', () => {
  const a = buildTirednessRecoveryAnswer({ fatigueStatus: { status: 'normal' }, daysSinceLastSession: 4 });
  assert.match(a, /look recovered/);
  assert.match(a, /4 days/);
  assert.doesNotMatch(a, HYPE);
});

test('buildTirednessRecoveryAnswer: no signals → safe recovery routing, no invented numbers, no hype', () => {
  const a = buildTirednessRecoveryAnswer({});
  assert.match(a, /don'?t force it|rest day|lighter/i);
  assert.doesNotMatch(a, HYPE);
  assert.doesNotMatch(a, /\b\d+\s*(lb|kg|reps)\b/i, 'never fabricates a lift-specific prescription');
  assert.ok(a.trim().length > 0);
});

test('isTirednessExpression: muscle-specific body-part phrasings route to recovery (FRAMING gap)', () => {
  for (const m of [
    'quads are fried', 'my quads are cooked', 'hamstrings are toast', 'hams are wrecked',
    'glutes are cooked', 'calves are beat up', 'chest is fried', 'delts are cooked',
    'traps are wrecked', 'lats are toast', 'hips are fried', 'core is cooked',
  ]) {
    assert.equal(isTirednessExpression(m), true, `muscle-specific phrase should detect: ${m}`);
  }
});

test('buildTirednessRecoveryAnswer: never hypes across every signal combination', () => {
  const combos = [
    {}, { fatigueStatus: { status: 'high' } }, { fatigueStatus: { status: 'normal' }, daysSinceLastSession: 5 },
    { daysSinceLastSession: 0 }, { daysSinceLastSession: 1 },
    { readiness: [{ pattern: 'hinge', status: 'caution' }] },
    { fatigueStatus: { status: 'no_baseline' } },
  ];
  for (const c of combos) assert.doesNotMatch(buildTirednessRecoveryAnswer(c), HYPE, JSON.stringify(c));
});
