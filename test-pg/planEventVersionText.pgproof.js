'use strict';

// THE PLAN-EVENT VERSION AGAINST REAL POSTGRES — owner ruling 2026-08-12.
//
// `Session_Plans.plan_version` is an opaque `pv_…` identity token, and the
// destination column was declared `integer CHECK (plan_version >= 1)`. Production
// forensics found 55 eligible historical plan events carrying such tokens; none of
// them could have been inserted, and the row contract turned each one into NULL
// before it ever reached the constraint.
//
// 20260812000100_plan_event_version_text.sql is the forward correction. This file
// proves it three ways, all against real Postgres and never a simulation:
//
//   1. THE FINAL SCHEMA of the runner's from-empty database — the column is text,
//      the integer-only constraint is gone, the presence constraint is there, and
//      the plan-SET counter is untouched;
//   2. THE ROUND TRIP — a token crosses Sheets → row contract → INSERT as the real
//      atlas_app role → SELECT → comparison, unmutated;
//   3. THE STAGED REPLAY — a scratch database takes the historical migrations
//      first, carries an integer row, then takes the forward migration, and the
//      row becomes its exact text (1 → '1') rather than a new token.
//
// Plus the mutation bites: restore the integer column and the token is refused
// again.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { withOwner, withRole, resetSchema, expectRejected, seedSession, SQLSTATE } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const contract = require('../services/migrationRowContract');
const { sessionPlansColumns } = require('../config/columns');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const FORWARD_FILE = '20260812000100_plan_event_version_text.sql';

const SESSION = '20260808-AM-01';
const TOKEN = 'pv_12345678-abcd';

test.beforeEach(async () => { await resetSchema(); });

/* ══════════ 1. THE FINAL SCHEMA ══════════ */

async function columnType(client, table, column) {
  const { rows } = await client.query(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'atlas' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows[0] || null;
}

test('the from-empty replay ends with a TEXT plan-event version and an INTEGER plan-set version', async () => {
  await withOwner(async (client) => {
    const event = await columnType(client, 'session_plan_events', 'plan_version');
    assert.equal(event.data_type, 'text', 'the opaque token needs its own type');
    assert.equal(event.is_nullable, 'NO', 'and NOT NULL must survive the type change');

    const set = await columnType(client, 'session_plan_set_recommendations', 'plan_version');
    assert.equal(set.data_type, 'integer',
      'the set-revision counter is a different dimension and must NOT have moved');
    assert.equal(set.is_nullable, 'NO');
  });
});

test('the obsolete integer-only constraint is GONE and the presence constraint is THERE', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'atlas.session_plan_events'::regclass AND contype = 'c'
        ORDER BY conname`
    );
    const names = rows.map((r) => r.conname);
    assert.ok(!names.includes('session_plan_events_version_check'),
      'an integer-only invariant on a text column is dead weight and must be dropped');
    assert.ok(names.includes('session_plan_events_version_present_check'),
      'the presence invariant carries forward: the builders and the reader both require a version');
    // The three owner-frozen vocabularies are untouched by this repair.
    for (const kept of ['session_plan_events_event_type_check', 'session_plan_events_outcome_check',
      'session_plan_events_closeout_status_check']) {
      assert.ok(names.includes(kept), `${kept} must survive the type change`);
    }
  });
});

test('the fold index, the closeout index, the key and the session FK all survive the type change', async () => {
  await withOwner(async (client) => {
    const indexes = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'atlas' AND tablename = 'session_plan_events' ORDER BY indexname`
    );
    const byName = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));
    assert.ok(byName.session_plan_events_fold_idx, 'the reader folds on (session_id, plan_version, plan_item_id)');
    assert.match(byName.session_plan_events_fold_idx, /plan_version/);
    assert.ok(byName.session_plan_events_closeout_idx, 'the export queue joins on the closeout partial index');
    assert.ok(byName.session_plan_events_pkey, 'idempotency_key is still the primary key');

    // Every index is VALID — a rebuilt index left invalid would silently stop
    // serving the fold.
    const invalid = await client.query(
      `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'atlas.session_plan_events'::regclass AND NOT i.indisvalid`
    );
    assert.equal(invalid.rowCount, 0);

    const fk = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'atlas.session_plan_events'::regclass AND contype = 'f'`
    );
    assert.equal(fk.rowCount, 1, 'the workout_sessions parent reference is still enforced');
  });
});

test('the runtime role keeps exactly the grants it had on the altered table', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT has_table_privilege('atlas_app', 'atlas.session_plan_events', 'SELECT') AS s,
              has_table_privilege('atlas_app', 'atlas.session_plan_events', 'INSERT') AS i,
              has_table_privilege('atlas_app', 'atlas.session_plan_events', 'UPDATE') AS u,
              has_table_privilege('atlas_app', 'atlas.session_plan_events', 'DELETE') AS d`
    );
    assert.deepEqual(rows[0], { s: true, i: true, u: false, d: false },
      'append-only for the runtime, exactly as before the repair');
  });
});

