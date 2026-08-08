'use strict';

// §6.1 P7a — the shadow transaction is ordered and atomic on the session parent.
// §6.1 P7d — no receipt is mirrored during S2/S3, and no write_id is fabricated.
//
// Proven against an EMPTY schema, which is the state S2 actually starts from:
// S2 enables shadow writes against an empty database and the backfill does not
// run until S3. Nothing inserts or backfills atlas.workout_sessions before the
// children arrive, so without the parent-first rule the FIRST S2 shadow write for
// a real session would violate the session foreign key.

const test = require('node:test');
const assert = require('node:assert');
const { withOwner, resetSchema } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const contract = require('../services/migrationRowContract');

const SESSION = '20260808-PM-07';

// The exact 12-cell Log_Cleaned row shape the Sheets append receives.
function logCells(setNumber, exercise = 'Back Squat') {
  return ['2026-08-08', SESSION, exercise, exercise, 'Legs', 'SQ01', String(setNumber), '225', '5', '2', '', '1125'];
}

const EFFORT_CELLS = ['2026-08-08', SESSION, '01:02:00', '400', '620', '131', '166', 'Gym', 'felt good'];

test.beforeEach(async () => {
  await resetSchema();
});

test.after(async () => {
  await adapter.close();
});

test('P7a: a shadow Save against an EMPTY schema inserts its session parent before its children', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    assert.equal(rows[0].n, 0, 'the schema must genuinely start empty');
  });

  const result = await adapter.shadowSave({
    sessionId: SESSION,
    logCells: [logCells(1), logCells(2)],
    effortCells: EFFORT_CELLS,
  });
  assert.equal(result.logged_sets_inserted, 2);
  assert.equal(result.session_effort_inserted, 1);

  await withOwner(async (client) => {
    // The parent is DERIVED from the id's own YYYYMMDD-{AM|PM}-NN structure. No
    // extra source is needed, and none is invented.
    const parent = await client.query('SELECT * FROM atlas.workout_sessions WHERE session_id = $1', [SESSION]);
    assert.equal(parent.rowCount, 1);
    assert.equal(parent.rows[0].session_date, '2026-08-08');
    assert.equal(parent.rows[0].period, 'PM');
    assert.equal(parent.rows[0].slot, 7);
    const sets = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    assert.equal(sets.rows[0].n, 2);
  });
});

test('P7a: a failure mid-transaction leaves NEITHER the parent nor the children', async () => {
  // The second row repeats set_number 1, which the composite identity index
  // refuses. ON CONFLICT DO NOTHING covers the exact-duplicate case, so force a
  // genuine constraint failure instead: a null exercise.
  const poisoned = ['2026-08-08', SESSION, '', 'Back Squat', 'Legs', 'SQ01', '3', '225', '5', '2', '', '1125'];

  await assert.rejects(
    adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1), poisoned] }),
    /null value in column "exercise"/
  );

  await withOwner(async (client) => {
    const parent = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    const sets = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    // A partial Save is impossible — which the two split appendRows calls in
    // index.js cannot guarantee against Sheets today.
    assert.equal(parent.rows[0].n, 0);
    assert.equal(sets.rows[0].n, 0);
  });
});

test('P7a: a child can never commit without its session parent', async () => {
  await withOwner(async (client) => {
    await assert.rejects(
      client.query(
        `INSERT INTO atlas.logged_sets (session_id, exercise, set_number) VALUES ($1, 'Back Squat', 1)`,
        [SESSION]
      ),
      /violates foreign key constraint/
    );
  });
});

test('P7a: a second Save for the same session neither duplicates nor overwrites the parent', async () => {
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)] });
  await withOwner(async (client) => {
    // Mutate an export-state column so an overwrite would be visible.
    await client.query(
      `UPDATE atlas.workout_sessions SET sheets_export_attempts = 4 WHERE session_id = $1`, [SESSION]
    );
  });
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(2)], effortCells: EFFORT_CELLS });

  await withOwner(async (client) => {
    const parent = await client.query('SELECT * FROM atlas.workout_sessions');
    assert.equal(parent.rowCount, 1);
    // ON CONFLICT DO NOTHING is correct HERE and carries none of the hazard it
    // carries for receipts: this table is insert-only for identity, so there is
    // no later state transition for it to discard.
    assert.equal(parent.rows[0].sheets_export_attempts, 4);
    const sets = await client.query('SELECT set_number FROM atlas.logged_sets ORDER BY set_number');
    assert.deepEqual(sets.rows.map((r) => r.set_number), [1, 2]);
  });
});

test('P7a: a re-Save of the SAME rows inserts nothing — the identity constraint is the guard', async () => {
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1), logCells(2)], effortCells: EFFORT_CELLS });
  const second = await adapter.shadowSave({
    sessionId: SESSION,
    logCells: [logCells(1), logCells(2)],
    effortCells: EFFORT_CELLS,
  });
  assert.equal(second.logged_sets_inserted, 0);
  assert.equal(second.session_effort_inserted, 0);
  await withOwner(async (client) => {
    const sets = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    assert.equal(sets.rows[0].n, 2);
  });
});

