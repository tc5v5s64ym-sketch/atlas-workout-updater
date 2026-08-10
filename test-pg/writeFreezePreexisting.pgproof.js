'use strict';

// §6.2 P8a — A PRE-EXISTING atlas.write_freeze IS DRIFT, AND S3 REFUSES IT.
//
// *Architectural ruling after review round 6 (2026-08-10).*
//
// This file used to prove that S3 could ADOPT a pre-existing control: take its
// ownership, rebuild its access list, and re-verify its shape against every
// hostile variant a reviewer could think of. Each round found another variant.
// The ruling replaced that whole direction — S3 now creates the table strictly,
// and a pre-existing object of any kind makes the migration refuse and change
// nothing.
//
// So this file is now small, and it proves the choice rather than the repair:
//
//   1. ABSENT  → S3 creates the exact declared control;
//   2. PRESENT → S3 refuses and rolls the entire transaction back, whatever the
//                pre-existing object's shape, owner or contents;
//   3. MUTATION → restoring `IF NOT EXISTS` lets the pre-existing case proceed,
//                 which is what this file bites on.
//
// The security boundary itself — who owns the control, who may write it, whether
// atlas_migrate can replace it, whether legitimate migration DDL still works, and
// whether the owner can freeze and lift — is proven against the real from-empty
// database in test-pg/writeFreeze.pgproof.js, as the real roles. It is not
// duplicated here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const S2_FILES = [
  '20260808000100_atlas_schema.sql',
  '20260808000200_workout_core.sql',
  '20260808000300_session_plans.sql',
  '20260808000400_write_receipts.sql',
  '20260808000500_exercise_catalog_mirror.sql',
  '20260808000600_migration_divergences.sql',
  '20260808000700_sheets_mirror.sql',
  '20260808000800_roles_and_grants.sql',
];
const S3_FILE = '20260809000100_write_freeze.sql';

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Run this through \`npm run test:pg\`, which creates the disposable ` +
        'server, the applier and the four scoped roles. A skipped proof is a false green.'
    );
  }
  return value;
}

// Roles and their passwords are cluster-wide, so pointing the same credential at
// another database on the same server is the same principal — which is what makes
// this proof faithful rather than a simulation.
function onDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withConnection(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function adminQuery(sql) {
  return withConnection(requireEnv('ATLAS_PG_ADMIN_URL'), (client) => client.query(sql));
}

// One transaction per file, exactly as scripts/apply-supabase-migrations.js does —
// which is what makes a failed statement roll the whole file back.
async function applyFile(client, sql, label) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    err.message = `${label}: ${err.message}`;
    throw err;
  }
}

const readMigration = (file) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

// THE MUTATIONS, in two steps, because the migration turns out to have two
// independent defences against drift and each deserves its own bite.
//
//   `ifNotExists`        — restore the permissive create. The strict CREATE no
//                          longer refuses, and the refusal falls through to the
//                          surviving postcondition.
//   `fullyPermissive`    — also delete that postcondition, restoring the whole
//                          pre-ruling posture. Now nothing refuses, and the
//                          drifted object is adopted.
const POSTCONDITION_BLOCK = /\nDO \$\$\nDECLARE\n  offending text;[\s\S]*?\nEND\n\$\$;\n/;

// The postcondition exactly as `39701b92` shipped it — eight hand-listed calls,
// checking only UPDATE for atlas_readonly and atlas_rebuild. Kept verbatim so
// "weakening it back lets the case through" is shown by RUNNING the old block.
const LEGACY_POSTCONDITION = `
DO $$
BEGIN
  IF has_table_privilege('atlas_app',      'atlas.write_freeze', 'INSERT')
  OR has_table_privilege('atlas_app',      'atlas.write_freeze', 'UPDATE')
  OR has_table_privilege('atlas_app',      'atlas.write_freeze', 'DELETE')
  OR has_table_privilege('atlas_migrate',  'atlas.write_freeze', 'INSERT')
  OR has_table_privilege('atlas_migrate',  'atlas.write_freeze', 'UPDATE')
  OR has_table_privilege('atlas_migrate',  'atlas.write_freeze', 'DELETE')
  OR has_table_privilege('atlas_readonly', 'atlas.write_freeze', 'UPDATE')
  OR has_table_privilege('atlas_rebuild',  'atlas.write_freeze', 'UPDATE') THEN
    RAISE EXCEPTION 'a scoped role can write atlas.write_freeze — the freeze would have two authorities';
  END IF;
END
$$;
`;

