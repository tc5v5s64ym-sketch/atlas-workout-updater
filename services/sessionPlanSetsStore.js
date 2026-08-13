'use strict';

// ── Session_Plan_Sets idempotent creation-time checkpoint (F10A, dry-run) ──────
//
// The durable checkpoint path for the set-level recommendation ledger
// (docs/SESSION_PLANS_LEDGER_DESIGN.md, amendment 2: "durable idempotent checkpoint
// at CREATION — session state alone is insufficient"). Each accepted plan (v1) and
// each explicit revision is checkpointed the moment it is created through the
// Supabase authority. The write is idempotent and append-only. Like
// Session_Plans, this is system state, NOT logged sets — no log write_id,
// never through preview→approve→write, never touches Log_Cleaned/Effort. Append-only:
// a prior recommendation row is NEVER mutated (a revision appends a new version).
//
// S4 removes the Sheets-era live-write gate. The Supabase table is now the sole
// authority, so every real checkpoint writes; only an explicit test_mode dry run
// returns no-write proof.
//
const { sessionPlanSetsColumns } = require('../config/columns');
const { buildAcceptedRows, buildImplicitRows, buildRevisionRow, parseRow, validateChain } = require('./sessionPlanLedger');

const SESSION_PLAN_SETS_TAB = process.env.SESSION_PLAN_SETS_SHEET_NAME || 'Session_Plan_Sets';
const KEY_IDX = sessionPlanSetsColumns.indexOf('idempotency_key');
// Content columns (everything except recorded_at, which may differ across a retry).
const CONTENT_COLS = sessionPlanSetsColumns
  .map((c, i) => ({ c, i }))
  .filter(({ c }) => c !== 'recorded_at')
  .map(({ i }) => i);

const workoutAuthority = require('./workoutAuthority');

const SESSION_IDX = sessionPlanSetsColumns.indexOf('session_id');

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


// Append checkpoint rows. An explicit dry-run never touches Supabase and returns
// the W1–W3 proof. Live: idempotent
// append (exact-retry rows are skipped; a same-key row with DIFFERENT content is an
// append-only violation and fails closed — a revision must bump plan_version).
async function _append(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (opts.test_mode === true) {
    return _dryRunResult(list, 'test_mode');
  }
  if (!list.length) {
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped: 0, tab_missing: false, reason: 'empty' };
  }
  // Presence is proven by the read this append already needs (see `_readLedger`), not by
  // a separate metadata probe. `null` means unreadable, which is NOT absence: the previous
  // `_tabExists()` swallowed every failure into `false` and so reported a momentary outage
  // as "the owner has not created the tab yet". It now fails closed with its own reason.
  // The ledger rows for the sessions this batch touches, from Supabase — the
  // authority for plan sets and revisions since the S4 cutover.
  //
  // `tab_missing` cannot happen any more: it meant "the owner has not created the
  // Session_Plan_Sets tab yet", and a Supabase table created by the migration
  // cannot be absent at runtime. The field stays in every result shape because
  // callers and `services/turnWriteArtifact.js` branch on it; it is now always
  // false. `ledger_read_failed` still fails closed on an unreadable authority.
  const sessionIds = [...new Set(list
    .map((row) => String(row[SESSION_IDX] == null ? '' : row[SESSION_IDX]).trim())
    .filter(Boolean))];
  let ledgerRows = [];
  try {
    for (const sessionId of sessionIds) {
      ledgerRows = ledgerRows.concat(await workoutAuthority.planSetRows({ sessionId }));
    }
  } catch (_) {
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped: 0, tab_missing: false, reason: 'ledger_read_failed' };
  }

  const existing = _existingByKey(ledgerRows);
  const seen = new Map();
  const toAppend = [];
  for (const row of list) {
    const key = String(row[KEY_IDX] == null ? '' : row[KEY_IDX]).trim();
    const prior = existing.get(key) || seen.get(key);
    if (prior) {
      if (_contentEqual(prior, row)) continue; // exact retry → skip (idempotent)
      throw new Error(
        `sessionPlanSetsStore: revision collision on idempotency_key ${key} — a changed recommendation for the same (session_id, plan_version, plan_item_id, set_index) must bump plan_version; the set ledger is append-only and never mutates a prior row`
      );
    }
    seen.set(key, row);
    toAppend.push(row);
  }

  const skipped = list.length - toAppend.length;
  if (!toAppend.length) {
    return { sheet_written: false, no_write_confirmed: true, written: 0, skipped, tab_missing: false, reason: 'all_idempotent_skips' };
  }

  const result = await workoutAuthority.appendPlanSetRows(toAppend);
  return {
    sheet_written: true,
    no_write_confirmed: false,
    written: result.inserted,
    skipped: skipped + result.skipped,
    tab_missing: false,
    // A range is a Sheets concept and there is no Sheets write here. Reporting a
    // fabricated A1 range would be a false proof field.
    range: null,
    rows_written: result.inserted,  };
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

