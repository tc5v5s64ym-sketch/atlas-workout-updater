'use strict';

// ── Session_Plans capture layer (Decision Desk #952 → Option A, PR-E) ─────────
//
// The feature-flag gate + EXACT-HEADER validation + failure-isolated proof
// envelope over the existing idempotent writer (services/sessionPlanStore.js).
// This is the server half of the explicit live-capture lane (docs/
// SESSION_PLANS_CAPTURE_SPEC.md §4): the three route handlers call these
// functions; there is NO client wiring yet (PR-F).
//
// System-state SIDECAR — mirrors services/deloadState.js / the shadow lanes:
//   - Feature-flagged, DEFAULT OFF (`ATLAS_SESSION_PLANS_WRITE`, accepts 1/true/on).
//     OFF ⇒ NO Sheets access at all (no header read, no write) → { status:'disabled' }.
//   - Writes ONLY the optional Session_Plans tab — never Log_Cleaned/Effort, no
//     write_id, never the preview→approve→write trust loop.
//   - TOTAL: every function is wrapped so it can NEVER throw at a call site. A
//     failure returns a `captured:false` envelope, never a rejection — so a
//     Session_Plans problem is structurally incapable of corrupting, duplicating,
//     or blocking the main workout save (these endpoints are separate from
//     /api/log-workout).
//   - `captured:true` is emitted ONLY when an append actually succeeded, or an
//     idempotent skip collapsed an already-persisted event. Every other status
//     (`disabled` / `tab_missing` / `header_mismatch` / `error`) ⇒ `captured:false`,
//     so the client must NEVER claim "remembered/saved" on those.
//
// EXACT-HEADER validation (owner requirement): before any write, read row 1 of the
// tab and compare it POSITION-BY-POSITION to config/columns.js `sessionPlansColumns`.
// A CONFIRMED-absent tab ⇒ `tab_missing`; an UNREADABLE one ⇒ `error`; any positional
// difference ⇒ `header_mismatch`. Never guess column positions; a non-ok header
// disables the write and surfaces a clear diagnostic reason.

const sheets = require('../sheets');
const { sessionPlansColumns } = require('../config/columns');
const store = require('./sessionPlanStore');

const SESSION_PLANS_TAB = store.SESSION_PLANS_TAB; // 'Session_Plans' (env-overridable, shared with the writer)

// A1 column letter for the Nth (1-based) column — 13 columns ⇒ A..M.
function _colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}
const HEADER_RANGE = `${SESSION_PLANS_TAB}!A1:${_colLetter(sessionPlansColumns.length)}1`;

function isEnabled() {
  const v = process.env.ATLAS_SESSION_PLANS_WRITE;
  return v === '1' || v === 'true' || v === 'on';
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
  let rows;
  try {
    rows = await sheets.readRange(HEADER_RANGE);
  } catch (e) {
    // Ask the ONE read-failure authority. This used to report EVERY read failure as
    // `tab_missing`, which told the owner to run a schema migration when Google had
    // merely rate-limited us. `tab_missing` is a durable schema fact and is claimed
    // only when `confirmTabMissing` has independently established it — the metadata
    // read succeeded AND this tab is genuinely absent. A malformed range, an
    // unreadable spreadsheet, or any other failure is `error`: a non-capture outcome
    // either way, so the write never proceeds on a guess in either direction.
    return (await sheets.confirmTabMissing(e, SESSION_PLANS_TAB))
      ? { ok: false, status: 'tab_missing', reason: 'Session_Plans tab confirmed absent' }
      : { ok: false, status: 'error', reason: `Session_Plans header unreadable (${e.message})` };
  }
  const header = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
  if (header.length === 0) {
    return { ok: false, status: 'tab_missing', reason: 'Session_Plans tab has no header row' };
  }
  const exact = header.length === sessionPlansColumns.length
    && sessionPlansColumns.every((col, i) => String(header[i] == null ? '' : header[i]).trim() === col);
  if (!exact) {
    return { ok: false, status: 'header_mismatch', reason: 'Session_Plans header does not match the exact 13-column contract' };
  }
  return { ok: true };
}

// Shared: flag gate → header validation → writer, all failure-isolated. `writerFn`
// returns the store's { written, skipped, tab_missing } shape.
async function _capture(planVersion, writerFn) {
  if (!isEnabled()) return _envelope('disabled', false, { plan_version: planVersion });
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
    const reason = /revision collision/i.test(e.message || '') ? 'revision_collision' : (e.message || 'sidecar write failed');
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
  isEnabled,
  validateHeader,
  captureAccept,
  captureOutcome,
  captureCloseout,
};