function mutateS3(mode) {
  let sql = readMigration(S3_FILE);
  if (mode === 'none') return sql;

  // A replacer FUNCTION: `$$` in a replacement string is an escape for `$`, and
  // passing SQL as a string would corrupt the dollar quoting.
  if (mode === 'legacyPostcondition') {
    const swapped = sql.replace(POSTCONDITION_BLOCK, () => `\n${LEGACY_POSTCONDITION}`);
    assert.notEqual(swapped, sql, 'the postcondition must be found in order to be replaced');
    assert.match(swapped, /DO \$\$/, 'the legacy block must survive the substitution intact');
    return swapped;
  }

  const permissive = sql.replace(/^CREATE TABLE atlas\.write_freeze \($/m,
    'CREATE TABLE IF NOT EXISTS atlas.write_freeze (');
  assert.notEqual(permissive, sql, 'the strict CREATE must exist in order to be mutated away');
  sql = permissive;

  if (mode === 'fullyPermissive') {
    // A replacer FUNCTION: `$$` in a replacement string is an escape for `$`, and
    // passing SQL as a string would corrupt the dollar quoting of anything around it.
    const withoutPostcondition = sql.replace(POSTCONDITION_BLOCK, () => '\n');
    assert.notEqual(withoutPostcondition, sql, 'the postcondition must exist in order to be mutated away');
    sql = withoutPostcondition;
  }
  return sql;
}

let created = [];

// A database in the legitimate post-S2 state, optionally carrying a pre-existing
// atlas.write_freeze, with S3 then applied (or attempted).
async function buildDatabase({ preCreate = null, preSql = [], mutation = 'none' } = {}) {
  const name = `atlas_s3_drift_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const applier = requireEnv('ATLAS_PG_PROOF_URL_APPLIER');
  const applierRole = new URL(applier).username;

  await adminQuery(`CREATE DATABASE "${name}" OWNER "${applierRole}"`);
  created.push(name);

  const urls = {
    applier: onDatabase(applier, name),
    atlas_migrate: onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_MIGRATE'), name),
    atlas_app: onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_APP'), name),
  };

  // The legitimate post-S2 state.
  await withConnection(urls.applier, async (client) => {
    for (const file of S2_FILES) await applyFile(client, readMigration(file), file);
  });

  // The drift, planted by atlas_migrate using only the authority S2 legitimately
  // gave it: after S2 it owns schema `atlas` and holds CREATE.
  if (preCreate) {
    await withConnection(urls.atlas_migrate, (client) => client.query(preCreate));
  }

  // ENVIRONMENT drift, as the applier — deployment-local settings that outlive any
  // one migration. `ALTER DEFAULT PRIVILEGES` is the case the retained postcondition
  // exists for: it attaches grants to tables this principal has not created yet.
  for (const statement of preSql) {
    await withConnection(urls.applier, (client) => client.query(statement.replace(/\$APPLIER/g, applierRole)));
  }

  let s3Error = null;
  await withConnection(urls.applier, async (client) => {
    try {
      await applyFile(client, mutateS3(mutation), S3_FILE);
    } catch (err) {
      s3Error = err;
    }
  });

  return { name, urls, applierRole, s3Error };
}

test.after(async () => {
  for (const name of created) {
    try {
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (err) {
      console.error(`[s3-drift] could not drop ${name}: ${err.message}`);
    }
  }
  created = [];
});

/* ══════════ 1. ABSENT — the one legitimate starting state ══════════ */

test('P8a: with the table ABSENT, S3 creates the exact declared control', async () => {
  const { urls, applierRole, s3Error } = await buildDatabase();
  assert.equal(s3Error, null, `S3 must apply cleanly from the legitimate state: ${s3Error && s3Error.message}`);

  await withConnection(urls.applier, async (client) => {
    // Owned by the principal that created it, by construction rather than by takeover.
    const owner = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    assert.equal(owner.rows[0].tableowner, applierRole);

    // The declared control, seeded dormant.
    const row = await client.query('SELECT id, frozen, set_by FROM atlas.write_freeze');
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].id, true);
    assert.equal(row.rows[0].frozen, false);
    assert.equal(row.rows[0].set_by, 'migration:S3');

    // The D7 schema narrowing took effect in the same file.
    const schema = await client.query(
      `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'atlas'`
    );
    assert.equal(schema.rows[0].owner, applierRole);
  });

  // And the runtime can read it, but not write it. The full role matrix is proven
  // in writeFreeze.pgproof.js; this is the smoke test that the created object
  // carries the intended posture.
  await withConnection(urls.atlas_app, async (client) => {
    const read = await client.query('SELECT frozen FROM atlas.write_freeze');
    assert.equal(read.rowCount, 1);
    await assert.rejects(
      () => client.query('UPDATE atlas.write_freeze SET frozen = false WHERE id'),
      (err) => err.code === '42501'
    );
  });
});

/* ══════════ 2. PRESENT — drift, refused, whatever it looks like ══════════ */

// Shape, owner and contents are all irrelevant now, and that is the point of the
// ruling: S3 does not inspect a pre-existing object, so there is no hostile variant
// to enumerate. These four only demonstrate that the refusal does not depend on
// what was planted — including the round-6 conditional CHECK that the previous
// design's behavioural probe would have accepted.
const DRIFT_VARIANTS = [
  ['the exact declared shape', `
    CREATE TABLE atlas.write_freeze (
      id boolean PRIMARY KEY DEFAULT true CHECK (id), frozen boolean NOT NULL,
      reason text NOT NULL, set_by text NOT NULL, set_at timestamptz NOT NULL DEFAULT now())`],
  ['a weaker conditional CHECK (the round-6 false green)', `
    CREATE TABLE atlas.write_freeze (
      id boolean PRIMARY KEY DEFAULT true CHECK (id OR set_by <> 'migration:S3'),
      frozen boolean NOT NULL, reason text NOT NULL, set_by text NOT NULL,
      set_at timestamptz NOT NULL DEFAULT now())`],
  ['a primary key on the wrong column', `
    CREATE TABLE atlas.write_freeze (
      id boolean NOT NULL UNIQUE DEFAULT true, frozen boolean NOT NULL,
      reason text NOT NULL, set_by text NOT NULL PRIMARY KEY,
      set_at timestamptz NOT NULL DEFAULT now())`],
  ['nothing like the control at all', 'CREATE TABLE atlas.write_freeze (whatever text)'],
];

for (const [label, preCreate] of DRIFT_VARIANTS) {
  test(`P8a: a pre-existing control REFUSES S3 — ${label}`, async () => {
    const { urls, s3Error } = await buildDatabase({ preCreate });

    assert.ok(s3Error, 'S3 must refuse a pre-existing atlas.write_freeze');
    assert.equal(s3Error.code, '42P07', `expected a duplicate-object refusal, got ${s3Error.code}`);

    // NOTHING CHANGED. The refusal is not partial: the file is one transaction, so
    // the schema narrowing and the grants rolled back with the create.
    await withConnection(urls.applier, async (client) => {
      const owner = await client.query(
        `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
      );
      assert.equal(owner.rows[0].tableowner, 'atlas_migrate',
        'S3 must not adopt the drifted object — no ownership takeover exists any more');

      const schema = await client.query(
        `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'atlas'`
      );
      assert.equal(schema.rows[0].owner, 'atlas_migrate', 'and the schema narrowing rolled back too');

      const granted = await client.query(
        `SELECT has_table_privilege('atlas_app', 'atlas.write_freeze', 'SELECT') AS can_read`
      );
      assert.equal(granted.rows[0].can_read, false, 'and no grant was issued on the drifted object');
    });
  });
}

