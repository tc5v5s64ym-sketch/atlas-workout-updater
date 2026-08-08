'use strict';

// §6.1 P7b  — the catalog mirror is proven FAIL-CLOSED.
// §6.1 P7b1 — a legitimate catalog edit SYNCHRONISES; it never fails.
//
// These two gates are a matched pair, and the pairing is the point: a test that
// only exercises failure cannot tell a normal owner edit from a broken sync, and
// a test that only shows a fresh mirror is served does not discharge fail-closed.

const test = require('node:test');
const assert = require('node:assert');
const { withOwner, resetSchema } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const mirror = require('../services/exerciseCatalogMirror');
const contract = require('../services/migrationRowContract');

const HEADER = ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'];

function catalog(rows) {
  return [HEADER, ...rows];
}

const BASE_ROWS = [
  ['Back Squat', 'Legs', 'SQ01', 'Back Squat'],
  ['Bench Press', 'Chest', 'BEN01', 'Bench Press'],
  ['Romanian Deadlift', 'Hamstrings', 'RDL01', 'Romanian Deadlift'],
  ['Overhead Press', 'Shoulders', 'OHP01', 'Overhead Press'],
];

function fakeSheets(rowsOrError) {
  return {
    async getSheetRows() {
      if (rowsOrError instanceof Error) throw rowsOrError;
      return rowsOrError;
    },
  };
}

test.beforeEach(async () => {
  await resetSchema();
  delete process.env.ATLAS_CATALOG_MIRROR_MAX_AGE_SEC;
});

test.after(async () => {
  delete process.env.ATLAS_CATALOG_MIRROR_MAX_AGE_SEC;
  await adapter.close();
});

async function generations() {
  return withOwner(async (client) => {
    const { rows } = await client.query(
      'SELECT sync_id, status, verified_at, content_hash, source_row_count, last_error FROM atlas.exercise_catalog_sync ORDER BY sync_id'
    );
    return rows;
  });
}

// ── P7b1: the normal case, which is an EDIT and not a failure ─────────────────

test('P7b1: a legitimate catalog edit produces a NEW VERIFIED generation and advances currency', async () => {
  const first = await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  assert.equal(first.ok, true);
  assert.equal(first.rows, 4);

  // The owner edits one row. Sheets is the EDITING authority, so a different
  // content hash is the normal, expected signal — not a failure.
  const edited = BASE_ROWS.map((row) => (row[0] === 'Bench Press' ? ['Bench Press', 'Chest', 'BEN02', 'Bench Press'] : row));
  const second = await mirror.syncCatalog({ sheets: fakeSheets(catalog(edited)), adapter });
  assert.equal(second.ok, true);
  assert.equal(second.changed, true, 'a changed source is reported as changed');
  assert.notEqual(second.sync_id, first.sync_id);

  const all = await generations();
  assert.deepEqual(all.map((g) => g.status), ['verified', 'verified']);
  // NOTHING is recorded as a failure, and nothing ages toward fail-closed.
  assert.deepEqual(all.map((g) => g.last_error), [null, null]);

  const current = await adapter.currentCatalogGeneration();
  assert.equal(current.sync_id, second.sync_id, 'currency advances to the new generation');

  // And the Save path stays continuously serviceable across the edit.
  const served = await mirror.readCatalogForSave({ adapter });
  assert.equal(served.currency.servable, true);
  assert.equal(served.rows.length, 4);
  assert.equal(served.rows.find((r) => r.exercise === 'bench press').lift_code, 'BEN02');
});

