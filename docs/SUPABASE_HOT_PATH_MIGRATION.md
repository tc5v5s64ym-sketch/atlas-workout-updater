# Supabase Hot-Path Migration — Design

> **Status:** design specification. **Current as of:** 2026-08-07.
> **Authority:** the owner instruction of 2026-08-07 and the Atlas Contract / Systems Review
> of `b38de8b8e7da55f4e28b1c71ebe1bae97b5ca710`, both recorded in
> [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md).
> That plan block is the work-selection authority. This document selects no work.
> It defines the schema, the mapping, the closure chain, the proof, the rollback rules,
> the security posture, and the data-ownership record.

**Nothing in this document is applied.** No Supabase code, dependency, migration file, or
adapter exists in this repository. No schema is applied. No product behaviour changes.
`PR S1` is paper only.

**Revision, 2026-08-07.** The owner review of `b38de8b` returned **BLOCKING** with four P1
architecture defects and five rulings. All are incorporated here. The four defects are named
where they are fixed — §3.8 (no divergence authority existed), §5.2 (`S2` could lose the
shadow write and the evidence of it), §5.4 (the export was durable but not idempotent), and
§3.6 (two incompatible rulings on the file-backed store). Decisions D1 through D5 are now
**resolved by owner ruling** and are recorded in §9 as rulings, not as open questions.

**The Supabase project exists.** The owner created and selected the Free-tier project named
**Atlas Production**, independently verified healthy and empty, in `us-west-2`, with zero
public tables and zero migrations. The project reference and every credential stay out of
this repository (§8.4). Applying a schema to it remains a separate owner action.

---

## 1. Scope

### 1.1 What migrates

The owner instruction names seven concepts. They are the **workout hot path** — everything
an active workout must read, save, verify, or close out:

| # | Concept | Current durable home |
|---|---|---|
| 1 | workout sessions (the `session_id` identity and its allocation) | `Effort` ∪ `Log_Cleaned` ∪ `Session_Plans` occupancy |
| 2 | logged sets | `Log_Cleaned` |
| 3 | Effort | `Effort` |
| 4 | accepted session plans | `Session_Plans`, `event_type='plan_accepted'` |
| 5 | session plan sets and revisions | `Session_Plan_Sets` |
| 6 | item outcomes | `Session_Plans`, `event_type='item_outcome'` |
| 7 | closeout and write receipts | `Session_Plans` `event_type='session_closeout'`; `Session_Plan_Sets.closeout_write_id`; `services/idempotency.js` records in `/tmp/atlas-idempotency.json` |

Two additions come from the owner review, and neither widens the migrated **workout data**:

- **`Exercise_Catalog`, as a read-only mirror (ruling D1).** Sheets stays its editing
  authority. Supabase holds a synchronised read copy for the Save path. This is the last
  athlete-facing Sheets quota dependency, and removing it is what makes proof criterion P4
  a true statement rather than a qualified one.
- **All seven `beginWrite` callers, not three (ruling D4).** Receipt metadata is shared
  safety infrastructure, not workout data. One receipt authority replaces two.

### 1.2 What does not migrate

These stay in Google Sheets and are **out of scope**. They are named so the scope boundary
is explicit, not so a later PR builds them:

- `Constraints`, `Deload_State`, `Coaching_Notes` — read by the recommendation and coach
  lanes, never on the Save path.
- `Modality_Log`, `Bodyweight`, `Bug_Reports` — their **rows** stay in Sheets. Only their
  duplicate-write receipts move, under ruling D4.
- Telemetry tabs: `Flight_Recorder`, `Brain_Shadow`, `Intent_Shadow`, `Coach_Shadow`,
  `Coach_Response`.
- Derived read surfaces: `Metadata`, `Logic`, `Session_Summary`, `Dashboard`.

No table is proposed for any of them.

### 1.3 What Google Sheets becomes

For the migrated concepts, and for those only:

- a human-readable export and mirror;
- never required for an active workout to read, save, verify, or close out.

For `Exercise_Catalog`, Sheets stays the **editing** authority and Supabase becomes the
Save-path **read** mirror. For every other tab, Sheets remains exactly what it is today.

---

## 2. Architecture ruling

**Classification: authority defect.** Two stores would decide where a logged set lives.
The standing rule in `CLAUDE.md` applies — select one winner, remove the loser, and add
no permanent reconciliation logic between them.

- **Current live authority.** Google Sheets, through `sheets.js`, for all seven concepts,
  plus the file-backed store in `services/idempotency.js` for write receipts.
- **Intended sole authority.** Supabase.
- **Competing authority to remove.** The direct Google Sheets runtime reads and writes for
  the migrated concepts, the machinery built to keep them inside the read quota, and the
  file-backed receipt store.
- **Temporary bridge.** A bounded shadow write, a durable divergence record, a
  reconciliation sweep, and a repair path. All four are live in `PR S2` and `PR S3` only.
  The athlete-facing write succeeds or fails from the **current authority alone**. The
  shadow write never changes a response, a status code, or a visible claim. Atlas never
  reconciles two authorities silently.
- **Exact sunset.** `PR S4` deletes the entire bridge, including the divergence table, and
  verifies its absence. §5.4 lists every artifact.

**Reads and writes cut over together (ruling D5).** An earlier version of this design moved
reads at `S3` while writes stayed on Sheets until `S4`. That window let reads lead writes,
so a failed shadow write could serve a silently incomplete workout. The window is removed:
`S3` proves readiness and `S4` performs the whole cutover.

**The engine/LLM boundary is unchanged.** The store changes; nothing about who decides a
number changes. `preview → approve → write` is unchanged, `test_mode` absent still means a
live write, and the W1–W3 proof fields are unchanged.

---

## 3. Minimum Supabase schema

**Eight tables: seven permanent, one temporary.** Each names its immediate production
consumer. There is no generic persistence framework, no repository abstraction, and no table
without a consumer in this chain.

| # | Table | Lifetime |
|---|---|---|
| 3.1 | `atlas.workout_sessions` | permanent |
| 3.2 | `atlas.logged_sets` | permanent |
| 3.3 | `atlas.session_effort` | permanent |
| 3.4 | `atlas.session_plan_events` | permanent |
| 3.5 | `atlas.session_plan_set_recommendations` | permanent |
| 3.6 | `atlas.write_receipts` | permanent |
| 3.7 | `atlas.exercise_catalog_mirror` | permanent (ruling D1) |
| 3.8 | `atlas.migration_divergences` | **TEMPORARY — dropped by `S4`** |

Conventions used by every table:

- Postgres schema `atlas`, not `public`.
- `created_at timestamptz NOT NULL DEFAULT now()` on every table.
- `session_id text` keeps the existing `YYYYMMDD-{AM|PM}-NN` contract verbatim
  (`services/sessionId.js`). It is not re-minted, re-formatted, or replaced by a UUID:
  it is the join key that `Log_Cleaned`, `Effort`, `Session_Plans`, `Session_Plan_Sets`,
  history, undo, the weekly summary, and `npm run atlas:review-live` all already use.
- Text comparison for `session_id` and `exercise` is case-insensitive, matching the
  existing dedupe and ownership checks, which trim and lower-case.

### 3.1 `atlas.workout_sessions`

Holds session identity, its allocation, and the Sheets-export state of that session.

