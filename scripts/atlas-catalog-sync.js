#!/usr/bin/env node
'use strict';

// `npm run atlas:catalog-sync` — refresh the Exercise_Catalog read mirror.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.7 (ruling D1).
// PERMANENT — the mirror is not bridge machinery. Google Sheets stays the EDITING
// authority; this job projects it into Supabase so the S4 Save path can read the
// catalog without an in-request Sheets read.
//
// Run it on an interval WELL BELOW ATLAS_CATALOG_MIRROR_MAX_AGE_SEC (default
// 3600), so a single failed sync never reaches the bound. Past that bound the S4
// Save path fails CLOSED with an explicit reason — it never serves stale content.
//
// A CHANGED CATALOG IS NOT A FAILURE. A different content hash is the normal
// signal that the owner edited the catalog; it produces a new verified generation
// and currency advances. Only a read failure, an empty or materially shrunken
// source, or a failed swap records a failure and leaves the prior generation to
// age toward the bound.
//
// Usage:
//   npm run atlas:catalog-sync
//   npm run atlas:catalog-sync -- --json

require('dotenv').config();

const sheets = require('../sheets');
const adapter = require('../services/supabaseAdapter');
const mirror = require('../services/exerciseCatalogMirror');

async function main() {
  const asJson = process.argv.slice(2).includes('--json');

  if (!adapter.isConfigured('app')) {
    const message = 'Supabase is not configured (ATLAS_SUPABASE_APP_URL is unset). Nothing was synced.';
    if (asJson) console.log(JSON.stringify({ ok: false, configured: false, error: message }, null, 2));
    else console.error(`✗ ${message}`);
    process.exitCode = 2;
    return;
  }

  let result;
  let currency;
  try {
    result = await mirror.syncCatalog({ sheets, adapter });
    const generation = await adapter.currentCatalogGeneration();
    currency = mirror.currencyVerdict(generation);
  } finally {
    await adapter.close();
  }

  if (asJson) {
    console.log(JSON.stringify({ configured: true, sync: result, currency }, null, 2));
  } else if (result.ok) {
    console.log(
      `Catalog sync OK — generation ${result.sync_id}, ${result.rows} rows, ` +
        `${result.changed ? 'source CHANGED (normal owner edit)' : 'source unchanged'}.`
    );
    console.log(`  currency: servable=${currency.servable} age=${currency.age_seconds}s max=${currency.max_age_seconds}s`);
  } else {
    console.error(`✗ Catalog sync FAILED (${result.code}): ${result.error}`);
    console.error('  The previous verified generation stays current and keeps ageing.');
    console.error(`  currency: servable=${currency.servable} reason=${currency.reason || 'n/a'}`);
  }

  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ catalog sync failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