test('P7b1: an UNCHANGED source is also a normal verified sync — it is simply reported as unchanged', async () => {
  await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  const again = await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

test('the swap is ONE transaction — a reader never sees a half-written catalog', async () => {
  await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  const before = await adapter.readCatalogMirror();

  // A swap that fails mid-flight must leave the previous generation's rows whole,
  // not a partially replaced catalog.
  const poisoned = catalog([...BASE_ROWS, ['Bad Row', 'X', 'Y', 'Z']]);
  const originalInsert = adapter.SQL.insertCatalogRow;
  assert.ok(originalInsert);

  const failing = {
    ...adapter,
    async commitCatalogSwap() {
      throw new Error('the swap transaction failed');
    },
  };
  const result = await mirror.syncCatalog({ sheets: fakeSheets(poisoned), adapter: failing });
  assert.equal(result.ok, false);

  const after = await adapter.readCatalogMirror();
  assert.deepEqual(after.map((r) => r.exercise), before.map((r) => r.exercise));
});

// ── P7b: every genuine failure mode, and none of them advances currency ───────

test('P7b: a READ FAILURE never advances currency and never records a generation it could not read', async () => {
  await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  const good = await adapter.currentCatalogGeneration();

  const result = await mirror.syncCatalog({ sheets: fakeSheets(new Error('Sheets quota exceeded')), adapter });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_READ_FAILED');

  const current = await adapter.currentCatalogGeneration();
  assert.equal(current.sync_id, good.sync_id, 'the prior verified generation stays current, and keeps ageing');
});

test('P7b: an EMPTY source is refused — an empty catalog is never written', async () => {
  await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  const result = await mirror.syncCatalog({ sheets: fakeSheets([HEADER]), adapter });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY_SOURCE');

  const all = await generations();
  const failed = all.find((g) => g.sync_id === result.sync_id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /empty/i);
  // A failure cannot buy the mirror more time.
  assert.equal(failed.verified_at, null);
  const served = await adapter.readCatalogMirror();
  assert.equal(served.length, 4, 'the good catalog is untouched');
});

test('P7b: a MATERIALLY SHRUNKEN source is refused rather than replacing a good catalog with a truncated one', async () => {
  await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  const result = await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS.slice(0, 1))), adapter });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SOURCE_SHRANK');

  const all = await generations();
  assert.equal(all.find((g) => g.sync_id === result.sync_id).status, 'failed');
  assert.equal((await adapter.readCatalogMirror()).length, 4);
});

test('P7b: a FAILED SWAP records status=failed with its exact error and leaves the prior generation current', async () => {
  const first = await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  const failing = {
    ...adapter,
    async commitCatalogSwap() {
      throw new Error('deadlock detected during the generation swap');
    },
  };
  const result = await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter: failing });
  assert.equal(result.ok, false);

  const all = await generations();
  const failed = all.find((g) => g.sync_id === result.sync_id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /deadlock detected/);
  assert.equal((await adapter.currentCatalogGeneration()).sync_id, first.sync_id);
});

test('P7b: a generation older than CATALOG_MIRROR_MAX_AGE is NOT SERVED — the Save fails closed with a reason', async () => {
  await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  // Fresh: served.
  assert.equal((await mirror.readCatalogForSave({ adapter })).currency.servable, true);

  process.env.ATLAS_CATALOG_MIRROR_MAX_AGE_SEC = '60';
  await withOwner(async (client) => {
    await client.query(`UPDATE atlas.exercise_catalog_sync SET verified_at = now() - interval '2 hours'`);
  });

  // The same 503 posture the expired cache produces today. Stale content is
  // never served silently, and never served AT ALL — there is no
  // stale-after-expiry fallback here, exactly as there is none in sheets.js.
  await assert.rejects(
    mirror.readCatalogForSave({ adapter }),
    (err) => {
      assert.equal(err.code, 'CATALOG_MIRROR_UNAVAILABLE');
      assert.equal(err.reason, 'catalog_mirror_stale');
      assert.equal(err.status, 503);
      return true;
    }
  );
});

test('P7b: a persistently failing sync eventually fails Saves closed — a failure cannot buy time', async () => {
  await mirror.syncCatalog({ sheets: fakeSheets(catalog(BASE_ROWS)), adapter });
  process.env.ATLAS_CATALOG_MIRROR_MAX_AGE_SEC = '60';

  // Three failed attempts in a row. None of them advances currency.
  for (let i = 0; i < 3; i++) {
    const result = await mirror.syncCatalog({ sheets: fakeSheets(new Error('Sheets is down')), adapter });
    assert.equal(result.ok, false);
  }
  await withOwner(async (client) => {
    await client.query(`UPDATE atlas.exercise_catalog_sync SET verified_at = now() - interval '2 hours' WHERE status = 'verified'`);
  });
  await assert.rejects(mirror.readCatalogForSave({ adapter }), /not servable/);
});

test('P7b: a mirror that was NEVER synced fails closed too, with its own reason', async () => {
  await assert.rejects(
    mirror.readCatalogForSave({ adapter }),
    (err) => err.reason === 'catalog_mirror_never_synced'
  );
});

test('the content hash is recorded on the ATTEMPT, so a failed generation names the content it tried', async () => {
  const rows = catalog(BASE_ROWS);
  const expected = contract.catalogContentHash(contract.normalizeCatalogRows(rows));
  const failing = {
    ...adapter,
    async commitCatalogSwap() {
      throw new Error('swap failed');
    },
  };
  const result = await mirror.syncCatalog({ sheets: fakeSheets(rows), adapter: failing });
  const all = await generations();
  const failed = all.find((g) => g.sync_id === result.sync_id);
  assert.equal(failed.content_hash, expected);
  assert.equal(failed.status, 'failed');
});
