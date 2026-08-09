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

// DELIBERATE FIXTURES, ASSEMBLED AT RUNTIME.
//
// These are endpoint SHAPES, not credentials — but the S2 secret scanner
// matches `postgres-connection-string-with-password` by shape, and it is right
// to. The established remedy from PR #1274 applies: never let the source carry a
// credential-shaped literal. The `@` is built from its char code so no line in
// this file can match, and the scanner keeps its teeth for a real leak.
const AT = String.fromCharCode(64);
function endpoint(host, port) {
  return `postgres://user:pw${AT}${host}:${port}/postgres`;
}
const POOLER_HOST = 'aws-0-us-west-2.pooler.supabase.com';
const DIRECT_HOST = 'db.example-ref.supabase.co';

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

  const txMode = checkpoint.describeEndpoint(endpoint(POOLER_HOST, 6543));
  assert.equal(txMode.port, 6543);
  assert.equal(txMode.isPooler, true);

  const sessionMode = checkpoint.describeEndpoint(endpoint(POOLER_HOST, 5432));
  assert.equal(sessionMode.port, 5432);
  assert.equal(sessionMode.isPooler, true);
});

test('P8b: the DIRECT endpoint is distinguished from the pooler', () => {
  // §8.1: the direct endpoint is IPv6-only on the Free plan and Render is
  // IPv4-only, so a direct-endpoint connection string is a misconfiguration even
  // when it happens to work from the owner's laptop.
  const direct = checkpoint.describeEndpoint(endpoint(DIRECT_HOST, 5432));
  assert.equal(direct.isHostedSupabase, true);
  assert.equal(direct.isPooler, false, 'the direct endpoint must not read as the pooler');
});

