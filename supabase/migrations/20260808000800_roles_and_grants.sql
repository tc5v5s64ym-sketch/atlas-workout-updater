-- Atlas hot-path migration — S2, file 8 of 8: the four scoped roles and their grants.
--
-- Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §8.2.
--
-- Atlas does NOT use the Supabase Data API, the service-role key, or the anon key
-- (§8.1). Credentials are Supavisor SESSION-MODE connection strings, one per role,
-- read from environment variables on the server only. Session mode is required
-- because the export holds a SESSION-level advisory lock across statements;
-- transaction mode would appear to work and hold nothing.
--
-- NO PASSWORD IS SET HERE, AND EVERY ROLE IS CREATED NOLOGIN.
-- A password in a migration file is a committed credential. The owner grants LOGIN
-- and sets each password out of band against `Atlas Production`; the CI proof
-- bootstrap does the same against its disposable database with a per-run random
-- value. §8.4 forbids a credential or a project reference in the repository.
--
-- LEAST PRIVILEGE IS PROVEN, NOT CLAIMED: §6.1 P7c executes every statement this
-- design specifies as its REAL role, and proves atlas_app is refused DDL and
-- refused a DELETE outside its grant list. An unproven grant list is a claim.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
    CREATE ROLE atlas_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_migrate') THEN
    CREATE ROLE atlas_migrate NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_readonly') THEN
    CREATE ROLE atlas_readonly NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_rebuild') THEN
    CREATE ROLE atlas_rebuild NOLOGIN;
  END IF;
END
$$;

-- ── atlas_migrate: DDL, plus exactly two declared DML operations ───────────────
--
-- In PostgreSQL, DDL authority IS ownership: there is no ALTER or DROP privilege
-- to grant. So atlas_migrate owns the schema and every table.
--
-- THE APPLIER MUST BE ABLE TO `SET ROLE` TO THE NEW OWNER, AND ON A HOSTED
-- SUPABASE PROJECT IT CANNOT WITHOUT THIS GRANT.
--
-- `ALTER ... OWNER TO r` requires the executing role to be a member of `r` with
-- SET. A SUPERUSER bypasses that, which is why this file applied cleanly for the
-- whole of `S2`: the from-empty proof ran as the container's superuser. Supabase's
-- `postgres` is NOT a superuser — it is a CREATEROLE role — and on PostgreSQL 16
-- a CREATEROLE creator receives ADMIN OPTION but NOT SET, so the next statement
-- failed with:
--
--     ERROR:  must be able to SET ROLE "atlas_migrate"
--
-- Measured against a real non-superuser CREATEROLE principal before this line was
-- written, and the proof harness now applies every migration as such a principal
-- so a privilege the deployment lacks can never again be assumed.
--
-- The plain form is used deliberately: `GRANT ... WITH SET TRUE` is PostgreSQL 16
-- syntax and would be a syntax error on 15, while a plain GRANT means membership
-- WITH SET on 16+ and implies SET ROLE on 15 and earlier. One statement, every
-- supported version.
--
-- It grants the applier nothing it did not already control: on a virgin project
-- the applier is the role that just created atlas_migrate.
GRANT atlas_migrate TO current_user;

ALTER SCHEMA atlas OWNER TO atlas_migrate;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'atlas' LOOP
    EXECUTE format('ALTER TABLE atlas.%I OWNER TO atlas_migrate', t.tablename);
  END LOOP;
END
$$;