// Read one session's raw ledger rows (for the F10D closeout summary). Returns []
// when the tab is missing or the session has none (a legacy / pre-enablement
// session), and null on a READ FAILURE — the caller must surface the difference
// honestly (an unreadable ledger is never presented as "no stored plan").
// Probe the tab list, distinguishing CONFIRMED-ABSENT from UNREADABLE (Codex P1,
// PR #1068): a metadata outage must never be collapsed into "the tab doesn't
// exist" — the seal fails closed on it, and the summary flags it.
//   → { present: boolean }  when the metadata call succeeded
// Read this session's ledger rows from Supabase — the authority since the S4
// cutover — and report which outcome occurred.
//
// It used to have THREE outcomes because a Google Sheets tab can genuinely be
// absent, and proving absence needed its own metadata read. A Supabase table
// created by the migration cannot be absent at runtime, so `present:false` is no
// longer reachable and the shape collapses to two:
//
//   { present: true, rows }  — these are the session's rows (possibly none)
//   null                     — UNREADABLE. Fails closed; never a verified empty
//                              seal. This is the outcome that matters, and it is
//                              unchanged: a transient failure must never claim a
//                              verified closeout while real rows sit unstamped.
//
// `present:false` is retained in the shape so the callers' branches stay intact;
// nothing produces it.
async function _readLedger(sessionId = null) {
  try {
    const rows = await workoutAuthority.planSetRows({ sessionId });
    return { present: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (_) {
    return null;
  }
}
async function readLedgerRows(sessionId) {
  const sid = String(sessionId == null ? '' : sessionId).trim();
  if (!sid) return [];
  const ledger = await _readLedger(sid);
  if (ledger === null) return null;      // unreadable — the caller must flag it
  // The read is scoped to the session, so no in-memory filter is needed.
  return Array.isArray(ledger.rows) ? ledger.rows : [];
}

async function sealCloseout(session, closeoutWriteId, opts = {}) {
  const s = session && typeof session === 'object' ? session : {};
  const session_id = String(s.session_id == null ? '' : s.session_id).trim();
  if (!session_id) throw new Error('sessionPlanSetsStore: session_id is required');
  const writeId = String(closeoutWriteId == null ? '' : closeoutWriteId).trim();
  if (!writeId) throw new Error('sessionPlanSetsStore: closeout_write_id is required');

  const dryRun = opts.test_mode === true;
  const dryReason = 'test_mode';
  const dryProof = { sheet_written: false, no_write_confirmed: true, dry_run: true, reason: dryReason };

  // Read the ledger (read-only — used by both the dry-run preview counts and the
  // live stamp). A CONFIRMED-absent tab means this session simply has no durable
  // ledger (legacy / pre-enablement) — an empty, verified seal. An UNREADABLE
  // ledger (metadata or row read failed) is a ledger failure and FAILS CLOSED
  // (Codex P1, PR #1068): a transient outage must never claim a verified closeout
  // while real rows may sit unstamped.
  const ledger = await _readLedger(session_id);
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

  // THE SEAL IS A PREDICATE NOW, NOT A SET OF ROW POSITIONS.
  //
  // It used to compute each row's sheet position (`row = i + 2`) from a fresh read
  // and stamp those cells by column letter. That was the one place production wrote
  // by POSITION, and it re-derived positions every time precisely because a stored
  // one could drift. Supabase stamps every unsealed row of the session in one
  // statement, so there is no position to derive and nothing to drift.
  //
  // The PROOF is unchanged in kind: the seal claims success only when the number of
  // rows actually stamped matches the number this function decided to stamp. A
  // mismatch is still `seal_proof_mismatch` and still refuses to claim a verified
  // closeout.
  let sealedCount;
  try {
    sealedCount = await workoutAuthority.sealPlanSets(session_id, writeId);
  } catch (_) {
    return {
      sheet_written: false, no_write_confirmed: true, sealed: 0,
      already_sealed: alreadySealed, sealed_ok: false, reason: 'seal_write_failed',
    };
  }
  if (sealedCount !== toStamp.length) {
    return {
      sheet_written: true, sealed: 0, already_sealed: alreadySealed, sealed_ok: false,
      reason: 'seal_proof_mismatch', expected_cells: toStamp.length,
      updated_cells: Number.isFinite(sealedCount) ? sealedCount : null,
    };
  }
  return {
    sheet_written: true, no_write_confirmed: false, sealed: sealedCount,
    already_sealed: alreadySealed, sealed_ok: true,
  };
}

module.exports = {
  SESSION_PLAN_SETS_TAB,
  checkpointAcceptedPlan,
  checkpointRevision,
  checkpointImplicit,
  readLedgerRows,
  sealCloseout,
};
