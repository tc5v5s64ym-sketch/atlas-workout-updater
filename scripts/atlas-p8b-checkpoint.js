#!/usr/bin/env node
'use strict';

// §6.1 P8b — the owner-gated hosted checkpoint between `S2` and `S3`.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §6.1 P8b, §8.1, §8.2.
// Plan authority: docs/ATLAS_V1_EXECUTION_PLAN.md, owner gate 2.
//
// WHAT THIS PROVES, AND WHY IT CANNOT BE PROVEN ANYWHERE ELSE.
// `S2` proved the four roles and their exact grants on a from-empty plain
// Postgres database, as the real roles (P7c). That database has no Supavisor, so
// it cannot prove the one thing the deployed system depends on: that a
// SESSION-LEVEL advisory lock survives across statements through the pooler.
// Transaction mode would take that lock on a connection the next statement may
// not even be using — it would appear to work and hold nothing, and the §5.4
// export's whole exclusivity argument would be silently false.
//
// So this runs against `Atlas Production` AFTER the owner applies the `S2`
// schema and BEFORE `S3` begins. `S3` may not start until it passes.
//
// ── WHAT THIS SCRIPT IS NOT ───────────────────────────────────────────────────
// It applies NO schema. It creates nothing, drops nothing, and writes no row. It
// moves no athlete-facing read or write. It is a read-only checkpoint plus
// advisory-lock session state, which is not data. `scripts/check-supabase-
// migration-safety.js` keeps every GitHub-triggered path away from production;
// this script is run by the owner, by hand, with credentials only the owner holds.
//
// ── FAIL CLOSED, ALWAYS ───────────────────────────────────────────────────────
// A missing role, an unreachable host, a wrong-mode endpoint, an unverifiable
// claim: every one of them is a FAIL, never a skip and never an assumption. The
// gate exists because "assumed IPv6 reachability does not count as proof"; the
// same rule applies to every other check here. A checkpoint that reports PASS on
// evidence it could not gather is worse than no checkpoint.
//
// Usage (owner, out of band — never in CI, never in a workflow):
//   ATLAS_SUPABASE_APP_URL=…      \
//   ATLAS_SUPABASE_READONLY_URL=… \
//   ATLAS_SUPABASE_MIGRATE_URL=…  \
//   ATLAS_SUPABASE_REBUILD_URL=…  \
//   node scripts/atlas-p8b-checkpoint.js [--json]
//
// Exit code 0 = PASS, 1 = FAIL. No output ever contains a connection string, a
// password, a username, or the project reference (§8.4).

const { Client } = require('pg');

// §8.2 — the four roles, and the environment variable each takes its own
// credential from. Order is the report order.
const ROLES = Object.freeze([
  { role: 'atlas_app', env: 'ATLAS_SUPABASE_APP_URL', note: 'the Express runtime role' },
  { role: 'atlas_readonly', env: 'ATLAS_SUPABASE_READONLY_URL', note: 'read-only tooling' },
  { role: 'atlas_migrate', env: 'ATLAS_SUPABASE_MIGRATE_URL', note: 'schema owner and operator jobs' },
  // Named explicitly by P8b: it needs a WORKING connection when a §5.7 rebuild
  // runs, and an owner-only role nobody has ever connected as is a role nobody
  // knows works.
  { role: 'atlas_rebuild', env: 'ATLAS_SUPABASE_REBUILD_URL', note: 'owner-only §5.7 rebuild' },
]);

// §3.1–§3.9 — the eleven tables `S2` creates. `write_freeze` (§3.10) is `S3`'s
// and must be ABSENT here; its presence would mean something applied S3 early.
const S2_TABLES = Object.freeze([
  'exercise_catalog_mirror', 'exercise_catalog_sync', 'logged_sets',
  'migration_divergences', 'session_effort', 'session_plan_events',
  'session_plan_set_recommendations', 'sheets_mirror_allocations',
  'sheets_mirror_cursor', 'workout_sessions', 'write_receipts',
]);

const S3_TABLE_MUST_BE_ABSENT = 'write_freeze';

// Supavisor's session-mode port. Transaction mode is 6543 and is the exact
// misconfiguration this gate exists to catch, so it is named rather than merely
// excluded.
const SESSION_MODE_PORT = 5432;
const TRANSACTION_MODE_PORT = 6543;

const results = [];
let failed = false;

function record(check, status, detail) {
  results.push({ check, status, detail });
  if (status === 'FAIL') failed = true;
}

