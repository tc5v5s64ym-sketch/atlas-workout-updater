'use strict';

// THE WRITE-RECEIPT AUTHORITY — `atlas.write_receipts`, in Supabase.
//
// AUTHORITY: OWNER INSTRUCTION 2026-08-07 (Supabase hot-path migration), ruling
// D4; design `docs/SUPABASE_HOT_PATH_MIGRATION.md` §3.6, §4.6, §5.4, §5.5.
//
// ── WHAT THIS REPLACED ───────────────────────────────────────────────────────
//
// `services/idempotency.js` kept the receipt set in a per-process `Map`, written
// through to `/tmp/atlas-idempotency.json`. Two properties of that store are the
// reason it could not survive the cutover:
//
//   - IT WAS PER PROCESS. Two instances decided duplicates against two different
//     record sets, so the same `write_id` could be claimed twice.
//   - ITS DURABILITY WAS BEST-EFFORT. A disk failure downgraded the store to
//     memory silently, and `/tmp` is not guaranteed across a Render restart, so
//     the duplicate shield could vanish without anything saying so.
//
// The table has neither property. It is one row per `write_id`, shared by every
// instance, and durable.
//
// ── WHAT IS PRESERVED EXACTLY ────────────────────────────────────────────────
//
// This module exists so the seven `beginWrite` callers keep the contract they
// already had. Each of these is a behaviour, not an implementation detail, and
// each is carried over unchanged:
//
//   CLAIM             — a fresh `write_id` is claimed and returns a token.
//   REPLAY            — a repeat of a COMPLETED `write_id` returns the stored
//                       response body rather than writing again.
//   LOST RESPONSE     — a retry of an in-flight or released `write_id` is
//                       answered from the receipt, never by a second write.
//   NO DUPLICATE      — a live attempt is refused while it is live.
//   TOKEN GUARD       — `completeWrite` and `failWrite` apply only to the attempt
//                       that owns the current token, so a superseded attempt's
//                       late completion is discarded rather than applied.
//   RETRYABLE FAILURE — a `failed` record is retryable; the `write_id` is not
//                       consumed by an attempt that never committed.
//
// ── WHAT CHANGED, AND WHY EACH CHANGE IS A STRENGTHENING ─────────────────────
//
//   ASYNC. Every operation is a database call, so every call site awaits. The
//   file store was synchronous only because it was a `Map`.
//
//   `session_id` IS A COLUMN, NOT FREE-FORM METADATA. The file store persisted an
//   arbitrary `metadata` object and WRITE-2 recovered the server-minted session id
//   out of it. The table gives that one fact its own column, written under the
//   token guard by a statement that refuses to overwrite a value already there
//   (§3.6). Nothing else in `metadata` was ever read back, so nothing else moved.
//
//   AN UNREADABLE AUTHORITY FAILS CLOSED. The file store could not be
//   "unavailable" — a `Map` always answers — so its callers had no such branch. A
//   database can be, and a write admitted without a receipt is a write with no
//   duplicate shield at all. `unavailable` is therefore a REFUSAL the caller must
//   surface, never a silent pass-through.
//
//   AMBIGUITY IS REPRESENTABLE. A prior process's Google Sheets append may have
//   landed after that process died. The file store could only call that a
//   duplicate; the table records it as `ambiguous`, which no retry and no timer
//   releases — only destination-side proof (§3.6). It reaches the caller through
//   the same duplicate branch, and it is a refusal there, which is correct.

// Carried verbatim from the retired file store. A `write_id` is whatever the
// client sent, trimmed; an empty one is absent rather than a claimable id. The
// rule is unchanged because changing it would reinterpret ids already in flight.
function normalizeWriteId(writeId) {
  if (writeId === undefined || writeId === null) return null;
  const normalized = String(writeId).trim();
  return normalized || null;
}

function adapterModule() {
  // Required lazily so a test can inject its own through require.cache, matching
  // the pattern every other Supabase seam in this repository uses.
  return require('./supabaseAdapter');
}

// The record shape the routes already consume. `response_body` is the column and
// `response` is what every duplicate branch reads, so the mapping happens once,
// here, rather than at seven call sites.
function toRecord(row) {
  if (!row) return null;
  return {
    write_id: row.write_id,
    route: row.route,
    status: row.status,
    session_id: row.session_id || null,
    attempt: row.attempt,
    response: row.response_body || null,
    rows_written: row.rows_written == null ? null : Number(row.rows_written),
    created_at: row.created_at,
    expires_at: row.expires_at,
    completed_at: row.completed_at || null,
    // Present only on a receipt whose external effect is unresolved. A caller may
    // report it; nothing may act on it without destination-side proof.
    ambiguous_at: row.ambiguous_at || null,
    ambiguity_proof: row.ambiguity_proof || null,
  };
}

