'use strict';

// The S3 backfill and its reconciliation report.
// TEMPORARY — S4 deletes this module with the backfill script and proves it absent.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.3 (PR S3), §4 (the
// field-by-field mapping), §4.7 (the blank-versus-null rule), §6.2 P3.
//
// ── WHAT IT MOVES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────
// It backfills exactly the tables the workbook can source:
//
//     logged_sets · session_effort · session_plan_events ·
//     session_plan_set_recommendations
//
// plus, through the existing catalog sync, exercise_catalog_mirror and its first
// exercise_catalog_sync generation. workout_sessions parents are created by the
// adapter as each child's parent, derived by parsing session_id.
//
// It does NOT touch:
//   • write_receipts — the workbook stores no write_id (§3.6), so there is nothing
//     to source. The file store in services/idempotency.js stays the SOLE receipt
//     authority through S3, and the §5.3 seam is how it hands over at S4. A
//     backfilled receipt would be a fabricated one.
//   • sheets_mirror_cursor / sheets_mirror_allocations — the cursor takes its base
//     at cutover (§5.5 step 4), not from the backfill. A base recorded now would be
//     stale by the time it was used.
//   • logged_sets.write_id / session_effort.write_id — NULL by design through
//     S2 and S3. Nothing here invents one.
//
// ── IT MOVES NO AUTHORITY ────────────────────────────────────────────────────
// Google Sheets decides every athlete-facing read and every write until S4. This
// is a one-way copy INTO an inert destination, run once per environment.
//
// ── IDEMPOTENT BY IDENTITY ───────────────────────────────────────────────────
// Every insert is ON CONFLICT DO NOTHING on the concept's own identity, so a
// re-run converges rather than duplicating or failing. A resumed run after an
// interruption is therefore safe, and `inserted` versus `existing` says exactly
// what this run added.

const contract = require('./migrationRowContract');
const { indexByIdentity } = require('./migrationSweep');
const catalogMirror = require('./exerciseCatalogMirror');

// Rows are written in bounded transactions. Large enough that a full workbook is
// not thousands of round trips, small enough that one failure does not discard an
// hour of work — and small enough to stay well inside any statement timeout.
const DEFAULT_BATCH_SIZE = 200;

function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function emptyConceptPlan(concept) {
  return {
    concept,
    tab: contract.conceptSpec(concept).tab,
    sheet_rows_read: 0,
    rows_with_identity: 0,
    rows_skipped_no_identity: 0,
    rows_skipped_unparseable_session: 0,
    inserted: 0,
    existing: 0,
    error: null,
  };
}

// A Sheets row is BACKFILLABLE only when it has an export identity AND, where the
// concept has a session parent, a session_id the parent contract can parse.
//
// A row that fails either is REPORTED AND SKIPPED, never guessed at. The sweep then
// opens a divergence for it, which is the correct outcome: Sheets is the authority
// and holds a row Supabase cannot represent, and only the owner can decide what a
// malformed historical row means. Silently inventing a parent would put a
// fabricated session into the destination.
function classifyRow(concept, row) {
  const identity = contract.identityKey(concept, row);
  if (!identity || identity === '||' || identity === '') return 'no_identity';
  const sessionId = contract.sessionIdOf(concept, row);
  if (sessionId && !contract.parseSessionId(sessionId)) return 'unparseable_session';
  return 'ok';
}

async function backfillConcept({ concept, sheets, adapter, apply, batchSize }) {
  const plan = emptyConceptPlan(concept);
  const spec = contract.conceptSpec(concept);

  let sheetRows;
  try {
    sheetRows = await sheets.getSheetRows(spec.tab);
  } catch (error) {
    plan.error = `sheets_read_failed: ${error.message}`;
    return plan;
  }
  plan.sheet_rows_read = sheetRows.length;

  const rows = [];
  for (const cells of sheetRows) {
    const row = contract.rowFromSheet(concept, cells);
    const verdict = classifyRow(concept, row);
    if (verdict === 'no_identity') { plan.rows_skipped_no_identity += 1; continue; }
    if (verdict === 'unparseable_session') { plan.rows_skipped_unparseable_session += 1; continue; }
    rows.push(row);
  }
  plan.rows_with_identity = rows.length;

  // A DRY RUN IS THE DEFAULT. It reads both sides and reports what it WOULD write,
  // and it is the only mode that runs without an explicit --apply.
  if (!apply) return plan;

  for (const batch of chunk(rows, batchSize)) {
    try {
      const result = await adapter.backfillRows(concept, batch);
      plan.inserted += result.inserted;
      plan.existing += result.existing;
    } catch (error) {
      // Stop this concept and report. Earlier batches are committed and the run is
      // resumable, because every insert is idempotent by identity.
      plan.error = `backfill_failed after ${plan.inserted} inserted: ${error.message}`;
      return plan;
    }
  }
  return plan;
}

