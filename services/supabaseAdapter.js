'use strict';

// THE ONLY MODULE THAT HOLDS A SUPABASE CLIENT.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.2 (one adapter,
// no ORM, no generic repository layer, no query-builder abstraction), §8.1 (the
// access model), §8.2 (the scoped roles), §3.1-§3.9 (the operations).
//
// It is to Supabase what `sheets.js` is to Google Sheets: the single place a
// connection lives. It exposes the operations §3 names and nothing else — there
// is deliberately no `query(sql, params)` escape hatch, because one would make
// every caller a second holder of the client.
//
// ── S4 AUTHORITY ──────────────────────────────────────────────────────────────
// Supabase is the sole live authority for every workout-critical concept. Google
// Sheets is downstream only: an asynchronous human-readable export whose failure
// can grow a backlog but can never decide an athlete-facing response.
//
// ── CONNECTION MODEL ──────────────────────────────────────────────────────────
// Supavisor SESSION mode (port 5432), one connection string per role, read from
// the server environment only. Transaction mode is not usable: the export holds a
// session-level advisory lock across statements, which transaction mode would
// appear to take and actually hold nothing. Those locks SERIALISE work; none of
// them is a liveness authority, and a dropped session is never evidence that an
// external effect died (see SQL.claimWriteReceipt). No service-role key, no anon
// key, no Data API. No credential ever reaches browser code.
//
// ── WHY THE SQL IS EXPORTED ───────────────────────────────────────────────────
// `SQL` below is the exact statement text every operation issues. The
// least-privilege proof (§6.1 P7c) executes THESE strings as the real roles, so a
// grant list and the statement it must permit cannot drift apart. Three
// grant/SQL mismatches already reached review; a statement proven only as
// superuser proves nothing about the deployed system.

const { Pool, types } = require('pg');
const contract = require('./migrationRowContract');

// Pin the DATE parser to the wire text. Left alone, the driver hands back a JS
// Date at the process's local midnight, which shifts a workout's date across the
// date line and would make the sweep report a content_mismatch on every row west
// of Greenwich. NUMERIC already arrives as text and is compared numerically by
// the row contract.
const PG_DATE_OID = 1082;
types.setTypeParser(PG_DATE_OID, (value) => value);

// ── Configuration ─────────────────────────────────────────────────────────────

const ROLE_ENV = Object.freeze({
  app: 'ATLAS_SUPABASE_APP_URL',
  readonly: 'ATLAS_SUPABASE_READONLY_URL',
  migrate: 'ATLAS_SUPABASE_MIGRATE_URL',
  rebuild: 'ATLAS_SUPABASE_REBUILD_URL',
});

const pools = new Map();

function connectionString(role) {
  const key = ROLE_ENV[role];
  if (!key) throw new Error(`Unknown Supabase role: ${role}`);
  return (process.env[key] || '').trim();
}

// Configured means "a connection string exists for the requested role". Runtime
// callers fail closed when the app role is absent; there is no Sheets fallback.
function isConfigured(role = 'app') {
  return connectionString(role).length > 0;
}

// `ATLAS_SUPABASE_SHADOW_WRITE` HAS NO READER IN THIS BUILD. It gated the S2/S3
// shadow lane, which the cutover deleted; the flag survives only in the operational
// status report, where it is published as an environment fact rather than consulted
// as a switch.

function poolFor(role) {
  const url = connectionString(role);
  if (!url) {
    const err = new Error(`Supabase is not configured for role "${role}" (${ROLE_ENV[role]} is unset).`);
    err.code = 'SUPABASE_NOT_CONFIGURED';
    throw err;
  }
  const existing = pools.get(role);
  if (existing && existing.url === url) return existing.pool;
  if (existing) existing.pool.end().catch(() => {});
  const pool = new Pool({
    connectionString: url,
    // Small and bounded: this is a single-owner deployment and the shadow lane
    // must never be able to starve the request path of file descriptors.
    max: Number(process.env.ATLAS_SUPABASE_POOL_MAX || 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.ATLAS_SUPABASE_CONNECT_TIMEOUT_MS || 10_000),
    // An unhandled pool error must never reach the request path.
    allowExitOnIdle: true,
  });
  pool.on('error', (err) => {
    console.warn(JSON.stringify({ level: 'warn', module: 'supabaseAdapter', event: 'pool_error', role, error: err.message }));
  });
  pools.set(role, { url, pool });
  return pool;
}

async function close() {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(entries.map((entry) => entry.pool.end().catch(() => {})));
}

async function withClient(role, fn) {
  const client = await poolFor(role).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// One transaction, one connection, released on every exit path. A ROLLBACK that
// itself throws must not mask the original error, which is why it is swallowed.
async function withTransaction(role, fn) {
  return withClient(role, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err;
    }
  });
}

// ── The exact statement text (see "WHY THE SQL IS EXPORTED") ──────────────────

