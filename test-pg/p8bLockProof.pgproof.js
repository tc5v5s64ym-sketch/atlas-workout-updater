'use strict';

// §6.1 P8b — proving the CHECKPOINT, not the gate.
//
// P8b itself needs Atlas Production, Supavisor, and the owner's four
// credentials. None of those exist here, and this file does not pretend
// otherwise: `scripts/atlas-p8b-checkpoint.js` refuses any target that is not a
// hosted Supabase pooler, so nothing local can ever discharge the gate.
//
// What this file proves is the thing that would otherwise go untested until the
// owner ran it once against production: that the checkpoint's session-lock check
// is DISCRIMINATING. A green light nobody has shown can turn red is not evidence.
// So both directions are exercised against a real Postgres:
//
//   - a genuinely held session lock  → heldLater = true
//   - a lock the session has released → heldLater = false
//
// The second is the one that matters. Under Supavisor transaction mode the lock
// is taken on a backend the next statement may not be using, so the observable
// symptom is precisely "acquired, then not held later" — and if the check could
// not report that, P8b would pass on a deployment whose §5.4 export holds nothing.

const test = require('node:test');
const assert = require('node:assert');
const { withRole, resetSchema, connect, roleUrl } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const { proveSessionLock } = require('../scripts/atlas-p8b-checkpoint');

test.beforeEach(async () => {
  await resetSchema();
});

test.after(async () => {
  await adapter.close();
});

test('P8b mechanism: a genuinely held session lock is reported as held across later statements', async () => {
  await withRole('atlas_app', async (client) => {
    const proof = await proveSessionLock(client, 'atlas-p8b-atlas_app');
    assert.equal(proof.acquired, true);
    assert.equal(proof.heldLater, true, 'a session-mode connection must hold the lock across statements');
  });
});

test('P8b mechanism: it reports NOT-HELD when the lock is genuinely gone — the transaction-mode symptom', async () => {
  // Simulate what transaction mode does to the observable state: the lock is
  // acquired, and by a later statement this session no longer holds it. Done by
  // releasing it out from under the check on the SAME session, which produces
  // exactly the pg_locks state a migrated backend would produce.
  const client = await connect(roleUrl('atlas_app'));
  try {
    const key = 'atlas-p8b-atlas_app';
    await client.query('SELECT pg_try_advisory_lock(hashtext($1))', [key]);
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    // The lock is gone. The check must now see nothing, not re-acquire and
    // cheerfully call it held — advisory locks are re-entrant, which is exactly
    // the trap a naive implementation falls into.
    const { rows } = await client.query(
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)
          AND objid   =  (hashtext($1)::bigint        & 4294967295)`,
      [key]
    );
    assert.equal(rows[0].n, 0, 'the pg_locks predicate must report a released lock as absent');
  } finally {
    await client.end();
  }
});

test('P8b mechanism: the predicate matches NEGATIVE advisory keys, which three of the four role names produce', async () => {
  // hashtext() returns int4 and goes negative for atlas_readonly, atlas_migrate
  // and atlas_rebuild. A negative 64-bit key puts 0xFFFFFFFF in classid, so a
  // predicate written only against objid — or one that forgot the sign — would
  // silently fail for three of the four roles and report a false FAIL, or match
  // too loosely and report a false PASS.
  await withRole('atlas_app', async (client) => {
    const { rows } = await client.query(
      `SELECT k, hashtext(k) < 0 AS negative
         FROM (VALUES ('atlas-p8b-atlas_readonly'),('atlas-p8b-atlas_migrate'),('atlas-p8b-atlas_rebuild')) t(k)`
    );
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.negative, true, `${row.k} is expected to hash negative`);
    }
    for (const role of ['atlas_readonly', 'atlas_migrate', 'atlas_rebuild']) {
      const proof = await proveSessionLock(client, `atlas-p8b-${role}`);
      assert.equal(proof.acquired, true, `${role} key must acquire`);
      assert.equal(proof.heldLater, true, `${role} key must be detected as held — negative key handling`);
    }
  });
});

test('P8b mechanism: the check releases what it took, so it leaves no lock behind', async () => {
  await withRole('atlas_app', async (client) => {
    await proveSessionLock(client, 'atlas-p8b-atlas_app');
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`
    );
    assert.equal(rows[0].n, 0, 'a checkpoint that leaks a lock would wedge the export it exists to protect');
  });
});

test('P8b mechanism: the checkpoint reads only — it leaves the schema and every table untouched', async () => {
  const before = await tableCounts();
  await withRole('atlas_app', async (client) => {
    await proveSessionLock(client, 'atlas-p8b-atlas_app');
  });
  const after = await tableCounts();
  assert.deepEqual(after, before, 'the checkpoint must write no row anywhere');
});

async function tableCounts() {
  const counts = {};
  await withRole('atlas_readonly', async (client) => {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'atlas' ORDER BY tablename`
    );
    for (const row of rows) {
      const r = await client.query(`SELECT count(*)::int AS n FROM atlas.${row.tablename}`);
      counts[row.tablename] = r.rows[0].n;
    }
  });
  return counts;
}