// One structured warning per refused write. A receipt failure is an operator
// event: the athlete gets a clean refusal, and the reason must be recoverable
// from the log rather than inferred from a 503.
function warnUnavailable(route, writeId, error) {
  try {
    console.warn(JSON.stringify({
      level: 'warn',
      module: 'writeReceipts',
      event: 'receipt_authority_unavailable',
      route,
      write_id: writeId || null,
      error: error && error.message ? error.message : String(error),
    }));
  } catch {
    /* logging must never throw into the write path */
  }
}

/**
 * Claim a `write_id` for one route.
 *
 * @param {string} writeId
 * @param {object} metadata            `{ endpoint, session_id? }`. `endpoint` is
 *                                     the route, and it is REQUIRED: the claim is
 *                                     route-bound for its whole life (§3.6), and
 *                                     the effect authority is derived from it by a
 *                                     frozen map that fails closed on an unknown
 *                                     route.
 * @returns {Promise<object>}
 *   `{ enabled:false }`                       — no `write_id` supplied; the route
 *                                               proceeds without a receipt, exactly
 *                                               as it did before.
 *   `{ enabled:true, unavailable:true }`       — the authority could not be read or
 *                                               written. The caller MUST refuse.
 *   `{ enabled:true, duplicate:true, record }` — refused; replay or report.
 *   `{ enabled:true, duplicate:false, token }` — claimed; this attempt owns it.
 */
async function beginWrite(writeId, metadata = {}) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) return { enabled: false, write_id: null };

  const route = metadata && metadata.endpoint ? String(metadata.endpoint) : null;
  if (!route) {
    // A receipt with no route cannot be claimed at all: the state machine's
    // reclaim rule reads the route's effect authority, and guessing it would
    // decide retryability for an effect nobody declared.
    throw new Error('[write-receipts] beginWrite requires metadata.endpoint (the route)');
  }

  const adapter = adapterModule();
  let attempt;
  try {
    // ONE implementation of the claim decision, shared with the deterministic
    // state-machine proof (§6.1 P8). The callback returns the attempt itself: the
    // advisory lock inside serialises concurrent claimers of one id within a
    // process, which is throughput and not safety — the claim statement is atomic,
    // so a second claimer is refused by the row it finds, not by the lock.
    attempt = await adapter.withWriteAttempt(normalizedWriteId, route, async (a) => a);
  } catch (error) {
    warnUnavailable(route, normalizedWriteId, error);
    return { enabled: true, unavailable: true, write_id: normalizedWriteId, reason: 'receipt_authority_unreadable' };
  }

  if (attempt.duplicate) {
    return {
      enabled: true,
      duplicate: true,
      write_id: normalizedWriteId,
      record: toRecord(attempt.record),
      // A DIFFERENT route already owns this id. The stored record is deliberately
      // withheld by the adapter, so no caller can replay a foreign route's body as
      // if it were its own.
      route_conflict: attempt.routeConflict === true,
      // An unresolved external effect. Not retryable by anything but proof.
      ambiguous: attempt.ambiguous === true,
      reason: attempt.reason || (attempt.routeConflict ? 'route_conflict' : null),
    };
  }

  // The server-minted session id, stamped immediately after the claim and before
  // the workout write (§3.6). It is what a lost-response retry recovers, so a
  // retry reuses the identity instead of minting a second one.
  // ── AN UNSTAMPED RECEIPT IS NOT SAFE TO WRITE UNDER ──────────────────────
  //
  // This used to warn and proceed. That is wrong, and the failure it permits is the
  // exact one WRITE-2 exists to prevent.
  //
  // The sequence: the claim succeeds, the session stamp fails, the Save commits, and
  // the response is lost in flight. The athlete's client retries the SAME write_id.
  // `peekWrite` finds a receipt with a NULL session_id, so the route cannot recover
  // the identity the first attempt minted — it mints a FRESH one, and the whole
  // workout is written a second time under a second session. Both dedupes are scoped
  // to a session, so neither can see the duplicate.
  //
  // So the stamp is part of the claim, not an optimisation on top of it: if the
  // identity cannot be recorded, the receipt is RELEASED and the write is refused.
  // A refused write is a retry the athlete can make; a duplicated workout is not.
  //
  // `rowCount === 0` is a success, not a failure. The statement is `WHERE session_id
  // IS NULL`, so a retry of an already-stamped receipt matches nothing — and that
  // receipt already carries the identity this attempt would have written.
  const sessionId = metadata && metadata.session_id ? String(metadata.session_id).trim() : '';
  if (sessionId) {
    try {
      await adapter.persistReceiptSessionId(normalizedWriteId, attempt.attempt_token, sessionId);
    } catch (error) {
      warnUnavailable(route, normalizedWriteId, error);
      try {
        await adapter.failWriteReceipt(normalizedWriteId, attempt.attempt_token);
      } catch (releaseError) {
        // The release failed too. The receipt stays `in_progress`, which REFUSES the
        // retry rather than permitting a duplicate — the safe direction, and the
        // reclaim rule releases it once this process is genuinely gone.
        warnUnavailable(route, normalizedWriteId, releaseError);
      }
      return {
        enabled: true, unavailable: true, write_id: normalizedWriteId,
        reason: 'receipt_session_stamp_failed',
      };
    }
  }

  return {
    enabled: true,
    duplicate: false,
    write_id: normalizedWriteId,
    token: attempt.attempt_token,
    attempt: attempt.attempt,
    session_id: attempt.session_id || sessionId || null,
  };
}

