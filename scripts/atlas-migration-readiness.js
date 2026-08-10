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

// ── THE VERDICT, AS A PURE FUNCTION ──────────────────────────────────────────
//
// Extracted so it can be tested adversarially without a database
// (test/migrationReadiness.test.js). A gate whose logic only exists inside a CLI
// main() is a gate nobody can point a counterexample at.
//
// ── P6 TAKES BOTH NUMBERS, AND THAT IS THE FIX ───────────────────────────────
// *Required Atlas Contract / Systems Review of `65310b3`, finding 2.* This used to
// read `sweep.complete && openCount === 0` — the DURABLE count only. The sweep was
// already being run in detect-only mode right here, and its findings were thrown
// away. So a database whose divergence table was empty because the sweep had never
// been run in opening mode, while THIS sweep had just found a fresh mismatch,
// reported P6 PASS: a stale zero certifying a state that was no longer true.
//
// Both must be zero now: no durable open row, AND nothing found by the sweep that
// established it. They answer different questions — "has anything been recorded?"
// and "is anything wrong right now?" — and cutover readiness needs both.
//
// ── AND ABSENT EVIDENCE IS NOT ZERO EVIDENCE ─────────────────────────────────
//
// *Required Atlas Contract / Systems Review of `ae1928c`.* The first fix still
// coerced: `Number(x) || 0` turns `undefined`, `null`, `NaN` and `'lots'` into a
// clean **0**, and `Boolean(x)` turns `'false'`, `{}` and `1` into a clean **true**.
// So a gate handed MISSING or MALFORMED proof reported PASS, and the unit test
// codified it. That is the same false-green class as the stale zero, one level
// further down: not "the evidence says nothing is wrong" but "there is no evidence,
// and nothing is wrong is what we will assume".
//
// Every input is now VALIDATED rather than coerced:
//   • a count must be PRESENT and a finite, non-negative INTEGER — missing, null,
//     NaN, Infinity, negative, fractional, or any non-number fails;
//   • a proof bit must be EXACTLY `true` — no truthiness, so `'false'`, `{}` and
//     `1` satisfy nothing.
// Anything else is a refusal, and `evidence_problems` says which input and why.

// A validated count. Returns the integer, or null when the evidence is unusable —
// and null is never equal to 0, so an unusable count can never satisfy a zero.
function requireCount(container, key, label, problems) {
  if (container === null || container === undefined) {
    problems.push(`${label}: the evidence object is MISSING`);
    return null;
  }
  const value = container[key];
  if (value === undefined || value === null) {
    problems.push(`${label} is MISSING — absent evidence is not a zero`);
    return null;
  }
  if (typeof value !== 'number') {
    problems.push(`${label} is not a number (${typeof value}) — malformed evidence is not a zero`);
    return null;
  }
  // Rejects NaN and Infinity as well as fractions; both are `typeof number`.
  if (!Number.isInteger(value)) {
    problems.push(`${label} is not a finite integer (${value})`);
    return null;
  }
  if (value < 0) {
    problems.push(`${label} is negative (${value}) — a count cannot be`);
    return null;
  }
  return value;
}

// A validated proof bit. EXACTLY `true` passes; `false` is an honest failure, and
// anything else is malformed evidence. Both refuse, and the message distinguishes
// them so an operator can tell a failing gate from a broken one.
function requireTrue(container, key, label, problems) {
  if (container === null || container === undefined) {
    problems.push(`${label}: the evidence object is MISSING`);
    return false;
  }
  const value = container[key];
  if (value === true) return true;
  if (value === false) {
    problems.push(`${label} is false`);
    return false;
  }
  problems.push(`${label} is not a boolean (${typeof value}) — a truthy value is not a proof`);
  return false;
}

function readinessVerdict({ parity, sweep, openDivergences, catalog } = {}) {
  const problems = [];

  const parityReady = requireTrue(parity, 'ready', 'parity.ready', problems);
  const sweepComplete = requireTrue(sweep, 'complete', 'sweep.complete', problems);
  const catalogOk = requireTrue(catalog, 'ok', 'catalog.ok', problems);
  const foundNow = requireCount(sweep, 'divergences_found', 'sweep.divergences_found', problems);
  // Passed as a bare value by every caller, so it is wrapped to reuse one validator.
  const openCount = requireCount({ open_divergences: openDivergences }, 'open_divergences',
    'open_divergences', problems);

  const verdict = {
    p5_read_parity: parityReady,
    // Strict equality against a VALIDATED integer. An unusable count is `null`,
    // and `null === 0` is false, so it cannot satisfy either zero.
    p6_zero_divergences: sweepComplete && openCount === 0 && foundNow === 0,
    p4b_bounded_catalog_dependency: catalogOk,
  };

  return {
    ready: Object.values(verdict).every((v) => v === true),
    verdict,
    // Reported separately so a NOT READY result says which of the two zeros failed —
    // and `null` where the evidence could not be trusted, never a substituted 0.
    open_divergences: openCount,
    divergences_found_now: foundNow,
    sweep_complete: sweepComplete,
    // Exactly what was missing or malformed. Empty on a clean run.
    evidence_problems: problems,
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

  const assessment = readinessVerdict({
    parity, sweep, openDivergences: divergences.open_count, catalog,
  });
  const { ready, verdict } = assessment;
  const openCount = assessment.open_divergences;

  if (asJson) {
    console.log(JSON.stringify({
      ok: ready, configured: true, verdict, parity, sweep_complete: assessment.sweep_complete,
      open_divergences: openCount, divergences_found_now: assessment.divergences_found_now,
      // Named inputs that were missing or malformed. A gate handed no evidence
      // refuses, and this is where it says so.
      evidence_problems: assessment.evidence_problems,
      // Every concept the sweep could not reconcile, named — an identityless or
      // duplicated authoritative row makes a concept INCOMPLETE and must be
      // readable here rather than only inferable from a false `complete`.
      incomplete_concepts: sweep.concepts.filter((c) => !c.complete).map((c) => ({
        concept: c.concept, error: c.error,
      })),
      catalog,
    }, null, 2));
  } else {
    console.log(`S3 cutover readiness: ${ready ? 'READY' : 'NOT READY'}`);
    console.log('');
    console.log(`  P5 read parity          ${parity.ready ? 'PASS' : 'FAIL'} (${parity.reads.filter((r) => r.equal).length}/${MOVED_READS.length} moved reads equal)`);
    for (const read of parity.reads) {
      if (read.equal) continue;
      console.log(`     ✗ ${read.id.padEnd(26)} ${read.error ? `ERROR ${read.error}` : read.detail}`);
    }
    console.log(
      `  P6 divergences          ${verdict.p6_zero_divergences ? 'PASS' : 'FAIL'} ` +
      `(sweep ${assessment.sweep_complete ? 'complete' : 'INCOMPLETE'}, ` +
      `${openCount === null ? 'UNUSABLE' : openCount} durable open, ` +
      `${assessment.divergences_found_now === null ? 'UNUSABLE' : assessment.divergences_found_now} found by THIS sweep)`
    );
    for (const problem of assessment.evidence_problems) {
      console.log(`     ! evidence: ${problem}`);
    }
    for (const concept of sweep.concepts.filter((c) => !c.complete)) {
      console.log(`     ✗ ${concept.concept.padEnd(34)} ${concept.error}`);
    }
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

module.exports = {
  main, readinessVerdict, catalogDependency, declaredSyncIntervalSeconds, DEFAULT_SYNC_INTERVAL_SEC,
};
