'use strict';

// #1764 Part 1 — reverify a completed save receipt against the live workbook
// before the retry path replays it as success.
//
// A stored receipt is historical proof: it establishes what the append
// returned at write time. It says nothing about the workbook NOW — an undo,
// or a deletion outside the app, can remove the rows while the receipt still
// claims them. The retry path must therefore re-derive the current state
// from the sheet before it answers `skipped_duplicate`.
//
// The check is a session scan, not a range read: deletes shift the rows
// below them, so a stored A1 range can point at a different session's rows
// after any delete. Counting the session's rows is shift-proof — a later
// save for the same session can only add rows, so "found >= claimed" stays
// true for multi-write sessions while a deleted save fails it.
//
// Reads are LIVE (`sheets.getSheetRows`, never the 30s row cache in
// index.js): a cached pre-undo snapshot would re-verify rows the undo just
// removed. A failed read refuses rather than replays — an unverifiable
// receipt is never a verified success.

const { getSheetRows } = require('../sheets');

function normalizeSessionId(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

async function verifySaveReceiptAgainstWorkbook({
  sessionId,
  logRowsWritten,
  effortWritten,
  logSheetName,
  effortSheetName,
  logSessionIdColumn,
  effortSessionIdColumn,
}) {
  const sid = normalizeSessionId(sessionId);
  if (!sid) {
    return { verified: false, reason: 'receipt_reverification_unavailable', detail: 'no session_id on the receipt' };
  }

  let logRows;
  try {
    logRows = await getSheetRows(logSheetName);
  } catch (err) {
    return { verified: false, reason: 'receipt_reverification_unavailable', detail: 'Log read failed' };
  }
  const claimedLog = Number(logRowsWritten) || 0;
  if (claimedLog > 0) {
    const found = (Array.isArray(logRows) ? logRows : []).filter(
      (row) => Array.isArray(row) && normalizeSessionId(row[logSessionIdColumn]) === sid
    ).length;
    if (found < claimedLog) {
      return {
        verified: false,
        reason: 'save_receipt_contradicts_workbook',
        detail: `receipt claims ${claimedLog} Log rows for the session, workbook holds ${found}`,
      };
    }
  }

  if (effortWritten) {
    let effortRows;
    try {
      effortRows = await getSheetRows(effortSheetName);
    } catch (err) {
      return { verified: false, reason: 'receipt_reverification_unavailable', detail: 'Effort read failed' };
    }
    const found = (Array.isArray(effortRows) ? effortRows : []).some(
      (row) => Array.isArray(row) && normalizeSessionId(row[effortSessionIdColumn]) === sid
    );
    if (!found) {
      return {
        verified: false,
        reason: 'save_receipt_contradicts_workbook',
        detail: 'receipt claims an Effort row for the session, workbook holds none',
      };
    }
  }

  return { verified: true };
}

module.exports = { verifySaveReceiptAgainstWorkbook };