test('P7a: an unparseable session id fails the shadow write closed rather than inventing a parent', async () => {
  await assert.rejects(
    adapter.shadowSave({ sessionId: 'GATE-H1', logCells: [logCells(1)] }),
    (err) => err.code === 'SESSION_ID_UNPARSEABLE'
  );
  await withOwner(async (client) => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    assert.equal(rows[0].n, 0);
  });
});

test('P7d: NO receipt is mirrored during S2 — write_receipts is empty after a shadow Save', async () => {
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)], effortCells: EFFORT_CELLS });
  await withOwner(async (client) => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM atlas.write_receipts');
    // The file store stays the sole receipt authority through S2 and S3,
    // unmirrored and uncross-checked. There is no Supabase receipt to be wrong.
    assert.equal(rows[0].n, 0);
  });
});

test('P7d: logged_sets.write_id and session_effort.write_id are NULL and carry NO foreign key at S2', async () => {
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)], effortCells: EFFORT_CELLS });
  await withOwner(async (client) => {
    const sets = await client.query('SELECT write_id FROM atlas.logged_sets');
    const effort = await client.query('SELECT write_id FROM atlas.session_effort');
    // A column that is ALWAYS null makes S4's foreign key addable by construction.
    // A column sometimes populated from an authority that does not exist yet does not.
    assert.deepEqual(sets.rows.map((r) => r.write_id), [null]);
    assert.deepEqual(effort.rows.map((r) => r.write_id), [null]);

    const fks = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('atlas.logged_sets'::regclass, 'atlas.session_effort'::regclass)
          AND confrelid = 'atlas.write_receipts'::regclass`
    );
    assert.equal(fks.rowCount, 0, 'S4 adds the write_id foreign keys, not S2');
  });
});

test('the plan spine and the set ledger shadow parent-first too, in ascending revision order', async () => {
  const now = new Date().toISOString();
  await adapter.shadowPlanEvents([
    ['ev-1', SESSION, '2026-08-08', '1', 'plan_accepted', 'item-1', '1', 'SQ01', 'squat', 'planned', '', '', now],
    ['ev-2', SESSION, '2026-08-08', '1', 'session_closeout', '', '', '', '', '', '', 'finalized', now],
  ]);
  // Deliberately out of order: a revision references the row it supersedes, so a
  // batch that inserted v2 before v1 would fail the self-referencing key.
  await adapter.shadowPlanSetRows([
    ['ls-2', SESSION, '2026-08-08', '2', 'item-1', 'SQ01', '1', '3', '230', '5', '2', 'live_revision', 'ls-1', 'reliable', '', now],
    ['ls-1', SESSION, '2026-08-08', '1', 'item-1', 'SQ01', '1', '3', '225', '5', '2', 'accepted', '', 'reliable', '', now],
  ]);

  await withOwner(async (client) => {
    const parent = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    assert.equal(parent.rows[0].n, 1);
    const events = await client.query('SELECT idempotency_key FROM atlas.session_plan_events ORDER BY idempotency_key');
    assert.deepEqual(events.rows.map((r) => r.idempotency_key), ['ev-1', 'ev-2']);
    const ledger = await client.query(
      'SELECT idempotency_key, plan_version, supersedes_key FROM atlas.session_plan_set_recommendations ORDER BY plan_version'
    );
    assert.deepEqual(ledger.rows.map((r) => [r.idempotency_key, r.plan_version, r.supersedes_key]), [
      ['ls-1', 1, null],
      ['ls-2', 2, 'ls-1'],
    ]);
  });
});

test('the closeout seal is mirrored, so the sweep compares a seal that is actually there', async () => {
  const now = new Date().toISOString();
  await adapter.shadowPlanSetRows([
    ['ls-1', SESSION, '2026-08-08', '1', 'item-1', 'SQ01', '1', '3', '225', '5', '2', 'accepted', '', 'reliable', '', now],
  ]);
  const sealed = await adapter.shadowSealPlanSets(SESSION, 'w-closeout-1');
  assert.equal(sealed.sealed_rows, 1);

  // Never re-seal: a row already sealed under a different id is not matched.
  const again = await adapter.shadowSealPlanSets(SESSION, 'w-closeout-2');
  assert.equal(again.sealed_rows, 0);

  await withOwner(async (client) => {
    const { rows } = await client.query(
      'SELECT closeout_write_id FROM atlas.session_plan_set_recommendations'
    );
    assert.equal(rows[0].closeout_write_id, 'w-closeout-1');
  });
});

test('the mirrored rows compare EQUAL to the Sheets cells they were built from', async () => {
  // The point of feeding the shadow the exact appended arrays: the mirror is a
  // projection of what was written, so the sweep's comparison must return equal
  // without any special-casing.
  await adapter.shadowSave({ sessionId: SESSION, logCells: [logCells(1)], effortCells: EFFORT_CELLS });
  const stored = await adapter.listConcept('logged_sets');
  const comparison = contract.compareRows(
    'logged_sets',
    contract.rowFromSheet('logged_sets', logCells(1)),
    contract.rowFromSupabase('logged_sets', stored[0])
  );
  assert.deepEqual(comparison.differences, []);
  assert.equal(comparison.equal, true);
});
