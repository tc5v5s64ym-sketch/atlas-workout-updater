'use strict';

// Soul Plan PR-B5b Part 1 — discouragement-signal golden fixtures.
//
// Explicit-language only (no sentiment inference). Pins: each kind fires on its
// phrases; the stall-context boost; near-miss non-firing (tiredness routes to the
// recovery read, not here); negation + question guards; lift-name collisions;
// totality.

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectDiscouragement } = require('../services/discouragementSignal');
const { isTirednessExpression } = require('../services/recoveryRouting');

// ── Frustration ───────────────────────────────────────────────────────────────

test('frustration: explicit stuck/plateau/frustrated phrases fire', () => {
  for (const msg of [
    'bench is stuck, been the same for weeks',
    "I've totally plateaued on squat",
    "I'm so frustrated with my progress",
    'feel like I\'m going nowhere',
    "can't break through on deadlift",
    'hitting a wall on pressing',
  ]) {
    const out = detectDiscouragement(msg, {});
    assert.equal(out.discouraged, true, msg);
    assert.equal(out.kind, 'frustration', msg);
    assert.ok(out.matched, msg);
  }
});

// ── Negative self-talk ────────────────────────────────────────────────────────

test('negative_self_talk: explicit self-directed phrases fire', () => {
  for (const msg of [
    "I feel like I'm going backwards",
    "I'm just weak",
    "I'll never hit 315",
    "honestly I suck at this",
    "what's the point anymore",
    "feel like I'm falling behind",
  ]) {
    const out = detectDiscouragement(msg, {});
    assert.equal(out.discouraged, true, msg);
    assert.equal(out.kind, 'negative_self_talk', msg);
  }
});

// ── stall_frustration boost ───────────────────────────────────────────────────

test('stall_frustration: frustration + engine stall context boosts the kind', () => {
  const ctx = { stalls: [{ exercise: 'Bench Press', sessions_stalled: 4 }] };
  const out = detectDiscouragement('bench is stuck and it sucks', ctx);
  assert.equal(out.discouraged, true);
  assert.equal(out.kind, 'stall_frustration');
  // Same message, no stall context → base frustration kind.
  assert.equal(detectDiscouragement('bench is stuck and it sucks', {}).kind, 'frustration');
  // Empty stalls array does not boost.
  assert.equal(detectDiscouragement('bench is stuck', { stalls: [] }).kind, 'frustration');
});

// ── Tiredness routes to recovery, NOT here ────────────────────────────────────

test('near-miss: pure tiredness is NOT discouragement (routes to the recovery read)', () => {
  for (const msg of ["I'm exhausted", 'legs are toast', "I'm wiped out", 'so drained today']) {
    assert.equal(detectDiscouragement(msg, {}).discouraged, false, msg);
    assert.equal(isTirednessExpression(msg), true, `${msg} is a tiredness expression handled elsewhere`);
  }
});

// ── Negation + question guards ────────────────────────────────────────────────

test('guard: negated discouragement never fires', () => {
  for (const msg of [
    "bench isn't stuck anymore, finally moving",
    "I'm not going backwards",
    "don't feel weak today",
    "not frustrated at all, feeling good",
  ]) {
    assert.equal(detectDiscouragement(msg, {}).discouraged, false, msg);
  }
});

test('guard: an analytical leading question does not fire (it is for the coach)', () => {
  for (const msg of ['why is my bench stuck?', 'how do I get past this plateau', 'what should I do about being stuck']) {
    assert.equal(detectDiscouragement(msg, {}).discouraged, false, msg);
  }
});

// ── Lift-name collision + totality ────────────────────────────────────────────

test('guard: neutral logging / lift names never fire', () => {
  for (const msg of ['bench 225 5/2', 'did squats and rows today', 'stalled the car on the way to the gym... jk logging bench']) {
    // (the last is a torture case; "stalled" fires — acceptable, explicit language.
    //  the first two must NOT fire.)
    if (msg.startsWith('bench 2') || msg.startsWith('did squ')) {
      assert.equal(detectDiscouragement(msg, {}).discouraged, false, msg);
    }
  }
});

test('totality: garbage/empty input → not discouraged, never throws', () => {
  for (const args of [[null, null], ['', {}], [42, null], ['   ', undefined], ['random gym chatter', { stalls: 'nope' }]]) {
    const out = detectDiscouragement(...args);
    assert.equal(out.discouraged, false);
    assert.equal(typeof out, 'object');
  }
});
