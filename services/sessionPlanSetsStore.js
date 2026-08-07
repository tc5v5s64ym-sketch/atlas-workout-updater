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
const { buildAcceptedRows, buildImplicitRows, buildRevisionRow, parseRow, validateChain } = require('./sessionPlanLedger');

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

// Pure: the read now happens in `_readLedger`, because that read also proves presence.
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
  // Presence is proven by the read this append already needs (see `_readLedger`), not by
  // a separate metadata probe. `null` means unreadable, which is NOT absence: the previous
  // `_tabExists()` swallowed every failure into `false` and so reported a momentary outage
  // as "the owner has not created the tab yet". It now fails closed with its own reason.
  const ledger = await _readLedger();
  if (ledger === null) {
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped: 0, tab_missing: false, reason: 'ledger_read_failed' };
  }
  if (!ledger.present) {
    // Live enabled but the owner has not created the tab yet → 503-style no-op.
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped: 0, tab_missing: true, reason: 'tab_missing' };
  }

  const existing = _existingByKey(ledger.rows);
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

// Checkpoint the IMPLICIT recommendation(s) for unannounced exercises (F10C). A
// no_reliable_target item builds NO row (buildImplicitRows, §4A rule 5), so an
// all-unreliable batch is an empty (nothing-to-write) dry-run. Non-blocking; dry-run.
async function checkpointImplicit(session, items, opts = {}) {
  const recordedAt = opts.recordedAt || _nowIso();
  return _append(buildImplicitRows(session, items, { ...opts, recordedAt }), opts);
}

// ── F10D — the closeout SEAL ────────────────────────────────────────────────────
//
// Stamps the owner-approved closeout's SHARED write_id into the blank
// closeout_write_id cell of every one of this session's ledger rows (design §2
// col 15). The seal is NOT the ledger's first persistence (amendment A2) — rows
// were durably checkpointed at creation; the seal only BINDS them to the finalized
// session. Append-only discipline holds: the update touches exactly the one blank
// closeout_write_id cell per row, never row content, never another column.
//
// Fail-closed rules (owner directive, 2026-07-18):
//   - a row already sealed by a DIFFERENT closeout_write_id → conflicting_seal,
//     nothing stamped (never re-seal);
//   - malformed revision history (duplicate/fork/gap/dangling/cross-ref) →
//     malformed_chain with diagnostics, nothing stamped (no partial seal);
//   - an updated-cell count that disagrees with the intended count →
//     seal_proof_mismatch (never a false verified seal);
//   - a retry with the SAME closeout_write_id is idempotent (already-stamped rows
//     skip; sealed_ok stays true).
// Dry-run (flag off / test_mode) READS the ledger to report what it WOULD seal but
// writes nothing and returns the W1–W3 proof.

const SID_IDX = sessionPlanSetsColumns.indexOf('session_id');
const SEAL_IDX = sessionPlanSetsColumns.indexOf('closeout_write_id');
function _colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}
const SEAL_COL_LETTER = _colLetter(SEAL_IDX + 1);

