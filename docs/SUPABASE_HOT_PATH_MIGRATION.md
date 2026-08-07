# Supabase Hot-Path Migration — Design

> **Status:** design specification. **Current as of:** 2026-08-07.
> **Authority:** the owner instruction of 2026-08-07, recorded in
> [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md) under
> "OWNER INSTRUCTION 2026-08-07 — SUPABASE HOT-PATH MIGRATION".
> That plan block is the work-selection authority. This document selects no work.
> It defines the schema, the mapping, the closure chain, the proof, the rollback rules,
> the security posture, and the data-ownership record for that instruction.

**Nothing in this document is applied.** No Supabase code, dependency, migration file, or
adapter exists in this repository. No schema is applied. No product behaviour changes.
`PR S1` is paper only.

**Observed fact, recorded rather than assumed.** A Supabase GitHub integration is installed
on this repository: it reports a `Supabase Preview` check on a pull request, and that check
names a project. This document does **not** claim to know whether that project is
provisioned, empty, owner-created, or unrelated to this migration. Establishing its state,
and deciding whether the migration uses it, is part of owner-reserved gate D3 (§9) and is
not established here. The project reference is not transcribed into this repository, for the
reason given in §8.4.

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

### 1.2 What does not migrate

These stay in Google Sheets and are **out of scope**. They are named so the scope boundary
is explicit, not so a later PR builds them:

- `Exercise_Catalog` — reference data. See **Owner decision D1**; it is the one out-of-scope
  read that blocks proof criterion P4.
- `Constraints`, `Deload_State`, `Coaching_Notes` — read by the recommendation and coach lanes.
- `Modality_Log`, `Bodyweight`, `Bug_Reports`.
- Telemetry tabs: `Flight_Recorder`, `Brain_Shadow`, `Intent_Shadow`, `Coach_Shadow`, `Coach_Response`.
- Derived read surfaces: `Metadata`, `Logic`, `Session_Summary`, `Dashboard`.

No new table is proposed for any of them.

### 1.3 What Google Sheets becomes

For the seven migrated concepts, and for those only:

- a human-readable export and mirror;
- never required for an active workout to read, save, verify, or close out.

For every other tab, Sheets remains exactly what it is today.

---

## 2. Architecture ruling

**Classification: authority defect.** Two stores would decide where a logged set lives.
The standing rule in `CLAUDE.md` applies — select one winner, remove the loser, and add
no permanent reconciliation logic between them.

- **Current live authority.** Google Sheets, through `sheets.js`, for all seven concepts.
- **Intended sole authority.** Supabase, for all seven concepts.
- **Competing authority to remove.** The direct Google Sheets runtime reads and writes for
  the seven concepts, and the machinery built to keep them inside the read quota.
- **Temporary bridge.** A bounded shadow/dual-write comparison, live in `PR S2` and `PR S3`
  only. The athlete-facing write succeeds or fails from the **current authority alone**.
  The shadow write never changes a response, a status code, or a visible claim. Atlas never
  reconciles two authorities silently.
- **Exact sunset.** `PR S4` deletes the bridge. Section 8 lists every artifact it deletes.

**The engine/LLM boundary is unchanged.** The store changes; nothing about who decides a
number changes. `preview → approve → write` is unchanged, `test_mode` absent still means a
live write, and the W1–W3 proof fields are unchanged.

---

## 3. Minimum Supabase schema

Six tables. Each names its immediate production consumer. There is no generic persistence
framework, no repository abstraction, and no table without a consumer in this chain.

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

Holds session identity and its allocation. Nothing else.

| Column | Type | Notes |
|---|---|---|
| `session_id` | `text` | **PK**. The existing id contract. |
| `session_date` | `date` | The athlete's local date. |
| `period` | `text` | `AM` or `PM`. `CHECK (period IN ('AM','PM'))`. |
| `slot` | `smallint` | `CHECK (slot BETWEEN 1 AND 99)`. |
| `created_at` | `timestamptz` | |

- **Unique:** `(session_date, period, slot)`.
- **Index:** the PK, plus `(session_date DESC)`.
- **Mutability:** insert-only. No column is ever updated.
- **Transaction boundary:** one statement.
  `INSERT … ON CONFLICT DO NOTHING RETURNING session_id`, retried on the next free slot.
  Slot exhaustion at 99 still fails closed with `SESSION_SLOTS_EXHAUSTED`.
- **Immediate production consumer:** `nextAvailableSessionId` (`services/sessionId.js`) as
  called by `POST /api/session-plans/accept`, `POST /api/log-workout`, and
  `POST /api/complete-workout`.
