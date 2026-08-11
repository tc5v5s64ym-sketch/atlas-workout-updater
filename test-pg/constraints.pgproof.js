'use strict';

// §6.1 P1 — every constraint of §3.1-§3.9 is proven by a test that inserts a
// VIOLATING row and asserts the insert is rejected. A constraint with no
// violation test does not count as proven.
//
// §3.10 atlas.write_freeze is deliberately absent: S2 must not create it. S3
// creates it and §6.2 P8a proves it there.
//
// Every statement below runs against the real from-empty database of P2.

const test = require('node:test');
const assert = require('node:assert');
const {
  withOwner, resetSchema, expectRejected, seedSession, SQLSTATE,
} = require('./support/db');

test.beforeEach(async () => {
  await resetSchema();
});

// ── §3.1 atlas.workout_sessions ────────────────────────────────────────────────

test('§3.1 workout_sessions: period is constrained to AM or PM', async () => {
  await withOwner(async (client) => {
    await expectRejected(
      client,
      `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
       VALUES ('20260808-XX-01', '2026-08-08', 'XX', 1)`,
      [],
      { sqlstate: SQLSTATE.CHECK_VIOLATION }
    );
  });
});

test('§3.1 workout_sessions: slot is constrained to 1..99', async () => {
  await withOwner(async (client) => {
    await expectRejected(
      client,
      `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
       VALUES ('20260808-AM-00', '2026-08-08', 'AM', 0)`,
      [],
      { sqlstate: SQLSTATE.CHECK_VIOLATION }
    );
    await expectRejected(
      client,
      `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
       VALUES ('20260808-AM-99', '2026-08-08', 'AM', 100)`,
      [],
      { sqlstate: SQLSTATE.CHECK_VIOLATION }
    );
  });
});

test('§3.1 workout_sessions: (session_date, period, slot) is unique — two allocations cannot pick one id', async () => {
  await withOwner(async (client) => {
    await client.query(
      `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
       VALUES ('20260808-AM-01', '2026-08-08', 'AM', 1)`
    );
    await expectRejected(
      client,
      `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
       VALUES ('20260808-AM-01-dup', '2026-08-08', 'AM', 1)`,
      [],
      { sqlstate: SQLSTATE.UNIQUE_VIOLATION }
    );
  });
});

test('§3.1 workout_sessions: export state is constrained to the three declared values', async () => {
  await withOwner(async (client) => {
    await expectRejected(
      client,
      `INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot, sheets_export_state)
       VALUES ('20260808-AM-02', '2026-08-08', 'AM', 2, 'exported')`,
      [],
      { sqlstate: SQLSTATE.CHECK_VIOLATION }
    );
  });
});

// ── §3.2 atlas.logged_sets ─────────────────────────────────────────────────────

