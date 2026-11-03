'use strict';

// #1629 — a session-scoped uniqueness claim for /api/log-workout's
// read-check-append sequence.
//
// The write_id idempotency store (services/idempotency.js) admits one record
// per write_id, so two overlapping saves carrying DIFFERENT write_ids are
// both admitted and both run the read-check-append: both read the sheet
// before either appends, both see no rows, both append — 4 Log rows for 2
// intended. This module closes exactly that window, in-process, with no
// schema change and no new durable state:
//
//   · acquireSessionClaim(sessionKey) is SYNCHRONOUS check-and-set. The
//     server is a single Node process (Procfile `web: npm start`, one
//     app.listen, no cluster), so a synchronous claim with no await between
//     check and set is atomic for the overlapping window. A second claim
//     for the same session while one is held is refused, not queued.
//   · The refused caller WAITS on the holder's completion promise (bounded
//     by SESSION_CLAIM_WAIT_MS), then re-acquires and re-runs the guarded
//     section from its normal reads. The re-read then sees the winner's
//     rows, so the loser lands on the route's existing truthful verdict
//     (all_rows_duplicate) instead of appending a second copy — and a
//     genuinely different second workout for the same session still appends
//     its new rows, serialized, because the row partition filters exact
//     duplicates only.
//   · Release is explicit at every exit of the guarded section, next to the
//     existing completeWrite/failWrite call. Two backstops bound a missed
//     release: a waiter times out to 409 in-progress (the old behavior),
//     and a claim older than STALE_CLAIM_MS is evicted by the next
//     acquirer, so a wedged claim cannot block a session forever.
//   · The claim is session-scoped, not global and not content-scoped:
//     different sessions never block each other, and the row-level
//     partition — not the claim — decides which rows are duplicates.
//
// Deliberate boundary: this serializes /api/log-workout only. Other routes
// that append to the same tabs (e.g. /api/complete-workout) are out of
// #1629's scope; a cross-route claim is a larger design question, not a
// bounded fix. Likewise, if the deployment ever scales past one web
// process, an in-process claim no longer serializes across instances —
// that is the durable operation-receipt schema decision, which stays
// Dale's call and is NOT taken here.

const SESSION_CLAIM_WAIT_MS = 30000;
const STALE_CLAIM_MS = 120000;

// sessionKey (lowercased session_id) -> { token, createdAtMs, resolve }
const claims = new Map();

function normalizeSessionKey(sessionId) {
  if (sessionId === undefined || sessionId === null) return '';
  return String(sessionId).trim().toLowerCase();
}

function acquireSessionClaim(sessionId, options = {}) {
  const key = normalizeSessionKey(sessionId);
  if (!key) return { acquired: false, token: null, wait: null };
  const now = options.now || Date.now();
  const existing = claims.get(key);
  if (existing) {
    if (now - existing.createdAtMs > STALE_CLAIM_MS) {
      // Wedge-breaker only: a legitimate hold is Sheets I/O measured in
      // seconds, never minutes. The stale holder's later release is a
      // no-op (token mismatch), and any waiter on the stale claim has
      // already timed out to 409 — eviction is silent by design.
      claims.delete(key);
    } else {
      return { acquired: false, token: null, wait: existing.done };
    }
  }
  const token = `${key}:${now}:${Math.random().toString(36).slice(2)}`;
  let resolve;
  const done = new Promise(r => { resolve = r; });
  claims.set(key, { token, createdAtMs: now, done, resolve });
  return { acquired: true, token, wait: null };
}

function releaseSessionClaim(sessionId, token) {
  const key = normalizeSessionKey(sessionId);
  if (!key || !token) return false;
  const existing = claims.get(key);
  if (!existing || existing.token !== token) return false;
  claims.delete(key);
  existing.resolve();
  return true;
}

// Resolves true when the holder releases, false on timeout. A timed-out
// waiter holds no claim, so the caller just answers 409 and releases its
// own write_id record — never appends on a timeout.
function waitForSessionClaim(waitPromise, timeoutMs = SESSION_CLAIM_WAIT_MS) {
  if (!waitPromise) return Promise.resolve(false);
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([
    waitPromise.then(() => true),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function resetSessionClaims() {
  for (const claim of claims.values()) {
    try { claim.resolve(); } catch (_) { /* best-effort */ }
  }
  claims.clear();
}

module.exports = {
  acquireSessionClaim,
  releaseSessionClaim,
  waitForSessionClaim,
  resetSessionClaims,
  normalizeSessionKey,
  SESSION_CLAIM_WAIT_MS,
  STALE_CLAIM_MS,
};
