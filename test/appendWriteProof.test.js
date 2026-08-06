'use strict';

// APPEND-RECEIPT WRITE PROOF — the guard for the write-verification authority.
//
// C3 of the read-budget corrective retires `GET /api/log-workout/verify-range` from the
// normal Save path. That is an AUTHORITY change, so it is proved at two levels here:
//
//   • the adjudicator itself (`services/appendWriteProof.js`) — every way a receipt can be
//     insufficient must produce `verified: false` WITH an exact reason, because the whole
//     point is that a missing or self-contradicting receipt must never read as a
//     confirmation;
//   • the live path — a real `POST /api/log-workout` against the real Express app and the
//     real `sheets.js` must publish an adjudicated receipt whose range and row count match
//     what the append actually reported.
//
// The client half — that exactly one verification path runs per successful Save, and that
// it is not the read-back — is proved in `tests/e2e/write-verification-authority.spec.js`,
// where the request either happens or does not.

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyAppendReceipt } = require('../services/appendWriteProof');
const { logCleanedColumns } = require('../config/columns');

const SESSION_ID_COL = logCleanedColumns.indexOf('session_id');
const SESSION = '20260806-AM-01';

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
  return verifyAppendReceipt({
    receipt,
    tab: 'Log_Cleaned',
    sessionId: SESSION,
    rowsSubmitted,
    sessionIdColumnIndex: SESSION_ID_COL,
  });
}

// ── the adjudicator ─────────────────────────────────────────────────────────
test('a complete, self-consistent receipt verifies', () => {
  const verdict = adjudicate({ updatedRange: 'Log_Cleaned!A200:L201', updatedRows: 2 });
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
  assert.equal(verdict.authority, 'append_receipt');
  assert.equal(verdict.range, 'Log_Cleaned!A200:L201');
  assert.equal(verdict.rows_written, 2);
  assert.equal(verdict.rows_submitted, 2);
  assert.equal(verdict.reason, null);
});

test('a tab name quoted by Sheets still verifies', () => {
  const verdict = verifyAppendReceipt({
    receipt: { updatedRange: "'Log Cleaned'!A200:L201", updatedRows: 2 },
    tab: 'Log Cleaned',
    sessionId: SESSION,
    rowsSubmitted: [row(), row(SESSION, 2)],
    sessionIdColumnIndex: SESSION_ID_COL,
  });
  assert.equal(verdict.verified, true, JSON.stringify(verdict));
});

// Every one of these is a way the receipt could look like proof without being proof. Each
// must name its exact defect: an unexplained `verified: false` is what let the old
// read-back exist as a second opinion in the first place.
const INSUFFICIENT = [
  ['no receipt at all', undefined, 'no_receipt'],
  ['an empty receipt', {}, 'no_range'],
  ['a range with no row count', { updatedRange: 'Log_Cleaned!A200:L201' }, 'no_row_count'],
  ['a row count with no range', { updatedRows: 2 }, 'no_range'],
  ['a zero row count', { updatedRange: 'Log_Cleaned!A200:L201', updatedRows: 0 }, 'no_row_count'],
  ['a non-numeric row count', { updatedRange: 'Log_Cleaned!A200:L201', updatedRows: 'two' }, 'no_row_count'],
  ['an unparseable range', { updatedRange: 'Log_Cleaned!whatever', updatedRows: 2 }, 'range_unparseable'],
  ['a range on another tab', { updatedRange: 'Effort!A200:L201', updatedRows: 2 }, 'wrong_tab'],
  ['a range not starting at column A', { updatedRange: 'Log_Cleaned!B200:L201', updatedRows: 2 }, 'range_does_not_start_at_column_a'],
  // The receipt contradicting ITSELF — twelve rows claimed, two rows of range.
  ['a span that disagrees with the row count', { updatedRange: 'Log_Cleaned!A200:L201', updatedRows: 12 }, 'range_span_disagrees_with_row_count'],
  // The receipt contradicting the REQUEST — a partial append must never read as verified.
  ['fewer rows written than submitted', { updatedRange: 'Log_Cleaned!A200:L200', updatedRows: 1 }, 'row_count_disagrees_with_request'],
];
for (const [label, receipt, reason] of INSUFFICIENT) {
  test(`${label} is not proof, and says exactly why (${reason})`, () => {
    const verdict = adjudicate(receipt);
    assert.equal(verdict.verified, false, JSON.stringify(verdict));
    assert.equal(verdict.reason, reason, JSON.stringify(verdict));
  });
}

test('rows belonging to another session are not proof of THIS session', () => {
  const verdict = adjudicate(
    { updatedRange: 'Log_Cleaned!A200:L201', updatedRows: 2 },
    [row(), row('20260806-PM-09', 2)]
  );
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'session_id_mismatch');
});

test('a blank session id can never verify', () => {
  const verdict = verifyAppendReceipt({
    receipt: { updatedRange: 'Log_Cleaned!A200:L200', updatedRows: 1 },
    tab: 'Log_Cleaned',
    sessionId: '   ',
    rowsSubmitted: [row('   ')],
    sessionIdColumnIndex: SESSION_ID_COL,
  });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.reason, 'no_session_id');
});

