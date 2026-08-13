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

const workoutAuthority = require('./workoutAuthority');
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

const SESSION_IDX = sessionPlansColumns.indexOf('session_id');

function _nowIso() {
  return new Date().toISOString();
}

// Index already-read rows by idempotency_key (data rows only; the header is stripped by
// the authority read). Pure — the read itself happens in `_append`.
// is also what proves the tab exists.
function _existingByKey(rows) {
  const byKey = new Map();
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

// Append event rows idempotently. Returns { written, skipped, tab_missing }.
//
// ── SUPABASE IS THE AUTHORITY (S4 cutover) ──────────────────────────────────
//
// Accepted plans, item outcomes and session closeout are three of the seven
// migrated concepts. They used to live in the `Session_Plans` tab, which forced
// three Google Sheets calls per append: a header probe, a whole-tab read to build
// the idempotency index, and the append itself.
//
// WHAT IS PRESERVED, EXACTLY:
//
//   - IDEMPOTENCY. `idempotency_key` is the primary key in Supabase, so a repeat
//     of the same event is skipped rather than duplicated — enforced by the
//     database instead of by a read-then-compare race.
//   - COLLISION DETECTION. A changed event under an existing key is still a
//     THROW, not a silent overwrite: `Session_Plans` was append-only and the
//     migrated concept keeps that contract. A revision must bump plan_version.
//   - FAIL CLOSED. A read or write failure still surfaces; nothing is inferred
//     from an outage.
//
// WHAT IS GONE: `tab_missing`. It was a VERIFIED_EMPTY_SEAL_REASON that existed
// because a Sheets tab can genuinely be absent, and proving absence needed its own
// metadata read. A Supabase table cannot be absent at runtime — the migration
// created it — so the field is reported `false` permanently rather than removed,
// because `services/turnWriteArtifact.js` still reads it.
async function _append(rows) {
  const out = { written: 0, skipped: 0, tab_missing: false };
  if (!rows.length) return out;

  // The existing events for the sessions this batch touches. Scoped by session,
  // because a table can be filtered and a tab could not — the old code read every
  // row in the tab to answer the same question.
  const sessionIds = [...new Set(rows.map((row) => String(row[SESSION_IDX] == null ? '' : row[SESSION_IDX]).trim()).filter(Boolean))];
  let rowsRead = [];
  for (const sessionId of sessionIds) {
    rowsRead = rowsRead.concat(await workoutAuthority.planEventRows({ sessionId }));
  }

  const existing = _existingByKey(rowsRead);
  const seen = new Map(); // within-batch dedup / collision detection
  const toAppend = [];

  for (const row of rows) {
    const key = String(row[KEY_IDX] == null ? '' : row[KEY_IDX]).trim();
    const prior = existing.get(key) || seen.get(key);
    if (prior) {
      if (_contentEqual(prior, row)) { out.skipped += 1; continue; }
      throw new Error(
        `sessionPlanStore: revision collision on idempotency_key ${key} — a changed event for the same (session_id, plan_version, plan_item_id) must bump plan_version; the plan event ledger is append-only and never mutates a prior event`
      );
    }
    seen.set(key, row);
    toAppend.push(row);
  }

  if (toAppend.length) {
    const result = await workoutAuthority.appendPlanEvents(toAppend);
    out.written = result.inserted;
    // A row the database refused as a duplicate is a SKIP, not a silent loss: the
    // key already carried identical content, which is the same verdict the
    // read-then-compare above reaches one layer up.
    out.skipped += result.skipped;
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
