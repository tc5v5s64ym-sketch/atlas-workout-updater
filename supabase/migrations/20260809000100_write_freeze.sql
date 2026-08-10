-- Atlas hot-path migration — S3, file 1 of 1: atlas.write_freeze.
--
-- Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §3.10 (the table), §5.3
-- ("The write freeze — one bounded control authority"), §8.2 (the grants), and
-- §6.2 P8a (the proof this file owes).
--
-- OWNER RULING D7 — APPROVED 2026-08-09. This control is PERMANENT Atlas safety
-- infrastructure and carries NO SUNSET. It is not migration bridge machinery, and
-- S4 does not delete it. The ruling is recorded in the canonical execution plan
-- under the 2026-08-07 owner-instruction block; this file does not carry authority,
-- it carries the schema.
--
-- ── WHAT IT IS: ONE ROW, ONE MEANING ─────────────────────────────────────────
-- One control with one meaning — are the seven beginWrite write routes open? It is
-- NOT a key/value flag store: no name column, no per-feature rows, no second
-- controlled behaviour. Adding one is outside this migration and needs its own
-- authorization. The fixed shape IS the bound.
--
-- ── WHY S3 CREATES IT AND S2 DID NOT ─────────────────────────────────────────
-- §6.1 P1 excludes this table from the S2 constraint proofs precisely because S2
-- is forbidden to create it, and a grant written in S2 would prove nothing about a
-- table that does not exist until S3. The constraint, the seed and the grants are
-- therefore all proven HERE, by §6.2 P8a, as the real roles.

CREATE TABLE IF NOT EXISTS atlas.write_freeze (
  -- The single-row idiom. `id` is a boolean primary key that CHECK forces to
  -- true, so a second row is refused by the primary key rather than by a
  -- convention some later writer could forget.
  id       boolean     PRIMARY KEY DEFAULT true CHECK (id),
  frozen   boolean     NOT NULL,
  reason   text        NOT NULL,
  set_by   text        NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now()
);

-- ── ESTABLISH THE OWNERSHIP INVARIANT; DO NOT ASSUME IT ──────────────────────
--
-- *Required Atlas Contract / Systems Review of `bba3fbf`.* Everything below this
-- file — and the whole of D7 — rests on "the project-owner/applier owns
-- atlas.write_freeze, and is therefore the sole effective authority over it".
-- `CREATE TABLE IF NOT EXISTS` DOES NOT ESTABLISH THAT. If the object already
-- exists, the statement is a no-op and the EXISTING OWNER SURVIVES.
--
-- The adversarial sequence is legitimate at every step: after `S2`, atlas_migrate
-- owns schema `atlas` and holds CREATE, so it can create `atlas.write_freeze`
-- itself before `S3` ever runs. `S3` would then skip the create, take the schema,
-- revoke explicit grants — and leave atlas_migrate as TABLE OWNER, holding
-- implicit DDL and DML that no REVOKE can remove. A competing authority would
-- survive silently, which is exactly what D7 forbids.
--
-- So the invariant is TAKEN, not assumed. This is a no-op on the normal path,
-- where the applier created the table one statement ago.
ALTER TABLE atlas.write_freeze OWNER TO CURRENT_USER;

-- ── AND RESET THE ACCESS LIST, FOR THE SAME REASON ───────────────────────────
--
-- A pre-existing table can also carry grants its creator chose. Revoking only
-- from atlas_migrate would leave, say, an `UPDATE` granted to atlas_app — a
-- runtime role able to LIFT A FREEZE, which is worse than the ownership defect.
-- The access list is therefore rebuilt from nothing rather than adjusted, so the
-- final state does not depend on what was there before.
REVOKE ALL ON atlas.write_freeze FROM PUBLIC;
REVOKE ALL ON atlas.write_freeze FROM atlas_app, atlas_migrate, atlas_readonly, atlas_rebuild;

