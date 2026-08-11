'use strict';

// §6.2 P8a, P8, P9, P11 — atlas.write_freeze, against the REAL from-empty database.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.10, §5.3, §8.2.
// OWNER RULING D7 — APPROVED 2026-08-09: permanent, no sunset.
//
// P8a is explicit that this may not be inherited from S2: "A grant written in S2
// proves nothing about a table that does not exist until S3." So the constraint,
// the seed and the grants are proven HERE, executed AS THE REAL ROLES against the
// schema the S3 migration actually created.
//
// P8 and P9 are proven with a REAL SEPARATE SERVER PROCESS (support/freezeServer.js),
// because "an activation demonstrated only across a restart proves the opposite of
// what §5.5 step 1 needs".

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const { withOwner, withRole, withApplier, expectRejected, SQLSTATE } = require('./support/db');
const adapter = require('../services/supabaseAdapter');

const CHILD = path.join(__dirname, 'support', 'freezeServer.js');
const API_KEY = 'pg-proof-api-key';

// Restore the DORMANT seed after every test. write_freeze is deliberately NOT in
// the harness's TRUNCATE list: its row is migration-seeded state, not test data,
// and truncating it would delete the very seed P8a proves exists.
async function setFreeze(frozen, reason = 'pg proof') {
  await withOwner(async (client) => {
    await client.query(
      'UPDATE atlas.write_freeze SET frozen = $1, reason = $2, set_by = $3, set_at = now() WHERE id',
      [frozen, reason, 'pg-proof']
    );
  });
}
test.afterEach(async () => { await setFreeze(false, 'dormant — restored by the proof harness'); });
test.after(async () => { await adapter.close(); });

/* ══════════ P8a — schema, constraint, seed and grants, as the real role ══════════ */

