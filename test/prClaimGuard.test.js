'use strict';

// F09H / PR-CLAIM-1 — a self-reported "that was a PR" must never become durable memory
// (a coaching note / constraint). PR status is engine-owned (from logged rows), never a
// typed claim. This pins the deterministic classifier that gates note/constraint
// suppression; the route-level suppression + the no-note prompt guidance are proven in
// test/api-smoke.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikePrClaim } = require('../services/coach');

test('looksLikePrClaim: a self-reported PR/personal-best CLAIM is detected', () => {
  for (const m of [
    'That was a PR!',
    'I think that was a PR',
    'That felt like a PR',
    'that was a pr',
    "that's a new personal best",
    'new PR on bench',
    'I just PR\'d',
    'just PRd',
    'hit a PR today',
    'set a personal record',
    'that was a personal record',
    'PR today!',
  ]) {
    assert.equal(looksLikePrClaim(m), true, `PR claim: ${m}`);
  }
});

test('looksLikePrClaim: a training GOAL that mentions a PR is NOT a claim (stays note-eligible)', () => {
  for (const m of [
    'My goal is to PR bench by December',
    'I want a new PR next month',
    'aiming for a PR eventually',
    'working toward a personal best on squat',
  ]) {
    assert.equal(looksLikePrClaim(m), false, `goal, not a claim: ${m}`);
  }
});

test('looksLikePrClaim: ordinary messages are not PR claims', () => {
  for (const m of [
    'left shoulder impingement, avoid overhead pressing',
    'what should I do next?',
    'bench felt heavy today',
    'practice makes perfect',
    'log it',
    '',
    null,
    undefined,
  ]) {
    assert.equal(looksLikePrClaim(m), false, `not a PR claim: ${m}`);
  }
});
