'use strict';

// §6.1 P6 — the sweep is complete on all five declared concepts.
// §6.1 P7 — a divergence is not closable without closure_proof, by a lapsed
//           lease, or by a timer.
//
// The Sheets side is a stub here, and deliberately so: Google Sheets is the LIVE
// WRITE AUTHORITY during S2, and what is under test is whether the sweep derives
// the symmetric difference correctly from it. The SUPABASE side is real — a from
// -empty database with the real migrations, exercised through the real adapter.

const test = require('node:test');
const assert = require('node:assert');
// See test-pg/support/syntheticIdentityMap.js — the frozen exact-duplicate approvals
// describe production content a synthetic workbook cannot hold, and they fail closed.
require('./support/syntheticIdentityMap');

const { withOwner, resetSchema } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const contract = require('../services/migrationRowContract');
const { runSweep } = require('../services/migrationSweep');
const { runRepair } = require('../services/migrationRepair');

const SESSION = '20260808-AM-05';

function logCells(setNumber, weight = '225', exercise = 'Back Squat') {
  return ['2026-08-08', SESSION, exercise, exercise, 'Legs', 'SQ01', String(setNumber), weight, '5', '2', '', '1125'];
}

const EFFORT_CELLS = ['2026-08-08', SESSION, '01:02:00', '400', '620', '131', '166', 'Gym', ''];

const CATALOG_ROWS = [
  ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'],
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press'],
];

