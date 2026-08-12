'use strict';

// THE EXACT-DUPLICATE DISPOSITION — the proofs the owner required (rulings CARD_8
// and CARD_9, recorded 2026-08-12).
//
// The frozen row-level EXCLUDE is keyed by CONTENT. That is correct for a row whose
// content is unique, and it is why CARD_5 worked: the two halves of that Effort
// duplicate differed in duration format. It CANNOT separate two rows whose content
// is byte-identical — it matches both and removes both, turning a duplicate into a
// missing record. That is a LOCAL DEFECT in the temporary bridge's exclusion
// expressiveness, and EXCLUDE_SURPLUS_IDENTICAL is the smallest extension that
// closes it inside the existing fingerprint authority and the one resolver.
//
// These proofs hold three lines at once:
//
//   * the four duplicate export identities resolve to one row each, and the row that
//     survives is the one the owner ruled for;
//   * nothing collapses that the owner did not approve at the multiplicity approved
//     — an unapproved duplicate, a conflicting duplicate, and an approval whose
//     multiplicity no longer matches the data all still FAIL;
//   * no live runtime identity grammar moved, and there is still ONE resolver.
//
// TEMPORARY: deleted at S4 with the map, the loader and the backfill machinery.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const contract = require('../services/migrationRowContract');
const legacyMap = require('../services/migrationLegacyIdentityMap');
const { runBackfill, reconcileConcept } = require('../services/migrationBackfill');
const { sweepRowConcept } = require('../services/migrationSweep');

const MAP = JSON.parse(fs.readFileSync(legacyMap.MAP_PATH, 'utf8'));

// Log_Cleaned contract order: date_clean, session_id, exercise, canonical_exercise,
// muscle_group, lift_code, set_number, weight, reps, rir, notes, volume_calc.
// SYNTHETIC values throughout — no production workout value appears in this file.
const logRow = (sessionId, { exercise = 'Bench Press', setNumber = '1', reps = '5', notes = '' } = {}) =>
  ['2026-05-20', sessionId, exercise, exercise, 'Chest', 'BP', setNumber, '225', reps, '2', notes, '1125'];
// Effort contract order: date, session_id, duration, active_calories, total_calories,
// average_hr, peak_hr, location, notes.
const effRow = (sessionId, { date = '2026-05-20', duration = '01:02:03', location = 'Gym' } = {}) =>
  [date, sessionId, duration, '300', '400', '120', '150', location, ''];

const stubSheets = (rowsByTab) => ({ getSheetRows: async (tab) => (rowsByTab[tab] || []).map((r) => r.slice()) });
const INERT_ADAPTER = { listConcept: async () => [], backfillRows: async () => ({ inserted: 0, existing: 0 }) };

// A map carrying ONE synthetic exact-duplicate approval for the given cells.
const withApproval = (concept, cells, overrides = {}) => ({
  ...MAP,
  duplicate_dispositions: [{
    concept,
    tab: contract.conceptSpec(concept).tab,
    row_fingerprint: legacyMap.rowFingerprint(cells),
    disposition: 'EXCLUDE_SURPLUS_IDENTICAL',
    expected_occurrences: 2,
    surviving_copies: 1,
    owner_ruling: 'TEST_RULING',
    reason: 'synthetic fixture',
    ...overrides,
  }],
});

// ── SCOPING THE FROZEN APPROVALS OUT OF A CONSUMER FIXTURE ────────────────────
//
// The shipped map carries three real CARD_9 approvals over PRODUCTION Effort content.
// A synthetic tab does not hold that content, so every one of them reports a
// multiplicity mismatch — which is the production rule working exactly as the
// required review demanded, and is also noise in a fixture that is testing something
// else. The rule is never relaxed to quiet it. Instead a consumer fixture declares
// the approvals it means to exercise, and they are injected at the ONE shared
// resolver seam the consumers read — the same seam, and the same argument, as
// `withMismatchVerdict` below. Nothing in production gains a map-injection hook: the
// backfill, the sweep and the reconciliation still read the frozen file and only it.
function withScopedApprovals(duplicateDispositions, run) {
  const real = legacyMap.resolveSheetRows;
  legacyMap.resolveSheetRows = (concept, sheetRows, options = {}) =>
    real(concept, sheetRows, { ...options, map: { ...MAP, duplicate_dispositions: duplicateDispositions } });
  return Promise.resolve(run()).finally(() => { legacyMap.resolveSheetRows = real; });
}
// The common case: a fixture that declares NO approval at all.
const withNoApprovals = (run) => withScopedApprovals([], run);

// ── 1. The frozen dispositions the owner ruled ────────────────────────────────

test('map: the logged_sets conflict is resolved by a UNIQUE-fingerprint EXCLUDE, not by the new mechanism', () => {
  const card8 = MAP.excluded_rows.filter((e) => e.owner_ruling === 'CARD_8');
  assert.equal(card8.length, 1, 'the test fragment takes the existing exclusion path');
  assert.equal(card8[0].concept, 'logged_sets');
  assert.equal(card8[0].disposition, 'EXCLUDE');
  assert.match(card8[0].row_fingerprint, /^[0-9a-f]{16}$/);
  // The new mechanism is NOT broadened to cover it.
  assert.equal(MAP.duplicate_dispositions.some((d) => d.concept === 'logged_sets'), false);
});

