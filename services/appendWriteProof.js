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
//   • exact row count — `updatedRows`, cross-checked against the row span of that range
//     AND against the number of rows the server actually submitted, so a receipt that
//     disagrees with itself or with the request is NOT verified;
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
  const rowsWritten = Number(receipt.updatedRows);
  const out = { ...base, range, rows_written: Number.isFinite(rowsWritten) ? rowsWritten : null };

  if (!range) return { ...out, reason: 'no_range' };
  if (!Number.isInteger(rowsWritten) || rowsWritten < 1) return { ...out, reason: 'no_row_count' };
  if (submitted.length === 0) return { ...out, reason: 'no_rows_submitted' };

  // Sheets may quote a tab name containing spaces: 'My Tab'!A2:L13.
  const match = /^'?(.+?)'?!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!match) return { ...out, reason: 'range_unparseable' };
  if (match[1] !== tab) return { ...out, reason: 'wrong_tab' };
  if (match[2] !== 'A') return { ...out, reason: 'range_does_not_start_at_column_a' };

  const span = Number(match[5]) - Number(match[3]) + 1;
  if (span !== rowsWritten) return { ...out, reason: 'range_span_disagrees_with_row_count' };
  if (rowsWritten !== submitted.length) return { ...out, reason: 'row_count_disagrees_with_request' };

  const expected = String(sessionId || '').trim().toLowerCase();
  if (!expected) return { ...out, reason: 'no_session_id' };
  for (const row of submitted) {
    const owner = String((Array.isArray(row) ? row[sessionIdColumnIndex] : '') || '').trim().toLowerCase();
    if (owner !== expected) return { ...out, reason: 'session_id_mismatch' };
  }

  return { ...out, verified: true };
}

module.exports = { verifyAppendReceipt };
