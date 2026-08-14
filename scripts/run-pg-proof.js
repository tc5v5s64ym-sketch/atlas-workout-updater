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

async function adminQuery(url, sql, params) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return params ? await client.query(sql, params) : await client.query(sql);
  } finally {
    await client.end();
  }
}

// ── Identifier quoting ────────────────────────────────────────────────────────
//
// *Advisory review of `0a3d051`.* Database names read back from pg_catalog are
// NOT this process's own strings. On a shared server another principal can create
// a database whose name matches the prefix scan below and contains SQL, and it was
// interpolated unchanged into a statement run on the ADMIN connection. Quoting is
// the fix; the doubling of embedded quotes is what makes it total.
function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── ONE RUN AT A TIME, ON ONE SERVER ─────────────────────────────────────────
//
// *Required review of `0a3d051`.* The four scoped roles are CLUSTER-wide, so two
// runs on one server were never actually independent — each would reset the
// other's per-run passwords. The stale-database cleanup made that latent conflict
// destructive: `atlas_s2_proof_%` is also the exact shape of a LIVE run's
// database, so the second runner could drop the first runner's database and then
// drop and recreate the roles underneath it.
//
// A proof runner must not kill another valid proof to clean stale state. So runs
// are serialised on an explicit, bounded advisory lock, and the lock is what makes
// the cleanup provably correct rather than a guess: while it is held, no other run
// can be in progress, so every surviving `atlas_s2_proof_%` database IS orphaned.
//
// Session-scoped, on a dedicated connection held for the whole run — it must
// outlive individual statements, and it is released explicitly in the finally.
const RUNNER_LOCK_KEY = 'atlas-s2-proof-runner';
const APPLIER_ROLE = 'atlas_proof_applier';