/* ══════════ 2. THE ROUND TRIP ══════════ */

function planEventCells(planVersion, { key = 'ff00aa11bb22cc33', eventType = 'plan_accepted' } = {}) {
  const byColumn = {
    idempotency_key: key,
    session_id: SESSION,
    session_date: '2026-08-08',
    plan_version: planVersion,
    event_type: eventType,
    plan_item_id: 'pi_9f8e7d',
    planned_order: 1,
    planned_lift_code: 'SQ01',
    movement_pattern: 'squat',
    outcome: 'planned',
    performed_lift_code: '',
    closeout_status: '',
    recorded_at: '2026-08-08T10:00:00.000Z',
  };
  return sessionPlansColumns.map((column) => byColumn[column]);
}

test('P3: an opaque token crosses Sheets → contract → Postgres → comparison unmutated', async () => {
  const cells = planEventCells(TOKEN);

  // The REAL shadow path, as the real atlas_app role: it applies the row contract
  // itself, so nothing here can canonicalise the token differently from production.
  const written = await adapter.shadowPlanEvents([cells]);
  assert.deepEqual(written, { inserted: 1, existing: 0 });

  // Straight from the database, before any contract touches it.
  await withOwner(async (client) => {
    const { rows } = await client.query(
      'SELECT plan_version FROM atlas.session_plan_events WHERE idempotency_key = $1',
      ['ff00aa11bb22cc33']
    );
    assert.equal(rows[0].plan_version, TOKEN, 'stored byte-for-byte, not numbered and not NULL');
  });

  // And back through the contract, which is what reconciliation compares on.
  const stored = await adapter.listConcept('session_plan_events');
  const fromSupabase = contract.rowFromSupabase('session_plan_events', stored[0]);
  const fromSheet = contract.rowFromSheet('session_plan_events', cells);
  assert.equal(fromSupabase.plan_version, TOKEN);
  const { equal, differences } = contract.compareRows('session_plan_events', fromSheet, fromSupabase);
  assert.equal(equal, true, JSON.stringify(differences));
});

test('P3: the retry collapses on the same token — the idempotency contract is unchanged', async () => {
  await adapter.shadowPlanEvents([planEventCells(TOKEN)]);
  const retry = await adapter.shadowPlanEvents([planEventCells(TOKEN)]);
  assert.deepEqual(retry, { inserted: 0, existing: 1 });
});

test('a BLANK version is refused by the presence constraint, and NULL by NOT NULL', async () => {
  const INSERT = `
    INSERT INTO atlas.session_plan_events
      (idempotency_key, session_id, session_date, plan_version, event_type, plan_item_id,
       outcome, closeout_status)
    VALUES ($1, $2, '2026-08-08', $3, 'plan_accepted', 'item-1', 'planned', '')`;

  await withOwner(async (client) => {
    const sessionId = await seedSession(client, SESSION);
    await expectRejected(client, INSERT, ['k-blank', sessionId, ''],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client, INSERT, ['k-space', sessionId, '   '],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client, INSERT, ['k-null', sessionId, null],
      { sqlstate: SQLSTATE.NOT_NULL_VIOLATION });
  });
});

test('the DATABASE does not narrow the token beyond what Atlas owns', async () => {
  // No `^pv_` rule: the historical integer rows the forward migration converts are
  // legitimate history, and the prefix contract belongs to routes/sessionPlans.js.
  await withOwner(async (client) => {
    const sessionId = await seedSession(client, SESSION);
    await client.query(
      `INSERT INTO atlas.session_plan_events
         (idempotency_key, session_id, plan_version, event_type, plan_item_id, outcome, closeout_status)
       VALUES ('k-legacy', $1, '1', 'plan_accepted', 'item-1', 'planned', '')`,
      [sessionId]
    );
    const { rows } = await client.query(
      `SELECT plan_version FROM atlas.session_plan_events WHERE idempotency_key = 'k-legacy'`
    );
    assert.equal(rows[0].plan_version, '1');
  });
});