/* ══════════ 2b. ENVIRONMENT DRIFT — an unexpected default write grant ══════════ */
//
// *Required review of `39701b92`.* The retained postcondition exists for exactly
// this: `ALTER DEFAULT PRIVILEGES` is deployment-local, outlives any one migration,
// and attaches grants to a table this file has not created yet. The from-empty
// proof cannot discharge it, because that fixture controls its own defaults.
//
// The old block hand-listed its checks and covered only UPDATE for atlas_readonly
// and atlas_rebuild, so a default INSERT or DELETE to either survived it.
//
// HONEST SCOPE: neither missing privilege is a route to OPENING writes. UPDATE —
// the lift path — was already covered for all four roles; INSERT cannot add a row
// past the primary key and `CHECK (id)`; DELETE and TRUNCATE remove the control,
// and a control that cannot be read is FROZEN (§5.3). The exposure is a claim that
// exceeded its proof, plus an availability one: a role able to delete the control
// can wedge writes closed until the owner notices.
const DEFAULT_GRANT_CASES = [
  ['INSERT to atlas_readonly', 'atlas_readonly', 'INSERT'],
  ['DELETE to atlas_rebuild', 'atlas_rebuild', 'DELETE'],
  ['TRUNCATE to atlas_readonly', 'atlas_readonly', 'TRUNCATE'],
];