-- ── The seed: DORMANT ────────────────────────────────────────────────────────
--
-- *Comment corrected by the required review of `ae1928c`: it still described this
-- as a declared DML operation in atlas_migrate's grant list, issued "before the
-- ownership transfer below". Both statements are now false — there is no transfer,
-- and atlas_migrate holds no DML here at all.*
--
-- WHO PERFORMS IT. This is MIGRATION-TIME DML by the PROJECT-OWNER / APPLIER
-- principal — `postgres` on `Atlas Production`, and its NOSUPERUSER mirror in the
-- from-empty proof — acting as the owner of the table it created two statements
-- ago. It needs no grant, because ownership is not transferred away from it, and
-- `atlas_migrate` receives NO row-DML authority on this table (see below).
--
-- The row ships `frozen = false`, so applying this migration changes no behaviour:
-- §6.2 P12 proves the dormant path is byte-identical to the pre-S3 build.
--
-- ON CONFLICT DO NOTHING makes a re-apply a no-op and — far more importantly —
-- means a RE-RUN CAN NEVER LIFT A LIVE FREEZE. A seed that overwrote the row would
-- hand every future migration run the power to reopen writes the owner had closed,
-- which is exactly the authority this control exists to keep in one place.
INSERT INTO atlas.write_freeze (id, frozen, reason, set_by)
VALUES (true, false, 'dormant — seeded by the S3 migration; writes open', 'migration:S3')
ON CONFLICT (id) DO NOTHING;

-- ── Ownership: DELIBERATELY NOT TRANSFERRED ──────────────────────────────────
--
-- *Corrected by the required Atlas Contract / Systems Review of `65310b3`, finding 1.*
--
-- An earlier version of this file ran `ALTER TABLE atlas.write_freeze OWNER TO
-- atlas_migrate`, mirroring what S2 file 8 does for every other table. On every
-- other table that is right: in PostgreSQL DDL authority IS ownership, and the
-- migration role has to be able to alter the schema it maintains.
--
-- ON THIS TABLE IT IS WRONG, AND IT DEFEATS D7. Ownership carries implicit
-- INSERT, UPDATE and DELETE that cannot be revoked from the owner in any durable
-- way — an owner may re-grant to itself at will. Transferring ownership therefore
-- created a SECOND principal that could lift a freeze, and D7 says there is one
-- winner: the Supabase project owner, over a credential the server never holds.
-- "One control with one meaning" is worth nothing if two roles can set it.
--
-- SO THE TABLE STAYS OWNED BY THE PRINCIPAL THAT APPLIED THIS MIGRATION, which is
-- the Supabase project owner (`postgres`) on `Atlas Production`, and the
-- NOSUPERUSER CREATEROLE applier that mirrors it in the from-empty proof. That
-- principal is exactly the one §5.3 names as the sole mutator, so the mutation
-- path and the ownership are the same thing rather than two things that have to
-- agree.
--
-- atlas_migrate holds no INSERT, UPDATE or DELETE here, so IT CANNOT LIFT A
-- FREEZE by writing the row. §6.2 P8a proves that as the real role.
--
-- ── AND ROW DML WAS NOT THE WHOLE ATTACK SURFACE ─────────────────────────────
--
-- *Corrected by the required review of `a29129e`, P1: the previous version of this
-- comment claimed the only power atlas_migrate had over the control was to
-- SUBTRACT it, and that subtraction is monotonic toward frozen. THAT CLAIM WAS NOT
-- STRUCTURALLY SUFFICIENT, and it is withdrawn.*
--
-- S2 file 8 made atlas_migrate the OWNER OF SCHEMA `atlas`. A schema owner can do
-- more than delete a table it does not own — it can REPLACE it. Drop
-- atlas.write_freeze, create a new table of the same name seeded `frozen = false`,
-- grant SELECT to atlas_app, and the runtime reads exactly one valid row saying
-- writes are open. Refusing UPDATE on the original object never proved the project
-- owner was the sole effective authority over the write-admission DECISION; it only
-- proved it owned one particular table.
--
-- So the schema authority is narrowed HERE, after the S2 state exists, rather than
-- by editing a migration the owner has already applied to `Atlas Production`.
ALTER SCHEMA atlas OWNER TO CURRENT_USER;

