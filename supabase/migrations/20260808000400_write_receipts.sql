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
  -- WHERE THIS ROUTE'S AUTHORITATIVE EFFECT LANDS. Set at claim from a frozen
  -- route map in the adapter; never inferred, never defaulted.
  --
  -- ONE STATE MACHINE CANNOT INFER IDENTICAL RETRYABILITY FOR A TRANSACTIONAL
  -- AND A NON-TRANSACTIONAL EFFECT. Ruling D4 moves the receipt for all seven
  -- beginWrite callers, but only three of them move their DATA:
  --
  --   'supabase' — /api/log-workout, /api/complete-workout, undo-last. After S4
  --     the authoritative effect is one Supabase transaction, which is atomically
  --     present or atomically absent; a process that died mid-flight committed
  --     nothing. Their Sheets export is a MIRROR written by
  --     spreadsheets.values.update into a destination allocated once per session
  --     per tab (§3.9, §5.3), so a late duplicate overwrites its own identical
  --     cells and cannot make a second copy. Retry is therefore safe.
  --
  --   'sheets' — coaching-notes, constraints, log-modality, bodyweight. Their
  --     rows keep appending to their own Sheets tabs with no allocated
  --     destination and no Supabase constraint able to catch a duplicate. An
  --     append already sent to Google CANNOT BE RECALLED: the request can be
  --     accepted and committed server-side without the client process surviving
  --     to record it. Process death is not proof of a non-write.
  effect_authority   text        NOT NULL,
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
  --
  -- LIFECYCLE, stated because this is load-bearing safety state:
  --   new claim / retry / reclaim — set to the claiming process's id, always;
  --   'in_progress'               — NEVER NULL. Enforced structurally below, not
  --                                 by the discipline of the one adapter call
  --                                 site: a live attempt whose owner is unknown
  --                                 is a state the reclaim rule cannot interpret,
  --                                 so it must be unrepresentable.
  --   'completed' / 'failed'      — retained as provenance of the last attempt's
  --                                 owner. Never cleared; nothing reads it.
  --   'ambiguous'                 — retained, and it is EVIDENCE: it names the
  --                                 process whose external effect is unresolved.
  --   S4 carry (§5.5a)            — the file store records no owner, so a carried
  --                                 record cannot supply one. The drain normalises
  --                                 every carried 'in_progress' record to 'failed'
  --                                 (§5.5 step 2 sub-step i) BEFORE the handover
  --                                 inserts it, so no carried row is ever
  --                                 'in_progress' and the NOT NULL rule below is
  --                                 satisfiable without inventing an owner.
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
  -- WHEN THE EFFECT BECAME UNRESOLVED. Set once, never cleared — it is what makes
  -- "this row was ambiguous at some point" durable after the row leaves the
  -- 'ambiguous' status, which is what the resolution-proof rule below needs.
  ambiguous_at       timestamptz,
  -- THE DESTINATION-SIDE PROOF that resolved it, in the athlete-safe form the
  -- divergence ledger already uses for closure_proof: what was read at the
  -- destination, and what it showed. Prose, not a flag, because a flag can be set
  -- by inference and prose cannot be set by a timer.
  ambiguity_proof    text,

  CONSTRAINT write_receipts_status_check
    CHECK (status IN ('in_progress', 'completed', 'failed', 'ambiguous')),

  CONSTRAINT write_receipts_effect_authority_check
    CHECK (effect_authority IN ('supabase', 'sheets')),

  -- P1 of the required review of `deaa8a5`: an 'in_progress' row with no owner is
  -- a live attempt the reclaim rule cannot interpret. `IS DISTINCT FROM` would
  -- read NULL as "some other process", so such a row would be reclaimed on age
  -- alone — exactly the time-based inference this column exists to remove.
  CONSTRAINT write_receipts_live_attempt_has_owner_check
    CHECK (status <> 'in_progress' OR owner_instance_id IS NOT NULL),

  -- 'ambiguous' is meaningless for an atomic effect: a Supabase transaction is
  -- present or absent, never maybe. Allowing it there would invite the state to be
  -- used as a general-purpose stall.
  CONSTRAINT write_receipts_ambiguous_is_sheets_only_check
    CHECK (status <> 'ambiguous' OR (effect_authority = 'sheets' AND ambiguous_at IS NOT NULL)),

  -- The dead process's token is void the moment the row becomes ambiguous, so its
  -- late completion cannot resurrect the attempt. Same rule failWrite uses.
  CONSTRAINT write_receipts_ambiguous_token_void_check
    CHECK (status <> 'ambiguous' OR attempt_token IS NULL),

  -- ONCE AMBIGUOUS, ONLY PROOF GETS YOU OUT. A row that has ever been ambiguous
  -- may not reach any other status without a recorded destination-side proof.
  -- Structural, because every unsound alternative — waiting, pruning, a retry — is
  -- a status change with no proof attached, and each is a duplicate append.
  CONSTRAINT write_receipts_ambiguity_needs_proof_check
    CHECK (ambiguous_at IS NULL
           OR status = 'ambiguous'
           OR (ambiguity_proof IS NOT NULL AND ambiguity_proof <> ''))
);

-- The prune job's scan. The prune bounds table size only; it carries no
-- correctness, because the claim statement reclaims an expired row atomically.
--
-- THE PRUNE MUST SKIP 'ambiguous' ROWS, and its statement does. Deleting one
-- would silently un-wedge a write_id whose external effect is still unproven —
-- the next claim would insert a clean row and permit the second append. That is
-- the same time-based inference by a different door, so the TTL does not open it
-- either: the claim's expired-row branch excludes 'ambiguous' as well.
CREATE INDEX write_receipts_expiry_idx ON atlas.write_receipts (expires_at);

-- The unresolved-effect queue. Small and rare, so this exists for the operator
-- read ("what is waiting on destination-side proof"), not for throughput.
CREATE INDEX write_receipts_ambiguous_idx
  ON atlas.write_receipts (ambiguous_at)
  WHERE status = 'ambiguous';
