'use strict';

// Shared harness for the from-empty Postgres proof suite (§6.1 P2).
//
// Every connection here is a REAL connection to a real Postgres database created
// from empty for this run by scripts/run-pg-proof.js, with every file in
// supabase/migrations/ applied from scratch. Nothing in this directory uses a
// fake, a stub, or a mocked client — that is the whole point of P2.

const { Client } = require('pg');

function requireUrl(name) {
  const url = (process.env[name] || '').trim();
  if (!url) {
    throw new Error(
      `${name} is not set. Run this suite through \`npm run test:pg\`, which creates the ` +
        'disposable from-empty database and the four scoped roles. A skipped proof is a false green.'
    );
  }
  return url;
}

// The superuser/owner connection the harness itself uses to seed and truncate.
function ownerUrl() {
  return requireUrl('ATLAS_PG_PROOF_URL');
}

// A connection AS one of the four real scoped roles (§8.2). Least privilege is
// proven, not claimed: a statement proven only as superuser proves nothing about
// the deployed system.
function roleUrl(role) {
  return requireUrl(`ATLAS_PG_PROOF_URL_${role.toUpperCase()}`);
}

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function withOwner(fn) {
  const client = await connect(ownerUrl());
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withRole(role, fn) {
  const client = await connect(roleUrl(role));
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// THE PROJECT-OWNER PATH — the only principal D7 recognises as a mutator of
// atlas.write_freeze (§3.10, §5.3).
//
// Deliberately NOT `withOwner`. That one is the container's superuser, and a
// superuser bypasses every privilege check, so "the owner can lift the freeze"
// proven as a superuser proves nothing about `Atlas Production`, which has none.
// This is the NOSUPERUSER CREATEROLE applier that mirrors Supabase's `postgres`
// and actually OWNS the table, because §3.10 deliberately does not transfer
// ownership to atlas_migrate.
function applierUrl() {
  return requireUrl('ATLAS_PG_PROOF_URL_APPLIER');
}

async function withApplier(fn) {
  const client = await connect(applierUrl());
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Child-first so no foreign key blocks the reset. TRUNCATE rather than DELETE so
// identity sequences restart and a test's row ids are its own.
const TABLES_CHILD_FIRST = [
  'atlas.modality_log',
  'atlas.coaching_notes',
  'atlas.constraints',
  'atlas.deload_state',
  'atlas.sheets_mirror_allocations',
  'atlas.sheets_mirror_cursor',
  'atlas.migration_divergences',
  'atlas.write_receipts',
  // OWNER CORRECTION 2026-08-13: the catalog is Supabase-owned, so
  // `exercise_catalog_mirror` was renamed to `exercise_catalog` and the
  // `exercise_catalog_sync` freshness authority was dropped. Naming a removed
  // relation here fails EVERY proof in the run, not only the catalog ones,
  // because this reset runs before each of them.
  'atlas.exercise_catalog',
  'atlas.session_plan_set_recommendations',
  'atlas.session_plan_events',
  'atlas.session_effort',
  'atlas.logged_sets',
  'atlas.workout_sessions',
];

async function resetSchema() {
  await withOwner(async (client) => {
    await client.query(`TRUNCATE ${TABLES_CHILD_FIRST.join(', ')} RESTART IDENTITY CASCADE`);
  });
}

// Assert that a statement is REJECTED, and report what actually happened when it
// is not. A constraint with no violation test does not count as proven (P1), and
// a violation test that passes for the wrong reason proves nothing either — so
// the expected SQLSTATE is named.
async function expectRejected(client, sql, params, { sqlstate } = {}) {
  let error = null;
  try {
    await client.query(sql, params);
  } catch (err) {
    error = err;
  }
  if (!error) {
    throw new Error(`Expected the statement to be REJECTED, but it succeeded:\n${sql}`);
  }
  if (sqlstate && error.code !== sqlstate) {
    throw new Error(
      `Expected SQLSTATE ${sqlstate} but got ${error.code} (${error.message}) for:\n${sql}`
    );
  }
  return error;
}

// A valid session parent, so a child-row constraint test fails for the reason
// under test rather than for a missing parent.
async function seedSession(client, sessionId = '20260808-AM-01') {
  await client.query(
    `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
     VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, `${sessionId.slice(0, 4)}-${sessionId.slice(4, 6)}-${sessionId.slice(6, 8)}`,
      sessionId.slice(9, 11), Number(sessionId.slice(12, 14))]
  );
  return sessionId;
}

// SQLSTATEs the proofs assert on, named so a test reads as an intention.
const SQLSTATE = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  EXCLUSION_VIOLATION: '23P01',
  INSUFFICIENT_PRIVILEGE: '42501',
});

module.exports = {
  connect,
  ownerUrl,
  roleUrl,
  applierUrl,
  withOwner,
  withRole,
  withApplier,
  resetSchema,
  expectRejected,
  seedSession,
  SQLSTATE,
  TABLES_CHILD_FIRST,
};
