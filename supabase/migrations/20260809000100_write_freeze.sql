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
--
-- ── ONE LEGITIMATE STARTING STATE: ABSENT ────────────────────────────────────
--
-- *Architectural ruling after review round 6 (2026-08-10).* This file used to say
-- `CREATE TABLE IF NOT EXISTS`, and then spent ninety lines taking ownership of,
-- rebuilding the access list of, and re-verifying whatever object it happened to
-- find. That was the wrong optimization target, and each round of review found
-- another hostile variant the verifier had not anticipated.
--
-- The repository and the deployment already establish the only state S3 may start
-- from: S2 is applied to `Atlas Production`, `atlas.write_freeze` was explicitly
-- verified ABSENT there by the P8b checkpoint, S3 is the one migration that creates
-- it, the migration runner refuses any non-empty target, and hosted application is
-- owner-run out of band exactly once.
--
-- Given that, a pre-existing `atlas.write_freeze` is DRIFT, NOT A COMPATIBILITY
-- STATE. The correct response to drift is to refuse and change nothing — never to
-- adopt an object of unknown provenance and try to prove every hostile variant was
-- normalised. So the create below is strict: if anything of that name already
-- exists, this statement raises, the file's single transaction rolls back, and S3
-- applies nothing at all.
--
-- That is also why this file no longer verifies its own DDL. Because S3 creates the
-- table in this transaction, the CREATE is the schema source of truth; a catalogue
-- query restating it would be a second implementation of the same declaration, and
-- the two could disagree. Successful transactional DDL is the proof.
--
-- THE COST, STATED: this migration is no longer re-runnable. Applying it twice
-- fails on the second attempt. That is intended — a second application has nothing
-- legitimate to do, and failing is how drift becomes visible.