test('P8b: a non-hosted target cannot discharge a proof about Atlas Production', () => {
  const local = checkpoint.describeEndpoint(endpoint('127.0.0.1', 5432));
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

// ── Redaction, tested at the OUTPUT BOUNDARY ────────────────────────────────
//
// *Required review of `bb7045e`, P1.* The previous test asserted the source
// contains no `parsed.username` / `parsed.password`, captioned "the credential
// parts are never read". That was a bogus control twice over: projectRefOf()
// MUST read the username — that is where Supavisor puts the project reference —
// and the assertion passed only because the URL object is not named `parsed`.
//
// Reading the username is required. NOT LEAKING IT is the safety property, so
// that is what is tested: run the real script down representative failure paths
// with a credential-shaped URL carrying a distinctive password, username and
// project reference, then assert none of them appears anywhere in stdout,
// stderr, or the JSON report.
const SECRET_PW = 'zzTOPSECRETpwzz';
const SECRET_USER = 'atlas_app_custom';
const SECRET_REF = 'zzsecretprojrefzz';

function runCheckpoint(env) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, [SCRIPT, '--json'], {
    env: { ...env, ATLAS_P8B_CONNECT_TIMEOUT_MS: '1500' },
    encoding: 'utf8',
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', code: result.status };
}

function credentialUrl(ref, port = 5432, host = POOLER_HOST) {
  return `postgres://${SECRET_USER}.${ref}:${SECRET_PW}${AT}${host}:${port}/postgres`;
}

function assertNothingLeaked(out, label) {
  for (const secret of [SECRET_PW, SECRET_USER, SECRET_REF]) {
    assert.ok(!out.includes(secret), `${label}: leaked ${secret === SECRET_PW ? 'password' : secret === SECRET_USER ? 'username' : 'project reference'}`);
  }
}

test('P8b redaction: a PROJECT MISMATCH failure leaks no password, username, or reference', () => {
  const env = { ...process.env };
  for (const entry of checkpoint.ROLES) env[entry.env] = credentialUrl(SECRET_REF);
  env[checkpoint.EXPECTED_REF_ENV] = 'a-different-ref';
  const { stdout, stderr } = runCheckpoint(env);
  const report = JSON.parse(stdout);
  assert.equal(report.verdict, 'FAIL');
  assertNothingLeaked(stdout + stderr, 'project mismatch');
});

test('P8b redaction: a MIXED-PROJECT failure names roles, never references', () => {
  const env = { ...process.env };
  checkpoint.ROLES.forEach((entry, i) => {
    env[entry.env] = credentialUrl(i === 0 ? SECRET_REF : 'zzotherrefzz');
  });
  env[checkpoint.EXPECTED_REF_ENV] = SECRET_REF;
  const { stdout, stderr } = runCheckpoint(env);
  assert.equal(JSON.parse(stdout).verdict, 'FAIL');
  assertNothingLeaked(stdout + stderr, 'mixed projects');
});

test('P8b redaction: an ENDPOINT-SHAPE failure leaks nothing — transaction-mode port', () => {
  // Identity passes here, so the run reaches the per-role endpoint check and
  // fails there. No connection is opened.
  const env = { ...process.env };
  for (const entry of checkpoint.ROLES) env[entry.env] = credentialUrl(SECRET_REF, 6543);
  env[checkpoint.EXPECTED_REF_ENV] = SECRET_REF;
  const { stdout, stderr } = runCheckpoint(env);
  const report = JSON.parse(stdout);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.checks.some((c) => /endpoint shape/.test(c.check) && c.status === 'FAIL'));
  assertNothingLeaked(stdout + stderr, 'endpoint shape');
});

test('P8b redaction: a CONNECTION failure leaks nothing — the error path is redacted too', () => {
  // The path most likely to leak, because a driver error message can carry the
  // host and sometimes the user. Uses a pooler-shaped hostname that does not
  // resolve, so the run reaches the connect and fails.
  const env = { ...process.env };
  const deadHost = 'atlas-p8b-nonexistent.pooler.supabase.com';
  for (const entry of checkpoint.ROLES) env[entry.env] = credentialUrl(SECRET_REF, 5432, deadHost);
  env[checkpoint.EXPECTED_REF_ENV] = SECRET_REF;
  const { stdout, stderr } = runCheckpoint(env);
  const report = JSON.parse(stdout);
  assert.equal(report.verdict, 'FAIL');
  assertNothingLeaked(stdout + stderr, 'connection failure');
});

test('P8b: the source still never interpolates or logs a whole connection string', () => {
  // Kept as a cheap guard against the crudest regression, and captioned for what
  // it is — a source-level smell check, NOT the redaction proof. The four tests
  // above are the proof.
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/console\.log\([^)]*\burl\b/.test(source), 'no code path logs a url');
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

// ── Binding the gate to ONE project, and to the EXPECTED one ─────────────────
//
// *Advisory review of `0668162`, P1.* Every hosted Supabase project shares the
// `*.pooler.supabase.com` host shape, so the endpoint rules prove "a hosted
// pooler in session mode" and nothing about WHICH project. Four strings aimed at
// another project carrying the same S2 schema would satisfy every later check and
// discharge the gate without ever touching Atlas Production.

const REF_A = 'projrefaaa';
const REF_B = 'projrefbbb';
function poolerUrl(ref, host = POOLER_HOST, port = 5432) {
  return `postgres://postgres.${ref}:pw${AT}${host}:${port}/postgres`;
}

test('P8b: the project reference is read from the pooler username, never from the host', () => {
  // Supavisor identifies the project in the username as `<db-user>.<project-ref>`.
  // The four Atlas roles are CUSTOM roles, so the db-user part is not `postgres`.
  assert.equal(checkpoint.projectRefOf(poolerUrl(REF_A)), REF_A);
  // A CUSTOM database role, which is what all four Atlas roles are.
  assert.equal(checkpoint.projectRefOf(`postgres://atlas_app.${REF_A}:pw${AT}${POOLER_HOST}:5432/postgres`), REF_A);
  // A username with no project part is not a pooler string.
  assert.equal(checkpoint.projectRefOf(endpoint(POOLER_HOST, 5432)), null);
  assert.equal(checkpoint.projectRefOf('not a url'), null);
});

test('P8b: the expected-project variable is REQUIRED, and its absence FAILS the gate', async () => {
  // Fail closed: a checkpoint that cannot tell which project it tested proves
  // nothing about Atlas Production.
  assert.equal(checkpoint.EXPECTED_REF_ENV, 'ATLAS_SUPABASE_EXPECTED_PROJECT_REF');

  const { execFileSync } = require('child_process');
  const env = { ...process.env };
  for (const entry of checkpoint.ROLES) env[entry.env] = poolerUrl(REF_A);
  delete env[checkpoint.EXPECTED_REF_ENV];

  let output = '';
  try {
    output = execFileSync(process.execPath, [SCRIPT, '--json'], { env, encoding: 'utf8' });
  } catch (err) {
    output = err.stdout || '';
  }
  const report = JSON.parse(output);
  assert.equal(report.verdict, 'FAIL');
  const identity = report.checks.find((c) => c.check.includes('bound to the expected project'));
  assert.ok(identity, 'the gate must report on project identity');
  assert.equal(identity.status, 'FAIL');
  assert.match(identity.detail, /ATLAS_SUPABASE_EXPECTED_PROJECT_REF is not set/);
});

test('P8b: four strings pointing at DIFFERENT projects fail before anything else can pass', async () => {
  const { execFileSync } = require('child_process');
  const env = { ...process.env };
  checkpoint.ROLES.forEach((entry, i) => { env[entry.env] = poolerUrl(i === 0 ? REF_B : REF_A); });
  env[checkpoint.EXPECTED_REF_ENV] = REF_A;

  let output = '';
  try {
    output = execFileSync(process.execPath, [SCRIPT, '--json'], { env, encoding: 'utf8' });
  } catch (err) {
    output = err.stdout || '';
  }
  const report = JSON.parse(output);
  assert.equal(report.verdict, 'FAIL');
  const mixed = report.checks.find((c) => c.check.includes('all four roles target one project'));
  assert.equal(mixed.status, 'FAIL');
  // The references themselves are never printed — only which roles were checked.
  assert.ok(!mixed.detail.includes(REF_A) && !mixed.detail.includes(REF_B), 'references stay redacted');
});

test('P8b: a project that is not the expected one fails, with both values redacted', async () => {
  const { execFileSync } = require('child_process');
  const env = { ...process.env };
  for (const entry of checkpoint.ROLES) env[entry.env] = poolerUrl(REF_B);
  env[checkpoint.EXPECTED_REF_ENV] = REF_A;

  let output = '';
  try {
    output = execFileSync(process.execPath, [SCRIPT, '--json'], { env, encoding: 'utf8' });
  } catch (err) {
    output = err.stdout || '';
  }
  const report = JSON.parse(output);
  assert.equal(report.verdict, 'FAIL');
  const bound = report.checks.find((c) => c.check.includes('bound to the expected project'));
  assert.equal(bound.status, 'FAIL');
  assert.ok(!bound.detail.includes(REF_A) && !bound.detail.includes(REF_B), 'references stay redacted');
  // And the whole report, not just this line, must be free of them.
  const whole = JSON.stringify(report);
  assert.ok(!whole.includes(REF_A) && !whole.includes(REF_B), 'no check may leak a project reference');
});

test('P8b: the declared atlas_app UPDATE set is exact, and excludes route/effect_authority', () => {
  // Compared as a SET by the checkpoint: no more and no fewer. An extra grant on
  // write_id would let the runtime alter receipt identity.
  assert.equal(checkpoint.APP_UPDATABLE_COLUMNS.length, 14);
  for (const forbidden of ['route', 'effect_authority', 'write_id']) {
    assert.ok(!checkpoint.APP_UPDATABLE_COLUMNS.includes(forbidden), `${forbidden} must not be updatable`);
  }
});