const SQL = Object.freeze({
  // §5.2 — every shadow transaction begins here. ON CONFLICT DO NOTHING is
  // correct for this table and carries none of the hazard it carries for
  // receipts: workout_sessions is insert-only for IDENTITY, so there is no later
  // state transition for it to discard.
  insertSessionParent: `
    INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (session_id) DO NOTHING`,

  // §3.2. write_id is ALWAYS NULL in S2/S3 (§3.6) — it is not a parameter, so no
  // code path can populate it before the receipt authority exists.
  insertLoggedSet: `
    INSERT INTO atlas.logged_sets
      (session_id, date_clean, exercise, canonical_exercise, muscle_group, lift_code,
       set_number, weight, reps, rir, notes, volume_calc, write_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)
    ON CONFLICT DO NOTHING`,

  // §3.3.
  insertSessionEffort: `
    INSERT INTO atlas.session_effort
      (session_id, effort_date, duration, active_calories, total_calories,
       average_hr, peak_hr, location, notes, write_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
    ON CONFLICT (session_id) DO NOTHING`,

  // §3.4. The revision-collision behaviour is preserved exactly: zero rows
  // returned means a row with that key already exists, and the caller then reads
  // that one row and compares content, ignoring recorded_at.
  insertPlanEvent: `
    INSERT INTO atlas.session_plan_events
      (idempotency_key, session_id, session_date, plan_version, event_type, plan_item_id,
       planned_order, planned_lift_code, movement_pattern, outcome, performed_lift_code,
       closeout_status, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key`,

  // §3.5.
  insertPlanSetRow: `
    INSERT INTO atlas.session_plan_set_recommendations
      (idempotency_key, session_id, session_date, plan_version, plan_item_id, planned_lift_code,
       set_index, target_set_count, target_weight, target_reps, target_rir,
       recommendation_source, supersedes_key, confidence, closeout_write_id, recorded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING idempotency_key`,

  // §3.5 — the seal, as one statement. The IS NULL predicate makes "never
  // re-seal" atomic; a row already sealed under a different closeout_write_id is
  // simply not matched.
  sealPlanSets: `
    UPDATE atlas.session_plan_set_recommendations
       SET closeout_write_id = $2
     WHERE session_id = $1 AND closeout_write_id IS NULL`,

  // §3.6 — the receipt claim. A compare-and-set, never ON CONFLICT DO NOTHING:
  // DO NOTHING would read a 'failed' row as a duplicate, permanently consuming
  // the write_id, and the athlete's retry of a Save that never committed would be
  // refused. That is a lost workout, not a protected one.
  //
  // ── WHAT MAKES AN `in_progress` ROW RECLAIMABLE, AND WHAT DOES NOT ───────────
  //
  // The reclaim condition is OWNER PROCESS IDENTITY. An `in_progress` row owned by
  // a DIFFERENT instance than the claimer's is reclaimable; one owned by THIS
  // instance is refused, because that attempt may still be running.
  //
  // An earlier version used the session-scoped advisory lock for this, and it was
  // UNSOUND. Postgres releases an advisory lock the instant its connection drops,
  // but the Google Sheets request the attempt is awaiting is an independent HTTP
  // call that can still be in flight and can still commit afterwards. A dropped
  // database session is not evidence that an external effect died. A competitor
  // could take the freed lock, claim the receipt, and perform the SAME append —
  // and the attempt token cannot help, because it only stops the first attempt
  // ACKNOWLEDGING in Supabase; it cannot un-append a row from Google Sheets.
  //
  // Process identity carries no such inference: it does not change when a
  // connection drops. This is also the rule the live file store actually uses
  // (services/idempotency.js:159-177) — a record is retryable only when it was
  // REHYDRATED FROM A PRIOR PROCESS, never merely because time passed.
  //
  // PRECONDITION, stated rather than assumed: "a different instance id means that
  // process is gone" is sound under the SINGLE-INSTANCE invariant §5.3/§5.5
  // already require for the cutover. Where more than one instance can run, a
  // different id may be a live sibling — so this rule would then be too weak, and
  // the S4 wiring may not proceed without that invariant enforced. Nothing here
  // depends on it today: the file store remains the sole receipt authority
  // through S2 and S3, and this table has no production caller.
  //
  // The five-minute window is retained as a secondary bound only. It is not the
  // authority either: a slow request is not a dead one.
  //
  // ── AND PROCESS IDENTITY ALONE IS STILL NOT ENOUGH ───────────────────────────
  // *Required review of `deaa8a5`.* A different instance proves the old process is
  // GONE. It does not prove an HTTP request that process already sent to Google
  // Sheets did not commit: Google can accept an append and complete it server-side
  // without the client surviving to record the response. Five minutes of age does
  // not turn an ambiguous post-send outcome into a proven non-write.
  //
  // So the reclaim is EFFECT-AWARE, and the prior-process branch below is gated on
  // `effect_authority = 'supabase'`:
  //
  //   'supabase' — the authoritative effect is one transaction, atomically present
  //     or atomically absent, and the Sheets export mirror is idempotent by an
  //     allocated destination (§3.9, §5.3). A dead process's attempt committed
  //     nothing that a retry could duplicate. Reclaim automatically.
  //
  //   'sheets' — the authoritative effect is a values.append with no allocated
  //     destination and no Supabase constraint able to catch a duplicate. NOTHING
  //     HERE RECLAIMS IT. The claim refuses, and markReceiptAmbiguous moves it to
  //     'ambiguous', where only resolveAmbiguousReceipt — carrying destination-side
  //     proof — can release it. Ambiguous post-send state FAILS CLOSED rather than
  //     automatically repeating.
  //
  // The expired branch excludes 'ambiguous' for the same reason: a 24-hour TTL is
  // another timer, and a timer is exactly the inference being removed.
  claimWriteReceipt: `
    INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt, attempt_token,
                                      owner_instance_id,
                                      created_at, attempt_started_at, expires_at)
    VALUES ($1, $2, $4, 'in_progress', 1, gen_random_uuid(), $3,
            now(), now(), now() + interval '24 hours')
    ON CONFLICT (write_id) DO UPDATE
       SET status             = 'in_progress',
           attempt            = CASE WHEN atlas.write_receipts.expires_at <= now()
                                     THEN 1 ELSE atlas.write_receipts.attempt + 1 END,
           created_at         = CASE WHEN atlas.write_receipts.expires_at <= now()
                                     THEN now() ELSE atlas.write_receipts.created_at END,
           attempt_token      = gen_random_uuid(),
           owner_instance_id  = $3,
           attempt_started_at = now(),
           expires_at         = now() + interval '24 hours',
           session_id         = CASE WHEN atlas.write_receipts.expires_at <= now()
                                     THEN NULL ELSE atlas.write_receipts.session_id END,
           response_body      = NULL,
           rows_written       = NULL,
           appended_range     = NULL,
           completed_at       = NULL
     -- ── ONE write_id IS BOUND TO ONE ROUTE, FOR ITS WHOLE LIFE ────────────────
     -- *Required review of 5533874.* route and effect_authority are written
     -- at INSERT and are NOT in the DO UPDATE list, so without this guard a
     -- write_id first claimed on a transactional route would keep
     -- effect_authority='supabase' when the SAME id was later presented to a
     -- Sheets route — through a client bug, a replay bug, or a namespace
     -- collision. The Sheets append would then be reclaimed automatically after
     -- five minutes instead of being marked ambiguous, which is exactly the
     -- duplicate P16d exists to make impossible.
     --
     -- The binding is a REFUSAL, not a rewrite. Rewriting effect_authority on
     -- retry would erase what kind of effect the PRIOR attempt may already have
     -- sent, which is the one fact the state machine cannot afford to lose.
     -- Both columns are checked: effect_authority is derived from route by the
     -- frozen map, so a disagreement means the map itself changed under a live
     -- receipt — also a case that must refuse rather than reinterpret.
     WHERE atlas.write_receipts.route = $2
       AND atlas.write_receipts.effect_authority = $4
       AND (
           atlas.write_receipts.status = 'failed'
        -- Expired: reclaimable at any status EXCEPT 'ambiguous'. A failed row is a
        -- DECLARED non-write (failWrite ran), not an inferred one, so both
        -- authorities may retry it.
        OR (atlas.write_receipts.expires_at <= now()
            AND atlas.write_receipts.status <> 'ambiguous')
        OR (atlas.write_receipts.status = 'in_progress'
            -- The effect is atomic, so a dead process committed nothing.
            AND atlas.write_receipts.effect_authority = 'supabase'
            -- The owning PROCESS is gone. Not "its database session dropped".
            AND atlas.write_receipts.owner_instance_id IS DISTINCT FROM $3
            AND atlas.write_receipts.attempt_started_at < now() - interval '5 minutes')
       )
    RETURNING attempt_token, attempt, session_id, owner_instance_id, effect_authority`,

  // §3.6 — the SHEETS half of the effect-aware rule, and the only exit an
  // abandoned non-transactional attempt has.
  //
  // A compare-and-set on exactly the condition the claim refuses: a prior
  // process's live attempt on a route whose effect is a Google Sheets append. It
  // does NOT decide whether the append landed — it records that NOBODY KNOWS, and
  // makes that ignorance durable and blocking. Marking is safe to race: two
  // claimers marking the same row produce one mark, and the loser reads it.
  //
  // The token is voided in the same statement. The dead process cannot come back
  // and complete the receipt on the strength of an effect nothing has verified.
  //
  // Route-bound for the same reason the claim is: a claimer arriving on a
  // DIFFERENT route than the one that owns this write_id must change nothing at
  // all — not even to record an ambiguity about an effect it did not send.
  markReceiptAmbiguous: `
    UPDATE atlas.write_receipts
       SET status = 'ambiguous', attempt_token = NULL, ambiguous_at = now()
     WHERE write_id = $1
       AND route = $3
       AND status = 'in_progress'
       AND effect_authority = 'sheets'
       AND owner_instance_id IS DISTINCT FROM $2
       AND attempt_started_at < now() - interval '5 minutes'
    RETURNING owner_instance_id, attempt, attempt_started_at`,

  // §3.6 — the ONLY way out of 'ambiguous', and it takes destination-side proof.
  //
  // $2 is the operator's finding: true when the append is FOUND at the
  // destination, false when the destination is read and it is genuinely ABSENT.
  // $3 is the proof text — what was read, and what it showed — in the same
  // athlete-safe form as migration_divergences.closure_proof. The NOT NULL/non-empty
  // requirement is also a table constraint, so a caller that omits it is refused by
  // the schema rather than by this statement's politeness.
  //
  //   found    → 'completed'. The write landed; a retry must replay the receipt,
  //              not repeat the append.
  //   absent   → 'failed'. A declared non-write, which is retryable exactly like
  //              any other failed attempt.
  //
  // There is deliberately no third outcome. "Still unsure" is not a resolution; it
  // is the state the row is already in.
  resolveAmbiguousReceipt: `
    UPDATE atlas.write_receipts
       SET status          = CASE WHEN $2::boolean THEN 'completed' ELSE 'failed' END,
           ambiguity_proof = $3::text,
           response_body   = CASE WHEN $2::boolean THEN $4::jsonb ELSE NULL END,
           completed_at    = CASE WHEN $2::boolean THEN now() ELSE NULL END
     WHERE write_id = $1 AND status = 'ambiguous'
    RETURNING status, ambiguous_at, ambiguity_proof`,

  // §3.6 — persist the server-minted id under the token guard, immediately after
  // minting and before the workout write. IS NULL means a reused id is never
  // rewritten; the token means an obsolete attempt cannot overwrite a newer one.
  persistReceiptSessionId: `
    UPDATE atlas.write_receipts
       SET session_id = $3
     WHERE write_id = $1 AND attempt_token = $2 AND session_id IS NULL`,

  completeWriteReceipt: `
    UPDATE atlas.write_receipts
       SET status = 'completed', response_body = $3, rows_written = $4,
           appended_range = $5, completed_at = now()
     WHERE write_id = $1 AND attempt_token = $2`,

  // §3.6 — failWrite INVALIDATES the token in the SAME statement. Without it, a
  // late completeWrite carrying the released attempt's token would resurrect a
  // write the system had already released.
  failWriteReceipt: `
    UPDATE atlas.write_receipts
       SET status = 'failed', attempt_token = NULL, completed_at = NULL
     WHERE write_id = $1 AND attempt_token = $2`,

  // §3.6 — read-only, TTL-bounded. An expired row reads as absent, exactly as today.
  //
  // AN 'ambiguous' ROW IS THE ONE EXCEPTION, and it must be: the claim refuses it
  // forever, so if the peek also reported it absent the caller would be refused
  // with a null record and no way to say why. It stays visible past its TTL so the
  // refusal can carry its own explanation to the operator.
  peekWriteReceipt: `
    SELECT write_id, route, effect_authority, session_id, status, attempt, attempt_token,
           response_body, rows_written, appended_range,
           created_at, attempt_started_at, expires_at, completed_at,
           ambiguous_at, ambiguity_proof, owner_instance_id
      FROM atlas.write_receipts
     WHERE write_id = $1 AND (expires_at > now() OR status = 'ambiguous')`,

  // §3.6 — the write_id's OWNING ROUTE, read WITHOUT the TTL filter.
  //
  // Deliberately not peekWriteReceipt. The route binding is about IDENTITY, not
  // about liveness: an expired row is the most permissive reclaim branch there is,
  // so a foreign route arriving at one must still be told it collided rather than
  // handed a silent, unexplained refusal. peekWriteReceipt reports an expired row
  // as absent, exactly as today, and that must not change.
  //
  // Two columns only, so this can never become a second way to read a receipt.
  readReceiptRoute: `
    SELECT route, effect_authority FROM atlas.write_receipts WHERE write_id = $1`,

  // The prune bounds table size. It carries no correctness — the claim above
  // reclaims an expired row atomically, so nothing waits for this to run.
  //
  // IT MUST NEVER DELETE AN 'ambiguous' ROW. Deleting one would leave no row at
  // all, so the next claim would insert a clean receipt and permit the second
  // append — the exact duplicate the ambiguous state exists to prevent, reached by
  // a housekeeping job instead of by a decision. An unresolved effect outlives the
  // TTL by design.
  pruneWriteReceipts: `
    DELETE FROM atlas.write_receipts
     WHERE expires_at <= now() AND status <> 'ambiguous'`,

  // §3.7 — the catalog generation lifecycle.
  // content_hash is written HERE, at attempt time, rather than updated at
  // verification. §8.2 grants atlas_app UPDATE on exactly (status, verified_at,
  // last_error) of this table — no content_hash — so a swap that stamped the hash
  // by UPDATE was permission-denied under its own security model, exactly as the
  // receipt claim was before created_at/expires_at were added to its grant.
  // Writing it at INSERT keeps §8.2's list unchanged AND gives a failed
  // generation better provenance: it records the content it attempted.
  readExerciseCatalog: `
    SELECT exercise, display_exercise, muscle_group, lift_code, canonical_exercise
      FROM atlas.exercise_catalog
     ORDER BY exercise`,

  // ── The coaching inputs (OWNER CORRECTION 2026-08-13) ──────────────────────
  //
  // Coaching notes, typed constraints and the deload state machine. All three are
  // read on the athlete's coaching, recommendation and prescription paths, so none
  // of them may be a synchronous Google Sheets dependency; all three are
  // append-only, exactly as the tabs they replace were.
  //
  // Read OLDEST-FIRST, because every consumer above this layer already parses the
  // header-stripped cell rows a tab returned in sheet order. Reversing them here to
  // "newest first" would be a silent reordering of an input the engine reasons over.
  readCoachingNotes: `
    SELECT note_date, note FROM atlas.coaching_notes ORDER BY id ASC`,
  insertCoachingNote: `
    INSERT INTO atlas.coaching_notes (note_date, note, write_id) VALUES ($1, $2, $3)`,

  readConstraints: `
    SELECT constraint_date, kind, target, rule, note
      FROM atlas.constraints ORDER BY id ASC`,
  insertConstraint: `
    INSERT INTO atlas.constraints (constraint_date, kind, target, rule, note, write_id)
    VALUES ($1, $2, $3, $4, $5, $6)`,

  readDeloadState: `
    SELECT updated_at, training_state, deload_protocol, deload_reason,
           deload_start_date, deload_sessions_remaining, deload_exit_criteria
      FROM atlas.deload_state ORDER BY id ASC`,
  insertDeloadState: `
    INSERT INTO atlas.deload_state (updated_at, training_state, deload_protocol,
      deload_reason, deload_start_date, deload_sessions_remaining, deload_exit_criteria)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,

  // Cardio and conditioning. `/api/log-modality` is an athlete-facing
  // preview → approve → write path with a receipt and the write freeze in front of
  // it, so its store is workout-critical and cannot be Google Sheets.
  readModalityLog: `
    SELECT entry_date, session_id, modality, exercise, duration_sec, distance_m,
           rounds, rest_sec, level, rpe, avg_hr, notes
      FROM atlas.modality_log ORDER BY id ASC`,
  insertModalityLog: `
    INSERT INTO atlas.modality_log (entry_date, session_id, modality, exercise,
      duration_sec, distance_m, rounds, rest_sec, level, rpe, avg_hr, notes, write_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
  coachingInputDestinationCounts: `
    SELECT
      (SELECT count(*)::int FROM atlas.coaching_notes) AS coaching_notes,
      (SELECT count(*)::int FROM atlas.constraints) AS constraints,
      (SELECT count(*)::int FROM atlas.deload_state) AS deload_state,
      (SELECT count(*)::int FROM atlas.modality_log) AS modality_log`,

  // Owner maintenance, as atlas_migrate. An upsert rather than a generation swap:
  // the swap existed to replace a whole PROJECTED generation atomically, and there
  // is no projection to replace. An upsert also means a run that names three
  // exercises changes three rows, which is the smallest safe edit.
  upsertExerciseCatalogRow: `
    INSERT INTO atlas.exercise_catalog
      (exercise, display_exercise, muscle_group, lift_code, canonical_exercise)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (exercise) DO UPDATE
       SET display_exercise   = EXCLUDED.display_exercise,
           muscle_group       = EXCLUDED.muscle_group,
           lift_code          = EXCLUDED.lift_code,
           canonical_exercise = EXCLUDED.canonical_exercise`,
  deleteExerciseCatalogRow: `
    DELETE FROM atlas.exercise_catalog WHERE exercise = $1`,

  // NO STATEMENT IN THIS FILE NAMES `atlas.migration_divergences`, and that is the
  // point rather than an omission. §6.3 P17 requires the table to be provably
  // INERT after the cutover — no writer and no reader on any post-S4 path — and a
  // retained SQL constant is a reader waiting for a caller. The eight statements
  // that opened, listed, claimed, released, closed and summarised a divergence are
  // deleted with the lane that issued them.
  //
  // The sweep's four full-table enumerations went the same way. They read every row
  // of every migrated concept to compare two stores; there is one store now, and a
  // request-scoped read is the only kind this build issues.
  //
  // `deleteLoggedSetByIdentity` went with the repair worker. The one delete the
  // runtime may still issue on workout data is undo's, by `(session_id, write_id)`.

  // The export-state updates of §3.1. Unused before S4; issued here only by the
  // least-privilege proof, so the grant list and the statement cannot drift.
  updateExportState: `
    UPDATE atlas.workout_sessions
       SET sheets_exported_at = $2, sheets_export_attempts = sheets_export_attempts + 1,
           sheets_export_error = $3, sheets_export_state = $4,
           sheets_export_next_attempt_at = $5, export_claim_token = $6
     WHERE session_id = $1`,

  // ══ S4 — the authoritative workout statements ═══════════════════════════════
  //
  // Everything below replaced a Google Sheets call at the cutover. Two conventions
  // run through the whole block, and both are deliberate.
  //
  // A DATE COLUMN IS SELECTED AS TEXT, via to_char. `migrationRowContract` can
  // canonicalise a driver-supplied Date (it takes the UTC face precisely so a
  // machine west of Greenwich does not read the day before), but relying on that
  // makes every read depend on how the driver's date parser happens to be pinned.
  // `YYYY-MM-DD` from the server is the same string the sheet held, so there is no
  // parser in the path at all. `timestamptz` is left native — the contract's
  // TIMESTAMP kind wants an instant, not a calendar day.
  //
  // SESSION MATCHING ON A CHILD TABLE IS CASE-INSENSITIVE, because
  // `logged_sets_identity_key` is a lower(session_id) index and the JavaScript
  // duplicate guards have always compared lower-cased. `atlas.workout_sessions` is
  // matched exactly: it is the primary key and the allocator mints it.

  // ── Identity and duplicate protection ───────────────────────────────────────

  // The allocator's whole input. Scoped to the date being allocated, which is why
  // it is one indexed lookup rather than the union of two whole-column reads
  // (`Effort!B:B` plus `Log_Cleaned!B:G`) it replaced.
  sessionIdsForDate: `
    SELECT session_id
      FROM atlas.workout_sessions
     WHERE session_date = $1
     ORDER BY session_id`,

  // The duplicate-SESSION guard. One row per session in atlas.session_effort IS
  // the guard, so this asks the question directly instead of pulling a column and
  // scanning it in application code.
  effortExistsForSession: `
    SELECT 1
      FROM atlas.session_effort
     WHERE lower(session_id) = lower($1)`,

  // The duplicate-ROW guard, scoped to one session. `exercise` is lower-cased and
  // trimmed here so the key matches the one the caller builds with the same
  // normalisation; `set_number` is an integer column and interpolates identically
  // on both sides.
  loggedSetIdentitiesForSession: `
    SELECT lower(btrim(exercise)) AS exercise, set_number
      FROM atlas.logged_sets
     WHERE lower(session_id) = lower($1)`,

  // ── The Save ────────────────────────────────────────────────────────────────

  // §3.2, post-cutover. The difference from `insertLoggedSet` above is the whole
  // point of S4: `write_id` is a real parameter rather than a hard-coded NULL,
  // because the receipt authority exists now and the S4 foreign key requires the
  // value to name a real receipt. ON CONFLICT DO NOTHING lets the identity index
  // absorb a duplicate set without failing the transaction, and the RETURNING tells
  // the caller which rows were genuinely new.
  insertLoggedSetAuthoritative: `
    INSERT INTO atlas.logged_sets
      (session_id, date_clean, exercise, canonical_exercise, muscle_group, lift_code,
       set_number, weight, reps, rir, notes, volume_calc, write_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT DO NOTHING
    RETURNING id`,

  // §3.3, post-cutover. Same change, same reason. The primary key on session_id is
  // the duplicate-session guard expressed as a constraint.
  insertSessionEffortAuthoritative: `
    INSERT INTO atlas.session_effort
      (session_id, effort_date, duration, active_calories, total_calories,
       average_hr, peak_hr, location, notes, write_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id`,

  // Undo (§6.3 P13). BY `(session_id, write_id)` — never by position and never by
  // range, which is exactly what `deleteRowsByRange` could not promise on a tab
  // whose rows can move. A Save that wrote nothing deletes nothing.
  deleteSaveLoggedSets: `
    DELETE FROM atlas.logged_sets
     WHERE lower(session_id) = lower($1) AND write_id = $2`,

  // Return a session to the export queue after any post-export mutation (§6.3
  // P14f). `blocked` is PRESERVED rather than cleared: a structural refusal is
  // recoverable only through the §5.7 owner rebuild, so an undo or a seal must not
  // quietly hand a blocked session back to the worker that already refused it.
  // Attempts are NOT reset for the same reason — the ceiling is a property of the
  // session's export history, not of its last mutation.
  markSessionForReexport: `
    UPDATE atlas.workout_sessions
       SET sheets_exported_at = NULL,
           export_claim_token = NULL,
           sheets_export_next_attempt_at = NULL,
           sheets_export_state =
             CASE WHEN sheets_export_state = 'blocked' THEN 'blocked' ELSE 'queued' END
     WHERE session_id = $1`,

  // ── The authoritative reads ─────────────────────────────────────────────────
  //
  // ORDER IS THE SHEET'S ORDER, reconstructed. `getSheetRows` returned rows in
  // append order, which for a workout log is chronological, and dozens of callers
  // depend on that — "the tail of the window is the newest work". Ordering by the
  // business date with the surrogate key as tie-break reproduces it deterministically.
  //
  // A `readRecent…` mirrors `getRecentRows(tab, maxRows)`: the LAST maxRows in sheet
  // order. It is expressed as a newest-first inner LIMIT re-sorted ascending, so the
  // database does the trimming — the whole reason a table beats a tab here.

  readAllLoggedSets: `
    SELECT to_char(date_clean, 'YYYY-MM-DD') AS date_clean, session_id, exercise,
           canonical_exercise, muscle_group, lift_code, set_number, weight, reps, rir,
           notes, volume_calc
      FROM atlas.logged_sets
     ORDER BY date_clean ASC NULLS FIRST, id ASC`,

  readRecentLoggedSets: `
    SELECT recent.date_clean, recent.session_id, recent.exercise, recent.canonical_exercise,
           recent.muscle_group, recent.lift_code, recent.set_number, recent.weight,
           recent.reps, recent.rir, recent.notes, recent.volume_calc
      FROM (
        SELECT to_char(date_clean, 'YYYY-MM-DD') AS date_clean, session_id, exercise,
               canonical_exercise, muscle_group, lift_code, set_number, weight, reps, rir,
               notes, volume_calc, date_clean AS sort_date, id
          FROM atlas.logged_sets
         ORDER BY sort_date DESC NULLS LAST, id DESC
         LIMIT $1
      ) recent
     ORDER BY recent.sort_date ASC NULLS FIRST, recent.id ASC`,

  readLoggedSetsForSession: `
    SELECT to_char(date_clean, 'YYYY-MM-DD') AS date_clean, session_id, exercise,
           canonical_exercise, muscle_group, lift_code, set_number, weight, reps, rir,
           notes, volume_calc
      FROM atlas.logged_sets
     WHERE lower(session_id) = lower($1)
     ORDER BY date_clean ASC NULLS FIRST, id ASC`,

  // `session_effort` has no surrogate key — one row per session IS its identity —
  // so the session id is the tie-break.
  readAllEffort: `
    SELECT to_char(effort_date, 'YYYY-MM-DD') AS effort_date, session_id, duration,
           active_calories, total_calories, average_hr, peak_hr, location, notes
      FROM atlas.session_effort
     ORDER BY effort_date ASC NULLS FIRST, session_id ASC`,

  readRecentEffort: `
    SELECT recent.effort_date, recent.session_id, recent.duration, recent.active_calories,
           recent.total_calories, recent.average_hr, recent.peak_hr, recent.location,
           recent.notes
      FROM (
        SELECT to_char(effort_date, 'YYYY-MM-DD') AS effort_date, session_id, duration,
               active_calories, total_calories, average_hr, peak_hr, location, notes,
               effort_date AS sort_date
          FROM atlas.session_effort
         ORDER BY sort_date DESC NULLS LAST, session_id DESC
         LIMIT $1
      ) recent
     ORDER BY recent.sort_date ASC NULLS FIRST, recent.session_id ASC`,

  // The plan ledgers order by the app-supplied `recorded_at` rather than by
  // `created_at`: a batch appended in one transaction shares a single `now()`, so
  // `created_at` cannot order within it, while `recorded_at` is the logical
  // sequence the reader's last-wins fold has always used.
  readAllPlanEvents: `
    SELECT idempotency_key, session_id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
           plan_version, event_type, plan_item_id, planned_order, planned_lift_code,
           movement_pattern, outcome, performed_lift_code, closeout_status, recorded_at
      FROM atlas.session_plan_events
     ORDER BY recorded_at ASC NULLS FIRST, created_at ASC, idempotency_key ASC`,

  readPlanEventsForSession: `
    SELECT idempotency_key, session_id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
           plan_version, event_type, plan_item_id, planned_order, planned_lift_code,
           movement_pattern, outcome, performed_lift_code, closeout_status, recorded_at
      FROM atlas.session_plan_events
     WHERE lower(session_id) = lower($1)
     ORDER BY recorded_at ASC NULLS FIRST, created_at ASC, idempotency_key ASC`,

  // `plan_version` is the INTEGER revision counter on this table (it is an opaque
  // `pv_…` token on the event table — same name, different dimension, never joined),
  // so ordering by it puts a revision after the row it supersedes.
  readAllPlanSetRows: `
    SELECT idempotency_key, session_id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
           plan_version, plan_item_id, planned_lift_code, set_index, target_set_count,
           target_weight, target_reps, target_rir, recommendation_source, supersedes_key,
           confidence, closeout_write_id, recorded_at
      FROM atlas.session_plan_set_recommendations
     ORDER BY recorded_at ASC NULLS FIRST, plan_version ASC, set_index ASC, idempotency_key ASC`,

  readPlanSetRowsForSession: `
    SELECT idempotency_key, session_id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
           plan_version, plan_item_id, planned_lift_code, set_index, target_set_count,
           target_weight, target_reps, target_rir, recommendation_source, supersedes_key,
           confidence, closeout_write_id, recorded_at
      FROM atlas.session_plan_set_recommendations
     WHERE lower(session_id) = lower($1)
     ORDER BY recorded_at ASC NULLS FIRST, plan_version ASC, set_index ASC, idempotency_key ASC`,

  // ── The export destination authority (§3.9, §5.4) ───────────────────────────

  // §5.4 mechanism 1 — THE DERIVED QUEUE, as one statement.
  //
  // The obligation is derived from the `session_closeout` event itself, so nothing
  // extra is written at closeout and nothing extra can be lost. The other three
  // predicates are what keep the queue from containing work no worker can advance:
  // an exported session is done, a `blocked` session is owner-action-required and
  // consumes zero further Sheets reads, and a backed-off session is not yet due.
  //
  // `FOR UPDATE SKIP LOCKED` stops two workers doing the same redundant work. It is
  // NOT fencing and must never be described as such (§5.4 mechanism 2) — an HTTP
  // request already sent to Google cannot be recalled by a Postgres lock. Exactness
  // comes from the deterministic destination, not from here.
  claimExportSession: `
    WITH candidate AS (
      SELECT s.session_id
        FROM atlas.workout_sessions s
       WHERE s.sheets_exported_at IS NULL
         AND s.sheets_export_state <> 'blocked'
         AND (s.sheets_export_next_attempt_at IS NULL
              OR s.sheets_export_next_attempt_at <= now())
         AND EXISTS (
               SELECT 1
                 FROM atlas.session_plan_events e
                WHERE e.session_id = s.session_id
                  AND e.event_type = 'session_closeout')
       ORDER BY s.sheets_export_next_attempt_at ASC NULLS FIRST, s.session_id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE atlas.workout_sessions t
       SET export_claim_token = gen_random_uuid()
      FROM candidate
     WHERE t.session_id = candidate.session_id
    RETURNING t.session_id,
              to_char(t.session_date, 'YYYY-MM-DD') AS session_date,
              t.export_claim_token,
              t.sheets_export_attempts,
              t.sheets_export_state`,

  // The existing reservation. A re-export MUST reuse it: reallocating would move
  // the session's rows and strand the block it already wrote into.
  readMirrorAllocations: `
    SELECT tab, session_id, start_row, row_count, end_row
      FROM atlas.sheets_mirror_allocations
     WHERE session_id = $1
     ORDER BY tab`,

  // §3.9 — atomic fetch-and-add against the one row that serialises a tab, then the
  // durable reservation, in a single statement. The cursor row lock is what makes
  // two DIFFERENT sessions receive disjoint blocks; the exclusion constraint on the
  // allocation table makes an overlap unrepresentable even if this were wrong.
  allocateMirrorBlock: `
    WITH bumped AS (
      UPDATE atlas.sheets_mirror_cursor
         SET next_row = next_row + $2
       WHERE tab = $1
      RETURNING next_row - $2 AS start_row
    )
    INSERT INTO atlas.sheets_mirror_allocations (tab, session_id, start_row, row_count)
    SELECT $1, $3, bumped.start_row, $2 FROM bumped
    RETURNING start_row, row_count, end_row`,

  readMirrorCursor: `
    SELECT tab, next_row, base_established_at
      FROM atlas.sheets_mirror_cursor
     ORDER BY tab`,

  // The one-time cutover handshake of §5.4 step 4. GREATEST keeps the cursor
  // MONOTONIC — re-running the handshake against a tab that has since grown must
  // never hand out rows that are already occupied.
  seedMirrorCursor: `
    INSERT INTO atlas.sheets_mirror_cursor (tab, next_row, base_established_at)
    VALUES ($1, $2, now())
    ON CONFLICT (tab) DO UPDATE
       SET next_row = GREATEST(atlas.sheets_mirror_cursor.next_row, EXCLUDED.next_row),
           base_established_at =
             COALESCE(atlas.sheets_mirror_cursor.base_established_at, EXCLUDED.base_established_at)`,

  // Acknowledgement, guarded by the claim token (§3.1). A superseded worker holds a
  // token that no longer matches, so its late acknowledgement matches zero rows and
  // cannot mark a session exported on the strength of a stale observation. This is
  // the ONLY statement that sets `sheets_exported_at`.
  acknowledgeExport: `
    UPDATE atlas.workout_sessions
       SET sheets_exported_at = now(),
           sheets_export_attempts = sheets_export_attempts + 1,
           sheets_export_error = NULL,
           sheets_export_state = 'queued',
           sheets_export_next_attempt_at = NULL,
           export_claim_token = NULL
     WHERE session_id = $1 AND export_claim_token = $2
    RETURNING session_id`,

  // The classified failure (§5.4 mechanism 1). The CALLER decides `state` and
  // `nextAttemptAt` from the declared policy; this statement records the decision
  // and releases the claim. `sheets_exported_at` is untouched, so the session stays
  // in the derived queue unless the state it was given removes it.
  recordExportFailure: `
    UPDATE atlas.workout_sessions
       SET sheets_export_attempts = sheets_export_attempts + 1,
           sheets_export_error = $3,
           sheets_export_state = $4,
           sheets_export_next_attempt_at = $5,
           export_claim_token = NULL
     WHERE session_id = $1 AND export_claim_token = $2
    RETURNING session_id, sheets_export_attempts, sheets_export_state,
              sheets_export_next_attempt_at, sheets_export_error`,

  // What `npm run atlas:status` reports so a stalled mirror is visible rather than
  // silent. The blocked count is separated from the owed count because they need
  // different actions: one waits, the other needs the owner.
  exportBacklog: `
    SELECT
      count(*) FILTER (WHERE s.sheets_export_state <> 'blocked')::int AS sessions_owed,
      count(*) FILTER (WHERE s.sheets_export_state = 'blocked')::int  AS sessions_blocked,
      to_char(min(s.session_date) FILTER (WHERE s.sheets_export_state <> 'blocked'),
              'YYYY-MM-DD') AS oldest_session_date,
      (array_agg(s.session_id ORDER BY s.session_date ASC, s.session_id ASC)
         FILTER (WHERE s.sheets_export_state <> 'blocked'))[1] AS oldest_session_id
      FROM atlas.workout_sessions s
     WHERE s.sheets_exported_at IS NULL
       AND EXISTS (
             SELECT 1
               FROM atlas.session_plan_events e
              WHERE e.session_id = s.session_id
                AND e.event_type = 'session_closeout')`,

  listBlockedExports: `
    SELECT session_id, to_char(session_date, 'YYYY-MM-DD') AS session_date,
           sheets_export_error, sheets_export_attempts, sheets_export_state,
           sheets_export_next_attempt_at
      FROM atlas.workout_sessions
     WHERE sheets_export_state = 'blocked'
     ORDER BY session_date ASC, session_id ASC`,

  // §3.10 — the write-admission read, issued once per affected write request.
  //
  // DELIBERATELY UNBOUNDED: no LIMIT, no WHERE. The caller must be able to tell
  // "exactly one row" from "no rows" and from "more than one row", because §5.3
  // makes all three of the last two FROZEN. A `LIMIT 1` would silently convert a
  // two-row table — a state the CHECK (id) primary key should make impossible, and
  // therefore a state that means something has gone wrong — into a confident
  // answer. The control must never be confident about a table it does not
  // recognise.
  //
  // Every column is selected so the caller can validate the row's SHAPE rather
  // than trust it; a malformed row is frozen too.
  readWriteFreeze: `
    SELECT id, frozen, reason, set_by, set_at
      FROM atlas.write_freeze`,
});

// ── Session parent, then children, in ONE transaction ─────────────────────────

async function insertSessionParent(client, sessionId) {
  const parsed = contract.parseSessionId(sessionId);
  if (!parsed) {
    const err = new Error(`session_id "${sessionId}" does not match the YYYYMMDD-{AM|PM}-NN contract.`);
    err.code = 'SESSION_ID_UNPARSEABLE';
    throw err;
  }
  await client.query(SQL.insertSessionParent, [
    parsed.session_id,
    parsed.session_date,
    parsed.period,
    parsed.slot,
  ]);
  return parsed;
}

// ── THE S2 SHADOW LANE, THE SWEEP AND THE DIVERGENCE REPAIR ARE GONE ─────────
//
// Design §5.4: S4 deletes every consumer and writer of `atlas.migration_divergences`.
//
// All of it existed for ONE window — the one where Google Sheets was the authority
// and Supabase held a copy nothing read. In that window a shadow write mirrored
// each committed append, a sweep compared the two stores row by row, a divergence
// row recorded every disagreement, and a repair worker closed it.
//
// Supabase IS the authority now, so there is no second store to disagree with it. A
// shadow write would be the authority writing to itself, a sweep would compare a
// table with itself, and a divergence between one authority and nothing is not a
// concept at all. Retaining any of them would be permanent reconciliation logic
// around competing authorities, which is exactly what the architectural ruling in
// CLAUDE.md forbids.
//
// THE TABLE ITSELF SURVIVES, INERT, and that is deliberate rather than an oversight
// (§5.5). A rollback restores the previously merged S3 build, whose shadow lane,
// sweep and repair worker query `atlas.migration_divergences` continuously — so
// dropping it here would leave a revert one statement away from querying a table
// that no longer exists. The drop ships as an owner-run artifact at
// `supabase/operations/drop_migration_divergences.sql`, executed after the rollback
// window closes, and the repository’s reproducible schema converges through the
// one bounded cleanup PR ruling D8 approved. THIS BUILD HAS NO WRITER AND NO READER
// FOR IT.
//
// The S3 backfill went with them — §5.3 was its whole window — and so did
// `listConcept`, which existed only to enumerate a concept for the sweep.

// ── The exercise catalog (§3.7) — SUPABASE IS THE SOLE AUTHORITY ──────────────
//
// OWNER CORRECTION 2026-08-13, recorded in docs/ATLAS_V1_EXECUTION_PLAN.md. It
// supersedes ruling D1, which kept Google Sheets as the EDITING authority and made
// this content a freshness-bounded projection of a Sheets tab.
//
// WHAT WAS DELETED, AND WHY. The sync, the generation, the content hash, the
// verified timestamp, CATALOG_MIRROR_MAX_AGE and the currency verdict all existed
// to answer one question: how stale is our copy of a Google Sheets tab. Under D1
// the answer could fail an athlete Save closed with a 503 — so a Google Sheets
// quota exhaustion could block a workout through a chain of four links. The owner
// ruled that a Sheets quota of any kind must not block an active workout. There is
// no upstream, so there is no staleness, so there is no clock.
//
// There is deliberately NO fallback from Supabase to Sheets. One winner.

/**
 * The one catalog read, and it is on the athlete Save path. The only way it fails
 * is that Supabase itself is unreachable — the same failure mode as every other
 * authoritative read on that path, handled the same way.
 */
async function readExerciseCatalog(role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.readExerciseCatalog);
    return result.rows;
  });
}

