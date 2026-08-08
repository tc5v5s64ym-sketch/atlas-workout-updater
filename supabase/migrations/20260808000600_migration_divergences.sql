-- Atlas hot-path migration — S2, file 6 of 8: the divergence lane. TEMPORARY.
--
-- atlas.migration_divergences (§3.8).
--
-- THIS TABLE IS MIGRATION-CONTROL MACHINERY, NOT PRODUCT DATA. It exists because
-- S2 requires a durable divergence record, S3 requires its open count to reach
-- zero, and S4 will not merge while any row is open — and a required gate cannot
-- depend on an unnamed record.
--
-- LIFETIME: S4 deletes every CONSUMER and WRITER of it (the inline shadow lane,
-- the reconciliation sweep, the repair worker) and verifies all three absent,
-- leaving the TABLE inert. The table itself is dropped only after the S4 rollback
-- window closes, because a restored S3 build queries it during that window
-- (§5.4 step 5, gate P19i).
--
-- NOTHING THAT OUTLIVES S4 MAY WRITE TO IT. Post-cutover mirror failures are
-- mirror state and live in the permanent export columns on atlas.workout_sessions.
-- Gate §6.1 P7c0 proves the writer set is exactly the three temporary modules.
--
-- `write_receipts` is DELIBERATELY ABSENT from the concept vocabulary: Sheets
-- stores no write_id, so it cannot be that concept's completeness authority
-- (§3.6). The design does not declare a check it cannot perform.
CREATE TABLE atlas.migration_divergences (
  id                      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  concept                 text        NOT NULL,
  -- The diverged row's identity: the export identity key for the four migrated
  -- tabs (§3.2-§3.5), and the sync generation's content_hash for exercise_catalog.
  identity_key            text        NOT NULL,
  -- Nullable — an orphan row may not resolve to a session.
  session_id              text,
  -- Present when an inline shadow write caused the divergence.
  write_id                text,
  route                   text,
  reason                  text        NOT NULL,
  detected_by             text        NOT NULL,
  detected_at             timestamptz NOT NULL DEFAULT now(),
  state                   text        NOT NULL DEFAULT 'open',
  repair_attempts         integer     NOT NULL DEFAULT 0,
  -- Lease held by the repairing worker; a crashed repairer's lease lapses.
  repair_claim_token      uuid,
  repair_claim_expires_at timestamptz,
  -- The field-level difference, with workout values redacted to shapes.
  comparison_result       jsonb,
  closed_at               timestamptz,
  -- The re-comparison that closed it. NEVER a timestamp alone.
  closure_proof           text,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT migration_divergences_concept_check
    CHECK (concept IN ('logged_sets', 'session_effort', 'session_plan_events',
                       'session_plan_set_recommendations', 'exercise_catalog')),
  -- No exporter reason appears here: the exporter is post-S4, by which point this
  -- table has no writer and no reader.
  CONSTRAINT migration_divergences_reason_check
    CHECK (reason IN ('shadow_write_failed', 'missing_in_supabase',
                      'missing_in_sheets', 'content_mismatch')),
  CONSTRAINT migration_divergences_detected_by_check
    CHECK (detected_by IN ('inline_shadow', 'sweep')),
  CONSTRAINT migration_divergences_state_check
    CHECK (state IN ('open', 'repairing', 'closed')),
  -- A divergence is NEVER closed by a timer, never aged out, and never closed
  -- without closure_proof. This constraint is what makes that structural rather
  -- than a convention the repair worker is trusted to keep.
  CONSTRAINT migration_divergences_closure_proof_check
    CHECK (state <> 'closed'
           OR (closure_proof IS NOT NULL AND closure_proof <> '' AND closed_at IS NOT NULL))
);

-- At most one OPEN divergence per row identity, so a repeated sweep does not
-- multiply rows. Closed rows stay as history and are exempt.
CREATE UNIQUE INDEX migration_divergences_open_identity_unique
  ON atlas.migration_divergences (concept, identity_key)
  WHERE state <> 'closed';

-- The repair queue.
CREATE INDEX migration_divergences_queue_idx
  ON atlas.migration_divergences (state)
  WHERE state <> 'closed';

CREATE INDEX migration_divergences_session_idx
  ON atlas.migration_divergences (session_id);