test('the adjudicator never mutates its inputs', () => {
  const receipt = { updatedRange: 'Log_Cleaned!A200:L201', updatedRows: 2 };
  const rows = [row(), row(SESSION, 2)];
  const frozen = JSON.stringify({ receipt, rows });
  adjudicate(receipt, rows);
  assert.equal(JSON.stringify({ receipt, rows }), frozen);
});

// ── the live path ───────────────────────────────────────────────────────────
//
// The real app, the real sheets.js, only `googleapis` faked — so the receipt under test is
// the one the append actually produced, not one the test authored.
test('a real Save publishes an adjudicated receipt that matches the append', async (t) => {
  process.env.ATLAS_API_KEY = 'test-api-key';
  process.env.GOOGLE_SHEETS_ID = 'test-spreadsheet-id';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
  process.env.GOOGLE_PRIVATE_KEY = 'KEYLINE1\\nKEYLINE2\\n';
  process.env.ATLAS_API_RATE_LIMIT_MAX = '1000000';
  process.env.ATLAS_WRITE_RATE_LIMIT_MAX = '1000000';
  process.env.ATLAS_IDEMPOTENCY_FILE = require('node:path').join(
    require('node:os').tmpdir(), 'atlas-append-write-proof-idempotency.json');

  const { effortColumns } = require('../config/columns');
  const SHEET = {
    Log_Cleaned: [[...logCleanedColumns]],
    Effort: [[...effortColumns]],
    Exercise_Catalog: [
      ['Exercise', 'Canonical_Name', 'Muscle_Group', 'Lift_Code'],
      ['Back Squat', 'Back Squat', 'Legs', 'SQ01'],
    ],
  };
  const appended = [];
  const fake = {
    spreadsheets: {
      get: async () => ({ data: { sheets: Object.keys(SHEET).map(title => ({ properties: { title, sheetId: 1 } })) } }),
      batchUpdate: async () => ({ data: {} }),
      values: {
        get: async ({ range }) => {
          const tab = String(range).split('!')[0];
          const rows = SHEET[tab];
          if (!rows) throw new Error(`Unable to parse range: ${range}`);
          return { data: { values: /!1:1$/.test(range) ? [rows[0]] : rows } };
        },
        batchGet: async ({ ranges }) => ({
          data: {
            valueRanges: ranges.map(range => {
              const tab = String(range).split('!')[0];
              const rows = SHEET[tab] || [];
              return { range, values: /!1:1$/.test(range) ? [rows[0]] : rows };
            }),
          },
        }),
        append: async ({ range, requestBody }) => {
          const tab = String(range).split('!')[0];
          if (!SHEET[tab]) SHEET[tab] = [];
          for (const r of requestBody.values) SHEET[tab].push(r.map(v => (v == null ? '' : String(v))));
          const n = requestBody.values.length;
          const last = SHEET[tab].length;
          const updates = { updatedRows: n, updatedRange: `${tab}!A${last - n + 1}:L${last}` };
          if (tab === 'Log_Cleaned') appended.push({ updates, rows: requestBody.values });
          return { data: { updates } };
        },
        update: async () => ({ data: {} }),
        batchUpdate: async () => ({ data: { totalUpdatedCells: 0 } }),
      },
    },
  };
  const googleapisPath = require.resolve('googleapis');
  const previous = require.cache[googleapisPath];
  require.cache[googleapisPath] = {
    id: googleapisPath, filename: googleapisPath, loaded: true,
    exports: { google: { auth: { GoogleAuth: class { async getClient() { return {}; } } }, sheets: () => fake } },
  };
  t.after(() => { if (previous) require.cache[googleapisPath] = previous; else delete require.cache[googleapisPath]; });

  const { app } = require('../index');
  // The idempotency store persists to disk and rehydrates, so a write_id from an earlier
  // run of this file would be replayed as a duplicate — the recorded response, and NO
  // append. That would leave the assertions below comparing the verdict against nothing.
  require('../services/idempotency').resetIdempotencyStore();

  const server = await new Promise(resolve => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/log-workout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': 'test-api-key' },
    body: JSON.stringify({
      date: '2026-08-06',
      session_id: SESSION,
      write_id: 'w_append_proof_1',
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
  assert.equal(verdict.authority, 'append_receipt');

  // The verdict must describe THE APPEND THAT HAPPENED — not a plausible one. Compare it
  // to what the Sheets client itself reported at the boundary.
  assert.equal(appended.length, 1, 'exactly one Log_Cleaned append');
  assert.equal(verdict.range, appended[0].updates.updatedRange);
  assert.equal(verdict.rows_written, appended[0].updates.updatedRows);
  assert.equal(verdict.rows_submitted, appended[0].rows.length);
  assert.equal(verdict.range, body.data.logAppendedRange,
    'the verdict and the forwarded range must be the same range');

  // And the rows really are in the sheet, under this session — the fact the retired
  // read-back used to establish, now established without a read.
  const written = SHEET.Log_Cleaned.slice(1);
  assert.equal(written.length, 2);
  for (const r of written) assert.equal(r[SESSION_ID_COL], SESSION);
});