// Read one session's raw ledger rows (for the F10D closeout summary). Returns []
// when the tab is missing or the session has none (a legacy / pre-enablement
// session), and null on a READ FAILURE — the caller must surface the difference
// honestly (an unreadable ledger is never presented as "no stored plan").
// Probe the tab list, distinguishing CONFIRMED-ABSENT from UNREADABLE (Codex P1,
// PR #1068): a metadata outage must never be collapsed into "the tab doesn't
// exist" — the seal fails closed on it, and the summary flags it.
//   → { present: boolean }  when the metadata call succeeded
//   → null                  when the metadata call itself failed
// Read the ledger rows AND report which of the three outcomes occurred, in ONE metered
// request instead of two.
//
// This used to be a `spreadsheets.get` probe followed by the rows read — two requests to
// answer one question, on every ledger operation. A SUCCESSFUL rows read is strictly
// better evidence of presence than the probe was: more current, and free. The three
// outcomes are unchanged and each still means exactly what it meant:
//   { present: true, rows }  — the tab is there and these are its rows
//   { present: false }       — CONFIRMED absent by `confirmTabMissing`, which is the one
//                              authority for that fact and needs its own successful tab
//                              listing to say so. A verified empty ledger.
//   null                     — unreadable. Fails closed; never a verified empty seal.
async function _readLedger() {
  try {
    const rows = await sheets.getSheetRows(SESSION_PLAN_SETS_TAB);
    return { present: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (error) {
    try {
      if (await sheets.confirmTabMissing(error, SESSION_PLAN_SETS_TAB)) return { present: false, rows: [] };
    } catch (_) { /* could not confirm ⇒ not evidence of absence ⇒ unreadable */ }
    return null;
  }
}

async function readLedgerRows(sessionId) {
  const sid = String(sessionId == null ? '' : sessionId).trim();
  if (!sid) return [];
  const ledger = await _readLedger();
  if (ledger === null) return null;      // unreadable — the caller must flag it
  if (!ledger.present) return [];        // confirmed absent — a legacy/no-ledger session
  return (Array.isArray(ledger.rows) ? ledger.rows : []).filter(r =>
    Array.isArray(r) && String(r[SID_IDX] == null ? '' : r[SID_IDX]).trim() === sid);
}

async function sealCloseout(session, closeoutWriteId, opts = {}) {
  const s = session && typeof session === 'object' ? session : {};
  const session_id = String(s.session_id == null ? '' : s.session_id).trim();
  if (!session_id) throw new Error('sessionPlanSetsStore: session_id is required');
  const writeId = String(closeoutWriteId == null ? '' : closeoutWriteId).trim();
  if (!writeId) throw new Error('sessionPlanSetsStore: closeout_write_id is required');

  const dryRun = opts.test_mode === true || !LIVE_WRITE_ENABLED;
  const dryReason = opts.test_mode === true ? 'test_mode' : 'write_disabled';
  const dryProof = { sheet_written: false, no_write_confirmed: true, dry_run: true, reason: dryReason };

  // Read the ledger (read-only — used by both the dry-run preview counts and the
  // live stamp). A CONFIRMED-absent tab means this session simply has no durable
  // ledger (legacy / pre-enablement) — an empty, verified seal. An UNREADABLE
  // ledger (metadata or row read failed) is a ledger failure and FAILS CLOSED
  // (Codex P1, PR #1068): a transient outage must never claim a verified closeout
  // while real rows may sit unstamped.
  const ledger = await _readLedger();
  if (ledger === null) {
    const failed = { sealed: 0, already_sealed: 0, sealed_ok: false, reason: 'ledger_read_failed' };
    return dryRun
      ? { ...dryProof, would_seal: null, read_failed: true, ...failed }
      : { sheet_written: false, no_write_confirmed: true, ...failed };
  }
  if (!ledger.present) {
    // `sealed_ok:true` on BOTH paths: absence was CONFIRMED and there is nothing to
    // stamp, which is a verified outcome regardless of whether the lane may write. Omitting it
    // on the dry path did not make the dry run safer — the artifact consumer reads an absent
    // field as UNKNOWN, so the omission reported a verified empty seal as `indeterminate` and
    // made reviewability unreachable while `SESSION_PLAN_SETS_WRITE_ENABLED` is 0 (#1165). The
    // W1–W3 dry-run tuple is untouched; `reason` still names why the run was dry.
    return dryRun
      ? { ...dryProof, would_seal: 0, already_sealed: 0, sealed_ok: true, no_ledger: true }
      : { sheet_written: false, no_write_confirmed: true, sealed: 0, already_sealed: 0, sealed_ok: true, no_ledger: true, reason: 'tab_missing' };
  }
  // Already in hand from the single ledger read above — the separate re-read this
  // replaced was the second of the two metered requests.
  const allRows = ledger.rows;

  const mine = [];
  allRows.forEach((row, i) => {
    const arr = Array.isArray(row) ? row : [];
    if (String(arr[SID_IDX] == null ? '' : arr[SID_IDX]).trim() === session_id) mine.push({ i, row: arr });
  });
  if (!mine.length) {
    // Same verified-empty outcome as the confirmed-absent tab above, reached one read later: the
    // rows came back and this session owns none of them.
    return dryRun
      ? { ...dryProof, would_seal: 0, already_sealed: 0, sealed_ok: true, no_ledger: true }
      : { sheet_written: false, no_write_confirmed: true, sealed: 0, already_sealed: 0, sealed_ok: true, no_ledger: true, reason: 'no_rows' };
  }

  // A row sealed by a DIFFERENT closeout fails the whole seal closed — never re-seal.
  const conflicting = mine.filter(m => {
    const v = String(m.row[SEAL_IDX] == null ? '' : m.row[SEAL_IDX]).trim();
    return v && v !== writeId;
  });
  if (conflicting.length) {
    const ids = [...new Set(conflicting.map(m => String(m.row[SEAL_IDX]).trim()))];
    const base = { sealed: 0, already_sealed: 0, sealed_ok: false, reason: 'conflicting_seal', conflicting_write_ids: ids };
    return dryRun ? { ...dryProof, would_seal: 0, ...base } : { sheet_written: false, no_write_confirmed: true, ...base };
  }

  // Validate every (plan_item_id, set_index) revision chain — a malformed ledger is
  // surfaced honestly and NOTHING is stamped (no partial seal).
  const parsed = mine.map(m => parseRow(m.row));
  if (parsed.some(p => p.malformed)) {
    const base = { sealed: 0, already_sealed: 0, sealed_ok: false, reason: 'malformed_chain', diagnostics: { reason: 'unparseable_rows' } };
    return dryRun ? { ...dryProof, would_seal: 0, ...base } : { sheet_written: false, no_write_confirmed: true, ...base };
  }
  const recs = parsed.map(p => p.rec);
  const chainKeys = [...new Set(recs.map(r => `${r.plan_item_id} ${r.setIndex}`))];
  for (const key of chainKeys) {
    const [plan_item_id, setIndex] = key.split(' ');
    const v = validateChain(recs, plan_item_id, Number(setIndex));
    if (!v.ok) {
      const base = { sealed: 0, already_sealed: 0, sealed_ok: false, reason: 'malformed_chain', diagnostics: { plan_item_id, set_index: Number(setIndex), ...v.diagnostics } };
      return dryRun ? { ...dryProof, would_seal: 0, ...base } : { sheet_written: false, no_write_confirmed: true, ...base };
    }
  }

  const toStamp = mine.filter(m => !String(m.row[SEAL_IDX] == null ? '' : m.row[SEAL_IDX]).trim());
  const alreadySealed = mine.length - toStamp.length;

  if (dryRun) return { ...dryProof, would_seal: toStamp.length, already_sealed: alreadySealed };
  if (!toStamp.length) {
    // Idempotent replay: every row already carries THIS closeout's id — verified.
    return { sheet_written: false, no_write_confirmed: true, sealed: 0, already_sealed: alreadySealed, sealed_ok: true, reason: 'all_sealed' };
  }

  // Data row i sits at sheet row i + 2 (row 1 is the header; rows are 1-based).
  const cells = toStamp.map(m => ({ row: m.i + 2, value: writeId }));
  const response = await sheets.updateColumnCells(SESSION_PLAN_SETS_TAB, SEAL_COL_LETTER, cells);
  const updatedCells = response && response.data ? Number(response.data.totalUpdatedCells) : NaN;
  if (updatedCells !== cells.length) {
    return {
      sheet_written: true, sealed: 0, already_sealed: alreadySealed, sealed_ok: false,
      reason: 'seal_proof_mismatch', expected_cells: cells.length,
      updated_cells: Number.isFinite(updatedCells) ? updatedCells : null,
    };
  }
  return {
    sheet_written: true, no_write_confirmed: false, sealed: cells.length,
    already_sealed: alreadySealed, sealed_ok: true, column: SEAL_COL_LETTER,
  };
}

module.exports = {
  SESSION_PLAN_SETS_TAB,
  LIVE_WRITE_ENABLED,
  checkpointAcceptedPlan,
  checkpointRevision,
  checkpointImplicit,
  readLedgerRows,
  sealCloseout,
};
