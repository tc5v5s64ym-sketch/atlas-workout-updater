-- Atlas hot-path migration — S2, file 5 of 8: the Exercise_Catalog read mirror.
--
-- atlas.exercise_catalog_sync and atlas.exercise_catalog_mirror (§3.7, ruling D1).
--
-- Reference data, not workout data. Google Sheets stays the EDITING authority for
-- Exercise_Catalog; Supabase becomes the Save-path READ mirror at S4. The catalog
-- is two tables, not one, because content and freshness are separate concerns —
-- collapsing them left the mirror with no freshness authority at all.

-- ── The freshness authority ────────────────────────────────────────────────────
--
-- One row per sync ATTEMPT. The current generation is the newest status='verified'
-- row. A FAILED sync never advances currency: it records last_error and leaves the
-- previous verified generation current, so that generation keeps ageing and a
-- persistently failing sync eventually fails Saves closed. A failure cannot buy
-- the mirror more time.
--
-- A CHANGED SOURCE IS NOT A FAILURE. Sheets is the editing authority, so a
-- different content_hash is the normal signal that the owner edited the catalog:
-- it drives the ordinary transactional swap and produces a new verified
-- generation. Only a read failure, an empty or materially shrunken source, a
-- failed verification, or a failed swap records 'failed'.
CREATE TABLE atlas.exercise_catalog_sync (
  sync_id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at       timestamptz NOT NULL DEFAULT now(),
  -- Set only when the swap committed AND the content was verified.
  verified_at      timestamptz,
  status           text        NOT NULL,
  -- SHA-256 over the normalised source rows, in order. The version identity.
  content_hash     text,
  source_row_count integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT exercise_catalog_sync_status_check
    CHECK (status IN ('in_progress', 'verified', 'failed')),
  -- A generation may not claim verification without the two facts that make it
  -- servable: when it was verified, and what content it verified.
  CONSTRAINT exercise_catalog_sync_verified_complete_check
    CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND content_hash IS NOT NULL))
);

-- The currency lookup.
CREATE INDEX exercise_catalog_sync_current_idx
  ON atlas.exercise_catalog_sync (verified_at DESC)
  WHERE status = 'verified';

-- ── The content ────────────────────────────────────────────────────────────────
--
-- Wholly replaced per generation, in ONE transaction (delete the previous
-- generation's rows, insert the new rows, mark the generation verified), so a
-- reader never sees a half-written catalog. The swap uses DELETE rather than
-- TRUNCATE precisely so the runtime role needs no DDL privilege.
CREATE TABLE atlas.exercise_catalog_mirror (
  -- lower(exercise) — the lookup key the resolver uses.
  exercise           text        PRIMARY KEY,
  -- The catalog's `Exercise` cell, verbatim.
  display_exercise   text        NOT NULL,
  muscle_group       text,
  lift_code          text,
  canonical_exercise text,
  -- Mirror provenance: the generation that wrote this row. There is deliberately
  -- no per-row timestamp — a second clock here would be a duplicate freshness
  -- authority, which is exactly what splitting the two tables avoids.
  sync_id            bigint      NOT NULL REFERENCES atlas.exercise_catalog_sync (sync_id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX exercise_catalog_mirror_lift_idx ON atlas.exercise_catalog_mirror (lift_code);
CREATE INDEX exercise_catalog_mirror_sync_idx ON atlas.exercise_catalog_mirror (sync_id);