// ── The coaching inputs (OWNER CORRECTION 2026-08-13) ────────────────────────
//
// Six operations, three concepts, one shape each way: a read returns the concept's
// rows in the tab's column order, and an append takes one row. They are separate
// functions rather than one generic table accessor because a generic one would be a
// second way to reach any table in the schema, which is precisely what the
// least-privilege model exists to prevent.

async function coachingNotes(role = 'app') {
  return withClient(role, async (client) => (await client.query(SQL.readCoachingNotes)).rows);
}

// `role` is 'app' for every runtime write. The ONE other caller is the one-time
// owner-run transition (`scripts/atlas-coaching-inputs-transition.js`), which runs as
// `atlas_migrate` — the maintenance principal — so a carry-over can never be
// performed by the runtime credential.
async function appendCoachingNote({ date, note, writeId = null, role = 'app' }) {
  return withClient(role, async (client) => {
    await client.query(SQL.insertCoachingNote, [date, note, writeId]);
    return { inserted: 1 };
  });
}

async function constraints(role = 'app') {
  return withClient(role, async (client) => (await client.query(SQL.readConstraints)).rows);
}

async function appendConstraint({ date, kind, target, rule, note = '', writeId = null, role = 'app' }) {
  return withClient(role, async (client) => {
    await client.query(SQL.insertConstraint, [date, kind, target, rule, note, writeId]);
    return { inserted: 1 };
  });
}

