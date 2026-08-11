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

/* ══════════ MISSING, MALFORMED, DEFAULTED OR AMBIGUOUS EVIDENCE ══════════ */
//
// *Required Atlas Contract / Systems Review of `ae1928c`.* The first P6 fix still
// COERCED its inputs — `Number(x) || 0` and `Boolean(x)` — so a gate handed no
// evidence at all reported PASS, and the test that used to live here CODIFIED that
// by asserting a malformed durable count of `'lots'` became 0 and P6 still passed.
// It was a false green written down as an expectation, which is worse than the bug.
//
// Absent evidence is not zero evidence, and a truthy value is not a proof. Every
// case below asserts a REFUSAL.

test('MISSING evidence is never a pass — an absent sweep, parity or catalog fails closed', () => {
  for (const missing of [
    { parity: null, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: CATALOG_OK },
    { parity: PARITY_OK, sweep: null, openDivergences: 0, catalog: CATALOG_OK },
    { parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: null },
    {},
    undefined,
  ]) {
    const result = readinessVerdict(missing);
    assert.equal(result.ready, false,
      `absent evidence must refuse, not default to ready: ${JSON.stringify(missing)}`);
    assert.ok(result.evidence_problems.length > 0, 'and it must say what was missing');
  }
});

// ── 1. CURRENT-SWEEP divergence evidence ─────────────────────────────────────
for (const [label, divergences_found] of [
  ['missing', undefined],
  ['null', null],
  ['a string', 'lots'],
  ['a numeric string', '0'],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['negative', -1],
  ['fractional', 0.5],
  ['a boolean', false],
  ['an object', {}],
  ['an array', []],
]) {
  test(`P6 FAILS when sweep.divergences_found is ${label}`, () => {
    const sweep = { complete: true, concepts: [] };
    if (divergences_found !== undefined) sweep.divergences_found = divergences_found;

    const result = readinessVerdict({
      parity: PARITY_OK, sweep, openDivergences: 0, catalog: CATALOG_OK,
    });
    assert.equal(result.verdict.p6_zero_divergences, false,
      `sweep.divergences_found = ${label} must never satisfy a zero`);
    assert.equal(result.ready, false);
    assert.equal(result.divergences_found_now, null, 'unusable evidence reports null, never a substituted 0');
    assert.ok(result.evidence_problems.some((p) => p.startsWith('sweep.divergences_found')));
  });
}

// ── 2. DURABLE open-divergence evidence ──────────────────────────────────────
for (const [label, openDivergences] of [
  ['missing', undefined],
  ['null', null],
  ['a string', 'lots'],
  ['a numeric string', '0'],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['negative', -3],
  ['fractional', 1.5],
  ['a boolean', false],
  ['an object', {}],
]) {
  test(`P6 FAILS when the durable open count is ${label}`, () => {
    const result = readinessVerdict({
      parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences, catalog: CATALOG_OK,
    });
    assert.equal(result.verdict.p6_zero_divergences, false,
      `open_divergences = ${label} must never satisfy a zero`);
    assert.equal(result.ready, false);
    assert.equal(result.open_divergences, null);
    assert.ok(result.evidence_problems.some((p) => p.startsWith('open_divergences')));
  });
}

// ── 3. BOOLEAN gate evidence — truthiness is not proof ───────────────────────
const TRUTHY_NON_BOOLEANS = [['the string "false"', 'false'], ['the string "yes"', 'yes'],
  ['an empty object', {}], ['the number 1', 1], ['a non-empty array', ['ok']]];

for (const [label, truthy] of TRUTHY_NON_BOOLEANS) {
  test(`P5 FAILS when parity.ready is ${label}`, () => {
    const result = readinessVerdict({
      parity: { ready: truthy }, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: CATALOG_OK,
    });
    assert.equal(result.verdict.p5_read_parity, false, `parity.ready = ${label} is not a proof`);
    assert.equal(result.ready, false);
    assert.ok(result.evidence_problems.some((p) => p.includes('parity.ready is not a boolean')));
  });

  test(`P6 FAILS when sweep.complete is ${label}`, () => {
    const result = readinessVerdict({
      parity: PARITY_OK,
      sweep: { complete: truthy, divergences_found: 0, concepts: [] },
      openDivergences: 0,
      catalog: CATALOG_OK,
    });
    assert.equal(result.verdict.p6_zero_divergences, false, `sweep.complete = ${label} is not a proof`);
    assert.equal(result.sweep_complete, false);
    assert.equal(result.ready, false);
  });

  test(`P4(b) FAILS when catalog.ok is ${label}`, () => {
    const result = readinessVerdict({
      parity: PARITY_OK, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: { ok: truthy },
    });
    assert.equal(result.verdict.p4b_bounded_catalog_dependency, false, `catalog.ok = ${label} is not a proof`);
    assert.equal(result.ready, false);
  });
}

test('a genuine false is reported as a FAILING gate, not as broken evidence', () => {
  // The distinction matters to an operator: "the sweep did not complete" and "the
  // sweep did not say whether it completed" need different responses.
  const honest = readinessVerdict({
    parity: { ready: false }, sweep: CLEAN_SWEEP, openDivergences: 0, catalog: CATALOG_OK,
  });
  assert.ok(honest.evidence_problems.includes('parity.ready is false'));
  assert.equal(honest.evidence_problems.some((p) => p.includes('not a boolean')), false);
});

test('the ONLY passing shape is exact booleans and exact integer zeros', () => {
  const result = readinessVerdict({
    parity: { ready: true },
    sweep: { complete: true, divergences_found: 0, concepts: [] },
    openDivergences: 0,
    catalog: { ok: true },
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.evidence_problems, []);
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
    ['divergences_found_now', 'evidence_problems', 'open_divergences', 'ready', 'sweep_complete', 'verdict'],
    'a readiness verdict that grew an action field would be a cutover trigger, which S3 must not have'
  );
});