-- atlas_migrate keeps exactly the two schema privileges a migration role needs,
-- explicitly, instead of the implicit everything that ownership carried:
--
--   USAGE   — reach the objects it owns;
--   CREATE  — add new migration-owned objects in future migrations.
--
-- It still OWNS the eleven S2 tables individually, so ordinary migration DDL on
-- those is untouched. What it loses is the ability to drop, rename, re-schema or
-- otherwise replace an object it does not own — which is exactly and only the
-- replacement bypass above. §6.2 P8a proves both halves: the replacement is
-- refused, and legitimate migration DDL still works.
GRANT USAGE, CREATE ON SCHEMA atlas TO atlas_migrate;

-- NET COMPLEXITY IS NEGATIVE: one broad implicit ownership is replaced by two
-- explicit bounded privileges. No second schema, no second freeze table, no
-- trigger, no wrapper, no fallback, and no reconciliation mechanism — a competing
-- authority is REMOVED, not mediated.

-- ── Grants: SELECT, and nothing else ─────────────────────────────────────────
--
-- THIS IS THE OWNER-AUTHENTICATION MECHANISM, not a convenience. §5.3: the owner
-- sets and lifts the freeze with an UPDATE in the Supabase SQL editor or through
-- psql as the project owner role, so authentication is the Supabase project
-- credential §8.1 already treats as owner-only. No application role and NO HTTP
-- ROUTE can change this row — which is why the control is a row rather than an
-- admin endpoint, and why the receipt migration seam (§5.3) can treat
-- `frozen = true` as proof that the owner opened the migration window.
--
-- S2 file 8's `GRANT SELECT/INSERT ON ALL TABLES` applied only to the tables that
-- existed then, so this table starts with no grant at all and receives exactly
-- one. §6.2 P8a proves, as the real role, that atlas_app CAN select and IS REFUSED
-- INSERT, UPDATE and DELETE.
GRANT SELECT ON atlas.write_freeze TO atlas_app;

-- The two SELECT-only roles, for parity with every other table in the schema:
-- read-only tooling (`npm run atlas:status`) may report the freeze state, and the
-- owner-only rebuild principal may read it. Neither can change it either.
GRANT SELECT ON atlas.write_freeze TO atlas_readonly;
GRANT SELECT ON atlas.write_freeze TO atlas_rebuild;

-- atlas_migrate receives NOTHING here — not even SELECT. Its access was cleared
-- with everyone else's above, and nothing grants it back.

-- ── FAIL CLOSED: VERIFY WHAT THIS FILE PRODUCED ──────────────────────────────
--
-- *Required review of `bba3fbf`.* Establishing the invariant is not the same as
-- knowing it holds. `ALTER TABLE … OWNER TO CURRENT_USER` above will fail loudly
-- if the applier cannot take ownership — but a migration that underpins a security
-- control must not depend on every one of its statements having had the effect the
-- author expected. This block asserts the finished state, and RAISES rather than
-- completing if any part of it is wrong.
--
-- The file runs inside one transaction (scripts/apply-supabase-migrations.js), so
-- a raise here rolls the whole migration back. It can never half-apply and leave
-- a control with competing authority alive: either `S3` produced exactly the
-- declared state, or `S3` did not apply.
DO $$
DECLARE
  expected_owner text := current_user;
  actual_owner   text;
  offending      text;
  col_count      int;
  nullable_cols  text;
  row_count      int;
  has_pk         boolean;
  has_check      boolean;
