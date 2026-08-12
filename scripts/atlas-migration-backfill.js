#!/usr/bin/env node
'use strict';

// `npm run atlas:backfill` — the ONE-WAY S3 backfill, Sheets → Supabase.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.3 (PR S3), §6.2 P3.
// TEMPORARY: S4 deletes this script and services/migrationBackfill.js and proves
// them absent (§5.4 step 3).
//
// ── IT MOVES NO AUTHORITY ────────────────────────────────────────────────────
// Google Sheets stays the sole live authority for every athlete-facing read and
// every write until S4 (ruling D5). This copies the workbook INTO an inert
// destination so the cutover has something to cut over to. It writes nothing to
// Google Sheets, ever.
//
// ── DRY RUN IS THE DEFAULT ───────────────────────────────────────────────────
// Without --apply it reads BOTH sides — the workbook and Supabase — and reports
// what it WOULD write, split into `would_insert` and `already_present`. It writes
// to neither store. Writing requires the flag, deliberately.
//
// ── RUN ONCE PER ENVIRONMENT, BUT SAFE TO RE-RUN ─────────────────────────────
// Every insert is ON CONFLICT DO NOTHING on the concept's own identity, so a
// re-run converges rather than duplicating, and an interrupted run resumes.
//
// Usage:
//   npm run atlas:backfill                     dry run — reads both sides, writes
//                                              neither; reports would_insert /
//                                              already_present per row concept
//   npm run atlas:backfill -- --apply          write it
//   npm run atlas:backfill -- --reconcile      reconcile only (§6.2 P3), no write
//   npm run atlas:backfill -- --apply --reconcile
//   npm run atlas:backfill -- --json
//   npm run atlas:backfill -- --report <path>  write the reconciliation report as JSON

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const sheets = require('../sheets');
const adapter = require('../services/supabaseAdapter');
const { runBackfill, reconcile } = require('../services/migrationBackfill');

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index === argv.length - 1) return null;
  return argv[index + 1];
}

// A dry run prints the two DESTINATION-AWARE counters instead of the write
// counters. Printing `inserted=0 existing=0` under a dry run is what let an
// operator read "nothing to do" off a run that had never looked at the
// destination. `?` marks a counter that was NOT computed — never 0.
function count(value) {
  return String(value === null || value === undefined ? '?' : value).padStart(6);
}

function printBackfill(result) {
  console.log(`Backfill ${result.applied ? 'APPLIED' : 'DRY RUN'} — ${result.complete ? 'complete' : 'INCOMPLETE'}`);
  for (const plan of result.concepts) {
    const counters = result.applied
      ? `inserted=${count(plan.inserted)} existing=${count(plan.existing)}`
      : `would_insert=${count(plan.would_insert)} already_present=${count(plan.already_present)}`;
    console.log(
      `  ${plan.concept.padEnd(34)} read=${String(plan.sheet_rows_read).padStart(6)} ` +
        `eligible=${String(plan.rows_with_identity).padStart(6)} ` +
        counters +
        (plan.error ? `  FAILED (${plan.error})` : '')
    );
    if (plan.sheets_duplicate_identities) {
      console.log(
        `    ! ${plan.sheets_duplicate_identities} duplicate export identity/identities in ${plan.tab}. ` +
          'would_insert counts IDENTITIES, not rows, because the destination can hold only one row per ' +
          'identity — so this run predicts what --apply does. The reconciliation refuses a tab in this state.'
      );
    }
    if (plan.rows_skipped_no_identity) {
      console.log(
        `    ! ${plan.rows_skipped_no_identity} row(s) in ${plan.tab} have no export identity. ` +
          'Reported, never guessed at.'
      );
    }
    if (plan.rows_skipped_unparseable_session) {
      console.log(
        `    ! ${plan.rows_skipped_unparseable_session} row(s) in ${plan.tab} carry a legacy session_id the frozen ` +
          `legacy identity map does not cover (${plan.unmapped_legacy_session_ids.length} distinct). The map is ` +
          'frozen; no entry is invented and the run is not complete.'
      );
    }
    if (plan.duplicate_multiplicity_mismatches.length) {
      console.log(
        `    ! ${plan.duplicate_multiplicity_mismatches.length} owner-approved exact-duplicate disposition(s) in ` +
          `${plan.tab} do not match the rows present ` +
          `(${plan.duplicate_multiplicity_mismatches.map((m) => `${m.row_fingerprint} expected ${m.expected_occurrences}, found ${m.actual_occurrences}`).join('; ')}). ` +
          'No surplus copy was removed; the map is frozen and no multiplicity is re-approved.'
      );
    }
    if (plan.rows_surplus_identical_excluded) {
      console.log(
        `    - ${plan.rows_surplus_identical_excluded} surplus identical copy/copies in ${plan.tab} removed at the ` +
          'owner-approved multiplicity. One authoritative copy of each survives. Temporary migration bridge; deleted at S4.'
      );
    }
    if (plan.rows_translated_from_legacy || plan.rows_excluded_by_owner_ruling) {
      console.log(
        `    - ${plan.rows_translated_from_legacy} row(s) translated through the frozen legacy identity map, ` +
          `${plan.rows_excluded_by_owner_ruling} removed by an owner ruling. Temporary migration bridge; deleted at S4.`
      );
    }
    if (plan.rows_skipped_blank) {
      console.log(
        `    - ${plan.rows_skipped_blank} empty row(s) in ${plan.tab} were not rows at all: Sheets pads every ` +
          'row above a stray one below the data block. Not history, not owner-actionable, never written.'
      );
    }
  }
  if (result.catalog) {
    console.log(
      `  ${'exercise_catalog'.padEnd(34)} ${result.catalog.applied
        ? `ok=${result.catalog.ok} rows=${result.catalog.rows} sync_id=${result.catalog.sync_id}`
        : 'dry run — no generation written'}` + (result.catalog.error ? `  FAILED (${result.catalog.error})` : '')
    );
  }
}