for (const [label, role, privilege] of DEFAULT_GRANT_CASES) {
  test(`P8a: S3 REFUSES an unexpected default ${label}`, async () => {
    const { urls, s3Error } = await buildDatabase({
      preSql: [
        `ALTER DEFAULT PRIVILEGES FOR ROLE "$APPLIER" IN SCHEMA atlas GRANT ${privilege} ON TABLES TO ${role}`,
      ],
    });

    assert.ok(s3Error, `an unexpected default ${privilege} for ${role} must refuse S3`);
    assert.match(s3Error.message, /a scoped role can write atlas\.write_freeze/);
    assert.match(s3Error.message, new RegExp(`${role}:${privilege}`),
      'and the refusal must NAME the offending role and privilege');

    // The whole file rolled back: the control does not exist, so nothing was left
    // behind carrying the unexpected grant.
    await withConnection(urls.applier, async (client) => {
      const exists = await client.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
      );
      assert.equal(exists.rows[0].n, 0, 'a refused S3 leaves no control behind');
    });
  });
}

test('P8a MUTATION: the 39701b92 postcondition lets a default DELETE to atlas_rebuild through', async () => {
  // The bite for this finding. With the hand-listed block restored, atlas_rebuild's
  // unexpected DELETE is not checked at all, S3 completes, and the role really can
  // remove the control.
  const { urls, s3Error } = await buildDatabase({
    preSql: ['ALTER DEFAULT PRIVILEGES FOR ROLE "$APPLIER" IN SCHEMA atlas GRANT DELETE ON TABLES TO atlas_rebuild'],
    mutation: 'legacyPostcondition',
  });

  assert.equal(s3Error, null,
    `the hand-listed postcondition accepts it — which is the defect: ${s3Error && s3Error.message}`);

  // And the consequence, demonstrated as the real role rather than asserted.
  const rebuild = onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_REBUILD'), urls.applier.split('/').pop());
  await withConnection(rebuild, async (client) => {
    const deleted = await client.query('DELETE FROM atlas.write_freeze WHERE id');
    assert.equal(deleted.rowCount, 1,
      'atlas_rebuild removed the control — writes are now wedged closed until the owner notices');
  });

  await withConnection(urls.applier, async (client) => {
    const rows = await client.query('SELECT count(*)::int AS n FROM atlas.write_freeze');
    assert.equal(rows.rows[0].n, 0, 'the control is gone; every runtime read now refuses');
  });
});

/* ══════════ 3. THE MUTATION BITE ══════════ */

test('P8a MUTATION: with IF NOT EXISTS restored, the SURVIVING postcondition still refuses', async () => {
  // Measured, not predicted: this was expected to let the drift through, and it
  // does not. `has_table_privilege` reports an OWNER's implicit privileges, so a
  // drifted table still owned by atlas_migrate trips the one postcondition the
  // ruling kept — which turns out to be load-bearing for ownership as well as for
  // ALTER DEFAULT PRIVILEGES.
  //
  // The two defences are independent and the refusal moves between them: the
  // strict CREATE refuses EARLY, on identity, before anything is inspected; the
  // postcondition refuses LATE, on effective privilege.
  const { urls, s3Error } = await buildDatabase({
    preCreate: DRIFT_VARIANTS[1][1],       // the conditional-CHECK variant
    mutation: 'ifNotExists',
  });

  assert.ok(s3Error, 'the postcondition must still refuse a drifted, foreign-owned control');
  assert.match(s3Error.message, /a scoped role can write atlas\.write_freeze/);
  assert.notEqual(s3Error.code, '42P07',
    'and it must be the LATE refusal — the strict CREATE is what produces the early one');

  await withConnection(urls.applier, async (client) => {
    const owner = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    assert.equal(owner.rows[0].tableowner, 'atlas_migrate', 'and it rolled back, adopting nothing');
  });
});

test('P8a MUTATION: with BOTH defences removed, the pre-existing object is adopted', async () => {
  // The full pre-ruling posture restored. Nothing refuses now, S3 completes over
  // the drifted table, and the control the runtime reads is an object this
  // migration never created and never inspected — which is what the refusals above
  // exist to prevent, and what this file fails on if the ruling is reverted.
  const { urls, s3Error } = await buildDatabase({
    preCreate: DRIFT_VARIANTS[1][1],
    mutation: 'fullyPermissive',
  });

  assert.equal(s3Error, null,
    `the permissive migration proceeds over drift — which is the defect: ${s3Error && s3Error.message}`);

  await withConnection(urls.applier, async (client) => {
    const owner = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    assert.equal(owner.rows[0].tableowner, 'atlas_migrate',
      'IF NOT EXISTS preserved the drifted object and its owner — the defect, reproduced');

    // And the weaker CHECK it carries really does permit a second control row,
    // which the previous design's single behavioural probe would have missed.
    await client.query(
      `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by)
       VALUES (false, false, 'a second control', 'someone-else')`
    );
    const rows = await client.query('SELECT count(*)::int AS n FROM atlas.write_freeze');
    assert.equal(rows.rows[0].n, 2, 'two control rows — every runtime read is now ambiguous');
  });
});
