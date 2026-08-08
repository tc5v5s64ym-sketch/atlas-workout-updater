#!/usr/bin/env node
'use strict';

// Applies every file in supabase/migrations/ to a DISPOSABLE Postgres database,
// in lexical order, from empty.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §6.1 P2 and §8.5.
//
// THIS SCRIPT CANNOT REACH `Atlas Production`, AND THAT IS THE POINT (§6.1 P10).
// Applying schema to the hosted project is an OWNER GATE, executed by Dale out of
// band. Two structural refusals enforce it here:
//
//   1. A hosted Supabase host (*.supabase.co / *.supabase.com, including every
//      Supavisor pooler host) is REFUSED outright. There is no flag that lifts it.
//   2. A target whose `atlas` schema already holds objects is REFUSED, so a
//      database that carried state in from an earlier commit can never be
//      mistaken for the from-empty database P2 requires.
//
// Usage:
//   node scripts/apply-supabase-migrations.js --url postgres://... [--json]
//   ATLAS_PG_TEST_URL=postgres://... node scripts/apply-supabase-migrations.js

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

// Every hosted Supabase endpoint shape: the direct database host, the Supavisor
// pooler hosts, and the project API host all live under these two domains.
const HOSTED_SUPABASE_HOST = /(^|\.)supabase\.(co|com|in|red|net)$/i;

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function parseArgs(argv) {
  const args = { url: process.env.ATLAS_PG_TEST_URL || '', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i] || '';
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

// Exported so a unit test can prove the refusal without a database.
function assertTargetAllowed(url) {
  if (!url) {
    const err = new Error(
      'No target database. Pass --url or set ATLAS_PG_TEST_URL to a disposable Postgres database.'
    );
    err.code = 'NO_TARGET';
    throw err;
  }
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    const err = new Error('Target is not a parseable connection URL.');
    err.code = 'BAD_TARGET';
    throw err;
  }
  if (HOSTED_SUPABASE_HOST.test(host)) {
    const err = new Error(
      'Refusing to apply migrations to a hosted Supabase host. Applying schema to ' +
        'Atlas Production is an owner gate performed out of band; this script exists ' +
        'only to build the disposable from-empty database of §6.1 P2.'
    );
    err.code = 'HOSTED_TARGET_REFUSED';
    throw err;
  }
  return true;
}

async function assertAtlasSchemaEmpty(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'atlas'`
  );
  const existing = rows[0] ? rows[0].n : 0;
  if (existing > 0) {
    const err = new Error(
      `Refusing to apply: the target's atlas schema already holds ${existing} object(s). ` +
        'P2 requires a database created from EMPTY for the exact run — a database that ' +
        'carried state in from an earlier commit hides exactly the class of defect P1 exists to catch.'
    );
    err.code = 'TARGET_NOT_EMPTY';
    throw err;
  }
}

async function applyMigrations(url) {
  assertTargetAllowed(url);
  const files = migrationFiles();
  if (files.length === 0) {
    const err = new Error(`No migration files found in ${MIGRATIONS_DIR}.`);
    err.code = 'NO_MIGRATIONS';
    throw err;
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  const applied = [];
  try {
    await assertAtlasSchemaEmpty(client);
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Each file is one transaction: a half-applied migration file is never a
      // state the next file may build on.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `${file}: ${err.message}`;
        throw err;
      }
      applied.push(file);
    }
  } finally {
    await client.end();
  }
  return applied;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const applied = await applyMigrations(args.url);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, applied }, null, 2));
    } else {
      console.log(`Applied ${applied.length} migration file(s):`);
      for (const file of applied) console.log(`  ✓ ${file}`);
    }
  } catch (err) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, code: err.code || null, error: err.message }, null, 2));
    } else {
      console.error(`✗ ${err.message}`);
    }
    process.exitCode = 1;
  }
}

module.exports = { applyMigrations, assertTargetAllowed, migrationFiles, HOSTED_SUPABASE_HOST };

if (require.main === module) main();
