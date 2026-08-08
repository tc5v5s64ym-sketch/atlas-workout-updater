-- Atlas hot-path migration — S2, file 7 of 8: the export destination authority.
--
-- atlas.sheets_mirror_cursor and atlas.sheets_mirror_allocations (§3.9).
--
-- PERMANENT. This is the mirror's address book, not migration machinery, so S4
-- keeps it. Its consumer is the S4 export worker; nothing reads or writes it
-- before S4. It is created here because S2 owns the schema, and because the
-- constraint below is the thing that makes the defect it replaces
-- UNREPRESENTABLE rather than merely unlikely.
--
-- The defect: a per-session `sheets_row_start` column proved only that two workers
-- exporting the SAME session read the same value. It never defined how two
-- DIFFERENT sessions reserve non-overlapping blocks on the same tab — so two
-- sessions could inspect the same tail, allocate the same start row, and have one
-- values.update silently overwrite the other's workout.

-- ── The single point of serialisation ──────────────────────────────────────────
--
-- One row per mirrored tab. Allocation is an atomic fetch-and-add against this
-- row, so the row lock serialises EVERY session competing for that tab — which a
-- statement over two different workout_sessions rows cannot do, and which the
-- session-level advisory lock deliberately does not do.
CREATE TABLE atlas.sheets_mirror_cursor (
  tab                  text        PRIMARY KEY,
  -- The next unreserved row. Advances monotonically; never decreases.
  next_row             integer     NOT NULL,
  -- When the cutover recorded this tab's safe base (§5.4 step 4).
  base_established_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Row 1 is the header, on every mirrored tab.
  CONSTRAINT sheets_mirror_cursor_next_row_check CHECK (next_row >= 2),
  CONSTRAINT sheets_mirror_cursor_tab_check
    CHECK (tab IN ('Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets'))
);

-- ── The durable reservation ────────────────────────────────────────────────────
CREATE TABLE atlas.sheets_mirror_allocations (
  tab          text        NOT NULL REFERENCES atlas.sheets_mirror_cursor (tab),
  session_id   text        NOT NULL REFERENCES atlas.workout_sessions (session_id),
  start_row    integer     NOT NULL,
  row_count    integer     NOT NULL,
  end_row      integer     GENERATED ALWAYS AS (start_row + row_count - 1) STORED,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- This is what preserves the same allocation across retries: a re-export finds
  -- its existing reservation instead of taking a new one.
  CONSTRAINT sheets_mirror_allocations_pkey PRIMARY KEY (tab, session_id),
  CONSTRAINT sheets_mirror_allocations_row_count_check CHECK (row_count >= 1),
  CONSTRAINT sheets_mirror_allocations_start_row_check CHECK (start_row >= 2)
);

-- TWO ALLOCATIONS ON ONE TAB CANNOT OVERLAP, STRUCTURALLY. Needs btree_gist
-- (created in file 1) for the equality operator on `tab`. If anything ever
-- produced an overlap, the insert fails rather than corrupting the mirror.
ALTER TABLE atlas.sheets_mirror_allocations
  ADD CONSTRAINT sheets_mirror_allocations_no_overlap
  EXCLUDE USING gist (tab WITH =, int4range(start_row, end_row + 1) WITH &&);