const LOGGED_SET_INSERT = `
  INSERT INTO atlas.logged_sets
    (session_id, date_clean, exercise, canonical_exercise, muscle_group, lift_code,
     set_number, weight, reps, rir, notes, volume_calc)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

const LOGGED_SET_ROW = ['2026-08-08', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', 1, 225, 5, 2, '', 1125];

test('§3.2 logged_sets: a set with no session parent is rejected', async () => {
  await withOwner(async (client) => {
    await expectRejected(
      client,
      LOGGED_SET_INSERT,
      ['20260808-AM-77', ...LOGGED_SET_ROW],
      { sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION }
    );
  });
});

test('§3.2 logged_sets: the composite identity key refuses a duplicate, case-insensitively', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await client.query(LOGGED_SET_INSERT, [sessionId, ...LOGGED_SET_ROW]);
    // The live dedupe lower-cases the whole composite key, so a differently-cased
    // exercise is the SAME row and must be refused.
    await expectRejected(
      client,
      LOGGED_SET_INSERT,
      [sessionId, '2026-08-08', 'BACK SQUAT', 'Back Squat', 'Legs', 'SQ01', 1, 225, 5, 2, '', 1125],
      { sqlstate: SQLSTATE.UNIQUE_VIOLATION }
    );
  });
});

test('§3.2 logged_sets: exercise and set_number are NOT NULL, so the identity index cannot be defeated by a null', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await expectRejected(
      client,
      LOGGED_SET_INSERT,
      [sessionId, '2026-08-08', null, 'Back Squat', 'Legs', 'SQ01', 1, 225, 5, 2, '', 1125],
      { sqlstate: SQLSTATE.NOT_NULL_VIOLATION }
    );
    await expectRejected(
      client,
      LOGGED_SET_INSERT,
      [sessionId, '2026-08-08', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', null, 225, 5, 2, '', 1125],
      { sqlstate: SQLSTATE.NOT_NULL_VIOLATION }
    );
  });
});

// ── §3.3 atlas.session_effort ──────────────────────────────────────────────────

test('§3.3 session_effort: one Effort row per session — the duplicate-session guard is now structural', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await client.query(
      `INSERT INTO atlas.session_effort (session_id, effort_date, duration) VALUES ($1, $2, $3)`,
      [sessionId, '2026-08-08', '01:12:00']
    );
    await expectRejected(
      client,
      `INSERT INTO atlas.session_effort (session_id, effort_date, duration) VALUES ($1, $2, $3)`,
      [sessionId, '2026-08-08', '01:12:00'],
      { sqlstate: SQLSTATE.UNIQUE_VIOLATION }
    );
  });
});

test('§3.3 session_effort: an Effort row with no session parent is rejected', async () => {
  await withOwner(async (client) => {
    await expectRejected(
      client,
      `INSERT INTO atlas.session_effort (session_id, effort_date) VALUES ($1, $2)`,
      ['20260808-PM-42', '2026-08-08'],
      { sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION }
    );
  });
});

// ── §3.4 atlas.session_plan_events ─────────────────────────────────────────────

const PLAN_EVENT_INSERT = `
  INSERT INTO atlas.session_plan_events
    (idempotency_key, session_id, session_date, plan_version, event_type, plan_item_id,
     outcome, closeout_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

test('§3.4 session_plan_events: the three owner-frozen vocabularies are CHECK constraints', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await expectRejected(client, PLAN_EVENT_INSERT,
      ['k-bad-type', sessionId, '2026-08-08', 1, 'plan_rejected', 'item-1', 'planned', ''],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client, PLAN_EVENT_INSERT,
      ['k-bad-outcome', sessionId, '2026-08-08', 1, 'item_outcome', 'item-1', 'partially_done', ''],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client, PLAN_EVENT_INSERT,
      ['k-bad-closeout', sessionId, '2026-08-08', 1, 'session_closeout', '', '', 'half_finished'],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('§3.4 session_plan_events: the empty string is a MEMBER of the outcome and closeout vocabularies', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    // §4.7 rule 2: '' means "not applicable to this event type" and must be legal.
    await client.query(PLAN_EVENT_INSERT,
      ['k-closeout', sessionId, '2026-08-08', 1, 'session_closeout', '', '', 'finalized']);
    const { rows } = await client.query(
      `SELECT outcome, plan_item_id FROM atlas.session_plan_events WHERE idempotency_key = 'k-closeout'`
    );
    assert.equal(rows[0].outcome, '');
    assert.equal(rows[0].plan_item_id, '');
  });
});

test('§3.4 session_plan_events: plan_version must be at least 1, and the key is unique', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await expectRejected(client, PLAN_EVENT_INSERT,
      ['k-v0', sessionId, '2026-08-08', 0, 'plan_accepted', 'item-1', 'planned', ''],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await client.query(PLAN_EVENT_INSERT,
      ['k-dup', sessionId, '2026-08-08', 1, 'plan_accepted', 'item-1', 'planned', '']);
    await expectRejected(client, PLAN_EVENT_INSERT,
      ['k-dup', sessionId, '2026-08-08', 2, 'plan_accepted', 'item-2', 'planned', ''],
      { sqlstate: SQLSTATE.UNIQUE_VIOLATION });
  });
});

// ── §3.5 atlas.session_plan_set_recommendations ────────────────────────────────
//
// These four constraints are what make five of validateChain's seven read-time
// chain defects structurally impossible.

const PLAN_SET_INSERT = `
  INSERT INTO atlas.session_plan_set_recommendations
    (idempotency_key, session_id, session_date, plan_version, plan_item_id, planned_lift_code,
     set_index, target_set_count, target_weight, target_reps, target_rir,
     recommendation_source, supersedes_key, confidence)
  VALUES ($1, $2, $3, $4, $5, 'SQ01', $6, 3, 225, 5, 2, $7, $8, 'reliable')`;

