'use strict';

// #1762 REGRESSION RE-FIX — Astra re-audit #3 (2026-11-16, at 427b7945)
// grades the #1762 fix REGRESSED-NEW-VARIANT: "9 variants x 4 writers —
// width, row-zero, and boolean-shaped receipt variants are accepted across
// the four append writers/replays. The original proof cases are blocked;
// the variant shapes are not."
//
// The regression is inside the adjudicator's acceptance conditions
// (services/appendWriteProof.js), not in any writer's gating: a malformed
// receipt that verifies here mints sheet_write success + idempotency_status
// completed, and the retry replay returns that stored body — so closing the
// adjudicator closes the replays too. Proved here at the adjudicator level,
// one test per shape per writer, with the exact refusal reason pinned.
//
// The 9 shapes (derived from the adjudicator's acceptance conditions; the
// verify-first state map on #1762, comment 6951736224, reproduces 36/36 at
// s3 head 7f7b1c49 with the standalone probe atlas-1762-refix-probe.cjs):
//   W1 narrow end col — the end column is captured and never checked.
//   W2 over-wide end col — Z instead of the submitted width.
//   W3 single-col end — A instead of the submitted width.
//   Z1 row-zero range — A0:<end>0; Sheets rows are 1-based.
//   Z2 row-zero start — A0:<end>1 with a matching 2-row count.
//   B1 boolean row count — updatedRows: true coerces to 1 via Number().
//   B2 numeric-string row count — updatedRows: '1'.
//   B3 array row count — updatedRows: [1].
//   B4 whitespace numeric-string row count — updatedRows: ' 1 '.
//
// One probe-count correction, recorded so the review is not confused: the
// standalone probe counts W1 for Coaching_Notes (A2:B2) as a variant, but B
// IS the honest full-width end column for a 2-column note row — that receipt
// is correct and must verify. The genuine variant count is therefore 35,
// not 36; the Notes A2:B2 case is pinned as a control below (C7). The
// coordinator parity ack (Slack #1762 thread, 08:18 PT Nov 17) confirms the
// pack's 3 minting shapes per writer — shortwidth (Log/Complete/Modality
// A2:B2; Notes A2:A2), rowzero (A0:L0), boolcount (updatedRows true) — are
// all inside this set; the set is a superset that also pins over-width,
// single-column, the A0:L1 span, and the string/array/padded coercions.
//
// Each variant test asserts the FIXED outcome, so every variant test FAILS
// at the s3 head until the adjudicator is fixed. Controls must behave the
// same before and after the fix.

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyAppendReceipt, verifyAppendReceiptWithoutSession } = require('../services/appendWriteProof');
const { logCleanedColumns, effortColumns, modalityLogColumns, coachingNotesColumns } = require('../config/columns');

const SESSION = 'sess-1762-refix';

// Writer shapes: real tab names, real submitted widths, session column where
// the writer's rows carry one. Log_Cleaned 12 cols (A–L), Effort 9 (A–I),
// Modality_Log 12 (A–L), Coaching_Notes 2 (A–B).
const WRITERS = [
  {
    key: 'log', tab: 'Log_Cleaned', columns: logCleanedColumns, session: true,
    fill(row) {
      row[logCleanedColumns.indexOf('date_clean')] = '2026-11-17';
      row[logCleanedColumns.indexOf('exercise')] = 'Back Squat';
      row[logCleanedColumns.indexOf('set_number')] = '1';
    },
  },
  {
    key: 'effort', tab: 'Effort', columns: effortColumns, session: true,
    fill(row) {
      row[effortColumns.indexOf('date')] = '2026-11-17';
      row[effortColumns.indexOf('duration')] = '58';
    },
  },
  {
    key: 'modality', tab: 'Modality_Log', columns: modalityLogColumns, session: true,
    fill(row) {
      row[modalityLogColumns.indexOf('date')] = '2026-11-17';
      row[modalityLogColumns.indexOf('modality')] = 'timed_hold';
      row[modalityLogColumns.indexOf('duration_sec')] = '45';
    },
  },
  {
    key: 'notes', tab: 'Coaching_Notes', columns: coachingNotesColumns, session: false,
    fill(row) {
      row[coachingNotesColumns.indexOf('date')] = '2026-11-17';
      row[coachingNotesColumns.indexOf('note')] = 'probe note';
    },
  },
];

function columnLetter(n) {
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function makeRows(writer, count) {
  const sessionCol = writer.columns.indexOf('session_id');
  return Array.from({ length: count }, () => {
    const row = new Array(writer.columns.length).fill('');
    if (sessionCol >= 0) row[sessionCol] = SESSION;
    writer.fill(row);
    return row;
  });
}

function adjudicate(writer, receipt, rows) {
  if (!writer.session) {
    return verifyAppendReceiptWithoutSession({ receipt, tab: writer.tab, rowsSubmitted: rows });
  }
  return verifyAppendReceipt({
    receipt,
    tab: writer.tab,
    sessionId: SESSION,
    rowsSubmitted: rows,
    sessionIdColumnIndex: writer.columns.indexOf('session_id'),
  });
}

function range(writer, startCol, startRow, endCol, endRow) {
  return `${writer.tab}!${startCol}${startRow}:${endCol}${endRow}`;
}

// ── variants: each must refuse, with the exact reason ───────────────────────
// W1 narrow end col — end 'B' is narrower than the submitted width for the
// 12- and 9-column writers. (For Notes, B is the full width — see C7.)
for (const writer of WRITERS.filter((w) => w.columns.length > 2)) {
  test(`#1762 refix W1 [${writer.key}]: a narrow end column is not proof (range_end_column_disagrees_with_row_width)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 2, 'B', 2), updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'range_end_column_disagrees_with_row_width', JSON.stringify(verdict));
  });
}

// W2 over-wide end col — end 'Z' exceeds the submitted width, every writer.
for (const writer of WRITERS) {
  test(`#1762 refix W2 [${writer.key}]: an over-wide end column is not proof (range_end_column_disagrees_with_row_width)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 2, 'Z', 2), updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'range_end_column_disagrees_with_row_width', JSON.stringify(verdict));
  });
}

