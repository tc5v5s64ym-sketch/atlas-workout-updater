#!/usr/bin/env node
'use strict';

// `npm run test:pg` — the from-empty Postgres proof suite (§6.1 P2).
//
// P2 requires a REAL disposable Postgres database, created from empty and
// destroyed for the exact run, with every file in supabase/migrations/ applied
// from scratch. A fake, an in-memory stub, or a mocked client does not satisfy it,
// and neither does a database that carried state in from an earlier commit.
//
// THIS RUNNER FAILS LOUDLY WHEN NO DATABASE IS AVAILABLE. It never skips. A
// skipped proof reported as a pass is exactly the false green the S2 gates exist
// to prevent, so the absence of a database is an error, not a silent omission.
//
// Give it an ADMIN connection string in ATLAS_PG_ADMIN_URL (a server it may
// create and drop databases on). It creates a uniquely named database, applies
// the migrations, creates the four scoped roles with per-run random passwords —
// no credential is ever written to the repository — runs test-pg/, and drops the
// database.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { applyMigrations } = require('./apply-supabase-migrations');
const { grantLoginToScopedRoles, ROLE_NAMES } = require('./pg-proof-bootstrap');

const ROOT = path.join(__dirname, '..');

function adminUrl() {
  const url = (process.env.ATLAS_PG_ADMIN_URL || '').trim();
  if (url) return url;
  throw new Error(
    'ATLAS_PG_ADMIN_URL is not set. The S2 proof suite needs an administrative ' +
      'connection to a disposable Postgres server it may create and drop a database on. ' +
      'It does NOT run against Atlas Production and cannot be pointed at it. ' +
      'In CI this is the job\'s Postgres service container.'
  );
}

