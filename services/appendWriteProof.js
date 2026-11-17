'use strict';

// APPEND-RECEIPT WRITE PROOF — the single authority for "did the log rows land".
//
// THE AUTHORITY DEFECT THIS RESOLVES. Two things decided whether a successful Save was
// verified:
//
//   1. `spreadsheets.values.append`'s own `updates` envelope — `updatedRange` and
//      `updatedRows` — produced BY the write, atomically with it. The server already had
//      it and already forwarded it as `logAppendedRange` / `log_rows_written`, but nothing
//      adjudicated it, so the client could not act on it.
//   2. `GET /api/log-workout/verify-range` — a SEPARATE, LATER read of the sheet that
//      re-checks the row count and the session_id column.
//
// Authority 1 wins. It is contemporaneous with the write rather than a re-observation
// taken afterwards, it is produced by the API that performed the append, and it costs no
// quota read. Authority 2 costs one metered read at closeout — the exact moment the
// session is most read-starved, and the moment the 2026-08-05 qualifying session hit 429s.
//
// WHAT THE RECEIPT ESTABLISHES, exactly, and nothing beyond it:
//   • exact appended range — `updatedRange`, reported by the append itself;
//     the range must start at column A, name 1-based rows (row 0 cannot be
//     an append), and end at the column of the submitted rows' width, so a
//     receipt for a narrower, wider, or row-zero range is NOT the append
//     that was requested;
//   • exact row count — `updatedRows`, cross-checked against the row span of that range
//     AND against the number of rows the server actually submitted, so a receipt that
//     disagrees with itself or with the request is NOT verified; the count
//     must arrive as a JSON number — a boolean, string, or array count is
//     not a row count, and nothing here coerces one into being one;
//   • session ownership — every submitted row is checked to carry this session_id in the
//     session_id column BEFORE the receipt is accepted. The rows Google appended are the
//     values the server submitted, so ownership of the submitted rows is ownership of the
//     appended rows;
//   • truthful write proof — the verdict is derived, never asserted: a missing, malformed
//     or self-contradicting receipt returns `verified: false` with an exact reason, and
//     the caller then has no proof rather than a fabricated one.
//
// WHAT IT DOES NOT ESTABLISH, stated rather than hidden: it does not re-observe the sheet.
// A receipt that were itself wrong would not be caught here. The read-back did re-observe,
// but only at a LATER instant (so an intervening write defeats it equally) and only over
// the session_id column and the row count — the same two facts the receipt carries. The
// marginal assurance it added was narrow; the quota read it cost was not.
//
// This module is pure: no I/O, no clock, no Sheets client.

/**
 * Adjudicate an append receipt.
 *
 * @param {object}   args
 * @param {object}   args.receipt        the `updates` envelope from values.append
 * @param {string}   args.tab            the tab the rows were appended to
 * @param {string}   args.sessionId      the session the rows must belong to
 * @param {Array[]}  args.rowsSubmitted  the exact row arrays handed to values.append
 * @param {number}   args.sessionIdColumnIndex  0-based index of session_id in a row
 * @returns {{verified:boolean, authority:string, reason:string|null, range:string|null,
 *            rows_written:number|null, rows_submitted:number}}
 */
function verifyAppendReceipt({ receipt, tab, sessionId, rowsSubmitted, sessionIdColumnIndex }) {
  return adjudicateAppendReceipt({ receipt, tab, rowsSubmitted, sessionId, sessionIdColumnIndex });
}

/**
 * Adjudicate an append receipt for a writer whose rows carry no session_id
 * column (POST /api/coaching-notes appends [date, note]). Every check of the
 * session-owning variant applies — tab, A-start, range parse, span, row count
 * against the request — except session ownership, which the row cannot carry.
 * A note receipt that fails any of those checks is a failed write, same as a
 * session-owned one; the absence of a session column never reads as proof.
 *
 * @param {object}   args
 * @param {object}   args.receipt        the `updates` envelope from values.append
 * @param {string}   args.tab            the tab the rows were appended to
 * @param {Array[]}  args.rowsSubmitted  the exact row arrays handed to values.append
 * @returns {{verified:boolean, authority:string, reason:string|null, range:string|null,
 *            rows_written:number|null, rows_submitted:number}}
 */
