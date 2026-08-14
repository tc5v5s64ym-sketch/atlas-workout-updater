#!/usr/bin/env node
'use strict';

// Owner-controlled exercise-catalog maintenance.
//
// AUTHORITY: OWNER CORRECTION 2026-08-13, recorded in
// docs/ATLAS_V1_EXECUTION_PLAN.md. Supabase is the sole live authority for the
// exercise catalog. This is the ONLY mutation path for it.
//
// ── WHY A CLI AND NOT A ROUTE ─────────────────────────────────────────────────
//
// "Any mutation mechanism must be explicitly owner-controlled." A route would be
// reachable from the runtime, which is precisely what the S4 catalog migration
// removes: atlas_app's INSERT and DELETE on atlas.exercise_catalog are revoked, so
// the server cannot rewrite the catalog even if a code path tried. Maintenance
// runs as atlas_migrate, a role that is never configured in the server runtime
// (test/supabaseRoleSeparation.test.js proves that by source scan), so a catalog
// edit requires the owner to supply an owner-only credential out of band.
//
// This is the smallest mechanism that can do the job. It is not an admin
// framework: no UI, no generic table editor, no second mutation surface, and no
// scheduler. One command, one file, one transaction.
//
// ── SAFETY CONTRACT ───────────────────────────────────────────────────────────
//
//   - DRY RUN BY DEFAULT. It prints the exact plan and writes nothing unless the
//     operator passes --apply.
//   - One transaction. A run applies wholly or changes nothing, so the Save path
//     can never read a half-applied edit.
//   - It reads back and verifies after a real apply, and exits non-zero if the
//     destination does not match the plan.
//   - It prints no credential, no connection string and no project reference.
//
// ── USAGE ─────────────────────────────────────────────────────────────────────
//
//   npm run atlas:catalog -- --file rows.json              # dry run (default)
//   npm run atlas:catalog -- --file rows.json --apply      # apply
//   npm run atlas:catalog -- --list                        # print the catalog
//
// rows.json is an array of objects. `exercise` is required; the rest are
// optional:
//
//   [{ "exercise": "Bicep Curl", "muscle_group": "Arms",
//      "lift_code": "BC01", "canonical_exercise": "Bicep Curl" }]
//
// To remove rows, pass `{ "exercise": "Old Name", "delete": true }`.
//
// It requires ATLAS_SUPABASE_MIGRATE_URL, which is owner-held and is not set in
// the server runtime.

const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../services/supabaseAdapter');
const { catalogRowFromInput, readExerciseCatalogRows } = require('../services/exerciseCatalog');

function parseArgs(argv) {
  const args = { file: null, apply: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--file') { args.file = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
  }
  return args;
}

function loadPlan(file) {
  const resolved = path.resolve(file);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${file} as JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of catalog rows.`);

  const upserts = [];
  const deletes = [];
  for (const [index, input] of parsed.entries()) {
    if (!input || typeof input !== 'object') {
      throw new Error(`Entry ${index} is not an object.`);
    }
    if (input.delete === true) {
      const key = String(input.exercise ?? '').trim().toLowerCase();
      if (!key) throw new Error(`Entry ${index} asks for a delete with no \`exercise\`.`);
      deletes.push(key);
      continue;
    }
    upserts.push(catalogRowFromInput(input));
  }
  return { upserts, deletes };
}

function describe(plan) {
  console.log(`Plan: ${plan.upserts.length} upsert(s), ${plan.deletes.length} delete(s).`);
  for (const row of plan.upserts) {
    console.log(`  upsert  ${row.display_exercise}  [${row.muscle_group ?? '-'} / ${row.lift_code ?? '-'} / ${row.canonical_exercise ?? '-'}]`);
  }
  for (const key of plan.deletes) console.log(`  delete  ${key}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!adapter.isConfigured('migrate')) {
    console.error('ATLAS_SUPABASE_MIGRATE_URL is not set. Catalog maintenance is owner-run and needs the owner-held migrate role.');
    process.exitCode = 2;
    return;
  }

  if (args.list) {
    const rows = await readExerciseCatalogRows({ adapter });
    console.log(`atlas.exercise_catalog — ${Math.max(0, rows.length - 1)} row(s).`);
    for (const row of rows.slice(1)) console.log(`  ${row.join(' | ')}`);
    return;
  }

  if (!args.file) {
    console.error('Nothing to do. Pass --file <rows.json>, or --list to print the catalog.');
    process.exitCode = 2;
    return;
  }

  const plan = loadPlan(args.file);
  describe(plan);

  if (!args.apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to write.');
    return;
  }

  const result = await adapter.applyCatalogMaintenance(plan);
  console.log(`\nApplied: ${result.upserted} upserted, ${result.deleted} deleted.`);

  // Read back and verify, rather than trusting the write. An upsert that silently
  // did nothing is the failure this catches.
  const after = new Map(
    (await readExerciseCatalogRows({ adapter })).slice(1).map((row) => [String(row[0]).toLowerCase(), row])
  );
  const missing = plan.upserts.filter((row) => !after.has(row.exercise)).map((row) => row.display_exercise);
  const surviving = plan.deletes.filter((key) => after.has(key));

  if (missing.length || surviving.length) {
    if (missing.length) console.error(`VERIFY FAILED — absent after upsert: ${missing.join(', ')}`);
    if (surviving.length) console.error(`VERIFY FAILED — still present after delete: ${surviving.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('Verified: every planned row is in the expected state.');
}

main()
  .catch((error) => {
    console.error(`Catalog maintenance failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => adapter.close().catch(() => {}));
