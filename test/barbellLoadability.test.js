'use strict';

// P0 AC12 — barbell loadability guard. A computed barbell weight must round to a
// load the owner can actually build (45 lb bar; plates 45/35/25/10/5/2.5 per side →
// 5 lb total jumps). See services/barbellLoadability.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLoadableBarbell, roundToLoadableBarbell } = require('../services/barbellLoadability');

test('AC12: the OHP 116 case rounds to a loadable 115 with an explanation', () => {
  const r = roundToLoadableBarbell(116);
  assert.equal(r.weight, 115);
  assert.equal(r.rounded, true);
  assert.match(r.note, /116/);
  assert.match(r.note, /115/);
  assert.match(r.note, /45 lb bar/);
});

test('roundToLoadableBarbell: nearest 5 with ties rounding up', () => {
  assert.equal(roundToLoadableBarbell(116).weight, 115);
  assert.equal(roundToLoadableBarbell(118).weight, 120);
  assert.equal(roundToLoadableBarbell(117.5).weight, 120); // tie → up
  assert.equal(roundToLoadableBarbell(112.5).weight, 115); // tie → up
  assert.equal(roundToLoadableBarbell(113).weight, 115);
  assert.equal(roundToLoadableBarbell(225).weight, 225);
});

test('roundToLoadableBarbell: an already-loadable weight is unchanged (no note)', () => {
  const r = roundToLoadableBarbell(115);
  assert.equal(r.weight, 115);
  assert.equal(r.rounded, false);
  assert.equal(r.note, null);
});

test('roundToLoadableBarbell: at/below the bar clamps to the empty bar', () => {
  assert.deepEqual(
    { weight: roundToLoadableBarbell(45).weight, rounded: roundToLoadableBarbell(45).rounded },
    { weight: 45, rounded: false }
  );
  const low = roundToLoadableBarbell(40);
  assert.equal(low.weight, 45);
  assert.equal(low.rounded, true);
  assert.match(low.note, /below the 45 lb bar/);
});

test('roundToLoadableBarbell: respects a custom bar and step', () => {
  assert.equal(roundToLoadableBarbell(116, { bar: 35 }).weight, 115); // 35 + 16*5 = 115
  assert.equal(roundToLoadableBarbell(101, { bar: 35, step: 10 }).weight, 105); // 35 + 7*10
});

test('roundToLoadableBarbell: a non-finite input returns a null weight, no throw', () => {
  const r = roundToLoadableBarbell(NaN);
  assert.equal(r.weight, null);
  assert.equal(r.rounded, false);
  assert.equal(r.note, null);
});

test('isLoadableBarbell: only the bar plus multiples of the step are loadable', () => {
  assert.equal(isLoadableBarbell(45), true);
  assert.equal(isLoadableBarbell(115), true);
  assert.equal(isLoadableBarbell(50), true);
  assert.equal(isLoadableBarbell(116), false);
  assert.equal(isLoadableBarbell(47), false);
  assert.equal(isLoadableBarbell(44), false);      // below the bar
  assert.equal(isLoadableBarbell(NaN), false);
});
