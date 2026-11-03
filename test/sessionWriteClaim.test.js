'use strict';

// #1629 — unit contract for services/sessionWriteClaim.js, the session-scoped
// claim around /api/log-workout's read-check-append. The route race test
// (test/concurrentDifferentIdSave.test.js) pins the end-to-end behavior;
// this file pins the module's own rules: one holder per session, token-gated
// release, waiter resolution, timeout, staleness, and reset.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireSessionClaim,
  releaseSessionClaim,
  waitForSessionClaim,
  resetSessionClaims,
  STALE_CLAIM_MS,
} = require('../services/sessionWriteClaim');

test.beforeEach(() => resetSessionClaims());
test.afterEach(() => resetSessionClaims());

test('first claim acquires; a second claim for the same session is refused with the holder wait', () => {
  const first = acquireSessionClaim('S1');
  assert.equal(first.acquired, true);
  assert.ok(first.token);
  const second = acquireSessionClaim('S1');
  assert.equal(second.acquired, false);
  assert.ok(second.wait instanceof Promise);
  // The wait must not resolve while the holder holds the claim.
  let resolved = false;
  second.wait.then(() => { resolved = true; });
  assert.equal(resolved, false);
  assert.equal(releaseSessionClaim('S1', first.token), true);
  return second.wait.then(() => {
    assert.equal(resolved, true);
    const third = acquireSessionClaim('S1');
    assert.equal(third.acquired, true);
  });
});

test('different sessions never block each other; keys normalize case and whitespace', () => {
  const a = acquireSessionClaim('  Session-A ');
  const b = acquireSessionClaim('session-b');
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true);
  const again = acquireSessionClaim('SESSION-a');
  assert.equal(again.acquired, false);
});

test('release requires the exact token; a wrong token or double release leaves the claim held', () => {
  const first = acquireSessionClaim('S2');
  assert.equal(releaseSessionClaim('S2', 'wrong-token'), false);
  assert.equal(acquireSessionClaim('S2').acquired, false);
  assert.equal(releaseSessionClaim('S2', first.token), true);
  assert.equal(releaseSessionClaim('S2', first.token), false);
  assert.equal(acquireSessionClaim('S2').acquired, true);
});

test('waitForSessionClaim resolves true on release and false on timeout', async () => {
  const first = acquireSessionClaim('S3');
  const second = acquireSessionClaim('S3');
  const released = waitForSessionClaim(second.wait, 5000);
  assert.equal(releaseSessionClaim('S3', first.token), true);
  assert.equal(await released, true);

  const third = acquireSessionClaim('S3');
  const fourth = acquireSessionClaim('S3');
  assert.equal(await waitForSessionClaim(fourth.wait, 20), false);
  assert.equal(releaseSessionClaim('S3', third.token), true);
});

test('a claim older than STALE_CLAIM_MS is evicted by the next acquirer', () => {
  const first = acquireSessionClaim('S4', { now: 1000 });
  assert.equal(first.acquired, true);
  // Within the window: still held.
  assert.equal(acquireSessionClaim('S4', { now: 1000 + STALE_CLAIM_MS - 1 }).acquired, false);
  // Past the window: evicted, and the stale holder's release is a no-op.
  const next = acquireSessionClaim('S4', { now: 1000 + STALE_CLAIM_MS + 1 });
  assert.equal(next.acquired, true);
  assert.equal(releaseSessionClaim('S4', first.token), false);
  assert.equal(releaseSessionClaim('S4', next.token), true);
});

test('reset clears all claims', () => {
  assert.equal(acquireSessionClaim('S5').acquired, true);
  resetSessionClaims();
  assert.equal(acquireSessionClaim('S5').acquired, true);
});

test('empty session ids never acquire', () => {
  assert.equal(acquireSessionClaim('').acquired, false);
  assert.equal(acquireSessionClaim(null).acquired, false);
  assert.equal(acquireSessionClaim(undefined).acquired, false);
});