async function deloadStateRows(role = 'app') {
  return withClient(role, async (client) => (await client.query(SQL.readDeloadState)).rows);
}

async function appendDeloadStateRow(cells, role = 'app') {
  return withClient(role, async (client) => {
    await client.query(SQL.insertDeloadState, cells);
    return { inserted: 1 };
  });
}

async function modalityLogRows(role = 'app') {
  return withClient(role, async (client) => (await client.query(SQL.readModalityLog)).rows);
}

async function appendModalityLogRow(cells, writeId = null, role = 'app') {
  return withClient(role, async (client) => {
    await client.query(SQL.insertModalityLog, [...cells, writeId]);
    return { inserted: 1 };
  });
}

/**
 * One-time pre-cutover carry-over of all four legacy input tabs.
 *
 * The empty-destination check and every insert share ONE transaction. If any
 * destination is non-empty, or any insert fails, none of the four concepts moves.
 * A partial constraints import must never look like a complete safety-input cutover.
 */
async function transitionCoachingInputs({
  coachingNotes = [], constraints: constraintRows = [], deloadState = [], modalityLog = [],
} = {}, role = 'migrate') {
  return withTransaction(role, async (client) => {
    const counts = (await client.query(SQL.coachingInputDestinationCounts)).rows[0] || {};
    const occupied = Object.entries(counts).filter(([, count]) => Number(count) > 0);
    if (occupied.length) {
      const error = new Error(`coaching input destination is not empty: ${occupied.map(([name]) => name).join(', ')}`);
      error.code = 'COACHING_INPUT_DESTINATION_NOT_EMPTY';
      throw error;
    }

    for (const row of coachingNotes) {
      await client.query(SQL.insertCoachingNote, [row.date, row.note, null]);
    }
    for (const row of constraintRows) {
      await client.query(SQL.insertConstraint, [row.date, row.kind, row.target, row.rule, row.note || '', null]);
    }
    for (const cells of deloadState) await client.query(SQL.insertDeloadState, cells);
    for (const cells of modalityLog) await client.query(SQL.insertModalityLog, [...cells, null]);

    return {
      coaching_notes: coachingNotes.length,
      constraints: constraintRows.length,
      deload_state: deloadState.length,
      modality_log: modalityLog.length,
    };
  });
}

