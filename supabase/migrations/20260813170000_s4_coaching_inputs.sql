-- Atlas hot-path migration — S4, the coaching inputs.
--
-- Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §1.1 as widened by
-- OWNER CORRECTION 2026-08-13 (recorded in docs/ATLAS_V1_EXECUTION_PLAN.md):
--
--   "Do not accept Coaching_Notes, Constraints, Deload_State, Exercise_Catalog, or
--    any other data needed for recommendations, coaching, substitutions,
--    prescriptions, preview, approval, save, closeout, receipt retry, or undo as a
--    synchronous Google Sheets dependency."
--
-- ── WHY THESE FOUR, AND WHY NOW ──────────────────────────────────────────────
--
-- The original scope moved the seven workout concepts and left these as
-- Sheets-owned, on the reading that a coaching read degrades gracefully: each call
-- site wrapped its read in `.catch(() => [])`, so a Google Sheets quota exhaustion
-- produced a WEAKER answer rather than a failed one.
--
-- The owner rejected that reading. A recommendation computed without the athlete's
-- typed constraints is not a degraded answer; it is a DIFFERENT answer, and one
-- that can prescribe into an injury the athlete has already reported. The
-- acceptance equation is that a totally quota-exhausted Google Sheets leaves the
-- workout passing — and "passing" means the same coaching decision, not merely a
-- 200 response. So the four workout inputs move, and no Sheets fallback survives.
--
--   atlas.coaching_notes  — the owner-approved coaching notes the chat lane grounds on
--   atlas.constraints     — typed constraints the engine consumes as safety input
--   atlas.deload_state    — the append-only deload state machine's record
--   atlas.modality_log    — athlete-approved cardio/conditioning workout records
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────
--
-- Each table carries EXACTLY the columns of the tab it replaces, in the same
-- owner-approved order (`config/columns.js`), plus provenance. The runtime reads
-- them back as header-stripped cell arrays through
-- `services/coachingInputsAuthority.js`, so no parse site anywhere above the seam
-- changes — only where the rows come from.
--
-- APPEND-ONLY, all four, exactly as the tabs were. Nothing here is updated and
-- nothing is deleted by the runtime: the current constraint set is the accumulated
-- rows, and the current deload state is the newest row by `updated_at`. That is the
-- semantics `services/deloadState.js` already implements over a tab, preserved.

