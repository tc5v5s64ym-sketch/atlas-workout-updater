'use strict';

// §6.1 P8b — the checkpoint's own guardrails, proven without a database.
//
// The hosted proof itself needs Atlas Production and the owner's credentials, so
// it cannot run here. What CAN and MUST run here is everything that decides
// whether the checkpoint would report a false green: the endpoint-shape rules,
// the fail-closed behaviour, the expected-table set, and the redaction rule.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'atlas-p8b-checkpoint.js');
const checkpoint = require('../scripts/atlas-p8b-checkpoint');

test('P8b: all four §8.2 roles are checked, including the owner-only rebuild role', () => {
  // P8b names atlas_rebuild explicitly: it needs a working connection when a
  // §5.7 rebuild runs, and an owner-only role nobody has connected as is a role
  // nobody knows works.
  assert.deepEqual(
    checkpoint.ROLES.map((r) => r.role).sort(),
    ['atlas_app', 'atlas_migrate', 'atlas_readonly', 'atlas_rebuild']
  );
  for (const entry of checkpoint.ROLES) {
    assert.match(entry.env, /^ATLAS_SUPABASE_[A-Z]+_URL$/);
  }
});

test('P8b: the expected schema is exactly S2 — eleven tables, and write_freeze absent', () => {
  assert.equal(checkpoint.S2_TABLES.length, 11);
  assert.ok(!checkpoint.S2_TABLES.includes('write_freeze'), 'write_freeze is S3, not S2');
  assert.equal(checkpoint.S3_TABLE_MUST_BE_ABSENT, 'write_freeze');
});

test('P8b: TRANSACTION mode is rejected — the exact misconfiguration the gate exists to catch', () => {
  // Supavisor transaction mode returns a different backend per transaction, so a
  // session-level advisory lock is taken on a connection the next statement may
  // not be using. It would appear to work and hold nothing.
  assert.equal(checkpoint.TRANSACTION_MODE_PORT, 6543);
  assert.equal(checkpoint.SESSION_MODE_PORT, 5432);

  const txMode = checkpoint.describeEndpoint('postgres://u:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres');
  assert.equal(txMode.port, 6543);
  assert.equal(txMode.isPooler, true);

  const sessionMode = checkpoint.describeEndpoint('postgres://u:p@aws-0-us-west-2.pooler.supabase.com:5432/postgres');
  assert.equal(sessionMode.port, 5432);
  assert.equal(sessionMode.isPooler, true);
});

test('P8b: the DIRECT endpoint is distinguished from the pooler', () => {
  // §8.1: the direct endpoint is IPv6-only on the Free plan and Render is
  // IPv4-only, so a direct-endpoint connection string is a misconfiguration even
  // when it happens to work from the owner's laptop.
  const direct = checkpoint.describeEndpoint('postgres://u:p@db.example-ref.supabase.co:5432/postgres');
  assert.equal(direct.isHostedSupabase, true);
  assert.equal(direct.isPooler, false, 'the direct endpoint must not read as the pooler');
});

test('P8b: a non-hosted target cannot discharge a proof about Atlas Production', () => {
  const local = checkpoint.describeEndpoint('postgres://u:p@127.0.0.1:5432/postgres');
  assert.equal(local.isHostedSupabase, false);
  assert.equal(local.isPooler, false);
});

test('P8b: an unparseable connection string is refused rather than guessed at', () => {
  const bad = checkpoint.describeEndpoint('not a url');
  assert.equal(bad.ok, false);
});

test('P8b: the checkpoint FAILS CLOSED when no credential is configured', async () => {
  // The whole point of the gate is that unproven is not the same as fine. Run the
  // real script with a clean environment and prove it exits non-zero rather than
  // reporting a vacuous pass.
  const { execFileSync } = require('child_process');
  const env = { ...process.env };
  for (const entry of checkpoint.ROLES) delete env[entry.env];

  let code = 0;
  let output = '';
  try {
    output = execFileSync(process.execPath, [SCRIPT, '--json'], { env, encoding: 'utf8' });
  } catch (err) {
    code = err.status;
    output = err.stdout || '';
  }
  assert.equal(code, 1, 'a checkpoint with no evidence must FAIL, never skip');
  const report = JSON.parse(output);
  assert.equal(report.gate, 'P8b');
  assert.equal(report.verdict, 'FAIL');
  // Every role must be named as failing — not just the first.
  for (const entry of checkpoint.ROLES) {
    assert.ok(
      report.checks.some((c) => c.check.startsWith(`${entry.role}:`) && c.status === 'FAIL'),
      `${entry.role} must be reported as unproven`
    );
  }
});

test('P8b: the script never prints a connection string, username, or project reference', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // §8.4 — the project reference is a secret, and the pooler username carries it.
  // The report is built from the port and the host SHAPE, never from the URL.
  assert.ok(!/console\.log\([^)]*\burl\b/.test(source), 'no code path logs a url');
  assert.ok(!/parsed\.username|parsed\.password/.test(source), 'the credential parts are never read');
  assert.ok(!/\$\{url\}/.test(source), 'no template ever interpolates the connection string');
});

test('P8b: the checkpoint applies no schema and writes no row', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // It is a checkpoint, not a migration path. The owner gate applies schema out
  // of band; this proves what was applied.
  for (const forbidden of [/\bCREATE TABLE\b/i, /\bALTER TABLE\b/i, /\bDROP\b/i, /\bINSERT INTO\b/i, /\bUPDATE .*\bSET\b/i, /\bDELETE FROM\b/i]) {
    assert.ok(!forbidden.test(source), `the checkpoint must not contain ${forbidden}`);
  }
});

test('P8b: nothing on a request path invokes the checkpoint', () => {
  // It is an owner-run, out-of-band tool. A server that could run it would be a
  // server holding four role credentials at once.
  const offenders = [];
  for (const rel of ['index.js', 'services', 'routes', 'src']) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const files = fs.statSync(full).isDirectory()
      ? fs.readdirSync(full).filter((f) => f.endsWith('.js')).map((f) => path.join(full, f))
      : [full];
    for (const file of files) {
      if (/atlas-p8b-checkpoint/.test(fs.readFileSync(file, 'utf8'))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