/**
 * The ONLY mutation path for the catalog, and it runs as `atlas_migrate` — a role
 * that is never configured in the server runtime, so no request path can reach it.
 * Its single consumer is `npm run atlas:catalog` (scripts/atlas-catalog-admin.js),
 * which is a dry run unless the operator passes `--apply`.
 *
 * One transaction: a maintenance run either applies wholly or changes nothing, so
 * a half-applied edit can never be the state a Save reads.
 */
// The role is a DEFAULT PARAMETER, never a hard-coded literal, for the same
// reason `pruneWriteReceipts` uses one: test/supabaseRoleSeparation.test.js proves
// that no adapter operation hard-codes a privileged connection, so the privileged
// roles have no request path. A literal here would give the runtime a standing
// route to a role that can rewrite the catalog, which is exactly what the owner
// correction's "explicitly owner-controlled mutation" forbids.
async function applyCatalogMaintenance({ upserts = [], deletes = [] } = {}, role = 'migrate') {
  return withTransaction(role, async (client) => {
    let upserted = 0;
    for (const row of upserts) {
      await client.query(SQL.upsertExerciseCatalogRow, [
        row.exercise, row.display_exercise, row.muscle_group, row.lift_code,
        row.canonical_exercise,
      ]);
      upserted += 1;
    }
    let deleted = 0;
    for (const key of deletes) {
      const result = await client.query(SQL.deleteExerciseCatalogRow, [key]);
      deleted += result.rowCount;
    }
    return { upserted, deleted };
  });
}

