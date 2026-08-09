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
const { withOwner, withRole, resetSchema, connect, roleUrl } = require('./support/db');
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

test('P8b mechanism: proveSessionLock ITSELF returns heldLater=false when the lock is gone', async () => {
  // *Required review of `bb7045e`, P1.* The previous version of this test
  // hand-rolled the pg_locks predicate and asserted it saw nothing. That proved
  // the SQL could observe a released lock; it did NOT prove the exported
  // mechanism the production checkpoint actually calls can return
  // { acquired: true, heldLater: false }. The claim was stronger than the test.
  //
  // So the REAL function runs against the REAL database, and the release is
  // INTERPOSED between its acquire and its later-held check. Nothing is faked:
  // every statement below reaches Postgres on the same real session. The
  // interposer only adds one genuine pg_advisory_unlock at the moment Supavisor
  // transaction mode would have moved the work to a different backend.
  const client = await connect(roleUrl('atlas_app'));
  try {
    const key = 'atlas-p8b-atlas_app';
    let released = false;
    const realQuery = client.query.bind(client);
    client.query = async (...args) => {
      const result = await realQuery(...args);
      const text = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
      if (!released && /pg_try_advisory_lock/.test(text)) {
        released = true;
        await realQuery('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
      return result;
    };

    const proof = await proveSessionLock(client, key);
    assert.equal(released, true, 'the interposer must actually have fired');
    assert.equal(proof.acquired, true, 'the acquire itself succeeded');
    assert.equal(
      proof.heldLater, false,
      'THE MECHANISM must report a vanished lock. This is the transaction-mode symptom, ' +
      'and if proveSessionLock cannot report it, P8b passes on a deployment whose export holds nothing.'
    );
  } finally {
    await client.end();
  }
});

test('P8b mechanism: MUTATION — a re-acquire implementation would report the vanished lock as HELD', async () => {
  // The bite. Advisory locks are RE-ENTRANT within a session, so the obvious
  // wrong implementation — "check by taking it again" — returns true in exactly
  // the state the real one must call false. Running both against the same real
  // released state shows the proof above discriminates between a correct and a
  // broken mechanism, rather than merely passing.
  const client = await connect(roleUrl('atlas_app'));
  try {
    const key = 'atlas-p8b-atlas_app';
    await client.query('SELECT pg_try_advisory_lock(hashtext($1))', [key]);
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);

    // The broken check: re-acquire and call that "still held".
    const naive = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
    assert.equal(naive.rows[0].ok, true, 're-acquiring always succeeds — which is why it proves nothing');
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);

    // The real check, same session, same released state.
    const { rows } = await client.query(
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)
          AND objid   =  (hashtext($1)::bigint        & 4294967295)`,
      [key]
    );
    assert.equal(rows[0].n, 0, 'the shipped predicate reports the truth where the naive one lies');
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

// ── The grant check: visibility-independent, and exact in BOTH directions ─────
//
// *Advisory review of `0668162`, P1.* The first version read
// information_schema.column_privileges as atlas_readonly. That view exposes only
// grants involving CURRENTLY ENABLED roles, and atlas_readonly has no membership
// in atlas_app — so it returned zero rows, every required column read as missing,
// and the checkpoint would have reported FAIL on a perfectly applied schema. The
// owner gate could never have been discharged.

const APP_UPDATE_QUERY = `
  SELECT c.column_name,
         has_column_privilege('atlas_app', 'atlas.write_receipts', c.column_name, 'UPDATE') AS granted
    FROM information_schema.columns c
   WHERE c.table_schema = 'atlas' AND c.table_name = 'write_receipts'
   ORDER BY c.column_name`;

const { APP_UPDATABLE_COLUMNS } = require('../scripts/atlas-p8b-checkpoint');

test('P8b grants: the OLD approach really was blind — information_schema shows atlas_readonly nothing', async () => {
  // The defect, pinned. If someone reverts to the view, this fails loudly rather
  // than the gate quietly going permanently red.
  await withRole('atlas_readonly', async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n
         FROM information_schema.column_privileges
        WHERE grantee = 'atlas_app' AND privilege_type = 'UPDATE'
          AND table_schema = 'atlas' AND table_name = 'write_receipts'`
    );
    assert.equal(rows[0].n, 0, 'the view is role-visibility scoped — this is why the check was rewritten');
  });
});

test('P8b grants: has_column_privilege sees the real grant set from atlas_readonly', async () => {
  await withRole('atlas_readonly', async (client) => {
    const { rows } = await client.query(APP_UPDATE_QUERY);
    assert.ok(rows.length > 0, 'the columns must be enumerable');
    const granted = rows.filter((r) => r.granted === true).map((r) => r.column_name).sort();
    // The real applied schema must match the declared set EXACTLY.
    assert.deepEqual(granted, [...APP_UPDATABLE_COLUMNS].sort());
  });
});

test('P8b grants: route and effect_authority are NOT updatable, read the same way', async () => {
  await withRole('atlas_readonly', async (client) => {
    const { rows } = await client.query(APP_UPDATE_QUERY);
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.granted]));
    assert.equal(byName.route, false, 'relabelling a route would defeat the write_id binding');
    assert.equal(byName.effect_authority, false, 'relabelling the authority would unlock automatic retry');
  });
});

test('P8b grants: an EXTRA grant is DETECTED — the check is exact, not just a subset test', async () => {
  // *Advisory review of `0668162`, third P1.* The old check tested only "nothing
  // missing" plus two named forbidden columns, so an accidental grant on any
  // other column passed. write_id is the sharpest case: updatable receipt
  // IDENTITY, reported as "exactly the declared set".
  await withOwner(async (client) => {
    await client.query('GRANT UPDATE (write_id) ON atlas.write_receipts TO atlas_app');
  });
  try {
    await withRole('atlas_readonly', async (client) => {
      const { rows } = await client.query(APP_UPDATE_QUERY);
      const granted = rows.filter((r) => r.granted === true).map((r) => r.column_name).sort();
      const extra = granted.filter((c) => !APP_UPDATABLE_COLUMNS.includes(c));
      assert.deepEqual(extra, ['write_id'], 'an undeclared grant must be visible to the checkpoint');
    });
  } finally {
    await withOwner(async (client) => {
      await client.query('REVOKE UPDATE (write_id) ON atlas.write_receipts FROM atlas_app');
    });
  }
});

test('P8b grants: a REVOKED required grant is DETECTED', async () => {
  await withOwner(async (client) => {
    await client.query('REVOKE UPDATE (status) ON atlas.write_receipts FROM atlas_app');
  });
  try {
    await withRole('atlas_readonly', async (client) => {
      const { rows } = await client.query(APP_UPDATE_QUERY);
      const granted = rows.filter((r) => r.granted === true).map((r) => r.column_name);
      assert.ok(!granted.includes('status'), 'a lost grant must be visible');
      const missing = APP_UPDATABLE_COLUMNS.filter((c) => !granted.includes(c));
      assert.deepEqual(missing, ['status']);
    });
  } finally {
    await withOwner(async (client) => {
      await client.query('GRANT UPDATE (status) ON atlas.write_receipts TO atlas_app');
    });
  }
});