test('the runtime role can read the token back through its own least-privileged connection', async () => {
  await adapter.shadowPlanEvents([planEventCells(TOKEN)]);
  await withRole('atlas_app', async (client) => {
    const { rows } = await client.query('SELECT plan_version FROM atlas.session_plan_events');
    assert.equal(rows[0].plan_version, TOKEN);
  });
});

/* ══════════ 3. THE STAGED REPLAY ══════════ */
//
// The runner's database already has every migration applied, so it cannot show the
// CONVERSION — only the destination. This builds a scratch database that stops at
// the historical schema, plants a row there, and then takes the forward migration.
// Same pattern as test-pg/writeFreezePreexisting.pgproof.js, and for the same
// reason: a migration that changes existing rows must be run over existing rows.

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Run this through \`npm run test:pg\`, which creates the disposable ` +
        'server, the applier and the four scoped roles. A skipped proof is a false green.'
    );
  }
  return value;
}

function onDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withConnection(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function adminQuery(sql) {
  return withConnection(requireEnv('ATLAS_PG_ADMIN_URL'), (client) => client.query(sql));
}

const readMigration = (file) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

// One transaction per file, exactly as scripts/apply-supabase-migrations.js does.
async function applyFile(client, sql, label) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    err.message = `${label}: ${err.message}`;
    throw err;
  }
}

// Every migration that precedes the forward correction, in the lexical order the
// applier uses. Derived from the directory rather than listed here, so a migration
// added later cannot silently fall out of the replay.
function priorMigrations() {
  const files = fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  const index = files.indexOf(FORWARD_FILE);
  assert.ok(index >= 0, `${FORWARD_FILE} must exist in supabase/migrations/`);
  assert.equal(index, files.length - 1, 'the forward correction must be the LAST migration in replay order');
  return files.slice(0, index);
}

let created = [];

// The one teardown: the adapter's pools, and every scratch database this file
// created. Both must run whatever happened, or the next run inherits state.
test.after(async () => {
  await adapter.close();
  for (const name of created) {
    try {
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (err) {
      console.error(`[plan-version] could not drop ${name}: ${err.message}`);
    }
  }
  created = [];
});

// TWO PRINCIPALS, EACH DOING WHAT IT DOES IN PRODUCTION. `applier` is the
// NOSUPERUSER CREATEROLE role that mirrors Supabase's `postgres` — it applies
// migrations, and it is the principal the owner gate uses. `atlas_app` is the
// runtime, and it is what writes plan events. Proving the conversion as a
// superuser, or writing rows as the schema owner, would prove a system Atlas does
// not run.
async function buildHistoricalDatabase() {
  const name = `atlas_pv_replay_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const applier = requireEnv('ATLAS_PG_PROOF_URL_APPLIER');
  const applierRole = new URL(applier).username;

  await adminQuery(`CREATE DATABASE "${name}" OWNER "${applierRole}"`);
  created.push(name);

  const urls = {
    applier: onDatabase(applier, name),
    atlas_app: onDatabase(requireEnv('ATLAS_PG_PROOF_URL_ATLAS_APP'), name),
  };

  await withConnection(urls.applier, async (client) => {
    for (const file of priorMigrations()) await applyFile(client, readMigration(file), file);
  });

  // The session parent every plan event references, written by the runtime role
  // exactly as the shadow write writes it.
  await withConnection(urls.atlas_app, (client) => client.query(
    `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
     VALUES ($1, '2026-08-08', 'AM', 1)`, [SESSION]
  ));

  return { name, urls };
}

const INSERT_EVENT = `
  INSERT INTO atlas.session_plan_events
    (idempotency_key, session_id, plan_version, event_type, plan_item_id, outcome, closeout_status)
  VALUES ($1, $2, $3, 'plan_accepted', $4, 'planned', '')`;

async function planVersionType(url) {
  return withConnection(url, async (client) => {
    const { rows } = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'atlas' AND table_name = 'session_plan_events' AND column_name = 'plan_version'`
    );
    return rows[0].data_type;
  });
}

test('the historical schema really did declare the plan-event version an INTEGER', async () => {
  const { urls } = await buildHistoricalDatabase();
  assert.equal(await planVersionType(urls.applier), 'integer',
    'the applied history is what it is — this proof would be meaningless if it were already text');

  // And it therefore REFUSES the authoritative token, for the runtime that would
  // have written it. This is the production defect, reproduced rather than described.
  await withConnection(urls.atlas_app, async (client) => {
    await assert.rejects(
      () => client.query(INSERT_EVENT, ['k-token', SESSION, TOKEN, 'item-1']),
      (err) => err.code === '22P02',
      'an integer column cannot hold pv_… — the 55 production plan events had nowhere to go'
    );
  });
});

