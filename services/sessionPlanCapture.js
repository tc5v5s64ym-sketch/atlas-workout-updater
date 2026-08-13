'use strict';

// ── Session_Plans capture layer (Decision Desk #952 → Option A, PR-E) ─────────
//
// Proof envelope over the idempotent Supabase writer
// (services/sessionPlanStore.js). The explicit lifecycle route handlers call these
// functions, and the main workout closeout verifies the same authority before it
// reports completion.
//
// System-state authority — mirrors services/deloadState.js:
//   - Writes the Supabase Session_Plans authority — never Log_Cleaned/Effort and
//     never the preview→approve→write trust loop.
//   - TOTAL: every function is wrapped so it can NEVER throw at a call site. A
//     failure returns a `captured:false` envelope, never an unclassified rejection.
//     Direct authoritative endpoints translate that envelope into a fail-closed
//     response; the main save verifies closeout before declaring completion.
//   - `captured:true` is emitted ONLY when an insert actually succeeded, or an
//     idempotent skip collapsed an already-persisted event. Every other status
//     (`disabled` / `tab_missing` / `header_mismatch` / `error`) ⇒ `captured:false`,
//     so the client must NEVER claim "remembered/saved" on those.
//
// The old exact-header probe is retained only as a compatibility function returning
// ok: the database migration and constraint proofs now own schema validation.

const store = require('./sessionPlanStore');

const SESSION_PLANS_TAB = store.SESSION_PLANS_TAB; // 'Session_Plans' (env-overridable, shared with the writer)

// A1 column letter for the Nth (1-based) column — 13 columns ⇒ A..M.
function _colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}


function _envelope(status, captured, extra = {}) {
  return {
    status,
    captured: captured === true,
    written: extra.written || 0,
    skipped: extra.skipped || 0,
    plan_version: extra.plan_version || null,
    reason: extra.reason || null,
  };
}

// Read row 1 and compare it to the contract, position by position. Returns
// { ok:true } or { ok:false, status:'tab_missing'|'header_mismatch'|'error', reason }.
async function validateHeader() {
  // ALWAYS OK — there is no Sheets header left to validate.
  //
  // This read row 1 of the `Session_Plans` tab and compared it to
  // `sessionPlansColumns` position by position, so a schema drift or a missing
  // tab refused the write instead of appending into the wrong columns. Both
  // failure modes were properties of a spreadsheet a human can edit.
  //
  // The S4 cutover moved this concept to a Supabase table whose columns the
  // migration fixed. A column cannot be renamed, reordered or removed at runtime,
  // and the table cannot be absent — so the probe has nothing left to detect, and
  // keeping it would mean a Google Sheets quota error could refuse a workout write
  // for a tab the write no longer touches.
  //
  // The FUNCTION survives because its callers branch on its verdict; only the
  // question it asks is gone. Genuine schema protection now lives where the schema
  // does: the migration, and the constraint tests in test-pg/constraints.pgproof.js.
  return { ok: true };
}

// Shared: schema posture → writer, all failure-isolated. `writerFn`
// returns the store's { written, skipped, tab_missing } shape.
async function _capture(planVersion, writerFn) {
  let hv;
  try {
    hv = await validateHeader();
  } catch (e) {
    return _envelope('error', false, { plan_version: planVersion, reason: `header validation failed (${e.message})` });
  }
  if (!hv.ok) return _envelope(hv.status, false, { plan_version: planVersion, reason: hv.reason });
  try {
    const r = await writerFn();
    if (r && r.tab_missing) return _envelope('tab_missing', false, { plan_version: planVersion, reason: 'Session_Plans tab missing at write time' });
    const written = (r && r.written) || 0;
    const skipped = (r && r.skipped) || 0;
    const captured = (written + skipped) > 0;
    return _envelope(written > 0 ? 'written' : 'skipped', captured, { plan_version: planVersion, written, skipped });
  } catch (e) {
    const reason = /revision collision/i.test(e.message || '') ? 'revision_collision' : (e.message || 'plan event write failed');
    return _envelope('error', false, { plan_version: planVersion, reason });
  }
}

// ── public API — one call per explicit lifecycle event (spec §4.1–4.3) ─────────

async function captureAccept(session, items) {
  return _capture(session && session.plan_version, () => store.writePlanAccepted(session, items));
}

async function captureOutcome(session, item) {
  return _capture(session && session.plan_version, () => store.writeItemOutcome(session, item));
}

async function captureCloseout(session, closeoutStatus) {
  return _capture(session && session.plan_version, () => store.writeSessionCloseout(session, closeoutStatus));
}

module.exports = {
  SESSION_PLANS_TAB,
  validateHeader,
  captureAccept,
  captureOutcome,
  captureCloseout,
};
