'use strict';

// WRITE PROOF — the single authority for "did the logged sets land".
//
// ── WHAT IT ADJUDICATES NOW ──────────────────────────────────────────────────
//
// The receipt of the Supabase transaction that performed the Save: the session it
// wrote under, the `write_id` it stamped on every row, and how many logged-set
// rows it inserted. It is produced BY the write, inside the same transaction, so
// it is contemporaneous with it rather than a re-observation taken afterwards.
//
// ── WHAT IT USED TO ADJUDICATE, AND WHY THAT CHANGED ─────────────────────────
//
// It adjudicated `spreadsheets.values.append`'s `updates` envelope — an A1
// `updatedRange` plus `updatedRows` — because Google Sheets was the authority and
// a range was the only address a row had. The S4 cutover moved the Save into one
// Supabase transaction, so:
//
//   - THERE IS NO RANGE. A row is addressed by `(session_id, write_id)`, which is
//     stamped at insert and is what undo deletes by. A range would have to be
//     invented, and an invented proof field is worse than an absent one.
//   - THE ROW COUNT IS STRONGER THAN IT WAS. It came from a second system's
//     acknowledgement of an append that could half-succeed; it now comes from the
//     transaction itself, which commits whole or not at all.
//
// ── WHAT IT ESTABLISHES, exactly, and nothing beyond it ──────────────────────
//   • exact row count — cross-checked against the number of rows the server
//     actually submitted, so a receipt that disagrees with the request is NOT
//     verified;
//   • session ownership — every submitted row is checked to carry this session_id
//     in the session_id column, AND the transaction is checked to have written
//     under that same session;
//   • write identity — the receipt must carry the `write_id` this request claimed,
//     because that is what makes the rows addressable afterwards. A Save whose rows
//     carry a different id could not be undone by this request's client;
//   • truthful proof — the verdict is DERIVED, never asserted. A missing, malformed
//     or self-contradicting receipt returns `verified: false` with an exact reason,
//     and the caller then has no proof rather than a fabricated one.
//
// WHAT IT DOES NOT ESTABLISH, stated rather than hidden: it does not re-read the
// rows back out of the database. The old read-back did re-observe, but only at a
// LATER instant and only over the row count and the session_id column — the same
// two facts the receipt carries.
//
// This module is pure: no I/O, no clock, no database client.

/**
 * Adjudicate a Save's write receipt.
 *
 * @param {object}   args
 * @param {object}   args.receipt        the result of the Save transaction:
 *                                       `{ session_id, write_id, log_rows_written }`
 * @param {string}   args.sessionId      the session the rows must belong to
 * @param {string}   args.writeId        the write_id this request claimed
 * @param {Array[]}  args.rowsSubmitted  the exact row arrays handed to the write
 * @param {number}   args.sessionIdColumnIndex  0-based index of session_id in a row
 * @returns {{verified:boolean, authority:string, reason:string|null,
 *            write_id:string|null, rows_written:number|null, rows_submitted:number}}
 */
function verifyWriteReceipt({ receipt, sessionId, writeId, rowsSubmitted, sessionIdColumnIndex }) {
  const submitted = Array.isArray(rowsSubmitted) ? rowsSubmitted : [];
  const base = {
    verified: false,
    authority: 'supabase_transaction',
    reason: null,
    write_id: null,
    rows_written: null,
    rows_submitted: submitted.length,
  };

  if (!receipt || typeof receipt !== 'object') return { ...base, reason: 'no_receipt' };

  const receiptWriteId = typeof receipt.write_id === 'string' ? receipt.write_id : null;
  const rowsWritten = Number(receipt.log_rows_written);
  const out = {
    ...base,
    write_id: receiptWriteId,
    rows_written: Number.isFinite(rowsWritten) ? rowsWritten : null,
  };

  if (!Number.isInteger(rowsWritten) || rowsWritten < 1) return { ...out, reason: 'no_row_count' };
  if (submitted.length === 0) return { ...out, reason: 'no_rows_submitted' };
  if (rowsWritten !== submitted.length) return { ...out, reason: 'row_count_disagrees_with_request' };

  const expected = String(sessionId || '').trim().toLowerCase();
  if (!expected) return { ...out, reason: 'no_session_id' };
  // The transaction must have written under the SAME session the caller believes it
  // did. A mismatch here means the rows exist but belong to a different workout,
  // which is the one failure a row count alone cannot see.
  if (String(receipt.session_id || '').trim().toLowerCase() !== expected) {
    return { ...out, reason: 'receipt_session_mismatch' };
  }

  const expectedWriteId = String(writeId || '').trim();
  if (!expectedWriteId) return { ...out, reason: 'no_write_id' };
  if (receiptWriteId !== expectedWriteId) return { ...out, reason: 'write_id_mismatch' };

  for (const row of submitted) {
    const owner = String((Array.isArray(row) ? row[sessionIdColumnIndex] : '') || '').trim().toLowerCase();
    if (owner !== expected) return { ...out, reason: 'session_id_mismatch' };
  }

  return { ...out, verified: true };
}

module.exports = { verifyWriteReceipt };
