'use strict';

// ── Session_Plan_Sets capture layer (F10B) ────────────────────────────────────
//
// The failure-isolated envelope + exact-header validation over the F10A idempotent
// checkpoint writer (services/sessionPlanSetsStore.js). Exactly mirrors
// services/sessionPlanCapture.js (the Session_Plans lane) so the ledger's
// creation-time checkpoint (design amendment A2 — durable at creation, session state
// is a cache) is captured the moment a plan is accepted or an explicit revision is
// issued, without ever being able to corrupt/duplicate/block the workout.
//
// System-state SIDECAR — never the preview→approve→write trust loop, no log write_id,
// writes ONLY the optional Session_Plan_Sets tab. DRY-RUN in F10B/F10C: the store is
// gated behind SESSION_PLAN_SETS_WRITE_ENABLED (off), so every capture returns the
// no-write proof and touches no sheet; the production tab + live-write flag are the
// owner-reserved F10D gate.
//
// TOTAL failure isolation: every function is wrapped so it can NEVER throw at a call
// site — a failure returns a `captured:false` envelope, never a rejection. `captured`
// is true ONLY when a live append actually persisted (or an idempotent skip collapsed
// an already-persisted row); a dry-run is `captured:false` (nothing durable yet).

const sheets = require('../sheets');
const { sessionPlanSetsColumns } = require('../config/columns');
const store = require('./sessionPlanSetsStore');

const SESSION_PLAN_SETS_TAB = store.SESSION_PLAN_SETS_TAB;

function _colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}
const HEADER_RANGE = `${SESSION_PLAN_SETS_TAB}!A1:${_colLetter(sessionPlanSetsColumns.length)}1`;

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
  let rows;
  try {
    rows = await sheets.readRange(HEADER_RANGE);
  } catch (e) {
    return { ok: false, status: 'tab_missing', reason: `Session_Plan_Sets header unreadable (${e.message})` };
  }
  const header = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
  if (header.length === 0) return { ok: false, status: 'tab_missing', reason: 'Session_Plan_Sets tab has no header row' };
  const exact = header.length === sessionPlanSetsColumns.length
    && sessionPlanSetsColumns.every((col, i) => String(header[i] == null ? '' : header[i]).trim() === col);
  if (!exact) return { ok: false, status: 'header_mismatch', reason: 'Session_Plan_Sets header does not match the exact 16-column contract' };
  return { ok: true };
}

// Shared: run the store checkpoint, failure-isolated, and translate its result into a
// capture envelope. In DRY-RUN (the F10B default) the store never touches the sheet,
// so header validation is skipped and the envelope is captured:false / dry_run:true —
// nothing durable is claimed. On the LIVE path (F10D), validate the exact header
// before trusting the write, and only claim captured on a real append/idempotent-skip.
async function _capture(writerFn) {
  if (!store.LIVE_WRITE_ENABLED) {
    let r;
    try { r = await writerFn(); } catch (e) { return _envelope('error', false, { reason: e.message || 'checkpoint build failed' }); }
    return _envelope('dry_run', false, { dry_run: true, reason: r && r.reason });
  }
  let hv;
  try { hv = await validateHeader(); } catch (e) { return _envelope('error', false, { reason: `header validation failed (${e.message})` }); }
  if (!hv.ok) return _envelope(hv.status, false, { reason: hv.reason });
  try {
    const r = await writerFn();
    if (r && r.tab_missing) return _envelope('tab_missing', false, { reason: 'Session_Plan_Sets tab missing at write time' });
    const written = (r && r.written) || 0;
    const skipped = (r && r.skipped) || 0;
    if (written > 0) {
      // A live append is `captured` ONLY with AUTHORITATIVE Google proof: the store
      // confirmed the write AND returned an A1 range AND the confirmed row count
      // equals what we asked to append. A malformed / short / range-less append fails
      // closed as `unconfirmed` (captured:false) — never a false 'written' that lets a
      // caller believe the durable ledger exists when Sheets did not confirm it
      // (write-safety; CLAUDE.md live-write proof requires positive range/row evidence).
      const confirmed = r && r.sheet_written === true && !!r.range && Number(r.rows_written) === written;
      if (!confirmed) {
        return _envelope('unconfirmed', false, { written, skipped, range: r && r.range, reason: 'append not confirmed by Sheets (missing range or row-count mismatch)' });
      }
      return _envelope('written', true, { written, skipped, range: r.range });
    }
    // A pure idempotent skip is already durable (the row exists) → captured.
    if (skipped > 0) return _envelope('skipped', true, { skipped });
    return _envelope('noop', false, { reason: 'nothing to checkpoint' });
  } catch (e) {
    const reason = /revision collision/i.test(e.message || '') ? 'revision_collision' : (e.message || 'sidecar checkpoint failed');
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