test('P8a: the S3 migration created atlas.write_freeze with the §3.10 shape', async () => {
  await withOwner(async (client) => {
    const columns = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'atlas' AND table_name = 'write_freeze'
        ORDER BY ordinal_position`
    );
    assert.deepEqual(
      columns.rows.map((r) => r.column_name),
      ['id', 'frozen', 'reason', 'set_by', 'set_at'],
      'ONE control with ONE meaning — no name column, no per-feature rows, no second controlled behaviour'
    );
    for (const row of columns.rows) {
      assert.equal(row.is_nullable, 'NO', `${row.column_name} must be NOT NULL — a null is not a control state`);
    }
  });
});

test('P8a: the seeded row is present, single, and DORMANT', async () => {
  await withOwner(async (client) => {
    const rows = await client.query('SELECT id, frozen, reason, set_by FROM atlas.write_freeze');
    assert.equal(rows.rowCount, 1, 'exactly one row');
    assert.equal(rows.rows[0].id, true);
    assert.equal(rows.rows[0].frozen, false, 'S3 ships the control DORMANT — applying the migration changes no behaviour');
    assert.ok(rows.rows[0].reason.length > 0);
    assert.ok(rows.rows[0].set_by.length > 0);
  });
});

test('P8a: a SECOND row is rejected — by the primary key and by the CHECK', async () => {
  await withOwner(async (client) => {
    // A second row claiming the same single-row key.
    await expectRejected(
      client,
      `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by) VALUES (true, true, 'second', 'attacker')`,
      [], { sqlstate: SQLSTATE.UNIQUE_VIOLATION }
    );
    // And the only other value the boolean key could take.
    await expectRejected(
      client,
      `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by) VALUES (false, true, 'second', 'attacker')`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION }
    );
    const rows = await client.query('SELECT count(*)::int AS n FROM atlas.write_freeze');
    assert.equal(rows.rows[0].n, 1, 'the table can hold exactly one row, which is the point');
  });
});

test('P8a: atlas_app CAN select the row — as the real role', async () => {
  await withRole('atlas_app', async (client) => {
    const rows = await client.query('SELECT id, frozen, reason, set_by, set_at FROM atlas.write_freeze');
    assert.equal(rows.rowCount, 1);
    assert.equal(typeof rows.rows[0].frozen, 'boolean');
  });
});

// ── ONE WINNER: EVERY SCOPED ROLE IS REFUSED, INCLUDING atlas_migrate ─────────
//
// *Added by the required Atlas Contract / Systems Review of `65310b3`, finding 1.*
//
// The migration used to transfer ownership to atlas_migrate, which handed it
// owner-equivalent INSERT/UPDATE/DELETE — a SECOND principal able to lift a
// freeze, which is exactly what D7 forbids. Ownership is no longer transferred,
// and the refusal is now asserted for ALL FOUR scoped roles rather than for the
// runtime alone. A grant list is a claim; these are the behaviours.
for (const role of ['atlas_app', 'atlas_migrate', 'atlas_readonly', 'atlas_rebuild']) {
  test(`P8a: ${role} is REFUSED insert, update and delete on the control — the absence IS the control`, async () => {
    await withRole(role, async (client) => {
      await expectRejected(
        client,
        `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by) VALUES (true, false, 'r', 's')`,
        [], { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
      );
      // THE ONE THAT MATTERS: lifting a freeze. If any scoped role can run this,
      // the control has two authorities and D7's "one winner" is not true.
      await expectRejected(
        client, 'UPDATE atlas.write_freeze SET frozen = false WHERE id', [],
        { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
      );
      await expectRejected(
        client, 'DELETE FROM atlas.write_freeze WHERE id', [],
        { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
      );
    });
  });

  // A SELF-GRANT CONFERS NOTHING — and PostgreSQL says so in two different ways,
  // which is why this asserts on the PRIVILEGE rather than on the statement.
  //
  // A grantor holding SOME privilege but no grant option (atlas_app,
  // atlas_readonly, atlas_rebuild all hold SELECT) gets a WARNING and the
  // statement SUCCEEDS. A grantor holding NONE at all (atlas_migrate) gets
  // ERROR 42501. Both were measured; an `expectRejected` passed for one group and
  // failed for the other, and would have passed VACUOUSLY the day a role actually
  // did hold the grant option. Only the outcome matters: no privilege, either way.
  test(`P8a: ${role} cannot grant itself the write it was refused`, async () => {
    await withRole(role, async (client) => {
      try {
        await client.query(`GRANT UPDATE ON atlas.write_freeze TO ${role}`);
      } catch (err) {
        assert.equal(err.code, SQLSTATE.INSUFFICIENT_PRIVILEGE,
          `the self-grant failed for an unexpected reason: ${err.code} ${err.message}`);
      }

      const { rows } = await client.query(
        `SELECT has_table_privilege($1, 'atlas.write_freeze', 'UPDATE') AS granted`, [role]
      );
      assert.equal(rows[0].granted, false, `${role} acquired UPDATE on the control by granting it to itself`);

      // And the behaviour, not just the catalogue.
      await expectRejected(client, 'UPDATE atlas.write_freeze SET frozen = false WHERE id', [],
        { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE });
    });
  });
}

// NO SCOPED ROLE HOLDS DDL ON THE CONTROL — including atlas_migrate.
//
// *Strengthened by the required review of `a29129e`, P1.* atlas_migrate used to be
// exempt from this loop, because S2 file 8 made it the OWNER OF SCHEMA `atlas` and
// a schema owner can drop a table it does not own. The S3 migration narrows that:
// the schema is owned by the project-owner/applier, and atlas_migrate holds exactly
// USAGE and CREATE. It is therefore in this loop now.
for (const role of ['atlas_app', 'atlas_migrate', 'atlas_readonly', 'atlas_rebuild']) {
  test(`P8a: ${role} cannot escalate — no DDL on the control either`, async () => {
    await withRole(role, async (client) => {
      // A role that could drop the primary key could insert a second row and make
      // every read ambiguous; a role that could drop the table could remove the
      // control outright; a role that could RENAME it could free the name and put
      // its own object there.
      await expectRejected(client, 'ALTER TABLE atlas.write_freeze DROP CONSTRAINT write_freeze_pkey', [],
        { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE });
      await expectRejected(client, 'DROP TABLE atlas.write_freeze', [],
        { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE });
      await expectRejected(client, 'ALTER TABLE atlas.write_freeze RENAME TO write_freeze_displaced', [],
        { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE });
    });
  });
}

test('P8a: the SCHEMA is owned by the project-owner path, and atlas_migrate holds only USAGE + CREATE', async () => {
  await withOwner(async (client) => {
    const owner = await client.query(
      `SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'atlas'`
    );
    assert.notEqual(owner.rows[0].owner, 'atlas_migrate',
      'schema ownership is replacement authority over every object in the namespace, including the control');

    // Exactly the two privileges a migration role needs, and no implicit everything.
    const priv = await client.query(
      `SELECT has_schema_privilege('atlas_migrate', 'atlas', 'USAGE')  AS usage,
              has_schema_privilege('atlas_migrate', 'atlas', 'CREATE') AS create_`
    );
    assert.equal(priv.rows[0].usage, true, 'it must still reach the objects it owns');
    assert.equal(priv.rows[0].create_, true, 'and still be able to add migration-owned objects');
  });
});

// ── THE REPLACEMENT BYPASS, DRIVEN END TO END ────────────────────────────────
//
// *Required review of `a29129e`, P1.* Refusing row DML on one table never proved
// the project owner was the sole authority over the write-admission DECISION. A
// schema owner does not need to write the row: it can DROP the table, CREATE a new
// one of the same name seeded `frozen = false`, GRANT SELECT to atlas_app, and the
// runtime then reads exactly one valid row saying writes are open.
//
// This drives that whole sequence as the real role, against a real frozen control,
// and asserts atlas_migrate cannot reach ANY replacement state the runtime accepts
// as open.
test('P1: atlas_migrate cannot REPLACE the control to forge an open state', async () => {
  // 1. The project owner freezes — as the NOSUPERUSER applier that mirrors
  //    Supabase's `postgres`, never as the container superuser.
  await withApplier((client) => client.query(
    `UPDATE atlas.write_freeze SET frozen = true, reason = $1, set_by = $2, set_at = now() WHERE id`,
    ['owner freeze — replacement bypass proof', 'project-owner-proof']
  ));

  // 2. The runtime observes it, through its own least-privileged connection.
  const observed = await adapter.readWriteFreeze();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].frozen, true, 'the control must genuinely be frozen before the attack');

  // 3–5. Every route to a forged open state, attempted as atlas_migrate.
  await withRole('atlas_migrate', async (client) => {
    const attempts = [
      ['drop the control', 'DROP TABLE atlas.write_freeze'],
      ['drop it with CASCADE', 'DROP TABLE atlas.write_freeze CASCADE'],
      ['rename it out of the way', 'ALTER TABLE atlas.write_freeze RENAME TO write_freeze_old'],
      ['move it to another schema', 'ALTER TABLE atlas.write_freeze SET SCHEMA public'],
      ['take ownership of it', 'ALTER TABLE atlas.write_freeze OWNER TO atlas_migrate'],
      ['drop the whole schema', 'DROP SCHEMA atlas CASCADE'],
      ['write the row directly', `UPDATE atlas.write_freeze SET frozen = false WHERE id`],
      ['delete the row so a fresh one can be seeded', 'DELETE FROM atlas.write_freeze WHERE id'],
      ['seed a second, open row', `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by)
                                   VALUES (true, false, 'forged', 'atlas_migrate')`],
    ];
    for (const [what, sql] of attempts) {
      await expectRejected(client, sql, [], { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE });
      // Each attempt is verified not to have happened, so a statement that
      // "failed" after a partial effect cannot pass unnoticed.
      const still = await withOwner((owner) => owner.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
      ));
      assert.equal(still.rows[0].n, 1, `the control disappeared after attempting to ${what}`);
    }

    // It cannot create a replacement under the occupied name either — and the
    // failure must be a DUPLICATE, proving the original is still standing rather
    // than the CREATE being refused for privilege reasons after a successful drop.
    const duplicate = await expectRejected(
      client,
      'CREATE TABLE atlas.write_freeze (id boolean PRIMARY KEY, frozen boolean NOT NULL)',
      []
    );
    assert.equal(duplicate.code, '42P07', 'the name is still occupied by the real control');
  });

  // 5 (concluded). The runtime STILL sees the owner's frozen control — no forged
  // open state was reachable by any of the routes above.
  const after = await adapter.readWriteFreeze();
  assert.equal(after.length, 1);
  assert.equal(after[0].frozen, true, 'atlas_migrate must not be able to produce an open state');
  assert.equal(after[0].set_by, 'project-owner-proof',
    'and the row is still the one the OWNER wrote, not a replacement');

  // 6. And the project-owner path can still lift the real control.
  await withApplier((client) => client.query(
    `UPDATE atlas.write_freeze SET frozen = false, reason = $1, set_by = $2, set_at = now() WHERE id`,
    ['owner lift — replacement bypass proof', 'project-owner-proof']
  ));
  const lifted = await adapter.readWriteFreeze();
  assert.equal(lifted[0].frozen, false);
});

// ── THE NARROWING DID NOT BREAK LEGITIMATE MIGRATION CAPABILITY ──────────────
//
// A bound that also disables ordinary migration DDL would be a different defect,
// so it is proven rather than hoped. Everything runs inside a rolled-back
// transaction; the schema is left exactly as it was found.
test('P1: atlas_migrate retains ordinary migration DDL on the objects it owns', async () => {
  await withRole('atlas_migrate', async (client) => {
    await client.query('BEGIN');
    try {
      // CREATE a new migration-owned object in the schema it no longer owns.
      await client.query('CREATE TABLE atlas.s3_proof_scratch (id int PRIMARY KEY, note text)');
      const owner = await client.query(
        `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 's3_proof_scratch'`
      );
      assert.equal(owner.rows[0].tableowner, 'atlas_migrate', 'the creator owns what it creates');

      // ALTER and DROP an object it legitimately owns.
      await client.query('ALTER TABLE atlas.s3_proof_scratch ADD COLUMN added_by_migration boolean');
      await client.query('DROP TABLE atlas.s3_proof_scratch');

      // And ALTER a pre-existing S2 table it owns — the capability the narrowing
      // could most plausibly have taken away.
      await client.query('ALTER TABLE atlas.logged_sets ADD COLUMN s3_proof_scratch_column int');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  // The rollback left nothing behind.
  await withOwner(async (client) => {
    const leftovers = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 's3_proof_scratch'`
    );
    assert.equal(leftovers.rows[0].n, 0);
    const column = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'atlas' AND table_name = 'logged_sets' AND column_name = 's3_proof_scratch_column'`
    );
    assert.equal(column.rows[0].n, 0);
  });
});

test('P8a: no scoped role OWNS the control — ownership is the mutation path, and it is the owner\'s', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    const owner = rows[0].tableowner;
    for (const role of ['atlas_app', 'atlas_migrate', 'atlas_readonly', 'atlas_rebuild']) {
      assert.notEqual(owner, role,
        `${role} owns atlas.write_freeze; an owner's implicit DML cannot be durably revoked, ` +
        'so that would be a second mutation authority over the one control D7 gives to the project owner');
    }
  });
});

