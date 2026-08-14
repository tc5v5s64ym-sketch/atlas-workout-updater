'use strict';

// WRITE PROOF — one authority for "did the logged sets land", adjudicated.
//
// ── WHAT MOVED AT THE S4 CUTOVER ─────────────────────────────────────────────
//
// The adjudicated receipt was `spreadsheets.values.append`'s `updates` envelope: an
// A1 `updatedRange` plus `updatedRows`. The Save is one Supabase transaction now, so
// the receipt is the transaction's own result — the session it wrote under, the
// `write_id` it stamped on every row, and how many logged sets it inserted.
//
// THE RANGE LEFT THE PREDICATE and its absence is asserted here rather than assumed.
// It only ever proved WHERE Google put the rows, never that they were the right ones,
// and there is no range to produce. Two checks replaced it, and both are stronger:
// the receipt must name THIS session, and it must carry THIS request's write_id —
// which is what makes the rows addressable by undo afterwards.
//
// The verdict is DERIVED, never asserted: a missing, malformed or self-contradicting
// receipt returns `verified:false` with an exact reason, so the caller has no proof
// rather than a fabricated one.

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyWriteReceipt } = require('../services/appendWriteProof');
const { logCleanedColumns } = require('../config/columns');

const SESSION_ID_COL = logCleanedColumns.indexOf('session_id');
const SESSION = '20260806-AM-01';
const WRITE_ID = 'w_append_proof_1';

/** A submitted Log_Cleaned row owned by `session`. */
function row(session = SESSION, setNumber = 1) {
  const values = new Array(logCleanedColumns.length).fill('');
  values[logCleanedColumns.indexOf('date_clean')] = '2026-08-06';
  values[SESSION_ID_COL] = session;
  values[logCleanedColumns.indexOf('exercise')] = 'Back Squat';
  values[logCleanedColumns.indexOf('set_number')] = String(setNumber);
  return values;
}

function adjudicate(receipt, rowsSubmitted = [row(), row(SESSION, 2)]) {
  return verifyWriteReceipt({
    receipt,
    sessionId: SESSION,
    writeId: WRITE_ID,
    rowsSubmitted,
    sessionIdColumnIndex: SESSION_ID_COL,
  });
}

const GOOD = { session_id: SESSION, write_id: WRITE_ID, log_rows_written: 2 };

// ── the adjudicator ─────────────────────────────────────────────────────────

test('a complete, self-consistent receipt verifies', () => {
  const verdict = adjudicate(GOOD);
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.equal(verdict.authority, 'supabase_transaction');
  assert.equal(verdict.write_id, WRITE_ID);
  assert.equal(verdict.rows_written, 2);
  assert.equal(verdict.rows_submitted, 2);
  assert.equal(verdict.reason, null);
});

test('no receipt at all is NOT verified', () => {
  for (const missing of [undefined, null, 'nope', 42]) {
    const verdict = adjudicate(missing);
    assert.equal(verdict.verified, false);
    assert.equal(verdict.reason, 'no_receipt');
  }
});

test('a receipt with no usable row count is NOT verified', () => {
  for (const count of [undefined, null, 0, -1, 'two', 1.5]) {
    const verdict = adjudicate({ ...GOOD, log_rows_written: count });
    assert.equal(verdict.verified, false, `count=${String(count)}`);
    assert.equal(verdict.reason, 'no_row_count');
  }
});

test('a row count that disagrees with the request is NOT verified', () => {
  // The one failure a count can catch on its own: the write landed a different
  // number of rows from the number this request submitted.
  for (const count of [1, 3]) {
    const verdict = adjudicate({ ...GOOD, log_rows_written: count });
    assert.equal(verdict.verified, false, `count=${count}`);
    assert.equal(verdict.reason, 'row_count_disagrees_with_request');
  }
});

test('an empty submission is NOT verified', () => {
  for (const rowsSubmitted of [[], null, undefined, 'rows']) {
    const verdict = verifyWriteReceipt({
      receipt: { ...GOOD, log_rows_written: 1 },
      sessionId: SESSION,
      writeId: WRITE_ID,
      rowsSubmitted,
      sessionIdColumnIndex: SESSION_ID_COL,
    });
    assert.equal(verdict.verified, false, `rowsSubmitted=${JSON.stringify(rowsSubmitted)}`);
    assert.equal(verdict.reason, 'no_rows_submitted');
  }
});