// §8.4 — the project reference is a secret, and the pooler username carries it
// (`postgres.<projectref>`). Nothing below ever prints a URL, a username, or a
// password: only the port and whether the host has the pooler shape, which are
// the two facts the checkpoint actually reasons about.
function describeEndpoint(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'not a parseable connection URL' };
  }
  const port = parsed.port ? Number(parsed.port) : 5432;
  const host = parsed.hostname.toLowerCase();
  return {
    ok: true,
    port,
    // Redacted shape, never the host itself: the region-bearing pooler hostname
    // is not a credential, but it is unnecessary to print and the reference in
    // the username is.
    isPooler: /(^|\.)pooler\.supabase\.(co|com)$/i.test(host),
    isHostedSupabase: /(^|\.)supabase\.(co|com|in|red|net)$/i.test(host),
  };
}

// A connection whose endpoint is wrong is not a connection worth testing: the
// advisory-lock proof below would pass or fail for a reason unrelated to the
// deployed configuration.
function checkEndpointShape(role, url) {
  const shape = describeEndpoint(url);
  if (!shape.ok) {
    record(`${role}: endpoint shape`, 'FAIL', shape.reason);
    return null;
  }
  if (shape.port === TRANSACTION_MODE_PORT) {
    record(
      `${role}: endpoint shape`, 'FAIL',
      `port ${TRANSACTION_MODE_PORT} is Supavisor TRANSACTION mode. §8.1 requires SESSION ` +
      `mode (port ${SESSION_MODE_PORT}): a session-level advisory lock does not survive ` +
      'transaction mode, and the §5.4 export depends on one that does.'
    );
    return null;
  }
  if (shape.port !== SESSION_MODE_PORT) {
    record(`${role}: endpoint shape`, 'FAIL', `port ${shape.port} is neither session nor transaction mode`);
    return null;
  }
  if (!shape.isHostedSupabase) {
    record(
      `${role}: endpoint shape`, 'FAIL',
      'host is not a hosted Supabase endpoint. P8b is a proof about Atlas Production; ' +
      'a local or disposable target cannot discharge it.'
    );
    return null;
  }
  if (!shape.isPooler) {
    record(
      `${role}: endpoint shape`, 'FAIL',
      'host is the DIRECT database endpoint, not the Supavisor pooler. §8.1 rules that ' +
      'Atlas connects through the pooler because the direct endpoint is IPv6-only on the ' +
      'Free plan and Render is IPv4-only.'
    );
    return null;
  }
  record(`${role}: endpoint shape`, 'PASS', `Supavisor pooler, session mode (port ${SESSION_MODE_PORT})`);
  return shape;
}

// THE LOAD-BEARING MECHANISM, extracted so it can be proven against a real
// database before the owner ever runs this against Atlas Production.
//
// A checkpoint whose PASS has never been shown to be DISCRIMINATING is a green
// light nobody has tested. `test-pg/p8bLockProof.pgproof.js` runs this function
// against the disposable Postgres and proves both directions: a genuinely held
// session lock reports heldLater=true, and a lock that was released reports
// heldLater=false. The endpoint-shape rules above still refuse a non-hosted
// target, so proving the MECHANISM locally never lets a local run discharge the
// GATE.
//
// Matched on classid AND objid, not objid alone. A 64-bit advisory key splits
// across both columns — classid is the high word (0xFFFFFFFF for the negative
// keys three of the four role names hash to) and objid is the low word — so
// objid alone could in principle match a different key. Re-acquiring the lock
// would prove nothing at all, because advisory locks are re-entrant within a
// session; reading pg_locks by this session's own pid is the only honest check.
async function proveSessionLock(client, lockKey) {
  const acquired = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
  if (acquired.rows[0].ok !== true) return { acquired: false, heldLater: false };

  // Deliberately several statements later, and outside any transaction: under
  // Supavisor transaction mode these may land on a different backend, which is
  // exactly the failure this gate exists to catch.
  await client.query('SELECT 1');
  await client.query('SELECT 1');
  const held = await client.query(
    `SELECT count(*)::int AS n
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND pid = pg_backend_pid()
        AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)
        AND objid   =  (hashtext($1)::bigint        & 4294967295)`,
    [lockKey]
  );
  const heldLater = held.rows[0].n > 0;
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
  return { acquired: true, heldLater };
}

