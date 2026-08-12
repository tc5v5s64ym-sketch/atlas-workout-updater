'use strict';

// A PADDED EMPTY SHEETS ARRAY IS NOT A ROW.
//
// Google Sheets' `values.get` returns every row above a stray row below the data
// block as an all-blank array. Production Effort carries 924 of them — padding to
// reach a 4-row tail block at sheet rows 1015-1018. The backfill counted each as an
// identityless AUTHORITATIVE row and escalated `OWNER ACTION REQUIRED` for all 924,
// which both invented 924 owner decisions and buried the two genuinely identityless
// Log_Cleaned rows (sheet rows 1046 and 1054) inside that number.
//
// The fix is ONE predicate on the row contract consumed by BOTH the backfill and the
// sweep. These proofs hold the line in both directions:
//
//   1. an all-blank array is `blank`, never `identityless`, in both consumers;
//   2. A ROW WITH EVEN ONE POPULATED CELL IS STILL A ROW and still fails — this is
//      the mutation guard, and it is the proof that matters. Widening the predicate
//      to "looks mostly empty" would silently drop the exact two authoritative rows
//      the identityless check exists to surface.

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../services/migrationRowContract');
const { runBackfill } = require('../services/migrationBackfill');
const { indexByIdentity } = require('../services/migrationSweep');

// ── The predicate itself ──────────────────────────────────────────────────────

test('blank-row predicate: an all-blank Sheets array is not a row', () => {
  assert.equal(contract.isBlankSheetRow([]), true);
  assert.equal(contract.isBlankSheetRow(['', '', '', '', '']), true);
  assert.equal(contract.isBlankSheetRow(['  ', '\t', '']), true);
  assert.equal(contract.isBlankSheetRow([undefined, null, '']), true);
});

test('blank-row predicate: ONE non-blank cell disqualifies — the mutation guard', () => {
  // Exactly the shape of production Log_Cleaned rows 1046 and 1054: cells 0-2 blank,
  // a value in canonical_exercise and muscle_group, nothing else. These rows carry no
  // set and no identity, and they MUST keep failing the migration until the owner
  // dispositions them. If this assertion ever flips, an authoritative row is being
  // silently discarded.
  assert.equal(contract.isBlankSheetRow(['', '', '', 'Something', 'Something']), false);
  assert.equal(contract.isBlankSheetRow(['', '', '', '', '0']), false);
  assert.equal(contract.isBlankSheetRow(['x']), false);
  assert.equal(contract.isBlankSheetRow(['', ' . ', '']), false);
});

test('blank-row predicate: it is Sheets-side only — a Supabase row object is never blank', () => {
  // The sweep feeds the same index function from both sides. A Supabase row arrives
  // as an object, so an empty destination row can never be swallowed as padding.
  assert.equal(contract.isBlankSheetRow({}), false);
  assert.equal(contract.isBlankSheetRow({ session_id: null, exercise: null }), false);
  assert.equal(contract.isBlankSheetRow(null), false);
  assert.equal(contract.isBlankSheetRow(undefined), false);
});

// ── Consumer 1: the backfill ──────────────────────────────────────────────────

// Log_Cleaned contract order: date_clean, session_id, exercise, canonical_exercise,
// muscle_group, lift_code, set_number, weight, reps, rir, notes, volume_calc.
const GOOD_LOG_ROW = ['2026-08-01', '20260801-AM-01', 'Bench Press', 'Bench Press', 'Chest', 'BP', '1', '225', '5', '2', '', '1125'];
const FRAGMENT_LOG_ROW = ['', '', '', 'Something', 'Something'];
const BLANK_LOG_ROW = ['', '', '', '', '', '', '', '', '', '', '', ''];

function stubSheets(rowsByTab) {
  return { getSheetRows: async (tab) => (rowsByTab[tab] || []).map((r) => r.slice()) };
}
const INERT_ADAPTER = { listConcept: async () => [], backfillRows: async () => ({ inserted: 0, existing: 0 }) };

test('backfill: padded blank rows are counted as blank, never as identityless', async () => {
  const result = await runBackfill({
    sheets: stubSheets({ Log_Cleaned: [GOOD_LOG_ROW, BLANK_LOG_ROW, BLANK_LOG_ROW, BLANK_LOG_ROW] }),
    adapter: INERT_ADAPTER,
    concepts: ['logged_sets'],
    includeCatalog: false,
  });
  const plan = result.concepts[0];
  assert.equal(plan.rows_skipped_blank, 3);
  assert.equal(plan.rows_skipped_no_identity, 0);
  assert.equal(plan.rows_with_identity, 1);
  assert.equal(plan.error, null, 'padding must not escalate OWNER ACTION REQUIRED');
  assert.equal(result.complete, true);
});