-- ── atlas.coaching_notes ─────────────────────────────────────────────────────
--
-- `Coaching_Notes` is two columns: date, note. The date is the owner's LOCAL day
-- (ATLAS_TIMEZONE), stamped by the route, and it is stored as text rather than
-- `date` for exactly that reason — reinterpreting it as a calendar date here would
-- silently move an evening-Pacific note to the next UTC day, which is the defect
-- F09I fixed in the route.
CREATE TABLE atlas.coaching_notes (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  note_date   text        NOT NULL,
  note        text        NOT NULL,
  -- THE WRITE RECEIPT THIS NOTE WAS ADMITTED UNDER, and it is a real foreign key.
  --
  -- `/api/coaching-notes` is one of the seven receipt-admitted write routes, so a
  -- note that landed did so under a claimed `write_id` — and a row naming a receipt
  -- that does not exist would be a note nothing can explain the provenance of. The
  -- key makes that unrepresentable.
  --
  -- NULLABLE, deliberately: a note carried over from the `Coaching_Notes` tab by the
  -- one-time transition predates the receipt authority and has none, exactly as the
  -- migrated workout children carry a null `write_id` for their pre-cutover rows.
  write_id    text        REFERENCES atlas.write_receipts (write_id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT coaching_notes_note_present_check CHECK (btrim(note) <> ''),
  CONSTRAINT coaching_notes_date_present_check CHECK (btrim(note_date) <> '')
);

-- Undo has no meaning here, but the export worker and any provenance question scan
-- by receipt on a growing table.
CREATE INDEX coaching_notes_write_id_idx ON atlas.coaching_notes (write_id);

-- The grounding read takes the most recent notes. Newest-first by insertion order,
-- which `id` gives exactly and a text date could not.
CREATE INDEX coaching_notes_recent_idx ON atlas.coaching_notes (id DESC);

-- ── atlas.constraints ────────────────────────────────────────────────────────
--
-- `Constraints` is five columns: date, kind, target, rule, note. The vocabulary for
-- `kind` and `rule` lives in `config/columns.js` and the route validates against it;
-- it is deliberately NOT restated as a CHECK here, because a vocabulary that can be
-- extended by an owner ruling must not need a schema migration to accept the new
-- value — and a row this table refused would be a constraint the engine never sees,
-- which is the failure mode this whole migration exists to remove.
CREATE TABLE atlas.constraints (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  constraint_date  text        NOT NULL,
  kind             text        NOT NULL,
  target           text        NOT NULL,
  rule             text        NOT NULL,
  note             text        NOT NULL DEFAULT '',
  -- Same rule as `coaching_notes.write_id`: `/api/constraints` is receipt-admitted,
  -- so a live row names the receipt it was written under, and a row naming a receipt
  -- that does not exist is unrepresentable. Nullable for the one-time carry-over of
  -- rows that predate the receipt authority.
  write_id         text        REFERENCES atlas.write_receipts (write_id),
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT constraints_kind_present_check   CHECK (btrim(kind) <> ''),
  CONSTRAINT constraints_target_present_check CHECK (btrim(target) <> ''),
  CONSTRAINT constraints_rule_present_check   CHECK (btrim(rule) <> '')
);

CREATE INDEX constraints_write_id_idx ON atlas.constraints (write_id);
CREATE INDEX constraints_recent_idx   ON atlas.constraints (id DESC);

-- ── atlas.deload_state ───────────────────────────────────────────────────────
--
-- `Deload_State` is seven columns and is APPEND-ONLY SYSTEM STATE: the current
-- state is the newest row, and the history is the reason a state machine can be
-- audited. Every column is text because the tab stored text and
-- `services/deloadState.js` parses it — changing the storage type here would move
-- the parse into the database and split one authority into two.
--
-- `updated_at` is the ordering key the reader already uses, so it is indexed. It is
-- NOT `created_at`: the record's own timestamp is what the state machine wrote, and
-- an insertion clock could disagree with it.
CREATE TABLE atlas.deload_state (
  id                        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  updated_at                text        NOT NULL,
  training_state            text        NOT NULL,
  deload_protocol           text        NOT NULL DEFAULT '',
  deload_reason             text        NOT NULL DEFAULT '',
  deload_start_date         text        NOT NULL DEFAULT '',
  deload_sessions_remaining text        NOT NULL DEFAULT '',
  deload_exit_criteria      text        NOT NULL DEFAULT '',
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deload_state_training_state_present_check CHECK (btrim(training_state) <> '')
);

CREATE INDEX deload_state_current_idx ON atlas.deload_state (updated_at DESC, id DESC);

-- ── atlas.modality_log ───────────────────────────────────────────────────────
--
-- CARDIO AND CONDITIONING IS A WORKOUT, and `/api/log-modality` is an
-- athlete-facing preview → approve → write path with a write receipt and the write
-- freeze in front of it — the same trust loop the barbell Save runs. Classifying its
-- tab as telemetry was an audit error: a Google Sheets quota exhaustion would have
-- failed that logging request outright, which is precisely the outcome the owner's
-- rule forbids.
--
-- Twelve columns, the same order as `config/columns.js`. Every value is text because
-- the recognizer already normalises units into strings and the row builder is the one
-- authority for that shape — parsing them into numbers here would move part of that
-- contract into the database.
CREATE TABLE atlas.modality_log (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_date    text        NOT NULL,
  session_id    text        NOT NULL DEFAULT '',
  modality      text        NOT NULL,
  exercise      text        NOT NULL DEFAULT '',
  duration_sec  text        NOT NULL DEFAULT '',
  distance_m    text        NOT NULL DEFAULT '',
  rounds        text        NOT NULL DEFAULT '',
  rest_sec      text        NOT NULL DEFAULT '',
  level         text        NOT NULL DEFAULT '',
  rpe           text        NOT NULL DEFAULT '',
  avg_hr        text        NOT NULL DEFAULT '',
  notes         text        NOT NULL DEFAULT '',
  -- Receipt-admitted like the barbell Save, and a real foreign key for the same
  -- reason. Nullable for the rows the one-time transition carries over.
  write_id      text        REFERENCES atlas.write_receipts (write_id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT modality_log_modality_present_check CHECK (btrim(modality) <> ''),
  CONSTRAINT modality_log_date_present_check     CHECK (btrim(entry_date) <> '')
);

CREATE INDEX modality_log_write_id_idx ON atlas.modality_log (write_id);
CREATE INDEX modality_log_recent_idx   ON atlas.modality_log (id DESC);

-- ── Grants ───────────────────────────────────────────────────────────────────
--
-- STATED EXPLICITLY, not inherited. File 8's `GRANT ... ON ALL TABLES IN SCHEMA
-- atlas` binds the tables that existed when it ran; a table created by a later
-- migration receives nothing from it. A silent omission here would surface as a
-- permission-denied on the athlete's first coaching read.
--
-- The runtime reads and appends, and nothing more. No UPDATE and no DELETE: all
-- four are append-only, so a runtime role that could rewrite a constraint could
-- erase a safety input the athlete typed.
GRANT SELECT, INSERT ON atlas.coaching_notes TO atlas_app;
GRANT SELECT, INSERT ON atlas.constraints    TO atlas_app;
GRANT SELECT, INSERT ON atlas.deload_state   TO atlas_app;
GRANT SELECT, INSERT ON atlas.modality_log   TO atlas_app;

GRANT SELECT ON atlas.coaching_notes TO atlas_readonly;
GRANT SELECT ON atlas.constraints    TO atlas_readonly;
GRANT SELECT ON atlas.deload_state   TO atlas_readonly;
GRANT SELECT ON atlas.modality_log   TO atlas_readonly;

-- The mirror rebuild (§5.7) reconstructs the human-readable export from Supabase,
-- so it reads these and may never write them.
GRANT SELECT ON atlas.coaching_notes TO atlas_rebuild;
GRANT SELECT ON atlas.constraints    TO atlas_rebuild;
GRANT SELECT ON atlas.deload_state   TO atlas_rebuild;
GRANT SELECT ON atlas.modality_log   TO atlas_rebuild;

-- The owner-run maintenance principal, for a correction or a one-time carry-over of
-- rows that predate the cutover.
GRANT SELECT, INSERT, UPDATE, DELETE ON atlas.coaching_notes TO atlas_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON atlas.constraints    TO atlas_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON atlas.deload_state   TO atlas_migrate;
GRANT SELECT, INSERT, UPDATE, DELETE ON atlas.modality_log   TO atlas_migrate;

-- ── The four identity sequences, NAMED ───────────────────────────────────────
--
-- `GENERATED ALWAYS AS IDENTITY` needs USAGE on the backing sequence for an INSERT
-- to succeed, and file 8's grant bound the sequences that existed when it ran.
--
-- NAMED RATHER THAN `ALL SEQUENCES IN SCHEMA atlas`, deliberately. The blanket form
-- would silently widen the runtime role's reach to every sequence in the schema —
-- including any a later migration adds for a concept `atlas_app` has no business
-- writing — which is the opposite of what §8.2's least-privilege model is for. Three
-- tables were added here, so four sequences are granted here.
--
-- `pg_get_serial_sequence` resolves the identity sequence by its table and column
-- rather than by a name this file guesses, so a rename in Postgres's own naming
-- convention cannot silently produce a grant that binds nothing.
DO $$
DECLARE
  seq text;
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('atlas.coaching_notes'), ('atlas.constraints'),
      ('atlas.deload_state'), ('atlas.modality_log')
    ) AS t(table_name)
  LOOP
    seq := pg_get_serial_sequence(target.table_name, 'id');
    IF seq IS NULL THEN
      RAISE EXCEPTION 'no identity sequence found for %.id', target.table_name;
    END IF;
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO atlas_app', seq);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO atlas_migrate', seq);
  END LOOP;
END $$;
