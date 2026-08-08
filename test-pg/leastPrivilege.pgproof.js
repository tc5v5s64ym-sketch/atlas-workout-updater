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
  // The list is exactly three: logged_sets (undo), exercise_catalog_mirror (the
  // §3.7 generation swap), and migration_divergences while it exists.
  const refused = [
    'atlas.session_effort',
    'atlas.session_plan_events',
    'atlas.session_plan_set_recommendations',
    // A runtime role that could delete a receipt could erase duplicate protection.
    'atlas.write_receipts',
    'atlas.workout_sessions',
    'atlas.sheets_mirror_allocations',
    'atlas.sheets_mirror_cursor',
    'atlas.exercise_catalog_sync',
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

    // The catalog generation lifecycle, including the DELETE the swap needs.
    const sync = await client.query(SQL.beginCatalogSync, [1, 'abc']);
    const syncId = sync.rows[0].sync_id;
    await client.query(SQL.deleteCatalogMirror);
    await client.query(SQL.insertCatalogRow, ['back squat', 'Back Squat', 'Legs', 'SQ01', 'Back Squat', syncId]);
    await client.query(SQL.verifyCatalogSync, [syncId]);
    await client.query(SQL.currentCatalogGeneration);
    await client.query(SQL.readCatalogMirror);
    await client.query(SQL.failCatalogSync, [syncId, 'a recorded failure']);

    // The divergence lane, end to end.
    const opened = await client.query(SQL.openDivergence, [
      'logged_sets', 'k||x||1', '20260808-PM-01', null, '/api/log-workout',
      'missing_in_supabase', 'sweep', JSON.stringify({ differences: [] }),
    ]);
    const divergenceId = opened.rows[0].id;
    await client.query(SQL.listOpenDivergences, [10]);
    const claimed = await client.query(SQL.claimDivergence, [divergenceId, '120']);
    const claimToken = claimed.rows[0].repair_claim_token;
    await client.query(SQL.releaseDivergence, [divergenceId, claimToken, null]);
    const reclaimed = await client.query(SQL.claimDivergence, [divergenceId, '120']);
    await client.query(SQL.closeDivergence, [
      divergenceId, reclaimed.rows[0].repair_claim_token, 'recompare: equal', JSON.stringify({ differences: [] }),
    ]);
    await client.query(SQL.divergenceSummary);

    // Sweep enumeration and the one workout-data delete it may issue.
    await client.query(SQL.listLoggedSets);
    await client.query(SQL.listSessionEffort);
    await client.query(SQL.listPlanEvents);
    await client.query(SQL.listPlanSetRows);
    await client.query(SQL.deleteLoggedSetByIdentity, ['20260808-pm-01', 'back squat', 1]);
  });
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

test('the second declared atlas_migrate DML operation is NOT granted in S2 — write_freeze does not exist yet', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.table_privileges
        WHERE table_schema = 'atlas' AND table_name = 'write_freeze'`
    );
    // A grant written in S2 would prove nothing about a table that does not exist
    // until S3. S3's migration carries it, and §6.2 P8a proves it there.
    assert.equal(rows[0].n, 0);
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