test('backfill: a one-cell fragment still fails the run as identityless', async () => {
  const result = await runBackfill({
    sheets: stubSheets({ Log_Cleaned: [GOOD_LOG_ROW, BLANK_LOG_ROW, FRAGMENT_LOG_ROW] }),
    adapter: INERT_ADAPTER,
    concepts: ['logged_sets'],
    includeCatalog: false,
  });
  const plan = result.concepts[0];
  assert.equal(plan.rows_skipped_blank, 1);
  assert.equal(plan.rows_skipped_no_identity, 1);
  assert.match(String(plan.error), /sheets_identityless: 1 authoritative row/);
  assert.match(String(plan.error), /OWNER ACTION REQUIRED/);
  assert.equal(result.complete, false, 'an identityless authoritative row must still fail the run');
});

test('backfill: blank rows stay out of the skipped total', async () => {
  const result = await runBackfill({
    sheets: stubSheets({ Log_Cleaned: [GOOD_LOG_ROW, BLANK_LOG_ROW, BLANK_LOG_ROW] }),
    adapter: INERT_ADAPTER,
    concepts: ['logged_sets'],
    includeCatalog: false,
  });
  assert.equal(result.totals.skipped, 0, 'padding was never a candidate row');
  assert.equal(result.totals.rows_skipped_blank, 2);
});

// ── Consumer 2: the sweep ─────────────────────────────────────────────────────

test('sweep: indexByIdentity separates blank padding from identityless rows', () => {
  const indexed = indexByIdentity(
    'logged_sets',
    [GOOD_LOG_ROW, BLANK_LOG_ROW, BLANK_LOG_ROW, FRAGMENT_LOG_ROW],
    (cells) => contract.rowFromSheet('logged_sets', cells)
  );
  assert.equal(indexed.blank, 2);
  assert.equal(indexed.identityless, 1, 'the fragment is still an identityless authoritative row');
  assert.equal(indexed.index.size, 1);
});

test('sweep and backfill cannot disagree about which arrays are rows', async () => {
  // ONE predicate, two consumers. The defect this replaces was two near-miss guards
  // in two modules; the proof is that both now return the same verdict for the same
  // input, so a future edit to one cannot silently drift from the other.
  const rows = [GOOD_LOG_ROW, BLANK_LOG_ROW, BLANK_LOG_ROW, BLANK_LOG_ROW, FRAGMENT_LOG_ROW];
  const swept = indexByIdentity('logged_sets', rows, (cells) => contract.rowFromSheet('logged_sets', cells));
  const result = await runBackfill({
    sheets: stubSheets({ Log_Cleaned: rows }),
    adapter: INERT_ADAPTER,
    concepts: ['logged_sets'],
    includeCatalog: false,
  });
  const plan = result.concepts[0];
  assert.equal(swept.blank, plan.rows_skipped_blank);
  assert.equal(swept.identityless, plan.rows_skipped_no_identity);
});

// ── The production shape, reproduced ──────────────────────────────────────────

test('backfill: the production Effort padding shape no longer escalates to the owner', async () => {
  // Effort contract order: date, session_id, duration, active_calories,
  // total_calories, average_hr, peak_hr, location, notes. Production holds 89 real
  // rows, a 924-row blank gap, then a 4-row tail. Reproduced at small scale: the
  // gap must produce zero owner escalations.
  const real = ['2026-06-11', '20260611-PM-01', '01:02:03', '300', '400', '120', '150', 'Gym', ''];
  const blank = ['', '', '', '', '', '', '', '', ''];
  const rows = [real, ...Array.from({ length: 24 }, () => blank.slice()), real.slice()];
  rows[rows.length - 1][1] = '20260612-PM-01';

  const result = await runBackfill({
    sheets: stubSheets({ Effort: rows }),
    adapter: INERT_ADAPTER,
    concepts: ['session_effort'],
    includeCatalog: false,
  });
  const plan = result.concepts[0];
  assert.equal(plan.sheet_rows_read, 26);
  assert.equal(plan.rows_skipped_blank, 24);
  assert.equal(plan.rows_skipped_no_identity, 0);
  assert.equal(plan.rows_with_identity, 2);
  assert.equal(plan.error, null);
});