// A row count alone cannot see this: the rows exist, and they belong to a different
// workout. It is the check the A1 range never performed either.
test('a receipt naming a DIFFERENT session is NOT verified', () => {
  const verdict = adjudicate({ ...GOOD, session_id: '20260806-PM-02' });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'receipt_session_mismatch');
});

test('no session id to compare against is NOT verified', () => {
  const verdict = verifyWriteReceipt({
    receipt: GOOD, sessionId: '  ', writeId: WRITE_ID,
    rowsSubmitted: [row(), row(SESSION, 2)], sessionIdColumnIndex: SESSION_ID_COL,
  });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'no_session_id');
});

// The write_id is what makes the rows addressable afterwards, so a Save whose rows
// carry a different one could not be undone by this request's client.
test('a receipt carrying a DIFFERENT write_id is NOT verified', () => {
  const verdict = adjudicate({ ...GOOD, write_id: 'w_someone_else' });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'write_id_mismatch');
});

test('no write_id to compare against is NOT verified', () => {
  const verdict = verifyWriteReceipt({
    receipt: GOOD, sessionId: SESSION, writeId: '',
    rowsSubmitted: [row(), row(SESSION, 2)], sessionIdColumnIndex: SESSION_ID_COL,
  });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'no_write_id');
});

test('a submitted row belonging to another session is NOT verified', () => {
  const verdict = adjudicate(GOOD, [row(), row('20260806-PM-02', 2)]);
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'session_id_mismatch');
});

test('session ownership is compared case- and whitespace-insensitively, as the write path does', () => {
  const padded = row(`  ${SESSION.toLowerCase()}  `, 1);
  const verdict = verifyWriteReceipt({
    receipt: { ...GOOD, log_rows_written: 1 },
    sessionId: SESSION,
    writeId: WRITE_ID,
    rowsSubmitted: [padded],
    sessionIdColumnIndex: SESSION_ID_COL,
  });
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
});

test('the module is pure — it never reaches for a client, a clock or a range', () => {
  const source = require('node:fs').readFileSync(require.resolve('../services/appendWriteProof'), 'utf8');
  assert.ok(!/require\(/.test(source), 'no dependencies at all');
  assert.ok(!/Date\.now|new Date/.test(source), 'no clock');
  // The comments explain WHY the range left the predicate, so they name it. No line
  // of code may read one.
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/updatedRange/.test(code), 'no A1 range survives in the predicate');
});

// ── the live path ───────────────────────────────────────────────────────────
//
// The real app and the real route, with the workout authority doubled — so the
// receipt under test is the one the Save actually produced, not one the test wrote.
test('a real Save publishes an adjudicated receipt that matches the write', async (t) => {
  process.env.ATLAS_API_KEY = 'test-api-key';
  process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
  process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
  process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
  process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';

  // Hermetic: the catalog reads Supabase (OWNER CORRECTION 2026-08-13). This stub also
  // blanks the ATLAS_SUPABASE_* roles, so no test can open a database connection.
  require('./helpers/stubExerciseCatalog').installExerciseCatalogStub([
    ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
    ['Back Squat', 'Back Squat', 'Legs', 'SQ01'],
  ]);
  const {
    installWorkoutAuthorityStub, workoutAuthorityStore,
  } = require('./helpers/stubWorkoutAuthority');
  installWorkoutAuthorityStub();

  const { app } = require('../index');

  const server = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify({
      date: '2026-08-06',
      session_id: SESSION,
      write_id: WRITE_ID,
      log_rows: [
        { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2 },
        { exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2 },
      ],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const verdict = body.data.log_write_verification;
  assert.ok(verdict, 'a successful Save must publish a verification verdict');
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.equal(verdict.authority, 'supabase_transaction');

  // The verdict must describe THE WRITE THAT HAPPENED — not a plausible one. Compare
  // it to what the authority actually recorded.
  const saves = workoutAuthorityStore().calls.saves;
  assert.equal(saves.length, 1, 'exactly one Save transaction');
  assert.equal(verdict.write_id, saves[0].writeId);
  assert.equal(verdict.rows_written, saves[0].logCells.length);
  assert.equal(verdict.rows_submitted, saves[0].logCells.length);
  assert.equal(verdict.rows_written, body.data.log_rows_written);

  // AND NO RANGE IS PUBLISHED, anywhere. A client reading `logAppendedRange` would be
  // reading a claim about a Google Sheets append that did not happen.
  assert.equal(body.data.logAppendedRange, undefined);
  assert.equal(verdict.range, undefined);
});