// A name unique to this run, so two runs on one server cannot share state and a
// leftover database from a crashed run is never reused.
function databaseName() {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const salt = Math.random().toString(36).slice(2, 8);
  return `atlas_s2_proof_${stamp}_${salt}`;
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function adminQuery(url, sql) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function main() {
  const admin = adminUrl();
  const name = databaseName();
  const target = withDatabase(admin, name);

  console.log(`[pg-proof] creating disposable database ${name}`);
  await adminQuery(admin, `CREATE DATABASE ${name}`);

  // ── APPLY AT PRODUCTION'S PRIVILEGE LEVEL, NOT AT THE ADMIN'S ────────────────
  //
  // The migrations used to be applied over the ADMIN connection, which on a local
  // container is a SUPERUSER. `Atlas Production` has no superuser: Supabase's
  // `postgres` is a CREATEROLE role. A superuser bypasses the membership check
  // that `ALTER ... OWNER TO` performs, so file 8's ownership transfer passed here
  // for the whole of S2 and would have FAILED at the owner gate with
  // `must be able to SET ROLE "atlas_migrate"`.
  //
  // A proof environment more privileged than production proves the wrong system.
  // So the applier is now a NOSUPERUSER CREATEROLE principal that mirrors
  // Supabase's `postgres`, and every one of the suite's proofs therefore runs
  // against a schema applied exactly the way production applies it.
  //
  // The four scoped roles are dropped first, because they are CLUSTER-wide and a
  // previous run leaves them behind. On a virgin project the applier CREATES them
  // and so receives ADMIN OPTION; if they survived from an earlier run they were
  // created by someone else, the applier would hold no admin option, and the run
  // would prove a privilege relationship production will not have.
  const applierPassword = require('crypto').randomBytes(18).toString('hex');

  // A previous run that crashed leaves its disposable database behind, and the
  // scoped roles then hold grants inside it, so DROP ROLE fails. CI never sees
  // this — its container is virgin — which is exactly why it must not be left to
  // CI to notice. These names belong to this suite alone (atlas_s2_proof_<stamp>_<salt>).
  const leftovers = await adminQuery(
    admin,
    `SELECT datname FROM pg_database WHERE datname LIKE 'atlas\\_s2\\_proof\\_%' AND datname <> '${name}'`
  );
  for (const row of leftovers.rows) {
    console.log(`[pg-proof] dropping leftover database ${row.datname}`);
    await adminQuery(admin, `DROP DATABASE IF EXISTS ${row.datname}`);
  }

  for (const role of ROLE_NAMES) {
    try {
      await adminQuery(admin, `DROP ROLE IF EXISTS ${role}`);
    } catch (err) {
      // Never fall back to applying as the admin — that would silently restore
      // superuser and with it the blind spot. Fail with the actual remedy.
      throw new Error(
        `Could not drop the cluster-wide role "${role}" (${err.message}). Something on this ` +
        'server still depends on it — usually a database left behind by other work on a ' +
        'shared local cluster. The proof needs the applier to CREATE these roles so it ' +
        'receives ADMIN OPTION, exactly as it will on a virgin project; a role created by ' +
        'someone else would prove a privilege relationship production will not have. ' +
        'Drop the dependent database(s) and re-run. CI is unaffected: its container is virgin.'
      );
    }
  }
  await adminQuery(admin, `DROP ROLE IF EXISTS atlas_proof_applier`);
  await adminQuery(
    admin,
    `CREATE ROLE atlas_proof_applier LOGIN PASSWORD '${applierPassword}' NOSUPERUSER CREATEROLE`
  );
  await adminQuery(admin, `ALTER DATABASE ${name} OWNER TO atlas_proof_applier`);
  const applierUrl = (() => {
    const parsed = new URL(target);
    parsed.username = 'atlas_proof_applier';
    parsed.password = applierPassword;
    return parsed.toString();
  })();

  let failed = null;
  try {
    // Fail loudly rather than silently falling back to the admin: a run that
    // quietly re-acquired superuser would restore the exact blind spot this
    // change exists to remove.
    const whoami = new Client({ connectionString: applierUrl });
    await whoami.connect();
    try {
      const { rows } = await whoami.query(
        'SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user'
      );
      if (rows[0].rolsuper !== false) {
        throw new Error('the proof applier must NOT be a superuser — production has none');
      }
      console.log(`[pg-proof] applying as ${rows[0].role} (NOSUPERUSER, mirrors Supabase's postgres)`);
    } finally {
      await whoami.end();
    }

    const applied = await applyMigrations(applierUrl);
    console.log(`[pg-proof] applied ${applied.length} migration file(s) from empty`);

    // The scoped roles are created NOLOGIN by the migration (no credential in the
    // repository). The proof must execute AS them, so this run grants LOGIN with a
    // password generated here and never persisted.
    const credentials = await grantLoginToScopedRoles(target);
    console.log(`[pg-proof] granted a per-run login to ${ROLE_NAMES.join(', ')}`);

    const env = { ...process.env, ATLAS_PG_PROOF_URL: target };
    for (const [role, url] of Object.entries(credentials)) {
      env[`ATLAS_PG_PROOF_URL_${role.toUpperCase()}`] = url;
    }
    // The adapter reads the runtime role from its ordinary environment variable,
    // so the suite exercises the SAME configuration path production uses.
    env.ATLAS_SUPABASE_APP_URL = credentials.atlas_app;
    env.ATLAS_SUPABASE_READONLY_URL = credentials.atlas_readonly;
    env.ATLAS_SUPABASE_MIGRATE_URL = credentials.atlas_migrate;
    env.ATLAS_SUPABASE_REBUILD_URL = credentials.atlas_rebuild;
    env.ATLAS_SUPABASE_SHADOW_WRITE = '1';

    // Enumerated explicitly rather than handed a directory: `node --test <dir>`
    // resolves the argument as a module path, and a glob would depend on a shell.
    // A run that silently found zero files would be the false green this suite exists
    // to prevent, so an empty list is an error.
    //
    // The .pgproof.js suffix is deliberate. `npm test` runs a bare `node --test`,
    // whose default glob matches **/*.test.js ANYWHERE in the tree — so named
    // that way these files would run, and fail, on every machine without a
    // database. They live outside test/ for the same reason: Node treats every
    // file under a directory named `test` as a test file.
    const files = fs
      .readdirSync(path.join(ROOT, 'test-pg'))
      .filter((name) => name.endsWith('.pgproof.js'))
      .sort()
      .map((name) => path.join('test-pg', name));
    if (files.length === 0) throw new Error('No test files found in test-pg/.');
    console.log(`[pg-proof] running ${files.length} proof file(s)`);

    // ONE file at a time. `node --test` runs each file in its own process
    // CONCURRENTLY by default, and every file here truncates the schema in its
    // beforeEach — so parallel files delete each other's rows mid-statement and
    // the suite fails in a different place on every run. Serialising is not a
    // performance choice; a shared database is shared state.
    execFileSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
  } catch (err) {
    failed = err;
  } finally {
    // Destroyed with the run, whatever happened.
    try {
      await adminQuery(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      console.log(`[pg-proof] dropped ${name}`);
    } catch (err) {
      console.error(`[pg-proof] could not drop ${name}: ${err.message}`);
    }
  }

  if (failed) {
    console.error(`[pg-proof] FAILED: ${failed.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[pg-proof] FAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