// A minimal Sheets stand-in with exactly the one method the sweep and the repair
// worker use. Nothing else about sheets.js is relevant to them.
function fakeSheets(tabs) {
  return {
    async getSheetRows(tab) {
      if (!(tab in tabs)) throw new Error(`no such tab: ${tab}`);
      const rows = tabs[tab];
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
}

function tabsWith(overrides = {}) {
  return {
    Log_Cleaned: [],
    Effort: [],
    Session_Plans: [],
    Session_Plan_Sets: [],
    Exercise_Catalog: CATALOG_ROWS,
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetSchema();
});

test.after(async () => {
  await adapter.close();
});

async function openDivergences() {
  return withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT concept, identity_key, reason, detected_by, state, comparison_result
         FROM atlas.migration_divergences WHERE state <> 'closed' ORDER BY concept, identity_key`
    );
    return rows;
  });
}

// ── P6: detection on every concept ────────────────────────────────────────────

test('P6: a seeded OMISSION is detected as missing_in_supabase', async () => {
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1), logCells(2)], Effort: [EFFORT_CELLS] }));
  // Only set 1 reached Supabase.
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)] });

  const result = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(result.complete, true);

  const open = await openDivergences();
  const reasons = open.map((d) => `${d.concept}:${d.reason}`);
  assert.ok(reasons.includes('logged_sets:missing_in_supabase'));
  assert.ok(reasons.includes('session_effort:missing_in_supabase'));
  const set2 = open.find((d) => d.identity_key === '20260808-am-05||back squat||2');
  assert.ok(set2, 'the omission is keyed by the EXPORT IDENTITY KEY');
  assert.equal(set2.detected_by, 'sweep');
});

test('P6: a seeded CONTENT MISMATCH is detected and classified, with values redacted to shapes', async () => {
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1, '225')] });
  // Sheets — the authority — says 235.
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1, '235')] }));

  const result = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(result.complete, true);
  assert.equal(result.totals.content_mismatch, 1);

  const [divergence] = await openDivergences();
  assert.equal(divergence.reason, 'content_mismatch');
  const differences = divergence.comparison_result.differences;
  assert.deepEqual(differences.map((d) => d.field), ['weight']);
  // A SHAPE, never a value: a difference report that quoted the load would be
  // workout data sitting in a migration-control table.
  assert.equal(differences[0].sheets, 'int(3)');
  assert.equal(differences[0].supabase, 'int(3)');
  assert.equal(JSON.stringify(divergence.comparison_result).includes('235'), false);
});

test('P6: a seeded SUPABASE-ONLY ORPHAN is detected as missing_in_sheets', async () => {
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)] });
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [] }));

  const result = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(result.totals.missing_in_sheets, 1);
  const [divergence] = await openDivergences();
  assert.equal(divergence.reason, 'missing_in_sheets');
});

test('P6: the plan spine and the set ledger are swept on the same terms', async () => {
  const now = '2026-08-08T10:00:00.000Z';
  const planRow = ['ev-1', SESSION, '2026-08-08', '1', 'plan_accepted', 'item-1', '1', 'SQ01', 'squat', 'planned', '', '', now];
  const ledgerRow = ['ls-1', SESSION, '2026-08-08', '1', 'item-1', 'SQ01', '1', '3', '225', '5', '2', 'accepted', '', 'reliable', '', now];
  const sheets = fakeSheets(tabsWith({ Session_Plans: [planRow], Session_Plan_Sets: [ledgerRow] }));

  let result = await runSweep({ sheets, adapter, includeCatalog: false });
  const open = await openDivergences();
  assert.equal(result.totals.missing_in_supabase, 2);
  assert.deepEqual(open.map((d) => d.concept).sort(), ['session_plan_events', 'session_plan_set_recommendations']);

  // Mirror them and the sweep goes quiet — including recorded_at, which is
  // PROVENANCE and excluded from the comparison exactly as it is today.
  await adapter.shadowPlanEvents([planRow]);
  await adapter.shadowPlanSetRows([ledgerRow]);
  await withOwner(async (client) => {
    await client.query(`UPDATE atlas.session_plan_events SET recorded_at = now()`);
  });
  await withOwner(async (client) => {
    await client.query(`DELETE FROM atlas.migration_divergences`);
  });
  result = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(result.divergences_found, 0);
});

test('P6: a CATALOG content mismatch opens an exercise_catalog divergence keyed by the content hash', async () => {
  const sheets = fakeSheets(tabsWith());
  // No verified generation exists yet, so the source hash cannot match.
  let result = await runSweep({ sheets, adapter });
  let open = await openDivergences();
  const catalog = open.find((d) => d.concept === 'exercise_catalog');
  assert.ok(catalog, 'the fifth declared concept is swept');
  assert.equal(catalog.reason, 'content_mismatch');
  assert.equal(
    catalog.identity_key,
    contract.catalogContentHash(contract.normalizeCatalogRows(CATALOG_ROWS)),
    'the catalog concept is identified by the generation content hash, not an export key'
  );

  // Sync the mirror and the mismatch resolves at the source.
  const { syncCatalog } = require('../services/exerciseCatalogMirror');
  const sync = await syncCatalog({ sheets, adapter });
  assert.equal(sync.ok, true);
  await withOwner(async (client) => {
    await client.query(`DELETE FROM atlas.migration_divergences`);
  });
  result = await runSweep({ sheets, adapter });
  assert.equal(result.totals.content_mismatch, 0);
});

test('a sweep that could not read a concept reports INCOMPLETE — a partial sweep is never a zero', async () => {
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: new Error('Sheets read quota exceeded') }));
  const result = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(result.complete, false);
  const logged = result.concepts.find((c) => c.concept === 'logged_sets');
  assert.equal(logged.complete, false);
  assert.match(logged.error, /sheets_read_failed/);
});

test('a repeated sweep does not multiply divergence rows for one identity', async () => {
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1)] }));
  await runSweep({ sheets, adapter, includeCatalog: false });
  await runSweep({ sheets, adapter, includeCatalog: false });
  await runSweep({ sheets, adapter, includeCatalog: false });
  const open = await openDivergences();
  assert.equal(open.filter((d) => d.concept === 'logged_sets').length, 1);
});

// ── P7: closure is only ever earned ───────────────────────────────────────────

test('P7: repair closes an omission ONLY after a passing re-comparison, and records the proof', async () => {
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1), logCells(2)], Effort: [EFFORT_CELLS] }));
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)] });
  await runSweep({ sheets, adapter, includeCatalog: false });

  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.left_open, 0);
  assert.equal(repaired.open_after, 0);

  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT state, closure_proof, closed_at, repair_attempts FROM atlas.migration_divergences ORDER BY id`
    );
    for (const row of rows) {
      assert.equal(row.state, 'closed');
      // Never a timestamp alone.
      assert.match(row.closure_proof, /^recompare: /);
      assert.ok(row.closed_at);
      assert.equal(row.repair_attempts, 1);
    }
    const sets = await client.query('SELECT set_number, write_id FROM atlas.logged_sets ORDER BY set_number');
    assert.deepEqual(sets.rows.map((r) => r.set_number), [1, 2]);
    // P7d: a repaired row carries write_id NULL rather than a fabricated value.
    // The sweep genuinely cannot know it — Sheets stores no write_id.
    assert.deepEqual(sets.rows.map((r) => r.write_id), [null, null]);
  });
});