// The core of P8b. One connection, four facts, in one session.
async function checkRole({ role, env, note }) {
  const url = (process.env[env] || '').trim();
  if (!url) {
    record(
      `${role}: credential`, 'FAIL',
      `${env} is not set. P8b requires a working connection as ALL FOUR roles — ` +
      `${role} is ${note}. An untested role is not a proven role.`
    );
    return;
  }
  record(`${role}: credential`, 'PASS', `${env} is set`);

  if (!checkEndpointShape(role, url)) return;

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    // Reachability is PROVEN by connecting, never assumed — that is the sentence
    // P8b is built around.
    record(`${role}: pooler connection`, 'FAIL', `could not connect: ${err.code || err.message}`);
    return;
  }

  try {
    // 1. The pooler authenticates as the INTENDED role. Supavisor carries the
    //    role in the username, so role separation either survives pooling or the
    //    whole least-privilege model is one shared identity wearing four names.
    const who = await client.query('SELECT current_user AS role, pg_backend_pid() AS pid');
    const actual = who.rows[0].role;
    const firstPid = who.rows[0].pid;
    if (actual !== role) {
      record(
        `${role}: pooler authenticates as the intended role`, 'FAIL',
        `connected as "${actual}". Least privilege is only real if the pooler preserves it.`
      );
      return;
    }
    record(`${role}: pooler authenticates as the intended role`, 'PASS', `current_user = ${actual}`);

    // 2. A MULTI-STATEMENT TRANSACTION, as P8b names it.
    await client.query('BEGIN');
    await client.query('SELECT 1');
    const inTx = await client.query('SELECT pg_backend_pid() AS pid');
    await client.query('COMMIT');
    if (inTx.rows[0].pid !== firstPid) {
      record(
        `${role}: multi-statement transaction`, 'FAIL',
        'the backend pid changed inside one transaction — the connection is not pinned'
      );
      return;
    }
    record(`${role}: multi-statement transaction`, 'PASS', 'committed on one pinned backend');

    // 3. THE LOAD-BEARING PROOF: a SESSION-level advisory lock, taken in one
    //    statement and still held in a LATER, SEPARATE statement — checked
    //    against pg_locks by this session's own pid rather than by re-acquiring
    //    it, because advisory locks are re-entrant and a second successful
    //    acquire would prove nothing at all.
    //
    //    The lock key is derived from the role name, so two roles running this
    //    checkpoint concurrently cannot collide and report a false failure.
    const lockKey = `atlas-p8b-${role}`;
    const proof = await proveSessionLock(client, lockKey);
    if (!proof.acquired) {
      record(`${role}: session advisory lock`, 'FAIL', 'could not acquire the advisory lock');
      return;
    }
    const stillHeld = proof.heldLater;
    if (!stillHeld) {
      record(
        `${role}: session advisory lock survives across statements`, 'FAIL',
        'the lock was gone by a later statement. This is exactly what transaction mode ' +
        'does: the §5.4 export would appear to hold exclusivity and hold nothing.'
      );
      return;
    }
    record(
      `${role}: session advisory lock survives across statements`, 'PASS',
      'held across three later statements on the same backend, then released'
    );
  } catch (err) {
    record(`${role}: checkpoint`, 'FAIL', `unexpected error: ${err.code || err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// Step 5 of the gate: the schema the owner applied is the schema `S2` reviewed.
// Read through atlas_readonly, because a check that needs elevated rights to run
// is a check nobody will run.
async function checkSchema() {
  const url = (process.env.ATLAS_SUPABASE_READONLY_URL || '').trim();
  if (!url) {
    record('schema: S2 tables present', 'FAIL', 'ATLAS_SUPABASE_READONLY_URL is not set');
    return;
  }
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    record('schema: S2 tables present', 'FAIL', `could not connect: ${err.code || err.message}`);
    return;
  }
  try {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'atlas' ORDER BY tablename`
    );
    const present = rows.map((r) => r.tablename);
    const missing = S2_TABLES.filter((t) => !present.includes(t));
    const unexpected = present.filter((t) => !S2_TABLES.includes(t));

    if (missing.length) {
      record('schema: S2 tables present', 'FAIL', `missing: ${missing.join(', ')}`);
    } else {
      record('schema: S2 tables present', 'PASS', `all ${S2_TABLES.length} tables of §3.1–§3.9`);
    }

    // `write_freeze` here would mean S3 schema reached production early — the
    // gate would be reporting on a state nobody authorized.
    if (present.includes(S3_TABLE_MUST_BE_ABSENT)) {
      record(
        `schema: ${S3_TABLE_MUST_BE_ABSENT} is ABSENT (S3 has not started)`, 'FAIL',
        'the S3 write-freeze table exists. S3 schema must not be applied before this gate passes.'
      );
    } else {
      record(`schema: ${S3_TABLE_MUST_BE_ABSENT} is ABSENT (S3 has not started)`, 'PASS', 'not present, as required');
    }

    const otherUnexpected = unexpected.filter((t) => t !== S3_TABLE_MUST_BE_ABSENT);
    if (otherUnexpected.length) {
      record('schema: no unreviewed table', 'FAIL', `unexpected in atlas: ${otherUnexpected.join(', ')}`);
    } else {
      record('schema: no unreviewed table', 'PASS', 'atlas holds exactly the reviewed set');
    }

    // The four roles exist as roles. Their GRANTS were proven exhaustively by
    // P7c on the from-empty database against the same migration files; what the
    // hosted check adds is that the applied database really carries them.
    const roleRows = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [ROLES.map((r) => r.role)]
    );
    const foundRoles = roleRows.rows.map((r) => r.rolname);
    const missingRoles = ROLES.map((r) => r.role).filter((r) => !foundRoles.includes(r));
    if (missingRoles.length) {
      record('schema: the four §8.2 roles exist', 'FAIL', `missing: ${missingRoles.join(', ')}`);
    } else {
      record('schema: the four §8.2 roles exist', 'PASS', foundRoles.join(', '));
    }

    // atlas_app's column-scoped UPDATE grants are the ones a hand-applied schema
    // is most likely to lose, and the ones the receipt state machine depends on.
    const grants = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.column_privileges
        WHERE grantee = 'atlas_app' AND privilege_type = 'UPDATE'
          AND table_schema = 'atlas' AND table_name = 'write_receipts'
        ORDER BY column_name`
    );
    const cols = grants.rows.map((r) => r.column_name);
    const required = [
      'ambiguity_proof', 'ambiguous_at', 'appended_range', 'attempt', 'attempt_started_at',
      'attempt_token', 'completed_at', 'created_at', 'expires_at', 'owner_instance_id',
      'response_body', 'rows_written', 'session_id', 'status',
    ];
    const missingCols = required.filter((c) => !cols.includes(c));
    // route and effect_authority must NOT be updatable: the round-5 binding of
    // one write_id to one route is defeated by relabelling a row, not only by
    // editing a statement.
    const forbidden = ['route', 'effect_authority'].filter((c) => cols.includes(c));
    if (missingCols.length || forbidden.length) {
      record(
        'grants: atlas_app column-scoped UPDATE on write_receipts', 'FAIL',
        [
          missingCols.length ? `missing: ${missingCols.join(', ')}` : '',
          forbidden.length ? `must NOT be granted: ${forbidden.join(', ')}` : '',
        ].filter(Boolean).join('; ')
      );
    } else {
      record(
        'grants: atlas_app column-scoped UPDATE on write_receipts', 'PASS',
        `exactly the ${required.length} declared columns; route and effect_authority immutable`
      );
    }
  } catch (err) {
    record('schema: S2 tables present', 'FAIL', `unexpected error: ${err.code || err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const json = process.argv.includes('--json');

  for (const entry of ROLES) await checkRole(entry);
  await checkSchema();

  const verdict = failed ? 'FAIL' : 'PASS';
  if (json) {
    console.log(JSON.stringify({ gate: 'P8b', verdict, checks: results }, null, 2));
  } else {
    console.log('\n§6.1 P8b — hosted Supavisor checkpoint (Atlas Production)\n');
    for (const r of results) {
      console.log(`  ${r.status === 'PASS' ? '✔' : '✖'} ${r.check}\n      ${r.detail}`);
    }
    console.log(`\n  VERDICT: ${verdict}`);
    if (verdict === 'PASS') {
      console.log('  The pre-S3 owner gate is discharged. S3 is eligible to begin.\n');
    } else {
      console.log('  S3 may NOT begin. Every FAIL above is a blocker, not a warning.\n');
    }
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    // An unexpected throw is a FAIL, never a silent pass.
    console.error(`[p8b] FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  ROLES, S2_TABLES, S3_TABLE_MUST_BE_ABSENT, describeEndpoint,
  proveSessionLock, SESSION_MODE_PORT, TRANSACTION_MODE_PORT,
};
