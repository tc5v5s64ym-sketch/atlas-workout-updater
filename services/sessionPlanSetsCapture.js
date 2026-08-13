'use strict';

// ── Session_Plan_Sets capture layer (F10B) ────────────────────────────────────
//
// The proof envelope over the idempotent Supabase checkpoint writer
// (services/sessionPlanSetsStore.js). It mirrors
// services/sessionPlanCapture.js (the Session_Plans lane) so the ledger's
// creation-time checkpoint (design amendment A2 — durable at creation, session state
// is a cache) is captured the moment a plan is accepted or an explicit revision is
// issued, without allowing a partial or unconfirmed ledger write to be reported as
// authoritative.
//
// System-state authority — never the preview→approve→write trust loop and no log
// write_id. S4 writes every real checkpoint to Supabase; only an explicit test-mode
// call is dry-run.
//
// TOTAL envelope isolation: every function is wrapped so it can NEVER throw at a call
// site — a failure returns a `captured:false` envelope. Direct authoritative routes
// translate that envelope into a fail-closed response. `captured`
// is true ONLY when a live append actually persisted (or an idempotent skip collapsed
// an already-persisted row); a dry-run is `captured:false` (nothing durable yet).

const store = require('./sessionPlanSetsStore');

const SESSION_PLAN_SETS_TAB = store.SESSION_PLAN_SETS_TAB;

function _colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}


function _envelope(status, captured, extra = {}) {
  return {
    status,
    captured: captured === true,
    dry_run: extra.dry_run === true,
    written: extra.written || 0,
    skipped: extra.skipped || 0,
    range: extra.range || null,
    reason: extra.reason || null,
  };
}

// Read row 1 and compare it to the contract, position by position (owner requirement,
// mirrors sessionPlanCapture.validateHeader). Only consulted on the LIVE path.
async function validateHeader() {
  // ALWAYS OK — there is no Sheets header left to validate.
  //
  // This read row 1 of the `Session_Plan_Sets` tab and compared it to
  // `sessionPlanSetsColumns` position by position, so a schema drift or a missing
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

// Shared: run the store checkpoint and translate its result into a capture envelope.
// An explicit test-mode call is captured:false / dry_run:true because nothing durable
// is claimed. A live call claims capture only for a confirmed Supabase write or an
// idempotent skip whose row is already durable.
async function _capture(writerFn) {
  let hv;
  try { hv = await validateHeader(); } catch (e) { return _envelope('error', false, { reason: `header validation failed (${e.message})` }); }
  if (!hv.ok) return _envelope(hv.status, false, { reason: hv.reason });
  try {
    const r = await writerFn();
    if (r && r.tab_missing) return _envelope('tab_missing', false, { reason: 'Session_Plan_Sets tab missing at write time' });
    const written = (r && r.written) || 0;
    const skipped = (r && r.skipped) || 0;
    if (written > 0) {
      // A live write is `captured` ONLY with AUTHORITATIVE proof: the store confirmed
      // the write AND the confirmed row count equals what we asked to append. A short
      // or unconfirmed write fails closed as `unconfirmed` (captured:false) — never a
      // false 'written' that lets a caller believe the durable ledger exists when the
      // authority did not confirm it.
      //
      // THE A1 RANGE LEFT THE PREDICATE, and dropping it is not a weakening. It
      // proved WHERE Google put the rows, never that they were the right rows, and
      // the S4 cutover writes them to `atlas.session_plan_set_recommendations`, where
      // there is no range to produce. Requiring one would fail EVERY live checkpoint.
      // The row count is the same assertion it always was and now comes from the
      // transaction that performed the write.
      const confirmed = r && r.sheet_written === true && Number(r.rows_written) === written;
      if (!confirmed) {
        return _envelope('unconfirmed', false, { written, skipped, reason: 'write not confirmed by the ledger authority (row-count mismatch)' });
      }
      return _envelope('written', true, { written, skipped });
    }
    // A pure idempotent skip is already durable (the row exists) → captured.
    if (skipped > 0) return _envelope('skipped', true, { skipped });
    return _envelope('noop', false, { reason: 'nothing to checkpoint' });
  } catch (e) {
    const reason = /revision collision/i.test(e.message || '') ? 'revision_collision' : (e.message || 'plan-set checkpoint failed');
    return _envelope('error', false, { reason });
  }
}

// ── public API — one call per creation-time checkpoint (design §8 F10B) ─────────

// Checkpoint the accepted plan (ledger v1) at acceptance.
async function captureAcceptedPlan(session, items) {
  return _capture(() => store.checkpointAcceptedPlan(session, items));
}

// Checkpoint one EXPLICIT future-set revision at the moment Atlas issues it.
async function captureRevision(session, revision) {
  return _capture(() => store.checkpointRevision(session, revision));
}

// Checkpoint the IMPLICIT recommendation(s) for unannounced exercises (F10C) at the
// moment the athlete logs an unplanned exercise. A no_reliable_target derivation yields
// no row (nothing durable) — a dry-run noop, never a fabricated recommendation.
async function captureImplicit(session, items) {
  return _capture(() => store.checkpointImplicit(session, items));
}

module.exports = {
  SESSION_PLAN_SETS_TAB,
  validateHeader,
  captureAcceptedPlan,
  captureRevision,
  captureImplicit,
};