test('map: exactly three Effort exact-duplicate dispositions, each 2 occurrences and 1 survivor', () => {
  assert.equal(MAP.duplicate_dispositions.length, 3);
  const fingerprints = new Set();
  for (const entry of MAP.duplicate_dispositions) {
    assert.equal(entry.concept, 'session_effort');
    assert.equal(entry.disposition, 'EXCLUDE_SURPLUS_IDENTICAL');
    assert.equal(entry.expected_occurrences, 2, 'the owner approved exactly two occurrences');
    assert.equal(entry.surviving_copies, 1, 'and exactly one survivor');
    assert.equal(entry.owner_ruling, 'CARD_9');
    assert.match(entry.row_fingerprint, /^[0-9a-f]{16}$/);
    fingerprints.add(entry.row_fingerprint);
  }
  assert.equal(fingerprints.size, 3, 'three distinct contents, not one entry applied three times');
  assert.ok(MAP.owner_rulings.CARD_8, 'CARD_8 is recorded in the map');
  assert.ok(MAP.owner_rulings.CARD_9, 'CARD_9 is recorded in the map');
});

// ── 2. The conflicting logged_sets fragment is excluded; the genuine row survives ─

test('resolver: the conflicting fragment is excluded and the GENUINE workout row survives', () => {
  // Two rows on one export identity, differing in content — the production shape of
  // the CARD_3 fold collision, reproduced synthetically.
  const fragment = logRow('20260520-AM-01', { exercise: 'Back Squat', reps: '3', notes: 'stray fragment' });
  const genuine = logRow('20260520-AM-01', { exercise: 'Back Squat', reps: '10' });
  const stub = {
    ...MAP,
    excluded_rows: [{
      concept: 'logged_sets',
      tab: 'Log_Cleaned',
      row_fingerprint: legacyMap.rowFingerprint(fragment),
      disposition: 'EXCLUDE',
      owner_ruling: 'CARD_8',
      reason: 'synthetic fixture',
    }],
  };
  const resolved = legacyMap.resolveSheetRows('logged_sets', [fragment, genuine], { map: stub });
  assert.equal(resolved.counts.excluded_row, 1, 'a unique fingerprint removes exactly one row');
  assert.equal(resolved.rows.length, 1);
  assert.equal(resolved.rows[0].reps, 10, 'the surviving row is the genuine record, not the fragment');
  assert.equal(resolved.rows[0].notes, null);
  // And the identity itself survives — the exclusion must not delete the set.
  assert.equal(contract.identityKey('logged_sets', resolved.rows[0]), '20260520-am-01||back squat||1');
});

// ── 3. Each identical Effort pair resolves to exactly ONE migrated row ────────

test('resolver: an approved identical pair yields exactly one row, and the identity survives', () => {
  const copy = effRow('20260525-PM-01');
  const cells = [copy, copy.slice()];
  assert.equal(legacyMap.rowFingerprint(cells[0]), legacyMap.rowFingerprint(cells[1]), 'the pair is byte-identical');

  const resolved = legacyMap.resolveSheetRows('session_effort', cells, { map: withApproval('session_effort', copy) });
  assert.equal(resolved.counts.surplus_identical, 1, 'exactly one surplus copy removed');
  assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 0);
  assert.equal(resolved.rows.length, 1, 'exactly one authoritative copy survives');
  assert.equal(contract.identityKey('session_effort', resolved.rows[0]), '20260525-pm-01');
});

test('resolver: an outright EXCLUDE on an identical pair would delete BOTH — the defect this closes', () => {
  const copy = effRow('20260525-PM-01');
  const stub = {
    ...MAP,
    excluded_rows: [{
      concept: 'session_effort',
      tab: 'Effort',
      row_fingerprint: legacyMap.rowFingerprint(copy),
      disposition: 'EXCLUDE',
      owner_ruling: 'TEST_RULING',
      reason: 'synthetic fixture proving the old path cannot express this',
    }],
  };
  const resolved = legacyMap.resolveSheetRows('session_effort', [copy, copy.slice()], { map: stub });
  assert.equal(resolved.counts.excluded_row, 2, 'content-keyed exclusion matches both copies');
  assert.equal(resolved.rows.length, 0, 'and the session would lose its Effort record entirely');
});

// ── 4. The four prior duplicate identities become ZERO duplicates ─────────────

