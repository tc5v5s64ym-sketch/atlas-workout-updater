-- Atlas hot-path migration — S4, file 2 of 2: the cutover schema.
--
-- Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.5 step 5, §3.6, and
-- gate §6.3 P20.
--
-- This is the schema half of the step that makes Supabase the receipt authority.
-- It adds the two `write_id` foreign keys that S2 and S3 could not add.
--
-- WHY THEY VALIDATE. S2 and S3 always stored `write_id = NULL` on both child
-- tables (§3.6, proven by §6.1 P7d): receipts were never mirrored during the
-- shadow window, so no child row can reference a receipt that does not exist. A
-- NOT VALID constraint is therefore not needed and is not used — the constraint is
-- added validated, and §6.3 P20 proves it validates against a database carrying
-- genuine shadow rows rather than an empty one.
--
-- Only post-cutover writes carry a non-null value, and each of those is backed by
-- a receipt created in the same authority path.

ALTER TABLE atlas.logged_sets
  ADD CONSTRAINT logged_sets_write_id_fkey
  FOREIGN KEY (write_id) REFERENCES atlas.write_receipts (write_id);

ALTER TABLE atlas.session_effort
  ADD CONSTRAINT session_effort_write_id_fkey
  FOREIGN KEY (write_id) REFERENCES atlas.write_receipts (write_id);

-- Undo deletes a Save's rows by (session_id, write_id), and the export worker
-- rewrites a session's block. Both scan by write_id on a growing table.
CREATE INDEX logged_sets_write_id_idx    ON atlas.logged_sets    (write_id);
CREATE INDEX session_effort_write_id_idx ON atlas.session_effort (write_id);

-- ── The export queue predicate gets the index it actually uses ────────────────
--
-- §5.4 mechanism 1: a session owes an export when a closeout event exists AND
-- `sheets_exported_at IS NULL` AND `sheets_export_state <> 'blocked'` AND its
-- backoff has elapsed. The S2 index covers only the first of those, so the worker
-- would scan every unexported session — including every `blocked` one — on every
-- pass. That is the read-amplification shape §5.4 forbids, one layer down.
DROP INDEX IF EXISTS atlas.workout_sessions_export_queue_idx;
CREATE INDEX workout_sessions_export_queue_idx
  ON atlas.workout_sessions (sheets_export_next_attempt_at NULLS FIRST, session_id)
  WHERE sheets_exported_at IS NULL AND sheets_export_state <> 'blocked';

-- `atlas:status` reports the structural backlog the owner must clear. Without
-- this it is a sequential scan of the whole table.
CREATE INDEX workout_sessions_export_blocked_idx
  ON atlas.workout_sessions (session_id)
  WHERE sheets_export_state = 'blocked';