/**
 * Stamp the server-minted session id onto a live attempt.
 *
 * Separate from `beginWrite` because `/api/complete-workout` mints its id from the
 * receipt itself — it must claim first to learn whether a prior attempt already
 * has one. The statement refuses to overwrite a value already present, so a
 * reused id is never rewritten and an obsolete attempt cannot clobber a newer
 * one's value.
 */
async function persistSessionId(writeId, token, sessionId) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId || !token || !sessionId) return false;
  try {
    return await adapterModule().persistReceiptSessionId(normalizedWriteId, token, String(sessionId).trim());
  } catch (error) {
    warnUnavailable(null, normalizedWriteId, error);
    return false;
  }
}

/**
 * Record the attempt as completed, with the response body a retry replays.
 *
 * NEVER THROWS. It is called after the athlete-facing effect has already
 * committed, so a failure here must not turn a successful write into an error
 * response. A lost completion leaves the receipt `in_progress`, which refuses a
 * retry rather than permitting a duplicate — the safe direction.
 */
async function completeWrite(writeId, token, response = {}, rowsWritten = null, appendedRange = null) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId || !token) return false;
  try {
    return await adapterModule().completeWriteReceipt(
      normalizedWriteId, token, response || {}, rowsWritten, appendedRange
    );
  } catch (error) {
    warnUnavailable(null, normalizedWriteId, error);
    return false;
  }
}

/**
 * Release an attempt that did NOT commit, and invalidate its token in the same
 * statement so a late completion cannot resurrect it.
 *
 * NEVER THROWS, for the mirror of the reason above: it runs on an error path, and
 * a failure here must not replace the real error the caller is reporting. A lost
 * release leaves the receipt `in_progress`, which refuses the retry until the
 * reclaim rule applies — again the safe direction.
 */
async function failWrite(writeId, token) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId || !token) return false;
  try {
    return await adapterModule().failWriteReceipt(normalizedWriteId, token);
  } catch (error) {
    warnUnavailable(null, normalizedWriteId, error);
    return false;
  }
}

/**
 * Read the current receipt without changing it. TTL-bounded — an expired row
 * reads as absent, exactly as the file store's did.
 *
 * WRITE-2's consumer: `/api/complete-workout` recovers the server-minted
 * `session_id` of a prior attempt from here, so a retry reuses that identity
 * rather than minting a fresh one that would slip past both dedupes and
 * double-write the whole workout (§6.3 P16b).
 *
 * Returns null only when the receipt is absent. An unreadable authority throws:
 * treating "could not check" as "no receipt" would let the caller mint a fresh
 * session identity on a lost-response retry and duplicate a committed workout.
 */
async function peekWrite(writeId) {
  const normalizedWriteId = normalizeWriteId(writeId);
  if (!normalizedWriteId) return null;
  return toRecord(await adapterModule().peekWriteReceipt(normalizedWriteId));
}

module.exports = {
  beginWrite,
  persistSessionId,
  completeWrite,
  failWrite,
  peekWrite,
  normalizeWriteId,
};