test('§3.5 plan sets: duplicate_version is prevented by the chain unique key', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await client.query(PLAN_SET_INSERT, ['s1', sessionId, '2026-08-08', 1, 'item-1', 1, 'accepted', null]);
    await expectRejected(client, PLAN_SET_INSERT,
      ['s1-other-key', sessionId, '2026-08-08', 1, 'item-1', 1, 'accepted', null],
      { sqlstate: SQLSTATE.UNIQUE_VIOLATION });
  });
});

test('§3.5 plan sets: fork is prevented — two revisions cannot supersede one row', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await client.query(PLAN_SET_INSERT, ['s1', sessionId, '2026-08-08', 1, 'item-1', 1, 'accepted', null]);
    await client.query(PLAN_SET_INSERT, ['s2', sessionId, '2026-08-08', 2, 'item-1', 1, 'live_revision', 's1']);
    await expectRejected(client, PLAN_SET_INSERT,
      ['s2-fork', sessionId, '2026-08-08', 3, 'item-1', 1, 'live_revision', 's1'],
      { sqlstate: SQLSTATE.UNIQUE_VIOLATION });
  });
});

test('§3.5 plan sets: dangling_supersedes is prevented by the self-referencing foreign key', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await expectRejected(client, PLAN_SET_INSERT,
      ['s9', sessionId, '2026-08-08', 2, 'item-1', 1, 'live_revision', 'no-such-key'],
      { sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION });
  });
});