BEGIN
  -- 1. OWNERSHIP — the whole of D7 rests on this one fact.
  SELECT tableowner INTO actual_owner
    FROM pg_tables WHERE schemaname = 'atlas' AND tablename = 'write_freeze';
  IF actual_owner IS DISTINCT FROM expected_owner THEN
    RAISE EXCEPTION
      'atlas.write_freeze is owned by "%" but must be owned by the applying project owner "%"',
      actual_owner, expected_owner
      USING HINT = 'An owner holds implicit DML that no REVOKE can remove, so a second owner is '
                   'a second authority able to lift a freeze. Owner ruling D7 recognises one.';
  END IF;

  -- 2. THE ACCESS LIST — exactly SELECT, to exactly three roles, and nothing else.
  --    Read from pg_class.relacl rather than information_schema, which filters to
  --    what the caller may see; a grant this block cannot see is one it cannot refuse.
  SELECT string_agg(format('%s:%s', grantee_name, a.privilege_type), ', ')
    INTO offending
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    CROSS JOIN LATERAL (
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
    ) AS g(grantee_name)
   WHERE n.nspname = 'atlas' AND c.relname = 'write_freeze'
     AND grantee_name <> expected_owner
     AND NOT (a.privilege_type = 'SELECT'
              AND grantee_name IN ('atlas_app', 'atlas_readonly', 'atlas_rebuild'));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'atlas.write_freeze carries unexpected privileges: %', offending
      USING HINT = 'The runtime holds SELECT and nothing else; only the project owner may write it.';
  END IF;

  -- 3. THE EFFECTIVE ANSWER, not just the catalogue. has_table_privilege accounts
  --    for membership and PUBLIC, so it catches a write reachable by a path the
  --    access-list sweep above would read as absent.
  IF has_table_privilege('atlas_app', 'atlas.write_freeze', 'INSERT')
     OR has_table_privilege('atlas_app', 'atlas.write_freeze', 'UPDATE')
     OR has_table_privilege('atlas_app', 'atlas.write_freeze', 'DELETE')
     OR has_table_privilege('atlas_migrate', 'atlas.write_freeze', 'INSERT')
     OR has_table_privilege('atlas_migrate', 'atlas.write_freeze', 'UPDATE')
     OR has_table_privilege('atlas_migrate', 'atlas.write_freeze', 'DELETE')
     OR has_table_privilege('atlas_readonly', 'atlas.write_freeze', 'UPDATE')
     OR has_table_privilege('atlas_rebuild', 'atlas.write_freeze', 'UPDATE') THEN
    RAISE EXCEPTION 'a scoped role can write atlas.write_freeze — the freeze would have two authorities';
  END IF;
  IF NOT has_table_privilege('atlas_app', 'atlas.write_freeze', 'SELECT') THEN
    RAISE EXCEPTION 'atlas_app cannot read atlas.write_freeze — every write would refuse forever';
  END IF;

  -- 4. THE SHAPE. A pre-existing table could carry the right name and the wrong
  --    guarantees. Without the single-row key this is not "one control with one
  --    meaning", and without NOT NULL a null `frozen` is not a control state.
  SELECT count(*)::int INTO col_count
    FROM information_schema.columns
   WHERE table_schema = 'atlas' AND table_name = 'write_freeze';
  SELECT string_agg(column_name, ', ') INTO nullable_cols
    FROM information_schema.columns
   WHERE table_schema = 'atlas' AND table_name = 'write_freeze' AND is_nullable = 'YES';
  IF col_count <> 5 OR nullable_cols IS NOT NULL THEN
    RAISE EXCEPTION 'atlas.write_freeze has % column(s); nullable: %', col_count, coalesce(nullable_cols, 'none')
      USING HINT = 'Expected exactly id, frozen, reason, set_by, set_at — all NOT NULL (§3.10).';
  END IF;

  SELECT bool_or(contype = 'p'), bool_or(contype = 'c') INTO has_pk, has_check
    FROM pg_constraint WHERE conrelid = 'atlas.write_freeze'::regclass;
  IF NOT coalesce(has_pk, false) OR NOT coalesce(has_check, false) THEN
    RAISE EXCEPTION 'atlas.write_freeze is missing its single-row primary key or its CHECK (id)';
  END IF;

  -- 5. EXACTLY ONE ROW. More than one makes every read ambiguous; none makes the
  --    control unreadable. The runtime treats both as frozen, so neither can open
  --    writes — but neither is a state this migration may leave behind.
  SELECT count(*)::int INTO row_count FROM atlas.write_freeze;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'atlas.write_freeze holds % row(s); exactly one is the control', row_count;
  END IF;
END
$$;