| Column | Type | Notes |
|---|---|---|
| `session_id` | `text` | **PK**. The existing id contract. |
| `session_date` | `date` | The athlete's local date. |
| `period` | `text` | `AM` or `PM`. `CHECK (period IN ('AM','PM'))`. |
| `slot` | `smallint` | `CHECK (slot BETWEEN 1 AND 99)`. |
| `created_at` | `timestamptz` | |
| `sheets_exported_at` | `timestamptz` | Nullable. Set only after the export is **verified**. Mirror state, not closeout state. |
| `sheets_export_attempts` | `integer` | `NOT NULL DEFAULT 0`. |
| `sheets_export_error` | `text` | Nullable. The last export failure reason. |
| `export_claim_token` | `uuid` | Nullable. The lease held by the worker currently exporting. |
| `export_claim_expires_at` | `timestamptz` | Nullable. Lease expiry. A crashed worker's lease lapses. |

- **Unique:** `(session_date, period, slot)`.
- **Index:** the PK, plus `(session_date DESC)`, plus a partial index on
  `(session_id) WHERE sheets_exported_at IS NULL` — the export worker's queue scan.
- **Mutability:** insert-only for identity. The five `sheets_export_*` / `export_claim_*`
  columns are the only updatable ones, and only the `S4` export worker updates them. They
  are unused before `S4`.
- **Transaction boundary for allocation:** one statement.
  `INSERT … ON CONFLICT DO NOTHING RETURNING session_id`, retried on the next free slot.
  Slot exhaustion at 99 still fails closed with `SESSION_SLOTS_EXHAUSTED`.
- **Immediate production consumer:** `nextAvailableSessionId` (`services/sessionId.js`) as
  called by `POST /api/session-plans/accept`, `POST /api/log-workout`, and
  `POST /api/complete-workout`; and, from `S4`, the export worker.
- **Why it exists:** allocation is today a read of the durable union of three tabs, followed
  by an in-process scan for a free slot. Two concurrent allocations can therefore pick the
  same id. The unique constraint makes the same allocation one atomic insert.