test('§3.5 plan sets: v1_has_supersedes AND missing_supersedes are prevented by one CHECK', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await client.query(PLAN_SET_INSERT, ['base', sessionId, '2026-08-08', 1, 'item-9', 1, 'accepted', null]);
    // v1 carrying a supersedes_key.
    await expectRejected(client, PLAN_SET_INSERT,
      ['v1-super', sessionId, '2026-08-08', 1, 'item-1', 1, 'accepted', 'base'],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    // v2 carrying none.
    await expectRejected(client, PLAN_SET_INSERT,
      ['v2-nosuper', sessionId, '2026-08-08', 2, 'item-1', 1, 'live_revision', null],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('§3.5 plan sets: set_index >= 1, and the source and confidence vocabularies bite', async () => {
  await withOwner(async (client) => {
    const sessionId = await seedSession(client);
    await expectRejected(client, PLAN_SET_INSERT,
      ['idx0', sessionId, '2026-08-08', 1, 'item-1', 0, 'accepted', null],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client, PLAN_SET_INSERT,
      ['badsrc', sessionId, '2026-08-08', 1, 'item-1', 1, 'guessed', null],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client,
      `INSERT INTO atlas.session_plan_set_recommendations
         (idempotency_key, session_id, plan_version, plan_item_id, set_index,
          recommendation_source, confidence)
       VALUES ('badconf', $1, 1, 'item-1', 1, 'accepted', 'quite_sure')`,
      [sessionId],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

// ── §3.6 atlas.write_receipts ──────────────────────────────────────────────────

test('\u00a73.6 write_receipts: status is constrained, and expires_at/attempt_started_at are NOT NULL', async () => {
  await withOwner(async (client) => {
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, expires_at, attempt_started_at)
       VALUES ('w1', '/api/log-workout', 'supabase', 'pending', now(), now())`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    // A receipt with a null TTL authority would be invisible to peekWrite the
    // instant it was created, so the column may not be nullable.
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, owner_instance_id)
       VALUES ('w2', '/api/log-workout', 'supabase', 'in_progress', now(), 'inst-1')`,
      [], { sqlstate: SQLSTATE.NOT_NULL_VIOLATION });
  });
});

test('\u00a73.6 write_receipts: effect_authority is NOT NULL and constrained to the two declared authorities', async () => {
  // The reclaim rule in SQL.claimWriteReceipt branches on this column. A row that
  // carried no authority, or an unrecognised one, would fall out of BOTH branches:
  // it could never be reclaimed and could never be marked ambiguous, so the
  // write_id would wedge with no operator path out of it.
  await withOwner(async (client) => {
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, status, attempt_started_at, expires_at, owner_instance_id)
       VALUES ('w-ea-1', '/api/log-workout', 'in_progress', now(), now(), 'inst-1')`,
      [], { sqlstate: SQLSTATE.NOT_NULL_VIOLATION });
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at, owner_instance_id)
       VALUES ('w-ea-2', '/api/log-workout', 'postgres', 'in_progress', now(), now(), 'inst-1')`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('\u00a73.6 write_receipts: a LIVE attempt with no owner is unrepresentable', async () => {
  // Required review of `deaa8a5`. `owner_instance_id IS DISTINCT FROM $3` reads a
  // NULL owner as "some other process", so an in_progress row with no owner would
  // be reclaimed on age alone -- the exact time-based inference the column exists
  // to remove. Enforced structurally rather than by the discipline of the single
  // adapter call site that happens to pass the value today.
  await withOwner(async (client) => {
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at)
       VALUES ('w-own-1', '/api/log-workout', 'supabase', 'in_progress', now(), now() + interval '1 hour')`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    // A terminal row may legally have none: the S4 carry (\u00a75.5a) normalises every
    // carried in_progress record to 'failed' before inserting it, because the file
    // store records no owner and one may not be invented.
    await client.query(
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at)
       VALUES ('w-own-2', '/api/log-workout', 'supabase', 'failed', now(), now() + interval '1 hour')`
    );
  });
});

test('\u00a73.6 write_receipts: the ambiguous state is structurally confined, and only proof leaves it', async () => {
  await withOwner(async (client) => {
    // Meaningless for an atomic effect: a Supabase transaction is present or
    // absent, never maybe. Barring it here stops 'ambiguous' becoming a
    // general-purpose stall for the migrated routes.
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at, ambiguous_at)
       VALUES ('w-amb-1', '/api/log-workout', 'supabase', 'ambiguous', now(), now() + interval '1 hour', now())`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    // An ambiguous row with no ambiguous_at could not be found by the operator
    // queue, and one holding a live token could be completed by the very process
    // whose effect is unproven.
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at)
       VALUES ('w-amb-2', '/api/coaching-notes', 'sheets', 'ambiguous', now(), now() + interval '1 hour')`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client,
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at, ambiguous_at, attempt_token)
       VALUES ('w-amb-3', '/api/coaching-notes', 'sheets', 'ambiguous', now(), now() + interval '1 hour', now(), gen_random_uuid())`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });

    await client.query(
      `INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt_started_at, expires_at, ambiguous_at)
       VALUES ('w-amb-4', '/api/coaching-notes', 'sheets', 'ambiguous', now(), now() + interval '1 hour', now())`
    );
    // Leaving 'ambiguous' without recording what was read at the destination is
    // exactly the inference the state exists to forbid -- and an empty string is
    // not a proof.
    await expectRejected(client,
      `UPDATE atlas.write_receipts SET status = 'failed' WHERE write_id = 'w-amb-4'`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client,
      `UPDATE atlas.write_receipts SET status = 'failed', ambiguity_proof = '' WHERE write_id = 'w-amb-4'`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await client.query(
      `UPDATE atlas.write_receipts
          SET status = 'failed',
              ambiguity_proof = 'read Coaching_Notes A2:D200 at 2026-08-08T11:04Z; no row for this write_id'
        WHERE write_id = 'w-amb-4'`
    );
    // And the provenance survives the resolution, so a later reader can tell a
    // verified release from an assumed one.
    const { rows } = await client.query(
      `SELECT ambiguous_at IS NOT NULL AS was_ambiguous, ambiguity_proof
         FROM atlas.write_receipts WHERE write_id = 'w-amb-4'`
    );
    assert.equal(rows[0].was_ambiguous, true);
    assert.match(rows[0].ambiguity_proof, /no row for this write_id/);
  });
});

// ── §3.7 the catalog mirror and its freshness authority ────────────────────────

test('§3.7 catalog: sync status is constrained and a verified generation must carry its facts', async () => {
  await withOwner(async (client) => {
    await expectRejected(client,
      `INSERT INTO atlas.exercise_catalog_sync (status) VALUES ('maybe')`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    // A generation may not claim verification without verified_at and content_hash:
    // currency and version identity are exactly what the Save path reads.
    await expectRejected(client,
      `INSERT INTO atlas.exercise_catalog_sync (status, verified_at) VALUES ('verified', now())`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('§3.7 catalog mirror: a row must name the generation that wrote it', async () => {
  await withOwner(async (client) => {
    await expectRejected(client,
      `INSERT INTO atlas.exercise_catalog_mirror (exercise, display_exercise, sync_id)
       VALUES ('back squat', 'Back Squat', 999999)`,
      [], { sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION });
    await expectRejected(client,
      `INSERT INTO atlas.exercise_catalog_mirror (exercise, display_exercise)
       VALUES ('back squat', 'Back Squat')`,
      [], { sqlstate: SQLSTATE.NOT_NULL_VIOLATION });
  });
});

// ── §3.8 atlas.migration_divergences ───────────────────────────────────────────

const DIVERGENCE_INSERT = `
  INSERT INTO atlas.migration_divergences (concept, identity_key, reason, detected_by)
  VALUES ($1, $2, $3, $4)`;

test('§3.8 divergences: concept, reason, detected_by and state vocabularies all bite', async () => {
  await withOwner(async (client) => {
    // write_receipts is DELIBERATELY absent from the concept vocabulary: Sheets
    // stores no write_id, so it cannot be that concept's completeness authority.
    await expectRejected(client, DIVERGENCE_INSERT,
      ['write_receipts', 'k', 'missing_in_supabase', 'sweep'],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client, DIVERGENCE_INSERT,
      ['logged_sets', 'k', 'mirror_range_occupied', 'sweep'],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client, DIVERGENCE_INSERT,
      ['logged_sets', 'k', 'missing_in_supabase', 'exporter'],
      { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client,
      `INSERT INTO atlas.migration_divergences (concept, identity_key, reason, detected_by, state)
       VALUES ('logged_sets', 'k', 'missing_in_supabase', 'sweep', 'resolved')`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('§3.8 divergences: a CLOSED row without closure_proof is structurally impossible', async () => {
  await withOwner(async (client) => {
    await client.query(DIVERGENCE_INSERT, ['logged_sets', 'k1', 'missing_in_supabase', 'sweep']);
    // Not by a timer, not by age, not by a repair that merely ran.
    await expectRejected(client,
      `UPDATE atlas.migration_divergences SET state = 'closed', closed_at = now() WHERE identity_key = 'k1'`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client,
      `UPDATE atlas.migration_divergences SET state = 'closed', closed_at = now(), closure_proof = ''
        WHERE identity_key = 'k1'`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    // And a closure_proof with no closed_at is refused too — a proof with no
    // moment is not an audit record.
    await expectRejected(client,
      `UPDATE atlas.migration_divergences SET state = 'closed', closure_proof = 'recompare ok'
        WHERE identity_key = 'k1'`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('§3.8 divergences: at most ONE open row per identity, and closed rows stay as history', async () => {
  await withOwner(async (client) => {
    await client.query(DIVERGENCE_INSERT, ['logged_sets', 'same-key', 'missing_in_supabase', 'sweep']);
    await expectRejected(client, DIVERGENCE_INSERT,
      ['logged_sets', 'same-key', 'content_mismatch', 'sweep'],
      { sqlstate: SQLSTATE.UNIQUE_VIOLATION });
    // Once closed, the identity may legitimately diverge again later.
    await client.query(
      `UPDATE atlas.migration_divergences
          SET state = 'closed', closed_at = now(), closure_proof = 'recompare: equal'
        WHERE identity_key = 'same-key'`
    );
    await client.query(DIVERGENCE_INSERT, ['logged_sets', 'same-key', 'content_mismatch', 'sweep']);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM atlas.migration_divergences WHERE identity_key = 'same-key'`
    );
    assert.equal(rows[0].n, 2);
  });
});

// ── §3.9 the export destination authority ──────────────────────────────────────

test('§3.9 mirror cursor: next_row starts below the header is refused, and the tab list is closed', async () => {
  await withOwner(async (client) => {
    await expectRejected(client,
      `INSERT INTO atlas.sheets_mirror_cursor (tab, next_row) VALUES ('Log_Cleaned', 1)`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
    await expectRejected(client,
      `INSERT INTO atlas.sheets_mirror_cursor (tab, next_row) VALUES ('Coaching_Notes', 2)`,
      [], { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('§3.9 mirror allocations: two allocations on one tab CANNOT overlap', async () => {
  await withOwner(async (client) => {
    await client.query(`INSERT INTO atlas.sheets_mirror_cursor (tab, next_row) VALUES ('Log_Cleaned', 2)`);
    const a = await seedSession(client, '20260808-AM-01');
    const b = await seedSession(client, '20260808-AM-02');
    await client.query(
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Log_Cleaned', $1, 10, 5)`, [a]
    );
    // Rows 10..14 are taken; 12..16 overlaps. This is the defect a per-session
    // column could not prevent: one values.update silently overwriting another
    // session's workout.
    await expectRejected(client,
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Log_Cleaned', $1, 12, 5)`,
      [b], { sqlstate: SQLSTATE.EXCLUSION_VIOLATION });
    // Abutting is legal: 15 begins exactly where 14 ended.
    await client.query(
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Log_Cleaned', $1, 15, 3)`, [b]
    );
    const { rows } = await client.query(
      `SELECT start_row, end_row FROM atlas.sheets_mirror_allocations ORDER BY start_row`
    );
    assert.deepEqual(rows.map((r) => [r.start_row, r.end_row]), [[10, 14], [15, 17]]);
  });
});

test('§3.9 mirror allocations: one allocation per (tab, session), and row_count >= 1', async () => {
  await withOwner(async (client) => {
    await client.query(`INSERT INTO atlas.sheets_mirror_cursor (tab, next_row) VALUES ('Effort', 2)`);
    const a = await seedSession(client, '20260808-PM-01');
    await client.query(
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Effort', $1, 2, 1)`, [a]
    );
    // A re-export finds its existing reservation instead of taking a new one.
    await expectRejected(client,
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Effort', $1, 50, 1)`,
      [a], { sqlstate: SQLSTATE.UNIQUE_VIOLATION });
    const b = await seedSession(client, '20260808-PM-02');
    await expectRejected(client,
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Effort', $1, 60, 0)`,
      [b], { sqlstate: SQLSTATE.CHECK_VIOLATION });
  });
});

test('§3.9 mirror allocations: a reservation must name a real tab and a real session', async () => {
  await withOwner(async (client) => {
    const a = await seedSession(client, '20260808-PM-03');
    await expectRejected(client,
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Log_Cleaned', $1, 2, 1)`,
      [a], { sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION });
    await client.query(`INSERT INTO atlas.sheets_mirror_cursor (tab, next_row) VALUES ('Log_Cleaned', 2)`);
    await expectRejected(client,
      `INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
       VALUES ('Log_Cleaned', '20260808-PM-88', 2, 1)`,
      [], { sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION });
  });
});

// ── §3.10 is proven by S3, not here ────────────────────────────────────────────
//
// *Updated by PR S3, which is the PR that creates it.* This file proves the
// constraints of §3.1–§3.9, and §6.1 P1 explicitly excludes §3.10 because S2 is
// forbidden to create that table. Until S3 the honest assertion was that it does
// not exist; from S3 on, the honest assertion is that it exists with exactly the
// declared shape — and its constraints, seed and grants are proven, as the real
// roles, in test-pg/writeFreeze.pgproof.js (§6.2 P8a).
//
// The S2 boundary itself is unchanged and still enforced, in the one place that
// can still enforce it: test/supabaseMigrationS2.test.js asserts that no S2
// migration file creates the table and that exactly one S3 file does.

test('§3.10 atlas.write_freeze exists, created by S3 — its constraints are proven in writeFreeze.pgproof.js', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze'`
    );
    assert.equal(rows[0].n, 1, 'S3 creates atlas.write_freeze alongside the control that reads it');
  });
});

test('exactly the twelve declared tables exist, and no more', async () => {
  await withOwner(async (client) => {
    const { rows } = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'atlas' ORDER BY tablename`
    );
    // Eleven from S2 (§3.1–§3.9) plus write_freeze from S3 (§3.10). An UNREVIEWED
    // table joining the schema is what this list exists to catch, so it is stated
    // in full rather than counted.
    assert.deepEqual(rows.map((r) => r.tablename), [
      'exercise_catalog_mirror',
      'exercise_catalog_sync',
      'logged_sets',
      'migration_divergences',
      'session_effort',
      'session_plan_events',
      'session_plan_set_recommendations',
      'sheets_mirror_allocations',
      'sheets_mirror_cursor',
      'workout_sessions',
      'write_freeze',
      'write_receipts',
    ]);
  });
});
