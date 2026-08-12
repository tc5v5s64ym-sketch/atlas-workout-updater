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
//
// ── THE DRY RUN READS THE DESTINATION ────────────────────────────────────────
// Without `apply` nothing is written to either store, but Supabase IS read, so
// the run can answer the only question a preflight is for: of the eligible source
// rows, how many WOULD be inserted (`would_insert`) and how many are ALREADY
// present (`already_present`). Those two fields are dry-run-only and are `null`
// — never 0 — when they were not computed.



const contract = require('./migrationRowContract');
const legacyMap = require('./migrationLegacyIdentityMap');
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
    // Padded all-blank arrays returned by `values.get` to reach a stray row below
    // the data block. Reported separately BECAUSE they are not history: they are
    // neither backfillable nor owner-actionable, and counting them as identityless
    // authoritative rows escalated 924 empty Effort arrays while hiding the two
    // genuinely identityless Log_Cleaned rows inside the same number.
    rows_skipped_blank: 0,
    // Rows the owner's frozen rulings remove from migration scope, and rows whose
    // legacy session id the frozen map translated to a canonical one. Both are
    // reported so a reader can see exactly how much of the run the bridge touched.
    rows_excluded_by_owner_ruling: 0,
    rows_translated_from_legacy: 0,
    // Surplus copies of an owner-approved exact-duplicate fingerprint, removed at the
    // approved multiplicity. Reported separately from `rows_excluded_by_owner_ruling`
    // because an identical copy is not the same disposition as an excluded record.
    rows_surplus_identical_excluded: 0,
    // Approved exact-duplicate fingerprints whose actual multiplicity is not the
    // frozen one. Non-empty means the run FAILS.
    duplicate_multiplicity_mismatches: [],
    // Legacy ids the frozen map does not cover. Non-empty means the run FAILS.
    unmapped_legacy_session_ids: [],
    inserted: 0,
    existing: 0,
    // DRY-RUN ONLY, and `null` means NOT COMPUTED rather than zero. An apply run
    // leaves them null because `inserted`/`existing` already carry its truth;
    // a dry run fills them from a real read of the destination. The two states
    // must stay distinguishable — reporting 0 for "never looked" is the exact
    // defect this pair was added to remove.
    would_insert: null,
    already_present: null,
    // Distinct source identities carrying more than one Sheets row. Counted on a
    // dry run because it is the reason `would_insert` is a count of IDENTITIES
    // rather than of rows; `null` when no dry run computed it.
    sheets_duplicate_identities: null,
    error: null,
  };
}

