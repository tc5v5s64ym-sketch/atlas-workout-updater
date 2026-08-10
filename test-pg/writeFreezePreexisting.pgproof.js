'use strict';

// §6.2 P8a — THE PRE-EXISTING-TABLE ADVERSARIAL PROOF.
//
// *Required Atlas Contract / Systems Review of `bba3fbf`.*
//
// Every other write-freeze proof starts from EMPTY, where the applier necessarily
// created atlas.write_freeze and necessarily owns it. That is the one starting
// state in which the D7 ownership invariant is free — and it is therefore the one
// starting state that cannot prove it.
//
// This file starts from the DANGEROUS state instead, and every step of it is
// legitimate: after `S2`, atlas_migrate owns schema `atlas` and holds CREATE, so it
// can create `atlas.write_freeze` itself before `S3` ever runs. `CREATE TABLE IF
// NOT EXISTS` then does nothing, the existing owner survives, and atlas_migrate
// keeps implicit DML and DDL that no REVOKE can take away — a second authority able
// to lift a freeze, alive and silent.
//
// So the proof builds that exact database:
//
//   1. a fresh disposable database, owned by the production-equivalent applier;
//   2. the eight `S2` files applied to it;
//   3. atlas.write_freeze created BY atlas_migrate, with the right shape and a
//      hostile UPDATE grant to atlas_app — the most dangerous version, not the
//      most obvious one;
//   4. the `S3` file applied over the top;
//   5. assertions that no competing authority survived.
//
// It then MUTATES the migration twice, to prove the new statements are what does
// the work rather than decoration.

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

const SQLSTATE_INSUFFICIENT_PRIVILEGE = '42501';

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