function verifyAppendReceiptWithoutSession({ receipt, tab, rowsSubmitted }) {
  return adjudicateAppendReceipt({ receipt, tab, rowsSubmitted, sessionId: null, sessionIdColumnIndex: null });
}

// Column letters <-> 1-based column numbers (A=1, Z=26, AA=27, ...).
function columnLettersToNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Shared core: the range/count/span checks, then session ownership only when
// the writer's rows carry a session_id column (sessionIdColumnIndex !== null).
function adjudicateAppendReceipt({ receipt, tab, rowsSubmitted, sessionId, sessionIdColumnIndex }) {
  const submitted = Array.isArray(rowsSubmitted) ? rowsSubmitted : [];
  const base = {
    verified: false,
    authority: 'append_receipt',
    reason: null,
    range: null,
    rows_written: null,
    rows_submitted: submitted.length,
  };

  if (!receipt || typeof receipt !== 'object') return { ...base, reason: 'no_receipt' };

  const range = typeof receipt.updatedRange === 'string' ? receipt.updatedRange : null;
  // The row count must ARRIVE as a number. Number() would coerce true -> 1,
  // '1' -> 1, [1] -> 1, ' 1 ' -> 1 — each a receipt shape the re-audit
  // proved mints success — so no coercion happens here: a non-number count
  // is no row count at all.
  const rowsWritten = typeof receipt.updatedRows === 'number' && Number.isInteger(receipt.updatedRows)
    ? receipt.updatedRows
    : NaN;
  const out = { ...base, range, rows_written: Number.isFinite(rowsWritten) ? rowsWritten : null };

  if (!range) return { ...out, reason: 'no_range' };
  if (!Number.isInteger(rowsWritten) || rowsWritten < 1) return { ...out, reason: 'no_row_count' };
  if (submitted.length === 0) return { ...out, reason: 'no_rows_submitted' };

  // Sheets may quote a tab name containing spaces: 'My Tab'!A2:L13.
  const match = /^'?(.+?)'?!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!match) return { ...out, reason: 'range_unparseable' };
  if (match[1] !== tab) return { ...out, reason: 'wrong_tab' };
  if (match[2] !== 'A') return { ...out, reason: 'range_does_not_start_at_column_a' };

  // Sheets rows are 1-based: a range naming row 0 cannot be an append, even
  // when its span and count agree.
  const startRow = Number(match[3]);
  const endRow = Number(match[5]);
  if (startRow < 1 || endRow < 1) return { ...out, reason: 'range_row_not_one_based' };

  // The end column must equal the submitted rows' width (max row length;
  // writers submit uniform full-width rows). A receipt for a narrower or
  // wider range is not the append that was requested, even when its row
  // count agrees.
  const submittedWidth = Math.max(...submitted.map((row) => (Array.isArray(row) ? row.length : 0)));
  if (columnLettersToNumber(match[4]) !== submittedWidth) {
    return { ...out, reason: 'range_end_column_disagrees_with_row_width' };
  }

  const span = endRow - startRow + 1;
  if (span !== rowsWritten) return { ...out, reason: 'range_span_disagrees_with_row_count' };
  if (rowsWritten !== submitted.length) return { ...out, reason: 'row_count_disagrees_with_request' };

  // No session column on this writer's rows: the receipt is adjudicated on the
  // range and the count alone, and ownership is not claimed.
  if (sessionIdColumnIndex === null || sessionIdColumnIndex === undefined) {
    return { ...out, verified: true };
  }

  const expected = String(sessionId || '').trim().toLowerCase();
  if (!expected) return { ...out, reason: 'no_session_id' };
  for (const row of submitted) {
    const owner = String((Array.isArray(row) ? row[sessionIdColumnIndex] : '') || '').trim().toLowerCase();
    if (owner !== expected) return { ...out, reason: 'session_id_mismatch' };
  }

  return { ...out, verified: true };
}

module.exports = { verifyAppendReceipt, verifyAppendReceiptWithoutSession };