// WHAT DECIDES A ROW NOW LIVES IN ONE PLACE.
//
// `classifyRow` used to answer "is this row backfillable?" here, while the sweep
// answered the same question through its own index. Both survived only because they
// agreed by accident. `migrationLegacyIdentityMap.resolveSheetRows` is now the single
// answer — blank, excluded, identityless, canonical, translated or unmapped — and both
// consumers take its verdicts verbatim. A second classifier in this module would be
// the exact authority defect the frozen map exists to close, so there is none.

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

  // ONE RESOLVER, SHARED WITH THE SWEEP. It applies the blank-row predicate, the
  // frozen row-level exclusions, the identityless test, and the frozen legacy
  // translation, in that order. The backfill does not re-decide any of them, so it
  // cannot disagree with the sweep about a mapping, an exclusion, or a verdict.
  const resolved = legacyMap.resolveSheetRows(concept, sheetRows);
  const rows = resolved.rows;
  plan.rows_skipped_blank = resolved.counts.blank;
  plan.rows_skipped_no_identity = resolved.counts.no_identity;
  plan.rows_excluded_by_owner_ruling = resolved.counts.excluded_row + resolved.counts.excluded_session;
  plan.rows_translated_from_legacy = resolved.counts.translated;
  plan.rows_surplus_identical_excluded = resolved.counts.surplus_identical;
  plan.duplicate_multiplicity_mismatches = resolved.duplicateMismatches;
  // A LEGACY ID ABSENT FROM THE FROZEN MAP IS A FAILURE, NEVER A SKIP. It replaces
  // the old `unparseable_session` skip counter: every legacy id in the corpus now
  // either translates through an owner-approved entry or fails the run.
  plan.rows_skipped_unparseable_session = resolved.counts.unmapped_legacy;
  plan.unmapped_legacy_session_ids = resolved.unmapped;
  plan.rows_with_identity = rows.length;

  // A DRY RUN IS THE DEFAULT, and it READS THE DESTINATION. It is the only mode
  // that runs without an explicit --apply, and it writes nothing to either store.
  //
  // It used to return here, before consulting Supabase at all, and therefore
  // reported `inserted=0 existing=0` whatever the destination held — a preflight
  // whose output was identical for "everything is already there" and "nothing is
  // there yet". The owner's requirement is the opposite: a dry run must truthfully
  // separate what WOULD be inserted from what is ALREADY present.
  //
  // It reuses the sweep's `indexByIdentity` and the row contract's identity key, so
  // the dry run cannot disagree with the sweep or the reconciliation about what a
  // row is or whether the destination already holds it.
  if (!apply) {
    let destinationRows;
    try {
      destinationRows = await adapter.listConcept(concept);
    } catch (error) {
      // A destination read that failed is NOT a zero. Reporting one would restore
      // the defect in a new form, so this fails the concept and the whole run.
      plan.error = `supabase_read_failed: ${error.message}`;
      return plan;
    }
    const present = indexByIdentity(concept, destinationRows, (row) => contract.rowFromSupabase(concept, row));

    // THE SOURCE IS INDEXED BY IDENTITY TOO, and that is not symmetry for its own
    // sake. *Required review of `63e39a3`, finding P1.* Two Sheets rows can carry
    // ONE export identity, and `ON CONFLICT DO NOTHING` means an apply run inserts
    // the first and classifies the second as existing. Counting the source rows
    // one by one therefore reported two pending inserts where apply performs one —
    // a preflight OVERSTATING the work, which is the same class of lie as the
    // understatement this change removed. Indexing collapses them exactly the way
    // the destination's unique index will.
    //
    // `indexByIdentity` is the sweep's, so the duplicate verdict here cannot
    // disagree with the sweep's or the reconciliation's, and the count is surfaced
    // under the name `reconcileConcept` already uses rather than a second one.
    const source = indexByIdentity(concept, rows, (row) => row);
    plan.sheets_duplicate_identities = source.duplicates.length;

    plan.would_insert = 0;
    plan.already_present = 0;
    for (const key of source.index.keys()) {
      // Identity is the ONLY question here, because every insert is
      // ON CONFLICT DO NOTHING on exactly this key: an identity already in the
      // destination would be skipped by the apply run whatever its content says.
      // Content equality is the RECONCILIATION's question (§6.2 P3), not the
      // backfill's, and answering it here would give the two lanes two verdicts.
      if (present.index.has(key)) plan.already_present += 1;
      else plan.would_insert += 1;
    }
    return plan;
  }

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
    sheets_identityless: 0,
    supabase_identityless: 0,
    sheets_blank_rows: 0,
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

  // The SAME resolver again — the reconciliation report is the third reader of the
  // frozen map and must not become a third opinion about it.
  const resolved = legacyMap.resolveSheetRows(concept, sheetRows);
  const left = indexByIdentity(concept, [...resolved.rows, ...resolved.unmappedRows], (row) => row);
  const right = indexByIdentity(concept, supabaseRows, (row) => contract.rowFromSupabase(concept, row));

  result.sheets_rows = left.index.size;
  result.supabase_rows = right.index.size;
  result.counts_equal = left.index.size === right.index.size;
  result.sheets_duplicate_identities = left.duplicates.length;
  result.sheets_identityless = resolved.counts.no_identity;
  result.supabase_identityless = right.identityless;
  result.sheets_blank_rows = resolved.counts.blank;
  result.sheets_excluded_by_owner_ruling = resolved.counts.excluded_row + resolved.counts.excluded_session;
  result.sheets_translated_from_legacy = resolved.counts.translated;
  result.sheets_unmapped_legacy = resolved.counts.unmapped_legacy;
  result.sheets_surplus_identical_excluded = resolved.counts.surplus_identical;
  result.sheets_duplicate_multiplicity_mismatch = resolved.counts.duplicate_multiplicity_mismatch;

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
  //
  // An IDENTITYLESS authoritative row blocks it for the stronger version of the
  // same reason: it is not merely unrepresentable, it is unmatchable, so "every
  // row matched by its export identity key" is FALSE for this tab however equal
  // the counts look. Counting it out of both sides would have made the counts
  // agree and the reconciliation lie.
  result.reconciled =
    result.counts_equal &&
    result.missing_in_supabase === 0 &&
    result.missing_in_sheets === 0 &&
    result.content_mismatch === 0 &&
    result.sheets_duplicate_identities === 0 &&
    result.sheets_identityless === 0 &&
    // An UNMAPPED legacy id blocks it for the same reason again: the tab holds a
    // row whose identity Supabase can never carry, so "every row matched by its
    // export identity key" is false however equal the counts look.
    result.sheets_unmapped_legacy === 0 &&
    // AND A STALE EXACT-DUPLICATE APPROVAL BLOCKS IT TOO. The surplus copies were
    // deliberately NOT removed, so the tab still holds rows the destination cannot
    // represent; and even where the mismatch left no duplicate behind, reconciling
    // would be certifying a tab against an owner ruling that no longer describes it.
    result.sheets_duplicate_multiplicity_mismatch === 0 &&
    result.supabase_identityless === 0;

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

