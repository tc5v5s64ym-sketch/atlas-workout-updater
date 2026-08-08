#!/usr/bin/env node
'use strict';

// `npm run atlas:repair` — run the divergence repair worker.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.8, §6.1 P7.
// TEMPORARY: S4 deletes this script with the rest of the bridge.
//
// Repair always means "make Supabase agree with Sheets", never the reverse and
// never a merge — Atlas does not reconcile two authorities silently. A divergence
// closes ONLY after an exact identity-and-content re-comparison passes, and the
// closure records that proof. Nothing here closes a row by timer, by age, or
// because a repair statement reported success.
//
// A divergence this worker holds no grant to repair stays OPEN with its attempt
// counted, so it reaches the owner as owner action required. That is the honest
// outcome: closing what it could not fix would make the S3 zero-divergence gate
// a lie.
//
// Usage:
//   npm run atlas:repair
//   npm run atlas:repair -- --json
//   npm run atlas:repair -- --limit 50

require('dotenv').config();

const sheets = require('../sheets');
const adapter = require('../services/supabaseAdapter');
const { runRepair } = require('../services/migrationRepair');

function parseLimit(argv) {
  const index = argv.indexOf('--limit');
  if (index < 0) return 200;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 200;
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');

  if (!adapter.isConfigured('app')) {
    const message = 'Supabase is not configured (ATLAS_SUPABASE_APP_URL is unset). Nothing was repaired.';
    if (asJson) console.log(JSON.stringify({ ok: false, configured: false, error: message }, null, 2));
    else console.error(`✗ ${message}`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = await runRepair({ sheets, adapter, limit: parseLimit(argv) });
  } finally {
    await adapter.close();
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, configured: true, ...result }, null, 2));
  } else {
    console.log(
      `Repair examined=${result.examined} closed=${result.closed} ` +
        `left_open=${result.left_open} not_claimed=${result.not_claimed} open_after=${result.open_after}`
    );
    for (const row of result.results) {
      console.log(`  #${row.id} ${row.concept}/${row.reason} → ${row.state}: ${row.detail}`);
    }
    if (result.left_open > 0) {
      console.log('  Divergences left open are OWNER ACTION REQUIRED — no worker may close them.');
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ repair failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