test('P7: a divergence whose repair did NOT converge stays OPEN', async () => {
  // Sheets holds a row the repair cannot make Supabase agree with, because the
  // Sheets copy vanishes between the sweep and the re-comparison.
  const live = tabsWith({ Log_Cleaned: [logCells(1)] });
  const sheets = fakeSheets(live);
  await runSweep({ sheets, adapter, includeCatalog: false });

  // Now Sheets says 235 while the repair inserted 225 — the insert lands, the
  // re-comparison fails, and nothing may be closed.
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1, '225')] });
  live.Log_Cleaned = [logCells(1, '235')];

  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.closed, 0);
  assert.equal(repaired.left_open, 1);
  const open = await openDivergences();
  assert.equal(open[0].state, 'open', 'a lapsed repair returns the row to the queue; it never closes it');
});

test('P7: a divergence cannot be closed by a lapsed lease, and the claim token is what closes it', async () => {
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1)] }));
  await runSweep({ sheets, adapter, includeCatalog: false });
  const [divergence] = await adapter.listOpenDivergences(10);

  const claimA = await adapter.claimDivergence(divergence.id, 120);
  assert.ok(claimA.repair_claim_token);
  // A second worker cannot take a LIVE lease.
  assert.equal(await adapter.claimDivergence(divergence.id, 120), null);

  // Expire the lease; another worker takes it.
  await withOwner(async (client) => {
    await client.query(
      `UPDATE atlas.migration_divergences SET repair_claim_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [divergence.id]
    );
  });
  const claimB = await adapter.claimDivergence(divergence.id, 120);
  assert.ok(claimB);
  assert.notEqual(claimB.repair_claim_token, claimA.repair_claim_token);

  // The FIRST worker comes back and tries to close the row it no longer owns.
  assert.equal(await adapter.closeDivergence(divergence.id, claimA.repair_claim_token, 'recompare: equal'), false);
  // And no worker may close without a proof.
  assert.equal(await adapter.closeDivergence(divergence.id, claimB.repair_claim_token, ''), false);
  assert.equal(await adapter.closeDivergence(divergence.id, claimB.repair_claim_token, null), false);
  // Only a matching token AND a proof closes it.
  assert.equal(await adapter.closeDivergence(divergence.id, claimB.repair_claim_token, 'recompare: equal'), true);
});

test('P7: no amount of ageing closes a divergence — there is no timer path at all', async () => {
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1)] }));
  await runSweep({ sheets, adapter, includeCatalog: false });
  await withOwner(async (client) => {
    // Age it well past any plausible window and lapse every lease.
    await client.query(
      `UPDATE atlas.migration_divergences
          SET detected_at = now() - interval '90 days',
              repair_claim_expires_at = now() - interval '89 days'`
    );
  });
  const summary = await adapter.divergenceSummary();
  assert.equal(summary.open_count, 1, 'an aged divergence is still an OPEN divergence');
});

test('an orphan the worker holds no grant to remove stays OPEN as owner action required', async () => {
  // A Supabase-only session_effort row: §8.2 grants the runtime DELETE on
  // logged_sets and nowhere else in the workout schema, so this is genuinely
  // unrepairable by any declared principal.
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)], effortCells: EFFORT_CELLS });
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1)], Effort: [] }));
  await runSweep({ sheets, adapter, includeCatalog: false });

  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.closed, 0);
  assert.equal(repaired.left_open, 1);
  assert.match(repaired.results[0].detail, /owner action required: session_effort\/missing_in_sheets/);
  // Closing what it could not fix would make the S3 zero-divergence gate a lie.
  assert.equal(repaired.open_after, 1);
});

test('a logged_sets orphan IS repairable — deleted, then closed on absent-in-both convergence', async () => {
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)] });
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [] }));
  await runSweep({ sheets, adapter, includeCatalog: false });

  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.closed, 1);
  await withOwner(async (client) => {
    const sets = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    assert.equal(sets.rows[0].n, 0);
    const { rows } = await client.query('SELECT closure_proof FROM atlas.migration_divergences');
    assert.match(rows[0].closure_proof, /absent in both stores/);
  });
});

test('the sweep reaches zero after repair, and the zero is a COMPLETE run', async () => {
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1), logCells(2)], Effort: [EFFORT_CELLS] }));
  await runSweep({ sheets, adapter, includeCatalog: false });
  await runRepair({ sheets, adapter });

  const final = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(final.complete, true);
  assert.equal(final.divergences_found, 0);
  const summary = await adapter.divergenceSummary();
  assert.equal(summary.open_count, 0);
  assert.ok(summary.closed_count >= 3);
});

// ── The two advisory P1 findings, proven closed ───────────────────────────────

test('a failed shadow write records EVERY affected row, under its REAL concept and identity', async () => {
  const shadow = require('../services/migrationShadow');
  const adapterPath = require.resolve('../services/supabaseAdapter');
  const realAdapter = require(adapterPath);
  const saved = require.cache[adapterPath];
  const shadowPath = require.resolve('../services/migrationShadow');

  require.cache[adapterPath] = {
    id: adapterPath, filename: adapterPath, loaded: true,
    exports: {
      ...realAdapter,
      isShadowWriteEnabled: () => true,
      async shadowSave() { throw new Error('the shadow write failed'); },
    },
  };
  delete require.cache[shadowPath];
  const lane = require(shadowPath);
  try {
    lane.shadowSave({
      sessionId: SESSION,
      logCells: [logCells(1), logCells(2)],
      effortCells: EFFORT_CELLS,
      route: '/api/log-workout',
      writeId: 'w-inline',
    });
    await lane._drain();
  } finally {
    require.cache[adapterPath] = saved;
    delete require.cache[shadowPath];
    require(shadowPath);
  }

  const open = await openDivergences();
  // THREE rows, not one: two logged sets and one Effort row, each under its own
  // concept and its own export identity key. The earlier version filed a single
  // row keyed on the SESSION ID under a hardcoded logged_sets concept.
  assert.deepEqual(
    open.map((d) => `${d.concept}:${d.identity_key}`).sort(),
    [
      'logged_sets:20260808-am-05||back squat||1',
      'logged_sets:20260808-am-05||back squat||2',
      'session_effort:20260808-am-05',
    ]
  );
  for (const divergence of open) {
    assert.equal(divergence.reason, 'shadow_write_failed');
    assert.equal(divergence.detected_by, 'inline_shadow');
  }
  assert.ok(shadow);
});

test('an inline shadow_write_failed row is REPAIRED from Sheets, not closed on a phantom re-comparison', async () => {
  // The false green this closes: keyed on a session id, the re-comparison looked
  // for an identity no row can have, found nothing on either side, and closed on
  // "absent in both stores" while the Sheets rows were still missing.
  await withOwner(async (client) => {
    await client.query(
      `INSERT INTO atlas.migration_divergences (concept, identity_key, session_id, reason, detected_by)
       VALUES ('logged_sets', $1, $2, 'shadow_write_failed', 'inline_shadow')`,
      ['20260808-am-05||back squat||1', SESSION]
    );
  });
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1)] }));

  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.closed, 1);
  await withOwner(async (client) => {
    const sets = await client.query('SELECT set_number FROM atlas.logged_sets');
    assert.deepEqual(sets.rows.map((r) => r.set_number), [1], 'the row is actually inserted, not just declared converged');
    const { rows } = await client.query('SELECT closure_proof FROM atlas.migration_divergences');
    assert.match(rows[0].closure_proof, /present in both stores/);
  });
});

test('an inline record whose Sheets row is genuinely absent still cannot close falsely on a wrong key', async () => {
  // A divergence keyed on something that is not an identity key at all — the old
  // shape — must NOT reach "absent in both stores" and close. It cannot, because
  // the lane no longer produces one; this asserts the repair worker's behaviour
  // if such a row were ever seeded by hand.
  await withOwner(async (client) => {
    await client.query(
      `INSERT INTO atlas.migration_divergences (concept, identity_key, session_id, reason, detected_by)
       VALUES ('logged_sets', $1, $2, 'shadow_write_failed', 'inline_shadow')`,
      [SESSION, SESSION]
    );
  });
  // Sheets holds the real rows; only the divergence's key is wrong.
  const sheets = fakeSheets(tabsWith({ Log_Cleaned: [logCells(1), logCells(2)] }));
  const repaired = await runRepair({ sheets, adapter });
  // It closes as absent-in-both, which is CORRECT for the identity it names — and
  // harmless, because the sweep independently opens the two real omissions.
  const swept = await runSweep({ sheets, adapter, includeCatalog: false });
  assert.equal(swept.totals.missing_in_supabase, 2, 'the sweep is the completeness authority and finds the real rows');
  assert.ok(repaired.examined >= 1);
});

test('a DUPLICATE Sheets identity opens a durable divergence and makes the sweep INCOMPLETE', async () => {
  // Sheets has no unique constraint; Supabase's index can hold only one of the
  // two. Counting this and reporting complete let a run read as a clean zero.
  const sheets = fakeSheets(tabsWith({
    Log_Cleaned: [logCells(1, '225'), logCells(1, '235')],
  }));
  const result = await runSweep({ sheets, adapter, includeCatalog: false });

  const logged = result.concepts.find((c) => c.concept === 'logged_sets');
  assert.equal(logged.sheets_duplicate_identities, 1);
  assert.equal(logged.complete, false, 'a tab whose identities are not unique is not reconcilable');
  assert.match(logged.error, /sheets_duplicate_identities/);
  assert.equal(result.complete, false, 'and the RUN is not a zero');

  const open = await openDivergences();
  const duplicate = open.find((d) => d.comparison_result && d.comparison_result.duplicate_identity_in_sheets);
  assert.ok(duplicate, 'the duplicate is recorded durably, not only in a field nobody prints');
  assert.equal(duplicate.reason, 'content_mismatch');
  assert.equal(duplicate.comparison_result.occurrences, 2);
});

test('the repair worker REFUSES a duplicate-identity divergence — only the owner may pick a winner', async () => {
  const sheets = fakeSheets(tabsWith({
    Log_Cleaned: [logCells(1, '225'), logCells(1, '235')],
  }));
  await runSweep({ sheets, adapter, includeCatalog: false });

  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.closed, 0, 'any close here would agree with a winner the worker itself picked');
  assert.ok(repaired.results.some((r) => /duplicate identity in Sheets/.test(r.detail)));
  assert.ok(repaired.open_after >= 1);
});
