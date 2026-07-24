'use strict';

// Slice 3 — recovery routing (services/recoveryRouting.js). The deterministic
// engine owns a tired lifter's reply and routes on recovery; it never hypes.

const { test } = require('node:test');
const assert = require('node:assert');

const { isTirednessExpression, buildTirednessRecoveryAnswer, recoveryReasonFacts } = require('../services/recoveryRouting');

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

test('isTirednessExpression: detects muscle-specific fatigue slang (P4 FRAMING gap)', () => {
  for (const m of [
    'quads are fried', 'hamstrings are toast', 'chest is cooked', 'glutes are wrecked',
    'calves are toast', 'lats are fried', 'delts are cooked', 'core is toast', 'triceps are fried',
  ]) {
    assert.equal(isTirednessExpression(m), true, `should detect muscle-specific fatigue: ${m}`);
  }
});

test('isTirednessExpression: a muscle name without fatigue slang is not a fatigue report', () => {
  for (const m of [
    'quads day tomorrow', 'training chest today', 'add a glute exercise', 'what hits the lats?',
    'dead bug for core',
  ]) {
    assert.equal(isTirednessExpression(m), false, `muscle mention alone should NOT detect: ${m}`);
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

test('buildTirednessRecoveryAnswer: never hypes across every signal combination', () => {
  const combos = [
    {}, { fatigueStatus: { status: 'high' } }, { fatigueStatus: { status: 'normal' }, daysSinceLastSession: 5 },
    { daysSinceLastSession: 0 }, { daysSinceLastSession: 1 },
    { readiness: [{ pattern: 'hinge', status: 'caution' }] },
    { fatigueStatus: { status: 'no_baseline' } },
  ];
  for (const c of combos) assert.doesNotMatch(buildTirednessRecoveryAnswer(c), HYPE, JSON.stringify(c));
});

// ── recoveryReasonFacts — the canonical recovery-reason facts (Phase 4 H-03) ──────────────────
//
// The exact, authoritative facts buildTirednessRecoveryAnswer consumes, extracted once for a
// CoachingDecision's explanation_inputs. Only genuinely-present facts appear; values are carried
// as the reply reads them (verbatim fatigue_status; same day normalization; the FULL fatigued
// pattern list). These prove the extractor captures every branch discriminator faithfully.

test('recoveryReasonFacts: engine-grounded elevated + back-to-back carries fatigue_status + days', () => {
  const f = recoveryReasonFacts({ fatigueStatus: { status: 'high' }, daysSinceLastSession: 1, readiness: [] });
  assert.deepEqual(f, { fatigue_status: 'high', days_since_last_session: 1 });
});

test('recoveryReasonFacts: days === 0 (trained today) is carried, not dropped as falsy', () => {
  const f = recoveryReasonFacts({ fatigueStatus: { status: 'normal' }, daysSinceLastSession: 0 });
  assert.equal(f.days_since_last_session, 0);
});

test('recoveryReasonFacts: carries the FULL flagged-fatigued pattern list (reply needs slice+length)', () => {
  const f = recoveryReasonFacts({ readiness: [
    { pattern: 'horizontal push', status: 'fatigued' },
    { pattern: 'squat', status: 'fatigued' },
    { pattern: 'hinge', status: 'fatigued' },
    { pattern: 'row', status: 'caution' }, // not fatigued → excluded
  ] });
  assert.deepEqual(f.fatigued_patterns, ['horizontal push', 'squat', 'hinge']);
});

test('recoveryReasonFacts: recovered branch carries normal status + day count', () => {
  const f = recoveryReasonFacts({ fatigueStatus: { status: 'normal' }, daysSinceLastSession: 5 });
  assert.deepEqual(f, { fatigue_status: 'normal', days_since_last_session: 5 });
});

test('recoveryReasonFacts: outage/limited (client readiness only) yields at most fatigued_patterns', () => {
  assert.deepEqual(recoveryReasonFacts({ readiness: [{ pattern: 'hinge', status: 'fatigued' }] }), { fatigued_patterns: ['hinge'] });
  assert.deepEqual(recoveryReasonFacts({ readiness: [{ pattern: 'hinge', status: 'caution' }] }), {}, 'no fatigued pattern ⇒ nothing');
});

test('recoveryReasonFacts: a bare / empty signal yields {} (honest — nothing grounded)', () => {
  assert.deepEqual(recoveryReasonFacts({}), {});
  assert.deepEqual(recoveryReasonFacts(), {});
  assert.deepEqual(recoveryReasonFacts(null), {});
});

test('recoveryReasonFacts: malformed inputs fail closed (no fabricated facts)', () => {
  assert.deepEqual(recoveryReasonFacts({ fatigueStatus: 'nope', readiness: 'nope', daysSinceLastSession: 'abc' }), {},
    'non-object status / non-array readiness / non-numeric days ⇒ all omitted');
  assert.deepEqual(recoveryReasonFacts({ fatigueStatus: {}, daysSinceLastSession: null }), {}, 'no status / null days ⇒ omitted');
});

test('recoveryReasonFacts: coerces a numeric-string day count exactly as the reply does', () => {
  const f = recoveryReasonFacts({ daysSinceLastSession: '3' });
  assert.equal(f.days_since_last_session, 3);
});

test('recoveryReasonFacts: the facts capture the branch the reply actually takes (spot check)', () => {
  // Elevated → the reply's "well above your usual volume" branch; the fact records fatigue_status:'high'.
  const elevated = { fatigueStatus: { status: 'high' }, daysSinceLastSession: 3, readiness: [] };
  assert.equal(recoveryReasonFacts(elevated).fatigue_status, 'high');
  assert.match(buildTirednessRecoveryAnswer(elevated), /well above your usual volume/);
  // Recovered → the reply's "look recovered" branch; the facts record normal + the day count.
  const recovered = { fatigueStatus: { status: 'normal' }, daysSinceLastSession: 4, readiness: [] };
  assert.deepEqual(recoveryReasonFacts(recovered), { fatigue_status: 'normal', days_since_last_session: 4 });
  assert.match(buildTirednessRecoveryAnswer(recovered), /look recovered/);
});
