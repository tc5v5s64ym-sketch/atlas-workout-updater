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

test('a write evicts every entry older than the window (the map stays bounded)', () => {
  // Three distinct session keys recorded at t=1000.
  referent.recordDiscussedLift('a', 'BENCHPRESS', { nowMs: 1000 });
  referent.recordDiscussedLift('b', 'SEATEDROW', { nowMs: 1000 });
  referent.recordDiscussedLift('c', 'BACKSQUAT', { nowMs: 1000 });
  assert.equal(referent._sizeForTesting(), 3);
  // A later write past the window sweeps the three now-stale entries.
  referent.recordDiscussedLift('d', 'DEADLIFT', { nowMs: 1000 + referent.DEFAULT_MAX_AGE_MS + 1 });
  assert.equal(referent._sizeForTesting(), 1, 'only the fresh entry remains');
  assert.equal(referent.readFreshDiscussedLift('d', { nowMs: 1000 + referent.DEFAULT_MAX_AGE_MS + 1 }), 'DEADLIFT');
});

test('a stale read removes the entry (reads also bound the map)', () => {
  referent.recordDiscussedLift('s1', 'BENCHPRESS', { nowMs: 1000 });
  assert.equal(referent._sizeForTesting(), 1);
  assert.equal(referent.readFreshDiscussedLift('s1', { nowMs: 1000 + referent.DEFAULT_MAX_AGE_MS + 1 }), null);
  assert.equal(referent._sizeForTesting(), 0, 'the stale entry was evicted on read');
});

test('the map never exceeds the hard size cap under sustained distinct-key traffic', () => {
  // All within the freshness window so eviction-by-age does not apply — only the cap can
  // bound the map. Record well past MAX_ENTRIES distinct keys.
  for (let i = 0; i < referent.MAX_ENTRIES + 250; i += 1) {
    referent.recordDiscussedLift(`plan:${i}`, 'BENCHPRESS', { nowMs: 1000 + i });
  }
  assert.ok(referent._sizeForTesting() <= referent.MAX_ENTRIES, `size ${referent._sizeForTesting()} must be ≤ ${referent.MAX_ENTRIES}`);
  // The most recent key survives; the oldest was evicted.
  assert.equal(referent.readFreshDiscussedLift(`plan:${referent.MAX_ENTRIES + 249}`, { nowMs: 1000 + referent.MAX_ENTRIES + 249 }), 'BENCHPRESS');
  assert.equal(referent.readFreshDiscussedLift('plan:0', { nowMs: 1000 + referent.MAX_ENTRIES + 249 }), null);
});