// ── The reconciliation report (§6.2 P3) ──────────────────────────────────────
//
// P3 requires THREE things per tab, and a count match alone is explicitly not
// reconciliation: equal row counts, every row matched by its EXPORT IDENTITY KEY,
// and a FIELD-BY-FIELD comparison reporting zero differences once §4.7's
// blank/null rule is applied.
//
// It reuses migrationSweep's indexByIdentity and the row contract's compareRows,
// so it cannot disagree with the sweep about what a row is, what its identity is,
// or whether two copies are equal. This is a REPORT; the sweep remains the
// completeness authority and the divergence rows remain the durable record.
//
// REDACTED BY CONSTRUCTION. Differences are reported as field names and SHAPES —
// `int(3)`, `decimal`, `text(len=12)`, `null` — never as loads, reps or notes,
// exactly as §3.8 requires of comparison_result. The report is committed as
// evidence, so it may not contain workout values.
async function reconcileConcept({ concept, sheets, adapter }) {
  const spec = contract.conceptSpec(concept);
  const result = {
    concept,
    tab: spec.tab,
    reconciled: false,
    sheets_rows: 0,
    supabase_rows: 0,
    counts_equal: false,
    matched_by_identity: 0,
    missing_in_supabase: 0,
    missing_in_sheets: 0,
    content_mismatch: 0,
    sheets_duplicate_identities: 0,
    field_differences: {},
    error: null,
  };

  let sheetRows;
  try {
    sheetRows = await sheets.getSheetRows(spec.tab);
  } catch (error) {
    result.error = `sheets_read_failed: ${error.message}`;
    return result;
  }

  let supabaseRows;
  try {
    supabaseRows = await adapter.listConcept(concept);
  } catch (error) {
    result.error = `supabase_read_failed: ${error.message}`;
    return result;
  }

  const left = indexByIdentity(concept, sheetRows, (cells) => contract.rowFromSheet(concept, cells));
  const right = indexByIdentity(concept, supabaseRows, (row) => contract.rowFromSupabase(concept, row));

  result.sheets_rows = left.index.size;
  result.supabase_rows = right.index.size;
  result.counts_equal = left.index.size === right.index.size;
  result.sheets_duplicate_identities = left.duplicates.length;

  for (const [key, row] of left.index) {
    const counterpart = right.index.get(key);
    if (!counterpart) { result.missing_in_supabase += 1; continue; }
    const comparison = contract.compareRows(concept, row, counterpart);
    if (comparison.equal) { result.matched_by_identity += 1; continue; }
    result.content_mismatch += 1;
    for (const difference of comparison.differences) {
      const bucket = result.field_differences[difference.field] || { count: 0, examples: [] };
      bucket.count += 1;
      // At most three SHAPE pairs per field: enough to diagnose a systematic
      // mapping fault, and never enough to reconstruct a value.
      if (bucket.examples.length < 3) {
        bucket.examples.push({ sheets: difference.sheets, supabase: difference.supabase });
      }
      result.field_differences[difference.field] = bucket;
    }
  }
  for (const key of right.index.keys()) {
    if (!left.index.has(key)) result.missing_in_sheets += 1;
  }

  // RECONCILED means all three P3 conditions hold at once. A duplicate Sheets
  // identity blocks it too: Supabase's unique index can hold only one of the two
  // rows, so the tab is not reconcilable and reporting a zero would be the false
  // green the whole lane exists to prevent.
  result.reconciled =
    result.counts_equal &&
    result.missing_in_supabase === 0 &&
    result.missing_in_sheets === 0 &&
    result.content_mismatch === 0 &&
    result.sheets_duplicate_identities === 0;

  return result;
}

async function reconcile({ sheets, adapter, concepts = contract.CONCEPT_NAMES } = {}) {
  const tabs = [];
  for (const concept of concepts) {
    tabs.push(await reconcileConcept({ concept, sheets, adapter }));
  }
  return {
    // A reconciliation that could not read a side is NOT a pass. Every gate that
    // reads `reconciled` must read `complete` with it.
    complete: tabs.every((t) => t.error === null),
    reconciled: tabs.length > 0 && tabs.every((t) => t.error === null && t.reconciled),
    tabs,
  };
}

// ── The catalog's first generation ───────────────────────────────────────────
//
// Reuses the PERMANENT sync (services/exerciseCatalogMirror.js) rather than
// writing catalog rows here. The mirror's swap, verification, content hash and
// failure recording are the same machinery that keeps it current afterwards, so
// the first generation is produced by exactly the path every later generation
// takes. A backfill-specific catalog writer would be a second way to populate the
// mirror, and the freshness rules would then have two sources.
async function backfillCatalog({ sheets, adapter, apply }) {
  if (!apply) {
    return { concept: contract.CATALOG_CONCEPT, applied: false, ok: null, note: 'dry run — no generation written' };
  }
  const result = await catalogMirror.syncCatalog({ sheets, adapter });
  return {
    concept: contract.CATALOG_CONCEPT,
    applied: true,
    ok: result.ok,
    sync_id: result.sync_id || null,
    rows: result.rows || 0,
    content_hash: result.content_hash || null,
    error: result.ok ? null : `${result.code}: ${result.error}`,
  };
}

async function runBackfill({
  sheets,
  adapter,
  concepts = contract.CONCEPT_NAMES,
  includeCatalog = true,
  apply = false,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const plans = [];
  for (const concept of concepts) {
    plans.push(await backfillConcept({ concept, sheets, adapter, apply, batchSize }));
  }
  const catalog = includeCatalog ? await backfillCatalog({ sheets, adapter, apply }) : null;

  const failed = plans.filter((p) => p.error !== null);
  return {
    applied: apply,
    // A run with any concept error is NOT complete, whatever the counts say.
    complete: failed.length === 0 && (!catalog || catalog.applied === false || catalog.ok === true),
    concepts: plans,
    catalog,
    totals: plans.reduce(
      (acc, p) => ({
        sheet_rows_read: acc.sheet_rows_read + p.sheet_rows_read,
        rows_with_identity: acc.rows_with_identity + p.rows_with_identity,
        inserted: acc.inserted + p.inserted,
        existing: acc.existing + p.existing,
        skipped: acc.skipped + p.rows_skipped_no_identity + p.rows_skipped_unparseable_session,
      }),
      { sheet_rows_read: 0, rows_with_identity: 0, inserted: 0, existing: 0, skipped: 0 }
    ),
  };
}

module.exports = {
  runBackfill,
  backfillConcept,
  backfillCatalog,
  reconcile,
  reconcileConcept,
  classifyRow,
  DEFAULT_BATCH_SIZE,
};