// AN AGGREGATE FAILS CLOSED. *Required review of `63e39a3`, finding P2.*
//
// A destination-aware total is `null` unless EVERY concept computed that counter.
// Summing the concepts that succeeded and ignoring the one whose read failed
// produced a number that looked like a whole-workbook answer while part of the
// destination had never been read — `totals.would_insert: 0` with a concept in
// error underneath it. That is the not-computed-versus-zero contract being
// honoured per concept and then discarded in the summary an operator actually
// reads, so the summary is where it matters most.
function sumOrNull(plans, field) {
  if (plans.some((plan) => plan[field] === null)) return null;
  return plans.reduce((total, plan) => total + plan[field], 0);
}

function conceptTotals(plans) {
  const numeric = plans.reduce(
    (acc, p) => ({
      sheet_rows_read: acc.sheet_rows_read + p.sheet_rows_read,
      rows_with_identity: acc.rows_with_identity + p.rows_with_identity,
      inserted: acc.inserted + p.inserted,
      existing: acc.existing + p.existing,
      skipped: acc.skipped + p.rows_skipped_no_identity + p.rows_skipped_unparseable_session,
      // Kept OUT of `skipped`: a padded empty array was never a candidate row, so
      // folding it into the skip count would restate the same overstatement the
      // per-concept counter removes.
      rows_skipped_blank: acc.rows_skipped_blank + p.rows_skipped_blank,
    }),
    { sheet_rows_read: 0, rows_with_identity: 0, inserted: 0, existing: 0, skipped: 0, rows_skipped_blank: 0 }
  );
  return {
    ...numeric,
    would_insert: sumOrNull(plans, 'would_insert'),
    already_present: sumOrNull(plans, 'already_present'),
    sheets_duplicate_identities: sumOrNull(plans, 'sheets_duplicate_identities'),
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

  // AN IDENTITYLESS AUTHORITATIVE ROW IS A FAILURE, NOT A SKIP COUNTER.
  // *Required review of `65310b3`, finding 3.* Sheets holds a row Supabase can
  // never represent, and unlike the unparseable-session case it cannot even become
  // a divergence, because a divergence is keyed by identity. Reporting it in a
  // counter while `complete` stayed true is exactly how it disappeared.
  const identityless = plans.filter((p) => p.rows_skipped_no_identity > 0);
  for (const plan of identityless) {
    plan.error = plan.error || (
      `sheets_identityless: ${plan.rows_skipped_no_identity} authoritative row(s) in ${plan.tab} have NO export ` +
      'identity and were NOT written. OWNER ACTION REQUIRED; the backfill never invents one'
    );
  }

  // AN UNMAPPED LEGACY ID IS A FAILURE, NOT A SKIP COUNTER — the same rule, for the
  // same reason. The frozen map is the owner's complete ruling over the legacy
  // corpus, so a legacy id it does not cover is either new evidence or a stale map,
  // and both mean the run may not claim completeness. It is never defaulted, never
  // guessed at, and never silently dropped.
  const unmapped = plans.filter((p) => p.rows_skipped_unparseable_session > 0);
  for (const plan of unmapped) {
    plan.error = plan.error || (
      `unmapped_legacy_session: ${plan.rows_skipped_unparseable_session} row(s) in ${plan.tab} carry a legacy ` +
      `session_id absent from the frozen legacy identity map (${plan.unmapped_legacy_session_ids.length} distinct ` +
      'id(s)) and were NOT written. OWNER ACTION REQUIRED; the map is frozen and the backfill never invents an entry'
    );
  }

  // AN EXACT-DUPLICATE APPROVAL THAT NO LONGER DESCRIBES THE DATA IS A FAILURE, for
  // the same reason again. The frozen entry says this content appears exactly N
  // times; if it does not, the owner approved a different tab from the one being
  // read, and the run may not claim completeness on a stale ruling.
  const mismatched = plans.filter((p) => p.duplicate_multiplicity_mismatches.length > 0);
  for (const plan of mismatched) {
    const detail = plan.duplicate_multiplicity_mismatches
      .map((m) => `${m.row_fingerprint} expected ${m.expected_occurrences}, found ${m.actual_occurrences}`)
      .join('; ');
    plan.error = plan.error || (
      `duplicate_multiplicity_mismatch: ${plan.duplicate_multiplicity_mismatches.length} owner-approved exact-duplicate ` +
      `disposition(s) in ${plan.tab} do not match the rows present (${detail}). No copy was removed. OWNER ACTION ` +
      'REQUIRED; the map is frozen and the backfill never re-approves a multiplicity'
    );
  }

  const failed = plans.filter((p) => p.error !== null);
  return {
    applied: apply,
    // A run with any concept error is NOT complete, whatever the counts say.
    complete: failed.length === 0 && (!catalog || catalog.applied === false || catalog.ok === true),
    concepts: plans,
    catalog,
    totals: conceptTotals(plans),
  };
}

module.exports = {
  runBackfill,
  backfillConcept,
  backfillCatalog,
  reconcile,
  reconcileConcept,
  DEFAULT_BATCH_SIZE,
};