-- ── A DEVIATION FROM §8.2, RECORDED RATHER THAN PAPERED OVER ──────────────────
--
-- §8.2 says atlas_migrate "holds no other DML on any table". POSTGRESQL CANNOT
-- EXPRESS THAT, and the attempt to express it breaks the schema.
--
-- An earlier version of this file revoked the owner's implicit DML. It was
-- reverted because PostgreSQL runs a foreign-key check as the REFERENCING
-- table's OWNER rather than as the user issuing the statement, and the check
-- takes `SELECT ... FOR KEY SHARE` on the referenced table. With the owner's
-- privileges stripped, EVERY insert into atlas.logged_sets, atlas.session_effort,
-- atlas.session_plan_events, atlas.session_plan_set_recommendations and
-- atlas.sheets_mirror_allocations failed with SQLSTATE 42501 — including inserts
-- by atlas_app, which holds its own SELECT. Measured on the from-empty database:
-- the §3.9 foreign-key proofs failed, and they failed again with SELECT and then
-- SELECT+UPDATE restored. An owner may also re-grant to itself at will, so even a
-- working revoke would have been a convention rather than a control.
--
-- So the boundary is enforced by the two things that ARE real, and the merge card
-- says so plainly rather than claiming a grant that does not exist:
--
--   1. atlas_migrate IS NEVER CONFIGURED IN THE SERVER RUNTIME. No production
--      module reads ATLAS_SUPABASE_MIGRATE_URL — services/supabaseAdapter.js is
--      the only holder of a client, every runtime operation asks it for the 'app'
--      role, and test/supabaseRoleSeparation.test.js proves that by source scan.
--   2. atlas_app's grant list below is exact, minimal, and proven AS the real
--      role by the from-empty least-privilege proof (§6.1 P7c).
--
-- The declared operation is granted explicitly anyway, so the schema records the
-- INTENT even where it cannot record the restriction.

-- Declared DML operation 1 of 2 — the cutover receipt carry (§5.5a step 5), one
-- crash-atomic transaction. atlas_app deliberately holds NO DELETE on
-- write_receipts: a runtime role that could delete a receipt could erase
-- duplicate protection.
GRANT INSERT, UPDATE, DELETE, SELECT ON atlas.write_receipts TO atlas_migrate;

-- Declared DML operation 2 of 2 — the migration seed of the single dormant
-- atlas.write_freeze row — is NOT granted here. That table is created by S3
-- (§3.10), and a grant written in S2 proves nothing about a table that does not
-- exist until S3. S3's migration carries it, and §6.2 P8a proves it there.

-- ── atlas_app: the runtime role, used by the Express server ───────────────────
GRANT USAGE ON SCHEMA atlas TO atlas_app;

