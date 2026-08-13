'use strict';

// The exercise catalog, proven against a real from-empty Postgres database.
//
// AUTHORITY: OWNER CORRECTION 2026-08-13 (docs/ATLAS_V1_EXECUTION_PLAN.md).
// Supabase is the SOLE live authority for Exercise_Catalog.
//
// ── WHAT THIS REPLACED, AND WHY THE OLD PROOF COULD NOT BE PATCHED ────────────
//
// test-pg/catalogMirror.pgproof.js proved §6.1 P7b and P7b1: that a mirror older
// than CATALOG_MIRROR_MAX_AGE was refused, that a failed sync did not advance
// currency, and that a legitimate Sheets edit produced a new verified generation.
// Every one of those propositions is about the freshness of a projection of a
// Google Sheets tab. The correction deletes the projection, so the propositions
// have no subject left — a fail-closed-past-the-age-bound test cannot be rewritten
// against a table that has no age. The file is deleted rather than adapted, and
// the properties that DO survive are proven here instead.
//
// ── WHAT MUST BE TRUE NOW ─────────────────────────────────────────────────────
//
//   1. The runtime role can READ the catalog.
//   2. The runtime role CANNOT change it. This is the whole meaning of
//      "explicitly owner-controlled mutation", and it is enforced by the grant
//      rather than by a code path nobody calls — so it is proven AS the real role.
//   3. Owner maintenance works, transactionally, as atlas_migrate.
//   4. There is no freshness authority left to go stale, and no age at which a
//      read starts failing.
//   5. Reading the catalog touches no Google Sheets client. This is the property
//      the owner correction exists to create.

const test = require('node:test');
const assert = require('node:assert');
const { withOwner, withRole, resetSchema, expectRejected, SQLSTATE } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const { readExerciseCatalogRows, catalogRowFromInput } = require('../services/exerciseCatalog');

const BASE_ROWS = [
  { exercise: 'Back Squat', muscle_group: 'Legs', lift_code: 'SQ01' },
  { exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BEN01' },
  { exercise: 'Romanian Deadlift', muscle_group: 'Hamstrings', lift_code: 'RDL01' },
];

async function seedCatalog(rows = BASE_ROWS) {
  await withOwner(async (client) => {
    for (const input of rows) {
      const row = catalogRowFromInput(input);
      await client.query(
        `INSERT INTO atlas.exercise_catalog
           (exercise, display_exercise, muscle_group, lift_code, canonical_exercise)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (exercise) DO UPDATE SET display_exercise = EXCLUDED.display_exercise`,
        [row.exercise, row.display_exercise, row.muscle_group, row.lift_code, row.canonical_exercise]
      );
    }
  });
}

async function catalogKeys() {
  return withOwner(async (client) => {
    const { rows } = await client.query('SELECT exercise FROM atlas.exercise_catalog ORDER BY exercise');
    return rows.map((row) => row.exercise);
  });
}

test.beforeEach(async () => {
  await resetSchema();
});

test.after(async () => {
  await adapter.close();
});

// ── 1. The freshness authority is genuinely gone ──────────────────────────────

test('the catalog has no freshness authority: exercise_catalog_sync does not exist, and the mirror name is retired', async () => {
  const present = await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'atlas' ORDER BY tablename`
    );
    return rows.map((row) => row.tablename);
  });

  assert.ok(present.includes('exercise_catalog'), 'the catalog authority table must exist');
  assert.ok(
    !present.includes('exercise_catalog_sync'),
    'the freshness clock must be gone — a surviving generation table is a surviving 503 path'
  );
  assert.ok(
    !present.includes('exercise_catalog_mirror'),
    'the mirror name must be retired, so no reader can believe Sheets still decides this content'
  );
});

test('the catalog carries no sync provenance column, so nothing can re-derive a generation from it', async () => {
  const columns = await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'atlas' AND table_name = 'exercise_catalog'
        ORDER BY column_name`
    );
    return rows.map((row) => row.column_name);
  });
  assert.ok(!columns.includes('sync_id'), 'sync_id must be dropped with the generation concept');
  for (const required of ['exercise', 'display_exercise', 'muscle_group', 'lift_code', 'canonical_exercise']) {
    assert.ok(columns.includes(required), `the catalog must still carry ${required}`);
  }
});

// ── 2. The runtime reads, and cannot write ────────────────────────────────────

test('atlas_app CAN read the catalog — the Save path depends on exactly this', async () => {
  await seedCatalog();
  const rows = await withRole('atlas_app', async (client) => {
    const { rows: found } = await client.query('SELECT exercise, lift_code FROM atlas.exercise_catalog ORDER BY exercise');
    return found;
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.exercise), ['back squat', 'bench press', 'romanian deadlift']);
});

