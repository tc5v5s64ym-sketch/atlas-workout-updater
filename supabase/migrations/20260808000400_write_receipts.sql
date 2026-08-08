-- Atlas hot-path migration — S2, file 4 of 8: the write-receipt state machine.
--
-- atlas.write_receipts (§3.6). Replaces the file-backed store in
-- services/idempotency.js for all seven beginWrite callers — AT S4, not now.
--
-- S2 AND S3 MIRROR NO RECEIPTS INTO THIS TABLE (§3.6, "S2 and S3 do not mirror
-- receipts at all"). The file store stays the sole receipt authority throughout
-- the shadow window: Log_Cleaned and Effort carry no write_id column, so Sheets
-- cannot be this concept's completeness authority and the sweep cannot
-- reconstruct a receipt lost in the death window. The table is created now
-- because S2 owns the schema; it is exercised now only by the deterministic
-- state-machine proof (§6.1 P8, P8a, P8a0, P8c), never by a production path.
--
-- This is a STATE MACHINE, not an insert plus a terminal update. The row is
-- deliberately mutable. A write_id is NOT consumed by a failed attempt: a
-- 'failed' record is retryable, because a prior attempt released without
-- committing. `ON CONFLICT DO NOTHING` would read a failed row as a duplicate and
-- permanently consume the write_id — a lost workout, not a protected one.
CREATE TABLE atlas.write_receipts (
  write_id           text        PRIMARY KEY,
  route              text        NOT NULL,
  -- Nullable: a claim is made before the id is known on some paths, and three of
  -- the seven routes have no session at all.
  session_id         text,
  status             text        NOT NULL,
  -- The current attempt's token, regenerated on every newly-owned attempt.
  -- completeWrite and failWrite are guarded on it so a superseded attempt's late
  -- completion is discarded rather than applied. failWrite NULLs it in the same
  -- statement, which makes resurrection of a released attempt unrepresentable.
  attempt_token      uuid,
  attempt            integer     NOT NULL DEFAULT 1,
  -- WHICH PROCESS OWNS THE CURRENT ATTEMPT.
  --
  -- This column is the liveness evidence, and it replaces an earlier mechanism
  -- that used a session-scoped advisory lock for the same job. That mechanism was
  -- unsound: Postgres releases an advisory lock the instant its connection drops,
  -- while the Google Sheets request the attempt is awaiting is an independent
  -- HTTP call that can still be in flight and can still commit. A dropped
  -- database session is NOT evidence that an external effect died, so a
  -- competitor could take the freed lock and perform the same append.
  --
  -- Process identity carries no such inference. It does not change when a
  -- connection drops, so an attempt owned by a live process stays owned. It
  -- mirrors the rule the live file store actually uses (services/idempotency.js):
  -- a record is retryable only when it was REHYDRATED FROM A PRIOR PROCESS, never
  -- merely because time passed.
  owner_instance_id  text,
  response_body      jsonb,
  rows_written       integer,
  -- Kept while the Sheets mirror exists; null afterwards.
  appended_range     text,
  -- Immutable provenance — when the write_id was first seen. NOT the TTL clock.
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- THE TTL AUTHORITY. attempt_started_at + 24 hours, refreshed on every
  -- newly-owned attempt. Every read filters on it; the prune deletes on it.
  -- NOT NULL and no default: the claim statement must set it explicitly, because
  -- a receipt with a null TTL is invisible to peekWrite the instant it is created
  -- and is therefore not a duplicate shield at all.
  expires_at         timestamptz NOT NULL,
  -- Start of the CURRENT attempt. The staleness clock reads this, not created_at.
  attempt_started_at timestamptz NOT NULL,
  completed_at       timestamptz,

  CONSTRAINT write_receipts_status_check
    CHECK (status IN ('in_progress', 'completed', 'failed'))
);

-- The prune job's scan. The prune bounds table size only; it carries no
-- correctness, because the claim statement reclaims an expired row atomically.
CREATE INDEX write_receipts_expiry_idx ON atlas.write_receipts (expires_at);