test('P8a: THE PROJECT OWNER can set and lift the freeze — as a NOSUPERUSER role', async () => {
  // The other half of "one winner". Refusing everybody proves the control is
  // inert, not that it is controllable — and this runs as the applier, the
  // CREATEROLE NOSUPERUSER principal that mirrors Supabase's `postgres`, never as
  // the container superuser that would bypass the check being relied on.
  await withApplier(async (client) => {
    const set = await client.query(
      `UPDATE atlas.write_freeze SET frozen = true, reason = $1, set_by = $2, set_at = now() WHERE id`,
      ['owner freeze — §5.5 step 1', 'project-owner-proof']
    );
    assert.equal(set.rowCount, 1, 'the project owner must be able to FREEZE');
  });

  // The runtime sees it, through its own least-privileged connection.
  const frozen = await adapter.readWriteFreeze();
  assert.equal(frozen[0].frozen, true);
  assert.equal(frozen[0].set_by, 'project-owner-proof');

  await withApplier(async (client) => {
    const lift = await client.query(
      `UPDATE atlas.write_freeze SET frozen = false, reason = $1, set_by = $2, set_at = now() WHERE id`,
      ['owner lift — §5.5 step 8', 'project-owner-proof']
    );
    assert.equal(lift.rowCount, 1, 'and to LIFT it — a freeze nobody can lift is a permanent outage');
  });

  const lifted = await adapter.readWriteFreeze();
  assert.equal(lifted[0].frozen, false);
});

