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

-- ── atlas_migrate receives NOTHING, and the revoke says so out loud ──────────
--
-- It holds no grant here to begin with, because the ALL TABLES grants of S2 file 8
-- ran before this table existed. The explicit REVOKE is therefore a no-op TODAY —
-- it is written for the reader and for the next migration author, so that
-- "atlas_migrate is not a mutator of the freeze" is a statement this file makes
-- rather than an accident of ordering. §6.2 P8a proves the refusal behaviourally,
-- as the real role, which is what actually enforces it.
REVOKE ALL ON atlas.write_freeze FROM atlas_migrate;

-- No INSERT, UPDATE or DELETE is granted to ANY role, and no role owns this table
-- except the project-owner principal that applied this migration. The absence is
-- the control.