// ── Write freeze (§3.10) ──────────────────────────────────────────────────────
//
// WIRED IN S3, and the ONLY operation in this module that a live athlete-facing
// request depends on. It returns the RAW rows — it renders no verdict, applies no
// default, and swallows no error — because the fail-closed decision belongs in one
// place (services/writeFreeze.js) and a second interpreter here would be a second
// authority over the same question.
//
// A throw is the honest outcome for an unreachable or unconfigured database. The
// control turns it into a refusal; this function does not decide.
async function readWriteFreeze(role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.readWriteFreeze);
    return result.rows;
  });
}

// ── Write receipts (§3.6) ─────────────────────────────────────────────────────
//
// WIRED IN S4. `atlas.write_receipts` is the sole receipt/idempotency authority for
// workout writes. Claim, complete, fail, and replay all execute against Supabase;
// the former file-backed receipt store is no longer a production authority.
//
// THE PROCESS THAT OWNS AN ATTEMPT.
//
// Minted once per process. The random suffix matters: a pid is reused after a
// restart, and reusing an id would make a dead process's row look like this
// process's own and wedge the write_id permanently.
//
// This value is the liveness evidence in the claim above. It is deliberately NOT
// derived from anything about the database connection.
const INSTANCE_ID = `${require('os').hostname()}:${process.pid}:${require('crypto').randomBytes(6).toString('hex')}`;

// A receipt anomaly must be visible to an operator, and logging must never throw
// into a write path.
function warn(event, fields) {
  try {
    console.warn(JSON.stringify({ level: 'warn', module: 'supabaseAdapter', event, ...fields }));
  } catch {
    /* logging must never throw into the write path */
  }
}

// WHERE EACH ROUTE'S AUTHORITATIVE EFFECT LANDS — the seven beginWrite callers of
// ruling D4, and nothing else.
//
// This is a declaration, not a derivation. The reclaim rule in
// SQL.claimWriteReceipt is only as sound as this map, so it is frozen, exhaustive,
// and keyed on the exact endpoint strings the routes already pass to beginWrite.
//
// 'supabase' is the PERMISSIVE value — it authorises automatic retry after a
// process death — so an unrecognised route must never fall into it by default.
const ROUTE_EFFECT_AUTHORITY = Object.freeze({
  // The migrated hot path. After S4 the authoritative effect is one Supabase
  // transaction, and the Sheets export is a mirror written into an allocated
  // destination (§3.9), so a repeat overwrites its own cells.
  '/api/log-workout': 'supabase',
  '/api/complete-workout': 'supabase',
  '/api/log-workout/undo-last': 'supabase',
  // TWO OF THE FOUR D4 ROUTES MOVED THEIR DATA TOO (OWNER CORRECTION 2026-08-13).
  // Coaching notes and typed constraints are prescription inputs, so they became
  // Supabase concepts — and once the effect is a transaction, it is atomically
  // present or atomically absent, which is exactly what makes a dead process's
  // attempt safely retryable. Leaving them declared 'sheets' would keep them in the
  // ambiguous state for an append that no longer happens.
  '/api/coaching-notes': 'supabase',
  '/api/constraints': 'supabase',
  // Cardio and conditioning is a WORKOUT, logged through the same
  // preview → approve → write loop, so its store moved too.
  '/api/log-modality': 'supabase',
  // THE ONE REMAINING SHEETS EFFECT, and it is the reason the effect-aware rule
  // still has a live member. `POST /api/bodyweight` appends to its own Google Sheets
  // tab with no allocated destination and nothing able to catch a duplicate, and an
  // append already sent to Google cannot be recalled — so process death leaves it
  // AMBIGUOUS rather than retryable. Bodyweight is a body-metric surface: no
  // recommendation, coaching, substitution, prescription, preview, approval, Save,
  // closeout, retry or undo path reads that tab (the bodyweight history the state
  // assembler derives comes from LOGGED SETS, not from it), so it is outside the
  // workout-critical boundary and stays Sheets-owned.
  '/api/bodyweight': 'sheets',
});

// FAIL CLOSED ON AN UNKNOWN ROUTE. A new write caller must declare where its
// effect lands before it can claim a receipt. Defaulting either way is wrong:
// 'supabase' would silently grant automatic retry to a non-transactional effect,
// and 'sheets' would let a caller reach a blocking state nobody designed for.
function effectAuthorityForRoute(route) {
  const authority = ROUTE_EFFECT_AUTHORITY[route];
  if (!authority) {
    throw new Error(
      `[supabase-adapter] no declared effect authority for write route "${route}" — ` +
      'add it to ROUTE_EFFECT_AUTHORITY before this route claims a write receipt'
    );
  }
  return authority;
}

