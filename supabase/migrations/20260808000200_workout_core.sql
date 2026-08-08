-- Atlas hot-path migration — S2, file 2 of 8: the workout core.
--
-- atlas.workout_sessions (§3.1), atlas.logged_sets (§3.2), atlas.session_effort (§3.3).
--
-- These are the three tables the shadow write touches on every Save. The session
-- row is the PARENT: every migrated child references it, and §5.2 requires the
-- parent to be inserted inside the same transaction as its children, before them.

-- ── §3.1 atlas.workout_sessions ────────────────────────────────────────────────
--
-- Session identity, its allocation, and the Sheets-export state of that session.
-- Insert-only for IDENTITY; exactly six columns are updatable, all of them export
-- state. This table does NOT hold closeout — the session-level closeout authority
-- is the `session_closeout` row in atlas.session_plan_events (§3.4). Export state
-- is not closeout state.
--
-- The export DESTINATION is deliberately absent: it lives in
-- atlas.sheets_mirror_allocations (§3.9), because a per-session column cannot
-- serialise two different sessions competing for the same mirror rows.
CREATE TABLE atlas.workout_sessions (
  session_id                    text        PRIMARY KEY,
  session_date                  date        NOT NULL,
  period                        text        NOT NULL,
  slot                          smallint    NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  sheets_exported_at            timestamptz,
  sheets_export_attempts        integer     NOT NULL DEFAULT 0,
  sheets_export_error           text,
  export_claim_token            uuid,
  sheets_export_state           text        NOT NULL DEFAULT 'queued',
  sheets_export_next_attempt_at timestamptz,

  CONSTRAINT workout_sessions_period_check
    CHECK (period IN ('AM', 'PM')),
  CONSTRAINT workout_sessions_slot_check
    CHECK (slot BETWEEN 1 AND 99),
  -- 'blocked' means only the §5.7 owner rebuild can clear it, and the session
  -- leaves the export queue entirely.
  CONSTRAINT workout_sessions_export_state_check
    CHECK (sheets_export_state IN ('queued', 'retry_backoff', 'blocked')),
  -- Allocation becomes ONE atomic insert instead of a read-then-scan, so two
  -- concurrent allocations can no longer pick the same id.
  CONSTRAINT workout_sessions_slot_unique
    UNIQUE (session_date, period, slot)
);

CREATE INDEX workout_sessions_date_idx
  ON atlas.workout_sessions (session_date DESC);

-- The S4 export worker's queue scan. Unused before S4; declared here because the
-- table is created here.
CREATE INDEX workout_sessions_export_queue_idx
  ON atlas.workout_sessions (session_id)
  WHERE sheets_exported_at IS NULL;

-- ── §3.2 atlas.logged_sets ─────────────────────────────────────────────────────
--
-- Replaces Log_Cleaned. Append-only, plus delete-by-write_id for undo. No row is
-- ever updated.
--
-- write_id carries NO foreign key at S2/S3 and is ALWAYS NULL in those eras
-- (§3.6): receipts are not mirrored during the shadow window, so a non-null value
-- would have no parent row and would break the S4 migration that adds the key.
CREATE TABLE atlas.logged_sets (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id         text        NOT NULL REFERENCES atlas.workout_sessions (session_id),
  date_clean         date,
  exercise           text        NOT NULL,
  canonical_exercise text,
  muscle_group       text,
  lift_code          text,
  set_number         integer     NOT NULL,
  weight             numeric,
  reps               integer,
  rir                numeric,
  notes              text,
  volume_calc        numeric,
  write_id           text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- The exact composite key getLogCompositeKeys() builds today
-- (session_id||exercise||set_number, lower-cased whole). Invariants W1-W3's second
-- line of defence moves from a read-and-compare in application code to a database
-- constraint. It is also the export identity key (§5.4).
--
-- exercise and set_number are NOT NULL above precisely so this index cannot be
-- defeated by SQL's "NULLs are distinct" rule in a unique index.
CREATE UNIQUE INDEX logged_sets_identity_key
  ON atlas.logged_sets (lower(session_id), lower(exercise), set_number);

CREATE INDEX logged_sets_session_idx  ON atlas.logged_sets (session_id);
CREATE INDEX logged_sets_lift_idx     ON atlas.logged_sets (lift_code, date_clean DESC);
CREATE INDEX logged_sets_date_idx     ON atlas.logged_sets (date_clean DESC);

-- ── §3.3 atlas.session_effort ──────────────────────────────────────────────────
--
-- Replaces Effort. Insert-only. One row per session IS the existing
-- duplicate-session guard, which today costs a read of Effort!B:B on every Save.
--
-- `effort_date` is renamed from the sheet's `date` only because `date` is a
-- reserved word. `duration` stays free text, stored exactly as supplied;
-- parseDurationMinutes (services/validation.js) stays its sole interpreter.
CREATE TABLE atlas.session_effort (
  session_id      text        PRIMARY KEY REFERENCES atlas.workout_sessions (session_id),
  effort_date     date,
  duration        text,
  active_calories numeric,
  total_calories  numeric,
  average_hr      numeric,
  peak_hr         numeric,
  location        text,
  notes           text,
  write_id        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