test('P8a: the adapter read returns exactly one valid row through the real pooled connection', async () => {
  const rows = await adapter.readWriteFreeze();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, true);
  assert.equal(typeof rows[0].frozen, 'boolean');
  assert.equal(typeof rows[0].reason, 'string');
  assert.equal(typeof rows[0].set_by, 'string');
});

/* ══════════ P8 / P9 / P11 — a real serving process ══════════ */

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ATLAS_API_KEY: API_KEY, ATLAS_SUPABASE_SHADOW_WRITE: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffered = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server child never became READY:\n${buffered}\n${stderr}`)), 45_000);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const match = /READY (\d+) (\d+) (\d+) (\S+)/.exec(buffered);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        child,
        baseUrl: `http://127.0.0.1:${match[1]}`,
        proofUrl: `http://127.0.0.1:${match[2]}`,
        pid: Number(match[3]),
        processId: match[4],
        stop: () => new Promise((done) => { child.once('exit', done); child.kill('SIGTERM'); }),
      });
    });
    child.on('error', reject);
  });
}

async function postNote(baseUrl, writeId, headers = {}) {
  const res = await fetch(`${baseUrl}/api/coaching-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': API_KEY, ...headers },
    body: JSON.stringify({ note: 'pg proof note', write_id: writeId }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// The child's own report of its identity and its Sheets mutations, read from the
// separate proof port (support/freezeServer.js explains why it is not a route).
async function identity(server) {
  const res = await fetch(server.proofUrl);
  return res.json();
}

test('P8: the freeze activates WITHOUT a restart, in the same live process', async () => {
  await setFreeze(false);
  const server = await startServer();
  try {
    const before = await identity(server);

    const open = await postNote(server.baseUrl, 'p8-before-activation');
    assert.equal(open.status, 200, `writes must be open first: ${JSON.stringify(open.body)}`);

    // The owner runs the UPDATE. No deploy, no restart, no signal to the process.
    await setFreeze(true, 'cutover window — §5.5 step 1');

    const refused = await postNote(server.baseUrl, 'p8-after-activation');
    assert.equal(refused.status, 503, 'the NEXT request of the SAME process must refuse');
    assert.equal(refused.body.details.error_code, 'writes_frozen');
    assert.equal(refused.body.details.freeze_reason, 'cutover window — §5.5 step 1');

    // PROVEN BY PROCESS START IDENTITY, not by behaviour alone. An activation
    // demonstrated across a restart would prove the opposite of what §5.5 step 1
    // needs — that the change requires a deploy.
    const after = await identity(server);
    assert.equal(after.pid, before.pid, 'same OS process');
    assert.equal(after.process_id, before.process_id, 'same process identity — it never restarted');
    assert.equal(after.process_id, server.processId);
    assert.equal(server.child.exitCode, null, 'and it is still the process that started');

    // NO SIDE EFFECT at the database level either: the frozen request appended
    // nothing to Sheets and wrote nothing to Supabase.
    assert.equal(after.sheet_calls.append, before.sheet_calls.append + 1,
      'exactly the one ADMITTED write appended — the refused one did not');
  } finally {
    await server.stop();
  }
});

test('P8: a receipt minted before activation is still decided by the same in-memory map afterwards', async () => {
  await setFreeze(false);
  const server = await startServer();
  try {
    const minted = await postNote(server.baseUrl, 'p8-receipt-survives-activation');
    assert.equal(minted.status, 200);

    await setFreeze(true, 'cutover window');

    // The seam reads the SAME live process's map. Its process_id must match the
    // one that served before the freeze — the freeze is not a loss event (P19c(a)).
    const res = await fetch(`${server.baseUrl}/api/migration/receipts/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-atlas-api-key': API_KEY },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.process_id, server.processId, 'the frozen process is the process that minted the receipt');
    assert.ok(
      body.data.records.some((r) => r.write_id === 'p8-receipt-survives-activation' && r.status === 'completed'),
      'the receipt minted before activation is still live in the map after it'
    );
  } finally {
    await server.stop();
  }
});

