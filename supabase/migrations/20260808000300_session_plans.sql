-- Atlas hot-path migration — S2, file 3 of 8: the plan spine and the set ledger.
--
-- atlas.session_plan_events (§3.4), atlas.session_plan_set_recommendations (§3.5).

-- ── §3.4 atlas.session_plan_events ─────────────────────────────────────────────
--
-- Replaces Session_Plans. Append-only event log: concepts 4 (accepted plans),
-- 6 (item outcomes), and the session-level half of 7 (closeout).
--
-- The three vocabularies below are OWNER-FROZEN (Decision Desk #952). They are
-- validated only in JavaScript today; here they become CHECK constraints. The
-- empty string is a MEMBER of the outcome and closeout_status vocabularies and
-- means "not applicable to this event type" — it is never NULL (§4.7 rule 2).
CREATE TABLE atlas.session_plan_events (
  idempotency_key     text        PRIMARY KEY,
  session_id          text        NOT NULL REFERENCES atlas.workout_sessions (session_id),
  session_date        date,
  plan_version        integer     NOT NULL,
  event_type          text        NOT NULL,
  plan_item_id        text        NOT NULL,
  planned_order       integer,
  planned_lift_code   text,
  movement_pattern    text,
  outcome             text        NOT NULL,
  performed_lift_code text,
  closeout_status     text        NOT NULL,
  recorded_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT session_plan_events_version_check
    CHECK (plan_version >= 1),
  CONSTRAINT session_plan_events_event_type_check
    CHECK (event_type IN ('plan_accepted', 'item_outcome', 'session_closeout')),
  CONSTRAINT session_plan_events_outcome_check
    CHECK (outcome IN ('planned', 'completed', 'skipped', 'substituted', '')),
  CONSTRAINT session_plan_events_closeout_status_check
    CHECK (closeout_status IN ('finalized', 'abandoned', ''))
);

-- The fold key the reader uses (services/sessionPlanReader.js, last-wins).
CREATE INDEX session_plan_events_fold_idx
  ON atlas.session_plan_events (session_id, plan_version, plan_item_id);

-- The S4 export queue's join.
CREATE INDEX session_plan_events_closeout_idx
  ON atlas.session_plan_events (session_id)
  WHERE event_type = 'session_closeout';

-- ── §3.5 atlas.session_plan_set_recommendations ────────────────────────────────
--
-- Replaces Session_Plan_Sets. Concept 5 (plan sets and revisions) and the seal
-- half of concept 7. Append-only, with exactly ONE permitted update: the closeout
-- seal stamping closeout_write_id. Row content is never updated; a revision
-- appends a new row.
--
-- The four constraints below make five of validateChain's seven read-time chain
-- defects structurally impossible (§3.5). `cross_reference` and
-- `non_immediate_supersedes` stay in application code and are NOT moved to a
-- trigger, so validateChain is not deleted at S4 — only the five checks the
-- constraints now hold.
CREATE TABLE atlas.session_plan_set_recommendations (
  idempotency_key       text        PRIMARY KEY,
  session_id            text        NOT NULL REFERENCES atlas.workout_sessions (session_id),
  session_date          date,
  plan_version          integer     NOT NULL,
  plan_item_id          text        NOT NULL,
  planned_lift_code     text,
  set_index             integer     NOT NULL,
  target_set_count      integer,
  target_weight         numeric,
  target_reps           integer,
  target_rir            numeric,
  recommendation_source text        NOT NULL,
  supersedes_key        text        REFERENCES atlas.session_plan_set_recommendations (idempotency_key),
  confidence            text        NOT NULL,
  closeout_write_id     text,
  recorded_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT session_plan_sets_version_check
    CHECK (plan_version >= 1),
  CONSTRAINT session_plan_sets_set_index_check
    CHECK (set_index >= 1),
  CONSTRAINT session_plan_sets_source_check
    CHECK (recommendation_source IN
      ('accepted', 'engine', 'live_revision', 'user_endorsed', 'implicit_unplanned')),
  CONSTRAINT session_plan_sets_confidence_check
    CHECK (confidence IN ('reliable', 'no_reliable_target')),
  -- Prevents `duplicate_version`.
  CONSTRAINT session_plan_sets_chain_unique
    UNIQUE (session_id, plan_item_id, set_index, plan_version),
  -- Prevents `v1_has_supersedes` AND `missing_supersedes` in one predicate.
  CONSTRAINT session_plan_sets_v1_supersedes_check
    CHECK ((plan_version = 1) = (supersedes_key IS NULL))
);

-- Prevents `fork` — two revisions cannot both supersede the same row.
-- (`dangling_supersedes` is prevented by the self-referencing foreign key above.)
CREATE UNIQUE INDEX session_plan_sets_supersedes_unique
  ON atlas.session_plan_set_recommendations (supersedes_key)
  WHERE supersedes_key IS NOT NULL;

CREATE INDEX session_plan_sets_session_idx
  ON atlas.session_plan_set_recommendations (session_id);
