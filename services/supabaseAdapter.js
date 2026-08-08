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
// ── WHAT THIS MODULE IS NOT, IN S2 ────────────────────────────────────────────
// Google Sheets remains the sole live read and write authority for every migrated
// concept. Nothing here decides an athlete-facing response, a status code, a proof
// field, or a visible claim. Every operation below is either shadow work, sweep
// work, repair work, or a deterministic proof target.
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

// Configured means "a connection string exists for the runtime role". Absent, every
// operation below is a no-op and every caller degrades to exactly today's
// behaviour — which is what keeps this PR inert until the owner configures it.
function isConfigured(role = 'app') {
  return connectionString(role).length > 0;
}

// The shadow lane is OFF unless BOTH the flag is on and a connection exists. Two
// conditions, because a flag alone on an unconfigured deployment would turn every
// Save into a logged failure for no benefit.
function isShadowWriteEnabled() {
  return process.env.ATLAS_SUPABASE_SHADOW_WRITE === '1' && isConfigured('app');
}

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
  beginCatalogSync: `
    INSERT INTO atlas.exercise_catalog_sync (status, source_row_count, content_hash)
    VALUES ('in_progress', $1, $2)
    RETURNING sync_id`,
  deleteCatalogMirror: `DELETE FROM atlas.exercise_catalog_mirror`,
  insertCatalogRow: `
    INSERT INTO atlas.exercise_catalog_mirror
      (exercise, display_exercise, muscle_group, lift_code, canonical_exercise, sync_id)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  verifyCatalogSync: `
    UPDATE atlas.exercise_catalog_sync
       SET status = 'verified', verified_at = now(), last_error = NULL
     WHERE sync_id = $1`,
  failCatalogSync: `
    UPDATE atlas.exercise_catalog_sync
       SET status = 'failed', last_error = $2
     WHERE sync_id = $1`,
  currentCatalogGeneration: `
    SELECT sync_id, verified_at, content_hash, source_row_count
      FROM atlas.exercise_catalog_sync
     WHERE status = 'verified'
     ORDER BY verified_at DESC
     LIMIT 1`,
  readCatalogMirror: `
    SELECT exercise, display_exercise, muscle_group, lift_code, canonical_exercise
      FROM atlas.exercise_catalog_mirror
     ORDER BY exercise`,

  // §3.8 — the divergence lane. The partial unique index means a repeated sweep
  // cannot multiply rows for one identity.
  openDivergence: `
    INSERT INTO atlas.migration_divergences
      (concept, identity_key, session_id, write_id, route, reason, detected_by, comparison_result)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (concept, identity_key) WHERE state <> 'closed' DO NOTHING
    RETURNING id`,
  listOpenDivergences: `
    SELECT id, concept, identity_key, session_id, write_id, route, reason, detected_by,
           detected_at, state, repair_attempts, comparison_result
      FROM atlas.migration_divergences
     WHERE state <> 'closed'
     ORDER BY detected_at ASC
     LIMIT $1`,
  claimDivergence: `
    UPDATE atlas.migration_divergences
       SET state = 'repairing',
           repair_claim_token = gen_random_uuid(),
           repair_claim_expires_at = now() + ($2 || ' seconds')::interval,
           repair_attempts = repair_attempts + 1
     WHERE id = $1
       AND (state = 'open' OR (state = 'repairing' AND repair_claim_expires_at < now()))
    RETURNING id, repair_claim_token`,
  // A lapsed lease returns the row to the queue. It NEVER closes it.
  releaseDivergence: `
    UPDATE atlas.migration_divergences
       SET state = 'open', repair_claim_token = NULL, repair_claim_expires_at = NULL,
           comparison_result = COALESCE($3::jsonb, comparison_result)
     WHERE id = $1 AND repair_claim_token = $2`,
  // A divergence closes ONLY with a passing re-comparison, under a matching claim
  // token. The table's own CHECK refuses a closed row without closure_proof, so a
  // second implementation cannot close one either.
  closeDivergence: `
    UPDATE atlas.migration_divergences
       SET state = 'closed', closed_at = now(), closure_proof = $3::text,
           comparison_result = COALESCE($4::jsonb, comparison_result),
           repair_claim_token = NULL, repair_claim_expires_at = NULL
     WHERE id = $1 AND repair_claim_token = $2
       AND $3::text IS NOT NULL AND $3::text <> ''
    RETURNING id`,
  divergenceSummary: `
    SELECT count(*) FILTER (WHERE state <> 'closed')::int AS open_count,
           count(*) FILTER (WHERE state = 'closed')::int  AS closed_count,
           min(detected_at) FILTER (WHERE state <> 'closed') AS oldest_open_at
      FROM atlas.migration_divergences`,

  // Sweep enumeration. Full-table reads, run by a background job, never in a request.
  listLoggedSets: `
    SELECT id, session_id, date_clean, exercise, canonical_exercise, muscle_group, lift_code,
           set_number, weight, reps, rir, notes, volume_calc, write_id
      FROM atlas.logged_sets`,
  listSessionEffort: `
    SELECT session_id, effort_date, duration, active_calories, total_calories,
           average_hr, peak_hr, location, notes, write_id
      FROM atlas.session_effort`,
  listPlanEvents: `
    SELECT idempotency_key, session_id, session_date, plan_version, event_type, plan_item_id,
           planned_order, planned_lift_code, movement_pattern, outcome, performed_lift_code,
           closeout_status, recorded_at
      FROM atlas.session_plan_events`,
  listPlanSetRows: `
    SELECT idempotency_key, session_id, session_date, plan_version, plan_item_id,
           planned_lift_code, set_index, target_set_count, target_weight, target_reps,
           target_rir, recommendation_source, supersedes_key, confidence,
           closeout_write_id, recorded_at
      FROM atlas.session_plan_set_recommendations`,

  // The one delete the repair worker may issue on workout data: a Supabase-only
  // logged_sets orphan, where Sheets — the live authority — holds no such row.
  deleteLoggedSetByIdentity: `
    DELETE FROM atlas.logged_sets
     WHERE lower(session_id) = $1 AND lower(exercise) = $2 AND set_number = $3`,

  // The export-state updates of §3.1. Unused before S4; issued here only by the
  // least-privilege proof, so the grant list and the statement cannot drift.
  updateExportState: `
    UPDATE atlas.workout_sessions
       SET sheets_exported_at = $2, sheets_export_attempts = sheets_export_attempts + 1,
           sheets_export_error = $3, sheets_export_state = $4,
           sheets_export_next_attempt_at = $5, export_claim_token = $6
     WHERE session_id = $1`,
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

function loggedSetParams(row) {
  return [
    row.session_id, row.date_clean, row.exercise, row.canonical_exercise, row.muscle_group,
    row.lift_code, row.set_number, row.weight, row.reps, row.rir, row.notes, row.volume_calc,
  ];
}

function sessionEffortParams(row) {
  return [
    row.session_id, row.effort_date, row.duration, row.active_calories, row.total_calories,
    row.average_hr, row.peak_hr, row.location, row.notes,
  ];
}

function planEventParams(row) {
  return [
    row.idempotency_key, row.session_id, row.session_date, row.plan_version, row.event_type,
    row.plan_item_id, row.planned_order, row.planned_lift_code, row.movement_pattern,
    row.outcome, row.performed_lift_code, row.closeout_status, row.recorded_at,
  ];
}

function planSetParams(row) {
  return [
    row.idempotency_key, row.session_id, row.session_date, row.plan_version, row.plan_item_id,
    row.planned_lift_code, row.set_index, row.target_set_count, row.target_weight,
    row.target_reps, row.target_rir, row.recommendation_source, row.supersedes_key,
    row.confidence, row.closeout_write_id, row.recorded_at,
  ];
}

// The Save's shadow: the session parent, then its logged sets, then its Effort
// row — ALL in one transaction. A child can never commit without its parent, and
// a failure mid-transaction leaves neither.
//
// `logCells` / `effortCells` are the EXACT row arrays the Sheets append received,
// so the mirror is a projection of what was actually written rather than a second
// derivation of it.
async function shadowSave({ sessionId, logCells = [], effortCells = null }) {
  return withTransaction('app', async (client) => {
    const parsed = await insertSessionParent(client, sessionId);
    let sets = 0;
    for (const cells of logCells) {
      const row = contract.rowFromSheet('logged_sets', cells);
      row.session_id = row.session_id || parsed.session_id;
      const result = await client.query(SQL.insertLoggedSet, loggedSetParams(row));
      sets += result.rowCount;
    }
    let effort = 0;
    if (effortCells) {
      const row = contract.rowFromSheet('session_effort', effortCells);
      row.session_id = row.session_id || parsed.session_id;
      const result = await client.query(SQL.insertSessionEffort, sessionEffortParams(row));
      effort = result.rowCount;
    }
    return { session_id: parsed.session_id, logged_sets_inserted: sets, session_effort_inserted: effort };
  });
}

// The plan spine's shadow. Parent-first for the same reason, and one transaction
// per event batch (§3.4).
async function shadowPlanEvents(rows) {
  const cells = Array.isArray(rows) ? rows : [];
  if (cells.length === 0) return { inserted: 0, existing: 0 };
  return withTransaction('app', async (client) => {
    const seen = new Set();
    let inserted = 0;
    let existing = 0;
    for (const cellRow of cells) {
      const row = contract.rowFromSheet('session_plan_events', cellRow);
      if (!row.session_id) continue;
      if (!seen.has(row.session_id)) {
        await insertSessionParent(client, row.session_id);
        seen.add(row.session_id);
      }
      const result = await client.query(SQL.insertPlanEvent, planEventParams(row));
      if (result.rowCount > 0) inserted += 1;
      else existing += 1;
    }
    return { inserted, existing };
  });
}

async function shadowPlanSetRows(rows) {
  const cells = Array.isArray(rows) ? rows : [];
  if (cells.length === 0) return { inserted: 0, existing: 0 };
  return withTransaction('app', async (client) => {
    const seen = new Set();
    let inserted = 0;
    let existing = 0;
    // A revision references the row it supersedes, so a batch must insert in
    // ascending plan_version or the self-referencing foreign key fails.
    const ordered = cells
      .map((cellRow) => contract.rowFromSheet('session_plan_set_recommendations', cellRow))
      .filter((row) => row.session_id)
      .sort((a, b) => (a.plan_version || 0) - (b.plan_version || 0));
    for (const row of ordered) {
      if (!seen.has(row.session_id)) {
        await insertSessionParent(client, row.session_id);
        seen.add(row.session_id);
      }
      const result = await client.query(SQL.insertPlanSetRow, planSetParams(row));
      if (result.rowCount > 0) inserted += 1;
      else existing += 1;
    }
    return { inserted, existing };
  });
}

// The closeout seal, mirrored so the shadow copy's CONTENT matches the tab. The
// sweep compares closeout_write_id, so a seal that reached Sheets and not the
// mirror is a real divergence and must be mirrored rather than ignored.
async function shadowSealPlanSets(sessionId, closeoutWriteId) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.sealPlanSets, [sessionId, closeoutWriteId]);
    return { sealed_rows: result.rowCount };
  });
}

// ── Sweep enumeration ─────────────────────────────────────────────────────────

const LIST_SQL_BY_CONCEPT = Object.freeze({
  logged_sets: SQL.listLoggedSets,
  session_effort: SQL.listSessionEffort,
  session_plan_events: SQL.listPlanEvents,
  session_plan_set_recommendations: SQL.listPlanSetRows,
});

async function listConcept(concept, role = 'app') {
  const sql = LIST_SQL_BY_CONCEPT[concept];
  if (!sql) throw new Error(`No enumeration for concept: ${concept}`);
  return withClient(role, async (client) => {
    const result = await client.query(sql);
    return result.rows;
  });
}

// ── Divergence lane ───────────────────────────────────────────────────────────

async function openDivergence({
  concept,
  identityKey,
  sessionId = null,
  writeId = null,
  route = null,
  reason,
  detectedBy,
  comparison = null,
}) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.openDivergence, [
      concept, identityKey, sessionId, writeId, route, reason, detectedBy,
      comparison ? JSON.stringify(comparison) : null,
    ]);
    return { id: result.rows[0] ? result.rows[0].id : null, created: result.rowCount > 0 };
  });
}

async function listOpenDivergences(limit = 500) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.listOpenDivergences, [limit]);
    return result.rows;
  });
}

async function claimDivergence(id, leaseSeconds = 120) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.claimDivergence, [id, String(leaseSeconds)]);
    return result.rows[0] || null;
  });
}

async function releaseDivergence(id, token, comparison = null) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.releaseDivergence, [
      id, token, comparison ? JSON.stringify(comparison) : null,
    ]);
    return result.rowCount > 0;
  });
}

async function closeDivergence(id, token, closureProof, comparison = null) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.closeDivergence, [
      id, token, closureProof || null, comparison ? JSON.stringify(comparison) : null,
    ]);
    return result.rowCount > 0;
  });
}

async function divergenceSummary(role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.divergenceSummary);
    return result.rows[0] || { open_count: 0, closed_count: 0, oldest_open_at: null };
  });
}

// ── Repair primitives ─────────────────────────────────────────────────────────

// Insert one Sheets-authoritative row into Supabase, parent-first, in one
// transaction. write_id is NULL by construction: the sweep genuinely cannot know
// it (Sheets stores none), and it never fabricates one.
async function repairInsert(concept, row) {
  return withTransaction('app', async (client) => {
    const sessionId = contract.sessionIdOf(concept, row);
    if (sessionId) await insertSessionParent(client, sessionId);
    switch (concept) {
      case 'logged_sets':
        return { inserted: (await client.query(SQL.insertLoggedSet, loggedSetParams(row))).rowCount };
      case 'session_effort':
        return { inserted: (await client.query(SQL.insertSessionEffort, sessionEffortParams(row))).rowCount };
      case 'session_plan_events':
        return { inserted: (await client.query(SQL.insertPlanEvent, planEventParams(row))).rowCount };
      case 'session_plan_set_recommendations':
        return { inserted: (await client.query(SQL.insertPlanSetRow, planSetParams(row))).rowCount };
      default:
        throw new Error(`No repair insert for concept: ${concept}`);
    }
  });
}

// The one delete the repair worker may issue on workout data (§8.2 grants
// DELETE on logged_sets only). Every other concept's Supabase-only orphan stays
// an OPEN divergence for the owner, because no declared principal may remove it.
async function repairDeleteLoggedSet(identity) {
  const [sessionId, exercise, setNumber] = String(identity).split('||');
  return withClient('app', async (client) => {
    const result = await client.query(SQL.deleteLoggedSetByIdentity, [
      sessionId, exercise, Number(setNumber),
    ]);
    return { deleted: result.rowCount };
  });
}

// ── Catalog mirror (§3.7) ─────────────────────────────────────────────────────

async function beginCatalogSync(sourceRowCount, contentHash) {
  return withClient('app', async (client) => {
    const result = await client.query(SQL.beginCatalogSync, [sourceRowCount, contentHash]);
    return result.rows[0].sync_id;
  });
}

// The swap: delete the previous generation's rows, insert the new rows, and mark
// the generation verified — in ONE transaction, so a reader never sees a
// half-written catalog and a reader on the old generation is unaffected until
// commit. content_hash is written in the same transaction as the rows it names.
async function commitCatalogSwap(syncId, rows) {
  return withTransaction('app', async (client) => {
    await client.query(SQL.deleteCatalogMirror);
    for (const row of rows) {
      await client.query(SQL.insertCatalogRow, [
        row.exercise, row.display_exercise, row.muscle_group, row.lift_code,
        row.canonical_exercise, syncId,
      ]);
    }
    await client.query(SQL.verifyCatalogSync, [syncId]);
    return { rows: rows.length };
  });
}

async function failCatalogSync(syncId, error) {
  return withClient('app', async (client) => {
    await client.query(SQL.failCatalogSync, [syncId, String(error && error.message ? error.message : error).slice(0, 2000)]);
  });
}

async function currentCatalogGeneration(role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.currentCatalogGeneration);
    return result.rows[0] || null;
  });
}

async function readCatalogMirror(role = 'app') {
  return withClient(role, async (client) => {
    const result = await client.query(SQL.readCatalogMirror);
    return result.rows;
  });
}

// ── Write receipts (§3.6) ─────────────────────────────────────────────────────
//
// PRESENT BUT NOT WIRED IN S2. The file-backed store in services/idempotency.js
// remains the sole receipt authority through S2 and S3 — nothing here is called
// by a production path, and §6.1 P7d proves atlas.write_receipts stays empty
// after a shadow Save. These operations exist because S2 owns the schema and the
// state machine is a deterministic S2 proof target (P8, P8a, P8a0, P8c). S4 wires
// them, adds the foreign keys, and deletes the file store.
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

// Same shape as services/migrationShadow.js's, and for the same reason: a receipt
// anomaly must be visible to an operator, and logging must never throw into a
// write path.
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
  // The four D4 routes. Only the RECEIPT moves; the rows keep appending to their
  // own Sheets tabs, with no allocated destination and nothing able to catch a
  // duplicate.
  '/api/coaching-notes': 'sheets',
  '/api/constraints': 'sheets',
  '/api/log-modality': 'sheets',
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

module.exports = {
  SQL,
  ROLE_ENV,
  INSTANCE_ID,
  ROUTE_EFFECT_AUTHORITY,
  effectAuthorityForRoute,
  isConfigured,
  isShadowWriteEnabled,
  close,

  // §5.2 shadow lane
  shadowSave,
  shadowPlanEvents,
  shadowPlanSetRows,
  shadowSealPlanSets,

  // sweep enumeration
  listConcept,

  // §3.8 divergence lane
  openDivergence,
  listOpenDivergences,
  claimDivergence,
  releaseDivergence,
  closeDivergence,
  divergenceSummary,

  // repair primitives
  repairInsert,
  repairDeleteLoggedSet,

  // §3.7 catalog mirror
  beginCatalogSync,
  commitCatalogSwap,
  failCatalogSync,
  currentCatalogGeneration,
  readCatalogMirror,

  // §3.6 receipts — schema-owned by S2, wired by S4
  withWriteAttempt,
  persistReceiptSessionId,
  completeWriteReceipt,
  failWriteReceipt,
  resolveAmbiguousReceipt,
  peekWriteReceipt,
  pruneWriteReceipts,
};