test('P9: a REPLACEMENT instance starts frozen — refused on its FIRST request', async () => {
  await setFreeze(true, 'frozen before this process existed');
  const server = await startServer();
  try {
    const first = await postNote(server.baseUrl, 'p9-first-request-ever');
    assert.equal(first.status, 503, 'there must be no window in which a new instance serves a frozen write');
    assert.equal(first.body.details.error_code, 'writes_frozen');

    const seen = await identity(server);
    assert.equal(seen.sheet_calls.append, 0, 'it appended nothing, ever');
  } finally {
    await server.stop();
  }
});

test('P11: deleting the row does NOT reopen writes — a missing row is frozen', async () => {
  await setFreeze(true, 'about to be deleted');
  const server = await startServer();
  try {
    assert.equal((await postNote(server.baseUrl, 'p11-before-delete')).status, 503);

    // The owner-only principal removes the control entirely. Losing the control
    // must never mean losing the refusal.
    await withOwner((client) => client.query('DELETE FROM atlas.write_freeze WHERE id'));
    try {
      const after = await postNote(server.baseUrl, 'p11-after-delete');
      assert.equal(after.status, 503, 'no row is frozen, not open');
      assert.equal(after.body.details.freeze_state, 'row_missing');
      assert.equal((await identity(server)).sheet_calls.append, 0);
    } finally {
      // Put the seed back for the rest of the suite.
      await withOwner((client) => client.query(
        `INSERT INTO atlas.write_freeze (id, frozen, reason, set_by)
         VALUES (true, false, 'restored by the proof harness', 'pg-proof')
         ON CONFLICT (id) DO NOTHING`
      ));
    }
  } finally {
    await server.stop();
  }
});