function printReconciliation(report) {
  console.log(`Reconciliation ${report.complete ? (report.reconciled ? 'PASS' : 'FAIL') : 'INCOMPLETE — not a pass'}`);
  for (const tab of report.tabs) {
    console.log(
      `  ${tab.concept.padEnd(34)} sheets=${String(tab.sheets_rows).padStart(6)} ` +
        `supabase=${String(tab.supabase_rows).padStart(6)} ` +
        `matched=${String(tab.matched_by_identity).padStart(6)} ` +
        `missing_in_supabase=${tab.missing_in_supabase} missing_in_sheets=${tab.missing_in_sheets} ` +
        `content_mismatch=${tab.content_mismatch} ` +
        `${tab.error ? `FAILED (${tab.error})` : (tab.reconciled ? 'RECONCILED' : 'NOT RECONCILED')}`
    );
    for (const [field, bucket] of Object.entries(tab.field_differences)) {
      // Shapes only — never a load, a rep count or a note (§3.8).
      console.log(`    ~ ${field}: ${bucket.count} row(s) differ; shapes ${JSON.stringify(bucket.examples)}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const apply = argv.includes('--apply');
  const reconcileOnly = argv.includes('--reconcile') && !apply && !argv.includes('--backfill');
  const wantReconcile = argv.includes('--reconcile') || apply;
  const reportPath = flagValue(argv, '--report');

  if (!adapter.isConfigured('app')) {
    const message =
      'Supabase is not configured (ATLAS_SUPABASE_APP_URL is unset). The backfill reports ' +
      'NOT CONFIGURED rather than a zero — an unrun backfill is not a complete one.';
    if (asJson) console.log(JSON.stringify({ ok: false, configured: false, error: message }, null, 2));
    else console.error(`✗ ${message}`);
    process.exitCode = 2;
    return;
  }

  let backfillResult = null;
  let reconciliation = null;
  try {
    if (!reconcileOnly) {
      backfillResult = await runBackfill({ sheets, adapter, apply });
    }
    if (wantReconcile || reconcileOnly) {
      reconciliation = await reconcile({ sheets, adapter });
    }
  } finally {
    await adapter.close();
  }

  if (reportPath && reconciliation) {
    // Redacted by construction: field names and SHAPES only.
    const target = path.resolve(reportPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(reconciliation, null, 2)}\n`);
    if (!asJson) console.log(`Reconciliation report written to ${target}`);
  }

  if (asJson) {
    console.log(JSON.stringify({
      ok: (!backfillResult || backfillResult.complete) && (!reconciliation || reconciliation.reconciled),
      configured: true,
      backfill: backfillResult,
      reconciliation,
    }, null, 2));
  } else {
    if (backfillResult) printBackfill(backfillResult);
    if (reconciliation) printReconciliation(reconciliation);
  }

  // Non-zero when the backfill did not complete, or when a requested
  // reconciliation did not pass. Cutover readiness reads this, so it may never be
  // green on a partial run.
  if (backfillResult && !backfillResult.complete) process.exitCode = 1;
  if (reconciliation && !(reconciliation.complete && reconciliation.reconciled)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ backfill failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