CREATE TABLE atlas.write_freeze (
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
-- Migration-time DML by the PROJECT-OWNER / APPLIER principal — `postgres` on
-- `Atlas Production`, and its NOSUPERUSER mirror in the from-empty proof — acting
-- as the owner of the table it created one statement ago. It needs no grant,
-- because that principal owns the object by construction: the strict CREATE above
-- guarantees this file made it. `atlas_migrate` receives no authority over it.
--
-- The row ships `frozen = false`, so applying this migration changes no behaviour:
-- §6.2 P12 proves the dormant path is byte-identical to the pre-S3 build.
--
-- A PLAIN INSERT, deliberately. This used to carry `ON CONFLICT (id) DO NOTHING`
-- so that a re-apply could never overwrite — and therefore never lift — a live
-- freeze. The strict CREATE now enforces that far earlier and far harder: a re-run
-- cannot reach this statement at all. A conflict clause here would only be able to
-- hide a bug, because the table is one statement old and provably empty.
INSERT INTO atlas.write_freeze (id, frozen, reason, set_by)
VALUES (true, false, 'dormant — seeded by the S3 migration; writes open', 'migration:S3');

-- ── D7: THE SCHEMA-OWNER REPLACEMENT BYPASS, CLOSED ──────────────────────────
--
-- *Required review of `a29129e`.* Refusing row DML on the control was not enough.
-- S2 file 8 made atlas_migrate the OWNER OF SCHEMA `atlas`, and a schema owner does
-- not need to write the row to defeat D7: it can DROP the control, CREATE one of
-- the same name seeded `frozen = false`, GRANT SELECT to atlas_app, and the runtime
-- reads a valid row saying writes are open.
--
-- So the schema authority is narrowed here, after the S2 state exists, rather than
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
-- existed then, so this table is created with an empty access list and receives
-- exactly one privilege. §6.2 P8a proves, as the real role, that atlas_app CAN
-- select and IS REFUSED INSERT, UPDATE and DELETE.
GRANT SELECT ON atlas.write_freeze TO atlas_app;

-- The two SELECT-only roles, for parity with every other table in the schema:
-- read-only tooling (`npm run atlas:status`) may report the freeze state, and the
-- owner-only rebuild principal may read it. Neither can change it either.
GRANT SELECT ON atlas.write_freeze TO atlas_readonly;
GRANT SELECT ON atlas.write_freeze TO atlas_rebuild;

-- atlas_migrate receives NOTHING — not even SELECT.

-- ── THE ONE POSTCONDITION THAT THE DDL ABOVE DOES NOT ALREADY GUARANTEE ──────
--
-- Everything else this file used to assert is now established by construction:
-- the shape, the primary key, the CHECK and the single seeded row come from a
-- CREATE and an INSERT that either succeeded or rolled the file back, and the
-- ownership comes from the strict CREATE having been performed by this principal.
-- Restating any of that in catalogue queries would be a second implementation of
-- the same declaration.
--
-- THIS IS DIFFERENT. It is a statement about an ABSENCE — that no scoped role can
-- write the control — and an absence is not established by any statement above.
-- `ALTER DEFAULT PRIVILEGES` is configured outside this file and can attach grants
-- to a newly created table, so "no grants beyond the three SELECTs" is a genuine
-- postcondition rather than a restatement. It is also the exact property D7 turns
-- on, which makes it the one worth failing the migration over.
--
-- IT REACHES FURTHER THAN GRANTS, AND THAT WAS MEASURED RATHER THAN INTENDED.
-- `has_table_privilege` reports an OWNER's implicit privileges too, so this block
-- also refuses a control owned by any of the four scoped roles. §6.2 P8a's mutation
-- pair shows it: with the strict CREATE weakened back to `IF NOT EXISTS`, a drifted
-- table still owned by atlas_migrate is caught HERE instead. The two defences are
-- independent — the create refuses early, on identity, before anything is
-- inspected; this refuses late, on effective privilege — and only removing both
-- lets a pre-existing object be adopted.
-- ONE INVARIANT, DERIVED FROM POSTGRESQL — NOT A LIST THIS FILE MAINTAINS.
--
-- *Architectural ruling after review round 8 (2026-08-10).* Two consecutive
-- reviews found the same defect in different clothes: a hand-maintained set of
-- forbidden privileges that was missing one. Round 7 was missing INSERT and DELETE
-- for two roles. Round 8 was missing TRIGGER for all four — and TRIGGER is not a
-- metadata privilege. `CREATE TRIGGER` needs it, and a BEFORE UPDATE trigger can
-- rewrite `NEW.frozen`, so a scoped role holding it can silently change what an
-- owner's freeze actually stores. That is a second effective authority over the
-- write-admission decision, which is exactly what D7 forbids.
--
-- The maintained list WAS the defect pattern, so it is gone. The invariant is now
-- stated once:
--
--     for atlas.write_freeze, a scoped role may hold SELECT and nothing else.
--
-- The privilege set is read from `acldefault('r', …)`, which is PostgreSQL's own
-- answer to "what privileges exist for a relation owned by this role". It is
-- therefore complete for whatever version is executing — including `MAINTAIN`,
-- which exists only from PostgreSQL 17 and which no list written today would have
-- contained. Nothing here needs updating when the set changes.
--
-- `has_table_privilege` is kept as the test because it answers about EFFECTIVE
-- privilege: it accounts for grants held through role membership and through
-- PUBLIC, which reading the access list directly would miss.
--
-- The refusal names the offending role and privilege, so an operator does not have
-- to re-derive which combination tripped it.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(format('%s:%s', r.role, p.priv), ', ' ORDER BY r.role, p.priv)
    INTO offending
    FROM unnest(ARRAY['atlas_app', 'atlas_migrate', 'atlas_readonly', 'atlas_rebuild']) AS r(role)
    CROSS JOIN (
      SELECT a.privilege_type AS priv
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(acldefault('r', c.relowner)) AS a
       WHERE c.oid = 'atlas.write_freeze'::regclass
         AND a.privilege_type <> 'SELECT'
    ) AS p
   WHERE has_table_privilege(r.role, 'atlas.write_freeze', p.priv);

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'a scoped role holds a privilege beyond SELECT on atlas.write_freeze: %', offending
      USING HINT = 'Owner ruling D7 recognises one mutator: the Supabase project owner. '
                   'Clear the ALTER DEFAULT PRIVILEGES that granted this, then re-apply.';
  END IF;

  IF NOT has_table_privilege('atlas_app', 'atlas.write_freeze', 'SELECT') THEN
    RAISE EXCEPTION 'atlas_app cannot read atlas.write_freeze — every write would refuse forever';
  END IF;
END
$$;
