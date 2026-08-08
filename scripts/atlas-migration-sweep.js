#!/usr/bin/env node
'use strict';

// `npm run atlas:sweep` — run the reconciliation sweep.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.2, §6.1 P5/P6.
// TEMPORARY: S4 deletes this script with the rest of the bridge.
//
// The sweep is the COMPLETENESS AUTHORITY for the shadow window. It reads Google
// Sheets (the live write authority, which holds every committed row) and Supabase,
// and opens a divergence for every element of the symmetric difference. It depends
// on nothing in flight, so a process death anywhere in the shadow window is
// detectable by construction rather than only when a handler managed to run.
//
// Read-only against both stores apart from the divergence rows it opens. It
// repairs nothing — `npm run atlas:repair` does that.
//
// HONESTY: a run that could not read a concept reports complete:false, and the
// exit code is non-zero. A partial sweep is never a zero.
//
// Usage:
//   npm run atlas:sweep
//   npm run atlas:sweep -- --json
//   npm run atlas:sweep -- --detect-only     (open no divergence rows)

require('dotenv').config();

const sheets = require('../sheets');
const adapter = require('../services/supabaseAdapter');
const { runSweep } = require('../services/migrationSweep');

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const detectOnly = argv.includes('--detect-only');

  if (!adapter.isConfigured('app')) {
    const message =
      'Supabase is not configured (ATLAS_SUPABASE_APP_URL is unset). The sweep reports ' +
      'NOT CONFIGURED rather than a zero — an unrun sweep is not a clean one.';
    if (asJson) console.log(JSON.stringify({ ok: false, configured: false, error: message }, null, 2));
    else console.error(`✗ ${message}`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = await runSweep({ sheets, adapter, openDivergences: !detectOnly });
  } finally {
    await adapter.close();
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: result.complete, configured: true, ...result }, null, 2));
  } else {
    console.log(`Sweep ${result.complete ? 'COMPLETE' : 'INCOMPLETE — this run is not a zero'}`);
    for (const concept of result.concepts) {
      const status = concept.complete ? 'ok' : `FAILED (${concept.error})`;
      console.log(
        `  ${concept.concept.padEnd(34)} sheets=${String(concept.sheets_rows).padStart(6)} ` +
          `supabase=${String(concept.supabase_rows).padStart(6)} ` +
          `missing_in_supabase=${concept.missing_in_supabase} ` +
          `missing_in_sheets=${concept.missing_in_sheets} ` +
          `content_mismatch=${concept.content_mismatch} ` +
          `opened=${concept.divergences_opened} ${status}`
      );
      if (concept.sheets_duplicate_identities) {
        console.log(
          `    ! ${concept.sheets_duplicate_identities} duplicate Sheets identit(ies) — ` +
            'Supabase can hold only one of each. OWNER ACTION REQUIRED; no worker may pick a winner.'
        );
      }
    }
    console.log(`  divergences found: ${result.divergences_found}`);
  }

  // Non-zero when the sweep did not complete. A found divergence is NOT a failure
  // of the sweep — it is the sweep working — so it does not fail the exit code;
  // the S3/S4 gates read the open-divergence count for that.
  if (!result.complete) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ sweep failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