**Ruling — this table does NOT hold closeout.** The session-level closeout authority is the
`session_closeout` row in `atlas.session_plan_events` (§3.4). Its `event_type`, `outcome`,
and `closeout_status` vocabularies are owner-frozen (Decision Desk #952). Adding a closeout
column here would create a second closeout authority, which is the defect this migration
exists to remove. Export state is **not** closeout state: it records whether the mirror has
caught up, and nothing reads it to decide whether a workout finished.

### 3.2 `atlas.logged_sets`

Replaces `Log_Cleaned`.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` | **PK**, `GENERATED ALWAYS AS IDENTITY`. Surrogate; never athlete-visible. |
| `session_id` | `text` | `REFERENCES atlas.workout_sessions(session_id)`. |
| `date_clean` | `date` | |
| `exercise` | `text` | As the athlete named it. |
| `canonical_exercise` | `text` | |
| `muscle_group` | `text` | |
| `lift_code` | `text` | |
| `set_number` | `integer` | |
| `weight` | `numeric` | |
| `reps` | `integer` | |
| `rir` | `numeric` | |
| `notes` | `text` | |
| `volume_calc` | `numeric` | |
| `write_id` | `text` | The `write_id` of the append that created the row. `REFERENCES atlas.write_receipts(write_id)`. |
| `created_at` | `timestamptz` | |

- **Unique (idempotency):** `(lower(session_id), lower(exercise), set_number)`.
  This is the exact composite key `getLogCompositeKeys()` builds today
  (`session_id‖exercise‖set_number`, lower-cased whole). It moves from a read-and-compare in
  application code to a database constraint. Invariants W1–W3's second line of defence
  becomes structural. **It is also the export identity key** (§5.4).
- **Indexes:** the unique key; `(session_id)`; `(lift_code, date_clean DESC)` for the
  recommendation history read; `(date_clean DESC)` for the history and weekly reads.
- **Mutability:** append-only, plus delete-by-`write_id` for undo. No row is ever updated.
- **Transaction boundary:** one transaction per Save. All rows of one Save insert together.
  A partial Save is impossible, which the two split `appendRows` calls in `index.js` cannot
  guarantee today.
- **Undo:** `DELETE FROM atlas.logged_sets WHERE session_id = $1 AND write_id = $2`.
  This replaces the A1-range delete at `index.js:3875` and the read-back ownership check
  above it. A row of another session cannot be deleted, because `session_id` is a predicate
  rather than a verified guess about a row range.
- **Immediate production consumer:** `POST /api/log-workout`, `POST /api/complete-workout`,
  `POST /api/log-workout/undo-last`, and every read of `Log_Cleaned` in
  `routes/reads.js` / `routes/coachOps.js`.

### 3.3 `atlas.session_effort`

Replaces `Effort`.

| Column | Type | Notes |
|---|---|---|
| `session_id` | `text` | **PK**, `REFERENCES atlas.workout_sessions(session_id)`. |
| `effort_date` | `date` | `Effort.date`. Renamed only because `date` is a reserved word. |
| `duration` | `text` | Stored exactly as supplied. `parseDurationMinutes` (`services/validation.js`) stays the sole interpreter. |
| `active_calories` | `numeric` | |
| `total_calories` | `numeric` | |
| `average_hr` | `numeric` | |
| `peak_hr` | `numeric` | |
| `location` | `text` | |
| `notes` | `text` | |
| `write_id` | `text` | `REFERENCES atlas.write_receipts(write_id)`. |
| `created_at` | `timestamptz` | |

- **Unique (idempotency), and the export identity key:** the primary key. One Effort row per
  session is the existing duplicate-session guard, which today costs a read of `Effort!B:B`
  on every Save.
- **Mutability:** insert-only.
- **Transaction boundary:** the same transaction as its Save's `logged_sets` rows.
- **Immediate production consumer:** `POST /api/complete-workout`, `POST /api/log-workout`
  when an effort row is supplied, `GET /api/summary/weekly`, `GET /api/history/recent`.

### 3.4 `atlas.session_plan_events`

Replaces `Session_Plans`. Append-only event log. Concepts 4, 6, and the session-level half
of 7.

| Column | Type | Notes |
|---|---|---|
| `idempotency_key` | `text` | **PK**. The existing 16-hex sha256 prefix from `services/sessionPlanEvents.js`. Unchanged. Also the export identity key. |
| `session_id` | `text` | `REFERENCES atlas.workout_sessions(session_id)`. |
| `session_date` | `date` | |
| `plan_version` | `integer` | `CHECK (plan_version >= 1)`. |
| `event_type` | `text` | `CHECK (event_type IN ('plan_accepted','item_outcome','session_closeout'))`. |
| `plan_item_id` | `text` | Empty string on a `session_closeout` row, as today. |
| `planned_order` | `integer` | |
| `planned_lift_code` | `text` | |
| `movement_pattern` | `text` | |
| `outcome` | `text` | `CHECK (outcome IN ('planned','completed','skipped','substituted',''))`. |
| `performed_lift_code` | `text` | |
| `closeout_status` | `text` | `CHECK (closeout_status IN ('finalized','abandoned',''))`. |
| `recorded_at` | `timestamptz` | |

- **Unique (idempotency):** the primary key. The key is derived from
  `(event_type, session_id, plan_version, plan_item_id, outcome, performed_lift_code,
  closeout_status)` and never from the timestamp. The derivation does not change.
- **Index:** `(session_id, plan_version, plan_item_id)` — the fold key the reader uses
  (`services/sessionPlanReader.js`, last-wins). Plus a partial index on
  `(session_id) WHERE event_type = 'session_closeout'` — the export queue's join.
- **Mutability:** append-only. No row is ever updated or deleted.
- **Revision collision, preserved exactly:** insert with
  `ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`. Zero rows returned
  means a row with that key exists. Read that one row and compare content, ignoring
  `recorded_at`. Equal content is a skipped retry. Different content raises the same
  revision-collision error `services/sessionPlanStore.js` raises today. The behaviour is
  identical; the read is one indexed row instead of the whole tab.
- **Transaction boundary:** one transaction per event batch.
- **Gain, stated plainly:** the three owner-frozen vocabularies become `CHECK` constraints.
  They are validated only in JavaScript today.
- **Immediate production consumer:** `services/sessionPlanStore.js` and
  `services/sessionPlanReader.js`, called from `routes/sessionPlans.js`,
  `services/sessionCloseout.js`, and `services/closeoutFinality.js`.

### 3.5 `atlas.session_plan_set_recommendations`

Replaces `Session_Plan_Sets`. Concept 5, and the seal half of concept 7.

| Column | Type | Notes |
|---|---|---|
| `idempotency_key` | `text` | **PK**. The existing 16-hex sha256 prefix from `services/sessionPlanLedger.js`. Unchanged. Also the export identity key. |
| `session_id` | `text` | `REFERENCES atlas.workout_sessions(session_id)`. |
| `session_date` | `date` | |
| `plan_version` | `integer` | `CHECK (plan_version >= 1)`. |
| `plan_item_id` | `text` | |
| `planned_lift_code` | `text` | |
| `set_index` | `integer` | `CHECK (set_index >= 1)`. |
| `target_set_count` | `integer` | |
| `target_weight` | `numeric` | Null when blank. |
| `target_reps` | `integer` | Null when blank. |
| `target_rir` | `numeric` | Null when blank. |
| `recommendation_source` | `text` | `CHECK (… IN ('accepted','engine','live_revision','user_endorsed','implicit_unplanned'))`. |
| `supersedes_key` | `text` | `REFERENCES atlas.session_plan_set_recommendations(idempotency_key)`. Null on version 1. |
| `confidence` | `text` | `CHECK (confidence IN ('reliable','no_reliable_target'))`. |
| `closeout_write_id` | `text` | Nullable. **The only mutable column in the migrated workout schema.** |
| `recorded_at` | `timestamptz` | |

- **Unique:** `(session_id, plan_item_id, set_index, plan_version)`.
- **Unique, partial:** `(supersedes_key) WHERE supersedes_key IS NOT NULL`.
- **Check:** `(plan_version = 1) = (supersedes_key IS NULL)`.
- **Mutability:** append-only, with exactly one permitted update — the closeout seal
  stamping `closeout_write_id`. Row content is never updated. A revision appends a new row.

**What the constraints move out of `validateChain`.** `validateChain`
(`services/sessionPlanLedger.js`) detects seven chain defects at read time. Four
constraints make five of them structurally impossible:

| Defect | Now prevented by |
|---|---|
| `duplicate_version` | `UNIQUE (session_id, plan_item_id, set_index, plan_version)` |
| `fork` | partial `UNIQUE (supersedes_key)` |
| `dangling_supersedes` | the self-referencing foreign key |
| `v1_has_supersedes` **and** `missing_supersedes` | the `CHECK` above |

Two defects remain in application code and are **not** moved to a trigger:
`cross_reference` (a `supersedes_key` naming a row of a different item or set index) and
`non_immediate_supersedes`. The separate `malformed` check in `_parseAll` also stays. Do
not delete `validateChain` at `PR S4`; delete only the five checks the constraints now hold.

- **The seal, as one transaction:**
  ```sql
  UPDATE atlas.session_plan_set_recommendations
     SET closeout_write_id = $2
   WHERE session_id = $1 AND closeout_write_id IS NULL;
  ```
  The `IS NULL` predicate makes "never re-seal" atomic. A row already sealed by a different
  `closeout_write_id` is not matched, so `conflicting_seal` is detected by comparing the
  matched-row count against the session's row count — inside the same transaction. The
  existing outcome vocabulary is preserved exactly: `sealed_ok`, `already_sealed`,
  `no_ledger`, `conflicting_seal`, `malformed_chain`, `seal_proof_mismatch`,
  `ledger_read_failed`. An unreadable ledger stays `sealed_ok:false`; it never becomes a
  verified empty seal.
- **Immediate production consumer:** `services/sessionPlanSetsStore.js`, called from
  `routes/sessionPlans.js` and the closeout lane in `index.js`.

### 3.6 `atlas.write_receipts`

Replaces the idempotency store in `services/idempotency.js` — **for all seven callers**.

| Column | Type | Notes |
|---|---|---|
| `write_id` | `text` | **PK**. Supplied by the client, as today. |
| `route` | `text` | One of the seven routes below. |
| `session_id` | `text` | Nullable — a claim is made before the id is known on some paths, and three routes have no session at all. |
| `status` | `text` | `CHECK (status IN ('in_progress','completed','failed'))`. |
| `attempt_token` | `uuid` | The current attempt's token. Regenerated on every new attempt. |
| `attempt` | `integer` | `NOT NULL DEFAULT 1`. Increments on each retry of the same `write_id`. |
| `response_body` | `jsonb` | The exact body replayed to a duplicate retry. |
| `rows_written` | `integer` | |
| `appended_range` | `text` | Kept while the Sheets mirror exists; null afterwards. |
| `created_at` | `timestamptz` | |
| `attempt_started_at` | `timestamptz` | Start of the **current** attempt. The staleness clock reads this, not `created_at`. |
| `completed_at` | `timestamptz` | Nullable. |

- **Mutability:** mutable, and deliberately so. The row is a **state machine**, not a
  single insert plus a single terminal update. A `write_id` is **not** consumed by a failed
  attempt.

**The state machine, stated exactly, because getting it wrong loses a retry.**
`beginWrite` (`services/idempotency.js:147-192`) permits three transitions that a naive
`ON CONFLICT DO NOTHING` claim would destroy:

1. **No row** → insert `in_progress`, `attempt = 1`, a fresh `attempt_token`.
2. **Row is `failed`** → **retryable.** The code says so: *"A 'failed' record is retryable: a
   prior attempt released without committing, so fall through and start a clean attempt."*
   The row moves back to `in_progress` with `attempt + 1` and a **new** `attempt_token`.
3. **Row is `in_progress` and stale** — older than `STALE_IN_PROGRESS_MS` (5 minutes) and
   rehydrated from a crashed process — → treated as abandoned and retryable, exactly as (2).
4. **Row is `in_progress` and fresh**, or **`completed`** → genuine duplicate. Refuse, or
   replay `response_body`.

- **Transaction boundary — a compare-and-set, never `DO NOTHING`.** The claim is one
  statement:
  ```sql
  INSERT INTO atlas.write_receipts (write_id, route, status, attempt, attempt_token,
                                    attempt_started_at)
  VALUES ($1, $2, 'in_progress', 1, gen_random_uuid(), now())
  ON CONFLICT (write_id) DO UPDATE
     SET status = 'in_progress',
         attempt = atlas.write_receipts.attempt + 1,
         attempt_token = gen_random_uuid(),
         attempt_started_at = now(),
         completed_at = NULL
   WHERE atlas.write_receipts.status = 'failed'
      OR (atlas.write_receipts.status = 'in_progress'
          AND atlas.write_receipts.attempt_started_at < now() - interval '5 minutes')
  RETURNING attempt_token, attempt;
  ```
  Returning a row means this caller holds the attempt. Returning **no** row means the
  `WHERE` refused the update, which is exactly case (4) — a genuine duplicate. The caller
  then reads the row and refuses or replays.
- **`completeWrite` and `failWrite` are token-guarded**, for the same reason the in-process
  store passes a token: a **stale attempt must not overwrite a newer one**. Both are
  `UPDATE … WHERE write_id = $1 AND attempt_token = $2`. A superseded attempt matches zero
  rows and its late completion is discarded rather than applied.
- **Why `ON CONFLICT DO NOTHING` is wrong here, stated so it is not reintroduced.** It would
  read a `failed` row as a duplicate. One transient failure would then consume the
  `write_id` permanently, and the athlete's retry of a Save that never committed would be
  refused as a duplicate. That is a lost workout, not a protected one.
- **What this does not change.** The 24-hour TTL prune and the 5-minute staleness window
  keep their current meanings. `write_id` remains client-supplied. The duplicate-write
  shield's *decisions* are unchanged; only its storage and its atomicity change.

**All seven `beginWrite` callers move here (ruling D4).** The owner ruled that receipt
metadata is shared safety infrastructure, not a second workout-data migration:

| Route | Call site |
|---|---|
| `POST /api/log-workout` | `index.js:3401` |
| `POST /api/complete-workout` | `index.js:2683` |
| `POST /api/log-workout/undo-last` | `index.js:3810` |
| `POST /api/coaching-notes` | `index.js:1296` |
| `POST /api/constraints` | `index.js:1382` |
| `POST /api/log-modality` | `index.js:1501` |
| the bodyweight write | `index.js:2107` |

Only the **receipt** moves for the last four. Their rows keep going to their Sheets tabs.
`S4` deletes the file-backed store, `ATLAS_IDEMPOTENCY_FILE`, and
`/tmp/atlas-idempotency.json`, and **proves no caller of the file store remains**.

**This resolves a contradiction the owner review found.** An earlier version of this design
said the file store deliberately survives `S4` for four routes, while
`docs/ATLAS_SYSTEM_AUTHORITY.md` concept 18 said `S4` deletes it and verifies its absence,
and the §9 ownership table said both. Two incompatible rulings on one artifact could either
strip four routes of duplicate-write protection or falsely close `S4` while a competing
authority remained. There is now one ruling, and every authority surface states it.

### 3.7 `atlas.exercise_catalog_mirror`

A read-only mirror of `Exercise_Catalog` (ruling D1). Reference data, not workout data.

| Column | Type | Notes |
|---|---|---|
| `exercise` | `text` | **PK** — `lower(exercise)`, the lookup key the resolver uses. |
| `display_exercise` | `text` | The catalog's `Exercise` cell, verbatim. |
| `muscle_group` | `text` | |
| `lift_code` | `text` | |
| `canonical_exercise` | `text` | |
| `synced_at` | `timestamptz` | When this row was last confirmed against Sheets. |

- **Authority.** Google Sheets remains the **editing** authority. This table is a
  projection, never edited by Atlas, and never the place a new exercise is defined.
- **Sync.** A server-owned refresh replaces the mirror transactionally: load the catalog from
  Sheets, and swap it in one transaction so a reader never sees a half-written catalog. A
  failed sync leaves the previous mirror in place and records the failure; it never empties
  the mirror and never synthesises an empty catalog from an error.
- **Mutability:** wholly replaced by the sync. Never updated per row by the request path.
- **Index:** the PK, plus `(lift_code)`.
- **Immediate production consumer:** `getExerciseCatalog()`'s callers — the Save-path
  enrichment in `POST /api/log-workout` and `POST /api/complete-workout`, and the catalog
  reads in `routes/reads.js`.
- **Why it exists, precisely.** `getExerciseCatalog()` enriches every logged row to
  `canonical_exercise`, `muscle_group`, and `lift_code`. It is cached for 60 seconds with
  **no stale-after-expiry fallback**, so a failed refresh throws and the Save fails. While
  the catalog is read from Sheets, a Sheets quota error can still fail a Save. This mirror
  is what makes proof criterion P4 — no athlete-facing dependency on the Sheets quota — a
  true statement rather than a qualified one.
- **Staleness posture, stated rather than assumed.** A catalog edit reaches the Save path
  only after the next sync. That is the same delay the existing 60-second cache already
  imposes, so it is not a new behaviour. The sync interval and its failure reporting are
  `S3` work, and `npm run atlas:status` reports the mirror's age.

### 3.8 `atlas.migration_divergences` — TEMPORARY

**This table exists because the owner review found that the divergence authority the design
depended on was never declared.** `S2` requires a durable divergence record, `S3` requires
its count to reach zero, and `S4` will not merge while any row is open. A required gate
cannot depend on an unnamed record, and `write_receipts` cannot carry it — it has no
divergence reason, no repair state, no comparison result, and no closure proof.

It is **migration-control machinery, not product data**. It is dropped by `S4`.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` | **PK**, `GENERATED ALWAYS AS IDENTITY`. |
| `concept` | `text` | `CHECK (concept IN ('logged_sets','session_effort','session_plan_events','session_plan_set_recommendations'))`. |
| `identity_key` | `text` | The diverged row's export identity key, as defined per table in §3.2–§3.5. |
| `session_id` | `text` | Nullable — an orphan row may not resolve to a session. |
| `write_id` | `text` | Nullable. Present when an inline shadow write caused the divergence. |
| `route` | `text` | Nullable. The route whose shadow write diverged. |
| `reason` | `text` | `CHECK (reason IN ('shadow_write_failed','missing_in_supabase','missing_in_sheets','content_mismatch'))`. |
| `detected_by` | `text` | `CHECK (detected_by IN ('inline_shadow','sweep'))`. |
| `detected_at` | `timestamptz` | |
| `state` | `text` | `CHECK (state IN ('open','repairing','closed'))`. |
| `repair_attempts` | `integer` | `NOT NULL DEFAULT 0`. |
| `repair_claim_token` | `uuid` | Nullable. Lease held by the repairing worker. |
| `repair_claim_expires_at` | `timestamptz` | Nullable. A crashed repairer's lease lapses. |
| `comparison_result` | `jsonb` | The field-level difference, with workout values redacted to shapes. |
| `closed_at` | `timestamptz` | Nullable. |
| `closure_proof` | `text` | The re-comparison that closed it. Never a timestamp alone. |

- **Unique, partial:** `(concept, identity_key) WHERE state <> 'closed'` — at most one open
  divergence per row identity, so a repeated sweep does not multiply rows.
- **Index:** partial on `(state) WHERE state <> 'closed'` — the repair queue; plus
  `(session_id)`.
- **State transitions.** `open` → `repairing` is a conditional claim
  (`WHERE state = 'open' OR repair_claim_expires_at < now()`), setting a fresh
  `repair_claim_token`. `repairing` → `closed` requires a **passing re-comparison** and a
  matching claim token. `repairing` → `open` on a lapsed lease. **A divergence is never
  closed by a timer, never aged out, and never closed without `closure_proof`.**
- **Immediate production consumer:** the `S2` shadow lane (writes `inline_shadow` rows), the
  reconciliation sweep (writes `sweep` rows), the repair worker (claims and closes), and
  `npm run atlas:status` (reports the open count and the oldest open row).
- **Exact deletion.** `S4` drops this table in its migration, deletes the shadow lane, the
  sweep, and the repair worker, and verifies all four are absent. `S4` does not merge while
  any row is not `closed` (§6.3 P15).

---

## 4. Field-by-field mapping

Every existing column maps to exactly one destination column. No column is dropped.
Column order in Sheets is owner-approved and is preserved by the export in §5.4.

### 4.1 `Log_Cleaned` (12 columns) → `atlas.logged_sets`

| # | Sheet column | Supabase column | Type change | Note |
|---|---|---|---|---|
| 1 | `date_clean` | `date_clean` | text → `date` | The athlete's local date. Not derived from `created_at`. |
| 2 | `session_id` | `session_id` | text → `text` FK | |
| 3 | `exercise` | `exercise` | none | Dedup compares `lower(exercise)`. |
| 4 | `canonical_exercise` | `canonical_exercise` | none | |
| 5 | `muscle_group` | `muscle_group` | none | |
| 6 | `lift_code` | `lift_code` | none | |
| 7 | `set_number` | `set_number` | text → `integer` | |
| 8 | `weight` | `weight` | text → `numeric` | |
| 9 | `reps` | `reps` | text → `integer` | |
| 10 | `rir` | `rir` | text → `numeric` | Nullable. Blank in Sheets becomes `NULL`. |
| 11 | `notes` | `notes` | none | |
| 12 | `volume_calc` | `volume_calc` | text → `numeric` | Stored, not recomputed. The engine keeps ownership of the number. |
| — | *(none)* | `id` | new | Surrogate PK. Never athlete-visible, never exported. |
| — | *(none)* | `write_id` | new | Already known at write time; not recorded in `Log_Cleaned` today. Backfill sets it `NULL`. |

`logRowFieldAliases` (`config/columns.js`) covers hand-edited header variants. It applies to
the Sheets reader only and is not needed against Supabase. Keep it while the reader exists.

### 4.2 `Effort` (9 columns) → `atlas.session_effort`

| # | Sheet column | Supabase column | Type change | Note |
|---|---|---|---|---|
| 1 | `date` | `effort_date` | text → `date` | Renamed only to avoid the reserved word. |
| 2 | `session_id` | `session_id` | text → `text` PK/FK | |
| 3 | `duration` | `duration` | none | Free text preserved verbatim. |
| 4 | `active_calories` | `active_calories` | text → `numeric` | |
| 5 | `total_calories` | `total_calories` | text → `numeric` | |
| 6 | `average_hr` | `average_hr` | text → `numeric` | Distinct from `peak_hr`. |
| 7 | `peak_hr` | `peak_hr` | text → `numeric` | |
| 8 | `location` | `location` | none | |
| 9 | `notes` | `notes` | none | |
| — | *(none)* | `write_id` | new | Backfill sets it `NULL`. |

### 4.3 `Session_Plans` (13 columns) → `atlas.session_plan_events`

| # | Sheet column | Supabase column | Type change | Note |
|---|---|---|---|---|
| 1 | `idempotency_key` | `idempotency_key` | none | Becomes the PK. Derivation unchanged. |
| 2 | `session_id` | `session_id` | text → `text` FK | |
| 3 | `session_date` | `session_date` | text → `date` | |
| 4 | `plan_version` | `plan_version` | text → `integer` | |
| 5 | `event_type` | `event_type` | none, plus `CHECK` | Owner-frozen vocabulary. |
| 6 | `plan_item_id` | `plan_item_id` | none | `''` on a closeout row. |
| 7 | `planned_order` | `planned_order` | text → `integer` | Nullable. |
| 8 | `planned_lift_code` | `planned_lift_code` | none | Canonical codes only. |
| 9 | `movement_pattern` | `movement_pattern` | none | |
| 10 | `outcome` | `outcome` | none, plus `CHECK` | Owner-frozen vocabulary; `''` permitted. |
| 11 | `performed_lift_code` | `performed_lift_code` | none | |
| 12 | `closeout_status` | `closeout_status` | none, plus `CHECK` | Owner-frozen vocabulary; `''` permitted. |
| 13 | `recorded_at` | `recorded_at` | text → `timestamptz` | Provenance. Excluded from the content comparison, as today. |

### 4.4 `Session_Plan_Sets` (16 columns) → `atlas.session_plan_set_recommendations`

| # | Sheet column | Supabase column | Type change | Note |
|---|---|---|---|---|
| 1 | `idempotency_key` | `idempotency_key` | none | Becomes the PK. Derivation unchanged. |
| 2 | `session_id` | `session_id` | text → `text` FK | |
| 3 | `session_date` | `session_date` | text → `date` | |
| 4 | `plan_version` | `plan_version` | text → `integer` | |
| 5 | `plan_item_id` | `plan_item_id` | none | |
| 6 | `planned_lift_code` | `planned_lift_code` | none | |
| 7 | `set_index` | `set_index` | text → `integer` | |
| 8 | `target_set_count` | `target_set_count` | text → `integer` | |
| 9 | `target_weight` | `target_weight` | text → `numeric` | Blank becomes `NULL`, never `0`. |
| 10 | `target_reps` | `target_reps` | text → `integer` | Blank becomes `NULL`. |
| 11 | `target_rir` | `target_rir` | text → `numeric` | Blank becomes `NULL`. |
| 12 | `recommendation_source` | `recommendation_source` | none, plus `CHECK` | Owner-frozen vocabulary. |
| 13 | `supersedes_key` | `supersedes_key` | none, plus self FK | Blank becomes `NULL`. |
| 14 | `confidence` | `confidence` | none, plus `CHECK` | Owner-frozen vocabulary. |
| 15 | `closeout_write_id` | `closeout_write_id` | none | Blank becomes `NULL`. The one mutable column. |
| 16 | `recorded_at` | `recorded_at` | text → `timestamptz` | Excluded from the content comparison. |

### 4.5 `Exercise_Catalog` (4 columns) → `atlas.exercise_catalog_mirror`

| # | Sheet column | Supabase column | Type change | Note |
|---|---|---|---|---|
| 1 | `Exercise` | `display_exercise` | none | Verbatim. `exercise` (the PK) is `lower()` of it. |
| 2 | `Muscle_Group` | `muscle_group` | none | |
| 3 | `Lift Code` | `lift_code` | none | The space in the header is preserved by the reader, not by the column name. |
| 4 | `Canonical_Exercise` | `canonical_exercise` | none | |
| — | *(none)* | `synced_at` | new | Mirror provenance. |

### 4.6 Idempotency store → `atlas.write_receipts`

The current store is a JSON map, not a Sheet tab, so this is a record-by-record mapping.

| Current field (`services/idempotency.js`) | Supabase column |
|---|---|
| map key | `write_id` |
| `status` | `status` |
| `response`/replayed body | `response_body` |
| `created_at_ms` | `created_at` |
| `completed_at` | `completed_at` |
| the in-process attempt token | `attempt_token` |
| *(not stored today)* | `route`, `session_id`, `rows_written`, `appended_range`, `attempt`, `attempt_started_at` |

### 4.7 The blank-versus-null rule

Google Sheets has one empty value: the empty string. Postgres has two: `''` and `NULL`.
The rule is fixed, so a round trip cannot change meaning:

1. A numeric or date column reads a blank cell as `NULL`.
2. A text column inside an owner-frozen vocabulary (`outcome`, `closeout_status`) keeps
   `''`, because `''` is a **member** of that vocabulary and means "not applicable to this
   event type". It does not become `NULL`.
3. Every other text column reads a blank cell as `NULL`.
4. The export in §5.4 writes `NULL` back as an empty cell.

Rule 2 is the one that a naive `NULL`-everything migration would break. `plan_item_id` is
also `''` rather than `NULL` on a `session_closeout` row, because the idempotency key is
derived from it and the key must not change.

---

## 5. The four-PR closure chain

One concern per PR. Each PR names what it closes and what it must not do.

### 5.1 PR S1 — governance, authority and schema design *(this PR)*

- Record the owner instruction and the owner review in `docs/ATLAS_V1_EXECUTION_PLAN.md`.
- Correct every document that states Sheets is permanently the only V1 store.
- Record the authority move in `docs/ATLAS_SYSTEM_AUTHORITY.md`.
- Publish this design document.
- **Must not:** apply a schema, add a dependency, add a migration file, add an adapter,
  change product behaviour, or deploy.
- **Closes:** the paper conflict between the owner instruction and the governing documents.
- **Opens:** the three implementation loops below, each with a named consumer and a sunset
  condition.

### 5.2 PR S2 — migrations, adapter, shadow write, divergence lane

- Add the repository migration files for the eight tables of §3, as plain SQL under
  `supabase/migrations/`. The files are checked in and applied to a **disposable**
  database in CI. Applying them to `Atlas Production` is a separate owner action.
- Add one Supabase adapter module. It is the only module that holds a Supabase client, in
  the same way `sheets.js` is the only module that holds a read-write Sheets client. It
  exposes the operations §3 names and nothing else. **No generic repository layer, no ORM,
  no query builder abstraction.**
- Wire the shadow write, the divergence lane, the reconciliation sweep, and the repair
  worker.
- **Sheets remains the live authority for every read and every write.** The shadow write
  runs after the response has been decided. It never changes a response, a status code, a
  proof field, or a visible claim. A shadow failure is never surfaced to the athlete.
- **Must not:** move any read, move any write, change any response, or deploy a cutover.
- **Immediate consumer of the adapter:** the shadow-write call sites in `index.js` and
  `routes/sessionPlans.js`. The adapter has a consumer in the PR that adds it.
- **Bridge introduced:** the shadow write, `atlas.migration_divergences`, the sweep, and the
  repair worker. **Sunset:** all four deleted in `S4`.

#### The sweep is the completeness authority, not the inline record

**The owner review found a real gap here, and closing it changed which mechanism is
authoritative.** The shadow write runs after the athlete-facing response is decided. If the
process dies after the Sheets write succeeds but before either the shadow write or its
divergence row lands, Supabase lacks the rows **and** the open-divergence count still reads
zero. That is the same process-death gap this design closes for the `S4` export, and an
earlier version left it open in `S2`. An earlier version also said the lane would mark the
session diverged "by the safest available means" — that is not an authority and not a proof,
and it is withdrawn.

The fix is to stop depending on anything the dying process was supposed to write:

1. **The reconciliation sweep is the authority for completeness.** Google Sheets is the
   write authority throughout `S2` and `S3`, so it holds every committed row. The sweep
   enumerates every Sheets row of the four migrated tabs by its **export identity key**
   (§3.2–§3.5), enumerates every Supabase counterpart, and opens a divergence for every
   element of the symmetric difference — `missing_in_supabase`, `missing_in_sheets`, or
   `content_mismatch`. It depends on no in-flight state, no queue, and no record the crashed
   process was meant to write. A process death anywhere in the window is therefore
   **detectable by construction**.
2. **The inline divergence row is an optimisation, not the authority.** It reports a known
   failure sooner. It is never relied on for completeness, and the sweep's result is what
   any gate reads.
3. **The sweep runs to completion before any cutover**, and its zero result is an `S4`
   precondition (§6.3 P15). A sweep that has not completed is not a zero.

**Proof obligation, exactly as the review requires.** A test kills the process in the exact
window — after the Sheets append returns success, before the shadow write — restarts, runs
the sweep, and asserts the omission is found, repaired, and closed with a passing
re-comparison. A test that only shows the sweep works on a tidy database does not discharge
this.

### 5.3 PR S3 — backfill, parity, repair, and cutover-readiness proof

**Ruling D5 removed the read cutover from this PR.** `S3` moves nothing. It establishes that
the cutover in `S4` is safe.

- Backfill the eight tables from the current workbook. The backfill is a one-way script that
  is run once per environment and is deleted in `S4`.
- Prove reconciliation (§6.2 P3).
- Run the sweep continuously, and drive the open-divergence count to zero.
- Prove the repair path closes a divergence only on a passing re-comparison.
- Prove cutover readiness: every read the `S4` cutover will move is proven, against the
  backfilled database, to return what the Sheets read returns today.
- **Must not:** move any athlete-facing read or write. Sheets stays the authority for both.
- **Blocked on:** nothing owner-reserved. Ruling D2's Constitution amendment is required
  before the `S4` cutover, not before this PR, because `S3` changes no authority.
- **Bridge introduced:** none new. The `S2` bridge continues.

**Why this is strictly safer than the earlier shape.** Moving reads at `S3` while writes
stayed on Sheets created a window in which reads led writes, so a failed shadow write could
serve a silently incomplete workout to the athlete. Deferring the cutover removes the window
entirely, and removes the need to serve any athlete read from an inert shadow.

### 5.4 PR S4 — the cutover, then delete

1. **Move reads and writes together.** Supabase becomes the approved-write authority and the
   read authority for the migrated concepts in one step.
   `preview → approve → write` is unchanged; the write lands in a Supabase transaction.
2. **Export a completed session to Google Sheets asynchronously**, after closeout. The
   export writes the same columns in the same owner-approved order. An export failure never
   fails a workout and never changes a visible claim.
3. Delete, in the same PR:
   - the Sheets hot-path reads for the migrated concepts;
   - the shadow write, `atlas.migration_divergences` (dropped), the sweep, the repair worker;
   - the backfill script;
   - `services/sessionReadBatch.js` and the per-request `batchGet` context in `sheets.js`,
     for the migrated ranges;
   - the `Log_Cleaned` / `Effort` 30-second row cache in `index.js`;
   - `GET /api/log-workout/verify-range` and the client fallback branch — its sunset
     condition in `docs/ATLAS_SYSTEM_AUTHORITY.md` concept 11b is satisfied by this cutover;
   - the read-budget harnesses and fixtures for the migrated path:
     `test/liveSessionReadBudget.test.js`, `test/sessionReadBudget.test.js`,
     `test/sheets-adapter-reads.test.js`, `test/fixtures/liveSessionManifest.json`,
     `scripts/reconstruct-session-reads.js`, and `docs/READ_BUDGET.md`;
   - **the file-backed idempotency store**, `ATLAS_IDEMPOTENCY_FILE`, and
     `/tmp/atlas-idempotency.json` — with a proof that **no caller of it remains** (ruling
     D4).
4. Verify the deleted machinery is genuinely absent, and record the count.

**Nothing survives `S4`.** Ruling D4 removed the only artifact an earlier version of this
design let survive. If any item on the list above cannot be deleted at `S4`, that is an open
loop, and it must carry a named consumer and an exact sunset condition, or `S4` is not
complete.

#### The export must be durable AND idempotent

**The owner review found that the derived queue delivered durability but not idempotency.**
The queue guarantees a closed session is retried after a crash. It did not prevent this
sequence: the Sheets append succeeds; the process dies before `sheets_exported_at` is set;
the restart exports the same session again. With no claim lease, two workers could also
claim the same session. Either path accumulates duplicate sets and ledger rows in the
mirror.

Three mechanisms, all required.

1. **The queue stays derived, never enqueued.** A session owes an export when a
   `session_closeout` event exists in `atlas.session_plan_events` **and**
   `atlas.workout_sessions.sheets_exported_at IS NULL`. That query is the queue. Nothing
   extra is written at closeout, so nothing extra can be lost, and no second closeout
   authority appears. This is why no outbox table is added: an outbox row can itself fail to
   be written, whereas the closeout event that creates the obligation is the same row that
   proves the session closed.
2. **A claim lease makes the worker single.** Claiming is one conditional statement that
   sets `export_claim_token` and `export_claim_expires_at` only when the session is
   unclaimed or its lease has lapsed. Only the holder of the matching token may later set
   `sheets_exported_at`. A crashed worker's lease lapses and the session returns to the
   queue; a second worker cannot claim a live lease.
3. **The export is identity-idempotent, which survives an ambiguous Sheets response.** Every
   migrated table has an **export identity key** — `(lower(session_id), lower(exercise),
   set_number)` for sets, `session_id` for effort, and `idempotency_key` for both ledgers.
   The worker reads back the session's existing Sheets rows, computes which identity keys are
   already present, and appends **only the missing ones**. It then re-reads and verifies
   exactly one row per identity key before setting `sheets_exported_at` with its claim token.

   A death after the append and before the acknowledgement is therefore safe: the restart
   re-claims, reads back, finds the rows present, appends nothing, verifies, and
   acknowledges. An ambiguous append response is resolved the same way — by looking, not by
   guessing.

   The read-back is a Sheets read, and it is deliberately **off the athlete path**: it runs
   in the asynchronous export worker after closeout, so it does not reintroduce an
   athlete-facing quota dependency.

`npm run atlas:status` reports the count of sessions owing an export and the oldest such
session, so a stalled mirror is visible rather than silent.

---

## 6. Exact proof required before each cutover

A proof is level-correct. A unit test proves local logic. An integration test proves
wiring. A browser or full-session test proves the product path. Owner evidence proves owner
operation. No lower rung substitutes for a higher one.

### 6.1 Gate for `S2` (merge the shadow write and the divergence lane)

| # | Requirement |
|---|---|
| P1 | Deterministic tests: every constraint of §3 is proven by a test that inserts a violating row and asserts the insert is rejected. A constraint with no violation test does not count as proven. |
| P2 | Integration tests against a **real disposable Supabase/Postgres database**, created and destroyed per CI run. A fake, an in-memory stub, or a mocked client does not satisfy this. |
| P3 | The shadow write is proven inert: a browser-level test shows the athlete-facing response is byte-identical with the shadow write enabled and disabled. |
| P4 | A shadow write that throws is proven not to fail a Save. |
| P5 | **Process death in the exact window is proven detectable.** Kill the process after the Sheets append returns success and before the shadow write; restart; run the sweep; assert the omission is found, repaired, and closed with a passing re-comparison. |
| P6 | The sweep is proven complete on the four migrated concepts: a seeded omission, a seeded content mismatch, and a seeded Supabase-only orphan are each detected and classified with the correct `reason`. |
| P7 | A divergence is proven **not** closable without `closure_proof`, and proven not closable by a lapsed lease or a timer. |
| P8 | The `write_receipts` state machine is proven on all four transitions of §3.6, including that a **`failed` attempt does not consume the `write_id`** and that a superseded attempt's late `completeWrite` is discarded. |
| P9 | Every drift and authority guard passes. `npm test`, the Playwright suite, lint, syntax, and the secret scan pass. |

### 6.2 Gate for `S3` (backfill, parity and readiness — no cutover)

| # | Requirement |
|---|---|
| P1 | Deterministic tests for every read path the `S4` cutover will move. |
| P2 | Integration tests against a real disposable Supabase database. |
| P3 | **Backfill reconciliation.** For each of the four tabs: equal row counts; every row matched by its export identity key; and a field-by-field comparison reporting zero differences after the §4.7 blank/null rule is applied. A count match alone is not reconciliation — identity and content must both be proven. The reconciliation report is committed as evidence, with workout values redacted. |
| P4 | **No athlete-facing dependency on the Sheets quota** for the migrated concepts. Measured, not asserted: replay `test/fixtures/liveSessionManifest.json` against the prospective read path and record the residual Sheets read count per range. With the `Exercise_Catalog` mirror in place (ruling D1) the expected residual on the Save path is zero; the measurement, not this sentence, is the proof. |
| P5 | **Cutover readiness.** Every read `S4` will move returns, against the backfilled database, what the Sheets read returns today. |
| P6 | The open-divergence count reaches **zero** and the sweep that established it ran to completion. |
| P7 | The repair path is proven to close a divergence only on a passing re-comparison. |

### 6.3 Gate for `S4` (the cutover)

Everything in §6.2, re-run after the cutover, plus:

| # | Requirement |
|---|---|
| P8 | **One non-counting deployed debug workout**, explicitly marked non-counting. It does not advance the rehearsal streak, Stage A, or Stage B. |
| P9 | `preview → approve → write` preserved. Proven by the existing trust-loop and browser tests, unchanged. |
| P10 | **Idempotent repeated approval.** A repeated approval writes zero additional rows. Proven at the database, by row count and by identity. |
| P11 | **Exact set, plan, ledger and closeout evidence.** The debug workout's rows are compared against a declared expectation written **before** the run: exact sets, exact plan events, exact ledger rows, exact seal, exact closeout status. A "rows appeared" standard does not qualify. |
| P12 | A write failure is proven atomic: no partial session is left behind. |
| P13 | Undo is proven exact: `DELETE` by `(session_id, write_id)` removes exactly the rows of that Save and nothing else, and the fail-closed contract of `services/closeoutFinality.js` still refuses an undo of a finalized session. |
| P14 | **The export is durable AND idempotent.** Kill the process **after the Sheets append and before the Supabase acknowledgement**; restart; and prove the mirror contains **exactly one copy, by identity and by content** — not merely that an export eventually occurred. Separately prove two concurrent workers cannot both claim one session. |
| P15 | **The open-divergence count is zero** and every `atlas.migration_divergences` row is `closed`. If not, `S4` does not merge. |
| P16 | **No caller of the file-backed idempotency store remains**, proven by search, and the store, its env var, and its file are absent. |
| P17 | The deletion list of §5.4 is verified absent, including the dropped `atlas.migration_divergences` table. |
| P18 | A second non-counting deployed debug workout, after the cutover. |

---

## 7. Failure and rollback rules

### 7.1 Standing rules

1. **The athlete-facing write succeeds or fails from the current authority only.**
   In `S2` and `S3` that is Google Sheets. After `S4` it is Supabase.
2. **Atlas never reconciles two authorities silently.** A divergence is recorded and
   repaired. It is never averaged, merged, or preferred by recency.
3. **A shadow failure is never an athlete-facing failure**, and never a visible claim.
4. **Fail closed on unknown.** If Atlas cannot establish that a write landed, it reports
   that it has no proof. It never reports a verified write on missing evidence. This is the
   existing `verified: false` posture, unchanged.
5. **Any production data-integrity anomaly freezes writes immediately** and is reported to
   the owner. This rule is unchanged from `CLAUDE.md`.

### 7.2 Rollback per step

| Step | Rollback | Data risk |
|---|---|---|
| `S2` | Disable the shadow write by its flag; revert the PR. | None. Sheets never stopped being the authority. Supabase holds a copy that nothing reads. |
| `S3` | Revert the PR. | None. No read and no write moved. Sheets remains both authorities throughout. |
| `S4` | Revert the PR **and** re-import any session written to Supabase after the cutover into Sheets, using the same export as §5.4. | Real. This is the only irreversible step, and it is why `S4` needs an owner gate and a verified backup. |

Ruling D5 concentrates all the risk into one step and leaves the two steps before it fully
reversible. That is the point of it.

### 7.3 The `S4` rollback window

Before `S4` merges, record:

1. a verified Supabase backup and a proven restore (§8.4);
2. the exact export command that reproduces a Sheets row set from Supabase;
3. a stated rollback window — the period during which a revert is a supported operation
   rather than a data-recovery exercise.

If any of the three is missing, `S4` does not merge.

---

## 8. Security design

### 8.1 Server-only service-role key

- The Supabase service-role key is read from an environment variable on the server only.
- It is held by one module — the adapter of §5.2 — exactly as the read-write Sheets client
  is held only by `sheets.js`.
- **No Supabase key of any kind appears in browser code.** `src/app/` never imports the
  Supabase client, never receives a key, and never contacts Supabase directly. The browser
  keeps talking to the Express API.
- The anon key is not used, because the browser is not a Supabase client. Not creating a
  browser client is what removes the whole class of anon-key exposure.

### 8.2 Least privilege

- The application connects with one role that holds `SELECT`, `INSERT`, and the specific
  `UPDATE` grants the design needs: `closeout_write_id` on
  `atlas.session_plan_set_recommendations`; `status`, `attempt*`, `response_body`,
  `rows_written` and `completed_at` on `atlas.write_receipts`; the `sheets_export_*` and
  `export_claim_*` columns on `atlas.workout_sessions`; and the state columns on
  `atlas.migration_divergences` while it exists.
- It holds `DELETE` on `atlas.logged_sets` only, for undo. It holds `DELETE` on nothing else.
- It holds no `DROP`, no `ALTER`, and no schema-modification grant. Migrations run under a
  separate migration role.
- Read-only tooling (`npm run atlas:status`, `npm run atlas:review-live`) connects with a
  distinct read-only role, mirroring the existing rule that read-only tools build their own
  `spreadsheets.readonly` client.

### 8.3 Row Level Security — no claim without configuration

**Atlas makes no Row Level Security claim.** Atlas is single-owner during V1 and the
browser is not a Supabase client, so RLS is not the control that protects this data — the
service-role key's confinement to the server is. RLS may be enabled later. Until it is
configured **and** a test proves a denied read, no document, PR body, or merge card may
state that Atlas has RLS. A claimed-but-unconfigured RLS policy is a false security claim.

### 8.4 Secret scanning, backups, restore

- `npm run scan:secrets` gains the Supabase key patterns in `S2`, before any key is
  configured. A connection string, a service-role JWT, an anon key, and a project reference
  are all treated as secrets. The existing rule holds: no secret, `.env`, production id, or
  private workout data in a commit or a PR.
- **The `Atlas Production` project reference and its credentials are not committed.** They
  are treated exactly as the production Sheet ID is treated — never in the repository, never
  in a PR body, never in an evidence file. The project's human-readable name is not a
  credential and may be recorded; its reference is.
- **Backups.** Before `S3`'s backfill and before `S4`'s cutover, take a backup and prove a
  restore into a scratch database. A backup that has never been restored is not a backup.
  `npm run backup:sheets` remains and keeps covering the Sheets mirror.
- The `S4` gate requires a restore proof, not a backup setting.

---

## 9. Data ownership

The record below is the summary. The per-concept record is
[`docs/ATLAS_SYSTEM_AUTHORITY.md`](./ATLAS_SYSTEM_AUTHORITY.md), concept 18.

| Field | Value |
|---|---|
| **Current winner** | Google Sheets, through `sheets.js`, for all seven concepts, plus the file-backed store in `services/idempotency.js` for write receipts. |
| **Intended winner** | Supabase. Sheets becomes an export mirror for the migrated concepts, and stays the editing authority for `Exercise_Catalog`. |
| **Bridge** | The shadow write, `atlas.migration_divergences`, the reconciliation sweep, and the repair worker. Live in `S2` and `S3` only. |
| **Exact sunset** | `PR S4` deletes all four bridge components, drops `atlas.migration_divergences`, deletes the Sheets hot-path reads, the read-budget machinery, the backfill script, the verify-range route, **and the file-backed idempotency store**, and verifies their absence. |
| **Code and tests deleted at closure** | The list in §5.4 step 3. **Nothing on it survives `S4`.** |
| **Net complexity after migration** | Expected **negative**. Removed: the per-request `batchGet` read context, the route range declarations, the 30-second row cache, the session read-budget harness and its fixture, the reconstruction script, the read-budget document, the verify-range route and its client fallback, and the file-backed idempotency store. Added: seven permanent tables, one adapter module, the `Exercise_Catalog` sync, and the asynchronous export worker. The eighth table and the whole bridge are temporary and are dropped. This expectation is **not yet measured**; `S4` must report the actual net line and module change. |

### Owner rulings — D1 through D5, all resolved

The owner review of `b38de8b` resolved every open decision. They are recorded here as
rulings, not as questions.

**D1 — `Exercise_Catalog` mirror: RESOLVED, build it.** Add the read-only mirror
(§3.7) needed to remove the final athlete-facing Sheets quota dependency. Sheets remains its
editing authority; Supabase is the Save-path read mirror.

**D2 — Constitution amendment: RESOLVED, content dictated.** Amend `docs/CONSTITUTION.md`
before the cutover so that **Supabase wins for migrated hot-path concepts**, **Sheets wins
for unmigrated concepts**, and **Sheets is the export mirror for migrated concepts**. Lines
14 and 55 carry the current claim. The amendment lands before the `S4` cutover — not before
`S3`, because ruling D5 means `S3` moves no authority. Dale writes the amendment; no agent
writes Constitution text.

**D3 — the Supabase project: RESOLVED.** Use the owner-created Free-tier project **Atlas
Production**, verified healthy and empty, `us-west-2`, zero public tables, zero migrations.
No identifier and no credential is committed. Applying a schema to it remains a separate
owner action.

**D4 — one receipt authority: RESOLVED.** All seven current `beginWrite` callers move to
`atlas.write_receipts` (§3.6). Receipt metadata is shared safety infrastructure, not a second
workout-data migration. `S4` removes the file store and proves no caller remains.

**D5 — where the read cutover lands: RESOLVED, defer into `S4`.** Reads and writes move
together. `S3` becomes backfill, continuous parity, repair, and cutover-readiness proof only.
This removes the reads-leading-writes window and the need to serve athlete reads from an
inert shadow.

---

## 10. Documents that become stale, and when

Each line is a cleanup obligation of the PR named, not of `S1`.

| Document | Statement | Corrected by |
|---|---|---|
| `CLAUDE.md` | "Google Sheets is the permanent V1 record; there is no second database." | `S1` — done |
| `CLAUDE.md` | "What not to build: a second database or storage migration" | `S1` — done |
| `docs/DECISION_KERNEL.md` | "Sheets-primary V1. No second permanent database…" | `S1` — done |
| `docs/ATLAS_V1_EXECUTION_PLAN.md` §5, §12 | "No Supabase/Postgres migration is part of this campaign" | `S1` — done |
| `docs/ARCHITECTURE.md:103` | "Stay Sheets-primary for v1… before introducing a database" | `S1` — done |
| `README.md:10` | "Google Sheets is the permanent V1 record." | `S1` — done |
| `docs/CONSTITUTION.md:14`, `:55` | "one spreadsheet as the permanent record"; "There is no secondary database" | **Ruling D2**, before the `S4` cutover |
| `docs/ATLAS_OPERATIONS_CONTRACT.md:103` | "There is no new database, no Supabase" | `S2` — the sentence scopes the status surface; it becomes false when the adapter lands |
| `docs/READ_BUDGET.md` | The whole document | `S4` — deleted |
| `docs/SHEET_CONTRACT.md`, `.claude/rules/sheet-schemas.md` | Sheet layouts for the four migrated tabs | `S4` — restated as the export contract, not the runtime contract |
| `docs/ATLAS_SYSTEM_AUTHORITY.md` concepts 11, 11b, 12 | Sheets as durable-write authority | `S4`, when authority actually moves |

---

## 11. What this document does not claim

- It does not claim any Supabase table exists. The `Atlas Production` project was verified
  empty: zero public tables, zero migrations.
- It does not claim a measurement. The net-complexity expectation in §9 and the residual
  read count in §6.2 P4 are both unmeasured, and both are marked as such.
- It does not authorize applying a schema or deploying.
- It does not amend the Constitution, and it writes no amended wording. Ruling D2 states the
  substance; Dale writes the text.
- It does not claim Row Level Security is configured.
- It is not a roadmap, a campaign, or a second execution plan. The execution plan's
  2026-08-07 owner-instruction block is the sole work-selection authority for this chain.
