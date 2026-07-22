'use strict';

// Server-side discussion-referent store (services/coachDiscussionReferent) — the interim
// tier-2 backing for the disputed-lift resolver. Ephemeral, per-session, freshness-bounded.

const test = require('node:test');
const assert = require('node:assert/strict');
const referent = require('../services/coachDiscussionReferent');

test.beforeEach(() => referent._resetForTesting());

test('records and reads back a fresh referent for the same session', () => {
  referent.recordDiscussedLift('s1', 'BENCHPRESS', { turnId: 't1', nowMs: 1000 });
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: 1000 + 60_000 }), 'BENCHPRESS');
});

test('a stale record (past the freshness window) reads back null', () => {
  referent.recordDiscussedLift('s1', 'BENCHPRESS', { nowMs: 1000 });
  const justInside = 1000 + referent.DEFAULT_MAX_AGE_MS;
  const justOutside = 1000 + referent.DEFAULT_MAX_AGE_MS + 1;
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: justInside }), 'BENCHPRESS', 'at the boundary it is still fresh');
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: justOutside }), null, 'one ms past the window it is stale');
});

test('a custom maxAgeMs tightens the freshness window', () => {
  referent.recordDiscussedLift('s1', 'BENCHPRESS', { nowMs: 1000 });
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: 1000 + 5000, maxAgeMs: 4000 }), null);
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: 1000 + 3000, maxAgeMs: 4000 }), 'BENCHPRESS');
});

test('the referent is scoped per session — another session never sees it', () => {
  referent.recordDiscussedLift('s1', 'BENCHPRESS', { nowMs: 1000 });
  assert.equal(referent.readFreshDiscussedLift('s2', { nowMs: 1000 }), null);
});

test('recording overwrites — the store always holds the MOST RECENT referent', () => {
  referent.recordDiscussedLift('s1', 'BENCHPRESS', { turnId: 't1', nowMs: 1000 });
  referent.recordDiscussedLift('s1', 'SEATEDROW', { turnId: 't2', nowMs: 2000 });
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: 2000 }), 'SEATEDROW');
  const rec = referent.peekRecord('s1');
  assert.equal(rec.canonicalKey, 'SEATEDROW');
  assert.equal(rec.turnId, 't2');
  assert.equal(rec.atMs, 2000);
});

test('missing session id or key is a no-op; reads on absent sessions return null', () => {
  referent.recordDiscussedLift('', 'BENCHPRESS', { nowMs: 1000 });
  referent.recordDiscussedLift('s1', '', { nowMs: 1000 });
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: 1000 }), null);
  assert.equal(referent.readFreshDiscussedLift('', { nowMs: 1000 }), null);
  assert.equal(referent.peekRecord('nope'), null);
});