// The scoped-role and applier credentials already exist for this run; only the
// DATABASE differs. Roles and their passwords are cluster-wide, so pointing the
// same credential at another database on the same server is exactly the same
// principal — which is what makes this proof faithful rather than a simulation.
function onDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function connectTo(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function withConnection(url, fn) {
  const client = await connectTo(url);
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
// which is what makes the S3 verification block's RAISE roll the whole file back.
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

function readMigration(file) {
  return fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
}

// ── The mutations ────────────────────────────────────────────────────────────
//
// `establish` strips the three statements that TAKE the invariant — the ownership
// transfer and the two access-list revokes — and keeps the verification block, so
// the migration should REFUSE.
//
// `everything` strips the verification block as well, restoring exactly the
// vulnerable code the review found, so the migration should SUCCEED and leave the
// competing authority alive. That is the bite: it is what the passing test above
// would fail on if the fix were reverted.
//
// The revokes go with the ownership transfer deliberately. They depend on it — a
// non-owner that revokes the owner's own access-list entry strips the privileges
// it was borrowing through membership, and the seed two statements later dies with
// "permission denied". Leaving them in would make the mutated migration fail for
// plumbing reasons and prove nothing about the verification.
const MUTABLE_STATEMENTS = [
  /^ALTER TABLE atlas\.write_freeze OWNER TO CURRENT_USER;$/m,
  /^REVOKE ALL ON atlas\.write_freeze FROM PUBLIC;$/m,
  /^REVOKE ALL ON atlas\.write_freeze FROM atlas_app, atlas_migrate, atlas_readonly, atlas_rebuild;$/m,
];

function mutateS3(mode) {
  let sql = readMigration(S3_FILE);
  if (mode === 'none') return sql;

  for (const statement of MUTABLE_STATEMENTS) {
    const before = sql;
    sql = sql.replace(statement, '-- [mutated away]');
    assert.notEqual(sql, before, `the statement ${statement} must exist to be mutated away`);
  }

  if (mode === 'everything') {
    const withoutVerify = sql.replace(/\nDO \$\$\nDECLARE\n  expected_owner[\s\S]*?\nEND\n\$\$;\n/, '\n');
    assert.notEqual(withoutVerify, sql, 'the verification block must exist to be mutated away');
    sql = withoutVerify;
  }
  return sql;
}

let created = [];

// A database in the dangerous pre-`S3` state, with `S3` then applied (or attempted).
async function buildHostileDatabase(mutation) {
  const name = `atlas_s3_hostile_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const applier = requireEnv('ATLAS_PG_PROOF_URL_APPLIER');
  const applierRole = new URL(applier).username;

  await adminQuery(`CREATE DATABASE "${name}" OWNER "${applierRole}"`);
  created.push(name);

  const urls = {
    applier: onDatabase(applier, name),
    atlas_migrate: onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_MIGRATE'), name),
    atlas_app: onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_APP'), name),
    atlas_readonly: onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_READONLY'), name),
    atlas_rebuild: onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_REBUILD'), name),
  };

  // 1–2. The legitimate post-S2 state.
  await withConnection(urls.applier, async (client) => {
    for (const file of S2_FILES) await applyFile(client, readMigration(file), file);
  });

  // 3. THE HOSTILE PRE-CREATE, performed by atlas_migrate using only the authority
  //    S2 legitimately gave it: it owns the schema and holds CREATE.
  //
  //    Deliberately the RIGHT shape. A malformed decoy would be caught by the
  //    shape check and prove nothing about ownership; this one satisfies every
  //    structural assertion and differs only in who owns it — which is the whole
  //    finding. The UPDATE grant to atlas_app is the second half: a runtime role
  //    able to lift a freeze is worse than the ownership defect itself.
  await withConnection(urls.atlas_migrate, async (client) => {
    await client.query(`
      CREATE TABLE atlas.write_freeze (
        id       boolean     PRIMARY KEY DEFAULT true CHECK (id),
        frozen   boolean     NOT NULL,
        reason   text        NOT NULL,
        set_by   text        NOT NULL,
        set_at   timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query(
      `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by)
       VALUES (true, false, 'planted before S3', 'atlas_migrate')`
    );
    await client.query('GRANT SELECT, UPDATE ON atlas.write_freeze TO atlas_app');
  });

  // The premise is real, and asserted rather than assumed.
  const plantedOwner = await withConnection(urls.applier, (client) => client.query(
    `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
  ));
  assert.equal(plantedOwner.rows[0].tableowner, 'atlas_migrate',
    'the hostile pre-create must genuinely have left atlas_migrate as owner');

  // 4. S3 over the top.
  let s3Error = null;
  await withConnection(urls.applier, async (client) => {
    try {
      await applyFile(client, mutateS3(mutation), S3_FILE);
    } catch (err) {
      s3Error = err;
    }
  });

  return { name, urls, s3Error };
}

test.after(async () => {
  for (const name of created) {
    try {
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (err) {
      console.error(`[s3-hostile] could not drop ${name}: ${err.message}`);
    }
  }
  created = [];
});

async function expectRefused(url, sql, what) {
  return withConnection(url, async (client) => {
    let error = null;
    try {
      await client.query(sql);
    } catch (err) {
      error = err;
    }
    assert.ok(error, `expected "${what}" to be REFUSED, but it succeeded`);
    assert.equal(error.code, SQLSTATE_INSUFFICIENT_PRIVILEGE,
      `"${what}" failed with ${error.code} (${error.message}), expected insufficient privilege`);
  });
}

/* ══════════ THE FIX, AGAINST THE DANGEROUS STARTING STATE ══════════ */

test('P8a: S3 applied over a PRE-EXISTING atlas_migrate-owned control takes ownership back', async () => {
  const { urls, s3Error } = await buildHostileDatabase('none');
  assert.equal(s3Error, null, `S3 must apply cleanly over a recoverable pre-existing table: ${s3Error && s3Error.message}`);

  const applierRole = new URL(urls.applier).username;

  // 1. THE PROJECT OWNER IS THE SOLE OWNER.
  await withConnection(urls.applier, async (client) => {
    const owner = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    assert.equal(owner.rows[0].tableowner, applierRole,
      'S3 must TAKE ownership, not inherit whatever it found');

    // And the schema too, so the replacement bypass is closed here as well.
    const schema = await client.query(
      `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'atlas'`
    );
    assert.equal(schema.rows[0].owner, applierRole);
  });

  // 2. atlas_migrate CANNOT DEFEAT THE FREEZE BY ANY ROUTE.
  for (const [what, sql] of [
    ['write the row', 'UPDATE atlas.write_freeze SET frozen = false WHERE id'],
    ['insert a row', `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by) VALUES (true, false, 'x', 'y')`],
    ['delete the row', 'DELETE FROM atlas.write_freeze WHERE id'],
    ['drop the control', 'DROP TABLE atlas.write_freeze'],
    ['drop it with CASCADE', 'DROP TABLE atlas.write_freeze CASCADE'],
    ['alter the control', 'ALTER TABLE atlas.write_freeze DROP CONSTRAINT write_freeze_pkey'],
    ['rename it away', 'ALTER TABLE atlas.write_freeze RENAME TO write_freeze_old'],
    ['move it to another schema', 'ALTER TABLE atlas.write_freeze SET SCHEMA public'],
    ['take ownership back', 'ALTER TABLE atlas.write_freeze OWNER TO atlas_migrate'],
    ['drop the schema', 'DROP SCHEMA atlas CASCADE'],
  ]) {
    await expectRefused(urls.atlas_migrate, sql, `atlas_migrate: ${what}`);
  }

  // 3. atlas_app IS SELECT-ONLY — and the hostile UPDATE grant is gone.
  await withConnection(urls.atlas_app, async (client) => {
    const read = await client.query('SELECT id, frozen FROM atlas.write_freeze');
    assert.equal(read.rowCount, 1, 'the runtime must still be able to read the control');
  });
  await expectRefused(urls.atlas_app, 'UPDATE atlas.write_freeze SET frozen = false WHERE id',
    'atlas_app: write the row (planted grant must not survive)');
  await expectRefused(urls.atlas_readonly, 'UPDATE atlas.write_freeze SET frozen = false WHERE id',
    'atlas_readonly: write the row');
  await expectRefused(urls.atlas_rebuild, 'UPDATE atlas.write_freeze SET frozen = false WHERE id',
    'atlas_rebuild: write the row');

  // 4. LEGITIMATE MIGRATION DDL STILL WORKS on migration-owned objects.
  await withConnection(urls.atlas_migrate, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('CREATE TABLE atlas.hostile_proof_scratch (id int PRIMARY KEY)');
      await client.query('ALTER TABLE atlas.hostile_proof_scratch ADD COLUMN note text');
      await client.query('DROP TABLE atlas.hostile_proof_scratch');
      await client.query('ALTER TABLE atlas.logged_sets ADD COLUMN hostile_proof_column int');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  // 5. The project owner remains able to set and lift the real control.
  await withConnection(urls.applier, async (client) => {
    const froze = await client.query(
      `UPDATE atlas.write_freeze SET frozen = true, reason = 'owner freeze', set_by = 'project-owner' WHERE id`
    );
    assert.equal(froze.rowCount, 1);
  });
  await withConnection(urls.atlas_app, async (client) => {
    const seen = await client.query('SELECT frozen FROM atlas.write_freeze');
    assert.equal(seen.rows[0].frozen, true, 'the runtime observes the owner freeze');
  });
  await withConnection(urls.applier, (client) => client.query(
    `UPDATE atlas.write_freeze SET frozen = false, reason = 'owner lift', set_by = 'project-owner' WHERE id`
  ));

  // And the planted row was preserved, not silently replaced — the migration takes
  // authority without discarding state it did not write.
  await withConnection(urls.applier, async (client) => {
    const rows = await client.query('SELECT count(*)::int AS n FROM atlas.write_freeze');
    assert.equal(rows.rows[0].n, 1, 'exactly one row, throughout');
  });
});

/* ══════════ THE MUTATION BITE ══════════ */

test('P8a MUTATION: without the establishing statements, S3 REFUSES to apply', async () => {
  // The verification block is load-bearing, not decorative: with the establishing
  // statements removed, the migration must abort rather than complete over a
  // control whose owner is a second authority.
  const { urls, s3Error } = await buildHostileDatabase('establish');

  assert.ok(s3Error, 'S3 must REFUSE when it cannot confirm it owns the control');
  assert.match(s3Error.message, /owned by "atlas_migrate"/,
    'and it must refuse for the RIGHT reason — the verification block, naming the wrong owner');
  assert.match(s3Error.message, /must be owned by the applying project owner/);

  // And it rolled back cleanly: the file is one transaction, so nothing half-applied.
  await withConnection(urls.applier, async (client) => {
    const owner = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    assert.equal(owner.rows[0].tableowner, 'atlas_migrate', 'the refused migration changed nothing');
    const schema = await client.query(
      `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'atlas'`
    );
    assert.equal(schema.rows[0].owner, 'atlas_migrate',
      'the schema narrowing rolled back with the rest of the file');
  });
});

test('P8a MUTATION: restoring the vulnerable behaviour reproduces the defect this file exists for', async () => {
  // Both new statements removed — exactly the code the review found. The migration
  // now SUCCEEDS, and leaves atlas_migrate owning the control with implicit DML no
  // REVOKE can remove. This is the bite: were the fix reverted, the test above
  // would fail, and this one records precisely what it would fail on.
  const { urls, s3Error } = await buildHostileDatabase('everything');

  assert.equal(s3Error, null,
    `the vulnerable migration applies without complaint — which is the problem: ${s3Error && s3Error.message}`);

  await withConnection(urls.applier, async (client) => {
    const owner = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    assert.equal(owner.rows[0].tableowner, 'atlas_migrate',
      'CREATE TABLE IF NOT EXISTS preserved the hostile owner — the defect, reproduced');
  });

  // The second half of the defect: the planted UPDATE grant also survives, so the
  // RUNTIME role could lift a freeze too. This is why the access list is rebuilt
  // rather than adjusted.
  await withConnection(urls.atlas_app, async (client) => {
    const granted = await client.query(
      `SELECT has_table_privilege('atlas_app', 'atlas.write_freeze', 'UPDATE') AS can_write`
    );
    assert.equal(granted.rows[0].can_write, true,
      'the planted runtime UPDATE grant survived — a Save path able to lift its own freeze');
  });

  // And the surviving owner really can lift a freeze, which is why it matters.
  await withConnection(urls.applier, (client) => client.query(
    `UPDATE atlas.write_freeze SET frozen = true, reason = 'owner freeze', set_by = 'project-owner' WHERE id`
  ));
  await withConnection(urls.atlas_migrate, async (client) => {
    const lifted = await client.query('UPDATE atlas.write_freeze SET frozen = false WHERE id');
    assert.equal(lifted.rowCount, 1,
      'the competing authority can reopen writes the owner closed — D7 defeated');
  });
});
