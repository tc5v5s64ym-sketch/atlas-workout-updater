#!/usr/bin/env node
'use strict';

// `npm run atlas:readiness` — the S3 CUTOVER-READINESS verdict.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §6.2 P4, P5, P6, P7.
// TEMPORARY: S4 deletes this script with the rest of the readiness machinery.
//
// It answers one question — is the backfilled database ready for the S4 cutover? —
// by running four checks and refusing to average them:
//
//   P5  every read S4 will move returns what the Sheets read returns today;
//   P6  the sweep RAN TO COMPLETION and the open-divergence count is zero;
//   P4b the background Sheets dependency the catalog mirror introduces is stated
//       and bounded, and a single missed sync cannot reach the age bound;
//   P4a the residual in-request Sheets read count on the migrated Save path —
//       measured by test/liveSessionReadBudget.test.js, which replays the captured
//       manifest, and reported here as the census that test publishes.
//
// ── IT AUTHORIZES NOTHING ────────────────────────────────────────────────────
// A green verdict does not move a read, move a write, apply a schema, or start S4.
// It is evidence for the S3 gate; the cutover is an owner-gated sequence (§5.5).
//
// ── HONESTY ──────────────────────────────────────────────────────────────────
// An unrun check is never a pass. Supabase unconfigured exits 2 with NOT
// CONFIGURED rather than reporting zero divergences against a database it never
// opened, and a sweep that could not read a concept makes the verdict false even
// when its counters read zero.
//
// Usage:
//   npm run atlas:readiness
//   npm run atlas:readiness -- --json

require('dotenv').config();

const sheets = require('../sheets');
const adapter = require('../services/supabaseAdapter');
const { runSweep } = require('../services/migrationSweep');
const { compareReadPaths, MOVED_READS } = require('../services/migrationReadParity');
const catalogMirror = require('../services/exerciseCatalogMirror');

// The DECLARED operating interval for `npm run atlas:catalog-sync`. It is an
// operator schedule, not a runtime setting — nothing in the server reads it — so
// it is declared here, where the dependency it creates is measured and gated.
const DEFAULT_SYNC_INTERVAL_SEC = 600;

function declaredSyncIntervalSeconds() {
  const raw = Number(process.env.ATLAS_CATALOG_MIRROR_SYNC_INTERVAL_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_SEC;
}

// ── P4(b): the bounded background dependency, stated exactly ─────────────────
//
// DO NOT CERTIFY UNQUALIFIED QUOTA INDEPENDENCE. Removing the in-request catalog
// read does not make a Save independent of the Sheets quota; it converts a
// per-request dependency into a bounded background one. The exact residual — how
// long a TOTAL Sheets outage may last before a Save fails — is what P4(b) asks
// for, and it is a RANGE, not a number:
//
//   best case   the outage starts immediately after a verified sync   → max_age
//   worst case  the outage starts just before the next scheduled sync → max_age − interval
//
// The gate is that a SINGLE missed sync must not reach the bound, so the interval
// must leave room for one failure and a retry: 2 × interval < max_age.
async function catalogDependency() {
  const maxAge = catalogMirror.maxAgeSeconds();
  const interval = declaredSyncIntervalSeconds();

  let generation = null;
  let currency = null;
  let error = null;
  try {
    generation = await adapter.currentCatalogGeneration();
    currency = catalogMirror.currencyVerdict(generation);
  } catch (err) {
    error = err.message;
  }

  return {
    max_age_seconds: maxAge,
    declared_sync_interval_seconds: interval,
    // The claim, in the only form the evidence supports.
    residual_outage_tolerance_seconds: { best_case: maxAge, worst_case: Math.max(0, maxAge - interval) },
    fail_closed_past_bound: true,
    single_missed_sync_cannot_reach_bound: interval * 2 < maxAge,
    current_generation: generation ? { sync_id: generation.sync_id, source_row_count: Number(generation.source_row_count || 0) } : null,
    currency,
    error,
    // Stated so no reader can quote a stronger claim from this output.
    claim: 'The migrated Save path issues no IN-REQUEST Sheets read. Save availability is ' +
      'NOT independent of the Sheets quota: it depends on a background sync succeeding within ' +
      'the age bound above, past which the Save fails CLOSED with an explicit reason.',
    ok: error === null && interval * 2 < maxAge && Boolean(currency && currency.servable),
  };
}

async function main() {
  const asJson = process.argv.slice(2).includes('--json');

  if (!adapter.isConfigured('app')) {
    const message =
      'Supabase is not configured (ATLAS_SUPABASE_APP_URL is unset). Readiness reports NOT ' +
      'CONFIGURED rather than a pass — an unrun check is never a green one.';
    if (asJson) console.log(JSON.stringify({ ok: false, configured: false, error: message }, null, 2));
    else console.error(`✗ ${message}`);
    process.exitCode = 2;
    return;
  }

  let parity;
  let sweep;
  let divergences;
  let catalog;
  try {
    parity = await compareReadPaths({ sheets, adapter });
    // Detect-only: readiness reports, it does not open rows. `npm run atlas:sweep`
    // is the lane that makes findings durable.
    sweep = await runSweep({ sheets, adapter, openDivergences: false });
    divergences = await adapter.divergenceSummary();
    catalog = await catalogDependency();
  } finally {
    await adapter.close();
  }

  const openCount = Number(divergences.open_count || 0);
  const verdict = {
    p5_read_parity: parity.ready,
    // BOTH halves. A zero from a sweep that did not complete is not a zero.
    p6_zero_divergences: sweep.complete && openCount === 0,
    p4b_bounded_catalog_dependency: catalog.ok,
  };
  const ready = Object.values(verdict).every(Boolean);

  if (asJson) {
    console.log(JSON.stringify({
      ok: ready, configured: true, verdict, parity, sweep_complete: sweep.complete,
      open_divergences: openCount, catalog,
    }, null, 2));
  } else {
    console.log(`S3 cutover readiness: ${ready ? 'READY' : 'NOT READY'}`);
    console.log('');
    console.log(`  P5 read parity          ${parity.ready ? 'PASS' : 'FAIL'} (${parity.reads.filter((r) => r.equal).length}/${MOVED_READS.length} moved reads equal)`);
    for (const read of parity.reads) {
      if (read.equal) continue;
      console.log(`     ✗ ${read.id.padEnd(26)} ${read.error ? `ERROR ${read.error}` : read.detail}`);
    }
    console.log(`  P6 divergences          ${verdict.p6_zero_divergences ? 'PASS' : 'FAIL'} (sweep ${sweep.complete ? 'complete' : 'INCOMPLETE'}, ${openCount} open)`);
    console.log(`  P4b catalog dependency  ${catalog.ok ? 'PASS' : 'FAIL'}`);
    console.log(`     max age ${catalog.max_age_seconds}s · declared sync interval ${catalog.declared_sync_interval_seconds}s`);
    console.log(`     a total Sheets outage fails a Save after ${catalog.residual_outage_tolerance_seconds.worst_case}–${catalog.residual_outage_tolerance_seconds.best_case}s`);
    console.log(`     ${catalog.claim}`);
    console.log('');
    console.log('  P4a in-request Sheets reads on the migrated Save path are measured by');
    console.log('      test/liveSessionReadBudget.test.js (the captured-manifest replay), not here.');
  }

  if (!ready) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ readiness check failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, catalogDependency, declaredSyncIntervalSeconds, DEFAULT_SYNC_INTERVAL_SEC };