// W3 single-col end — end 'A' covers one column of a multi-column row.
for (const writer of WRITERS) {
  test(`#1762 refix W3 [${writer.key}]: a single-column end is not proof (range_end_column_disagrees_with_row_width)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 2, 'A', 2), updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'range_end_column_disagrees_with_row_width', JSON.stringify(verdict));
  });
}

// Z1 row-zero range — A0:<end>0; Sheets rows are 1-based, row 0 cannot be an append.
for (const writer of WRITERS) {
  test(`#1762 refix Z1 [${writer.key}]: a row-zero range is not proof (range_row_not_one_based)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 0, columnLetter(writer.columns.length), 0), updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'range_row_not_one_based', JSON.stringify(verdict));
  });
}

// Z2 row-zero start — A0:<end>1 with a matching 2-row count; the span agrees,
// so only the 1-based-row check can refuse it.
for (const writer of WRITERS) {
  test(`#1762 refix Z2 [${writer.key}]: a row-zero start is not proof (range_row_not_one_based)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 0, columnLetter(writer.columns.length), 1), updatedRows: 2 }, makeRows(writer, 2));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'range_row_not_one_based', JSON.stringify(verdict));
  });
}

// B1–B4 row-count coercion — Number() turns each of these into 1; a row count
// that is not a JSON number is not a row count.
const COERCIONS = [
  ['B1 boolean row count', true],
  ['B2 numeric-string row count', '1'],
  ['B3 array row count', [1]],
  ['B4 whitespace numeric-string row count', ' 1 '],
];
for (const writer of WRITERS) {
  for (const [label, updatedRows] of COERCIONS) {
    test(`#1762 refix ${label} [${writer.key}]: a non-number row count is not proof (no_row_count)`, () => {
      const verdict = adjudicate(writer,
        { updatedRange: range(writer, 'A', 2, columnLetter(writer.columns.length), 2), updatedRows }, makeRows(writer, 1));
      assert.equal(verdict.verified, false, JSON.stringify(verdict));
      assert.equal(verdict.reason, 'no_row_count', JSON.stringify(verdict));
      assert.equal(verdict.rows_written, null, JSON.stringify(verdict));
    });
  }
}

// ── controls: must behave the same before and after the fix ─────────────────
for (const writer of WRITERS) {
  test(`#1762 refix C1 [${writer.key}]: a correct receipt still verifies`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 2, columnLetter(writer.columns.length), 2), updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, true, JSON.stringify(verdict));
    assert.equal(verdict.reason, null, JSON.stringify(verdict));
    assert.equal(verdict.rows_written, 1, JSON.stringify(verdict));
  });

  test(`#1762 refix C2 [${writer.key}]: a wrong tab still refuses (wrong_tab)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: `Wrong_Tab!A2:${columnLetter(writer.columns.length)}2`, updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'wrong_tab', JSON.stringify(verdict));
  });

  test(`#1762 refix C3 [${writer.key}]: zero rows still refuses (no_row_count)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 2, columnLetter(writer.columns.length), 2), updatedRows: 0 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'no_row_count', JSON.stringify(verdict));
  });

  test(`#1762 refix C4 [${writer.key}]: a quoted tab still verifies`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: `'${writer.tab}'!A2:${columnLetter(writer.columns.length)}2`, updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, true, JSON.stringify(verdict));
  });

  test(`#1762 refix C5 [${writer.key}]: a span disagreeing with the count still refuses (range_span_disagrees_with_row_count)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 2, columnLetter(writer.columns.length), 3), updatedRows: 1 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'range_span_disagrees_with_row_count', JSON.stringify(verdict));
  });

  test(`#1762 refix C6 [${writer.key}]: a count disagreeing with the request still refuses (row_count_disagrees_with_request)`, () => {
    const verdict = adjudicate(writer,
      { updatedRange: range(writer, 'A', 2, columnLetter(writer.columns.length), 3), updatedRows: 2 }, makeRows(writer, 1));
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, 'row_count_disagrees_with_request', JSON.stringify(verdict));
  });
}

// C7 — the probe-count correction: for Coaching_Notes, A2:B2 IS the honest
// full-width receipt (2 columns), so it must verify. W1 does not apply here.
test('#1762 refix C7 [notes]: the honest 2-column receipt still verifies', () => {
  const writer = WRITERS.find((w) => w.key === 'notes');
  const verdict = adjudicate(writer,
    { updatedRange: 'Coaching_Notes!A2:B2', updatedRows: 1 }, makeRows(writer, 1));
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.equal(verdict.reason, null, JSON.stringify(verdict));
});
