'use strict';

// The enforcement §8.2's grant list cannot express, proven where it CAN be.
//
// supabase/migrations/20260808000800_roles_and_grants.sql records the deviation
// in full: PostgreSQL has no ALTER or DROP privilege, so DDL authority IS
// ownership, and an owner's implicit DML cannot be revoked without breaking the
// foreign-key checks that run as the referencing table's owner. So §8.2's
// "atlas_migrate holds no other DML on any table" is not expressible as a grant.
//
// Two things ARE real, and the migration file names this suite as the proof of
// the first:
//
//   1. atlas_migrate IS NEVER CONFIGURED IN THE SERVER RUNTIME — no production
//      request path can authenticate as it, so its ownership privileges are
//      unreachable from the app however broad they are;
//   2. atlas_app's grant list is exact, minimal, and proven AS the real role by
//      the from-empty least-privilege proof (test-pg/leastPrivilege.test.js, P7c).
//
// This file proves (1) by source scan, because a grant list that is enforced by
// "nobody would do that" is not enforced at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADAPTER = 'services/supabaseAdapter.js';

// The privileged credentials. atlas_rebuild is owner-operated and supplied only
// for the duration of a §5.7 rebuild; atlas_migrate is migration-only.
const PRIVILEGED_ENV = ['ATLAS_SUPABASE_MIGRATE_URL', 'ATLAS_SUPABASE_REBUILD_URL'];

function productionSources() {
  const files = [];
  for (const dir of ['services', 'routes', 'config', 'src/app']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    const walk = (current, prefix) => {
      for (const name of fs.readdirSync(current)) {
        const entry = path.join(current, name);
        if (fs.statSync(entry).isDirectory()) walk(entry, `${prefix}/${name}`);
        else if (name.endsWith('.js')) files.push(`${prefix}/${name}`);
      }
    };
    walk(full, dir);
  }
  files.push('index.js', 'sheets.js', 'middleware.js', 'response.js');
  return files;
}

test('no production module names a privileged Supabase credential — only the adapter maps it at all', () => {
  const offenders = [];
  for (const rel of productionSources()) {
    if (rel === ADAPTER) continue; // the single client holder; its ROLE_ENV map is the point
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const name of PRIVILEGED_ENV) {
      if (text.includes(name)) offenders.push(`${rel} references ${name}`);
    }
  }
  assert.deepEqual(offenders, [], 'a production module can reach a privileged Supabase role');
});

test('NO browser code imports a Supabase client or receives a connection string (§8.1)', () => {
  const appDir = path.join(ROOT, 'src', 'app');
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      if (fs.statSync(entry).isDirectory()) { walk(entry); continue; }
      if (!name.endsWith('.js')) continue;
      // COMMENTS ARE NOT CODE, and after the S4 cutover the browser shell has to be
      // able to SAY where the workout is written — "the Save lands in Supabase" is a
      // fact a reader of this file needs. What must never appear is a client, an
      // import, a credential or a connection string, so the scan reads executable
      // lines only.
      const text = fs.readFileSync(entry, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      if (/@supabase\/|from\s+['"][^'"]*supabase|require\(['"][^'"]*supabase|ATLAS_SUPABASE|\bpg\b.*require|postgres(?:ql)?:\/\//i.test(text)) {
        offenders.push(path.relative(ROOT, entry));
      }
    }
  };
  if (fs.existsSync(appDir)) walk(appDir);
  // The browser keeps talking to the Express API. No Supabase credential of any
  // kind appears in browser code.
  assert.deepEqual(offenders, []);
});

test('every RUNTIME adapter operation asks for the app role — the privileged roles have no request path', () => {
  const text = fs.readFileSync(path.join(ROOT, ADAPTER), 'utf8');

  // Which roles the adapter's operations actually connect as.
  const roles = new Set();
  for (const match of text.matchAll(/with(?:Client|Transaction)\(\s*'(\w+)'/g)) roles.add(match[1]);
  assert.deepEqual([...roles].sort(), ['app'], 'a hard-coded adapter operation connects as a non-app role');

  // The privileged defaults in the module are enumerated, because a default
  // parameter is how an owner-run operation reaches a privileged role without
  // giving the runtime a hard-coded path to one. There are exactly two.
  //
  // 1. The receipt prune, which §3.6 demotes to size housekeeping with no
  //    correctness role and no runtime consumer — atlas_app is refused DELETE on
  //    write_receipts, and P7c proves that refusal.
  assert.match(text, /async function pruneWriteReceipts\(role = 'migrate'\)/);
  // 2. Catalog maintenance (OWNER CORRECTION 2026-08-13). Supabase is the sole
  //    catalog authority, and the S4 catalog migration revokes atlas_app's INSERT
  //    and DELETE there, so the runtime can read the catalog and cannot change it.
  //    Its only consumer is the owner-run `npm run atlas:catalog`.
  assert.match(
    text,
    /async function applyCatalogMaintenance\(\{[^}]*\} = \{\}, role = 'migrate'\)/,
    'catalog maintenance must reach atlas_migrate through a default parameter, never a hard-coded literal'
  );
});

test('no request path calls catalog maintenance — the runtime never mutates the catalog', () => {
  // The grant is the real control (the S4 migration revokes atlas_app's INSERT and
  // DELETE on atlas.exercise_catalog). This proves the intent too: nothing outside
  // the owner CLI even names the mutation function.
  const allowed = new Set(['scripts/atlas-catalog-admin.js']);
  const offenders = [];
  for (const rel of productionSources()) {
    if (rel === ADAPTER || allowed.has(rel)) continue;
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    if (/\bapplyCatalogMaintenance\s*\(/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'a non-owner path can mutate the exercise catalog');
});

test('nothing on a request path calls the receipt prune', () => {
  const offenders = [];
  for (const rel of productionSources()) {
    if (rel === ADAPTER) continue;
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    if (/\bpruneWriteReceipts\s*\(/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('the read-only tools prefer atlas_readonly, mirroring the existing Sheets rule', () => {
  const status = fs.readFileSync(path.join(ROOT, 'scripts', 'atlas-status.js'), 'utf8');
  // Read-only tools build their own read-only client, exactly as they build their
  // own spreadsheets.readonly Sheets client today.
  assert.match(status, /ATLAS_SUPABASE_READONLY_URL/);
  assert.match(status, /\? 'readonly' : 'app'/);
});