test('atlas_app is REFUSED every mutation of the catalog, proven as the real role', async () => {
  await seedCatalog();
  await withRole('atlas_app', async (client) => {
    // The grant is the control. Under ruling D1 the runtime performed the
    // generation swap and therefore held INSERT and DELETE here; the S4 catalog
    // migration revoked both. If any of these three succeeds, the runtime can
    // rewrite the catalog from inside a request path.
    const denied = { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE };
    await expectRejected(
      client,
      `INSERT INTO atlas.exercise_catalog (exercise, display_exercise) VALUES ('smuggled', 'Smuggled')`,
      [], denied
    );
    await expectRejected(
      client,
      `UPDATE atlas.exercise_catalog SET lift_code = 'HACK' WHERE exercise = 'back squat'`,
      [], denied
    );
    await expectRejected(
      client,
      `DELETE FROM atlas.exercise_catalog WHERE exercise = 'back squat'`,
      [], denied
    );
  });
  assert.deepEqual(await catalogKeys(), ['back squat', 'bench press', 'romanian deadlift']);
});

// ── 3. Owner maintenance works, and is atomic ─────────────────────────────────

test('owner maintenance upserts and deletes as atlas_migrate, in one transaction', async () => {
  await seedCatalog();

  const result = await adapter.applyCatalogMaintenance(
    {
      upserts: [
        catalogRowFromInput({ exercise: 'Bench Press', muscle_group: 'Chest', lift_code: 'BEN02' }),
        catalogRowFromInput({ exercise: 'Front Squat', muscle_group: 'Legs', lift_code: 'FSQ01' }),
      ],
      deletes: ['romanian deadlift'],
    },
    'migrate'
  );

  assert.equal(result.upserted, 2);
  assert.equal(result.deleted, 1);
  assert.deepEqual(await catalogKeys(), ['back squat', 'bench press', 'front squat']);

  const changed = await withOwner(async (client) => {
    const { rows } = await client.query(`SELECT lift_code FROM atlas.exercise_catalog WHERE exercise = 'bench press'`);
    return rows[0].lift_code;
  });
  assert.equal(changed, 'BEN02', 'an upsert must update an existing row, not silently do nothing');
});

test('a maintenance run that fails part way changes NOTHING — the Save path never reads a half-applied edit', async () => {
  await seedCatalog();

  await assert.rejects(
    adapter.applyCatalogMaintenance(
      {
        upserts: [
          catalogRowFromInput({ exercise: 'Front Squat', muscle_group: 'Legs', lift_code: 'FSQ01' }),
          // `exercise` is the primary key and NOT NULL. Building this row by hand
          // rather than through catalogRowFromInput is deliberate: the CLI's own
          // validation would refuse it, so this proves the TRANSACTION protects
          // the catalog even when a bad row reaches the adapter.
          { exercise: null, display_exercise: null, muscle_group: null, lift_code: null, canonical_exercise: null },
        ],
        deletes: [],
      },
      'migrate'
    )
  );

  assert.deepEqual(
    await catalogKeys(),
    ['back squat', 'bench press', 'romanian deadlift'],
    'the successful first upsert must roll back with the failed second one'
  );
});

// ── 4. The shape consumers already parse ──────────────────────────────────────

test('the catalog reads back in the header-plus-rows shape existing consumers parse', async () => {
  await seedCatalog();
  const rows = await readExerciseCatalogRows({ adapter });

  const { exerciseCatalogColumns } = require('../config/columns');
  assert.deepEqual(rows[0], [...exerciseCatalogColumns], 'the first row must be the owner-approved header');
  assert.equal(rows.length, 4, 'one header plus three catalog rows');

  // buildExerciseCatalogMap is the live consumer and indexes by the header. If
  // this parses, the authority moved underneath it without a parse site changing.
  const { buildExerciseCatalogMap } = require('../services/exerciseEnrichment');
  const map = buildExerciseCatalogMap(rows);
  assert.ok(map.size >= 3, 'the live consumer must be able to index the Supabase-sourced catalog');
});

test('an EMPTY catalog reads as empty rather than as a lone header', async () => {
  const rows = await readExerciseCatalogRows({ adapter });
  assert.deepEqual(rows, [], 'a caller seeing [] is seeing the authority, not a projection artefact');
});

// ── 5. The point of the whole correction ──────────────────────────────────────

test('reading the catalog opens no Google Sheets client, so a Sheets quota error cannot reach it', async () => {
  await seedCatalog();

  // A sheets module whose every export throws the quota error that caused this
  // migration. If the catalog read touches Sheets at all, this test fails.
  const sheetsPath = require.resolve('../sheets');
  const original = require.cache[sheetsPath];
  const quota = () => {
    const error = new Error('Quota exceeded for quota metric ... RESOURCE_EXHAUSTED');
    error.status = 429;
    throw error;
  };
  require.cache[sheetsPath] = {
    id: sheetsPath,
    filename: sheetsPath,
    loaded: true,
    exports: new Proxy({}, { get: () => quota }),
  };

  try {
    const rows = await readExerciseCatalogRows({ adapter });
    assert.equal(rows.length, 4, 'the catalog must be fully readable while every Sheets call throws 429');
  } finally {
    if (original) require.cache[sheetsPath] = original;
    else delete require.cache[sheetsPath];
  }
});