// ONE attempt, ONE pinned connection, from claim to release.
//
// ── WHAT THE ADVISORY LOCK IS FOR, AND WHAT IT IS NOT ────────────────────────
// It SERIALISES concurrent claimers of one write_id inside a process, so two
// in-flight requests do not race the same row. That is throughput, not safety.
//
// IT IS NOT THE LIVENESS AUTHORITY, and it must never be described as one again.
// Postgres releases an advisory lock the instant its connection drops, while the
// Google Sheets request the attempt is awaiting is an independent HTTP call that
// can still be in flight and can still commit. Treating a dropped database
// session as proof that an external effect died let a competitor take the freed
// lock and perform the SAME append — and the attempt token cannot help, because
// it only stops the first attempt ACKNOWLEDGING in Supabase; it cannot un-append
// a row from Google Sheets. The reclaim decision now rests on OWNER PROCESS
// IDENTITY (see SQL.claimWriteReceipt), which a dropped connection does not change.
//
// `ops` are the token-guarded transitions bound to the same pinned connection.
// The attempt may not migrate to another backend mid-flight.
async function withWriteAttempt(writeId, route, fn) {
  return withClient('app', async (client) => {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [writeId]);
    if (!lock.rows[0].acquired) {
      // Another claimer in THIS process holds the row right now. Refusing is the
      // safe direction, and it is a statement about contention, not about death.
      return fn({ acquired: false, duplicate: true, reason: 'attempt_in_progress_here' }, null);
    }
    try {
      const authority = effectAuthorityForRoute(route);
      const claim = await client.query(SQL.claimWriteReceipt, [writeId, route, INSTANCE_ID, authority]);
      let attempt;
      if (claim.rowCount === 0) {
        // A ROUTE COLLISION IS NOT A DUPLICATE, and must not be answered like one.
        //
        // *Required review of `5533874`.* This write_id already belongs to another
        // route. The refusal happens BEFORE anything else: no ambiguity is
        // recorded (this claimer sent no effect to record), and the stored record
        // is deliberately WITHHELD so no caller can replay a foreign route's
        // response body as if it were its own.
        //
        // Read WITHOUT the TTL filter. An expired row is the most permissive
        // reclaim branch there is, so a foreign route arriving at one must still
        // be told it collided rather than handed a silent, unexplained refusal.
        const owning = await client.query(SQL.readReceiptRoute, [writeId]);
        const owner = owning.rows[0] || null;
        if (owner && owner.route !== route) {
          warn('write_receipt_route_conflict', {
            write_id: writeId, requested_route: route, stored_route: owner.route,
            stored_effect_authority: owner.effect_authority,
          });
          attempt = {
            acquired: true,
            duplicate: true,
            routeConflict: true,
            record: null,
            requestedRoute: route,
            storedRoute: owner.route,
            ambiguous: false,
            markedAmbiguousNow: false,
          };
        } else {
          // A genuine refusal on this write_id's own route. Before reporting a
          // plain duplicate, ask whether this is the case the claim CANNOT decide:
          // a prior process's live attempt whose Google Sheets append may or may
          // not have landed. If it is, record the ignorance durably — the row
          // becomes 'ambiguous' and stops being retryable by anything except
          // destination-side proof.
          //
          // Compare-and-set, so this is safe to race and is a no-op on every other
          // shape of duplicate (fresh, completed, already ambiguous).
          const marked = await client.query(SQL.markReceiptAmbiguous, [writeId, INSTANCE_ID, route]);
          const after = await client.query(SQL.peekWriteReceipt, [writeId]);
          const current = after.rows[0] || null;
          attempt = {
            acquired: true,
            duplicate: true,
            routeConflict: false,
            record: current,
            // True whenever the caller is looking at an unresolved external effect —
            // whether this claim marked it or found it already marked. The route may
            // not retry, and it may not report success either.
            ambiguous: current ? current.status === 'ambiguous' : false,
            markedAmbiguousNow: marked.rowCount > 0,
          };
        }
      } else {
        attempt = { acquired: true, duplicate: false, ...claim.rows[0] };
      }
      const ops = {
        persistSessionId: async (sessionId) => {
          const r = await client.query(SQL.persistReceiptSessionId, [writeId, attempt.attempt_token, sessionId]);
          return r.rowCount > 0;
        },
        complete: async (responseBody, rowsWritten = null, appendedRange = null) => {
          const r = await client.query(SQL.completeWriteReceipt, [
            writeId, attempt.attempt_token,
            responseBody ? JSON.stringify(responseBody) : null, rowsWritten, appendedRange,
          ]);
          return r.rowCount > 0;
        },
        fail: async () => {
          const r = await client.query(SQL.failWriteReceipt, [writeId, attempt.attempt_token]);
          return r.rowCount > 0;
        },
      };
      return await fn(attempt, ops);
    } finally {
      // Released on every exit path — success, failure, duplicate, refusal, throw —
      // BEFORE the connection returns to the pool. A lock released only on the
      // happy path leaks on precisely the paths that matter, and a leaked lock
      // would falsely serialise a later request behind nothing.
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [writeId]);
      } catch {
        /* the connection is going back to the pool either way */
      }
    }
  });
}

// The token-guarded transitions, also available OUT of an attempt — a superseded
// attempt's late completion must be discardable, and proving that discard (P8,
// P8c) requires issuing it from outside the attempt that owns the connection.
async function persistReceiptSessionId(writeId, attemptToken, sessionId) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.persistReceiptSessionId, [writeId, attemptToken, sessionId]);
    return result.rowCount > 0;
  });
}

async function completeWriteReceipt(writeId, attemptToken, responseBody, rowsWritten = null, appendedRange = null) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.completeWriteReceipt, [
      writeId, attemptToken, responseBody ? JSON.stringify(responseBody) : null, rowsWritten, appendedRange,
    ]);
    return result.rowCount > 0;
  });
}

async function failWriteReceipt(writeId, attemptToken) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.failWriteReceipt, [writeId, attemptToken]);
    return result.rowCount > 0;
  });
}

// THE ONLY EXIT FROM 'ambiguous', and it is deliberately not automatic.
//
// `landed` is a FINDING, not a guess: the caller has read the destination tab and
// either found the row or established it is absent. `proof` records what was read,
// so a later reader can tell a verified resolution from an assumed one — the same
// discipline migration_divergences.closure_proof enforces.
//
// This has no production caller in S2, and it will not acquire one silently: S4
// wires the receipt authority, and until then the file store decides everything.
// What S2 owes is that the state exists, that it blocks, and that nothing but this
// releases it.
async function resolveAmbiguousReceipt(writeId, landed, proof, responseBody = null) {
  if (typeof landed !== 'boolean') {
    throw new Error('[supabase-adapter] resolveAmbiguousReceipt requires an explicit landed finding');
  }
  if (typeof proof !== 'string' || proof.trim() === '') {
    // Refused here AND by write_receipts_ambiguity_needs_proof_check. The
    // constraint is the authority; this is the readable error.
    throw new Error('[supabase-adapter] resolveAmbiguousReceipt requires destination-side proof text');
  }
  return withClient('app', async (client) => {
    const result = await client.query(SQL.resolveAmbiguousReceipt, [
      writeId, landed, proof.trim(),
      landed && responseBody ? JSON.stringify(responseBody) : null,
    ]);
    return result.rows[0] || null;
  });
}

async function peekWriteReceipt(writeId) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.peekWriteReceipt, [writeId]);
    return result.rows[0] || null;
  });
}

// THE PRUNE IS NOT A RUNTIME OPERATION, and the grants are what say so.
//
// §3.6 demotes the prune: it bounds table size and carries no correctness,
// because the claim statement reclaims an expired row atomically and nothing
// waits for cleanup. §8.2 then gives atlas_app no DELETE on write_receipts at
// all — deliberately, since a runtime role that could delete a receipt could
// erase duplicate protection. The two together mean the prune must run as a
// principal that is not the server.
//
// atlas_migrate is the only declared role holding DELETE here, so the prune runs
// as an operator job under that credential. Proven both ways by §6.1 P7c: the
// statement succeeds as atlas_migrate and is REFUSED as atlas_app.
//
// Recorded as a finding on this PR: §3.6 describes "a periodic job" without
// naming its principal, and §8.2's grant list makes atlas_app the wrong one.
// Nothing here is blocked by that — the prune has no consumer until S4 — but S4
// must not assume the runtime can call it.
async function pruneWriteReceipts(role = 'migrate') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.pruneWriteReceipts);
    return { deleted: result.rowCount };
  });
}

// ══ S4 — the authoritative workout operations ═══════════════════════════════
//
// Each function below is the sole authority for what it answers. Every one of
// them replaced a Google Sheets call, and the ROW SHAPE they return is the
// canonical row of services/migrationRowContract.js — the same contract the
// export uses to project a row back into its owner-approved column order. One
// mapping, used in both directions, so the authority and its human-readable
// export can never disagree about what a column means.

/** Session ids already occupied on a date. The allocator's whole input. */
async function sessionIdsForDate(sessionDate, role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.sessionIdsForDate, [sessionDate]);
    return result.rows.map((row) => row.session_id);
  });
}

/** True when this session already has an Effort row — the duplicate-session guard. */
async function effortExistsForSession(sessionId, role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.effortExistsForSession, [sessionId]);
    return result.rowCount > 0;
  });
}

/**
 * The identity keys this session already holds, as `exercise||set_number` lower-cased
 * — the same shape `getLogCompositeKeys()` produced, scoped to one session because a
 * table can be queried and a tab cannot.
 */
async function loggedSetIdentitiesForSession(sessionId, role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.loggedSetIdentitiesForSession, [sessionId]);
    return new Set(result.rows.map((row) => `${row.exercise}||${row.set_number}`));
  });
}

/**
 * THE AUTHORITATIVE SAVE. One transaction: the session parent, then its logged
 * sets, then its Effort row.
 *
 * ATOMIC BY CONSTRUCTION (§6.3 P12). Either the whole Save commits or none of it
 * does — there is no partial session to leave behind, and no "12 of 20 rows
 * appended" state for a later read to misinterpret. That is the property a
 * sequence of Sheets appends could never provide.
 *
 * `write_id` is stamped on every child row, which is what makes undo exact
 * (§6.3 P13) and what the two S4 foreign keys enforce.
 */