GRANT SELECT ON ALL TABLES IN SCHEMA atlas TO atlas_app;
-- INSERT on every table in atlas. (write_freeze is SELECT-only for atlas_app and
-- does not exist yet; S3's migration grants SELECT and nothing else on it.)
GRANT INSERT ON ALL TABLES IN SCHEMA atlas TO atlas_app;

-- Column-scoped UPDATE. Everything not listed is immutable to the runtime.
GRANT UPDATE (closeout_write_id)
  ON atlas.session_plan_set_recommendations TO atlas_app;

-- created_at and expires_at are in this list because the retry claim updates both
-- (§3.6): an expired row is reclaimed as a genuinely new logical record, which
-- resets attempt and created_at and refreshes the TTL epoch. Omitting them made
-- the claim permission-denied under its own security model.
--
-- ambiguous_at and ambiguity_proof are here because the runtime performs BOTH
-- halves of the effect-aware rule: the claim path marks a prior process's
-- unresolved Sheets effect ambiguous, and the resolution records the
-- destination-side proof that releases it.
--
-- effect_authority is DELIBERATELY ABSENT. It is written once at INSERT from the
-- frozen route map and is never updated, so the runtime cannot relabel a
-- non-transactional effect as transactional and unlock automatic retry for it.
-- The reclaim rule reads this column; a role that could rewrite it could defeat
-- the rule without touching any statement. Proven both ways by §6.1 P7c/P16d.
GRANT UPDATE (status, attempt, attempt_token, attempt_started_at, created_at,
              expires_at, session_id, response_body, rows_written, appended_range,
              completed_at, owner_instance_id, ambiguous_at, ambiguity_proof)
  ON atlas.write_receipts TO atlas_app;

-- The six updatable export-state columns of §3.1. Three writers touch them: the
-- S4 export worker, the §5.7 owner rebuild, and the runtime itself (an undo or a
-- closeout-seal invalidation returns a session to the export queue).
GRANT UPDATE (sheets_exported_at, sheets_export_attempts, sheets_export_error,
              sheets_export_state, sheets_export_next_attempt_at, export_claim_token)
  ON atlas.workout_sessions TO atlas_app;

GRANT UPDATE (next_row, base_established_at)
  ON atlas.sheets_mirror_cursor TO atlas_app;

GRANT UPDATE (status, verified_at, last_error)
  ON atlas.exercise_catalog_sync TO atlas_app;

-- The divergence state columns, while that table exists.
GRANT UPDATE (state, repair_attempts, repair_claim_token, repair_claim_expires_at,
              comparison_result, closed_at, closure_proof)
  ON atlas.migration_divergences TO atlas_app;

-- DELETE, exactly three places: undo (§3.2), the catalog generation swap (§3.7),
-- and divergence housekeeping while that table exists. NEVER on a Sheets tab —
-- the export does not delete mirror rows to correct itself (§5.4).
GRANT DELETE ON atlas.logged_sets              TO atlas_app;
GRANT DELETE ON atlas.exercise_catalog_mirror  TO atlas_app;
GRANT DELETE ON atlas.migration_divergences    TO atlas_app;

-- atlas_app holds no DROP, ALTER, TRUNCATE or other DDL grant. The catalog swap
-- uses DELETE inside a transaction rather than TRUNCATE precisely so the runtime
-- role needs no DDL privilege. It is NOT granted CREATE on the schema.

-- ── atlas_readonly: SELECT only ────────────────────────────────────────────────
-- Used by `npm run atlas:status` and `npm run atlas:review-live`, mirroring the
-- existing rule that read-only tools build their own spreadsheets.readonly client.
GRANT USAGE  ON SCHEMA atlas TO atlas_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA atlas TO atlas_readonly;

-- ── atlas_rebuild: the owner-only §5.7 mirror-rebuild principal ────────────────
--
-- Its credential is NOT configured in the Render runtime. It is owner-operated and
-- supplied only for the duration of a rebuild, which is what preserves the rule
-- that the normal runtime cannot rebase allocations. One role and one procedure —
-- not a generic admin framework. Unused before S4; declared here with the schema.
GRANT USAGE  ON SCHEMA atlas TO atlas_rebuild;
GRANT SELECT ON ALL TABLES IN SCHEMA atlas TO atlas_rebuild;

GRANT DELETE, INSERT ON atlas.sheets_mirror_allocations TO atlas_rebuild;
GRANT UPDATE (next_row, base_established_at) ON atlas.sheets_mirror_cursor TO atlas_rebuild;

-- The COMPLETE export-state tuple §5.7 step 5 resets. A rebuild that may reset
-- four of six columns is permission-denied on the other two.
GRANT UPDATE (sheets_export_state, sheets_export_error, sheets_export_next_attempt_at,
              sheets_exported_at, sheets_export_attempts, export_claim_token)
  ON atlas.workout_sessions TO atlas_rebuild;

-- It holds NO grant beyond SELECT on logged_sets, session_effort,
-- session_plan_events, session_plan_set_recommendations or write_receipts — so the
-- rebuild cannot touch Supabase workout authority. That is enforced by the grant,
-- not by the procedure's good intentions, and §6.3 P14h proves the refusals.

-- ── Row Level Security ─────────────────────────────────────────────────────────
--
-- ATLAS MAKES NO ROW LEVEL SECURITY CLAIM (§8.3). Atlas is single-owner during V1
-- and the browser is never a Supabase client, so RLS is not the control that
-- protects this data; the controls are the scoped grants above and the fact that
-- connection credentials never leave the server. No policy is enabled here, and
-- until one is configured AND a test proves a denied read, no document, PR body,
-- or merge card may state that Atlas has RLS.
