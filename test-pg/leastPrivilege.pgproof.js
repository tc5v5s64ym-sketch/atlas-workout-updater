'use strict';

// §6.1 P7c — LEAST PRIVILEGE IS PROVEN, NOT CLAIMED.
//
// Every statement below executes AS ITS REAL ROLE against the from-empty
// database. A statement proven only as superuser proves nothing about the
// deployed system, and three grant/SQL mismatches have already reached review —
// which is why the statements under test are read from
// services/supabaseAdapter.js's exported SQL map rather than retyped here. If a
// grant and the statement it must permit ever drift apart, this suite fails.

const test = require('node:test');
const assert = require('node:assert');
const { withOwner, withRole, resetSchema, expectRejected, seedSession, SQLSTATE } = require('./support/db');
const { SQL } = require('../services/supabaseAdapter');

test.beforeEach(async () => {
  await resetSchema();
});

// ── The refusals ───────────────────────────────────────────────────────────────

test('P7c: atlas_app is refused DDL', async () => {
  await withRole('atlas_app', async (client) => {
    await expectRejected(client, 'CREATE TABLE atlas.sneaky (id int)', [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
    await expectRejected(client, 'DROP TABLE atlas.logged_sets', [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
    await expectRejected(client, 'ALTER TABLE atlas.logged_sets ADD COLUMN sneaky text', [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
    // The catalog swap uses DELETE inside a transaction rather than TRUNCATE
    // precisely so the runtime role needs no DDL privilege.
    await expectRejected(client, 'TRUNCATE atlas.logged_sets', [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
  });
});

test('P7c: atlas_app is refused DELETE on every table outside its grant list', async () => {
  // The list is exactly two: logged_sets (undo) and migration_divergences while it
  // exists.
  //
  // It was three. The §3.7 generation swap was the third, and the OWNER CORRECTION
  // 2026-08-13 removed it: Supabase owns the catalog, mutation is owner-controlled,
  // and the S4 catalog migration revokes atlas_app's INSERT and DELETE there. So
  // atlas.exercise_catalog moves from the permitted list to the REFUSED list below,
  // which is the grant-level statement of "the runtime cannot change the catalog".
  const refused = [
    'atlas.session_effort',
    'atlas.session_plan_events',
    'atlas.session_plan_set_recommendations',
    // A runtime role that could delete a receipt could erase duplicate protection.
    'atlas.write_receipts',
    'atlas.workout_sessions',
    'atlas.sheets_mirror_allocations',
    'atlas.sheets_mirror_cursor',
    'atlas.exercise_catalog',
  ];
  await withRole('atlas_app', async (client) => {
    for (const table of refused) {
      await expectRejected(client, `DELETE FROM ${table}`, [], {
        sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
      });
    }
  });
});

test('P7c: atlas_app may UPDATE only the declared columns — the immutable ones are refused', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await client.query(
      `INSERT INTO atlas.logged_sets (session_id, exercise, set_number, weight)
       VALUES ($1, 'Back Squat', 1, 225)`, [sessionId]
    );
    await client.query(
      `INSERT INTO atlas.session_plan_set_recommendations
         (idempotency_key, session_id, plan_version, plan_item_id, set_index,
          recommendation_source, confidence)
       VALUES ('k1', $1, 1, 'item-1', 1, 'accepted', 'reliable')`, [sessionId]
    );
  });
  await withRole('atlas_app', async (client) => {
    // logged_sets is append-only: NO row is ever updated. The grant list contains
    // no UPDATE on it at all.
    await expectRejected(client, `UPDATE atlas.logged_sets SET weight = 999`, [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
    // The ONE mutable column in the migrated workout schema is the closeout seal.
    await client.query(SQL.sealPlanSets, ['20260808-AM-01', 'w-seal-1']);
    // Row CONTENT is never updated; a revision appends a new row.
    await expectRejected(
      client,
      `UPDATE atlas.session_plan_set_recommendations SET target_weight = 999`,
      [], { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
    );
    // Session IDENTITY is insert-only; only the six export-state columns move.
    await expectRejected(
      client,
      `UPDATE atlas.workout_sessions SET session_date = '2026-01-01'`,
      [], { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
    );
  });
});

test('P7c: atlas_readonly holds SELECT and nothing else', async () => {
  await withOwner(async (client) => {
    await seedSession(client);
  });
  await withRole('atlas_readonly', async (client) => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    assert.equal(rows[0].n, 1);
    await expectRejected(
      client,
      `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
       VALUES ('20260809-AM-01', '2026-08-09', 'AM', 1)`,
      [], { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
    );
    await expectRejected(client, `DELETE FROM atlas.logged_sets`, [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
    await expectRejected(client, `UPDATE atlas.migration_divergences SET state = 'closed'`, [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
  });
});

test('P7c: atlas_rebuild CANNOT touch Supabase workout authority — the grant enforces it, not the procedure', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await client.query(
      `INSERT INTO atlas.logged_sets (session_id, exercise, set_number) VALUES ($1, 'Back Squat', 1)`,
      [sessionId]
    );
  });
  await withRole('atlas_rebuild', async (client) => {
    for (const table of [
      'atlas.logged_sets',
      'atlas.session_effort',
      'atlas.session_plan_events',
      'atlas.session_plan_set_recommendations',
      'atlas.write_receipts',
    ]) {
      await expectRejected(client, `DELETE FROM ${table}`, [], {
        sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
      });
    }
    await expectRejected(
      client,
      `INSERT INTO atlas.logged_sets (session_id, exercise, set_number) VALUES ('20260808-AM-01', 'X', 9)`,
      [], { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
    );
    // But it CAN reset the COMPLETE export-state tuple §5.7 step 5 resets. A
    // rebuild that may reset four of six columns is permission-denied on the
    // other two, which would be a recovery path no principal can execute.
    await client.query(
      `UPDATE atlas.workout_sessions
          SET sheets_export_state = 'queued', sheets_export_error = NULL,
              sheets_export_next_attempt_at = NULL, sheets_exported_at = NULL,
              sheets_export_attempts = 0, export_claim_token = NULL`
    );
    // It holds no INSERT on the cursor either — §5.7 reissues allocations and
    // moves the cursor forward; it never creates a tab's cursor row.
    await expectRejected(
      client,
      `INSERT INTO atlas.sheets_mirror_cursor (tab, next_row) VALUES ('Effort', 2)`,
      [], { sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE }
    );
  });
  await withOwner(async (client) => {
    await client.query(
      `INSERT INTO atlas.sheets_mirror_cursor (tab, next_row) VALUES ('Log_Cleaned', 2)
       ON CONFLICT (tab) DO NOTHING`
    );
  });
  await withRole('atlas_rebuild', async (client) => {
    // "Clear and reissue" — the whole of what §5.7 needs, and nothing more.
    await client.query(`UPDATE atlas.sheets_mirror_cursor SET next_row = 40, base_established_at = now()`);
    await client.query(
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Log_Cleaned', '20260808-AM-01', 2, 3)`
    );
    await client.query(`DELETE FROM atlas.sheets_mirror_allocations`);
  });
});

// ── The permits: every statement the design specifies, as its real role ────────

test('P7c: every adapter statement atlas_app must issue SUCCEEDS as atlas_app', async () => {
  await withOwner(async (client) => {
    await seedSession(client, '20260808-AM-01');
  });

  await withRole('atlas_app', async (client) => {
    // The session parent, and the three shadow inserts.
    await client.query(SQL.insertSessionParent, ['20260808-PM-01', '2026-08-08', 'PM', 1]);
    await client.query(SQL.insertLoggedSet, [
      '20260808-PM-01', '2026-08-08', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', 1, 225, 5, 2, '', 1125,
    ]);
    await client.query(SQL.insertSessionEffort, [
      '20260808-PM-01', '2026-08-08', '01:02:00', 400, 600, 130, 165, 'Gym', '',
    ]);
    await client.query(SQL.insertPlanEvent, [
      'ev-1', '20260808-PM-01', '2026-08-08', 1, 'plan_accepted', 'item-1', 1, 'SQ01', 'squat', 'planned', '', '',
      new Date().toISOString(),
    ]);
    await client.query(SQL.insertPlanSetRow, [
      'ls-1', '20260808-PM-01', '2026-08-08', 1, 'item-1', 'SQ01', 1, 3, 225, 5, 2,
      'accepted', null, 'reliable', null, new Date().toISOString(),
    ]);

    // The one permitted update on the migrated workout schema.
    await client.query(SQL.sealPlanSets, ['20260808-PM-01', 'w-1']);

    // The whole receipt state machine, including the advisory lock.
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', ['w-1']);
    assert.equal(lock.rows[0].acquired, true);
    const claim = await client.query(SQL.claimWriteReceipt, ['w-1', '/api/log-workout', 'proof-instance', 'supabase']);
    assert.equal(claim.rowCount, 1);
    const token = claim.rows[0].attempt_token;
    // The session_id persist — the statement whose missing grant would have made
    // WRITE-2 permission-denied under its own security model.
    await client.query(SQL.persistReceiptSessionId, ['w-1', token, '20260808-PM-01']);
    await client.query(SQL.completeWriteReceipt, ['w-1', token, JSON.stringify({ ok: true }), 1, 'A2:L2']);
    await client.query(SQL.failWriteReceipt, ['w-1', token]);
    await client.query(SQL.peekWriteReceipt, ['w-1']);
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['w-1']);

    // The export-state updates of §3.1 — all six columns, as one statement.
    await client.query(SQL.updateExportState, [
      '20260808-PM-01', null, 'mirror_range_occupied', 'blocked', null, null,
    ]);

    // The catalog READ, and only the read. OWNER CORRECTION 2026-08-13 made Supabase
    // the catalog authority, so the generation lifecycle no longer exists and the
    // runtime holds no write on it at all — the refusals are proven in
    // test-pg/exerciseCatalog.pgproof.js.
    await client.query(SQL.readExerciseCatalog);

    // THE DIVERGENCE LANE AND THE SWEEP ENUMERATIONS ARE NOT EXERCISED HERE ANY
    // MORE, because this build issues no such statement. `services/supabaseAdapter.js`
    // names `atlas.migration_divergences` in no SQL at all after the S4 cutover, and
    // a privilege proof for a statement nothing can issue would be proving the grant
    // of a capability the code does not have. §6.3 P17 asks the opposite question —
    // that the table be INERT — and the assertion below is that question.
  });
});

// §6.3 P17 — the table survives the merge, and NOTHING IN THIS BUILD TOUCHES IT.
//
// It is retained for the rollback window: a restored S3 build's shadow lane, sweep
// and repair worker query it continuously, so dropping it now would leave a revert
// one statement from a missing table. The drop is an owner-run artifact outside
// `supabase/migrations/`, executed after the window closes.
//
// This is a SOURCE assertion rather than a runtime one, and deliberately so: a
// runtime observation could only prove that the statements this test happened to
// drive issued nothing. Reading the adapter proves no statement exists to issue.
test('P17: atlas.migration_divergences exists, and no adapter statement names it', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      "SELECT to_regclass('atlas.migration_divergences') AS present"
    );
    assert.ok(rows[0].present, 'the table must still exist — a restored S3 build needs it');
  });

  const source = require('fs')
    .readFileSync(require.resolve('../services/supabaseAdapter.js'), 'utf8')
    // Comments explain WHY the table is retained, so they name it. Statements must not.
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !/migration_divergences/.test(source),
    'no executable line of the adapter may name atlas.migration_divergences after S4'
  );
});

test('P7c: the receipt prune is refused to atlas_app and permitted to atlas_migrate', async () => {
  // §3.6 demotes the prune to size housekeeping, and §8.2 gives atlas_app NO
  // DELETE on write_receipts — a runtime role that could delete a receipt could
  // erase duplicate protection. So the prune is an operator job, not a runtime
  // one, and the grant is what enforces that rather than a convention.
  await withRole('atlas_app', async (client) => {
    await expectRejected(client, SQL.pruneWriteReceipts, [], {
      sqlstate: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });
  });
  await withRole('atlas_migrate', async (client) => {
    await client.query(SQL.pruneWriteReceipts);
  });
});

test('P7c: atlas_migrate executes the declared cutover receipt carry as its real role', async () => {
  await withRole('atlas_migrate', async (client) => {
    await client.query(
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at)
       VALUES ('carried-1', '/api/log-workout', 'supabase', 'completed', now(), now() + interval '24 hours')`
    );
    await client.query(`UPDATE atlas.write_receipts SET rows_written = 3 WHERE write_id = 'carried-1'`);
    await client.query(`DELETE FROM atlas.write_receipts WHERE write_id = 'carried-1'`);
  });
});

// *Updated by PR S3.* The S2 boundary was "no grant on write_freeze, because the
// table does not exist yet". S3 creates it, so the honest assertion is now the
// EXACT grant list — and it is the stricter one, because a table that exists with
// the wrong grants is the failure mode that actually matters.
//
// This is the security half of owner ruling D7: the runtime CANNOT lift a freeze,
// and that is enforced by the absence of a grant rather than by any code path. The
// behavioural refusals are proven as the real role in writeFreeze.pgproof.js.
test('atlas.write_freeze is owned by the PROJECT OWNER, and no scoped role may write it', async () => {
  await withOwner(async (client) => {
    const ownerRow = await client.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    const owner = ownerRow.rows[0].tableowner;

    // *Corrected by the required review of `65310b3`, finding 1.* This used to
    // assert `owner === 'atlas_migrate'`, mirroring every other table. On THIS
    // table that was the defect: ownership carries implicit INSERT/UPDATE/DELETE
    // that cannot be durably revoked from the owner, so it made atlas_migrate a
    // second principal able to lift a freeze. D7 names ONE mutator — the Supabase
    // project owner — so the table stays owned by whoever applied the migration,
    // which on `Atlas Production` is `postgres` and here is its NOSUPERUSER mirror.
    assert.notEqual(owner, 'atlas_migrate',
      'transferring ownership to the migration role recreates the second mutation authority D7 forbids');
    for (const role of ['atlas_app', 'atlas_readonly', 'atlas_rebuild']) {
      assert.notEqual(owner, role, `${role} must not own the control`);
    }

    const { rows } = await client.query(
      `SELECT grantee, privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'atlas' AND table_name = 'write_freeze'
        ORDER BY grantee, privilege_type`
    );

    // The OWNER's own implicit privileges appear in this view and are excluded by
    // identity — read from pg_tables above, never hardcoded, so this cannot quietly
    // start excusing a different role.
    const granted = rows.filter((r) => r.grantee !== owner);

    // NOT ONE granted role may INSERT, UPDATE, DELETE or TRUNCATE it. Swept across
    // every grantee rather than checked per role, so a write granted to a role this
    // test did not think to name is still caught.
    assert.deepEqual(
      granted.filter((r) => r.privilege_type !== 'SELECT'), [],
      'only the Supabase project owner may mutate the freeze — a granted write would be a second authority'
    );

    // atlas_migrate holds NOTHING here, not even SELECT. It is the migration role,
    // and the control is not its to read or to change.
    assert.deepEqual(granted.filter((r) => r.grantee === 'atlas_migrate'), [],
      'atlas_migrate must hold no privilege on the control at all');

    // And the runtime CAN read it, or the control could never admit a write.
    const readers = [...new Set(granted.map((r) => r.grantee))].sort();
    assert.deepEqual(readers, ['atlas_app', 'atlas_readonly', 'atlas_rebuild'],
      'exactly the three read-capable roles, and no other grantee');
  });
});

test('no role in this schema has been given Row Level Security — Atlas makes no RLS claim', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'atlas' AND c.relkind = 'r' AND c.relrowsecurity`
    );
    // §8.3: until RLS is configured AND a test proves a denied read, no document,
    // PR body, or merge card may state that Atlas has it. This asserts the
    // honest state — none is enabled — so the claim cannot drift.
    assert.deepEqual(rows, []);
  });
});