test('P11: killing the database session does NOT reopen writes', async () => {
  await setFreeze(true, 'connection about to drop');
  const server = await startServer();
  try {
    assert.equal((await postNote(server.baseUrl, 'p11-before-drop')).status, 503);

    // Terminate every backend the child holds. Its pooled connection is gone; the
    // next freeze read must fail, and a failed read is a refusal.
    await withOwner((client) => client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE usename = 'atlas_app' AND pid <> pg_backend_pid()`
    ));

    const after = await postNote(server.baseUrl, 'p11-after-drop');
    assert.equal(after.status, 503, 'a control it cannot read is a control that refuses');
    assert.equal((await identity(server)).sheet_calls.append, 0);
  } finally {
    await server.stop();
  }
});

test('P11: with the row OPEN again the same process writes normally — the refusal is not a wedge', async () => {
  await setFreeze(true, 'temporarily frozen');
  const server = await startServer();
  try {
    assert.equal((await postNote(server.baseUrl, 'p11-wedge-check-frozen')).status, 503);
    await setFreeze(false, 'lifted — §5.5 step 8');
    const lifted = await postNote(server.baseUrl, 'p11-wedge-check-open');
    assert.equal(lifted.status, 200, 'lifting the freeze must take effect on the next request too');
    assert.equal((await identity(server)).sheet_calls.append, 1);
  } finally {
    await server.stop();
  }
});