async function acquireRunnerLock(adminConnectionString, { timeoutMs = 15 * 60 * 1000, pollMs = 1000 } = {}) {
  const client = new Client({ connectionString: adminConnectionString });
  await client.connect();
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  try {
    for (;;) {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [RUNNER_LOCK_KEY]);
      if (rows[0].ok === true) {
        if (waited) console.log('[pg-proof] the other run finished; continuing');
        return {
          async release() {
            try {
              await client.query('SELECT pg_advisory_unlock(hashtext($1))', [RUNNER_LOCK_KEY]);
            } finally {
              await client.end().catch(() => {});
            }
          },
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(
          'Another `npm run test:pg` run holds the proof-runner lock on this server, and it did ' +
          'not finish within the wait. The runs cannot share a server: the four scoped roles are ' +
          'cluster-wide, so they would reset each other\'s per-run credentials. Wait for the other ' +
          'run, or point ATLAS_PG_ADMIN_URL at a different server. Nothing was created or dropped.'
        );
      }
      if (!waited) {
        waited = true;
        console.log('[pg-proof] another run holds the proof-runner lock — waiting rather than clobbering it');
      }
      await sleep(pollMs);
    }
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
}

async function main() {
  const admin = adminUrl();
  const name = databaseName();
  const target = withDatabase(admin, name);

  // Acquired BEFORE anything is created or dropped, so a run that cannot get the
  // lock has touched nothing at all.
  const runnerLock = await acquireRunnerLock(admin);

  let failed = null;
  let applierUrl = null;
  try {
    console.log(`[pg-proof] creating disposable database ${name}`);
    await adminQuery(admin, `CREATE DATABASE ${quoteIdent(name)}`);

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

    // ORPHANED, NOT MERELY MATCHING. The runner lock is held, so no other run can
    // be in progress — every surviving database with this suite's name shape is
    // therefore left over from a crashed run, and dropping it destroys no live
    // proof. Without the lock this scan could not tell the two apart, and the
    // second of two concurrent runs would have dropped the first one's database.
    //
    // Names come from pg_catalog, not from this process, so they are quoted.
    const leftovers = await adminQuery(
      admin,
      `SELECT datname FROM pg_database WHERE datname LIKE 'atlas\\_s2\\_proof\\_%' AND datname <> $1`,
      [name]
    );
    for (const row of leftovers.rows) {
      console.log(`[pg-proof] dropping orphaned database ${row.datname}`);
      await adminQuery(admin, `DROP DATABASE IF EXISTS ${quoteIdent(row.datname)} WITH (FORCE)`);
    }

    for (const role of ROLE_NAMES) {
    try {
      await adminQuery(admin, `DROP ROLE IF EXISTS ${quoteIdent(role)}`);
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
    await adminQuery(admin, `DROP ROLE IF EXISTS ${quoteIdent(APPLIER_ROLE)}`);
    await adminQuery(
      admin,
      // DDL takes no bind parameters, so the password is a literal. It is 36 hex
      // characters this process generated a moment ago — no quote can appear in
      // it — and the doubling is belt and braces rather than a real escape path.
      `CREATE ROLE ${quoteIdent(APPLIER_ROLE)} LOGIN PASSWORD '${applierPassword.replace(/'/g, "''")}' NOSUPERUSER CREATEROLE`
    );
    await adminQuery(admin, `ALTER DATABASE ${quoteIdent(name)} OWNER TO ${quoteIdent(APPLIER_ROLE)}`);
    applierUrl = (() => {
      const parsed = new URL(target);
      parsed.username = APPLIER_ROLE;
      parsed.password = applierPassword;
      return parsed.toString();
    })();

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
    // THE PROJECT-OWNER PATH, as a NOSUPERUSER role.
    //
    // `ATLAS_PG_PROOF_URL` above is the container's superuser, and a superuser
    // bypasses every privilege check — so a proof that the owner "can" do
    // something, run as that, proves nothing about `Atlas Production`, which has
    // no superuser. The applier is the CREATEROLE, NOSUPERUSER principal that
    // mirrors Supabase's `postgres`, and it owns `atlas.write_freeze` (§3.10).
    //
    // §6.2 P8a needs it in both directions: every scoped role is refused a write
    // to the control, and THIS principal — the only one D7 recognises — can set
    // and lift the freeze.
    env.ATLAS_PG_PROOF_URL_APPLIER = applierUrl;
    // The adapter reads the runtime role from its ordinary environment variable,
    // so the suite exercises the SAME configuration path production uses.
    env.ATLAS_SUPABASE_APP_URL = credentials.atlas_app;
    env.ATLAS_SUPABASE_READONLY_URL = credentials.atlas_readonly;
    env.ATLAS_SUPABASE_MIGRATE_URL = credentials.atlas_migrate;
    env.ATLAS_SUPABASE_REBUILD_URL = credentials.atlas_rebuild;

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
    // Destroyed with the run, whatever happened — and the guard now starts at
    // CREATE DATABASE, so a failure during setup drops the database too rather
    // than leaking it past the exact-run destruction contract.
    try {
      await adminQuery(admin, `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      console.log(`[pg-proof] dropped ${name}`);
    } catch (err) {
      console.error(`[pg-proof] could not drop ${name}: ${err.message}`);
    }
    // The applier is per-run state too. Left behind, the next run's DROP would
    // succeed anyway, but a stray LOGIN role on a shared server is not this
    // suite's to leave.
    try {
      await adminQuery(admin, `DROP ROLE IF EXISTS ${quoteIdent(APPLIER_ROLE)}`);
    } catch (err) {
      console.error(`[pg-proof] could not drop ${APPLIER_ROLE}: ${err.message}`);
    }
    // Released last: while it is held, the cleanup above is the only thing
    // touching this suite's shared state.
    await runnerLock.release().catch(() => {});
  }

  if (failed) {
    console.error(`[pg-proof] FAILED: ${failed.message}`);
    process.exitCode = 1;
  }
}

module.exports = { RUNNER_LOCK_KEY, APPLIER_ROLE, acquireRunnerLock, quoteIdent };

if (require.main === module) {
  main().catch((err) => {
    console.error(`[pg-proof] FAILED: ${err.message}`);
    process.exitCode = 1;
  });
}
