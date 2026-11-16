'use strict';

// #1763 [P1][Astra D03] — undo reconciliation by row identity.
//
// The undo route used to verify its target by SHEET POSITION: it read the
// rows at the requested A1 range, checked they belonged to the session, and
// deleted by that range. When a delete committed server-side but the response
// errored, the retry re-verified the same range — which now held the NEXT
// same-session row — and deleted the wrong row. The fix is identity: the
// route fingerprints the target rows at verification time, and every later
// decision (retry, fresh ID, receipt loss) compares against those
// fingerprints. A stored row position is never authority again.
//
// A row's identity is its full content (all columns). Log_Cleaned carries no
// row id and no timestamp, so the content is the strongest identity the
// schema offers; two rows with identical content are twins and the undo
// refuses rather than guessing which one to delete (design-proof Q2).

function fingerprintRow(row) {
  if (!Array.isArray(row)) return null;
  return JSON.stringify(row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))));
}

// Fingerprints of the rows in [startRow, endRow] (1-indexed sheet rows) taken
// from `allRows` (data rows, header excluded). Returns null when any target
// row is missing or empty — the caller refuses, it never guesses.
function fingerprintsForRange(allRows, startRow, endRow) {
  const targets = [];
  for (let r = startRow; r <= endRow; r++) {
    const dataIndex = r - 2;
    const row = allRows[dataIndex];
    if (!row || row.every((cell) => String(cell) === '')) return null;
    const fingerprint = fingerprintRow(row);
    if (fingerprint === null) return null;
    targets.push({ sheetRow: r, dataIndex, fingerprint });
  }
  return targets;
}

function countFingerprint(rows, fingerprint) {
  let count = 0;
  for (const row of rows || []) {
    if (fingerprintRow(row) === fingerprint) count += 1;
  }
  return count;
}

// True when any target fingerprint also occurs OUTSIDE the target data
// indices — an identical twin the undo must not touch. Rows identical to
// each other INSIDE the target range are fine: the range deletes all of
// them, and no row outside the range shares their content.
function hasTwinOutsideRange(allRows, targets) {
  const targetIndices = new Set(targets.map((t) => t.dataIndex));
  const targetFingerprints = new Set(targets.map((t) => t.fingerprint));
  for (let i = 0; i < (allRows || []).length; i++) {
    if (targetIndices.has(i)) continue;
    const fp = fingerprintRow(allRows[i]);
    if (fp !== null && targetFingerprints.has(fp)) return true;
  }
  return false;
}

// The single decision procedure for a delete attempt against a fresh
// read-back. `targets` are the fingerprints captured at verification time
// (range order); `effortWasPresent` is whether an Effort row for the session
// existed before the delete; `logRowsNow` / `effortRowsNow` are the current
// full data rows; `effortSessionColumn` is the Effort session_id column index.
//
// Outcomes:
//   completed — every target fingerprint is gone from Log and the Effort row
//     is gone too (when one existed). The undo landed.
//   partial   — every target is still present at its original position and
//     the Effort row is gone (when one existed). The Effort delete committed;
//     the Log delete did not.
//   unchanged — every target is still present at its original position and
//     the Effort row is exactly as it was. Nothing committed.
//   ambiguous — anything else: a target shifted, partially gone, or present
//     at a different position; the Effort state contradicts the Log state;
//     a twin appeared. Refuse; the outcome is unknown.
function reconcileDeleteOutcome({ targets, effortWasPresent, logRowsNow, effortRowsNow, effortSessionColumn, normalizedSessionId }) {
  const logNow = Array.isArray(logRowsNow) ? logRowsNow : [];
  const effortNow = Array.isArray(effortRowsNow) ? effortRowsNow : [];

  let effortPresentNow = false;
  for (const row of effortNow) {
    if (!row || row.every((cell) => String(cell) === '')) continue;
    if (String(row[effortSessionColumn] || '').trim().toLowerCase() === normalizedSessionId) {
      effortPresentNow = true;
      break;
    }
  }

  let allTargetsGone = true;
  let allTargetsAtOriginalPosition = true;
  for (const target of targets) {
    if (countFingerprint(logNow, target.fingerprint) !== 0) allTargetsGone = false;
    const current = logNow[target.dataIndex];
    if (!current || fingerprintRow(current) !== target.fingerprint) allTargetsAtOriginalPosition = false;
  }

  if (allTargetsGone && (!effortWasPresent || !effortPresentNow)) return 'completed';
  if (allTargetsAtOriginalPosition && effortWasPresent && !effortPresentNow) return 'partial';
  if (allTargetsAtOriginalPosition && effortPresentNow === effortWasPresent) return 'unchanged';
  return 'ambiguous';
}

// The re-save generation check: a prior undo completed for this (session,
// range), and a new undo arrives for the same pair. The stored receipt says
// whether that undo removed the Effort row. The current sheet says whether
// a NEW write has since landed at the same range: a re-saved session
// recreates its Effort row, which the completed undo had removed. Only that
// combination proves a new generation — anything else means the current rows
// are the shifted leftovers of the undone write, and the undo is already done.
function isNewGenerationAfterCompletedUndo({ effortDeleted, effortPresentNow }) {
  if (effortDeleted !== true) return false;
  return effortPresentNow === true;
}

module.exports = {
  fingerprintRow,
  fingerprintsForRange,
  countFingerprint,
  hasTwinOutsideRange,
  reconcileDeleteOutcome,
  isNewGenerationAfterCompletedUndo,
};
