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
  authority. Supabase holds a synchronised read copy for the Save path. It removes the last
  **in-request** Sheets read from the migrated Save path. It does **not** make Save
  availability independent of the Sheets quota — §3.7 and §6.2 P4 state the residual exactly.
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

**Eleven tables: ten permanent, one temporary.** Each names its immediate production
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
| 3.7 | `atlas.exercise_catalog_sync` | permanent — the mirror's freshness authority |
| 3.8 | `atlas.migration_divergences` | **TEMPORARY — dropped by `S4`** |
| 3.9 | `atlas.sheets_mirror_cursor` + `atlas.sheets_mirror_allocations` | permanent — the export destination authority |

The catalog is two tables, not one: content and freshness are separate concerns, and the
owner review of `5f42d3c` found that collapsing them left the mirror with no freshness
authority at all.

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
| `export_claim_token` | `uuid` | Nullable. **Acknowledgement guard only** — see §5.4. Not fencing, and not mutual exclusion. |
*(The export's destination is **not** stored here. It lives in `atlas.sheets_mirror_allocations` (§3.9), because a per-session column cannot serialise two different sessions competing for the same rows.)*

- **Unique:** `(session_date, period, slot)`.
- **Index:** the PK, plus `(session_date DESC)`, plus a partial index on
  `(session_id) WHERE sheets_exported_at IS NULL` — the export worker's queue scan.
- **Mutability:** insert-only for identity. Exactly four columns are updatable —
  `sheets_exported_at`, `sheets_export_attempts`, `sheets_export_error`, and
  `export_claim_token` — and only the `S4` export worker updates them. They are unused before
  `S4`. The export **destination** is not among them: it lives in
  `atlas.sheets_mirror_allocations` (§3.9).
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
| `write_id` | `text` | Nullable. The `write_id` of the write that created the row. **No foreign key until `S4`** — see §3.6. Null on backfilled rows and on any row the sweep repaired. |
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
| `write_id` | `text` | Nullable. **No foreign key until `S4`** — see §3.6. Null on backfilled rows and on any row the sweep repaired. |
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
| `attempt_token` | `uuid` | Nullable. The current attempt's token, regenerated on every new attempt. Null only where no Supabase attempt was ever claimed. |
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

#### `S2` and `S3` do not mirror receipts at all

**Correction, from the owner review of `2ce7be3`, replacing the mechanism the review of
`5f42d3c` prompted.** The previous version had `S2` mirror each decided file-backed receipt
into Supabase, parent-first, with `ON CONFLICT (write_id) DO NOTHING`. The third review
showed that mechanism cannot work, for two independent reasons:

1. **The sweep cannot reconstruct a receipt lost in the death window.** `Log_Cleaned` and
   `Effort` carry **no `write_id` column** — `config/columns.js` defines 12 and 9 columns and
   neither includes it; the mapping in §4.1 and §4.2 marks `write_id` as *new*, added only in
   Supabase. So if the process dies after the Sheets Save and before the shadow transaction,
   the authoritative Sheets rows prove the child data exists but **cannot reveal the missing
   receipt's `write_id`**, route, response body, or attempt. The file store is
   process-adjacent `/tmp` state with a TTL and may be gone after the same restart. A
   divergence keyed on an unknown `write_id` cannot be opened, so the parent-first repair was
   not implementable from the declared completeness authority. **That reintroduced the first
   review's process-death defect one level down.**
2. **`ON CONFLICT DO NOTHING` cannot mirror a retryable transition.** The file store permits
   `failed → new attempt → completed` (`services/idempotency.js:178-181`). If a `failed`
   outcome mirrored first and the retry then succeeded, the `completed` outcome would be
   discarded and Supabase would stay permanently `failed`. Out-of-order mirror work had no
   source attempt or version to say which terminal state was newer.

**The correction removes the mechanism rather than patching it.** Receipts are not mirrored
during `S2` or `S3`:

- **`logged_sets.write_id` and `session_effort.write_id` are nullable and carry NO foreign
  key until `S4`.** **`S2` and `S3` always store `write_id = NULL`** — never an
  observability-only value.

  *Correction, from the owner review of `0878f61`.* The previous wording let the shadow
  record a `write_id` "when it happens to have one". Those non-null values would have had **no
  parent row**, because `S2`/`S3` mirror no receipts — so the `S4` migration adding
  `REFERENCES atlas.write_receipts(write_id)` would have **failed validation on the existing
  shadow rows**, before the new receipt authority could start. A column that is always null
  makes the constraint addable by construction; a column that is sometimes populated from an
  authority that does not exist yet does not.

  Only **post-cutover** writes carry a non-null `write_id`, and each is backed by a receipt
  created in the same authority path, in the same transaction.
- **The file store remains the sole receipt authority through `S2` and `S3`**, unmirrored and
  uncross-checked. There is no Supabase receipt to be wrong.
- **`write_receipts` is not a sweep concept.** Sheets cannot be its completeness authority,
  because Sheets never stores a `write_id`. The design does not claim a check it cannot
  perform.
- **A child row repaired by the sweep gets `write_id = NULL`**, because the sweep genuinely
  cannot know it. It never fabricates one.
- **`S4` adds the foreign key and makes Supabase the receipt authority in the same step.**
  `beginWrite` starts claiming in Supabase, the §3.6 state machine goes live, and the
  migration adds `logged_sets.write_id REFERENCES atlas.write_receipts(write_id)` and the
  same on `session_effort`. Historical and backfilled rows keep `write_id = NULL`, which the
  foreign key permits. There is no receipt data to migrate — only a decider to change.
- **Undo is unaffected.** `DELETE … WHERE session_id = $1 AND write_id = $2` operates on the
  Save just performed, which after `S4` always carries a `write_id`. A pre-cutover row with a
  null `write_id` was never undoable by that path.

This also removes the retryable-transition problem entirely: with nothing mirrored, there is
no terminal state to overwrite out of order.

**This resolves a contradiction the owner review found.** An earlier version of this design
said the file store deliberately survives `S4` for four routes, while
`docs/ATLAS_SYSTEM_AUTHORITY.md` concept 18 said `S4` deletes it and verifies its absence,
and the §9 ownership table said both. Two incompatible rulings on one artifact could either
strip four routes of duplicate-write protection or falsely close `S4` while a competing
authority remained. There is now one ruling, and every authority surface states it.

### 3.7 `atlas.exercise_catalog_mirror` and `atlas.exercise_catalog_sync`

A read-only mirror of `Exercise_Catalog` (ruling D1). Reference data, not workout data.

**Correction, from the owner review of `5f42d3c`.** An earlier version of this section said a
failed sync leaves the previous mirror in place, and called that the same behaviour as the
existing 60-second cache. **That was wrong, and it silently converted a fail-closed property
into a fail-open one.** The live code is fail-closed: `sheets.js:738-739` drops the cache
entry at expiry with the comment *"Explicit expiry: drop it here so no path below can fall
back to it"*, and a failed refresh throws. Enrichment never runs on expired content today.
A mirror that keeps serving after a failed sync could enrich Saves indefinitely from content
that disagrees with the Sheets editing authority. The rules below restore fail-closed and add
the freshness authority the mirror lacked.

**`atlas.exercise_catalog_mirror`** — the content.

| Column | Type | Notes |
|---|---|---|
| `exercise` | `text` | **PK** — `lower(exercise)`, the lookup key the resolver uses. |
| `display_exercise` | `text` | The catalog's `Exercise` cell, verbatim. |
| `muscle_group` | `text` | |
| `lift_code` | `text` | |
| `canonical_exercise` | `text` | |
| `sync_id` | `bigint` | The sync generation that wrote this row. `REFERENCES atlas.exercise_catalog_sync(sync_id)`. |

- **Index:** the PK, plus `(lift_code)`, plus `(sync_id)`.

**`atlas.exercise_catalog_sync`** — the freshness authority. One row per sync attempt;
the current generation is the newest `status = 'verified'` row.

| Column | Type | Notes |
|---|---|---|
| `sync_id` | `bigint` | **PK**, `GENERATED ALWAYS AS IDENTITY`. The generation. |
| `started_at` | `timestamptz` | |
| `verified_at` | `timestamptz` | Nullable. Set only when the swap committed **and** the content was verified. |
| `status` | `text` | `CHECK (status IN ('in_progress','verified','failed'))`. |
| `content_hash` | `text` | SHA-256 over the normalised source rows, in order. The version identity. |
| `source_row_count` | `integer` | |
| `last_error` | `text` | Nullable. The exact failure, durable. |

- **Index:** partial on `(verified_at DESC) WHERE status = 'verified'` — the currency lookup.

#### The freshness rules

1. **The freshness winner is Google Sheets content as of the last verified sync.** Sheets
   remains the sole **editing** authority. The mirror is a projection and is never the place
   an exercise is defined, renamed, or given a lift code.
2. **`CATALOG_MIRROR_MAX_AGE` bounds what may be served.** The Save path reads the mirror only
   while `now() - verified_at <= CATALOG_MIRROR_MAX_AGE`. **Proposed default: 3600 s**, with
   a sync interval well below it so a single failed sync never reaches the bound. The value
   is owner-settable; the rule is not.
3. **Beyond the bound, the Save fails closed** — the same 503 posture the expired cache
   produces today, carrying an explicit reason. **Stale content is never served silently, and
   never served at all.** There is no stale-after-expiry fallback, exactly as there is none
   today.
4. **A failed sync never advances currency.** It writes `status='failed'` with `last_error`
   and leaves the previous verified generation as the current one. That generation still
   ages, so a persistently failing sync reaches the bound and the Save fails closed. A
   failure cannot buy the mirror more time.
5. **An empty or shrunken source is refused.** An empty read is never written, matching
   `sheets.js:754-756` — *"An empty catalog is never cached"*. A source row count that drops
   by more than a declared fraction fails the sync rather than replacing a good catalog with
   a truncated one.
6. **A content mismatch is a divergence, not a silent overwrite.** The reconciliation sweep
   recomputes `content_hash` from Sheets and compares it against the current generation. A
   mismatch that a sync has not already resolved opens a `migration_divergences` row on
   concept `exercise_catalog`, which blocks the cutover exactly as any other open divergence
   does.
7. `npm run atlas:status` reports the current generation's age, its `content_hash`, and the
   last failure. Staleness is visible before it is fatal.

- **The swap.** The sync inserts an `in_progress` row, loads the catalog from Sheets, and in
  **one transaction** deletes the previous generation's rows, inserts the new rows, and marks
  the generation `verified`. A reader never sees a half-written catalog, and a reader on the
  old generation is unaffected until the transaction commits. The exact grants this requires
  are in §8.2 — the application role holds `DELETE` on this table, which §8.2 states
  explicitly rather than claiming a blanket "DELETE on `logged_sets` only".
- **Mutability:** wholly replaced per generation. Never updated per row by the request path.
- **Immediate production consumer:** `getExerciseCatalog()`'s callers — the Save-path
  enrichment in `POST /api/log-workout` and `POST /api/complete-workout`, and the catalog
  reads in `routes/reads.js`.
- **What this changes about the quota dependency, stated exactly.** The Save path's *read*
  moves to Supabase, so a Sheets quota error during a session cannot fail a Save. The
  dependency is **bounded and decoupled**, not eliminated: a background sync that cannot read
  Sheets for longer than `CATALOG_MIRROR_MAX_AGE` will eventually fail Saves closed. That is
  one read per sync interval from a background job, rather than a read inside a session's
  read burst. §6.2 P4 requires this to be **measured and stated with its exact residual**,
  and it may not be reported as an unqualified zero.

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
| `concept` | `text` | `CHECK (concept IN ('logged_sets','session_effort','session_plan_events','session_plan_set_recommendations','exercise_catalog'))`. **`write_receipts` is deliberately absent** — Sheets stores no `write_id`, so it cannot be that concept's completeness authority (§3.6). The design does not declare a check it cannot perform. |
| `identity_key` | `text` | The diverged row's identity: the export identity key for the four migrated tabs (§3.2–§3.5), and the sync generation's `content_hash` for `exercise_catalog`. |
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

### 3.9 `atlas.sheets_mirror_cursor` and `atlas.sheets_mirror_allocations`

**The export destination authority.** Added by the owner review of `0878f61`.

**The defect this replaces.** The previous design put the destination in
`workout_sessions.sheets_row_start` and proved only that two workers claiming the **same
session** read the same value. It never defined how two **different** sessions reserve
non-overlapping blocks on the same tab. Two sessions could inspect the same tail, allocate
the same start row, and then `values.update` would have one session **overwrite the other** —
a silent loss of an athlete's workout from the mirror. A single transactional statement over
two different `workout_sessions` rows serialises nothing, and the session-level advisory lock
deliberately does not serialise different sessions.

**`atlas.sheets_mirror_cursor`** — one row per mirrored tab. The single point of
serialisation.

| Column | Type | Notes |
|---|---|---|
| `tab` | `text` | **PK**. `Log_Cleaned`, `Effort`, `Session_Plans`, `Session_Plan_Sets`. |
| `next_row` | `integer` | The next unreserved row. `CHECK (next_row >= 2)` — row 1 is the header. |
| `base_established_at` | `timestamptz` | When the cutover recorded this tab's safe base (§5.4 step 4). |

**`atlas.sheets_mirror_allocations`** — the durable reservation.

| Column | Type | Notes |
|---|---|---|
| `tab` | `text` | **PK part 1.** `REFERENCES atlas.sheets_mirror_cursor(tab)`. |
| `session_id` | `text` | **PK part 2.** `REFERENCES atlas.workout_sessions(session_id)`. |
| `start_row` | `integer` | First reserved row, inclusive. |
| `row_count` | `integer` | `CHECK (row_count >= 1)`. |
| `end_row` | `integer` | `GENERATED ALWAYS AS (start_row + row_count - 1) STORED`. |
| `allocated_at` | `timestamptz` | |

- **Primary key `(tab, session_id)`** — this is what preserves the same allocation across
  retries. A re-export finds its existing reservation instead of taking a new one.
- **`EXCLUDE USING gist (tab WITH =, int4range(start_row, end_row + 1) WITH &&)`** (needs
  `btree_gist`). **Two allocations on one tab cannot overlap, structurally.** This is the
  constraint that makes the previous defect unrepresentable rather than merely unlikely.

#### The allocation protocol

One transaction, covering **every** mirrored tab for the session:

1. `SELECT … FROM atlas.sheets_mirror_allocations WHERE session_id = $1 FOR UPDATE` — if a
   complete set of allocations already exists, **use it and take nothing new**. This is the
   retry path, and it consumes no cursor.
2. Otherwise, for each tab, atomically fetch-and-add against the cursor:
   ```sql
   UPDATE atlas.sheets_mirror_cursor
      SET next_row = next_row + $n
    WHERE tab = $1
   RETURNING next_row - $n AS start_row;
   ```
   The row lock on the cursor row serialises **every** session competing for that tab. Two
   concurrent different sessions are ordered by the database, and the second sees the first's
   advanced cursor.
3. Insert the allocation rows. The exclusion constraint is the backstop: if anything ever
   produced an overlap, the insert fails rather than corrupting the mirror.
4. **All tabs, or none.** The whole allocation is one transaction, so a failure cannot leave
   one tab reserved and another not.

- **Immediate production consumer:** the `S4` export worker, before it writes.
- **Mutability:** `next_row` advances monotonically and never decreases. An allocation row is
  never updated after insert.
- **Lifetime:** permanent. It is the mirror's address book, not migration machinery, so `S4`
  keeps it. `base_established_at` records the one-time cutover handshake of §5.4 step 4.

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

- Add the repository migration files for the eleven tables of §3, as plain SQL under
  `supabase/migrations/`. The files are checked in and applied to a **disposable**
  database in CI. Applying them to `Atlas Production` is a separate owner action.
- Add one Supabase adapter module. It is the only module that holds a Supabase client, in
  the same way `sheets.js` is the only module that holds a read-write Sheets client. It
  exposes the operations §3 names and nothing else. **No generic repository layer, no ORM,
  no query builder abstraction.**
- Wire the shadow write, the divergence lane, the reconciliation sweep, and the repair
  worker.

**Every shadow transaction inserts its `workout_sessions` parent first.** *Correction, from
the owner review of `2ce7be3`.* Every migrated child table references
`atlas.workout_sessions(session_id)`. `S2` enables shadow writes against an **empty** schema
and the backfill does not run until `S3`. Nothing in the previous design inserted or
backfilled `workout_sessions` before the children arrived, so **the first `S2` shadow write
for a real session would have violated the session foreign key.**

The parent is derivable, so no extra source is needed: `session_id` carries its own
`YYYYMMDD-{AM|PM}-NN` structure (`services/sessionId.js`), which yields `session_date`,
`period`, and `slot` by parsing alone. Every shadow transaction therefore begins:

```sql
INSERT INTO atlas.workout_sessions (session_id, session_date, period, slot)
VALUES ($1, $2, $3, $4)
ON CONFLICT (session_id) DO NOTHING;
```

and then inserts its children, all in the **same transaction**, so a child can never commit
without its session parent and a failure leaves neither. `ON CONFLICT DO NOTHING` is correct
here and carries none of the hazard it carried for receipts (§3.6): `workout_sessions` is
**insert-only for identity**, so there is no later state transition for it to discard. The
`S3` backfill uses the same conflict clause, so a session a shadow write already created is
neither duplicated nor overwritten.
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

- Backfill from the current workbook the tables the workbook can source: `workout_sessions`,
  `logged_sets`, `session_effort`, `session_plan_events`, `session_plan_set_recommendations`,
  and `exercise_catalog_mirror` with its first `exercise_catalog_sync` generation.
  **`write_receipts` is deliberately not backfilled** — the workbook stores no `write_id`
  (§3.6) — and `sheets_mirror_cursor` takes its base at cutover (§5.5 step 4), not from the
  backfill. The backfill is a one-way script that
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

1. **Move reads and writes together, by the handover protocol in §5.5.** Supabase becomes the
   approved-write authority and the read authority for the migrated concepts.
   `preview → approve → write` is unchanged; the write lands in a Supabase transaction.

   **"Together" is a required result, not a mechanism.** A PR merge and a Render deploy are
   not an atomic authority transfer, and §5.5 is the sequence that makes the result true.
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
2. **The mirror write is idempotent by destination. No lock can fence an external append.**

   **Correction, from the owner review of `2ce7be3`, replacing the mechanism the review of
   `5f42d3c` prompted.** The previous version claimed a session-level Postgres advisory lock
   fences the append, and that a worker whose lock is gone "abandons without appending rather
   than appending late". **The client cannot guarantee that**, and the repository already
   says so. `isTransientAppendError` (`sheets.js:52-76`) refuses to retry any ambiguous
   non-429 failure precisely because *the append may have committed before the backend failed
   to respond*. An HTTP request already sent cannot be recalled. So:

   - Worker A sends the append.
   - A's Postgres connection drops. Postgres releases the advisory lock **immediately**,
     while A's Sheets request is still in flight.
   - B acquires the lock, reads the rows as missing, and appends them.
   - A's original request commits late.

   Two copies, and no lock anywhere in that sequence was violated. **Mutual exclusion in
   Postgres cannot make a Google Sheets append exclusive**, because the two systems share no
   transaction and Sheets cannot evaluate a Postgres predicate.

   The fix is to stop needing exclusivity: **make the mirror write idempotent by giving every
   row a deterministic destination.**

   - The destination is allocated **once per session per tab** by
     `atlas.sheets_mirror_allocations` (§3.9), whose per-tab cursor serialises **different**
     sessions and whose exclusion constraint makes two overlapping blocks unrepresentable.
     A retry reuses the existing reservation rather than taking a new one.
   - The export writes with `spreadsheets.values.update` into the **exact allocated range**,
     not with `values.append`. The same session always writes the same values into the same
     cells.
   - A late duplicate from a superseded worker therefore **overwrites its own identical
     values in its own cells**. It cannot create a second copy, because it has nowhere else
     to write. Ordering between A and B stops mattering, which is what makes this immune to
     the race above rather than merely unlikely to hit it.
   - The grid is extended to cover the allocation before the write, so an update that lands
     past the current row count cannot fail for want of rows.

   This is safe only because **Atlas is the sole writer of these tabs once they are export
   mirrors**. That is exactly what `S4` establishes, and it is why deterministic destinations
   are available here and were not available while Sheets was the live write authority.

   **Reconciliation still tolerates a duplicate rather than assuming one is impossible.** The
   verify step counts rows per identity key, and more than one opens a divergence instead of
   passing silently. A mechanism that is believed to be idempotent, and a mechanism that is
   checked, are not the same thing.

   The advisory lock is **kept, with an honest job**: it stops two workers doing redundant
   work at the same time, which is a throughput and quota concern, not a correctness one.
   `export_claim_token` likewise remains the **acknowledgement guard only**. Neither may be
   described as fencing again.

   **The trade-off, stated rather than hidden.** A worker that hangs without dying keeps the
   lock and the export stalls. That is deliberate: a visible stall is better than churn, and
   `npm run atlas:status` surfaces the oldest session owing an export precisely so the stall
   is seen. Correctness no longer depends on that lock being held.
3. **Identity verification spans the whole tab, not only the allocated block.** Every
   migrated table has an **export identity key** — `(lower(session_id), lower(exercise),
   set_number)` for sets, `session_id` for effort, and `idempotency_key` for both ledgers.

   *Correction, from the owner review of `0878f61`.* The previous version re-read only the
   worker's **allocated range** while claiming to detect duplicates. A duplicate outside that
   block was invisible to it, so a session could be marked exported while another copy of the
   same identity sat elsewhere in the tab — reachable during the cutover, after a manual or
   structural Sheet edit, or after any stray legacy append. A verifier that can only see
   inside its own reservation cannot make a statement about the tab.

   The verifier therefore reads **the whole relevant tab** and asserts **exactly one row per
   identity key across the entire tab**, not merely inside the reserved block. Only then is
   `sheets_exported_at` set, and only with a matching claim token.

   Because the destination is deterministic (mechanism 2), verification is a confirmation
   rather than a reconciliation: there is no "which rows are already present, write the rest"
   step whose answer could change between two workers. A death after the write and before the
   acknowledgement is safe — the restart re-claims, rewrites the same values into the same
   cells, verifies, and acknowledges.

   **A count greater than one is a defect, not a tidy-up.** It opens a divergence, the session
   is **not** marked exported, and the design does not delete Sheets rows to correct itself.

   **The cost, stated rather than hidden.** A whole-tab read per completed session is more
   expensive than a block read, and `Log_Cleaned` grows. It is deliberately **off the athlete
   path** — it runs in the asynchronous export worker after closeout, so it adds no in-request
   Sheets read to a Save — and it is the only check that can support the claim being made. A
   cheaper verifier that cannot see the whole tab would have to stop claiming duplicate
   detection.

`npm run atlas:status` reports the count of sessions owing an export and the oldest such
session, so a stalled mirror is visible rather than silent.

---

### 5.5 The `S4` handover protocol

**Added by the owner review of `0878f61`.** The design previously said reads and writes "move
together" and left it there. A merge plus a deploy is a rolling replacement, not an atomic
authority transfer, and without a protocol an old instance — or a request already in flight on
one — can complete an **acknowledged Sheets write** after the final `S3` sweep, while a new
instance is already reading and writing Supabase. That recreates the exact acknowledged-write
omission this migration exists to eliminate. It also makes the export's initial per-tab base
unsafe, because a late append can land after the allocator has recorded its tail.

The handover is eight ordered steps. Each one must complete and be verified before the next
begins.

1. **Freeze the affected writes.** A write-freeze flag makes every migrated write route **fail
   closed** with an explicit "migration in progress" response. The trust loop is suspended,
   never weakened: an athlete gets a clear refusal, never a silent drop and never an
   unverified success. **The freeze ships as its own earlier deploy**, so that every running
   instance — old and new — is already honouring it before the cutover deploy begins. A freeze
   that only the new build knows about would not stop the old one.
2. **Drain, and prove the drain.** After the freeze is live on all instances, wait longer than
   the maximum request duration, then prove **no in-flight Sheets hot-path write remains**:
   zero `in_progress` write receipts, and zero in-flight requests on the migrated write
   routes. The proof is a positive assertion, not an elapsed timer.
3. **Run a final complete sweep** and require **zero open divergences**. It runs after the
   drain, so nothing can be written behind it.
4. **Establish and record the export mirror's per-tab base.** Read each mirrored tab's true
   tail and set `atlas.sheets_mirror_cursor.next_row` past it, stamping
   `base_established_at`. This is only safe because step 2 proved no further append can land.
5. **Apply the `S4` schema and receipt transition.** Add the `write_id` foreign keys — which
   validate because `S2`/`S3` always stored null (§3.6) — and make Supabase the receipt
   authority.
6. **Deploy the cutover build** and switch the sole runtime authority.
7. **Run the non-counting proof workout** and the exact evidence checks of §6.3.
8. **Reopen writes**, and only after step 7 passes.

**Abort and rollback.** Steps 1–4 are reversible by lifting the freeze: nothing has moved. If
any check fails at step 5, 6 or 7, the cutover aborts, the freeze stays on, and the previous
build is restored — writes reopen on Sheets. Before reopening at step 8, **re-verify each
tab's tail against `base_established_at`**; a tail that moved means an old-authority write
landed after the base was recorded, and the cutover aborts rather than writing over it.

**Required proof (§6.3 P19).** An old-authority write attempting to complete after the
cutover boundary is **refused or detected before writes reopen**. A protocol whose failure
case has never been exercised is a plan, not a control.

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
| P6 | The sweep is proven complete on all five declared concepts: a seeded omission, a seeded content mismatch, and a seeded Supabase-only orphan are each detected and classified with the correct `reason`. Includes a **catalog content mismatch** (`exercise_catalog`). |
| P7 | A divergence is proven **not** closable without `closure_proof`, and proven not closable by a lapsed lease or a timer. |
| P7a | **The shadow transaction is proven ordered and atomic on the session parent.** A shadow Save inserts its `workout_sessions` parent before its child rows in one transaction; a child can never commit without its session parent; a failure mid-transaction leaves neither; and a second Save for the same session does not duplicate or overwrite the parent. Proven against an **empty** schema, which is the state `S2` actually starts from. |
| P7d | **No receipt is mirrored during `S2`/`S3`**, proven by assertion on an empty `write_receipts` after a shadow Save, and `logged_sets.write_id` / `session_effort.write_id` carry **no foreign key** at this stage. A repaired child row is proven to carry `write_id = NULL` rather than a fabricated value. |
| P7b | **The catalog mirror is proven fail-closed.** A generation older than `CATALOG_MIRROR_MAX_AGE` is proven **not served** — the Save fails closed with an explicit reason, exactly as the expired cache does today. A failed sync is proven not to advance currency. An empty or materially shrunken source is proven refused. A content mismatch is proven to open an `exercise_catalog` divergence. A test that only shows a fresh mirror is served does not discharge this. |
| P7c | **Least privilege is proven, not claimed.** `atlas_app` is refused a DDL statement and refused a `DELETE` on a table outside its grant list (§8.2). |
| P8 | The `write_receipts` state machine is proven on all four transitions of §3.6, including that a **`failed` attempt does not consume the `write_id`** and that a superseded attempt's late `completeWrite` is discarded. |
| P9 | Every drift and authority guard passes. `npm test`, the Playwright suite, lint, syntax, and the secret scan pass. |

### 6.2 Gate for `S3` (backfill, parity and readiness — no cutover)

| # | Requirement |
|---|---|
| P1 | Deterministic tests for every read path the `S4` cutover will move. |
| P2 | Integration tests against a real disposable Supabase database. |
| P3 | **Backfill reconciliation.** For each of the four tabs: equal row counts; every row matched by its export identity key; and a field-by-field comparison reporting zero differences after the §4.7 blank/null rule is applied. A count match alone is not reconciliation — identity and content must both be proven. The reconciliation report is committed as evidence, with workout values redacted. |
| P4 | **No in-request Sheets read on the migrated Save path, plus a measured and bounded background dependency.** *Renamed from "No athlete-facing dependency on the Sheets quota" after the owner review of `2ce7be3`: a session replay can prove zero in-request reads, and it cannot prove that Save availability is independent of the Sheets quota over the mirror-age window.* Two parts, both required. **(a)** Measured, not asserted: replay `test/fixtures/liveSessionManifest.json` against the prospective read path and record the residual in-request Sheets read count per range. Expected zero on the migrated Save path; the measurement is the proof. **(b)** State and gate the background dependency the catalog mirror introduces: the sync interval, `CATALOG_MIRROR_MAX_AGE`, the fail-closed behaviour past that age, and the exact residual — how long a total Sheets outage may last before a Save fails. **Do not certify unqualified quota independence.** |
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
| P14 | **The export is durable AND idempotent.** Kill the process **after the Sheets `values.update` and before the Supabase acknowledgement**; restart; and prove the mirror contains **exactly one copy, by identity and by content** — not merely that an export eventually occurred. |
| P14a | **The mirror write is idempotent under a late external write**, proven on the race no lock can prevent: **drop worker A's Postgres connection while its Sheets `values.update` is in flight**, let B acquire the lock and complete the export, then **let A's original request commit late**. Exactly one mirror identity must result. Two further cases: a slow or timed-out write whose outcome is ambiguous, and a replacement worker after a real death. A test that only proves a live lock blocks a simultaneous claim does **not** discharge P14a — the lock is not the mechanism under test; the deterministic destination is. |
| P14b | **The allocation is stable, single-valued, and collision-free across different sessions.** (a) Two workers exporting the **same** session read the same allocation, and a re-export never reallocates. (b) **Two different sessions allocating concurrently receive disjoint ranges** — the case a per-session column could not serialise. (c) A failed allocation **reserves nothing**: it cannot leave one tab reserved and another not. (d) The exclusion constraint is proven to reject a deliberately overlapping insert. |
| P14c | **Verification spans the whole tab.** Seed one duplicate identity **outside** the allocated range and prove acknowledgement is **refused** and the defect surfaced as a divergence. A verifier that reads only its own block cannot pass this. |
| P15 | **The open-divergence count is zero** and every `atlas.migration_divergences` row is `closed`. If not, `S4` does not merge. |
| P16 | **No caller of the file-backed idempotency store remains**, proven by search, and the store, its env var, and its file are absent. |
| P17 | The deletion list of §5.4 is verified absent, including the dropped `atlas.migration_divergences` table. |
| P18 | A second non-counting deployed debug workout, after the cutover. |
| P19 | **The handover protocol of §5.5 is executed and its failure case exercised.** An old-authority write attempting to complete after the cutover boundary is **refused or detected before writes reopen**. Separately: the freeze is proven to fail closed with an explicit refusal rather than a silent drop; the drain is proven by positive assertion (zero `in_progress` receipts, zero in-flight migrated writes) rather than by an elapsed timer; and the per-tab base is proven to be recorded only after the drain passed. |
| P20 | **The `write_id` foreign keys validate on the real pre-cutover data**, because `S2`/`S3` stored null throughout (§3.6). Proven by adding the constraint against a database carrying genuine shadow rows, not an empty one. |

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

### 8.1 The access model — direct Postgres with scoped roles

**Correction, from the owner review of `5f42d3c`.** An earlier version of this section
specified a single service-role key **and** separate least-privilege roles **and** `DELETE`
on `logged_sets` only — while §3.7 required a transactional catalog swap that needs `DELETE`
on the mirror. Those cannot all be true at once. One service-role key does not authenticate
as three distinct database roles, and the stated grants could not perform the described
operations. The model below is the one executable choice, and the grants match what the
design actually does.

**Atlas connects to Supabase as Postgres, over a direct connection, with explicit scoped
database roles. It does not use the Supabase Data API, the service-role key, or the anon
key.**

Why this and not the Data API:

- The design needs **multi-statement transactions** (the Save, the seal, the catalog swap).
- It needs **session-level advisory locks** to serialise export workers (§5.4) — for
  throughput, not for correctness. The Data API has no equivalent.
- It needs **real role separation**. A service-role key is one identity that bypasses RLS;
  it cannot express "this connection may not run DDL".

Consequences, stated plainly:

- **There is no service-role key and no anon key in the runtime path**, so the entire class
  of key-leak and RLS-bypass exposure that comes with them does not arise here.
- Credentials are Postgres connection strings, one per role, read from environment variables
  on the server only.
- The connection is held by one module — the adapter of §5.2 — exactly as the read-write
  Sheets client is held only by `sheets.js`.
- **No Supabase credential of any kind appears in browser code.** `src/app/` never imports a
  Supabase client, never receives a connection string, and never contacts Supabase directly.
  The browser keeps talking to the Express API.

### 8.2 Least privilege — three roles, and the exact grants

Three distinct database roles, each with its own credential.

**`atlas_app`** — the runtime role, used by the Express server.

| Grant | Objects |
|---|---|
| `SELECT` | every table in `atlas` |
| `INSERT` | every table in `atlas` |
| `UPDATE` (column-scoped) | `closeout_write_id` on `session_plan_set_recommendations`; `status`, `attempt`, `attempt_token`, `attempt_started_at`, `response_body`, `rows_written`, `appended_range`, `completed_at` on `write_receipts`; `sheets_exported_at`, `sheets_export_attempts`, `sheets_export_error`, `export_claim_token` on `workout_sessions`; `next_row`, `base_established_at` on `sheets_mirror_cursor`; `status`, `verified_at`, `last_error` on `exercise_catalog_sync`; the state columns on `migration_divergences` while it exists |
| `DELETE` | `logged_sets` (undo), `exercise_catalog_mirror` (the §3.7 generation swap), and `migration_divergences` while it exists. **Never on a Sheets tab** — the export does not delete mirror rows to correct itself (§5.4). |
| `EXECUTE` | `pg_try_advisory_lock` / `pg_advisory_unlock` (available to any role; named here because the export depends on it) |

It holds **no** `DROP`, `ALTER`, `TRUNCATE`, or other DDL grant. The catalog swap uses
`DELETE` inside a transaction rather than `TRUNCATE` precisely so the runtime role needs no
DDL privilege.

**`atlas_migrate`** — DDL only. Used by migration runs in CI and by the owner-run
application to `Atlas Production`. Never used by the server at runtime.

**`atlas_readonly`** — `SELECT` only, on every table in `atlas`. Used by
`npm run atlas:status` and `npm run atlas:review-live`, mirroring the existing rule that
read-only tools build their own `spreadsheets.readonly` client.

**Least privilege is claimed only where the grants above produce it.** `S2` must prove it:
a test asserts `atlas_app` is refused a DDL statement and is refused a `DELETE` on a table
not in its list. An unproven grant list is a claim, not a control.

### 8.3 Row Level Security — no claim without configuration

**Atlas makes no Row Level Security claim.** Atlas is single-owner during V1 and the browser
is not a Supabase client, so RLS is not the control that protects this data. The controls
are the ones §8.1 and §8.2 actually specify: the connection credentials never leave the
server, and the runtime role's grants are scoped and proven (P7c). RLS is a control for
untrusted clients holding their own credentials, which is a situation this design does not
create. It may be enabled later. Until it is configured **and** a test proves a denied read,
no document, PR body, or merge card may state that Atlas has RLS. A claimed-but-unconfigured
RLS policy is a false security claim.

### 8.4 Secret scanning, backups, restore

- `npm run scan:secrets` gains the Supabase patterns in `S2`, before any credential is
  configured. **Postgres connection strings and role passwords are the credentials that
  matter under §8.1**; service-role JWTs and anon keys are also matched, so a later
  reintroduction of the Data API cannot slip a key past the scanner. A project reference is
  treated as a secret too. The existing rule holds: no secret, `.env`, production id, or
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
| **Net complexity after migration** | Expected **negative**. Removed: the per-request `batchGet` read context, the route range declarations, the 30-second row cache, the session read-budget harness and its fixture, the reconstruction script, the read-budget document, the verify-range route and its client fallback, and the file-backed idempotency store. Added: ten permanent tables, one adapter module, the `Exercise_Catalog` sync, and the asynchronous export worker. The eleventh table and the whole bridge are temporary and are dropped. This expectation is **not yet measured**; `S4` must report the actual net line and module change. |

### Owner rulings — D1 through D5, all resolved

The owner review of `b38de8b` resolved every open decision. They are recorded here as
rulings, not as questions.

**D1 — `Exercise_Catalog` mirror: RESOLVED, build it.** Add the read-only mirror
(§3.7) needed to remove the last **in-request** Sheets read from the migrated Save path. It
bounds rather than eliminates the background dependency, in the wording P4 adopts. Sheets remains its
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
