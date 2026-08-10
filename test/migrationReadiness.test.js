'use strict';

// THE S3 READINESS VERDICT — adversarial.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §6.2 P5, P6, P4(b).
// Added by the required Atlas Contract / Systems Review of `65310b3`, finding 2.
//
// ── THE DEFECT THIS FILE EXISTS FOR ──────────────────────────────────────────
// P6 used to be `sweep.complete && openCount === 0` — the DURABLE open count only.
// The sweep was already being run detect-only in the same function, and its
// findings were discarded. So a database whose `atlas.migration_divergences` table
// was empty — because nothing had yet run the sweep in OPENING mode — reported
// P6 PASS while that very sweep was finding a fresh mismatch. A stale zero
// certifying a state that was no longer true, which is the exact false-green class
// the S3 gates exist to prevent.
//
// Every case below asserts a REFUSAL. A readiness gate is only worth its green
// when a counterexample can turn it red, so the counterexamples come first.

const test = require('node:test');
const assert = require('node:assert/strict');

const { readinessVerdict } = require('../scripts/atlas-migration-readiness');

const PARITY_OK = { ready: true, reads: [] };
const CATALOG_OK = { ok: true };
const CLEAN_SWEEP = { complete: true, divergences_found: 0, concepts: [] };

/* ══════════ the only passing case ══════════ */

test('READY requires all three: parity, both divergence zeros, and the bounded catalog dependency', () => {
  const result = readinessVerdict({
    parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: CATALOG_OK,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.verdict, {
    p5_read_parity: true,
    p6_zero_divergences: true,
    p4b_bounded_catalog_dependency: true,
  });
});

/* ══════════ FINDING 2 — the stale zero ══════════ */

test('THE FALSE GREEN: a durable open count of ZERO while THIS sweep finds a new mismatch must FAIL', () => {
  // Exactly the reviewed defect. The divergence table is empty — nothing has ever
  // opened a row — and the sweep that just ran found a fresh content mismatch.
  const result = readinessVerdict({
    parity: PARITY_OK,
    sweep: { complete: true, divergences_found: 1, concepts: [] },
    openDivergences: 0,
    catalog: CATALOG_OK,
  });

  assert.equal(result.verdict.p6_zero_divergences, false,
    'a stale zero must never certify a state the current sweep contradicts');
  assert.equal(result.ready, false);
  // And the report says WHICH zero failed, so the operator is not left guessing.
  assert.equal(result.open_divergences, 0);
  assert.equal(result.divergences_found_now, 1);
});

test('the durable count still fails on its own — an open row with a clean sweep is not readiness either', () => {
  const result = readinessVerdict({
    parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 3, catalog: CATALOG_OK,
  });
  assert.equal(result.verdict.p6_zero_divergences, false);
  assert.equal(result.ready, false);
});

test('both zeros together are required — neither substitutes for the other', () => {
  for (const [open, found] of [[0, 1], [1, 0], [2, 5]]) {
    const result = readinessVerdict({
      parity: PARITY_OK,
      sweep: { complete: true, divergences_found: found, concepts: [] },
      openDivergences: open,
      catalog: CATALOG_OK,
    });
    assert.equal(result.verdict.p6_zero_divergences, false,
      `open=${open} found=${found} must not pass P6`);
  }
});

test('an INCOMPLETE sweep fails P6 even when both counts read zero', () => {
  // §5.2 point 3: a sweep that has not completed is never a zero. An identityless
  // or duplicated authoritative row is exactly how a concept becomes incomplete.
  const result = readinessVerdict({
    parity: PARITY_OK,
    sweep: {
      complete: false,
      divergences_found: 0,
      concepts: [{ concept: 'logged_sets', complete: false, error: 'sheets_identityless: 1 …' }],
    },
    openDivergences: 0,
    catalog: CATALOG_OK,
  });
  assert.equal(result.verdict.p6_zero_divergences, false);
  assert.equal(result.sweep_complete, false);
});

/* ══════════ missing, malformed and absent evidence ══════════ */

test('MISSING evidence is never a pass — an absent sweep, parity or catalog fails closed', () => {
  for (const missing of [
    { parity: null, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: CATALOG_OK },
    { parity: PARITY_OK, sweep: null, openDivergences: 0, catalog: CATALOG_OK },
    { parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: null },
    {},
  ]) {
    assert.equal(readinessVerdict(missing).ready, false,
      `absent evidence must refuse, not default to ready: ${JSON.stringify(Object.keys(missing))}`);
  }
});

test('a NON-NUMERIC divergence count is treated as zero found only when it is genuinely absent', () => {
  // `divergences_found` missing entirely (an older sweep shape) coerces to 0 — but
  // `complete` and the durable count still have to hold, so this cannot pass alone.
  const partial = readinessVerdict({
    parity: PARITY_OK, sweep: { complete: true, concepts: [] }, openDivergences: 0, catalog: CATALOG_OK,
  });
  assert.equal(partial.divergences_found_now, 0);

  // And a garbage durable count does not silently become zero-and-passing.
  const garbage = readinessVerdict({
    parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 'lots', catalog: CATALOG_OK,
  });
  assert.equal(garbage.open_divergences, 0, 'unparseable coerces to 0');
  assert.equal(garbage.verdict.p6_zero_divergences, true,
    'which is why the SWEEP half exists — the durable count alone was never enough');
});

test('P5 and P4(b) each fail the whole verdict on their own', () => {
  assert.equal(readinessVerdict({
    parity: { ready: false }, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: CATALOG_OK,
  }).ready, false);
  assert.equal(readinessVerdict({
    parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: { ok: false },
  }).ready, false);
});

/* ══════════ the verdict authorizes nothing ══════════ */

test('the verdict reports only — it carries no authority to move a read or a write', () => {
  const result = readinessVerdict({
    parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: CATALOG_OK,
  });
  assert.deepEqual(
    Object.keys(result).sort(),
    ['divergences_found_now', 'open_divergences', 'ready', 'sweep_complete', 'verdict'],
    'a readiness verdict that grew an action field would be a cutover trigger, which S3 must not have'
  );
});