async function saveWorkout({ sessionId, writeId, loggedSets = [], effort = null }) {
  return withTransaction('app', async (client) => {
    await insertSessionParent(client, sessionId);

    const insertedSetIds = [];
    let skippedDuplicateSets = 0;
    for (const row of loggedSets) {
      const result = await client.query(SQL.insertLoggedSetAuthoritative, [
        sessionId, row.date_clean, row.exercise, row.canonical_exercise, row.muscle_group,
        row.lift_code, row.set_number, row.weight, row.reps, row.rir, row.notes,
        row.volume_calc, writeId,
      ]);
      if (result.rowCount > 0) insertedSetIds.push(result.rows[0].id);
      else skippedDuplicateSets += 1;
    }

    let effortWritten = false;
    if (effort) {
      const result = await client.query(SQL.insertSessionEffortAuthoritative, [
        sessionId, effort.effort_date, effort.duration, effort.active_calories,
        effort.total_calories, effort.average_hr, effort.peak_hr, effort.location,
        effort.notes, writeId,
      ]);
      effortWritten = result.rowCount > 0;
    }

    return {
      session_id: sessionId,
      write_id: writeId,
      sets_written: insertedSetIds.length,
      sets_skipped_duplicate: skippedDuplicateSets,
      effort_written: effortWritten,
    };
  });
}

/**
 * Undo. Deletes exactly the logged sets of one Save, identified by
 * `(session_id, write_id)` — never by position, never by range.
 *
 * It also returns the session to the export queue, in the SAME transaction, so a
 * mirror that already holds the undone rows cannot stay stale (§6.3 P14e/P14f).
 * An undo that retracted Supabase and left the human-readable record intact would
 * be a false record of the athlete's training.
 */
async function undoSave(sessionId, writeId) {
  return withTransaction('app', async (client) => {
    const deleted = await client.query(SQL.deleteSaveLoggedSets, [sessionId, writeId]);
    await client.query(SQL.markSessionForReexport, [sessionId]);
    return { rows_deleted: deleted.rowCount };
  });
}

/** Return a session to the export queue after any post-export mutation. */
async function markSessionForReexport(sessionId, role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.markSessionForReexport, [sessionId]);
    return result.rowCount > 0;
  });
}

// ── Authoritative reads ───────────────────────────────────────────────────────
//
// `limit` mirrors `getRecentRows(tab, maxRows)`; omit it for the whole table, as
// `getSheetRows(tab)` did.

async function loggedSets({ sessionId = null, limit = null, role = 'app' } = {}) {
  return withClient(role, async (client) => {
    if (sessionId) return (await client.query(SQL.readLoggedSetsForSession, [sessionId])).rows;
    if (Number.isFinite(limit)) return (await client.query(SQL.readRecentLoggedSets, [limit])).rows;
    return (await client.query(SQL.readAllLoggedSets)).rows;
  });
}

async function sessionEffort({ limit = null, role = 'app' } = {}) {
  return withClient(role, async (client) => {
    if (Number.isFinite(limit)) return (await client.query(SQL.readRecentEffort, [limit])).rows;
    return (await client.query(SQL.readAllEffort)).rows;
  });
}

async function planEvents({ sessionId = null, role = 'app' } = {}) {
  return withClient(role, async (client) => {
    if (sessionId) return (await client.query(SQL.readPlanEventsForSession, [sessionId])).rows;
    return (await client.query(SQL.readAllPlanEvents)).rows;
  });
}

async function planSetRows({ sessionId = null, role = 'app' } = {}) {
  return withClient(role, async (client) => {
    if (sessionId) return (await client.query(SQL.readPlanSetRowsForSession, [sessionId])).rows;
    return (await client.query(SQL.readAllPlanSetRows)).rows;
  });
}

// ── The plan ledgers, as authority rather than shadow ────────────────────────
//
// The append semantics are unchanged from the Sheets stores they replace: the
// idempotency key decides, a repeated append is a no-op, and the caller learns
// which keys were genuinely new. What changed is that "already present" is now a
// primary key rather than a read-then-compare across a tab.

async function appendPlanEvents(rows) {
  return withTransaction('app', async (client) => {
    const inserted = [];
    for (const row of rows) {
      await insertSessionParent(client, row.session_id);
      const result = await client.query(SQL.insertPlanEvent, [
        row.idempotency_key, row.session_id, row.session_date, row.plan_version, row.event_type,
        row.plan_item_id, row.planned_order, row.planned_lift_code, row.movement_pattern,
        row.outcome, row.performed_lift_code, row.closeout_status, row.recorded_at,
      ]);
      if (result.rowCount > 0) inserted.push(row.idempotency_key);
    }
    return { inserted, skipped: rows.length - inserted.length };
  });
}

async function appendPlanSetRows(rows) {
  return withTransaction('app', async (client) => {
    const inserted = [];
    for (const row of rows) {
      await insertSessionParent(client, row.session_id);
      const result = await client.query(SQL.insertPlanSetRow, [
        row.idempotency_key, row.session_id, row.session_date, row.plan_version, row.plan_item_id,
        row.planned_lift_code, row.set_index, row.target_set_count, row.target_weight,
        row.target_reps, row.target_rir, row.recommendation_source, row.supersedes_key,
        row.confidence, row.closeout_write_id, row.recorded_at,
      ]);
      if (result.rowCount > 0) inserted.push(row.idempotency_key);
    }
    return { inserted, skipped: rows.length - inserted.length };
  });
}

/**
 * The closeout seal, as one statement. `closeout_write_id IS NULL` makes "never
 * re-seal" atomic, and the seal returns the session to the export queue because it
 * is the one mutable column on an exported row (§6.3 P14f).
 */
async function sealPlanSetsForSession(sessionId, closeoutWriteId) {
  return withTransaction('app', async (client) => {
    const sealed = await client.query(SQL.sealPlanSets, [sessionId, closeoutWriteId]);
    await client.query(SQL.markSessionForReexport, [sessionId]);
    return { rows_sealed: sealed.rowCount };
  });
}

// ── The export destination authority (§3.9, §5.4) ────────────────────────────

async function claimExportSession(role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.claimExportSession);
    return result.rows[0] || null;
  });
}

async function allocateMirrorBlocks(sessionId, rowCountsByTab, role = 'app') {
  // ONE transaction covering EVERY tab this session needs. A failure therefore
  // reserves nothing — it cannot leave one tab reserved and another not (§6.3
  // P14b(c)) — and a tab with no rows receives no allocation and does not advance
  // its cursor (§6.3 P14g).
  return withTransaction(role, async (client) => {
    const existing = await client.query(SQL.readMirrorAllocations, [sessionId]);
    if (existing.rowCount > 0) {
      // A re-export reuses its reservation. Reallocating would move the session's
      // rows and strand the block it already wrote into.
      return Object.fromEntries(existing.rows.map((row) => [row.tab, row]));
    }
    const allocations = {};
    for (const [tab, rowCount] of Object.entries(rowCountsByTab)) {
      if (!rowCount) continue;
      const result = await client.query(SQL.allocateMirrorBlock, [tab, rowCount, sessionId]);
      allocations[tab] = { tab, ...result.rows[0] };
    }
    return allocations;
  });
}

async function readMirrorCursor(role = 'app') {
  return withClient(role, async (client) => (await client.query(SQL.readMirrorCursor)).rows);
}

async function seedMirrorCursor(tab, nextRow, role = 'migrate') {
  return withClient(role, async (client) => {
    await client.query(SQL.seedMirrorCursor, [tab, nextRow]);
  });
}

async function acknowledgeExport(sessionId, claimToken, role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.acknowledgeExport, [sessionId, claimToken]);
    return result.rowCount > 0;
  });
}

async function recordExportFailure(sessionId, claimToken, { error, state, nextAttemptAt }, role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.recordExportFailure, [
      sessionId, claimToken, String(error || '').slice(0, 2000), state, nextAttemptAt,
    ]);
    return result.rows[0] || null;
  });
}

async function exportBacklog(role = 'app') {
  return withClient(role, async (client) => (await client.query(SQL.exportBacklog)).rows[0] || null);
}

async function listBlockedExports(role = 'app') {
  return withClient(role, async (client) => (await client.query(SQL.listBlockedExports)).rows);
}

module.exports = {
  SQL,
  ROLE_ENV,
  INSTANCE_ID,
  ROUTE_EFFECT_AUTHORITY,
  effectAuthorityForRoute,
  isConfigured,
  close,

  // §3.10 write freeze — the one operation a live write request depends on
  readWriteFreeze,

  // §3.7 the exercise catalog — Supabase is the sole authority (owner correction
  // 2026-08-13). One read for the runtime, one owner-controlled mutation path.
  readExerciseCatalog,
  applyCatalogMaintenance,

  // The coaching inputs — Supabase is their sole authority (OWNER CORRECTION
  // 2026-08-13). No Sheets read remains for any of them.
  coachingNotes,
  appendCoachingNote,
  constraints,
  appendConstraint,
  deloadStateRows,
  appendDeloadStateRow,
  modalityLogRows,
  appendModalityLogRow,
  transitionCoachingInputs,

  // ══ S4 — the authoritative workout path ═════════════════════════════════════
  sessionIdsForDate,
  effortExistsForSession,
  loggedSetIdentitiesForSession,
  saveWorkout,
  undoSave,
  markSessionForReexport,
  loggedSets,
  sessionEffort,
  planEvents,
  planSetRows,
  appendPlanEvents,
  appendPlanSetRows,
  sealPlanSetsForSession,

  // the export destination authority (§3.9, §5.4)
  claimExportSession,
  allocateMirrorBlocks,
  readMirrorCursor,
  seedMirrorCursor,
  acknowledgeExport,
  recordExportFailure,
  exportBacklog,
  listBlockedExports,

  // §3.6 receipts — schema-owned by S2, wired by S4
  withWriteAttempt,
  persistReceiptSessionId,
  completeWriteReceipt,
  failWriteReceipt,
  resolveAmbiguousReceipt,
  peekWriteReceipt,
  pruneWriteReceipts,
};
