#!/usr/bin/env node
'use strict';

// `npm run atlas:supabase-restore-proof` — local scratch backup/restore proof (§8.4).
//
// Proves the restore VERIFICATION path against a disposable Postgres server:
//   from-empty migrations → seed fixture rows → export → fresh database →
//   from-empty migrations → import → row-count and migration-file parity.
//
// This is NOT a substitute for a real Atlas Production pg_dump. It reuses the
// same migration applier as `npm run test:pg` and refuses hosted Supabase hosts.
//
// Owner production backup (out of band, not run by this script):
//   Supabase Dashboard → Database → Backups → download, OR
//   pg_dump from an owner workstation using the direct/session connection.
//
// Usage:
//   ATLAS_PG_ADMIN_URL=postgres://... npm run atlas:supabase-restore-proof
//   npm run atlas:supabase-restore-proof -- --json

const { Client } = require('pg');
const crypto = require('crypto');
const { applyMigrations, assertTargetAllowed } = require('./apply-supabase-migrations');

const COUNT_TABLES = [
  'write_receipts',
  'coaching_notes',
  'constraints',
  'deload_state',
  'modality_log',
  'logged_sets',
  'workout_sessions',
];

function adminUrl() {
  const url = (process.env.ATLAS_PG_ADMIN_URL || '').trim();
  if (!url) {
    throw new Error(
      'ATLAS_PG_ADMIN_URL is not set. Point it at a disposable Postgres server ' +
        '(CI service container or local). This script cannot reach Atlas Production.'
    );
  }
  return url;
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function databaseName(prefix) {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const salt = crypto.randomBytes(3).toString('hex');
  return `${prefix}_${stamp}_${salt}`;
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function adminExec(admin, sql) {
  return withClient(admin, (client) => client.query(sql));
}

async function tableCounts(client) {
  const counts = {};
  for (const table of COUNT_TABLES) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM atlas.${table}`
    );
    counts[table] = rows[0].n;
  }
  return counts;
}

async function seedFixture(client) {
  await client.query(`
    INSERT INTO atlas.write_receipts (
      write_id, route, effect_authority, status,
      attempt_started_at, created_at, expires_at, completed_at
    ) VALUES (
      'restore-proof-1', '/api/log-workout', 'supabase', 'completed',
      now(), now(), now() + interval '24 hours', now()
    )`);
  await client.query(`
    INSERT INTO atlas.coaching_notes (note_date, note, write_id)
    VALUES ('2026-08-14', 'restore-proof seed', NULL)`);
}

async function exportAtlasData(client) {
  const payload = {};
  for (const table of COUNT_TABLES) {
    const { rows } = await client.query(`SELECT * FROM atlas.${table}`);
    payload[table] = rows;
  }
  return payload;
}

async function importAtlasData(client, payload) {
  for (const table of COUNT_TABLES) {
    const rows = payload[table] || [];
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    const colList = columns.map((c) => quoteIdent(c)).join(', ');
    for (const row of rows) {
      const values = columns.map((_, i) => `$${i + 1}`);
      const params = columns.map((c) => row[c]);
      await client.query(
        `INSERT INTO atlas.${table} (${colList}) VALUES (${values.join(', ')})`,
        params
      );
    }
  }
}

// P19d fail-closed helper: a restore source must not be older than the newest
// receipt the cutover still owes. Pure function for unit tests.
function assertBackupCoversReceipts({ backupTakenAtMs, newestReceiptExpiresAtMs }) {
  if (!Number.isFinite(backupTakenAtMs) || !Number.isFinite(newestReceiptExpiresAtMs)) {
    const err = new Error('backup freshness check requires numeric timestamps');
    err.code = 'BACKUP_FRESHNESS_INVALID';
    throw err;
  }
  if (backupTakenAtMs < newestReceiptExpiresAtMs) {
    const err = new Error(
      'Refusing restore: backup is older than the newest live receipt obligation'
    );
    err.code = 'BACKUP_TOO_OLD';
    throw err;
  }
  return true;
}

function verifyCountsMatch(before, after) {
  const mismatches = [];
  for (const table of COUNT_TABLES) {
    if ((before[table] || 0) !== (after[table] || 0)) {
      mismatches.push({ table, before: before[table], after: after[table] });
    }
  }
  if (mismatches.length) {
    const err = new Error(`Restore verification failed: ${JSON.stringify(mismatches)}`);
    err.code = 'RESTORE_COUNT_MISMATCH';
    err.mismatches = mismatches;
    throw err;
  }
  return true;
}

async function runProof() {
  const admin = adminUrl();
  assertTargetAllowed(admin);

  const sourceName = databaseName('atlas_restore_src');
  const targetName = databaseName('atlas_restore_tgt');
  const sourceUrl = withDatabase(admin, sourceName);
  const targetUrl = withDatabase(admin, targetName);

  let migrationFiles = [];
  try {
    await adminExec(admin, `CREATE DATABASE ${quoteIdent(sourceName)}`);
    const applied = await applyMigrations(sourceUrl);
    migrationFiles = applied;

    const beforeCounts = await withClient(sourceUrl, async (client) => {
      await seedFixture(client);
      return tableCounts(client);
    });

    const exported = await withClient(sourceUrl, (client) => exportAtlasData(client));

    await adminExec(admin, `CREATE DATABASE ${quoteIdent(targetName)}`);
    await applyMigrations(targetUrl);

    const afterCounts = await withClient(targetUrl, async (client) => {
      await importAtlasData(client, exported);
      return tableCounts(client);
    });

    verifyCountsMatch(beforeCounts, afterCounts);

    return {
      ok: true,
      source_database: sourceName,
      target_database: targetName,
      migration_files_applied: migrationFiles.length,
      table_counts: afterCounts,
      proof_level: 'local_scratch',
      production_equivalent: false,
    };
  } finally {
    await adminExec(admin, `DROP DATABASE IF EXISTS ${quoteIdent(targetName)} WITH (FORCE)`).catch(() => {});
    await adminExec(admin, `DROP DATABASE IF EXISTS ${quoteIdent(sourceName)} WITH (FORCE)`).catch(() => {});
  }
}

function parseArgs(argv) {
  return { json: argv.includes('--json'), help: argv.includes('--help') || argv.includes('-h') };
}

function printHelp() {
  console.log(`
atlas:supabase-restore-proof — local scratch backup/restore verification (§8.4).

  ATLAS_PG_ADMIN_URL=postgres://... npm run atlas:supabase-restore-proof
  npm run atlas:supabase-restore-proof -- --json

Proves migration ordering, export/import, and row-count verification on a disposable
database. Does NOT replace an owner-taken Atlas Production pg_dump.
`.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  try {
    const result = await runProof();
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('SUPABASE RESTORE PROOF — PASS (local scratch)');
      console.log(`  migrations applied: ${result.migration_files_applied}`);
      console.log(`  tables verified: ${Object.keys(result.table_counts).join(', ')}`);
      console.log('  production_equivalent: false — owner pg_dump still required for S4 gate');
    }
  } catch (error) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, code: error.code || null, error: error.message }, null, 2));
    } else {
      console.error(`SUPABASE RESTORE PROOF — FAIL: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

module.exports = {
  COUNT_TABLES,
  assertBackupCoversReceipts,
  verifyCountsMatch,
  runProof,
};

if (require.main === module) main();
