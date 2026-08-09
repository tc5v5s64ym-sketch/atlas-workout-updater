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
-- Declared DML operation 2 of 2 in atlas_migrate's grant list (§3.10, §8.2). The
-- row ships `frozen = false`, so applying this migration changes no behaviour:
-- §6.2 P12 proves the dormant path is byte-identical to the pre-S3 build.
--
-- Issued BEFORE the ownership transfer below, while the applier still owns the
-- table it just created. ON CONFLICT DO NOTHING makes a re-apply a no-op and — far
-- more importantly — means a RE-RUN CAN NEVER LIFT A LIVE FREEZE. A seed that
-- overwrote the row would hand every future migration run the power to reopen
-- writes the owner had closed, which is exactly the authority this control exists
-- to keep in one place.
INSERT INTO atlas.write_freeze (id, frozen, reason, set_by)
VALUES (true, false, 'dormant — seeded by the S3 migration; writes open', 'migration:S3')
ON CONFLICT (id) DO NOTHING;

-- ── Ownership ────────────────────────────────────────────────────────────────
--
-- Mirrors S2 file 8: in PostgreSQL, DDL authority IS ownership, so atlas_migrate
-- owns every table in the schema. Re-granting membership to the applier is
-- idempotent and keeps this file self-contained rather than silently depending on
-- a grant made in an earlier file — the applier created atlas_migrate in S2 and so
-- holds ADMIN OPTION on it.
GRANT atlas_migrate TO current_user;
ALTER TABLE atlas.write_freeze OWNER TO atlas_migrate;

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

-- No INSERT, UPDATE or DELETE is granted to any role. The absence is the control.
