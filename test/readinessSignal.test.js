'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const { computeReadiness } = require('../services/readinessSignal');

/* Helpers */

// Build a deviation entry as computeReadiness receives from classifyDeviation().
function dev(verdict, delta = null) {
  return { verdict, delta, magnitude: delta !== null && Math.abs(delta) >= 4 ? 'significant' : 'slight' };
}

const BELOW  = dev('below_expected', -3);
const ABOVE  = dev('above_expected', 3);
const ON     = dev('on_target', 0);
const INSUFF = dev('insufficient_data');

const DECLINING = { trend: 'declining', confidence: 'high', sessions_analyzed: 6 };
const FLAT      = { trend: 'flat',      confidence: 'high', sessions_analyzed: 6 };
const IMPROVING = { trend: 'improving', confidence: 'high', sessions_analyzed: 6 };
const NOISY     = { trend: 'noisy',     confidence: 'medium', sessions_analyzed: 4 };

/* ===== Null / empty guards ===== */

test('computeReadiness: null deviationHistory → monitoring/none', () => {
  const r = computeReadiness(null, null);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'none');
  assert.equal(r.note, null);
});

test('computeReadiness: empty deviationHistory → monitoring/none', () => {
  const r = computeReadiness(DECLINING, []);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'none');
  assert.equal(r.note, null);
});

test('computeReadiness: non-array deviationHistory → monitoring/none', () => {
  const r = computeReadiness(null, 'bad input');
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'none');
});

/* ===== Return shape ===== */

test('computeReadiness: return shape always has signal, confidence, note', () => {
  const r = computeReadiness(null, [BELOW, BELOW, BELOW]);
  assert.ok('signal'     in r);
  assert.ok('confidence' in r);
  assert.ok('note'       in r);
});

/* ===== Monitoring (0 bad sessions) ===== */

test('computeReadiness: all on_target sessions → monitoring/none', () => {
  const r = computeReadiness(null, [ON, ON, ON, ON]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'none');
  assert.equal(r.note, null);
});

test('computeReadiness: all above_expected sessions → monitoring/none', () => {
  const r = computeReadiness(DECLINING, [ABOVE, ABOVE, ABOVE]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'none');
});

/* ===== Monitoring (1–2 consecutive bad sessions) ===== */

test('computeReadiness: 1 bad session → monitoring/low (plan spec: one bad day is just monitoring)', () => {
  const r = computeReadiness(DECLINING, [BELOW]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'low');
  assert.equal(r.note, null);
});

test('computeReadiness: 2 consecutive bad sessions → monitoring/low', () => {
  const r = computeReadiness(DECLINING, [BELOW, BELOW]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'low');
});

test('computeReadiness: 1 bad session at tail, preceded by good ones → monitoring/low', () => {
  const r = computeReadiness(DECLINING, [ON, ABOVE, ON, BELOW]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'low');
});

test('computeReadiness: 2 consecutive bad sessions at tail, preceded by good → monitoring/low', () => {
  const r = computeReadiness(DECLINING, [ABOVE, ON, BELOW, BELOW]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'low');
});

/* ===== possible_fatigue (3+ consecutive bad sessions, no declining trend) ===== */

test('computeReadiness: 3 consecutive bad sessions, flat trend → possible_fatigue', () => {
  const r = computeReadiness(FLAT, [BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'possible_fatigue');
  assert.equal(r.confidence, 'medium');
  assert.equal(r.note, 'consecutive_below_expected');
});

test('computeReadiness: 3 consecutive bad sessions, improving trend → possible_fatigue', () => {
  const r = computeReadiness(IMPROVING, [ON, BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'possible_fatigue');
  assert.equal(r.confidence, 'medium');
});

test('computeReadiness: 3 consecutive bad sessions, noisy trend → possible_fatigue', () => {
  const r = computeReadiness(NOISY, [BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'possible_fatigue');
  assert.equal(r.confidence, 'medium');
});

test('computeReadiness: 3 consecutive bad sessions, null trend → possible_fatigue', () => {
  const r = computeReadiness(null, [BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'possible_fatigue');
  assert.equal(r.confidence, 'medium');
});

test('computeReadiness: 4 consecutive bad sessions, flat trend → possible_fatigue', () => {
  const r = computeReadiness(FLAT, [BELOW, BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'possible_fatigue');
  assert.equal(r.confidence, 'medium');
});

/* ===== likely_fatigue (3+ consecutive bad sessions + declining trend) ===== */

test('computeReadiness: 3 consecutive bad sessions + declining trend → likely_fatigue', () => {
  const r = computeReadiness(DECLINING, [BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'likely_fatigue');
  assert.equal(r.confidence, 'high');
  assert.equal(r.note, 'sustained_declining_trend');
});

test('computeReadiness: 5 consecutive bad sessions + declining trend → likely_fatigue', () => {
  const r = computeReadiness(DECLINING, [ON, BELOW, BELOW, BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'likely_fatigue');
  assert.equal(r.confidence, 'high');
});

test('computeReadiness: 2 bad sessions + declining trend → monitoring (never likely_fatigue without streak ≥ 3)', () => {
  const r = computeReadiness(DECLINING, [BELOW, BELOW]);
  assert.equal(r.signal, 'monitoring');
  assert.notEqual(r.signal, 'likely_fatigue');
});

test('computeReadiness: accepts plain trend string "declining"', () => {
  const r = computeReadiness('declining', [BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'likely_fatigue');
});

/* ===== Streak counting — most recent last ===== */

test('computeReadiness: streak counts only from the tail', () => {
  // 3 bad sessions in the middle, but the tail is on_target → monitoring
  const r = computeReadiness(DECLINING, [BELOW, BELOW, BELOW, ON]);
  assert.equal(r.signal, 'monitoring');
});

test('computeReadiness: streak resets at a good session in the tail', () => {
  // 2 bad, 1 good, 2 bad → streak = 2 at tail → monitoring
  const r = computeReadiness(DECLINING, [BELOW, BELOW, ON, BELOW, BELOW]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'low');
});

/* ===== insufficient_data entries break the streak ===== */

test('computeReadiness: insufficient_data entry breaks the streak', () => {
  // 2 below + 1 insufficient_data → streak = 0 (not 2) since insufficient breaks
  const r = computeReadiness(DECLINING, [BELOW, BELOW, INSUFF]);
  assert.equal(r.signal, 'monitoring');
  assert.equal(r.confidence, 'none');
});

test('computeReadiness: streak resumes after insufficient_data if new bad sessions follow', () => {
  // insuff, below, below, below → streak = 3 → possible_fatigue
  const r = computeReadiness(FLAT, [INSUFF, BELOW, BELOW, BELOW]);
  assert.equal(r.signal, 'possible_fatigue');
});

/* ===== Plain verdict strings ===== */

test('computeReadiness: accepts plain verdict strings in deviationHistory', () => {
  const r = computeReadiness(DECLINING, ['below_expected', 'below_expected', 'below_expected']);
  assert.equal(r.signal, 'likely_fatigue');
});

/* ===== Plan spec golden case ===== */

test('computeReadiness: plan spec — one bad bench day → monitoring, not strength loss confirmed', () => {
  const r = computeReadiness(DECLINING, [ABOVE, ON, ON, BELOW]);
  assert.equal(r.signal, 'monitoring');
  assert.notEqual(r.signal, 'likely_fatigue');
  assert.notEqual(r.signal, 'possible_fatigue');
});