- **Why it exists:** allocation is today a read of the durable union of three tabs, followed
  by an in-process scan for a free slot. Two concurrent allocations can therefore pick the
  same id. The unique constraint makes the same allocation one atomic insert.

**Ruling — this table does NOT hold closeout.** The session-level closeout authority is the
`session_closeout` row in `atlas.session_plan_events` (§3.4). Its `event_type`, `outcome`,
and `closeout_status` vocabularies are owner-frozen (Decision Desk #952). Adding a closeout
column here would create a second closeout authority, which is the defect this migration
exists to remove.

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
  becomes structural.
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

- **Unique (idempotency):** the primary key. One Effort row per session is the existing
  duplicate-session guard, which today costs a read of `Effort!B:B` on every Save.
- **Mutability:** insert-only.
- **Transaction boundary:** the same transaction as its Save's `logged_sets` rows.
- **Immediate production consumer:** `POST /api/complete-workout`, `POST /api/log-workout`
  when an effort row is supplied, `GET /api/summary/weekly`, `GET /api/history/recent`.

### 3.4 `atlas.session_plan_events`

Replaces `Session_Plans`. Append-only event log. Concepts 4, 6, and the session-level half
of 7.

| Column | Type | Notes |
|---|---|---|
| `idempotency_key` | `text` | **PK**. The existing 16-hex sha256 prefix from `services/sessionPlanEvents.js`. Unchanged. |
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
  (`services/sessionPlanReader.js`, last-wins).
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
| `idempotency_key` | `text` | **PK**. The existing 16-hex sha256 prefix from `services/sessionPlanLedger.js`. Unchanged. |
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
| `closeout_write_id` | `text` | Nullable. **The only mutable column in the migrated schema.** |
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

Replaces the idempotency store in `services/idempotency.js`. Concept 7's receipt half.

| Column | Type | Notes |
|---|---|---|
| `write_id` | `text` | **PK**. Supplied by the client, as today. |
| `route` | `text` | `/api/log-workout`, `/api/complete-workout`, `/api/log-workout/undo-last`. |
| `session_id` | `text` | Nullable — a claim is made before the id is known on some paths. |
| `status` | `text` | `CHECK (status IN ('in_progress','completed','failed'))`. |
| `response_body` | `jsonb` | The exact body replayed to a duplicate retry. |
| `rows_written` | `integer` | |
| `appended_range` | `text` | Kept while the Sheets mirror exists; null afterwards. |
| `created_at` | `timestamptz` | |
| `completed_at` | `timestamptz` | Nullable. |

- **Mutability:** one insert and one update. `in_progress` moves to `completed` or `failed`
  exactly once.
- **Transaction boundary:** the claim is
  `INSERT … ON CONFLICT (write_id) DO NOTHING RETURNING write_id`. Zero rows returned means
  the id is already claimed, which is the duplicate branch.
- **Observed fact, and the defect this closes.** The current store is a JSON file at
  `/tmp/atlas-idempotency.json` (`services/idempotency.js:18`). A Render container
  replacement loses it, so the duplicate-write shield does not survive one. The 5-minute
  `STALE_IN_PROGRESS_MS` window exists to make an abandoned record retryable after a crash.
  Moving the store to Supabase makes the shield durable. The stale-record rule stays: a
  process can still die mid-write.
- **Immediate production consumer:** `beginWrite`, `completeWrite`, `failWrite` in
  `services/idempotency.js`, called from `POST /api/log-workout`,
  `POST /api/complete-workout`, and `POST /api/log-workout/undo-last`.

**Not migrated with it.** `services/appendWriteProof.js` stays pure and unchanged in `S2`
and `S3` — it adjudicates the Google `updates` envelope. At `S4` the Supabase equivalent of
a receipt is the transaction's own returned row count and returned rows, which is stronger:
it is produced by the write, and it re-observes the committed rows in the same transaction.
`S4` replaces the adjudicator's input, not the trust contract it implements.

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

### 4.5 Idempotency store → `atlas.write_receipts`

The current store is a JSON map, not a Sheet tab, so this is a record-by-record mapping.

| Current field (`services/idempotency.js`) | Supabase column |
|---|---|
| map key | `write_id` |
| `status` | `status` |
| `response`/replayed body | `response_body` |
| `created_at_ms` | `created_at` |
| `completed_at` | `completed_at` |
| *(not stored today)* | `route`, `session_id`, `rows_written`, `appended_range` |

### 4.6 The blank-versus-null rule

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

- Record the owner instruction in `docs/ATLAS_V1_EXECUTION_PLAN.md`.
- Correct every document that states Sheets is permanently the only V1 store.
- Record the authority move in `docs/ATLAS_SYSTEM_AUTHORITY.md`.
- Publish this design document.
- **Must not:** create a Supabase project, add a dependency, add a migration file, add an
  adapter, change product behaviour, or deploy.
- **Closes:** the paper conflict between the owner instruction and the governing documents.
- **Opens:** the three implementation loops below, each with a named consumer and a sunset
  condition.

### 5.2 PR S2 — migrations, adapter, shadow write

- Add the repository migration files for the six tables of §3, as plain SQL under
  `supabase/migrations/`. The files are checked in and applied to a **disposable**
  database in CI only. Applying them to a live project is owner-reserved.
- Add one Supabase adapter module. It is the only module that holds a Supabase client, in
  the same way `sheets.js` is the only module that holds a read-write Sheets client. It
  exposes the operations §3 names and nothing else. **No generic repository layer, no ORM,
  no query builder abstraction.**
- Wire the shadow write. After a successful athlete-facing write to Sheets, the same
  payload is written to Supabase, and the two are compared.
- **Sheets remains the live authority for every read and every write.** The shadow write
  runs after the response has been decided. It never changes a response, a status code, a
  proof field, or a visible claim. A shadow failure is logged and is never surfaced to the
  athlete.
- **Must not:** move any read, change any response, or deploy a cutover.
- **Immediate consumer of the adapter:** the shadow-write call sites in `index.js` and
  `routes/sessionPlans.js`. The adapter has a consumer in the PR that adds it.
- **Bridge introduced:** the shadow write and its comparison. **Sunset:** deleted in `S4`.

### 5.3 PR S3 — move active-workout reads to Supabase

- Backfill the six tables from the current workbook. The backfill is a one-way script that
  is run once per environment and is deleted in `S4`.
- Prove reconciliation (§6.3).
- Move the active-workout **reads** for the seven concepts to Supabase.
- Sheets remains a mirror. A Sheets **read** fallback is added only if the owner explicitly
  approves it; the default design has no read fallback, because a fallback is a second read
  authority and reintroduces exactly the quota dependency this migration removes.
- **Must not:** move the approved-write authority. Writes still land in Sheets first.
- **Blocked on:** Owner decision D2 (§9), the Constitution amendment.
- **Bridge introduced:** none new. The `S2` shadow write continues.

### 5.4 PR S4 — Supabase becomes the write authority, then delete

1. Make Supabase the approved-write authority. `preview → approve → write` is unchanged;
   the write lands in a Supabase transaction.
2. Export a completed session to Google Sheets **asynchronously**, after closeout. The
   export writes the same columns in the same owner-approved order. An export failure never
   fails a workout and never changes a visible claim; it is retried and reported by
   `npm run atlas:status`.
3. Delete, in the same PR:
   - the Sheets hot-path reads for the seven concepts;
   - the shadow write and its comparison;
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
   - the file-backed idempotency store and `ATLAS_IDEMPOTENCY_FILE`.
4. Verify the deleted machinery is genuinely absent, and record the count.

**Anything in that list which cannot be deleted at `S4` is an open loop.** It must then
carry a named consumer and an exact sunset condition, or `S4` is not complete.

---

## 6. Exact proof required before each cutover

A proof is level-correct. A unit test proves local logic. An integration test proves
wiring. A browser or full-session test proves the product path. Owner evidence proves owner
operation. No lower rung substitutes for a higher one.

### 6.1 Gate for `S2` (merge the shadow write)

| # | Requirement |
|---|---|
| P1 | Deterministic tests: every constraint of §3 is proven by a test that inserts a violating row and asserts the insert is rejected. A constraint with no violation test does not count as proven. |
| P2 | Integration tests against a **real disposable Supabase/Postgres database**, created and destroyed per CI run. A fake, an in-memory stub, or a mocked client does not satisfy this. |
| P3 | The shadow write is proven inert: a browser-level test shows the athlete-facing response is byte-identical with the shadow write enabled and disabled. |
| P4 | A shadow write that throws is proven not to fail a Save. |
| P5 | Every drift and authority guard passes. `npm test`, the Playwright suite, lint, syntax, and the secret scan pass. |

### 6.2 Gate for `S3` (move the reads)

| # | Requirement |
|---|---|
| P1 | Deterministic tests for every read path moved. |
| P2 | Integration tests against a real disposable Supabase database. |
| P3 | **Backfill reconciliation.** For each of the four tabs: equal row counts; every row matched by its identity key; and a field-by-field comparison reporting zero differences after the §4.6 blank/null rule is applied. A count match alone is not reconciliation — identity and content must both be proven. The reconciliation report is committed as evidence, with workout values redacted. |
| P4 | **No athlete-facing dependency on the Sheets quota** for the seven concepts. Measured, not asserted: replay `test/fixtures/liveSessionManifest.json` against the new read path and record the residual Sheets read count per range. The claim is bounded by Owner decision D1 (§9) and must be stated with its exact residual, never as "zero" while a residual exists. |
| P5 | **One non-counting deployed debug workout.** Run against the deployment, explicitly marked non-counting. It does not advance the rehearsal streak, Stage A, or Stage B. |
| P6 | `preview → approve → write` preserved. Proven by the existing trust-loop and browser tests, unchanged. |
| P7 | **Idempotent repeated approval.** A repeated approval writes zero additional rows. Proven at the database, by row count and by identity. |
| P8 | **Exact set, plan, ledger and closeout evidence.** The debug workout's rows are compared against a declared expectation written **before** the run: exact sets, exact plan events, exact ledger rows, exact seal, exact closeout status. A "rows appeared" standard does not qualify. |
| P9 | The shadow comparison from `S2` reports zero divergences across the debug workout. |

### 6.3 Gate for `S4` (move the write authority)

Everything in §6.2, re-run after the cutover, plus:

| # | Requirement |
|---|---|
| P10 | A write failure is proven atomic: no partial session is left behind. |
| P11 | Undo is proven exact: `DELETE` by `(session_id, write_id)` removes exactly the rows of that Save and nothing else, and the fail-closed contract of `services/closeoutFinality.js` still refuses an undo of a finalized session. |
| P12 | The asynchronous Sheets export is proven to produce the same columns in the same owner-approved order, and proven not to fail a workout when it fails. |
| P13 | The deletion list of §5.4 is verified absent. |
| P14 | A second non-counting deployed debug workout, after the cutover. |

---

## 7. Failure and rollback rules

### 7.1 Standing rules

1. **The athlete-facing write succeeds or fails from the current authority only.**
   In `S2` and `S3` that is Google Sheets. After `S4` it is Supabase.
2. **Atlas never reconciles two authorities silently.** A divergence is reported. It is
   never averaged, merged, or preferred by recency.
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
| `S3` | Revert the PR. Reads return to Sheets. | None for durable data — no write moved. A read cutover cannot lose a row. |
| `S4` | Revert the PR **and** re-import any session written to Supabase after the cutover into Sheets, using the same export as §5.4. | Real. This is the only irreversible step, and it is why `S4` needs an owner gate and a verified backup. |

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

- The application connects with one role that holds `SELECT`, `INSERT`, and the single
  permitted `UPDATE` on `atlas.session_plan_set_recommendations.closeout_write_id` and on
  `atlas.write_receipts.status`/`completed_at`.
- It holds `DELETE` on `atlas.logged_sets` only, for undo. It holds `DELETE` on nothing else.
- It holds no `DROP`, no `ALTER`, and no schema-modification grant. Migrations run under a
  separate migration role.
- Read-only tooling (`npm run atlas:status`, `npm run atlas:review-live`) connects with a
  distinct read-only role, mirroring the existing rule that read-only tools build their own
  `spreadsheets.readonly` client.

### 8.3 Row Level Security — no claim without configuration

**Atlas makes no Row Level Security claim in `S1`.** Atlas is single-owner during V1 and the
browser is not a Supabase client, so RLS is not the control that protects this data — the
service-role key's confinement to the server is. RLS may be enabled later. Until it is
configured **and** a test proves a denied read, no document, PR body, or merge card may
state that Atlas has RLS. A claimed-but-unconfigured RLS policy is a false security claim.

### 8.4 Secret scanning, backups, restore

- `npm run scan:secrets` gains the Supabase key patterns in `S2`, before the first key
  exists. A connection string, a service-role JWT, and a project reference are all treated
  as secrets. The existing rule holds: no secret, `.env`, production id, or private workout
  data in a commit or a PR.
- The project reference and the database URL are treated exactly as the production Sheet ID
  is treated — never committed, never in a PR body, never in an evidence file.
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
| **Current winner** | Google Sheets, through `sheets.js`, for all seven concepts. |
| **Intended winner** | Supabase, for all seven concepts. Sheets becomes an export mirror. |
| **Bridge** | The bounded shadow write and comparison of `S2`. Live in `S2` and `S3` only. |
| **Exact sunset** | `PR S4` deletes the bridge, the Sheets hot-path reads, the read-budget machinery, and the file-backed idempotency store, and verifies their absence. |
| **Code and tests deleted at closure** | The list in §5.4 step 3. |
| **Net complexity after migration** | Expected **negative**. Removed: the per-request `batchGet` read context, the route range declarations, the 30-second row cache, the session read-budget harness and its fixture, the reconstruction script, the read-budget document, the verify-range route and its client fallback, and the file-backed idempotency store. Added: six tables, one adapter module, and the asynchronous export. This expectation is **not yet measured**; `S4` must report the actual net line and module change. |

### Open decisions requiring the owner

**D1 — `Exercise_Catalog` is a blocking Sheets dependency of the Save path.**

- *Observed fact.* `getExerciseCatalog()` enriches every logged row to
  `canonical_exercise`, `muscle_group`, and `lift_code`. It is cached across requests for
  60 seconds in `sheets.js`, with **no stale-after-expiry fallback**: a failed refresh
  throws.
- *Supported conclusion.* While the catalog is read from Sheets, a Sheets quota error can
  still fail a Save. Proof criterion P4 of §6.2 — "no athlete-facing dependency on Sheets
  quota" — therefore cannot be met as an unqualified claim.
- *Proposed action, needing the owner.* Either (a) add one read-only mirror table for the
  catalog, synchronised from Sheets, which keeps Sheets as the editing surface and makes the
  Save path quota-independent; or (b) accept a stated, bounded residual dependency and
  reword P4 to name it exactly.
- *Recommendation.* (a). It is one small table of reference data and it is the only way P4
  becomes a true statement. It is **not** included in §3 because it is outside the seven
  concepts the owner enumerated, and this document does not widen its own scope.

**D2 — `docs/CONSTITUTION.md` must be amended before `S3`.**

- *Observed fact.* `docs/CONSTITUTION.md:55` reads: "Google Sheets is the permanent record.
  The app reads from it and writes to it. There is no secondary database. If Sheets and the
  app disagree, Sheets wins." Line 14 makes the same claim.
- *Supported conclusion.* `S3` makes "the app reads from it" false, and `S4` makes "Sheets
  wins" false.
- *Constraint.* A Constitution amendment is owner-reserved (`CLAUDE.md`, "Owner-reserved
  stops", item 5). No agent may make it.
- *Proposed action.* Dale dictates the amended text. It merges before `S3`. This document
  proposes no wording.

**D3 — Provisioning the Supabase project, and applying any schema, is owner-reserved.**

Both are schema and credentials work. `S2` checks migration files into the repository and
applies them to a disposable CI database only.

*Observed fact.* A Supabase GitHub integration is already installed on this repository and
reports a `Supabase Preview` check naming a project. *Not established.* Whether that project
exists in a usable state, who created it, what it contains, and whether this migration should
use it or a new one. *Proposed action.* Dale states which project the migration uses, or
directs that a new one is created. No agent provisions, inspects, or connects to either.

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
| `docs/CONSTITUTION.md:14`, `:55` | "one spreadsheet as the permanent record"; "There is no secondary database" | **Owner decision D2**, before `S3` |
| `docs/ATLAS_OPERATIONS_CONTRACT.md:103` | "There is no new database, no Supabase" | `S2` — the sentence scopes the status surface; it becomes false when the adapter lands |
| `docs/READ_BUDGET.md` | The whole document | `S4` — deleted |
| `docs/SHEET_CONTRACT.md`, `.claude/rules/sheet-schemas.md` | Sheet layouts for the four migrated tabs | `S4` — restated as the export contract, not the runtime contract |
| `docs/ATLAS_SYSTEM_AUTHORITY.md` concepts 11, 11b, 12 | Sheets as durable-write authority | `S3` and `S4`, as authority actually moves |

---

## 11. What this document does not claim

- It does not claim any Supabase table exists, and it does not claim to know the state of the
  project the repository's `Supabase Preview` check names.
- It does not claim a measurement. The net-complexity expectation in §9 and the residual
  read count in §6.2 P4 are both unmeasured, and both are marked as such.
- It does not authorize creating a Supabase project, applying a schema, or deploying.
- It does not amend the Constitution, and it proposes no amended wording.
- It does not claim Row Level Security is configured.
- It is not a roadmap, a campaign, or a second execution plan. The execution plan's
  2026-08-07 owner-instruction block is the sole work-selection authority for this chain.
