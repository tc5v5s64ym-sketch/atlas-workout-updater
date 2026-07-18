'use strict';

// ── Session_Plan_Sets idempotent creation-time checkpoint (F10A, dry-run) ──────
//
// The durable checkpoint path for the set-level recommendation ledger
// (docs/SESSION_PLANS_LEDGER_DESIGN.md, amendment 2: "durable idempotent checkpoint
// at CREATION — session state alone is insufficient"). Each accepted plan (v1) and
// each explicit revision is checkpointed the moment it is created, via a NON-BLOCKING,
// idempotent sidecar append — the exact pattern services/sessionPlanStore.js uses for
// Session_Plans. Mirrors that writer: system-state, NOT logged sets — no log write_id,
// never through preview→approve→write, never touches Log_Cleaned/Effort. Append-only:
// a prior recommendation row is NEVER mutated (a revision appends a new version).
//
// SAFETY — this whole path is DRY-RUN in F10A/F10B/F10C. Live writes are gated behind
// SESSION_PLAN_SETS_WRITE_ENABLED (default OFF); flipping it, and creating the
// production Session_Plan_Sets tab, is the single OWNER-RESERVED action at F10D. Until
// then every checkpoint returns the dry-run proof (sheet_written:false,
// no_write_confirmed:true) and writes nothing. Even with live writes enabled, a
// missing tab is a no-op that reports tab_missing so the caller can 503 — the tab is
// created by the owner, never here.
//
// Staged/unwired in F10A (config/wiring-allowlist.json): F10B wires it to the
// acceptance/revision boundaries, F10D enables live writes.

const sheets = require('../sheets');
const { sessionPlanSetsColumns } = require('../config/columns');
const { buildAcceptedRows, buildRevisionRow } = require('./sessionPlanLedger');

const SESSION_PLAN_SETS_TAB = process.env.SESSION_PLAN_SETS_SHEET_NAME || 'Session_Plan_Sets';
// OWNER-RESERVED live-write gate (F10D). Default OFF → every checkpoint is a dry-run.
const LIVE_WRITE_ENABLED = process.env.SESSION_PLAN_SETS_WRITE_ENABLED === '1';
const KEY_IDX = sessionPlanSetsColumns.indexOf('idempotency_key');
// Content columns (everything except recorded_at, which may differ across a retry).
const CONTENT_COLS = sessionPlanSetsColumns
  .map((c, i) => ({ c, i }))
  .filter(({ c }) => c !== 'recorded_at')
  .map(({ i }) => i);

function _nowIso() { return new Date().toISOString(); }

// The dry-run proof (Invariants W1–W3 / CLAUDE.md): sheet_written:false +
// no_write_confirmed:true, plus what WOULD have been written for observability.
function _dryRunResult(rows, reason) {
  return {
    sheet_written: false,
    no_write_confirmed: true,
    dry_run: true,
    reason,
    would_write: rows.length,
    rows,
  };
}

async function _tabExists() {
  try {
    const tabs = await sheets.getSpreadsheetTabs();
    return Array.isArray(tabs) && tabs.includes(SESSION_PLAN_SETS_TAB);
  } catch (_) {
    return false;
  }
}

async function _existingByKey() {
  const byKey = new Map();
  let rows;
  try {
    rows = await sheets.getSheetRows(SESSION_PLAN_SETS_TAB);
  } catch (_) {
    return byKey;
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const arr = Array.isArray(row) ? row : [];
    const key = String(arr[KEY_IDX] == null ? '' : arr[KEY_IDX]).trim();
    if (key) byKey.set(key, arr);
  }
  return byKey;
}

function _contentEqual(a, b) {
  return CONTENT_COLS.every(i => String(a[i] == null ? '' : a[i]) === String(b[i] == null ? '' : b[i]));
}