test('F: the forward migration converts a historical integer row to its EXACT text', async () => {
  const { urls } = await buildHistoricalDatabase();

  // Rows created UNDER the historical integer schema, as integers, by the runtime.
  await withConnection(urls.atlas_app, async (client) => {
    await client.query(INSERT_EVENT, ['k-v1', SESSION, 1, 'item-1']);
    await client.query(INSERT_EVENT, ['k-v12', SESSION, 12, 'item-2']);
  });

  // The forward migration, applied by the principal the owner gate uses.
  await withConnection(urls.applier, (client) => applyFile(client, readMigration(FORWARD_FILE), FORWARD_FILE));
  assert.equal(await planVersionType(urls.applier), 'text');

  await withConnection(urls.atlas_app, async (client) => {
    const { rows } = await client.query(
      'SELECT idempotency_key, plan_version FROM atlas.session_plan_events ORDER BY idempotency_key'
    );
    assert.deepEqual(rows, [
      { idempotency_key: 'k-v1', plan_version: '1' },
      { idempotency_key: 'k-v12', plan_version: '12' },
    ], '1 → "1" and 12 → "12" — the exact textual representation, never a generated token');

    // And the corrected column now accepts what the source actually holds.
    await client.query(INSERT_EVENT, ['k-token', SESSION, TOKEN, 'item-3']);
    const stored = await client.query(
      `SELECT plan_version FROM atlas.session_plan_events WHERE idempotency_key = 'k-token'`
    );
    assert.equal(stored.rows[0].plan_version, TOKEN);
  });
});

test('MUTATION: without the type change, the token is refused again', async () => {
  // The bite. Keep the constraint drop, remove the ALTER COLUMN TYPE, and the
  // migration no longer fixes anything — which is what proves the conversion, and
  // not some incidental statement, is doing the work.
  const { urls } = await buildHistoricalDatabase();
  const original = readMigration(FORWARD_FILE);
  // Whitespace-tolerant, so a checkout's line endings cannot silently turn this
  // bite into a no-op that "passes".
  const withoutTypeChange = original.replace(
    /ALTER TABLE atlas\.session_plan_events\s+ALTER COLUMN plan_version TYPE text\s+USING plan_version::text;/, ''
  );
  assert.notEqual(withoutTypeChange, original, 'the type change must be found in order to be mutated away');
  // The presence CHECK is written for text and cannot compile against an integer
  // column, so it goes with it; what remains is the constraint drop alone.
  const mutated = withoutTypeChange.replace(
    /ALTER TABLE atlas\.session_plan_events\s+ADD CONSTRAINT session_plan_events_version_present_check\s+CHECK \(btrim\(plan_version\) <> ''\);/, ''
  );
  assert.notEqual(mutated, withoutTypeChange, 'the presence constraint must be found too');
  assert.ok(!/ALTER COLUMN plan_version TYPE text/.test(mutated));

  await withConnection(urls.applier, (client) => applyFile(client, mutated, `${FORWARD_FILE} (mutated)`));
  assert.equal(await planVersionType(urls.applier), 'integer');

  await withConnection(urls.atlas_app, async (client) => {
    await assert.rejects(
      () => client.query(INSERT_EVENT, ['k-token', SESSION, TOKEN, 'item-1']),
      (err) => err.code === '22P02',
      'dropping the constraint alone leaves the wrong TYPE, and the token still has nowhere to go'
    );
  });
});

test('the forward migration REFUSES a database whose historical constraint is missing', async () => {
  // Strict by design: `DROP CONSTRAINT` without IF EXISTS. A destination that does
  // not carry the invariant this repair was written against is drift, and the file
  // must refuse and change nothing rather than proceed over an unknown shape.
  const { urls } = await buildHistoricalDatabase();
  await withConnection(urls.applier, async (client) => {
    await client.query('ALTER TABLE atlas.session_plan_events DROP CONSTRAINT session_plan_events_version_check');

    let error = null;
    try {
      await applyFile(client, readMigration(FORWARD_FILE), FORWARD_FILE);
    } catch (err) {
      error = err;
    }
    assert.ok(error, 'the forward migration must refuse a drifted destination');
    assert.equal(error.code, '42704');

    const type = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'atlas' AND table_name = 'session_plan_events' AND column_name = 'plan_version'`
    );
    assert.equal(type.rows[0].data_type, 'integer',
      'and the whole file rolls back — a refused migration converts nothing');
  });
});