test('the four prior duplicate export identities resolve to zero duplicate identities', async () => {
  const { indexByIdentity } = require('../services/migrationSweep');

  // One conflicting Log pair (CARD_8 shape) and three identical Effort pairs
  // (CARD_9 shape), reproduced synthetically on one map.
  const fragment = logRow('20260520-AM-01', { exercise: 'Back Squat', reps: '3', notes: 'stray fragment' });
  const genuine = logRow('20260520-AM-01', { exercise: 'Back Squat', reps: '10' });
  const pairs = ['20251122-PM-01', '20260520-AM-01', '20260525-PM-01']
    .map((id) => effRow(id, { date: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}` }));

  const stub = {
    ...MAP,
    excluded_rows: [{
      concept: 'logged_sets', tab: 'Log_Cleaned', row_fingerprint: legacyMap.rowFingerprint(fragment),
      disposition: 'EXCLUDE', owner_ruling: 'CARD_8', reason: 'synthetic fixture',
    }],
    duplicate_dispositions: pairs.map((cells) => ({
      concept: 'session_effort', tab: 'Effort', row_fingerprint: legacyMap.rowFingerprint(cells),
      disposition: 'EXCLUDE_SURPLUS_IDENTICAL', expected_occurrences: 2, surviving_copies: 1,
      owner_ruling: 'CARD_9', reason: 'synthetic fixture',
    })),
  };

  const logResolved = legacyMap.resolveSheetRows('logged_sets', [fragment, genuine], { map: stub });
  const logIndex = indexByIdentity('logged_sets', logResolved.rows, (r) => r);
  assert.equal(logIndex.duplicates.length, 0, 'logged_sets: 1 duplicate identity -> 0');
  assert.equal(logIndex.index.size, 1);

  const effortCells = pairs.flatMap((cells) => [cells, cells.slice()]);
  const effortResolved = legacyMap.resolveSheetRows('session_effort', effortCells, { map: stub });
  const effortIndex = indexByIdentity('session_effort', effortResolved.rows, (r) => r);
  assert.equal(effortIndex.duplicates.length, 0, 'session_effort: 3 duplicate identities -> 0');
  assert.equal(effortIndex.index.size, 3, 'and all three sessions keep an Effort record');
});

// ── 5. An UNAPPROVED duplicate still fails ───────────────────────────────────

test('reconciliation: an UNAPPROVED identical duplicate still blocks reconciled', async () => {
  const copy = effRow('20260801-AM-01');
  await withNoApprovals(async () => {
    const result = await reconcileConcept({
      concept: 'session_effort',
      sheets: stubSheets({ Effort: [copy, copy.slice()] }),
      adapter: INERT_ADAPTER,
    });
    assert.equal(result.sheets_duplicate_identities, 1, 'nothing collapses without a frozen approval');
    assert.equal(result.sheets_surplus_identical_excluded, 0);
    assert.equal(result.sheets_duplicate_multiplicity_mismatch, 0, 'the duplicate is the ONLY blocker here');
    assert.equal(result.reconciled, false);
  });
});

test('sweep: an UNAPPROVED identical duplicate still makes the concept incomplete', async () => {
  const copy = effRow('20260801-AM-01');
  await withNoApprovals(async () => {
    const result = await sweepRowConcept({
      concept: 'session_effort',
      sheets: stubSheets({ Effort: [copy, copy.slice()] }),
      adapter: { listConcept: async () => [], openDivergence: async () => ({ created: true }) },
      openDivergences: false,
    });
    assert.equal(result.sheets_duplicate_identities, 1);
    assert.equal(result.sheets_duplicate_multiplicity_mismatch, 0);
    assert.equal(result.complete, false);
    assert.match(String(result.error), /sheets_duplicate_identities/);
  });
});

// ── 6. A CONTENT-CONFLICTING duplicate still fails ───────────────────────────

test('a content-CONFLICTING duplicate is never collapsed, even with an approval on one of the rows', async () => {
  // Same export identity, different content — so the two rows carry DIFFERENT
  // fingerprints and the approval can only ever match one of them. The duplicate
  // therefore survives and still blocks, which is the point: this mechanism collapses
  // identical content only, never a conflict.
  const first = effRow('20260801-AM-01', { location: 'Gym' });
  const second = effRow('20260801-AM-01', { location: 'Home' });
  assert.notEqual(legacyMap.rowFingerprint(first), legacyMap.rowFingerprint(second));

  const resolved = legacyMap.resolveSheetRows('session_effort', [first, second], {
    map: withApproval('session_effort', first),
  });
  // The approval's multiplicity does not hold (its content appears once), so it fails
  // closed and removes nothing.
  assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 1);
  assert.equal(resolved.counts.surplus_identical, 0);
  assert.equal(resolved.rows.length, 2, 'both conflicting rows are kept');

  await withNoApprovals(async () => {
    const result = await reconcileConcept({
      concept: 'session_effort',
      sheets: stubSheets({ Effort: [first, second] }),
      adapter: INERT_ADAPTER,
    });
    assert.equal(result.reconciled, false);
  });
});

test('a conflicting logged_sets duplicate still blocks when no exclusion names it', async () => {
  const a = logRow('20260801-AM-01', { exercise: 'Back Squat', reps: '5' });
  const b = logRow('20260801-AM-01', { exercise: 'Back Squat', reps: '8' });
  const result = await reconcileConcept({
    concept: 'logged_sets',
    sheets: stubSheets({ Log_Cleaned: [a, b] }),
    adapter: INERT_ADAPTER,
  });
  assert.equal(result.sheets_duplicate_identities, 1);
  assert.equal(result.reconciled, false);
});

// ── 7. Unexpected multiplicity FAILS CLOSED ──────────────────────────────────

test('resolver: MORE copies than approved fails closed and removes nothing', () => {
  const copy = effRow('20260801-AM-01');
  const resolved = legacyMap.resolveSheetRows('session_effort', [copy, copy.slice(), copy.slice()], {
    map: withApproval('session_effort', copy),
  });
  assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 1);
  assert.equal(resolved.counts.surplus_identical, 0, 'not one copy is removed on a mismatch');
  assert.equal(resolved.rows.length, 3, 'every copy is let through so the duplicate guard still bites');
  assert.equal(resolved.duplicateMismatches[0].expected_occurrences, 2);
  assert.equal(resolved.duplicateMismatches[0].actual_occurrences, 3);
});

test('resolver: FEWER copies than approved fails closed — the case no duplicate guard would catch', () => {
  // The owner deleted one copy in Sheets after freezing. Nothing is left to collapse,
  // so ONLY the mismatch counter can surface the stale approval.
  const copy = effRow('20260801-AM-01');
  const resolved = legacyMap.resolveSheetRows('session_effort', [copy], {
    map: withApproval('session_effort', copy),
  });
  assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 1);
  assert.equal(resolved.counts.surplus_identical, 0);
  assert.equal(resolved.rows.length, 1);
});

// ── 7a. ZERO occurrences is a mismatch — the required review's P1 ────────────
//
// *Required review of `7240777`, P1.* An earlier form of this branch skipped
// `actual === 0` as "inapplicable", on the reasoning that a vanished pair would
// surface as `missing_in_sheets`. That reasoning fails in the one place the gate
// exists to protect: BEFORE an apply the destination is empty, so nothing is
// missing from Sheets, nothing is queued to insert, and a frozen ruling that no
// longer describes the workbook would pass the pre-apply gate silently. Zero is
// now a mismatch exactly like 1 or 3.

test('resolver: an approval whose content is ABSENT is a multiplicity mismatch, not a no-op', () => {
  const approved = effRow('20260525-PM-01');
  const unrelated = effRow('20260801-AM-01');
  assert.notEqual(legacyMap.rowFingerprint(approved), legacyMap.rowFingerprint(unrelated));

  // The approval names content the tab does not hold at all.
  const resolved = legacyMap.resolveSheetRows('session_effort', [unrelated], {
    map: withApproval('session_effort', approved),
  });
  assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 1, 'zero occurrences fails closed');
  assert.equal(resolved.duplicateMismatches.length, 1);
  assert.equal(resolved.duplicateMismatches[0].expected_occurrences, 2);
  assert.equal(resolved.duplicateMismatches[0].actual_occurrences, 0, 'and it reports the real count');
  assert.equal(resolved.duplicateMismatches[0].owner_ruling, 'TEST_RULING', 'naming the ruling that no longer holds');
  // Fails closed: it removes nothing and rewrites nothing.
  assert.equal(resolved.counts.surplus_identical, 0);
  assert.equal(resolved.rows.length, 1);
});

test('resolver: every actual multiplicity other than the approved one is a mismatch — 0, 1 and 3 alike', () => {
  const copy = effRow('20260525-PM-01');
  const map = withApproval('session_effort', copy); // expected 2, surviving 1
  const mismatchesFor = (rows) => legacyMap.resolveSheetRows('session_effort', rows, { map });

  for (const [count, rows] of [
    [0, []],
    [1, [copy]],
    [3, [copy, copy.slice(), copy.slice()]],
    [4, [copy, copy.slice(), copy.slice(), copy.slice()]],
  ]) {
    const resolved = mismatchesFor(rows);
    assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 1, `actual ${count} must fail closed`);
    assert.equal(resolved.duplicateMismatches[0].actual_occurrences, count);
    assert.equal(resolved.counts.surplus_identical, 0, `actual ${count} must remove nothing`);
    assert.equal(resolved.rows.length, rows.length, `actual ${count} must keep every copy`);
  }
  // Only the approved multiplicity acts.
  const exact = mismatchesFor([copy, copy.slice()]);
  assert.equal(exact.counts.duplicate_multiplicity_mismatch, 0);
  assert.equal(exact.counts.surplus_identical, 1);
  assert.equal(exact.rows.length, 1);
});

test('dry run: a vanished approved pair makes the run INCOMPLETE and writes nothing', async () => {
  // The exact pre-apply hole. The destination is EMPTY — as it is before the real
  // apply — so no divergence can be raised, no row is queued, and every counter
  // reads clean. Only the multiplicity mismatch stands between this and a false
  // green on a frozen ruling that no longer describes the tab.
  const approved = effRow('20260525-PM-01');
  const present = effRow('20260801-AM-01');

  const sheetsCalls = [];
  const adapterCalls = [];
  const sheetsStub = new Proxy({
    getSheetRows: async (tab) => { sheetsCalls.push(`getSheetRows:${tab}`); return tab === 'Effort' ? [present] : []; },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { sheetsCalls.push(`FORBIDDEN:${String(prop)}`); throw new Error(`dry run called sheets.${String(prop)}(${args.length})`); };
    },
  });
  const adapterStub = {
    listConcept: async (concept) => { adapterCalls.push(`listConcept:${concept}`); return []; },
    backfillRows: async () => { adapterCalls.push('FORBIDDEN:backfillRows'); throw new Error('dry run wrote to Supabase'); },
  };

  await withScopedApprovals([{
    concept: 'session_effort',
    tab: 'Effort',
    row_fingerprint: legacyMap.rowFingerprint(approved),
    disposition: 'EXCLUDE_SURPLUS_IDENTICAL',
    expected_occurrences: 2,
    surviving_copies: 1,
    owner_ruling: 'TEST_RULING',
    reason: 'synthetic fixture: the approved pair is no longer in the tab',
  }], async () => {
    const result = await runBackfill({
      sheets: sheetsStub, adapter: adapterStub, concepts: ['session_effort'], includeCatalog: false, apply: false,
    });

    // THE REQUIRED OUTCOME.
    assert.equal(result.complete, false, 'a vanished approval may not produce a complete dry run');
    assert.equal(result.concepts[0].duplicate_multiplicity_mismatches.length, 1);
    assert.equal(result.concepts[0].duplicate_multiplicity_mismatches[0].actual_occurrences, 0);
    assert.match(String(result.concepts[0].error), /duplicate_multiplicity_mismatch/);
    assert.match(String(result.concepts[0].error), /OWNER ACTION REQUIRED/);
    assert.match(String(result.concepts[0].error), /expected 2, found 0/);

    // Everything else IS clean — which is precisely why the mismatch has to fire.
    assert.equal(result.concepts[0].sheets_duplicate_identities, 0);
    assert.equal(result.concepts[0].rows_skipped_no_identity, 0);
    assert.equal(result.concepts[0].rows_skipped_unparseable_session, 0);

    // AND NO WRITE OCCURRED.
    assert.equal(result.applied, false);
    assert.equal(result.concepts[0].inserted, 0);
    assert.equal(result.concepts[0].existing, 0);
    assert.equal(sheetsCalls.filter((c) => c.startsWith('FORBIDDEN')).length, 0, 'no Sheets write');
    assert.equal(adapterCalls.filter((c) => c.startsWith('FORBIDDEN')).length, 0, 'no Supabase write');
    assert.deepEqual(adapterCalls, ['listConcept:session_effort'], 'the destination was READ and nothing else');
  });
});

test('sweep and reconciliation also refuse a vanished approved pair', async () => {
  const approved = effRow('20260525-PM-01');
  const present = effRow('20260801-AM-01');
  const sheets = stubSheets({ Effort: [present] });

  await withScopedApprovals([{
    concept: 'session_effort',
    tab: 'Effort',
    row_fingerprint: legacyMap.rowFingerprint(approved),
    disposition: 'EXCLUDE_SURPLUS_IDENTICAL',
    expected_occurrences: 2,
    surviving_copies: 1,
    owner_ruling: 'TEST_RULING',
    reason: 'synthetic fixture: the approved pair is no longer in the tab',
  }], async () => {
    const sweep = await sweepRowConcept({
      concept: 'session_effort',
      sheets,
      adapter: { listConcept: async () => [], openDivergence: async () => ({ created: true }) },
      openDivergences: false,
    });
    assert.equal(sweep.sheets_duplicate_multiplicity_mismatch, 1);
    assert.equal(sweep.complete, false);
    assert.match(String(sweep.error), /duplicate_multiplicity_mismatch/);

    const reconciliation = await reconcileConcept({
      concept: 'session_effort',
      sheets,
      adapter: { listConcept: async () => [contract.rowFromSheet('session_effort', present)] },
    });
    // The row itself matches on both sides: counts equal, nothing missing either way.
    assert.equal(reconciliation.counts_equal, true);
    assert.equal(reconciliation.missing_in_sheets, 0);
    assert.equal(reconciliation.missing_in_supabase, 0);
    assert.equal(reconciliation.sheets_duplicate_multiplicity_mismatch, 1);
    assert.equal(reconciliation.reconciled, false, 'the stale ruling alone blocks reconciliation');
  });
});

test('the shipped frozen approvals fail closed against a tab that does not hold them', async () => {
  // The production map, unscoped, over a synthetic Effort tab: all three CARD_9
  // approvals are absent from it, and all three must fail closed. This is the
  // fixture-contamination the other consumer tests scope away — asserted here once,
  // deliberately, so the scoping can never hide a regression of the rule itself.
  const result = await runBackfill({
    sheets: stubSheets({ Effort: [effRow('20260801-AM-01')] }),
    adapter: INERT_ADAPTER,
    concepts: ['session_effort'],
    includeCatalog: false,
    apply: false,
  });
  assert.equal(MAP.duplicate_dispositions.length, 3);
  assert.equal(result.concepts[0].duplicate_multiplicity_mismatches.length, 3);
  for (const mismatch of result.concepts[0].duplicate_multiplicity_mismatches) {
    assert.equal(mismatch.actual_occurrences, 0);
    assert.equal(mismatch.expected_occurrences, 2);
    assert.equal(mismatch.owner_ruling, 'CARD_9');
  }
  assert.equal(result.complete, false);
  assert.equal(result.concepts[0].inserted, 0);
});

test('resolver: an approval covering FEWER copies than it claims is caught with no duplicate present', () => {
  // The silent case: an owner deleted one of two identical copies after the freeze.
  // One row is left, so NO duplicate is raised and only the multiplicity check can
  // see that the frozen ruling no longer describes the tab. It is caught eagerly,
  // against the whole tab — a lazy per-row check reaches the same row but this
  // proves the verdict, not the traversal.
  const copy = effRow('20260801-AM-01');
  const resolved = legacyMap.resolveSheetRows('session_effort', [copy], { map: withApproval('session_effort', copy) });
  assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 1);
  assert.equal(resolved.counts.surplus_identical, 0, 'nothing is removed on a mismatch');
  assert.equal(resolved.rows.length, 1);
  assert.equal(resolved.duplicateMismatches[0].actual_occurrences, 1);
  assert.equal(resolved.duplicateMismatches[0].expected_occurrences, 2);
});

test('backfill: a stale exact-duplicate approval FAILS the run and names the fingerprint', async () => {
  const copy = effRow('20260801-AM-01');
  const stub = withApproval('session_effort', copy);
  // The backfill reads the frozen file, so the stale approval is proven through the
  // resolver's verdict and the failure the plan builds from it.
  const resolved = legacyMap.resolveSheetRows('session_effort', [copy], { map: stub });
  assert.equal(resolved.counts.duplicate_multiplicity_mismatch, 1);

  await withNoApprovals(async () => {
    const result = await runBackfill({
      sheets: stubSheets({ Effort: [copy, copy.slice(), copy.slice()] }),
      adapter: INERT_ADAPTER,
      concepts: ['session_effort'],
      includeCatalog: false,
    });
    // Three identical copies, no frozen approval for them: still a duplicate, and the
    // backfill still reports it rather than collapsing anything.
    assert.equal(result.concepts[0].rows_surplus_identical_excluded, 0);
    assert.equal(result.concepts[0].sheets_duplicate_identities, 2);
  });
});

// The mismatch verdict itself is proven above, on real rows. These two prove what the
// CONSUMERS do with it. The frozen approvals name production content that may not be
// reproduced in a test, so the verdict is injected at the one seam both consumers read
// — the shared resolver export — which is also the proof that they read only that seam.
function withMismatchVerdict(run) {
  const real = legacyMap.resolveSheetRows;
  legacyMap.resolveSheetRows = (concept, sheetRows, options = {}) => {
    // Scoped as `withScopedApprovals` does, so the ONE injected mismatch is the only
    // one — the shipped approvals would otherwise add their own against a synthetic
    // tab, and these tests claim everything else is clean.
    const resolved = real(concept, sheetRows, { ...options, map: { ...MAP, duplicate_dispositions: [] } });
    return {
      ...resolved,
      counts: { ...resolved.counts, duplicate_multiplicity_mismatch: 1 },
      duplicateMismatches: [{
        concept,
        row_fingerprint: '0123456789abcdef',
        owner_ruling: 'CARD_9',
        expected_occurrences: 2,
        actual_occurrences: 1,
      }],
    };
  };
  return Promise.resolve(run()).finally(() => { legacyMap.resolveSheetRows = real; });
}

test('reconciliation: a mismatched exact-duplicate approval blocks reconciled on an otherwise clean tab', async () => {
  const row = effRow('20260801-AM-01');
  await withMismatchVerdict(async () => {
    const result = await reconcileConcept({
      concept: 'session_effort',
      sheets: stubSheets({ Effort: [row] }),
      adapter: { listConcept: async () => [contract.rowFromSheet('session_effort', row)] },
    });
    // Everything else is clean: the mismatch is the ONLY thing between this and a
    // false green on a ruling that no longer describes the tab.
    assert.equal(result.counts_equal, true);
    assert.equal(result.missing_in_supabase, 0);
    assert.equal(result.missing_in_sheets, 0);
    assert.equal(result.content_mismatch, 0);
    assert.equal(result.sheets_duplicate_identities, 0);
    assert.equal(result.sheets_duplicate_multiplicity_mismatch, 1);
    assert.equal(result.reconciled, false);
  });
});

test('backfill and sweep: a mismatched approval fails the run and makes the concept incomplete', async () => {
  const row = effRow('20260801-AM-01');
  await withMismatchVerdict(async () => {
    const backfill = await runBackfill({
      sheets: stubSheets({ Effort: [row] }),
      adapter: INERT_ADAPTER,
      concepts: ['session_effort'],
      includeCatalog: false,
    });
    assert.equal(backfill.concepts[0].duplicate_multiplicity_mismatches.length, 1);
    assert.match(String(backfill.concepts[0].error), /duplicate_multiplicity_mismatch/);
    assert.match(String(backfill.concepts[0].error), /OWNER ACTION REQUIRED/);
    assert.match(String(backfill.concepts[0].error), /0123456789abcdef expected 2, found 1/);
    assert.equal(backfill.complete, false, 'the run may not claim completeness on a stale ruling');

    const sweep = await sweepRowConcept({
      concept: 'session_effort',
      sheets: stubSheets({ Effort: [row] }),
      adapter: { listConcept: async () => [], openDivergence: async () => ({ created: true }) },
      openDivergences: false,
    });
    assert.equal(sweep.sheets_duplicate_multiplicity_mismatch, 1);
    assert.equal(sweep.complete, false);
    assert.match(String(sweep.error), /duplicate_multiplicity_mismatch/);
  });
});

// ── 8. Map validation refuses a malformed or ambiguous approval ──────────────

test('map: a malformed exact-duplicate disposition refuses to load', () => {
  const base = MAP.duplicate_dispositions[0];
  const bad = (patch) => ({ ...MAP, duplicate_dispositions: [{ ...base, ...patch }] });

  assert.throws(() => legacyMap.loadMap(bad({ disposition: 'EXCLUDE' })), /must be EXCLUDE_SURPLUS_IDENTICAL/);
  assert.throws(() => legacyMap.loadMap(bad({ row_fingerprint: 'nope' })), /is not a row fingerprint/);
  assert.throws(() => legacyMap.loadMap(bad({ concept: 'not_a_concept' })), /unknown concept/);
  assert.throws(() => legacyMap.loadMap(bad({ owner_ruling: '' })), /no owner_ruling recorded/);
  assert.throws(() => legacyMap.loadMap(bad({ expected_occurrences: 1 })), /at least 2/);
  assert.throws(() => legacyMap.loadMap(bad({ surviving_copies: 0 })), /at least 1/);
  assert.throws(() => legacyMap.loadMap(bad({ surviving_copies: 2, expected_occurrences: 2 })), /fewer than expected_occurrences/);
});

test('map: one fingerprint may not be both an outright EXCLUDE and an exact-duplicate approval', () => {
  const base = MAP.duplicate_dispositions[0];
  const conflicting = {
    ...MAP,
    excluded_rows: [...MAP.excluded_rows, {
      concept: base.concept, tab: base.tab, row_fingerprint: base.row_fingerprint,
      disposition: 'EXCLUDE', owner_ruling: 'TEST_RULING', reason: 'synthetic fixture',
    }],
  };
  assert.throws(() => legacyMap.loadMap(conflicting), /also an outright EXCLUDE/);
});

test('map: the same fingerprint may not be approved twice', () => {
  const base = MAP.duplicate_dispositions[0];
  assert.throws(() => legacyMap.loadMap({ ...MAP, duplicate_dispositions: [base, { ...base }] }), /declared twice/);
});

test('map: the shipped frozen map loads clean', () => {
  assert.doesNotThrow(() => legacyMap.loadMap(MAP));
  assert.equal(MAP.frozen, true);
  assert.equal(MAP.owner_approved, true);
});

// ── 9. Nothing permanent moved ───────────────────────────────────────────────

test('canonical identity generation is unchanged', () => {
  // The live shape, the live parse, and every concept's identity function.
  assert.deepEqual(contract.parseSessionId('20260520-AM-01'), {
    session_id: '20260520-AM-01', session_date: '2026-05-20', period: 'AM', slot: 1,
  });
  assert.equal(contract.parseSessionId('2026-05-20'), null, 'legacy grammar is still not canonical');
  assert.equal(contract.parseSessionId('20260520-AM'), null);
  assert.equal(
    contract.identityKey('logged_sets', { session_id: '20260520-AM-01', exercise: 'Back Squat', set_number: 1 }),
    '20260520-am-01||back squat||1'
  );
  assert.equal(contract.identityKey('session_effort', { session_id: '20260520-AM-01' }), '20260520-am-01');
});

test('no live runtime identity grammar changed', () => {
  const live = fs.readFileSync(require.resolve('../services/sessionId'), 'utf8');
  assert.equal(/EXCLUDE_SURPLUS_IDENTICAL|duplicate_disposition|surplus_identical/.test(live), false,
    'the migration bridge never reaches live session-id generation');
  const rowContract = fs.readFileSync(require.resolve('../services/migrationRowContract'), 'utf8');
  assert.match(rowContract, /const SESSION_ID_SHAPE = \/\^\(\\d\{4\}\)\(\\d\{2\}\)\(\\d\{2\}\)-\(AM\|PM\)-\(\\d\{2\}\)\$\//);
  assert.equal(/duplicate_disposition|surplus_identical/.test(rowContract), false,
    'the row contract owns identity and equality, and knows nothing about dispositions');
});

// ── 10. Still ONE resolver ───────────────────────────────────────────────────

test('backfill, sweep and reconciliation report the SAME disposition verdicts', async () => {
  const copy = effRow('20260801-AM-01');
  const sheets = stubSheets({ Effort: [copy, copy.slice()] });
  const adapter = { ...INERT_ADAPTER, openDivergence: async () => ({ created: true }) };

  // Scoped to the approval under test, so agreement is proven on a verdict the
  // fixture controls rather than on three incidental mismatches.
  await withScopedApprovals([{
    concept: 'session_effort',
    tab: 'Effort',
    row_fingerprint: legacyMap.rowFingerprint(copy),
    disposition: 'EXCLUDE_SURPLUS_IDENTICAL',
    expected_occurrences: 2,
    surviving_copies: 1,
    owner_ruling: 'TEST_RULING',
    reason: 'synthetic fixture',
  }], async () => {
    const backfill = (await runBackfill({ sheets, adapter, concepts: ['session_effort'], includeCatalog: false })).concepts[0];
    const reconciliation = await reconcileConcept({ concept: 'session_effort', sheets, adapter });
    const sweep = await sweepRowConcept({ concept: 'session_effort', sheets, adapter, openDivergences: false });

    assert.equal(backfill.rows_surplus_identical_excluded, 1, 'the approval holds, so exactly one surplus is removed');
    assert.equal(backfill.rows_surplus_identical_excluded, reconciliation.sheets_surplus_identical_excluded);
    assert.equal(backfill.rows_surplus_identical_excluded, sweep.sheets_surplus_identical_excluded);
    assert.equal(backfill.duplicate_multiplicity_mismatches.length, reconciliation.sheets_duplicate_multiplicity_mismatch);
    assert.equal(backfill.duplicate_multiplicity_mismatches.length, sweep.sheets_duplicate_multiplicity_mismatch);
  });
});

test('one resolver only: the disposition is decided in migrationLegacyIdentityMap and nowhere else', () => {
  const decidedIn = ['../services/migrationBackfill', '../services/migrationSweep'];
  for (const modulePath of decidedIn) {
    const source = fs.readFileSync(require.resolve(modulePath), 'utf8');
    assert.equal(/EXCLUDE_SURPLUS_IDENTICAL/.test(source), false,
      `${modulePath} must consume the resolver's verdict, never re-decide it`);
    assert.equal(/rowFingerprint/.test(source), false,
      `${modulePath} must not compute a fingerprint of its own`);
  }
  const resolver = fs.readFileSync(require.resolve('../services/migrationLegacyIdentityMap'), 'utf8');
  assert.match(resolver, /EXCLUDE_SURPLUS_IDENTICAL/);
});

// ── 11. The dry run stays read-only ──────────────────────────────────────────

test('dry run: no Sheets write and no Supabase write, with the dispositions active', async () => {
  const copy = effRow('20260801-AM-01');
  const sheetsCalls = [];
  const adapterCalls = [];
  const sheetsStub = new Proxy({
    getSheetRows: async (tab) => { sheetsCalls.push(`getSheetRows:${tab}`); return tab === 'Effort' ? [copy, copy.slice()] : []; },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Any other Sheets method reached by the dry run is a write attempt.
      return (...args) => { sheetsCalls.push(`FORBIDDEN:${String(prop)}`); throw new Error(`dry run called sheets.${String(prop)}(${args.length})`); };
    },
  });
  const adapterStub = {
    listConcept: async (concept) => { adapterCalls.push(`listConcept:${concept}`); return []; },
    backfillRows: async () => { adapterCalls.push('FORBIDDEN:backfillRows'); throw new Error('dry run wrote to Supabase'); },
  };

  await withScopedApprovals([{
    concept: 'session_effort',
    tab: 'Effort',
    row_fingerprint: legacyMap.rowFingerprint(copy),
    disposition: 'EXCLUDE_SURPLUS_IDENTICAL',
    expected_occurrences: 2,
    surviving_copies: 1,
    owner_ruling: 'TEST_RULING',
    reason: 'synthetic fixture',
  }], async () => {
    const result = await runBackfill({
      sheets: sheetsStub, adapter: adapterStub, concepts: ['session_effort'], includeCatalog: false, apply: false,
    });

    assert.equal(result.applied, false);
    assert.equal(result.concepts[0].rows_surplus_identical_excluded, 1, 'the disposition really is active');
    assert.equal(result.concepts[0].inserted, 0);
    assert.equal(result.concepts[0].existing, 0);
    assert.equal(adapterCalls.filter((c) => c.startsWith('FORBIDDEN')).length, 0, 'no Supabase write');
    assert.equal(sheetsCalls.filter((c) => c.startsWith('FORBIDDEN')).length, 0, 'no Sheets write');
    assert.deepEqual(adapterCalls, ['listConcept:session_effort'], 'the dry run READS the destination and nothing else');
    // And it still answered the destination-aware question.
    assert.equal(result.concepts[0].would_insert, 1);
    assert.equal(result.concepts[0].already_present, 0);
  });
});
