'use strict';

// ── Session_Plans idempotent append-only writer (Decision Desk #952, PR-B) ─────
//
// Persists the ACCEPTED/FINAL plan-state events built by services/sessionPlanEvents.js
// to the Session_Plans tab. Mirrors services/deloadState.js: system-state writes,
// NOT logged sets — no write_id, never through the preview→approve→write trust loop,
// never touches Log_Cleaned/Effort. Append-only: a prior event row is NEVER mutated.
//
// Optional tab (config/sheetContract.js): if the Session_Plans tab does not exist,
// the writer is a NO-OP and reports { tab_missing: true } so the caller can 503 —
// the tab is created by the owner (schema migration), never auto-created here.
//
// Idempotency (retry-safe): before appending, existing rows are read and each
// incoming event is matched by its deterministic idempotency_key. An exact retry
// (same key + same content) is SKIPPED — no duplicate row. A key that matches an
// existing row with DIFFERENT content is a REVISION COLLISION and fails closed
// (throws) rather than silently dedup-dropping a changed plan — the caller must
// bump plan_version (the reader folds per session_id + plan_version + plan_item_id).
//
// This slice is the writer + its guards only. The live capture wiring (calling
// these at the accepted-plan / session-closeout boundaries) lands with the reader
// (PR-C) so the whole data loop is wired and tested together; until then this module
// is staged in config/wiring-allowlist.json.

const sheets = require('../sheets');
const { sessionPlansColumns } = require('../config/columns');
const {
  buildPlanAcceptedEvents,
  buildItemOutcomeEvent,
  buildSessionCloseoutEvent,
} = require('./sessionPlanEvents');

const SESSION_PLANS_TAB = process.env.SESSION_PLANS_SHEET_NAME || 'Session_Plans';
const KEY_IDX = sessionPlansColumns.indexOf('idempotency_key');
// The columns that define an event's CONTENT — everything except recorded_at, which
// is provenance and may legitimately differ across a retry of the same logical event.
const CONTENT_COLS = sessionPlansColumns
  .map((c, i) => ({ c, i }))
  .filter(({ c }) => c !== 'recorded_at')
  .map(({ i }) => i);

function _nowIso() {
  return new Date().toISOString();
}

async function _tabExists() {
  try {
    const tabs = await sheets.getSpreadsheetTabs();
    return Array.isArray(tabs) && tabs.includes(SESSION_PLANS_TAB);
  } catch (_) {
    return false;
  }
}

// Read existing rows keyed by idempotency_key (data rows only; the header is stripped
// by sheets.getSheetRows). A read failure is treated as "no prior rows" — the append
// still guards within its own batch, and a genuinely missing tab was already gated.
async function _existingByKey() {
  const byKey = new Map();
  let rows;
  try {
    rows = await sheets.getSheetRows(SESSION_PLANS_TAB);
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

// Ensure a header row exists before the first data append, so sheets.getSheetRows
// (which strips row 0 as a header) never swallows the first persisted event.
async function _ensureHeaderRow() {
  let firstRow = [];
  try {
    const top = await sheets.readRange(`${SESSION_PLANS_TAB}!A1:A1`);
    firstRow = Array.isArray(top) ? top : [];
  } catch (_) {
    firstRow = [];
  }
  const hasHeader = firstRow.length > 0 && Array.isArray(firstRow[0]) && String(firstRow[0][0] || '').trim() !== '';
  if (!hasHeader) await sheets.appendRows(SESSION_PLANS_TAB, [[...sessionPlansColumns]]);
}

// Append event rows idempotently. Returns { written, skipped, tab_missing }.
async function _append(rows) {
  const out = { written: 0, skipped: 0, tab_missing: false };
  if (!rows.length) return out;
  if (!(await _tabExists())) { out.tab_missing = true; return out; }

  const existing = await _existingByKey();
  const seen = new Map(); // within-batch dedup / collision detection
  const toAppend = [];

  for (const row of rows) {
    const key = String(row[KEY_IDX] == null ? '' : row[KEY_IDX]).trim();
    const prior = existing.get(key) || seen.get(key);
    if (prior) {
      if (_contentEqual(prior, row)) { out.skipped += 1; continue; }
      throw new Error(
        `sessionPlanStore: revision collision on idempotency_key ${key} — a changed event for the same (session_id, plan_version, plan_item_id) must bump plan_version; Session_Plans is append-only and never mutates a prior event`
      );
    }
    seen.set(key, row);
    toAppend.push(row);
  }

  if (toAppend.length) {
    await _ensureHeaderRow();
    await sheets.appendRows(SESSION_PLANS_TAB, toAppend);
    out.written = toAppend.length;
  }
  return out;
}

// ── public API ────────────────────────────────────────────────────────────────

async function writePlanAccepted(session, items, opts = {}) {
  const recordedAt = opts.recordedAt || _nowIso();
  return _append(buildPlanAcceptedEvents(session, items, { ...opts, recordedAt }));
}

async function writeItemOutcome(session, item, opts = {}) {
  const recordedAt = opts.recordedAt || _nowIso();
  return _append([buildItemOutcomeEvent(session, item, { ...opts, recordedAt })]);
}

async function writeSessionCloseout(session, closeoutStatus, opts = {}) {
  const recordedAt = opts.recordedAt || _nowIso();
  return _append([buildSessionCloseoutEvent(session, closeoutStatus, { ...opts, recordedAt })]);
}

module.exports = {
  SESSION_PLANS_TAB,
  writePlanAccepted,
  writeItemOutcome,
  writeSessionCloseout,
};