async function _ensureHeaderRow() {
  let firstRow = [];
  try {
    const top = await sheets.readRange(`${SESSION_PLAN_SETS_TAB}!A1:A1`);
    firstRow = Array.isArray(top) ? top : [];
  } catch (_) {
    firstRow = [];
  }
  const hasHeader = firstRow.length > 0 && Array.isArray(firstRow[0]) && String(firstRow[0][0] || '').trim() !== '';
  if (!hasHeader) await sheets.appendRows(SESSION_PLAN_SETS_TAB, [[...sessionPlanSetsColumns]]);
}

// Append checkpoint rows. DRY-RUN unless live writes are owner-enabled (F10D) — a
// dry-run never touches the sheet and returns the W1–W3 proof. Live: idempotent
// append (exact-retry rows are skipped; a same-key row with DIFFERENT content is an
// append-only violation and fails closed — a revision must bump plan_version).
async function _append(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // Explicit dry-run OR the owner gate is closed (F10A/B/C default) → never write.
  if (opts.test_mode === true || !LIVE_WRITE_ENABLED) {
    return _dryRunResult(list, opts.test_mode === true ? 'test_mode' : 'write_disabled');
  }
  if (!list.length) {
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped: 0, tab_missing: false, reason: 'empty' };
  }
  if (!(await _tabExists())) {
    // Live enabled but the owner has not created the tab yet → 503-style no-op.
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped: 0, tab_missing: true, reason: 'tab_missing' };
  }

  const existing = await _existingByKey();
  const seen = new Map();
  const toAppend = [];
  for (const row of list) {
    const key = String(row[KEY_IDX] == null ? '' : row[KEY_IDX]).trim();
    const prior = existing.get(key) || seen.get(key);
    if (prior) {
      if (_contentEqual(prior, row)) continue; // exact retry → skip (idempotent)
      throw new Error(
        `sessionPlanSetsStore: revision collision on idempotency_key ${key} — a changed recommendation for the same (session_id, plan_version, plan_item_id, set_index) must bump plan_version; Session_Plan_Sets is append-only and never mutates a prior row`
      );
    }
    seen.set(key, row);
    toAppend.push(row);
  }

  const skipped = list.length - toAppend.length;
  if (!toAppend.length) {
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped, tab_missing: false, reason: 'all_idempotent_skips' };
  }
  await _ensureHeaderRow();
  // sheets.appendRows returns the raw Google API response — the AUTHORITATIVE write
  // proof is response.data.updates.{updatedRange,updatedRows}, exactly as the
  // Log_Cleaned/Effort write path extracts it (index.js). Never return the raw object
  // as `range` (it is not the A1 proof the F10D closeout seal needs).
  const response = await sheets.appendRows(SESSION_PLAN_SETS_TAB, toAppend);
  const updates = response && response.data && response.data.updates ? response.data.updates : null;
  return {
    sheet_written: true,
    no_write_confirmed: false,
    written: toAppend.length,
    skipped,
    tab_missing: false,
    range: updates ? (updates.updatedRange || null) : null,
    rows_written: updates ? Number(updates.updatedRows || 0) : null,
  };
}

// ── public API — creation-time checkpoints ──────────────────────────────────────

// Checkpoint the accepted plan (ledger v1). Non-blocking sidecar; dry-run in F10A.
async function checkpointAcceptedPlan(session, items, opts = {}) {
  const recordedAt = opts.recordedAt || _nowIso();
  return _append(buildAcceptedRows(session, items, { ...opts, recordedAt }), opts);
}

// Checkpoint one EXPLICIT revision row (a future-set-only Atlas recommendation).
async function checkpointRevision(session, revision, opts = {}) {
  const recordedAt = opts.recordedAt || _nowIso();
  return _append([buildRevisionRow(session, revision, { ...opts, recordedAt })], opts);
}

module.exports = {
  SESSION_PLAN_SETS_TAB,
  LIVE_WRITE_ENABLED,
  checkpointAcceptedPlan,
  checkpointRevision,
};
