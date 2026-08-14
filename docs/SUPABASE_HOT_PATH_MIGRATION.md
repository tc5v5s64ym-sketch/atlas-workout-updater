# Supabase Hot-Path Migration — Design

> **Status:** design specification. **Current as of:** 2026-08-07.
> **Authority:** the owner instruction of 2026-08-07 and the Atlas Contract / Systems Review
> of `b38de8b8e7da55f4e28b1c71ebe1bae97b5ca710`, both recorded in
> [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md).
> That plan block is the work-selection authority. This document selects no work.
> It defines the schema, the mapping, the closure chain, the proof, the rollback rules,
> the security posture, and the data-ownership record.

> **OWNER CORRECTION 2026-08-13 — controlling S4 addendum.** Ruling D1 and every
> statement below that keeps Google Sheets as the editing authority for
> `Exercise_Catalog`, calls `atlas.exercise_catalog` a mirror, requires
> `atlas.exercise_catalog_sync`, or permits a catalog freshness clock is
> **superseded**. S4 has one catalog table, `atlas.exercise_catalog`, and Supabase is
> its sole authority. The runtime has `SELECT` only; the smallest owner-controlled
> mutation is `npm run atlas:catalog` under `atlas_migrate`. Coaching notes,
> constraints, deload state, and modality workouts also move because they are
> required workout inputs or workouts themselves. Accepted plan events and plan-set
> recommendations are authoritative and always persisted; their old optional-write
> flags do not survive S4. The controlling acceptance equation is: **all Google
> Sheets reads and writes return 429 + complete workout + five-session campaign =
> every workout still passes, with zero workout-critical synchronous Sheets calls.**
> Sheets export failure may create backlog only. The seven-day rollback window delays
> only the `atlas.migration_divergences` drop and does not delay testing.

**Status of application, current as of 2026-08-08.** `PR S1` was paper only and is merged.
**`PR S2` is MERGED** (`main` at `4d3e231`, PR #1274), so Supabase code, a dependency, the
migration files and the adapter EXIST in this repository. **The `S2` schema is now APPLIED to
`Atlas Production`, and the hosted P8b gate has PASSED.** **Nothing has migrated**, and the
distinction is the whole point of this phase:

- the **eleven `S2` tables** of §3.1–§3.9 are defined by the **eight reviewed migration files**
  in `supabase/migrations/` — eight files, eleven tables, and the two counts are never the same
  number — together with one
  adapter (`services/supabaseAdapter.js`), the shadow write, the divergence lane, the
  reconciliation sweep, the repair worker and the `Exercise_Catalog` mirror;
- **the schema IS applied to `Atlas Production`, by owner action, out of band, on 2026-08-08.**
  The owner applied the eight reviewed migration files unmodified, local and remote migration
  history matched, and the hosted checkpoint of §6.1 P8b then **PASSED with exit code `0`**
  (§8.6 records the runbook and its outcome). A migration file in a repository was never an
  applied schema; applying it was an owner action, and **no repository code path can APPLY
  SCHEMA to a hosted host**: the applier refuses every `*.supabase.co` / `*.supabase.com`
  endpoint outright, including every Supavisor pooler host, and no flag lifts it
  (`scripts/apply-supabase-migrations.js`, proven by `npm run check:supabase-safety`). That
  guard is unchanged and still holds — the owner applied the schema through an owner-side path,
  not through this repository;
- **no schema is applied to any OTHER persistent or hosted Atlas target.** The only other place
  these migrations are applied is the **disposable proof database** of §6.1 P2 — a plain
  Postgres container created from empty and destroyed with each run, which holds no Atlas data
  and outlives nothing;
- **no deployed path reaches `Atlas Production` today.** Since `S2`,
  `services/supabaseAdapter.js` builds `pg.Pool` instances from the four `ATLAS_SUPABASE_*_URL`
  role strings and will connect to whatever host it is given — by design, because that is
  exactly what `S4` requires. What keeps every path away from the hosted target is
  **configuration, not capability**: no live Atlas environment has any Supabase connection
  string set. Applying the schema did not change that, and no Render or runtime Supabase
  credential was configured at the gate;
- **no product behaviour changed.** The shadow lane is off unless
  `ATLAS_SUPABASE_SHADOW_WRITE=1` **and** a connection string is configured, and neither is in
  any environment;
- Google Sheets remains the sole live read and write authority for every migrated concept, and
  no athlete-facing read or write has moved.

**`atlas.write_freeze` (§3.10) does not exist in `Atlas Production`**, and the P8b checkpoint
confirmed its absence there. That statement is about the DEPLOYMENT, and it is still true.

**It is not true of the repository, and this block used to conflate the two.** *Corrected by the
required review of `a29129e`, which found these lines still calling `S3` "paper" and "not
started" from a branch that implements it; corrected again on 2026-08-11, when PR #1281 merged
and "NOT MERGED" became the stale half.* The honest split is **repository versus production**:

| | State |
|---|---|
| `S3` implementation | **MERGED** — PR #1281, merge commit `fbe205a` |
| `S3` on `main` | **LANDED** (2026-08-11) |
| The `S3` `write_freeze` migration on `Atlas Production` | **CURRENT: UNVERIFIED** — last verified 2026-08-08: **NOT APPLIED**; the owner gate (§6.2 P8b) is outstanding |
| `atlas.write_freeze` in `Atlas Production` | **CURRENT: UNVERIFIED** — last verified 2026-08-08: **ABSENT** |
| Runtime Supabase credential in any live environment | **CURRENT: UNVERIFIED** — last verified 2026-08-08: **NOT CONFIGURED** |
| Deployed `S3` evidence | **NONE**, and none may be claimed — no deployed evidence has ever been gathered, so this row has no last-verified value to go stale |
| Athlete-facing read or write authority moved | **NONE** — and `S3` moved none by merging (ruling D5) |
| Sole live authority | **Google Sheets + `services/idempotency.js`** |

**The three `UNVERIFIED` rows carry a last-verified value, not a current one**, and each cell
says so itself so the distinction survives being quoted apart from this paragraph. Those values
were observed at the P8b checkpoint of 2026-08-08, and **no inspection of `Atlas Production` has
been made since** — nothing here asserts what that deployment holds today. Each recorded value
under-claims, so a stale copy can only withhold deployed evidence, never manufacture it; but
under-claiming is not verification, and this table no longer presents it as one. The deployed-
evidence row is different in kind and is stated separately: it is **NONE** because none has ever
been gathered, which is a present fact rather than an ageing one. §6.2 P8b is discharged by a
real read-only inspection of `Atlas Production`, and by nothing else.

*What was actually observed, and its exact bound:* the local Claude environment inspected on
2026-08-11 held **no usable `ATLAS_SUPABASE_*` credential of any role**, so no such inspection
could be performed from it. That is a statement about one inspected environment. It is **not**
evidence about Render, about any other Atlas environment, or about any other agent surface, and
it must not be read as any of those.

`S4` remains paper, remains the authority-transfer point, and has not started. `S3` is now
merged, and nothing in this document may be read as claiming it is **deployed, applied to
production, or complete**. Merging it moved no read and no write.

*Corrected by the required review of `ad18907`, which found this document and the authority map
both describing `S2` as landed while its PR was still open. A branch does not record itself as
landed; these lines are updated after merge, from current `main`.*

**Revision, 2026-08-07.** The required review of `b38de8b` returned **BLOCKING** with four P1
architecture defects and five rulings. All are incorporated here. The four defects are named
where they are fixed — §3.8 (no divergence authority existed), §5.2 (`S2` could lose the
shadow write and the evidence of it), §5.4 (the export was durable but not idempotent), and
§3.6 (two incompatible rulings on the file-backed store). Decisions D1 through D5 are now
**resolved by owner ruling** and are recorded in §9 as rulings, not as open questions.

**The Supabase project exists, and now carries the `S2` schema.** The owner created and
selected the Free-tier project named **Atlas Production** in `us-west-2`. It was independently
verified healthy and empty — zero public tables, zero migrations — before the `S2` schema was
applied to it on 2026-08-08; it is no longer empty. The project reference and every credential
stay out of this repository (§8.4).

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

Two additions come from the required review, and neither widens the migrated **workout data**:

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

**A note on attribution.** Throughout this document, *"the required review of `<sha>`"* means
the **Atlas Contract / Systems Review** of that exact head. Under `CLAUDE.md` that lane is
**performed by ChatGPT**; Dale is the owner, the dispatching authority, and the holder of every
owner gate — he does not perform the required review. *Earlier versions of this document and of
the merge card called those reviews "owner reviews" and named Dale as the reviewer, which
misattributed the lane. Corrected by the required review of `310b01b`; no verdict, finding or
disposition was changed, only who performed the lane.* Owner **rulings**, **instructions** and
**gates** are Dale's and are still named as his.

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
  reconciliation sweep, and a repair path. All four **exist only through `PR S2` and `PR S3`;
  the runtime remains dormant until configured** — a lifecycle bound, not a runtime claim: no
  Supabase role connection string is set in any live Atlas environment, so none of the four
  runs today.
  The athlete-facing write succeeds or fails from the **current authority alone**. The
  shadow write never changes a response, a status code, or a visible claim. Atlas never
  reconciles two authorities silently.
- **Exact sunset.** `PR S4` deletes every **consumer and writer** of the bridge — the shadow
  write, the sweep, the repair worker — and verifies their absence. The divergence **table**
  outlives the merge by design, inert and unwritten, until the `S4` rollback window closes,
  because a restored `S3` build queries it (§5.5, gate P19i); the owner then runs the drop
  (§5.4). §5.4 lists every artifact. **The chain is not closed until BOTH closure steps land** —
  that owner-run drop, which converges `Atlas Production`, and the one bounded post-window
  cleanup PR approved by ruling **D8**, which adds the versioned drop migration so a fresh
  replay of `supabase/migrations/` converges too. *Corrected by the required review of
  `f641894`: this summary still named only step 1.*

**Reads and writes cut over together (ruling D5).** An earlier version of this design moved
reads at `S3` while writes stayed on Sheets until `S4`. That window let reads lead writes,
so a failed shadow write could serve a silently incomplete workout. The window is removed:
`S3` proves readiness and `S4` performs the whole cutover.

**The engine/LLM boundary is unchanged.** The store changes; nothing about who decides a
number changes. `preview → approve → write` is unchanged, `test_mode` absent still means a
live write, and the W1–W3 proof fields are unchanged.

---

## 3. Minimum Supabase schema

**Twelve tables: eleven permanent, one temporary.** Eleven are created by
`S2`; the twelfth, `atlas.write_freeze`, is created by `S3` because that is the PR that builds
the control it carries, and it is **permanent — owner ruling D7, APPROVED 2026-08-09**. Each names its immediate production consumer. There is no generic persistence
framework, no repository abstraction, and no table without a consumer in this chain.

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
| 3.8 | `atlas.migration_divergences` | **TEMPORARY** — `S4` removes every consumer and writer and leaves it inert; it is dropped after the `S4` rollback window (§5.4 step 5) |
| 3.9 | `atlas.sheets_mirror_cursor` + `atlas.sheets_mirror_allocations` | permanent — the export destination authority |
| 3.10 | `atlas.write_freeze` | **permanent, no sunset** (owner ruling D7, APPROVED 2026-08-09) — created by `S3`, not `S2` |

The catalog is two tables, not one: content and freshness are separate concerns, and the
required review of `5f42d3c` found that collapsing them left the mirror with no freshness
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
| `sheets_export_state` | `text` | `CHECK (… IN ('queued','retry_backoff','blocked'))`, default `'queued'`. **`blocked` means only the §5.7 owner rebuild can clear it**, and the session leaves the export queue entirely. |
| `sheets_export_next_attempt_at` | `timestamptz` | Nullable. The earliest a `retry_backoff` session may be claimed again. |
*(The export's destination is **not** stored here. It lives in `atlas.sheets_mirror_allocations` (§3.9), because a per-session column cannot serialise two different sessions competing for the same rows.)*

- **Unique:** `(session_date, period, slot)`.
- **Index:** the PK, plus `(session_date DESC)`, plus a partial index on
  `(session_id) WHERE sheets_exported_at IS NULL` — the export worker's queue scan.
- **Mutability:** insert-only for identity. Exactly **six** columns are updatable —
  `sheets_exported_at`, `sheets_export_attempts`, `sheets_export_error`,
  `sheets_export_state`, `sheets_export_next_attempt_at`, and `export_claim_token`. Three
  writers touch them, and the earlier text named only two: the `S4` export worker, the §5.7
  owner-only rebuild, **and the runtime itself** — an undo (§5.6) and a closeout-seal
  invalidation both clear `sheets_exported_at` and return the session to `queued`, which is what
  gates P14e and P14f prove. *Corrected by the advisory review of `ec53270`: a mutability rule
  that omits a live writer understates who can change export state.* They are unused before
  `S4`. The
  export **destination** is not among them: it lives in `atlas.sheets_mirror_allocations`
  (§3.9).
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
| `plan_version` | `text` | The accepted plan's OPAQUE identity token, preserved exactly. `CHECK (btrim(plan_version) <> '')`. See the note below. |
| `event_type` | `text` | `CHECK (event_type IN ('plan_accepted','item_outcome','session_closeout'))`. |
| `plan_item_id` | `text` | Empty string on a `session_closeout` row, as today. |
| `planned_order` | `integer` | |
| `planned_lift_code` | `text` | |
| `movement_pattern` | `text` | |
| `outcome` | `text` | `CHECK (outcome IN ('planned','completed','skipped','substituted',''))`. |
| `performed_lift_code` | `text` | |
| `closeout_status` | `text` | `CHECK (closeout_status IN ('finalized','abandoned',''))`. |
| `recorded_at` | `timestamptz` | |

- **`plan_version` is OPAQUE TEXT, and that is a corrected statement.** This table
  originally declared it `integer CHECK (plan_version >= 1)`, in
  `20260808000300_session_plans.sql`, which is applied to `Atlas Production`. The
  declaration was wrong for the concept. `Session_Plans.plan_version` is the accepted
  plan's identity token — a `pv_…` value the client mints and `routes/sessionPlans.js`
  validates against `/^pv_.+/` — and production forensics found **55 eligible historical
  plan events carrying such tokens**. No integer is derivable from one without inventing
  data. Owner ruling 2026-08-12 authorised the correction, and
  `20260812000100_plan_event_version_text.sql` is the forward migration that makes it:
  the integer-only constraint is dropped, the column becomes `text` through an explicit
  `USING plan_version::text` (so a replay database's historical integer rows become their
  exact text, `1` → `'1'`), and the one invariant that carries forward is presence. The
  database records no `pv_` prefix rule: it preserves the authoritative token and leaves
  the token's shape to the application that owns it. **`atlas.session_plan_set_recommendations.plan_version`
  is a DIFFERENT dimension and stays `integer` — see §3.5.** *Not yet applied to
  `Atlas Production`: applying it is owner gate 1 (§8.5), outstanding at the time of
  writing.*
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
| `plan_version` | `integer` | The set-revision counter. `CHECK (plan_version >= 1)`. See the note below. |
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

- **`plan_version` here is an INTEGER, and it must stay one.** It is the set-revision
  counter — 1 is the accepted plan, 2, 3, … are successive revisions — and the mechanism
  around it is arithmetic: `plan_version + 1`, the highest-version fold, and the ordering
  the adapter applies so a revision's `supersedes_key` resolves
  (`services/sessionPlanLedger.js`, `services/supabaseAdapter.js`). The `CHECK
  ((plan_version = 1) = (supersedes_key IS NULL))` below is arithmetic too. **It shares a
  name with `atlas.session_plan_events.plan_version` (§3.4) and nothing else: that one is
  an opaque text identity token.** The two columns are never equality-joined across the
  two tabs; the authoritative join is by `plan_item_id`.
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
| `route` | `text` | One of the seven routes below. **Written once at claim and never updated**, and the claim refuses any attempt to reuse this `write_id` on a different route — see "one write_id, one route" below. |
| `effect_authority` | `text` | `NOT NULL`, `CHECK (effect_authority IN ('supabase','sheets'))`. **Where this route's authoritative effect lands**, written once at claim from the adapter's frozen route map and never updated. The reclaim rule branches on it — see "effect-awareness" below. |
| `session_id` | `text` | Nullable — a claim is made before the id is known on some paths, and three routes have no session at all. |
| `status` | `text` | `CHECK (status IN ('in_progress','completed','failed','ambiguous'))`. |
| `attempt_token` | `uuid` | Nullable. The current attempt's token, regenerated on every new attempt. Null only where no Supabase attempt was ever claimed, where `failWrite` voided it, or where the row is `ambiguous`. |
| `attempt` | `integer` | `NOT NULL DEFAULT 1`. Increments on each retry of the same `write_id`. |
| `owner_instance_id` | `text` | **Which process owns the current attempt** — `host:pid:random`, minted once per process. **The liveness authority**, replacing a session-scoped advisory lock. Lifecycle below. |
| `response_body` | `jsonb` | The exact body replayed to a duplicate retry. |
| `rows_written` | `integer` | |
| `appended_range` | `text` | Kept while the Sheets mirror exists; null afterwards. |
| `created_at` | `timestamptz` | Immutable provenance — when the `write_id` was first seen. **Not** the TTL clock. |
| `expires_at` | `timestamptz` | **The TTL authority.** `attempt_started_at + 24 hours`, refreshed on every newly-owned attempt. Every read filters on it; the prune deletes on it. **An `ambiguous` row is exempt from both** — see below. |
| `attempt_started_at` | `timestamptz` | Start of the **current** attempt. The staleness clock reads this, not `created_at`. |
| `completed_at` | `timestamptz` | Nullable. |
| `ambiguous_at` | `timestamptz` | Nullable. When the effect became unresolved. Set once, **never cleared**, so "this row was ambiguous" survives its resolution. |
| `ambiguity_proof` | `text` | Nullable. The destination-side proof that resolved it — what was read, and what it showed — in the same athlete-safe form as `migration_divergences.closure_proof`. |

**Four structural constraints, because each unsound state is otherwise reachable by an
ordinary `UPDATE`:**

| Constraint | Rule | Why it cannot be left to the call site |
|---|---|---|
| `write_receipts_live_attempt_has_owner_check` | `status <> 'in_progress' OR owner_instance_id IS NOT NULL` | `owner_instance_id IS DISTINCT FROM $3` reads a **null owner as "some other process"**, so an unowned live attempt would be reclaimed on age alone — the exact time-based inference the column exists to remove. |
| `write_receipts_ambiguous_is_sheets_only_check` | `status <> 'ambiguous' OR (effect_authority = 'sheets' AND ambiguous_at IS NOT NULL)` | An atomic effect is present or absent, never maybe. Without this, `ambiguous` becomes a general-purpose stall for the migrated routes; and a row with no `ambiguous_at` is invisible to the operator queue. |
| `write_receipts_ambiguous_token_void_check` | `status <> 'ambiguous' OR attempt_token IS NULL` | Otherwise the very process whose effect is unverified could return and complete the receipt on the strength of it. |
| `write_receipts_ambiguity_needs_proof_check` | `ambiguous_at IS NULL OR status = 'ambiguous' OR (ambiguity_proof IS NOT NULL AND ambiguity_proof <> '')` | **Once ambiguous, only proof gets you out.** Every unsound release — waiting, pruning, a plain retry — is a status change with no proof attached, and each one is a duplicate append. |

**`owner_instance_id` lifecycle, stated because it is load-bearing safety state.**

| Event | Value |
|---|---|
| New claim, retry, or reclaim | The claiming process's id. Always written. |
| `in_progress` | **Never null** — enforced by the constraint above, not by adapter discipline. |
| `completed` / `failed` | Retained as provenance of the last attempt's owner. Never cleared; nothing reads it. |
| `ambiguous` | Retained, and it is **evidence**: it names the process whose external effect is unresolved. |
| `S4` carry (§5.5a) | The file store records no owner, so a carried record cannot supply one — and one may not be invented. The drain normalises every carried `in_progress` record to `failed` (§5.5 step 2 sub-step i) **before** the handover inserts it, so no carried row is ever `in_progress` and the not-null rule is satisfiable without fabricating a value. |

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
  -- $3 is the claiming process's owner_instance_id; $4 is the route's declared
  -- effect_authority. The caller also holds pg_try_advisory_lock(hashtext($1)),
  -- which serialises claimers INSIDE one process and is NOT a liveness authority.
  INSERT INTO atlas.write_receipts (write_id, route, effect_authority, status, attempt, attempt_token,
                                    owner_instance_id,
                                    created_at, attempt_started_at, expires_at)
  VALUES ($1, $2, $4, 'in_progress', 1, gen_random_uuid(), $3,
          now(), now(), now() + interval '24 hours')
  ON CONFLICT (write_id) DO UPDATE
     SET status             = 'in_progress',
         owner_instance_id  = $3,   -- the claimer now owns the attempt
         -- An EXPIRED row is a fresh logical record, exactly as the file store's
         -- prune-then-insert produces. A live retry continues the existing one.
         attempt            = CASE WHEN atlas.write_receipts.expires_at <= now()
                                   THEN 1 ELSE atlas.write_receipts.attempt + 1 END,
         created_at         = CASE WHEN atlas.write_receipts.expires_at <= now()
                                   THEN now() ELSE atlas.write_receipts.created_at END,
         attempt_token      = gen_random_uuid(),
         attempt_started_at = now(),
         expires_at         = now() + interval '24 hours',  -- every newly-owned attempt
         -- WRITE-2: a LIVE retry must still see the prior attempt's minted session_id.
         -- An EXPIRED reclaim is a new logical record and starts clean.
         session_id         = CASE WHEN atlas.write_receipts.expires_at <= now()
                                   THEN NULL ELSE atlas.write_receipts.session_id END,
         response_body      = NULL,
         rows_written       = NULL,
         appended_range     = NULL,
         completed_at       = NULL
   -- ONE write_id IS BOUND TO ONE ROUTE, FOR ITS WHOLE LIFE. Without this the
   -- three branches below would each let a foreign route inherit the stored
   -- effect_authority, because route and effect_authority are not in the SET list.
   WHERE atlas.write_receipts.route = $2
     AND atlas.write_receipts.effect_authority = $4
     AND (
         atlas.write_receipts.status = 'failed'   -- a DECLARED non-write; both authorities retry it
      -- Expired: reclaimable at any status EXCEPT 'ambiguous'. A 24-hour TTL is
      -- another timer, and a timer is exactly the inference being removed.
      OR (atlas.write_receipts.expires_at <= now()
          AND atlas.write_receipts.status <> 'ambiguous')
      OR (atlas.write_receipts.status = 'in_progress'
          -- EFFECT-AWARE. Only an atomic effect may be reclaimed on process death.
          AND atlas.write_receipts.effect_authority = 'supabase'
          -- The owning PROCESS is gone. Not "its database session dropped".
          AND atlas.write_receipts.owner_instance_id IS DISTINCT FROM $3
          AND atlas.write_receipts.attempt_started_at < now() - interval '5 minutes')
     )
  RETURNING attempt_token, attempt, session_id, owner_instance_id, effect_authority;
  ```

  **The `sheets` half has no reclaim branch at all**, by construction. When the claim
  refuses, the adapter runs a second compare-and-set on exactly the condition the claim
  cannot decide, and the row leaves the retryable world entirely:

  ```sql
  UPDATE atlas.write_receipts
     SET status = 'ambiguous', attempt_token = NULL, ambiguous_at = now()
   WHERE write_id = $1
     AND route = $3                -- route-bound for the same reason the claim is
     AND status = 'in_progress'
     AND effect_authority = 'sheets'
     AND owner_instance_id IS DISTINCT FROM $2
     AND attempt_started_at < now() - interval '5 minutes'
  RETURNING owner_instance_id, attempt, attempt_started_at;
  ```

  It records that **nobody knows**, and makes that ignorance durable and blocking. Being a
  compare-and-set it is safe to race and idempotent: two claimers produce one mark, and the
  loser reads it. The only exit takes a destination-side finding and its proof:

  ```sql
  UPDATE atlas.write_receipts
     SET status          = CASE WHEN $2::boolean THEN 'completed' ELSE 'failed' END,
         ambiguity_proof = $3::text,
         response_body   = CASE WHEN $2::boolean THEN $4::jsonb ELSE NULL END,
         completed_at    = CASE WHEN $2::boolean THEN now() ELSE NULL END
   WHERE write_id = $1 AND status = 'ambiguous'
  RETURNING status, ambiguous_at, ambiguity_proof;
  ```

  `found` → `completed`, and a retry **replays** rather than repeating. `absent` → `failed`,
  a **declared** non-write that is retryable like any other. There is deliberately no third
  outcome: "still unsure" is not a resolution, it is the state the row is already in.

  **Liveness, not a timer — restoring the WRITE-3 condition the SQL had dropped.**
  *Required review of `c22ce02`.* The file store retries an aged `in_progress` record **only when
  it was rehydrated from a prior process**; an in-process `in_progress` record may still be
  running and stays a duplicate (`services/idempotency.js:159-177`). The SQL above, on its
  own, reclaims **any** `in_progress` older than five minutes — which can start a **second
  live attempt while the first is still running**. The attempt token stops the stale attempt
  *acknowledging*; it does nothing to stop it performing **external effects**. For the four
  D4 routes, whose rows still append to Google Sheets, that is a duplicate append with no
  Supabase constraint to catch it. A slow request is not a dead one.

  **THE ADVISORY LOCK WAS THE WRONG ANSWER TO THIS, AND THE REPLACEMENT IS
  OWNER PROCESS IDENTITY.** *Required review of `ad18907`.* An earlier version of
  this section made a **session-scoped advisory lock** the liveness authority, on
  the reasoning that "if the owning process dies **or its connection drops**,
  Postgres releases the lock, which is exactly the prior-process-died evidence
  WRITE-3 relies on". **The second half of that disjunction is false**, and it
  invalidated the whole guarantee family:

  - Postgres releases an advisory lock the instant its connection drops — a network
    blip, a pooler restart, an idle reap. It says nothing about the process.
  - The attempt is meanwhile awaiting a **Google Sheets** request, which is an
    independent HTTP call the database knows nothing about. It can still be in
    flight, and it can still commit **after** the lock is released.
  - A competitor then takes the freed lock, claims the receipt, and performs the
    **same external effect**. The attempt token cannot help: it stops the first
    attempt *acknowledging in Supabase*; it cannot un-append a row from Google
    Sheets. For the four D4 routes there is no Supabase constraint to catch the
    duplicate either.

  **A dropped database session is not evidence that an external effect died.** No
  reconciliation is added around two live attempts; the inference is removed.

  The claim's reclaim condition is now the **owner instance id** carried on the
  receipt row:

  - Every claim stamps `owner_instance_id` — a per-process value minted at module
    load (`host:pid:random`). The random suffix matters, because a pid is reused
    after a restart.
  - An `in_progress` row owned by **this** instance is refused, however old. That
    attempt may still be running, which is exactly the file store's in-process rule.
  - An `in_progress` row owned by a **different** instance is reclaimable once the
    secondary five-minute bound has passed. A different instance id is the
    executable form of "rehydrated from a prior process".
  - A connection drop changes none of this, because it changes no instance id.

  **The precondition is stated rather than assumed.** "A different instance id
  means that process is gone" is sound under the **single-instance invariant**
  §5.3 and §5.5 already require for the cutover. Where more than one instance can
  run, a different id may be a live sibling, so the rule would be too weak — and
  `S4` may not wire this without that invariant enforced. Nothing depends on it
  today: the file store remains the sole receipt authority through `S2` and `S3`,
  and `atlas.write_receipts` has no production caller.

  **The lock survives, demoted.** It serialises concurrent claimers of one
  `write_id` inside a process. That is throughput. **It is never again described as
  a liveness authority**, and the five-minute window remains a secondary bound
  rather than an authority of its own.

  **The normal-release contract — without it the lock leaks.**
  *Required review of `60f27b3`.* A session-scoped lock does **not** end at transaction commit,
  and returning a pooled client does **not** necessarily close the database session. The
  previous text specified acquisition and process-death release and never specified the
  ordinary path. Three rules close it:

  1. **The connection is pinned.** The same checked-out session is held across
     claim → external effect → `completeWrite`/`failWrite` → unlock. The attempt may not
     migrate to another backend mid-flight, or the lock and the work end up on different
     sessions.
  2. **`pg_advisory_unlock` runs unconditionally on every normal exit** — success, failure,
     duplicate, refusal, and thrown error alike — in a `finally`. A lock released only on the
     happy path is a lock that leaks on precisely the paths that matter.
  3. **A leaked lock still costs something**, though less than it did when the lock
     was load-bearing: a later request may be serialised behind nothing, and on the
     *same* backend session advisory-lock **reentrancy** would let it acquire a lock
     it does not exclusively own. Reentrancy is why pinning is stated as a
     requirement rather than an optimisation.

  **P16a proves the release contract**: a successful attempt, a failed attempt and a
  thrown route each release the lock **before the connection returns to the pool**.
  **P16c proves the liveness rule against the case that invalidated its predecessor**:
  claim an attempt, drop its database session while the external effect is
  unresolved, confirm the advisory lock is genuinely free, age the row past the
  secondary bound, and prove a competitor is **still refused** — so no second
  external effect occurs. It also proves the refusal does not become a permanent
  stall: a genuinely restarted process, carrying a new instance id, reclaims.

  **PROCESS IDENTITY ALONE IS STILL NOT ENOUGH, AND THE REPLACEMENT IS
  EFFECT-AWARENESS.** *Required review of `deaa8a5`.* Owner process identity fixed
  connection loss and nothing more. A different instance proves the old process is
  **gone**; it does **not** prove an HTTP request that process already sent to
  Google Sheets did not commit. Google can accept an append and complete the
  server-side effect without the client surviving to receive or record the
  response, so five minutes of age cannot turn an ambiguous post-send outcome into
  a proven non-write. This sequence was still legal:

  1. process A claims the `write_id` and sends a Sheets write;
  2. Google **accepts** the request, but A dies before recording completion;
  3. the receipt stays `in_progress` under A's `owner_instance_id`;
  4. five minutes pass;
  5. process B, with a different instance id, reclaims **automatically**;
  6. B performs the same Sheets effect, and A's accepted request commits — two rows.

  The two liveness proofs each covered one half and **missed the composition**: P16c's
  connection-loss case keeps the **same** instance, so its refusal is about ownership
  rather than about the effect, while its restarted-process case uses a dead instance
  but has **no unresolved external effect allowed to commit late**.

  **One receipt state machine cannot infer identical retryability for a transactional
  and a non-transactional effect.** Ruling D4 moves the receipt for all seven callers,
  but only three of them move their **data**, so the reclaim rule branches on
  `effect_authority`:

  - **`supabase`** — `/api/log-workout`, `/api/complete-workout`, `undo-last`. After
    `S4` the authoritative effect is **one transaction**: atomically present or
    atomically absent, so a process that died mid-flight committed nothing a retry
    could duplicate. Their Sheets export is a **mirror** written by
    `spreadsheets.values.update` into a destination allocated once per session per tab
    (§3.9, §5.3 item 2), so a late duplicate overwrites its own identical cells. These
    reclaim automatically on process death, exactly as before.
  - **`sheets`** — `coaching-notes`, `constraints`, `log-modality`, `bodyweight`. Their
    rows keep appending to their own tabs with **no allocated destination** and **no
    Supabase constraint able to catch a duplicate**. Nothing reclaims these on process
    death. The claim refuses, the row moves to **`ambiguous`**, and only a
    destination-side finding — with its proof — releases it. **Ambiguous post-send
    state fails closed rather than automatically repeating.**

  **This is not fixed by another timer, and both existing timers had to be closed**, or a
  five-minute wait would simply have become a twenty-four-hour one:

  - the claim's **expired-row** branch excludes `'ambiguous'`, so the 24-hour TTL does not
    reclaim it;
  - the **prune** excludes `'ambiguous'`, because deleting the row would leave nothing at
    all and the next claim would insert a clean receipt — the same duplicate append,
    reached by a housekeeping job instead of a decision;
  - `peekWrite` therefore keeps an `ambiguous` row **visible past its TTL**, or a refusal
    would carry a null record and could not say why it refused.

  **`effect_authority` is declared, never derived.** It comes from a **frozen, exhaustive
  route map** in the adapter, keyed on the exact endpoint strings the routes already pass
  to `beginWrite`. An **undeclared route may not claim at all**: `'supabase'` is the
  permissive value — it authorises automatic retry after a process death — so a new write
  caller must not inherit it by omission. The column is written once at `INSERT` and is
  **absent from `atlas_app`'s column-scoped `UPDATE` grant** (§8.2), so the runtime cannot
  relabel a non-transactional effect as transactional and unlock automatic retry for it.

  **ONE `write_id` IS BOUND TO ONE ROUTE, FOR ITS WHOLE LIFE.** *Required review of
  `5533874`.* `route` and `effect_authority` are written at `INSERT` and are
  deliberately **absent from the claim's `DO UPDATE` list**. Without a binding, the
  `ON CONFLICT` path neither rewrote them nor required the incoming values to match
  the stored ones — and the primary key is `write_id` alone. That made this legal:

  1. `write_id = W` is first claimed on `/api/log-workout`, storing
     `effect_authority = 'supabase'`;
  2. that attempt reaches `failed` — a declared non-write, therefore retryable;
  3. through a client bug, a replay bug, or a namespace collision, the same `W` is
     presented to `/api/coaching-notes`, whose real authority is `sheets`;
  4. the failed-row branch lets the retry through, but the row **keeps**
     `effect_authority = 'supabase'`;
  5. the coaching-notes request sends its non-transactional append and the process
     dies in the ambiguous post-send window;
  6. a replacement process reads the stored `'supabase'` and **reclaims after five
     minutes** instead of marking the row ambiguous;
  7. the Sheets effect repeats — exactly the duplicate class the `ambiguous` state
     exists to make impossible, reached by a different door.

  The reverse collision only wedges a transactional route as `sheets`; the
  permissive `supabase → sheets` inheritance is the safety defect. Both are refused,
  because a rule that bound only the dangerous direction would be a rule about one
  symptom rather than about identity.

  **The binding is a refusal, not a rewrite.** Rewriting `effect_authority` on retry
  would erase what kind of effect the **prior** attempt may already have sent, which
  is the one fact the state machine cannot afford to lose. So the claim requires
  `route = $2 AND effect_authority = $4` **outside** the three reclaim branches, and
  a mismatch simply matches no row. `markReceiptAmbiguous` is bound the same way: a
  claimer arriving on a different route must change nothing at all — not even to
  record an ambiguity about an effect it never sent.

  **`write_id` stays the primary key**, unchanged. Making `(write_id, route)` the
  identity would legitimise one `write_id` on two routes, which is a weaker contract
  than the client has today, not a stronger one.

  **The collision is observable, not a silent duplicate.** The adapter reads the
  owning route through a dedicated two-column statement that is **not** TTL-filtered
  — an expired row is the most permissive reclaim branch there is, so a foreign route
  arriving at one must still be told it collided rather than handed an unexplained
  refusal. It logs `write_receipt_route_conflict` and returns
  `{ duplicate: true, routeConflict: true, storedRoute, requestedRoute }` with the
  **record withheld**, so no caller can replay a foreign route's stored response body
  as its own.

  **The pair is immutable to the runtime.** Neither `route` nor `effect_authority`
  appears in `atlas_app`'s column-scoped `UPDATE` grant (§8.2), so the binding cannot
  be defeated by relabelling a row rather than by editing a statement.

  **P16e proves it**: the full unsafe sequence refused before any effect, with the
  stored row completely untouched and its own route's retry still working; the
  reverse collision; the binding holding in **all three** reclaimable states
  (expired, prior-process, ambiguous) rather than only the failed one; a direct
  `markReceiptAmbiguous` on a foreign route matching zero rows; and both columns
  refused to `atlas_app` with SQLSTATE 42501.

    **P16d proves the composition the two halves missed**: an abandoned attempt from a dead
  instance on a `sheets` route, a competitor that is **refused and records the ambiguity**,
  and the dead process's append **committing late** — with exactly one row at the
  destination. It then proves **no timer un-wedges it** (neither the TTL nor the prune),
  that **only proof releases it in both directions** (found → `completed` and a retry
  replays; absent → `failed` and a retry proceeds; missing, empty, or non-boolean findings
  are refused), the **contrast** that the same death on a transactional route still
  reclaims and never becomes ambiguous, and that the route map is exhaustive and **fails
  closed** on an undeclared route.



  **Three corrections from the required review of `0e324ac`, all in this one statement.**

  1. **The initial insert now sets `expires_at`.** It did not, and the column has no default,
     so every brand-new receipt carried a **null TTL authority** — `peekWrite` filtered it out
     immediately (`expires_at > now()` is null-false) and the prune never owned it. A receipt
     that is invisible the instant it is created is not a duplicate shield.
  2. **An expired row is reclaimable atomically, at any status.** The file store calls
     `pruneExpired()` **synchronously before every `beginWrite`**, so an expired record is
     gone before the claim is evaluated. Filtering on read while deleting on a timer is not
     the same thing: an expired `completed` row still physically holds the primary key, so
     `ON CONFLICT` saw it, the retry `WHERE` refused it because it was `completed`, and the
     TTL-filtered read then reported it absent. **The `write_id` was wedged until a
     housekeeping job ran.** The third `OR` above reclaims it in the same statement, so
     correctness never waits on cleanup.
  3. **A reclaimed row resets `attempt` and `created_at`**, because prune-then-insert produces
     a genuinely new record. A live retry still increments and preserves them.

  **The prune job survives, demoted.** It bounds table size; it no longer carries any
  correctness. Nothing waits for it.

  Returning a row means this caller holds the attempt. Returning **no** row means the
  `WHERE` refused the update, which is exactly case (4) — a genuine duplicate. The caller
  then reads the row and refuses or replays.
- **`completeWrite` and `failWrite` are token-guarded**, for the same reason the in-process
  store passes a token: a **stale attempt must not overwrite a newer one**. Both are
  `UPDATE … WHERE write_id = $1 AND attempt_token = $2`. A superseded attempt matches zero
  rows and its late completion is discarded rather than applied.

- **`failWrite` INVALIDATES the token in the same statement.** *Required review of `4647ee2`.*
  The live store sets `token: null` on failure with the comment that this stops a stale
  `completeWrite` resurrecting the released attempt (`services/idempotency.js:249-255`). The
  design omitted it, which left this sequence legal: attempt A owns token T → `failWrite(A,T)`
  sets `failed` → **before any retry replaces T**, a late `completeWrite(A,T)` arrives → T
  still matches → the failed attempt becomes `completed`. That resurrects a write the system
  had released, and it contradicts P8's own promise. The transition is therefore:

  ```sql
  UPDATE atlas.write_receipts
     SET status = 'failed', attempt_token = NULL, completed_at = NULL
   WHERE write_id = $1 AND attempt_token = $2;
  ```

  Nulling the token in the same guarded update makes the resurrection unrepresentable rather
  than merely unlikely — a later `completeWrite` carrying T matches zero rows. **P8c** is the
  direct bite: fail, then late-complete with the *same* token **before any retry**, and prove
  it is refused.
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
`/tmp/atlas-idempotency.json`, and **proves no caller of the file store remains**, in the same
build. The **data** it held is carried into `atlas.write_receipts` and verified at §5.5 step 2a
before any new decider opens; that verified set, not the file, is what a rollback restores
(ruling D6, withdrawn).

**`session_id` is persisted when it is minted, or WRITE-2 cannot work.** *Required review of
`c22ce02`.* The schema carried a `session_id` column and the text promised `peekWrite` would
recover the **server-minted** id, but the claim SQL never wrote one — so `peekWrite` had
nothing to return and P16b could not have passed. The live consumer reads
`record.metadata.session_id` **before** minting a new id on retry (`index.js:2511`), so the
value must already be there.

**The route ordering must change at `S4`, and that is a behaviour change, not a storage
swap.** *Required review of `60f27b3`.* The live flow is `peekWrite` → **mint** → work →
`beginWrite` (`index.js:2506-2530`, `:2683`), so at the moment the id is minted **no Supabase
attempt is owned and no attempt token exists** to guard the update. The previous wording —
"persist it at the moment the server mints it, guarded by the attempt token" — described an
ordering that cannot happen.

One executable ordering is specified, and it is strictly stronger than today's: **it becomes
impossible to mint a server id without first owning the write attempt.**

1. **Claim first.** `beginWrite` runs before any minting, takes the advisory lock (below), and
   its `RETURNING` includes `session_id`.
2. **Completed-replay is unaffected**, because the claim refuses a `completed` row — it
   returns no row, the caller reads it and replays, and **never reaches the mint**. This is
   exactly the behaviour `index.js:2513-2519` documents today.
3. **Reuse or mint.** A returned non-null `session_id` on a non-completed row is reused. Only
   if it is null does the allocator mint.
4. **Persist under the token**, immediately after minting and before the workout write:
   ```sql
   UPDATE atlas.write_receipts
      SET session_id = $3
    WHERE write_id = $1 AND attempt_token = $2 AND session_id IS NULL;
   ```
   The token guard means an obsolete attempt cannot overwrite a newer one, and `IS NULL` means
   a reused id is never rewritten.

`completeWrite` persists `response_body` under the same token guard. A **live retry preserves**
`session_id` — the point of WRITE-2 — while an **expired reclaim clears it**, because that row
is a new logical record; both are in the claim's `CASE` above. `peekWrite` remains for
read-only inspection and for consumers that are not claiming.

**P16b must exercise this ordering**, including **process death after mint-and-persist and
before the workout write**, and prove the retry recovers **exactly that id** rather than
minting a second.

**Four operations, not three.** *Added by the advisory review of `7057b31`, which found
`peekWrite` live at `index.js:2511` and absent from this specification.* `peekWrite` is a
**read-only, non-mutating** lookup by `write_id`, TTL-bounded, that recovers a prior attempt's
record — including the **server-minted `session_id`** the earlier attempt allocated
(`test/idempotencyPersistence.test.js`, WRITE-2). Moving the store without specifying it would
leave a live caller with no replacement. In Supabase it is a plain
`SELECT … WHERE write_id = $1 AND expires_at > now()`; an expired row reads as absent,
exactly as today.

**The 24-hour TTL becomes a predicate plus a job, not an on-load prune.** The file store prunes
when it loads from disk. Postgres has no load, so the same rule is expressed twice: every read
filters on `expires_at > now()` so an expired row is never returned, and a periodic job
deletes rows whose `expires_at` has passed so the table does not grow without bound. The
**behaviour** is unchanged; only the mechanism is. Saying "the TTL keeps its current meaning"
without saying this specified nothing.

**The TTL epoch resets on every newly-owned retry — a correction from the required review of
`771ff83`.** The earlier SQL filtered on `created_at` and never refreshed it, while the
`failed → in_progress` and stale-`in_progress` transitions advanced only `attempt_started_at`.
That silently lost time the file store gives: it starts a **clean record** on a retry, so the
new attempt gets a fresh 24-hour lifetime. Under the old predicate a write first attempted at
23h59m could retry successfully and then vanish from `peekWrite` and duplicate replay **a
minute later**, inheriting the original attempt's expiry.

`expires_at` is the single winner and it is refreshed to `now() + 24 hours` by the claim
above. `created_at` stays immutable provenance and decides nothing. §6.1 P8a is the boundary
proof.

**One safety property is deliberately reversed at `S4`, and that is recorded rather than
implied.** Today persistence is best-effort: *"a disk failure NEVER fails a workout write; the
module falls back to in-memory operation"* (`services/idempotency.js:16-18`). That is correct
while Sheets is the write authority and the receipt is only a shield. After `S4` the receipt is
written **inside the Save's own transaction against the authority**, so a receipt failure
**fails the Save closed**. This is the intended and safer behaviour — a write whose duplicate
shield did not persist must not be reported as committed — but it **is** a reversal of a
documented property, and `S4` states it in its merge card rather than letting it happen
quietly.

#### `S2` and `S3` do not mirror receipts at all

**Correction, from the required review of `2ce7be3`, replacing the mechanism the review of
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

  *Correction, from the required review of `0878f61`.* The previous wording let the shadow
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
- **`S4` HANDS OVER the live receipt state; it does not discard it.** *Required review of
  `c22ce02`, correcting this document's claim that there is "no receipt data to migrate — only
  a decider to change". **That was false as a cutover property.*** Immediately before cutover
  the file store can hold up to **24 hours of unexpired live safety state**: completed replay
  records with their response bodies, `failed` records that are still retryable, fresh and
  rehydrated `in_progress` records, and the **server-minted `session_id`** WRITE-2 depends on.
  Pointing seven callers at an **empty** `atlas.write_receipts` and deleting the file store
  destroys all of it, and a **lost-response retry straddling the cutover then looks brand
  new** — which for a server-minted workout can mint a *second* session identity, and for the
  four D4 routes (whose rows still append to Sheets) can permit a *second* append with no
  Supabase constraint able to catch it. See §5.5a for the handover.

- **`S4` adds the foreign key and makes Supabase the receipt authority in the same step.**
  `beginWrite` starts claiming in Supabase, the §3.6 state machine goes live, and the
  migration adds `logged_sets.write_id REFERENCES atlas.write_receipts(write_id)` and the
  same on `session_effort`. Historical and backfilled rows keep `write_id = NULL`, which the
  foreign key permits.
- **Undo is unaffected.** `DELETE … WHERE session_id = $1 AND write_id = $2` operates on the
  Save just performed, which after `S4` always carries a `write_id`. A pre-cutover row with a
  null `write_id` was never undoable by that path.

This also removes the retryable-transition problem entirely: with nothing mirrored, there is
no terminal state to overwrite out of order.

**This resolves a contradiction the required review found.** An earlier version of this design
said the file store deliberately survives `S4` for four routes, while
`docs/ATLAS_SYSTEM_AUTHORITY.md` concept 18 said `S4` deletes it and verifies its absence,
and the §9 ownership table said both. Two incompatible rulings on one artifact could either
strip four routes of duplicate-write protection or falsely close `S4` while a competing
authority remained. There is now one ruling, and every authority surface states it.

### 3.7 `atlas.exercise_catalog_mirror` and `atlas.exercise_catalog_sync`

A read-only mirror of `Exercise_Catalog` (ruling D1). Reference data, not workout data.

**Correction, from the required review of `5f42d3c`.** An earlier version of this section said a
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
6. **A changed source is NOT a failure. The two are different things and are handled
   differently.**

   *Correction, from the required review of `0e324ac`.* The previous rule said a post-`S4`
   content mismatch records `status = 'failed'`, does not advance currency, and lets the
   prior generation age toward fail-closed. **That is exactly backwards for this table.** D1
   makes Sheets the **editing authority** for `Exercise_Catalog`, so a changed
   `content_hash` is the **normal, expected signal that the owner edited the catalog** — and
   ingesting it is the entire purpose of the swap defined immediately below. As written, a
   routine catalog edit would have been classified as a failure and would eventually have
   **503'd athlete Saves** instead of being synchronised.

   - **Source changed** — the Sheets `content_hash` differs from the current generation and
     the source is otherwise valid. This is **normal**. It drives the ordinary transactional
     swap and produces a **new verified generation**. Currency advances. Nothing is recorded
     as a failure, and nothing ages toward fail-closed.
   - **Sync failed** — the read failed, the source was empty or materially shrunken (rule 5),
     verification failed, or the swap transaction failed. **Only these** record
     `status = 'failed'` with `last_error` and leave the prior verified generation current
     (rule 4), so the mirror ages and eventually fails Saves closed.

   **During `S2`/`S3` only**, the reconciliation sweep may still open a
   `migration_divergences` row on concept `exercise_catalog` for a parity mismatch it cannot
   resolve, because in that era Sheets is still the live authority and unexplained drift is
   a migration concern. **After `S4` normal edits converge through the permanent sync**, and
   no permanent mechanism writes to `migration_divergences` — that table is dropped (gate
   P7c0).

   **P7b1** proves the distinction: change one valid row in the Sheets catalog, and a new
   verified generation must appear with the Save path continuously serviceable.
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

**This table exists because the required review found that the divergence authority the design
depended on was never declared.** `S2` requires a durable divergence record, `S3` requires
its count to reach zero, and `S4` will not merge while any row is open. A required gate
cannot depend on an unnamed record, and `write_receipts` cannot carry it — it has no
divergence reason, no repair state, no comparison result, and no closure proof.

It is **migration-control machinery, not product data**. `S4` removes every consumer and
writer of it; the table itself is dropped after the `S4` rollback window closes (§5.4 step 5),
because a restored `S3` build queries it during that window.

**Nothing that outlives `S4` may write to it — a correction from the required review of
`771ff83`.** An earlier version had the post-cutover exporter open a `mirror_range_occupied`
divergence here, and route whole-tab duplicate detection here too. Both are **permanent**
mechanisms; this table and its sweep and repair worker are **temporary**. After `S4` there
would have been no consumer to read it — and, once the post-window drop has run, no table
either.

The ruling is that this stays temporary and that **no generic permanent divergence subsystem
is kept alive just to serve the mirror**. Post-cutover mirror failures are **mirror state**,
and they live in the permanent, session-addressable export columns on
`atlas.workout_sessions` — `sheets_export_error` plus an unacknowledged `sheets_exported_at`
— surfaced by `npm run atlas:status` (§5.4). This table serves `S2` and `S3` only.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` | **PK**, `GENERATED ALWAYS AS IDENTITY`. |
| `concept` | `text` | `CHECK (concept IN ('logged_sets','session_effort','session_plan_events','session_plan_set_recommendations','exercise_catalog'))`. **`write_receipts` is deliberately absent** — Sheets stores no `write_id`, so it cannot be that concept's completeness authority (§3.6). The design does not declare a check it cannot perform. |
| `identity_key` | `text` | The diverged row's identity: the export identity key for the four migrated tabs (§3.2–§3.5), and the sync generation's `content_hash` for `exercise_catalog`. |
| `session_id` | `text` | Nullable — an orphan row may not resolve to a session. |
| `write_id` | `text` | Nullable. Present when an inline shadow write caused the divergence. |
| `route` | `text` | Nullable. The route whose shadow write diverged. |
| `reason` | `text` | `CHECK (reason IN ('shadow_write_failed','missing_in_supabase','missing_in_sheets','content_mismatch'))`. **No exporter reason appears here** — the exporter is post-`S4`, by which point this table has no writer and no reader and is awaiting its post-window drop (see the scope note below). |
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
- **Exact deletion.** *Corrected by the required review of `039c28c`, which found this bullet,
  the §3 inventory row and the scope note still asserting a same-`S4` drop that §§2/5.4/5.5
  had already replaced — so review 13's claim that every surface agreed was false on that
  head.* `S4` deletes the shadow lane, the sweep and the repair worker and verifies all three
  are absent, and leaves **the table** inert. The table is dropped by the two-step closure of
  §5.4 step 5 — an owner-run operation against `Atlas Production` after the rollback window,
  then a versioned migration so a fresh replay converges. `S4` does not merge while
  any row is not `closed` (§6.3 P15).

### 3.9 `atlas.sheets_mirror_cursor` and `atlas.sheets_mirror_allocations`

**The export destination authority.** Added by the required review of `0878f61`.

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

### 3.10 `atlas.write_freeze`

*Added by the required review of `4f8e180`, which found §5.5 step 1 depending on an
"owner-controlled runtime switch" that no section defined.*

```sql
CREATE TABLE atlas.write_freeze (
  id       boolean     PRIMARY KEY DEFAULT true CHECK (id),
  frozen   boolean     NOT NULL,
  reason   text        NOT NULL,
  set_by   text        NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now()
);
```

The `CHECK (id)` single-row idiom means the table can hold exactly one row, which is the point:
it carries **one control with one meaning** — are the seven `beginWrite` write routes open?

- **Immediate production consumer:** every one of the seven `beginWrite` write routes, which
  read it before any side effect; and §5.5 step 1, which is not executable without it.
- **Mutability:** `frozen`, `reason`, `set_by` and `set_at` are updated by the Supabase project
  owner only. The runtime holds `SELECT` and nothing else (§8.2).
- **Lifetime:** **PERMANENT, with no sunset — owner ruling D7, APPROVED 2026-08-09.** It is
  Atlas safety infrastructure, not a bridge, and `S4` does not delete it. The full lifecycle,
  owner authentication, failure posture, accepted cost and the reasoning are in §5.3; the
  decision record is **D7** (§9); the authorization is the execution plan's owner-ruling block.
- **Created by `S3`**, in an ordinary migration file under `supabase/migrations/`, applied to
  the disposable CI database like every other. The migration seeds the single dormant row
  (`frozen = false`) **as the principal that applies it** — the Supabase project owner.
- **The create is STRICT: no `IF NOT EXISTS`, and a pre-existing object is refused.**
  *Architectural ruling after review round 6 (2026-08-10).* `atlas.write_freeze` has exactly one
  legitimate `S3` starting state — **absent**. `S2` is applied to `Atlas Production` and the P8b
  checkpoint verified this table ABSENT there; the migration runner refuses any non-empty target;
  hosted application is owner-run, once. A pre-existing `atlas.write_freeze` is therefore **drift,
  not a compatibility state**, and the correct response is to refuse and change nothing rather
  than adopt an object of unknown provenance. The file is one transaction, so a refusal applies
  nothing at all. The accepted cost is that the migration is **not re-runnable** — which is
  intended, because a second application has nothing legitimate to do and failing is how drift
  becomes visible.
- **The DDL is the schema authority; the migration does not re-verify its own `CREATE`.** An
  earlier revision grew a ninety-line catalogue-and-probe verifier to police whatever object it
  might find. That existed only because `IF NOT EXISTS` allowed an unknown one; with strict
  creation, successful transactional DDL is the proof, and a catalogue query restating the
  declaration would be a second implementation of it. One postcondition survives, because it
  asserts an **absence** the DDL cannot establish: that no scoped role can write the control,
  which `ALTER DEFAULT PRIVILEGES` configured outside the file could otherwise grant.
- **Ownership is deliberately NOT transferred to `atlas_migrate`.** *Corrected by the required
  review of `65310b3`, finding 1: the migration originally ran `ALTER TABLE … OWNER TO
  atlas_migrate`, and an owner's implicit `INSERT`/`UPDATE`/`DELETE` cannot be durably revoked —
  an owner may re-grant to itself at will — so that made the migration role a **second**
  principal able to lift a freeze, which is precisely what D7 forbids.* Every other table in
  `atlas` is owned by `atlas_migrate`; this one is not, and the exception is the point. The
  table stays owned by the applying principal, which IS the sole mutator §5.3 names, so the
  ownership and the mutation path are one thing rather than two that must agree. §6.2 P8a proves
  the `INSERT`/`UPDATE`/`DELETE` refusal for **all four** scoped roles, proves a self-`GRANT`
  confers nothing, and proves the project-owner path can still set **and lift** the freeze.
- **The bound is on the row's CONTENT, not on the object.** *Measured, not assumed.*
  `atlas_migrate` owns the **schema** (S2 file 8), and a schema owner may `DROP` a table it does
  not own — an earlier version of P8a asserted that drop was refused, and the drop succeeded.
  So the migration role can still subtract this table; what it cannot do is **lift a freeze**.
  That asymmetry is safe by construction: subtraction is monotonic toward frozen, because a
  control that cannot be read is a control that refuses (§5.3, `row_missing`), and §6.2 P11
  proves it end to end by deleting the row under a live server. Losing the control can only
  close writes; it can never open them.

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
| 4 | `plan_version` | `plan_version` | none | The opaque `pv_…` plan identity token, preserved as text. NOT the integer of §4.4 row 4. |
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

**The mapping is POSITIONAL. The header has two supported spellings, and both name the same four columns in the same order.** `config/columns.js` declares the legacy spelling; the live tab carries the current one. `services/exerciseEnrichment.js` `buildExerciseCatalogMap` accepts both, so `contract.normalizeCatalogRows` accepts both. *Corrected 2026-08-13 after the live `Atlas Production` readiness run: this table named only the legacy spelling, and the normaliser recognised only its first column. A current header read by `sheets.getExerciseCatalog()` was therefore normalised as DATA, and the catalog gained one phantom entry named after its own first column.*

**A header is recognised by its COMPLETE four-column shape, never by its first cell.** `contract.isCatalogHeaderRow` matches all four columns against one of the two declared forms, tolerating only what the live reader tolerates — case, surrounding space, and `_` versus space. A row whose first cell equals a header name but whose remaining cells carry catalog content is DATA and is kept. *Added 2026-08-13 from the pre-review of this correction: a first-cell rule would discard an exercise legitimately named `Exercise` from both sides at once, so the two content hashes would still agree and readiness would certify a catalog that had silently lost a real entry.*

| # | Sheet column (current) | Sheet column (legacy) | Supabase column | Type change | Note |
|---|---|---|---|---|---|
| 1 | `Canonical_Name` | `Exercise` | `display_exercise` | none | Verbatim. `exercise` (the PK) is `lower()` of it. |
| 2 | `Muscle_Group` | `Muscle_Group` | `muscle_group` | none | |
| 3 | `Lift_Code` | `Lift Code` | `lift_code` | none | The space in the legacy header is preserved by the reader, not by the column name. |
| 4 | `Original_Variants` | `Canonical_Exercise` | `canonical_exercise` | none | Position 4. The mirror column keeps the name it was created with; renaming it would be a schema change, and none is made here. |
| — | *(none)* | `sync_id` | new | Mirror provenance — the generation that wrote the row, `REFERENCES atlas.exercise_catalog_sync(sync_id)` (§3.7). *Corrected by the advisory review of `ec53270`: this row previously mapped to a `synced_at` column that §3.7 does not define. Provenance is the generation, not a per-row timestamp — `exercise_catalog_sync` already carries `started_at` and `verified_at`, so a second clock on the mirror row would be a duplicate freshness authority, which is exactly what §3.7 split the two tables to avoid.* |

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
| **"rehydrated from a prior process"** — the in-memory flag `beginWrite` reads before treating an aged `in_progress` record as abandoned (`services/idempotency.js:159-177`) | **`owner_instance_id`.** The file store answers this by asking whether the record survived a restart; the table answers it by comparing the recorded owner against the claiming process. Same question, made durable. It is **not** a carried value — see below. |
| *(not stored today)* | `route`, `effect_authority`, `session_id`, `rows_written`, `appended_range`, `attempt`, `attempt_started_at`, `ambiguous_at`, `ambiguity_proof` |

**Three of these cannot be carried from a file record, and each has a rule rather than a
default:**

- **`owner_instance_id`** — the file store records no owner, and one may not be invented: a
  fabricated id would either look like the carrying process (wedging the `write_id` forever)
  or like a stranger (authorising an immediate reclaim). The `S4` drain instead normalises
  every carried `in_progress` record to `failed` (§5.5 step 2 sub-step i) **before** the
  handover inserts it, so no carried row is ever `in_progress` and
  `write_receipts_live_attempt_has_owner_check` is satisfied without fabricating anything.
  A carried `failed` record is retryable by design, which is the correct reading of a
  record whose owning process is by definition gone.
- **`effect_authority`** — derived from the carried record's `metadata.endpoint` through the
  same frozen route map the runtime uses, and from nothing else. A carried record whose
  endpoint is not in the map **fails the handover** rather than defaulting, for the reason
  §3.6 gives: `'supabase'` is the permissive value.
- **`ambiguous_at` / `ambiguity_proof`** — always null on a carried record. The file store
  has no ambiguous state, so nothing can arrive already blocked. New ambiguity is created
  only by a claim after the cutover.

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

## 5. The closure chain — four PRs, plus one bounded post-window cleanup PR

One concern per PR. Each PR names what it closes and what it must not do. The four
implementation PRs are §5.1–§5.4; the fifth is the narrowly scoped schema-history cleanup that
owner ruling **D8** approved, which fires only after the `S4` rollback window closes (§5.4
step 5, §9). *The heading said "four-PR" after D8 had made that count wrong — corrected by the
required review of `f641894`.*

### 5.1 PR S1 — governance, authority and schema design *(this PR)*

- Record the owner instruction and the required reviews in `docs/ATLAS_V1_EXECUTION_PLAN.md`.
- Correct every document that states Sheets is permanently the only V1 store.
- Record the authority move in `docs/ATLAS_SYSTEM_AUTHORITY.md`.
- Publish this design document.
- **Must not:** apply a schema, add a dependency, add a migration file, add an adapter,
  change product behaviour, or deploy.
- **Closes:** the paper conflict between the owner instruction and the governing documents.
- **Opens:** **four** loops, each with a named consumer and a sunset condition — the three
  implementation PRs below (`S2`, `S3`, `S4`) **and** the post-window schema-history cleanup
  that ruling D8 approved (§5.4 step 5). *Corrected by the required review of `f641894`: this
  said three, while D8 and the merge card both count four.*

### 5.2 PR S2 — migrations, adapter, shadow write, divergence lane

- Add the repository migration files for the eleven tables of §3.1–§3.9, as plain SQL under
  `supabase/migrations/`. `atlas.write_freeze` (§3.10) is **not** one of them — `S3` creates
  it, alongside the control that reads it. The files are checked in and applied to a **disposable**
  database in CI. Applying them to `Atlas Production` is a separate owner action.
- Add one Supabase adapter module. It is the only module that holds a Supabase client, in
  the same way `sheets.js` is the only module that holds a read-write Sheets client. It
  exposes the operations §3 names and nothing else. **No generic repository layer, no ORM,
  no query builder abstraction.**
- Wire the shadow write, the divergence lane, the reconciliation sweep, and the repair
  worker.

**Every shadow transaction inserts its `workout_sessions` parent first.** *Correction, from
the required review of `2ce7be3`.* Every migrated child table references
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

**The required review found a real gap here, and closing it changed which mechanism is
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

**Ruling D5 removed the read cutover from this PR — but "`S3` moves nothing" is no longer an
honest summary of it.** *Required review of `310b01b`.* D5 still holds exactly as ruled: **no
workout-data read or write authority moves in `S3`**, and Sheets decides every athlete-facing
read and write until `S4`. What `S3` now also does is introduce a **live write-admission
control** over the seven `beginWrite` routes and, with it, a **Supabase availability dependency
on those routes** (§5.3, the write freeze). That is a real production change, it is not
authority movement, and both statements need to be said rather than collapsed into "moves
nothing".

- Backfill from the current workbook the tables the workbook can source: `workout_sessions`,
  `logged_sets`, `session_effort`, `session_plan_events`, `session_plan_set_recommendations`,
  and `exercise_catalog_mirror` with its first `exercise_catalog_sync` generation.
  **`write_receipts` is deliberately not backfilled** — the workbook stores no `write_id`
  (§3.6) — and `sheets_mirror_cursor` takes its base at cutover (§5.5 step 4), not from the
  backfill. The backfill is a one-way script that
  is run once per environment and is deleted in `S4`.
- **The dry run is destination-aware, and that is a contract rather than a comment.** Without
  `--apply` the backfill reads **both** stores and writes to **neither**, and it reports the
  eligible source rows split into `would_insert` and `already_present`, computed from a real
  read of the destination indexed by the same export identity the sweep and the reconciliation
  use. Both fields are `null` — never `0` — when they were not computed, and a destination read
  that fails makes the run **incomplete** rather than a zero. *Recorded here after the dry run
  was found returning before it read Supabase, reporting `inserted=0 existing=0` whatever the
  destination held: the behaviour was asserted only in two code comments, so nothing outranked
  them when they and the code disagreed. The operator question this answers — how much of the
  workbook is already there — is the preflight for the owner-gated production backfill.*
- Prove reconciliation (§6.2 P3).
- Run the sweep continuously, and drive the open-divergence count to zero.
- Prove the repair path closes a divergence only on a passing re-comparison.
- Prove cutover readiness: every read the `S4` cutover will move is proven, against the
  backfilled database, to return what the Sheets read returns today.
- **Ship and prove the receipt migration seam**, specified below. Without it the `S4` handover
  has no executable path into or out of the live receipt authority.
- **Ship and prove the dormant write freeze**, specified immediately below. `S3` builds the
  owner-controlled freeze across **all seven `beginWrite` callers**, dormant by default, and
  proves it (§6.2 P8–P12). This is the one capability `S3` adds, and it moves no authority —
  which is why it belongs here rather than in the cutover build.
- **Must not:** move any athlete-facing read or write. Sheets stays the authority for both.
- **Blocked on: TWO owner gates, at different times.** *Corrected by the required review of
  `310b01b`, then completed by the required review of `f641894`, which found this entry naming
  only the second — so a fresh implementation agent could have started `S3` without the hosted
  checkpoint the higher-authority plan requires first.*

  1. **Before `S3` may begin — DISCHARGED 2026-08-08.** This gate required the owner to apply
     the `S2` schema to `Atlas Production` **and** the real-Supavisor four-role and session-lock
     checkpoint to pass (§6.1 P8b, §8.1, and the plan's owner-gate 2). **Both were done.** The
     owner applied the eight reviewed migration files, and the checkpoint **PASSED with exit
     code `0`** (§8.6). Nothing further is owed here. **`S3` became eligible from this
     dependency alone, and MERGED on 2026-08-11 as PR #1281 — carrying no deployed evidence,
     and NOT VERIFIED as applied to `Atlas Production` (last verified 2026-08-08: NOT
     APPLIED).**
  2. **For `S3`'s deployed freeze evidence:** the owner applies the `S3` `write_freeze`
     migration (§3.10). The PR **may merge before this**; the P8a/P8b deployed-system evidence
     **may not be claimed before it**, because the freeze cannot be proven against a deployed
     system whose schema does not yet exist.

  Ruling D2's Constitution amendment remains required before the `S4` cutover, not before this
  PR.
- **Bridge introduced:** none new. The `S2` bridge continues.

#### The write freeze — one bounded control authority

*Added by the required review of `4f8e180`.* `S4` step 1 required an "owner-controlled runtime
switch" that no section defined. A control with no named authority, no lifecycle and no
failure posture is a hope, not a mechanism, and the step that depends on it is not executable.

**What it is — one row, one meaning.** The table is `atlas.write_freeze` (§3.10): one row,
enforced by a `CHECK (id)` single-row primary key, carrying `frozen`, `reason`, `set_by` and
`set_at`. It carries **one control with one meaning**: are the seven `beginWrite` write routes
open? It is **not** a key/value flag store. It has no name column, no per-feature rows, and no second controlled
behaviour. Adding one is outside this migration and needs its own authorization. That bound is
the reason this is a table with a fixed shape rather than a general flag service.

**Owner authentication — no new surface.** `atlas_app` is granted `SELECT` and nothing else
(§8.2). No application role and **no HTTP route** can change it. The owner sets and lifts the
freeze by executing an `UPDATE` in the Supabase SQL editor, or through `psql` as the project
owner role. Authentication is therefore the Supabase project credential that §8.1 already
treats as owner-only, so the control adds **no new endpoint, no new key and no new auth
surface** — which is exactly why it is a row rather than an admin route.

**How a running instance sees it — permission is per request, never remembered.** Each of the
seven write routes reads the row at the start of the request, before any Sheets or Supabase
side effect. **A route may proceed only on a successful read, issued for that request, that
returns exactly one row saying `frozen = false`.** There is no cache and no remembered
value, so an owner `UPDATE` takes effect on the **next request of every running instance**,
old and new, with no deploy and no restart. That is what makes §5.5 step 1 executable. One
indexed single-row read per write request is affordable: these routes run a handful of times
per session.

**Failure posture — a failed read is a refusal, not a fallback.** *Corrected by the required
review of `310b01b`, which found the previous "last value read successfully" rule failing
**open** in the exact race the control exists to close: an instance reads `frozen = false`, the
owner then freezes, the instance's next freeze read fails, and the retained `open` value
authorizes a write the owner has already forbidden.*

- **Only a successful current-request read authorizes a write.** A stale previously-open value
  may never authorize a new write, however recently it was read.
- **Every one of these is `frozen` for that request:** a query error, a timeout, no result, a
  missing row, a malformed row, or more than one row. The control fails closed on every
  ambiguity, not only on a thrown error.
- **A prior `frozen = true` may be retained** — retaining a refusal can only refuse more — but
  a prior `frozen = false` may not.
- **Before any successful read the state is `frozen`**, so a replacement instance started
  during a freeze starts frozen.
- A frozen route returns an **explicit refusal** — HTTP 503 with a stated reason — never a
  silent drop and never an unverified success. The trust loop is suspended, not weakened.
- There is **no local override**. An environment variable or file that could open writes would
  be a second authority over the same question, which §2 forbids.

**The accepted cost, stated exactly and larger than the previous version admitted.** *The
earlier text called this a cold-start-only dependency. That was false once the rule above is
correct, and the correction is recorded rather than quietly reworded.* From the `S3` deploy
onward, **an affected write depends on a successful Supabase freeze read on that request**. If
Supabase is unreachable, the seven `beginWrite` routes refuse — even though Sheets is still the
authority for every one of them until `S4`.

That is a genuine new availability dependency on a system that is not yet the authority, and
these are its exact bounds:

- **Scope:** the seven `beginWrite` routes only. Every read path, preview, coaching reply and
  unaffected write is untouched.
- **Window:** from the `S3` deploy until the `S4` cutover. After `S4` a Supabase outage fails
  the write in any case, so the dependency stops being *additional*.
- **Shape:** one indexed single-row `SELECT` on an already-open pooled connection, so it fails
  only when Supabase is genuinely unreachable, not under ordinary load.

Failing **open** on a read error was rejected because it defeats the control: a blip inside the
cutover window would reopen writes with no operator knowing, which is the defect this
correction closes. The cost is stated here so it is visible before `S3` is built, not
discovered during the cutover.

**Lifecycle.** Created and shipped **dormant** (`frozen = false`) in `S3`, which proves it
(§6.2 P8–P12). Activated by the owner at §5.5 step 1, lifted at step 8, and used again by the
reverse transfer of §5.5a if a rollback happens.

**Sunset: NONE. Owner ruling D7 — APPROVED 2026-08-09.** *Recorded as a proposal until the
`S3` gate, where the design placed it; Dale ruled there, and it is now settled authority.* This
control is **permanent Atlas safety infrastructure, not a temporary migration bridge**. Two
exact reasons, both of which the ruling adopts.

1. **`S4` cannot delete it.** The `S4` reverse transfer freezes **the build that is currently
   live**, which is the `S4` build. An `S4` that removed the freeze would have no way to roll
   itself back.
2. **It has a named permanent consumer.** `CLAUDE.md` already carries the standing rule *"Any
   production data-integrity anomaly freezes writes immediately"* — and Atlas had **no
   mechanism for it** before `S3`; freezing meant a deploy or a manual scramble. That standing
   rule is the consumer, and it outlives the migration.

Recorded as **D7** (§9), **RESOLVED**. This is **not** the retained-dead-code case that ruling
D6 was withdrawn over: this code has a live consumer after closure, and the legacy receipt
store did not.

**The ruling is narrow, and its bounds are binding on every later change.** One single-row
write-admission control, governing exactly one question; the runtime holds `SELECT` and nothing
else; **no generic feature-flag framework**, no second controlled behaviour, no second
mechanism and no fallback; no weakening of `preview → approve → write`; and no workout-data
authority moves before `S4`. Adding a second controlled behaviour is outside this migration and
needs its own authorization. The authorization itself is the execution plan's owner-ruling
block, not this section.

#### The receipt migration seam — the only way into the live receipt authority

*Added by the required review of `310b01b`, which found both directions of the handover naming a
source and a destination that no declared actor can reach.*

**The defect, against the real module.** §5.5a requires reading the **live in-memory map** of
the frozen old process, and restoring a reverse-mapped set into that **same live process**
before writes reopen. Neither is possible today:

- `services/idempotency.js:300-307` exports exactly `beginWrite`, `peekWrite`, `completeWrite`,
  `failWrite`, `normalizeWriteId` and `resetIdempotencyStore`. None of them can enumerate or
  replace the record set.
- `writeRecords` (`:20`) and `persistDisabled` (`:22`) are module-private. An external process
  cannot read another process's memory-only receipts at all.
- `ensureLoaded` (`:117-125`) sets `loaded = true` **before** reading, so the disk is read
  **once per process**. Writing `/tmp/atlas-idempotency.json` after the old process is already
  live therefore does **not** restore its map. The reverse transfer's "restore into the
  now-live old process" had no mechanism.

**The seam — two functions and two routes, and nothing else.** `S3` adds to
`services/idempotency.js`:

- **`exportLiveReceipts()`** → `{ process_id, persist_disabled, disk_vs_map, records }`. A
  snapshot of the live map, with `persistDisabled` and the disk-vs-map comparison §5.5a already
  requires as completeness evidence. Read-only: it changes no record.
- **`importReceipts(records)`** → replaces the live map with a verified reverse-mapped set,
  persists it, and returns per-record accepted / rejected.

Their callers are two owner-only routes, `POST /api/migration/receipts/export` and
`POST /api/migration/receipts/import`.

**Operational boundary.**

**Authorization is the existing API key plus the proven frozen state — and nothing else.**
*Corrected by the required review of `8195632`.* An earlier version added "an owner-only
migration token supplied for the cutover and not configured in normal runtime". **A server
cannot verify a secret it does not hold**, and no authority was named that could: no stored
hash, no database record, no derivation. Worse, the only obvious way to give it one — setting a
Render environment secret at cutover — **redeploys**, which is the restart this seam exists to
avoid and which destroys the in-memory map it exists to read. The token was magic state, so it
is deleted rather than given a framework.

Two conditions remain, and both already exist — but the first is **deliberately stricter than
the ordinary `/api/*` contract**, and the earlier wording "exactly as every other route
requires it" was wrong. *Corrected by the required review of `039c28c`.*
`middleware.js::requireApiKey` accepts **either** a matching `x-atlas-api-key` (`:28-32`,
setting `req.authMethod = 'api_key'`) **or** a valid `atlas_session` cookie (`:34-45`, setting
`req.authMethod = 'session'`) — the browser path is cookie-authenticated by design. Mounting
these POSTs under the existing middleware would therefore let **a browser session** satisfy the
condition the design describes as "the API key".

That is not acceptable for `/api/migration/receipts/import`, which **replaces live
duplicate-write safety state**. So:

- **The API-key path specifically** — the routes require `req.authMethod === 'api_key'`, and a
  **session-cookie-only request is refused** even though it would pass the ordinary middleware.
  This invents no new secret; it narrows to one of the two paths the middleware already
  distinguishes.
- **A successful current-request read of `atlas.write_freeze` returning `frozen = true`**, by
  the same fail-closed rule that gates the seven write routes.

The two conditions answer different questions and neither substitutes for the other:
`frozen = true` proves the **owner opened the migration window**; the API key proves the
**caller is the owner-operated migration client** rather than any authenticated browser that
happens to be pointed at the box during it.

The second condition **is** the owner authorization, and that is the point rather than a
convenience: `atlas_app` holds `SELECT` only on that row, so **the only principal that can put
the system into the state where these routes answer at all is the Supabase project owner**
(§8.2). The owner authorizes the seam by freezing — with a credential the server never holds,
over a path that needs no deploy. Outside the frozen window both routes are inert and can
neither read nor alter live safety state.

This is **two routes with two purposes**. It is not a generic admin surface: there is no
arbitrary state access, no second operation, and no key/value shape. Adding one is outside
this migration.

**Single-instance handover is a positive cutover invariant, not a collector problem.**
*Corrected by the required review of `8195632`.* The previous version told the runbook to call
export repeatedly until every live process was covered. **Enumeration is not addressability:**
learning from the platform that three processes exist does not let a request reach a chosen
one, and a load balancer may legally route every call to the same instance forever. The runbook
could never prove it had captured the other private maps, so "cover every process" was an
instruction with no mechanism.

The design refuses the collector and constrains the situation instead:

1. **Before the freeze, prove the platform reports exactly one live old process. If it
   reports more, the cutover ABORTS — it does not trigger a scale-down.** *Corrected by the
   required review of `039c28c`.* The previous version told the owner to "reduce to one
   instance first, outside the frozen window". **That destroys the authority it was about to
   capture.** `services/idempotency.js` is per-process state, persistence is best-effort, and a
   process may hold an unexpired receipt **only in its private in-memory map**
   (`:128-130`, `:141`). Retiring that process during scale-down erases the receipt before
   `exportLiveReceipts()` ever runs — the same lost-safety-state class review 9 closed, moved
   to the topology step. "Outside the frozen window" does not make the loss safe; **writes
   being open makes it worse**, because the retired process may have accepted a receipt seconds
   earlier.

   **Single-instance operation is therefore a pre-existing `S3` → `S4` invariant, not a
   handover action.** The service runs on one instance for the whole readiness period. If it
   was ever multi-instance, or restarted while topology was being reduced, **the cutover stays
   ineligible until a full receipt TTL horizon (`DEFAULT_TTL_MS`, 24 hours) has elapsed under
   the stable single instance** — after which no unexpired receipt can survive only on a
   retired process, because every receipt a retired process could have held has expired. Any
   other proof that establishes the same fact is equally acceptable; an elapsed timer alone
   without the stability precondition is not.
2. **Confirm it from inside as well.** Every export response carries `process_id`, and across
   the handover every response must carry the **same** one. Platform count and observed
   `process_id` must agree: the count can be stale, and a repeated identity can be a routing
   coincidence, so neither alone is sufficient and a disagreement **aborts**.
3. **The same invariant governs the reverse path** — exactly one restored old process before
   `importReceipts` runs, proven both ways, or the rollback does not reopen writes.

This is affordable because **forward capture happens before the `S4` rolling deploy**, when
only the old build is running. The old-and-new overlap this design worries about elsewhere is
created by the step 6 deploy, which is after the carry.

A `write_id` conflict across snapshots is no longer a case to arbitrate, because there is only
one snapshot. If the invariant cannot be established the cutover **aborts**, which is the same
fail-closed posture as every other missing precondition here.

**Exact sunset.** The seam exists solely to migrate off the file store, so it dies with it.
`S4` deletes `services/idempotency.js` in full — both functions — and both routes, in the same
PR (§5.4). It survives a rollback exactly as the store does: the reverse transfer runs on the
restored `S3` build, which contains it. **P16's absence proof covers both routes and both
functions**, not just the store.

**Proof.** P19a and P19d must exercise the **real seam**, including the `persistDisabled`
memory-only case. A fixture that builds a record map directly and bypasses the exported
functions does not discharge them — the seam is the thing under test. `S3` proves the seam
itself at §6.2 P13.

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
3. Delete, **in the same PR**. *The `S4a` / `S4b` two-build split that the required review of
   `fcafa75` introduced here was **withdrawn by owner ruling on 2026-08-07** (decision D6,
   §9): the durable-capture correction had already removed its premise, because the rollback
   **data** is the verified receipt rows in `atlas.write_receipts` and the rollback **code**
   is the previously merged `S3` build, which a revert restores. `S4` therefore never needed
   to carry an implementation with no surviving consumer.*
   - the Sheets hot-path reads for the migrated concepts;
   - the shadow write, the sweep, the repair worker — **every consumer and writer of
     `atlas.migration_divergences`**, so the table is left inert rather than dropped;
   - the backfill script;
   - `services/sessionReadBatch.js` and the per-request `batchGet` context in `sheets.js`,
     for the migrated ranges;
   - the `Log_Cleaned` / `Effort` 30-second row cache in `index.js`;
   - `GET /api/log-workout/verify-range` and the client fallback branch — its sunset
     condition in `docs/ATLAS_SYSTEM_AUTHORITY.md` concept 11b is satisfied by this cutover;
   - **`deleteRowsByRange` for every mirrored tab** — a row-shifting delete is incompatible
     with durable allocations (§5.6);
   - the read-budget harnesses and fixtures for the migrated path:
     `test/liveSessionReadBudget.test.js`, `test/sessionReadBudget.test.js`,
     `test/sheets-adapter-reads.test.js`, `test/fixtures/liveSessionManifest.json`,
     `scripts/reconstruct-session-reads.js`, and `docs/READ_BUDGET.md`;
   - **the file-backed idempotency store**, `ATLAS_IDEMPOTENCY_FILE`,
     `/tmp/atlas-idempotency.json`, **and the §5.3 receipt migration seam** —
     `exportLiveReceipts`, `importReceipts` and both `/api/migration/receipts/*` routes, which
     exist only to migrate off that store — with a proof that **no caller of any of them
     remains** (ruling D4). Removing it in this build is safe because the rollback needs neither piece from it:
     the rollback **data** is the verified receipt rows in `atlas.write_receipts`, written at
     §5.5 step 2a and independent of any deploy, and the rollback **code** is the previously
     merged `S3` build, which a revert restores and which still contains the legacy
     implementation. `ATLAS_IDEMPOTENCY_FILE` is read by **six** test files, not only the two
     named above; `S4` removes every reference.
4. Verify the deleted machinery is genuinely absent, and record the count.
5. **Ship the divergence-table drop as an owner-run artifact, NOT as a pending migration.**
   *Corrected by the required review of `8195632`.* The previous version called it "an `S4`
   migration applied later", which is not executable under the declared workflow: pending files
   under `supabase/migrations/` are applied in timestamp order, and the `S4` cutover push would
   apply the drop **in the same operation as the cutover schema** — destroying rollback
   compatibility at the exact moment it is most needed.

   The drop therefore ships as **`supabase/operations/drop_migration_divergences.sql`**, a file
   deliberately **outside `supabase/migrations/`** so that no migration run and no `db push`
   can consume it. It is executed once, by the owner, as `atlas_migrate`, **after** the
   rollback window closes (§7.3), and that execution is an enumerated owner gate (§9).

   **That execution converges `Atlas Production`. It does NOT converge the repository, and the
   difference is the whole finding.** *Required review of `039c28c`.* An out-of-band operations
   file is not part of the schema that `supabase/migrations/` reconstructs, so **every fresh
   database built by replaying migration history — CI, a local stack, a disaster rebuild —
   recreates the `S2` temporary table and never drops it.** Production would be clean while
   every new environment regressed to a stale bridge table. A migration is not closed when one
   database is right; it is closed when the declared schema is right.

   **So the closure is two steps, and the second is a repository change with a future
   trigger.** After the rollback window closes and the owner has executed the operations file:

   | Step | Where | What converges |
   |---|---|---|
   | 1 | `supabase/operations/drop_migration_divergences.sql`, owner-run | `Atlas Production` |
   | 2 | the same statement added to `supabase/migrations/` as a normal versioned file, `DROP TABLE IF EXISTS` | the repository's reproducible schema — a fresh replay ends **without** the table, and production is a **no-op** because step 1 already dropped it |

   **Step 2 is a fifth repository change, and the owner has approved exactly one — ruling D8,
   2026-08-07 (§9).** It was raised as `OWNER DECISION REQUIRED` because it contradicted ruling
   D6 as written; Dale ruled option (a). The chain is therefore **four PRs plus one narrowly
   scoped post-window cleanup PR**, and the builder does not reinterpret that scope.

   The ruling's bounds are binding on step 2 and are repeated here because this is where an
   implementer reads them. The cleanup PR:

   - adds **only** the `DROP TABLE IF EXISTS atlas.migration_divergences` statement to
     `supabase/migrations/` as a normal versioned file;
   - **does not** reopen the `S4a` / `S4b` topology and retains no dead code;
   - **moves no runtime authority and changes no workout data**;
   - **adds no new framework, bridge, or feature**;
   - **exists only** to converge reproducible schema history, after the rollback-window
     trigger.

   Anything beyond that list is outside the ruling and needs its own authorization.

   **The migration is not closed until both steps land.** `S4` merging is not closure, and
   executing the operations file alone is not closure either — that is the ruling's own
   condition, not an addition to it.

**A guarantee may not be deleted along with its mechanism.**
`test/idempotencyPersistence.test.js` proves eleven behaviours of the receipt store. Some are
file-format specific and die with the file — corrupt-file recovery, the legacy bare-array
shape, `resetIdempotencyStore`. **Five are authority guarantees and must be re-proven against
Supabase BEFORE that suite is deleted** (§6.3 P16a): a completed write is replayed after a
restart; a stale `in_progress` record becomes retryable; a recent `in_progress` record still
blocks a retry after a restart; WRITE-3's rehydrated downgrade; and WRITE-2's recovery of the
server-minted `session_id` through `peekWrite`. Deleting the suite with the store would
silently drop the proofs for properties the new authority still owes.

**Nothing on this list survives `S4`.** One build, one merge, one exact-head review. Ruling D4
holds unchanged: the file store does not survive the migration, and it is not retained inert in
any build. The one thing `S4` does **not** delete is `atlas.write_freeze` and its route check,
**permanent Atlas safety infrastructure** rather than a bridge, carrying a named permanent
consumer and **no sunset** — owner ruling **D7**, APPROVED 2026-08-09 (§5.3, §9).

If any item on the list above cannot be deleted at `S4`, that is an open loop, and it must
carry a named consumer and an exact sunset condition, or `S4` is not complete.

#### The export must be durable AND idempotent

**The required review found that the derived queue delivered durability but not idempotency.**
The queue guarantees a closed session is retried after a crash. It did not prevent this
sequence: the Sheets append succeeds; the process dies before `sheets_exported_at` is set;
the restart exports the same session again. With no claim lease, two workers could also
claim the same session. Either path accumulates duplicate sets and ledger rows in the
mirror.

Three mechanisms, all required.

1. **The queue stays derived, never enqueued — and it excludes work no worker can advance.**
   A session owes an export when a `session_closeout` event exists in
   `atlas.session_plan_events`, **and** `sheets_exported_at IS NULL`, **and**
   `sheets_export_state <> 'blocked'`, **and**
   `(sheets_export_next_attempt_at IS NULL OR sheets_export_next_attempt_at <= now())`.
   Nothing extra is written at closeout, so nothing extra can be lost, and no second closeout
   authority appears. This is why no outbox table is added: an outbox row can itself fail to
   be written, whereas the closeout event that creates the obligation is the same row that
   proves the session closed.

   **Failures are classified, because an unclassified failure is an infinite loop.** *Required
   review of `0e324ac`.* The earlier design left `sheets_exported_at` null on **every**
   failure, including structural ones only the owner rebuild can fix. Those sessions stayed
   eligible on every worker pass, and **each pass performs the expensive whole-tab read** —
   recreating the exact class of Sheets quota storm that caused this migration, and competing
   with the permanent `Exercise_Catalog` sync. Starve that sync past
   `CATALOG_MIRROR_MAX_AGE` and **athlete Saves fail closed**. A retry loop that can take
   down the Save path is not a retry loop.

   - **Structural** — `mirror_range_occupied`, `mirror_duplicate_identity`. These are
     `blocked`. Only the §5.7 rebuild clears them. They leave the queue immediately, consume
     **zero** further Sheets reads, and stay visible in `npm run atlas:status` as owner
     action required. Durable, visible, and **not retried**.
   - **Transient** — an API error, a timeout, a rate limit. These are `retry_backoff` on
     **one deterministic policy**, declared here so P14i has something exact to prove:
     `sheets_export_next_attempt_at = now() + least(2 ^ sheets_export_attempts, 60) minutes`
     — that is **2, 4, 8, 16, 32, 60, 60 …** minutes — and at
     `sheets_export_attempts >= 8` the session becomes **`blocked`** rather than retrying
     forever. One formula, one cap (60 minutes), one ceiling (8 attempts). No jitter, so the
     schedule is reproducible in a test.

   The rebuild clears the structural error, returns the session to `queued`, and the derived
   queue picks it up by the same predicate. **P14i** proves a structural refusal generates no
   unbounded retry and no repeated whole-tab read.
2. **The mirror write is idempotent by destination. No lock can fence an external append.**

   **Correction, from the required review of `2ce7be3`, replacing the mechanism the review of
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

   **Row positions are VERIFIED before every write, never assumed.** *Added by the advisory
   review of `7057b31`.* Writing by absolute address makes correctness depend on a durable
   row block still holding what the allocator believes it holds. That is a materially
   stronger assumption than anything Atlas makes today, and the design must not rest on it
   silently — see §5.6.

   Immediately before the `values.update`, and inside the same claim, the worker reads its
   allocated range and proceeds **only** if every row in it is either blank or already
   carries **this session's** identity keys. Anything else — another session's identity, an
   unexpected value, a short read — is a **refusal**: the worker writes nothing, records
   `sheets_export_error = 'mirror_range_occupied'` on `atlas.workout_sessions`, and leaves
   `sheets_exported_at` unset.

   This converts the failure mode from *silent overwrite, detected later* into *refusal,
   detected now*. It costs nothing extra: the whole-tab read of mechanism 3 already contains
   the allocated range, so the check is derived from a read the export was making anyway.

   **The exporter fails its own acknowledgement; it never fails the workout.** *Corrected in
   the required review of `771ff83`, which found the exporter writing to `migration_divergences`
   — a table `S4` drops.* Every post-cutover mirror failure is **session-addressable mirror
   state**: `sheets_export_error` carries the reason, `sheets_exported_at` stays null so the
   session remains in the derived queue, and `npm run atlas:status` reports the backlog and
   the oldest unacknowledged session. **No post-`S4` path depends on `migration_divergences`,
   and no permanent divergence subsystem is kept alive to serve the mirror.** The athlete's
   workout is already committed in Supabase and is unaffected by any of this.

   This is safe only because **Atlas is the sole writer of these tabs once they are export
   mirrors**. That is exactly what `S4` establishes, and it is why deterministic destinations
   are available here and were not available while Sheets was the live write authority.

   **Reconciliation still tolerates a duplicate rather than assuming one is impossible.** The
   verify step counts rows per identity key, and more than one records
   `sheets_export_error = 'mirror_duplicate_identity'` with `sheets_export_state = 'blocked'`
   instead of passing silently — **not** a `migration_divergences` row, which does not exist
   after `S4` (gate P7c0). A mechanism that is believed to be idempotent, and a mechanism that
   is checked, are not the same thing.

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

   *Correction, from the required review of `0878f61`.* The previous version re-read only the
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

   **A count greater than one is a defect, not a tidy-up.** It records
   `sheets_export_error = 'mirror_duplicate_identity'` and `sheets_export_state = 'blocked'`,
   the session is **not** marked exported, and the design does not delete Sheets rows to correct itself. Recovery is the
   owner-only rebuild of §5.7, never an automatic deletion.

   **The cost, stated rather than hidden.** A whole-tab read per completed session is more
   expensive than a block read, and `Log_Cleaned` grows. It is deliberately **off the athlete
   path** — it runs in the asynchronous export worker after closeout, so it adds no in-request
   Sheets read to a Save — and it is the only check that can support the claim being made. A
   cheaper verifier that cannot see the whole tab would have to stop claiming duplicate
   detection.

`npm run atlas:status` reports the count of sessions owing an export and the oldest such
session, so a stalled mirror is visible rather than silent.

---

### 5.6 Row-position stability, undo, and re-export

*Added by the advisory review of `7057b31`. The three gaps below were unaddressed.*

#### The assumption the design was making without saying so

The deterministic-destination model persists `start_row` **durably and indefinitely** and
reuses it on every later export and retry. Its correctness therefore depends on absolute row
positions in a mirrored tab staying stable for the lifetime of the mirror.

**Atlas makes no such assumption today, and the one place it writes by position is careful
not to.** `sessionPlanSetsStore.sealCloseout` reads the ledger fresh, locates this session's
rows by index in *that* read, computes `sheet row = i + 2`, and stamps immediately
(`services/sessionPlanSetsStore.js`). It **re-derives** positions inside a single operation
and never persists one, so row drift between operations cannot hurt it. The allocator does
the opposite. That difference is the whole risk, and it is why §5.4 now verifies the range
rather than trusting it.

Three concrete ways positions drift:

1. **A row deletion shifts everything below it up.** `deleteRowsByRange` issues
   `deleteDimension` (`sheets.js:970-993`), which is a shift, not a blanking. Every
   allocation whose `start_row` is above the deleted range then points at the wrong rows.
2. **A structural edit by hand.** The owner has edited this workbook by hand before — the
   `Session_Plans` and `Session_Plan_Sets` tabs were created that way (execution plan,
   2026-08-03). One inserted or deleted row produces the same shift.

   **Correction, from the required review of `771ff83`.** An earlier version of this section
   argued that "a mirror nobody may touch is not a human-readable mirror". **That is wrong,
   and it is withdrawn. Human-readable does not mean human-editable.** The owner ruling is
   below.
3. **A partially applied grid extension** or any structural edit that changes row indices.

**Detection alone was not sufficient**, which is why §5.4 adds refusal. The whole-tab verifier
counts identities, so a shift produces no duplicate and passes; the damage would surface only
on the *next* export, after that session's rows had already been overwritten. Detection after
destruction is not a control.

#### The mirror contract after `S4` (owner ruling, 2026-08-07)

- The four migrated tabs — `Log_Cleaned`, `Effort`, `Session_Plans`, `Session_Plan_Sets` —
  become **generated export surfaces**. They are read by humans and written only by Atlas.
- **Supabase is the sole editing authority for migrated workout data.** A correction to a
  workout is made in Atlas and reaches the mirror by re-export. Editing the tab does not
  change the record; it only desynchronises the projection.
- **`Exercise_Catalog` is unchanged and is the opposite case** — Sheets remains its editing
  authority under ruling D1, and Supabase mirrors it.
- **Structural inserts and deletes on the four generated tabs are unsupported after
  cutover**, and are removed from the normal operating model. **Atlas itself must not shift
  rows there either**, which is why `deleteRowsByRange` is deleted for those tabs (below).
- This contract belongs in the D2 Constitution amendment alongside the authority ruling, so
  the editing boundary is stated where the storage boundary is.

The pre-write range check (§5.4) is retained as a **fail-safe for accidental drift**, not as
permission to edit.

#### Undo, post-cutover

`POST /api/log-workout/undo-last` retracts in Supabase (`DELETE FROM atlas.logged_sets WHERE
session_id = $1 AND write_id = $2`). Its effect on the mirror is now defined:

- **`deleteRowsByRange` is removed from every mirrored tab at `S4`** and added to the §5.4
  deletion list. A row-shifting delete is incompatible with durable allocations, and the
  export already may not delete mirror rows.
- **The session is marked for re-export** (below). The export rewrites the session's own
  allocated block with the reduced row set and **blanks the tail of that block**. Everything
  stays inside the session's own reservation, so no other session is touched and the cursor
  never moves backwards.
- An undone session whose rows stayed in the mirror would be a false record of the athlete's
  training. Retraction reaching the mirror is a correctness requirement, not housekeeping.

#### Re-export after any post-export change

`sheets_exported_at` was set once with nothing to unset it, so a session whose Supabase data
changed after export stayed permanently stale in the mirror — invisible to the derived queue,
which only finds `sheets_exported_at IS NULL`, and invisible to the sweep. That is reachable
today by undo, and by the seal: `closeout_write_id` is explicitly the one mutable column.

**The invalidation reuses the queue rather than adding machinery.** Any mutation of a
session's exported data sets `sheets_exported_at = NULL`. The session re-enters the derived
queue by the same predicate that found it the first time. No dirty flag, no outbox, no second
queue — and no new table.

#### Allocation covers only tabs the session actually has rows for

`row_count >= 1` and allocation is per `(tab, session_id)`. A session with **no `Effort` row**
— routine; the owner frequently supplies no watch data — must therefore receive **no `Effort`
allocation** at all. Reserving a block for a tab that will never be written would strand blank
rows in the mirror permanently and advance that tab's cursor for nothing. The all-or-nothing
rule of §3.9 applies to the tabs a session *has*, not to the full tab list.

### 5.7 Mirror rebuild — the one recovery from structural drift

*Added by the required review of `771ff83`.* The pre-write range check turns a silent overwrite
into a refusal, which is the right trade. But refusal alone **stalls permanently**:
allocations are immutable, the cursor never moves backwards, and after `S4` there is no repair
worker and no divergence table. A session that refuses would stay unexported forever with no
way out.

**One owner-only procedure recovers, and it is the only one.** It never touches Supabase
workout data — Supabase is the authority and is by definition already correct.

1. **Pause the export worker, and prove the pause.** Setting a flag is not a drain. No
   session may be claimed **and no in-flight Sheets write may survive into the allocation
   reset**, so the rebuild proceeds only once every export claim is released — proven the same
   way §5.5 step 2 proves its drain: a positive assertion (no held export advisory lock, no
   claimed-but-unacknowledged session), never an elapsed timer.
2. **Reconstruct the CLOSED-SESSION projection from a fixed snapshot.** Two boundaries, both
   required, and both missing from the first version of this procedure.

   - **Same scope as the normal exporter: closed sessions only.** The export queue is
     closeout-derived, so the projection the mirror owns is exactly the set of sessions
     carrying a `session_closeout` event. Rebuilding from *every* row would project an
     **open** workout's partial rows and mint an immutable allocation whose `row_count` is too
     small for that session's eventual closeout state — permanently unexportable. Open
     sessions are simply not in the projection; they export normally, with fresh allocations,
     once they close.
   - **A fixed snapshot, so the target cannot move under the rebuild.** The whole
     reconstruction and its verification run against one `REPEATABLE READ` snapshot taken at
     the start. Without it an athlete's writes change Supabase while the projection is being
     regenerated and verified, and the verification describes a state that no longer exists.
     Sessions that close after the cutoff are outside this rebuild and export normally
     afterwards.
3. **Re-establish the mirror metadata safely.** `atlas.sheets_mirror_allocations` is cleared
   and reissued to match the rebuilt layout, and each `atlas.sheets_mirror_cursor.next_row` is
   set past the new true tail with `base_established_at` re-stamped — the same handshake as
   §5.5 step 4, and safe for the same reason: the export is paused, so nothing else is
   writing.
4. **Verify the whole projection** — every session, every identity key, exactly once per tab —
   before anything resumes. A rebuild that has not been verified is not complete.
5. **Reset the whole export-state tuple, atomically, and resume.** Clearing
   `sheets_export_error` alone would leave every repaired session `sheets_export_state =
   'blocked'` — and the queue predicate excludes `blocked`, so the sessions would stay
   permanently unexportable while the procedure claimed success. *That contradiction between
   the procedure and its own proof was found in the required review of `c22ce02`.* The rebuild
   sets, in one statement per session:
   `sheets_export_state = 'queued'`, `sheets_export_error = NULL`,
   `sheets_export_next_attempt_at = NULL`, `sheets_export_attempts = 0`,
   `sheets_exported_at = NULL`, `export_claim_token = NULL`. Then the derived queue drains
   normally.

- **Owner-gated.** It rewrites a durable owner-visible surface, so it is owner-reserved like
  any other destructive Sheets operation. No agent runs it unprompted.
- **Never touches Supabase workout authority.** It only writes Sheets and mirror metadata.
- **Proof (§6.3 P14h).** One structural-drift case must reach refusal and then recover through
  exactly this procedure, ending with the projection verified and the session exported.

### 5.5a The receipt authority handover

*Added by the required review of `c22ce02`. This is an **authority-transfer** defect, not a
widening of workout-data migration.*

The receipt store is not only a code path. At cutover it holds live safety state, and ruling
D4 transfers receipt authority for **all seven `beginWrite` callers** — not just the migrated
workout routes. Two consequences the handover protocol had missed.

**The freeze and drain must cover all seven callers, not four.** §5.5 steps 1–2 freeze and
drain the *migrated workout routes*. But `POST /api/coaching-notes`, `POST /api/constraints`,
`POST /api/log-modality` and the bodyweight write also change decider at `S4`. Leaving them
live would have **two deciders answering "is this a duplicate?" at the same moment** — the old
build asking the file store, the new build asking Supabase. The receipt freeze therefore
covers **all seven**, and the drain proves no in-flight attempt remains on any of them.

**Every still-live receipt is carried over before the new decider opens.** Inside the frozen
window, and before step 6 of §5.5:

**Normalization is NOT a step of this section.** *Required review of `fcafa75`.* An earlier
version put it here as a "step 0" — but this whole section runs at §5.5 **step 2a**, after step
2 has already demanded zero `in_progress`. The normalization that unblocks the gate sat
**behind** it, so the deadlock it was written to fix survived intact. It now lives **inside
the drain**, at §5.5 step 2, before that step's zero assertion. **Nothing `in_progress` is
transferred**, which is what makes every carried row genuinely a decided outcome.

1. **Extract from the LIVE authority, not from the file alone.** *Required review of `4647ee2`.*
   Persistence is **best-effort**: after a write failure the module sets `persistDisabled`
   (`services/idempotency.js:141`) and keeps serving `beginWrite` / `completeWrite` from the
   in-memory `writeRecords` map (`:128-130`). **The file can therefore be stale or missing
   while the live process still holds a completed replay record, a retryable `failed` record,
   or a server-minted `session_id` that Atlas will honour.** Reading only the persisted JSON
   loses exactly those receipts, and the loss is invisible because the mapping itself is
   field-correct.

   The extraction authority is therefore, in order:

   - **The live in-memory map of every frozen old process**, read while they are still
     running, **through the §5.3 receipt migration seam** — `exportLiveReceipts()`, which is
     the only operation that can reach it. This is the actual authority and it is correct even
     when persistence is degraded.
   - **The receipt rows in `atlas.write_receipts`, when that table is non-empty**, and the
     live processes are gone. This is the resumption case, and it is decidable because of the
     crash-atomic rule in step 4 below: before the cutover **nothing else writes that table**
     (P7d proves `S2`/`S3` never mirror a receipt), and the carry is one transaction that
     commits only after verification passes. So a non-empty `write_receipts` before cutover
     means **exactly one thing** — the carry committed and was verified. Presence is not
     verification in general; it is verification *here* only because those two facts hold
     together, and both are gates. *Required review of `fcafa75`:
     the previous version allowed the persisted JSON here "after recording that completeness
     could not be verified". **Recording uncertainty is not a safety mechanism.** A
     field-correct import from a known-incomplete candidate still loses a completed replay or
     a WRITE-2 `session_id` — it just loses it with a note attached.*
   - **Nothing else. The transfer FAILS CLOSED.** A stale or unverifiable
     `/tmp/atlas-idempotency.json` is **diagnostic evidence only and may not authorize a
     cutover**. If neither the live map nor verified rows in `atlas.write_receipts` are
     available, **the cutover aborts** — the freeze stays on, the old decider stays
     authoritative, and no new decider opens.
   - Whichever source is used, the transfer records **`persistDisabled` and a disk-vs-map
     comparison** as evidence of completeness, not as an excuse for its absence.

   **P19a must inject the persistence-failure fallback** and prove a memory-only receipt still
   crosses the boundary. A disk-only fixture does not discharge it.

2. Read the **unexpired** records. *Corrected by the required review of `60f27b3`:
   the previous version filtered on `expires_at > now()`, and the file store **has no
   `expires_at` field**. Its TTL authority is `created_at_ms + DEFAULT_TTL_MS`
   (`services/idempotency.js`). A design that cannot enumerate the records it must preserve
   is not executable.* Unexpired means `now - created_at_ms <= DEFAULT_TTL_MS`.
3. Map each record by this **exact forward mapping**, from the real persisted JSON shape —
   not from a schema-shaped idealisation of it:

   | File-store field | `atlas.write_receipts` | Rule |
   |---|---|---|
   | map key / `write_id` | `write_id` | verbatim |
   | `status` | `status` | verbatim (`in_progress` / `completed` / `failed`) |
   | `created_at_ms` | `created_at` | `to_timestamp(created_at_ms / 1000.0)` |
   | `created_at_ms` | `expires_at` | `to_timestamp((created_at_ms + DEFAULT_TTL_MS) / 1000.0)` — **derived**, since the source has no expiry field |
   | **`response`** | **`response_body`** | the payload is named `response` in the file, not `response_body` |
   | `metadata.session_id` | `session_id` | the WRITE-2 value |
   | `metadata.endpoint` | `route` | |
   | *(absent)* | `attempt` | **`1`** — the file store keeps no attempt counter, so every carried record is attempt 1 |
   | *(not carried)* | `attempt_token` | **null** — every carried row is a **decided outcome**, never a live claim: the drain (§5.5 step 2) normalizes abandoned `in_progress` records and then requires zero of them, so `in_progress` is not a transferable state (§3.6) |
   | `rehydrated`, `token`, `failed_at*` | *(dropped)* | process-local; `token` is replaced by `attempt_token`, and liveness is now the advisory lock |

4. **The reverse mapping carries the ACTIVE TTL epoch, not provenance.** *Required review of
   `4647ee2`.* The previous version reconstructed `created_at_ms` from Supabase `created_at`
   and called dropping `expires_at` safe. It is not, because §3.6 deliberately separates the
   two clocks: `created_at` is immutable provenance while `expires_at` is refreshed on every
   newly-owned attempt. Concretely — a receipt first seen 23 hours ago, retried and completed
   now, has an old `created_at` and a fresh `expires_at` 24 hours out. Roll back two hours
   later and the old mapping writes a `created_at_ms` that is **25 hours old**, so the file
   store **prunes on load a receipt Supabase still owed for 22 more hours**, silently losing
   duplicate-replay and WRITE-2 protection across the rollback.

   The file store's TTL authority is `created_at_ms + DEFAULT_TTL_MS`, so `created_at_ms`
   must carry the **current lifetime clock**:

   `created_at_ms = extract(epoch from (expires_at - interval '24 hours')) * 1000`
   — equivalently `attempt_started_at`, which is the same instant by construction.

   Provenance is discarded, which costs nothing: the file store has no provenance concept and
   never had one. The rest of the reverse table is unchanged — `response_body → response`,
   `session_id → metadata.session_id`, `route → metadata.endpoint`, `rehydrated` omitted,
   `token` null; `attempt` is dropped because the file store has no counter. **P19a proves a
   retried receipt whose original `created_at` is already older than 24 hours but whose
   refreshed `expires_at` is still live survives the rollback.**
5. **Carry and verify in ONE crash-atomic transaction — and that committed set IS the rollback
   source.** *Required review of `310b01b`: the previous version described a verification but
   never the write that put the rows there, so a process could die after writing a proper
   subset and leave physical rows with nothing distinguishing them from a verified carry.*

   The forward carry is **one Postgres transaction**, run after the freeze and the drain:

   1. materialize the closed source set — the union of every process snapshot from the seam;
   2. write the mapped rows, `INSERT … ON CONFLICT (write_id) DO UPDATE` to the mapped values,
      so a repeated cutover attempt converges instead of failing;
   3. **remove nothing silently** — see the equality rule below;
   4. **verify identity and content inside the same transaction**;
   5. `COMMIT` only if verification passed; otherwise `ROLLBACK`.

   **The commit is the durable fact that verification passed.** Death before commit leaves no
   partial carried state at all, which is what makes the resumption rule in step 1 decidable.

   **Verification is exact set EQUALITY, in both directions.** *Required review of `310b01b`: the
   previous rule required only that every source record be present, which is source ⊆
   destination — not authority transfer.* Before cutover the file/in-memory store is the
   receipt winner, so an **extra unexpired `completed` row in `atlas.write_receipts` that the
   winner does not hold** would make a post-cutover `write_id` look already completed when the
   old authority considered it new: a false duplicate, and a **lost write**.

   - Every unexpired source record is present by `write_id`, with `status`, `response_body`,
     `session_id`, `route`, `created_at` and `expires_at` compared **field-by-field** against
     the forward mapping above.
   - **No extra unexpired destination receipt exists.** Any unexpired row not in the source set
     **aborts the transaction** — it is not removed and not merged. Before cutover nothing
     legitimate writes this table, so an unexpired extra is evidence of an unmodelled writer,
     and quietly deleting it would destroy the evidence. Aborting costs a retry; guessing costs
     a write.
   - **Expired physical rows may remain**, and only because every correctness path already
     excludes them by TTL (§3.6). A retry hours later legitimately finds its own earlier rows
     expired; that is not an unexplained extra.
   - A count match is not verification, in either direction.

   **The principal is `atlas_migrate`, not `atlas_app`** (§8.2). The carry is an owner-operated
   cutover step, and `atlas_app` deliberately holds no `DELETE` on `write_receipts` — a runtime
   role that could delete receipts could erase duplicate protection.

   Once the transaction commits, **`atlas.write_receipts` is the durable carried state** —
   there is no second artifact, no export file, and no "capture" object. *Required review of `4f8e180`:
   the design had made a "verified durable capture" load-bearing in five places without ever
   saying what it was, which is an unnamed authority bridge.* Reusing the destination table
   settles every question the term left open:

   | Question | Answer |
   |---|---|
   | Where does it live | `atlas.write_receipts`, in Supabase Postgres — durable, deploy-independent, covered by the §8.4 backup and restore proof |
   | What is its source and shape | the live in-memory map of the frozen old process, mapped by the forward table above |
   | What closes it against concurrent writes | §5.5 step 1's freeze on all seven callers plus step 2's positive drain, both of which precede this section; nothing can be appended behind it |
   | How is it verified | this step — identity and field-by-field content |
   | Who may read it | `atlas_app` under its existing grants (§8.2); the owner through the Supabase console. **No new role and no new grant.** |
   | Privacy | `response_body` carries athlete-facing payloads, so it is covered by the existing rule: never exported to an evidence file, a PR body or a commit (§8.4) |
   | Retention and sunset | the existing `expires_at` TTL prunes it. The table is **permanent** — it is the post-cutover receipt authority — so it needs no sunset, which is the whole reason to reuse it |
   | How is it restored | the reverse mapping below, at reverse-transfer step 6, into the live old process |

6. **The old authority's state is abandoned only after the carry-over is verified; its code is
   deleted by the `S4` build itself.** The earlier text conflated the two and made the file
   store "the rollback source", which forced a second build to remove it. It is not the
   rollback source: the **data** is the verified rows above, and the **code** a rollback needs
   is the previously merged `S3` build, which a revert restores. `S4` therefore deletes the
   file store outright (ruling D4), and **no build ships it inert** (ruling D6, withdrawn).

**Rollback is symmetric, and this is the part that bites.** Once writes reopen (step 8), new
receipts exist **only** in Supabase. A rollback that simply restores the previous build would
reopen Sheets writes while discarding that state — reintroducing the same lost-response
duplicate in the opposite direction.

- **Rollback before step 8** (writes still frozen) is clean: no new receipts exist, the file
  store is intact and untouched, and nothing needs carrying back.
- **Rollback after step 8 is its own ordered authority transfer, not a copy step.** *Required
  review of `60f27b3`.* The previous wording said only "carry back, then reopen" — but once
  writes are open, a **new Supabase receipt can be created after the reverse read and before
  the old build resumes**, and it then vanishes from the restored file authority. That is
  exactly the lost-response boundary this mechanism exists to close, reintroduced by the
  rollback. The reverse transfer therefore mirrors the forward one, in order:

  1. **Freeze all seven callers** again — on the build that is currently live.
  2. **Positive drain**, proven as in step 2: no in-flight attempt on any of the seven, no
     held receipt advisory lock.
  3. **Fixed snapshot — which is `atlas.write_receipts` itself**, closed by steps 1–2: the
     freeze and the positive drain mean nothing can be appended behind it. There is no
     separate snapshot artifact. Carry back every unexpired receipt by the reverse mapping of
     §5.5a.
  4. **Verify by identity and content**, not count.
  5. **Restore the old build and decider**, and wait until that process is **live**.
  6. **Restore the receipts into the now-live old process**, read from
     `atlas.write_receipts` — never from a `/tmp` file written before the restart, which the
     restart may have discarded.
  7. **Reopen writes**, last.

  **P19a must inject a receipt concurrent with the rollback** and prove it cannot fall through
  the boundary.

**Proof (§6.3 P19a).** A **lost-response retry across the cutover boundary** is replayed from
the carried-over receipt rather than treated as new — proven for a **server-minted workout**
(WRITE-2: the retry recovers the prior `session_id` and does not mint a second) **and for at
least one non-workout D4 route** (no second Sheets append). The same scenario is then proven
**across a rollback**. A handover proven only forwards is proven half.

### 5.5 The `S4` handover protocol

**Added by the required review of `0878f61`.** The design previously said reads and writes "move
together" and left it there. A merge plus a deploy is a rolling replacement, not an atomic
authority transfer, and without a protocol an old instance — or a request already in flight on
one — can complete an **acknowledged Sheets write** after the final `S3` sweep, while a new
instance is already reading and writing Supabase. That recreates the exact acknowledged-write
omission this migration exists to eliminate. It also makes the export's initial per-tab base
unsafe, because a late append can land after the allocator has recorded its tail.

The handover is **nine ordered steps** — 1, 2, 2a, 3, 4, 5, 6, 7, 8 — inside **one build**.
*The heading once said eight while the list contained `2a` and a step 9; the miscount is fixed
and step 9 is gone, because the source deletion it described is performed by the `S4` build
itself rather than by a second one (ruling D6, withdrawn).* Each step must complete and be
verified before the next begins.

1. **Freeze the affected writes — all seven `beginWrite` callers, not only the migrated
   four (§5.5a) — WITHOUT a restart that destroys the source.** *Required review of `4647ee2`.*
   The previous protocol shipped the freeze as an **earlier deploy**, then carried the receipt
   state at step 2a. But `/tmp/atlas-idempotency.json` is process-adjacent and **may be gone
   after a restart** — this document says so itself — so a deploy at step 1 could destroy the
   very state step 2a exists to preserve. **The handover was creating its own
   authority-loss window**, and "the file remains the rollback source until step 9" does not
   help if step 1 already removed it.

   Two rules close it:

   **One activation path, not two.** *Required review of `fcafa75` found the previous version
   offering dormant-in-`S3` and "ships as its own earlier deploy" as alternatives — mutually
   incompatible runbooks, the second of which recreates the very restart window the first
   exists to close.* The winner:

   - **The freeze capability ships dormant in `S3`'s already-deployed build**, and `S3` is
     **obligated to build and prove it** (§5.3, which specifies the control in full).
     Activating it at `S4` requires **no new deploy and no restart**, because the control is a
     single owner-written row in `atlas.write_freeze` that every running instance reads on
     each affected request — not an environment variable, precisely because a Render
     environment change itself redeploys.
   - **`S3` must prove restart-free activation on all seven callers** (§6.2 P8–P12). If that
     proof fails, it is an `S3` blocker to resolve there — **not** a standing alternative
     carried into `S4`. The design offers no second mechanism to fall back on.

   **P19c proves activation is restart-free**, and that an unrelated loss of the old process
   and its filesystem at this boundary **aborts the cutover** rather than proceeding on an
   incomplete set. It does not claim the receipts survive that loss: no set is closed before
   the freeze, so none can be made durable earlier (§11).

   A write-freeze flag makes every affected write route **fail closed** with an explicit "migration in progress" response. The trust loop is suspended,
   never weakened: an athlete gets a clear refusal, never a silent drop and never an
   unverified success. The capability is already present in the running `S3` build (above), so
   **every running instance — old and new — honours it the moment it is activated**, with no
   deploy. A freeze that only a new build knew about would not stop the old one.
2. **Drain — normalize, THEN assert zero.** After the freeze is live on all instances, wait
   longer than the maximum request duration, then, **in this order**:

   i. **Normalize abandoned records until none remain.** The current authority downgrades a
      rehydrated `in_progress` record **lazily, inside `beginWrite`**
      (`services/idempotency.js:165-177`), with no background timer — so once the routes are
      frozen, `beginWrite` is unreachable and a record that was four minutes old at the freeze
      ages past the threshold and stays physically `in_progress` **forever**. The drain
      therefore applies the authority's own rule itself — a `rehydrated` record older than
      `STALE_IN_PROGRESS_MS` becomes `failed` with its token invalidated — and **repeats until
      no abandoned record remains**, because a record can cross the threshold *during* the
      drain.
   ii. **Then prove zero**: zero `in_progress` write receipts and zero in-flight requests
      across all seven routes. A positive assertion, never an elapsed timer.

   *Ordering matters and was wrong before: the normalization used to live in §5.5a, which runs
   at step 2a — behind the gate it exists to unblock. The sub-steps are numbered i/ii rather
   than a/b so that "step 2a" can only mean the carry-over step below.*
2a. **Carry over the live receipt state (§5.5a)** and verify it, before any new decider opens.
3. **Run a final complete sweep** and require **zero open divergences**. It runs after the
   drain, so nothing can be written behind it.
4. **Establish and record the export mirror's per-tab base.** Read each mirrored tab's true
   tail and set `atlas.sheets_mirror_cursor.next_row` past it, stamping
   `base_established_at`. This is only safe because step 2 proved no further append can land.
5. **Apply the `S4` schema and receipt transition.** Add the `write_id` foreign keys — which
   validate because `S2`/`S3` always stored null (§3.6) — and make Supabase the receipt
   authority. The foreign keys validate even though step 2a has just populated
   `atlas.write_receipts` for the first time, because every existing child row still carries a
   null `write_id`. **The file store is still present in the running `S3` build at this point**;
   it disappears with the deploy at step 6, and its data was carried at step 2a.
6. **Deploy the cutover build** and switch the sole runtime authority.
7. **Run the non-counting proof workout** and the exact evidence checks of §6.3.
8. **Reopen writes**, and only after step 7 passes.

**There is no step 9, and `S4` is one build.** *Owner ruling 2026-08-07, withdrawing decision
D6.* An earlier version made the file store the rollback source, which forced it to survive
steps 6–8 and therefore forced a second build to remove it. The durable-capture correction had
already removed that premise. The rollback needs two things and neither is the retained file
store: the **data** is the verified receipt rows in `atlas.write_receipts`, written at step 2a
and deploy-independent, and the **code** is the previously merged `S3` build, which a revert
restores and which already contains the legacy implementation. The `S4` build therefore ships
without the file store from the start, and the deletion is an ordinary part of the same PR
(§5.4, ruling D4).

**A revert restores source, not a database. The rollback winner is stated here.** *Required
review of `310b01b`.* `S4` also changes the database, and the divergence table is the reason:
the restored `S3` build's shadow lane, sweep and repair worker call
`atlas.migration_divergences` **continuously**, so a Git revert against a database that had
already dropped it would put back code querying a table that no longer exists. *The earlier
wording here said `S4` "drops" that table, which the two-step closure of §5.4 step 5 replaced —
`S4` drops nothing; the owner does, after this window.*

The winner is **(a): the post-`S4` schema stays backward-compatible with the `S3` build for the
whole rollback window**, rather than a reverse schema transition executed under pressure.

- **`S4` ships the drop as an owner-run artifact, not as a pending migration.** It lives at
  `supabase/operations/drop_migration_divergences.sql`, deliberately **outside
  `supabase/migrations/`**, so the `S4` cutover push cannot apply it in the same operation and
  destroy the compatibility this bullet depends on (§5.4 step 5). The owner executes it as
  `atlas_migrate` after the rollback window closes — the same owner gate that already governs
  every schema application in this chain (§9, owner-reserved gates). **Executing that file costs
  no merge** — applying SQL never did — but it is only **step 1 of two**: the repository's
  reproducible schema converges through a later versioned migration, delivered by the one
  narrowly scoped cleanup PR **owner ruling D8 (2026-08-07) approved** (§5.4 step 5, §9). `S4`'s merge card records both steps, the trigger, and the
  fact that the loop stays open.
- **During the window the table exists and is unused.** The `S4` build has no writer for it
  (P7c0 proves no permanent mechanism writes it), so it sits inert; a restored `S3` build finds
  it present and its sweep, divergence lane and repair worker run exactly as they did.
- **The rest of the `S4` schema is additive.** The `write_id` foreign keys accept null, which
  is all `S3`'s shadow write ever produced (§3.6, P20), and `S3` never reads or writes
  `write_receipts`. Nothing else changes shape.
- **This is proven, not assumed** — gate **P19i** runs the `S3` build against the post-`S4`
  schema.

**Rollback fails closed when the receipt source cannot be read.** The rollback data source is
now `atlas.write_receipts`, so its unavailability is a rollback failure mode and is stated as
one: if Supabase is unreachable, or the current receipt rows cannot be read and verified, the
rollback **may restore the code but must not reopen the seven writes**. The freeze stays on
until a verified set is restored. A Supabase backup is a disaster-recovery instrument and
**cannot be assumed to contain receipts created after its snapshot**, so it does not discharge
this. Revert-and-reopen is not an unconditional operation, and **P19d** exercises the case
where it must stop half way.

**Abort and rollback.** Steps 1–4 are reversible by lifting the freeze: nothing has moved.

**The rollback source is `atlas.write_receipts`, never `/tmp`.** *Required review of `fcafa75`,
made concrete by the required review of `4f8e180`.* The previous text called the file store
"still intact" after step 6 — but step 6 **deploys**, and this design records that
`/tmp/atlas-idempotency.json` may not survive a Render restart. **Retaining the code does not
retain the data.** The reverse path had the same hole: it carried receipts back into `/tmp` and
*then* restored the old build, whose own restart could erase the file before the old decider
ever read it.

So the rollback authority is **the receipt rows written and verified into
`atlas.write_receipts` at step 2a**. There is no separate "capture" artifact: the destination
of the forward transfer **is** the durable carried state, it is a permanent table this
migration already builds, it needs no new consumer and no new sunset, and its existing
`expires_at` TTL is its retention rule. Restoration happens **after the old process is live and
before writes reopen** — never into a filesystem that a pending restart may discard. **P19d**
proves both loss cases: the cutover deploy destroying `/tmp`, and the rollback deploy
destroying it. If
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
| P1 | Deterministic tests: every constraint of **§3.1–§3.9** is proven by a test that inserts a violating row and asserts the insert is rejected. A constraint with no violation test does not count as proven. **§3.10 `atlas.write_freeze` is excluded, because `S2` must not create it** — `S3` creates it and `S3` proves it (§6.2 P8a). *Corrected by the required review of `310b01b`: "every constraint of §3" demanded that `S2` prove a table `S2` is forbidden to create.* |
| P2 | Integration tests against a **real disposable Postgres database, created from empty and destroyed for the exact CI run** — a Postgres service container in the job or the local Supabase stack, with every file in `supabase/migrations/` applied from scratch. A fake, an in-memory stub, or a mocked client does not satisfy this, and neither does a database that carried state in from an earlier commit. It must require **no paid Supabase plan** (§8.5, ruling D3). |
| P3 | The shadow write is proven inert: a browser-level test shows the athlete-facing response is byte-identical with the shadow write enabled and disabled. |
| P4 | A shadow write that throws is proven not to fail a Save. |
| P5 | **Process death in the exact window is proven detectable.** Kill the process after the Sheets append returns success and before the shadow write; restart; run the sweep; assert the omission is found, repaired, and closed with a passing re-comparison. |
| P6 | The sweep is proven complete on all five declared concepts: a seeded omission, a seeded content mismatch, and a seeded Supabase-only orphan are each detected and classified with the correct `reason`. Includes a **catalog content mismatch** (`exercise_catalog`). |
| P7 | A divergence is proven **not** closable without `closure_proof`, and proven not closable by a lapsed lease or a timer. |
| P7a | **The shadow transaction is proven ordered and atomic on the session parent.** A shadow Save inserts its `workout_sessions` parent before its child rows in one transaction; a child can never commit without its session parent; a failure mid-transaction leaves neither; and a second Save for the same session does not duplicate or overwrite the parent. Proven against an **empty** schema, which is the state `S2` actually starts from. |
| P7d | **No receipt is mirrored during `S2`/`S3`**, proven by assertion on an empty `write_receipts` after a shadow Save, and `logged_sets.write_id` / `session_effort.write_id` carry **no foreign key** at this stage. A repaired child row is proven to carry `write_id = NULL` rather than a fabricated value. |
| P7c0 | **No permanent mechanism writes to `migration_divergences`.** Proven by search across the exporter, the catalog sync and every post-`S4` path. The complete writer set is **three**, all temporary and all deleted by `S4`: the `S2`/`S3` **inline shadow lane**, the **reconciliation sweep**, and the **repair worker**, which writes the `open → repairing → closed` transitions (§3.8). *Corrected by the required review of `eae382e`: this gate named only two, so a proof of a "complete" writer set was checking an incomplete one.* The invariant under test is that **no permanent or post-`S4` mechanism writes it** — the enumeration must be complete for that proof to mean anything. A permanent mechanism writing to a dropped table is a defect that only appears after cutover. |
| P7b1 | **A legitimate catalog edit synchronises; it never fails.** Change one valid row in the Sheets catalog and prove a **new verified generation** appears, currency advances, no failure is recorded, and the Save path stays continuously serviceable. Separately prove each genuine failure mode — read failure, empty source, materially shrunken source, verification failure, swap-transaction failure — **does** record `status='failed'` and leaves the prior generation current. A test that only exercises failure cannot tell the two apart. |
| P7b | **The catalog mirror is proven fail-closed.** A generation older than `CATALOG_MIRROR_MAX_AGE` is proven **not served** — the Save fails closed with an explicit reason, exactly as the expired cache does today. A failed sync is proven not to advance currency. An empty or materially shrunken source is proven refused. A content mismatch is proven to open an `exercise_catalog` divergence. A test that only shows a fresh mirror is served does not discharge this. |
| P7c | **Least privilege is proven, not claimed.** `atlas_app` is refused a DDL statement and refused a `DELETE` on a table outside its grant list (§8.2). Every statement the design specifies — the claim, the `session_id` persist, `completeWrite`, `failWrite`, the export-state updates — is executed **as its real role** and proven to succeed. Three grant/SQL mismatches have already reached review; a statement proven only as superuser proves nothing about the deployed system. |
| P8 | The `write_receipts` state machine is proven on all four transitions of §3.6, including that a **`failed` attempt does not consume the `write_id`** and that a superseded attempt's late `completeWrite` is discarded. |
| P8c | **`failWrite` invalidates the token.** Fail an attempt, then send a late `completeWrite` carrying the **same** token **before any retry occurs**, and prove it is refused. The failed attempt must not become `completed`. |
| P16c | **The receipt liveness rule survives a lost database session during an unresolved external effect.** Claim an attempt; **terminate its database backend** while the Google Sheets effect is still in flight; confirm the advisory lock is genuinely free; age the row past the five-minute bound; and prove a competitor is **still refused**, so no second external effect occurs. Then prove the refusal is not a permanent stall: a genuinely restarted process, carrying a new `owner_instance_id`, reclaims. *Added by the required review of `ad18907`, which found the previous mechanism inferring external-effect death from database-session death — a false implication that let a competitor take a freed lock and perform the same Sheets append. A test that only proves a live lock blocks a claim does not discharge this: the lock is not the mechanism under test.* |
| P16d | **A process death does not authorise repeating a non-transactional external effect — proven as one composition, not as two halves.** Claim a `write_id` on a **`sheets`-authority D4 route** as instance A; kill A's attempt so the row keeps A's ownership with the Sheets append **neither cancelled nor acknowledged**; age it past the five-minute bound; prove a competitor with a different instance id is **refused** and that the refusal is **recorded** as `ambiguous` naming A's instance with the token voided; then let **A's already-accepted append commit late** and prove exactly **one** row reached the destination. Must additionally prove: **no timer un-wedges it** — an expired `ambiguous` row is still refused, still visible to `peekWrite`, and **not deleted by the prune**; **only destination-side proof releases it, in both directions** — found → `completed` with a retry replaying the body, absent → `failed` with a retry proceeding, and a missing, empty, or non-boolean finding refused; the **contrast** that the same death on a `supabase`-authority route still reclaims and never passes through `ambiguous`; and that the route map is **exhaustive and fails closed**, an undeclared route claiming nothing. *Added by the required review of `deaa8a5`, which found that owner process identity fixed connection loss only: a different instance proves the old process is gone, but not that an HTTP request it already sent did not commit. P16c's connection-loss case keeps the same instance, and its restarted-process case has no unresolved external effect allowed to commit late — the two prove two halves and miss the composition that matters. A test that reclaims and then checks for a duplicate does not discharge this: the duplicate must be unrepresentable, not detected.* |
| P16e | **One `write_id` is bound to one route and one effect authority, for its whole life.** Create `W` under a **`supabase`** route, transition it to a retryable state, then present `W` under a **`sheets`** route and prove the request is **refused before any effect** — reported as a route collision rather than as a duplicate, with the stored record **withheld** (a foreign route must not be able to replay another route's response body), the stored row **completely unchanged** (same route, same effect authority, same status, same attempt, no new token, no `ambiguous_at`), and the receipt's **own** route still able to retry. Cover the **reverse** direction. Cover **all three** reclaimable states, not only `failed`: an **expired** row (the most permissive branch), a **prior-process** abandoned attempt, and an **`ambiguous`** row — a foreign route must be refused for collision, never read the row, and never resolve it. Prove `markReceiptAmbiguous` is route-bound in the **statement**, and that `route` and `effect_authority` are both refused to `atlas_app` with SQLSTATE `42501`. *Added by the required review of `5533874`, which found that `route` and `effect_authority` are written only on the initial `INSERT` while the `ON CONFLICT DO UPDATE` path neither rewrites them nor requires the incoming values to match — so a write_id first claimed on a transactional route kept `effect_authority = 'supabase'` when reused on a Sheets route, and the Sheets append became automatically reclaimable after five minutes instead of ambiguous. A mutation that removes the binding must make the behavioural proofs fail; a textual guard alone does not discharge this.* |
| P8a0 | **The receipt claim is executable and self-contained.** A brand-new receipt is proven to carry a **non-null `expires_at`** and to be immediately visible to `peekWrite`. An **expired `completed`** row is proven **atomically reclaimable in the claim statement** — no housekeeping job runs during the test — with `attempt` and `created_at` reset, matching prune-then-insert. The claim is proven to execute **as `atlas_app` under its actual grants**, not as a superuser. |
| P8a | **The receipt TTL epoch resets on retry.** Seed a retryable receipt just under 24 hours old; claim a new attempt; complete it; advance the clock past the **original** expiry but inside 24 hours of the retry; and prove `peekWrite` and duplicate replay still succeed. A retry that inherits the first attempt's expiry fails this. |
| P8b | **DISCHARGED 2026-08-08 — the owner ran the checkpoint against `Atlas Production` and it PASSED with exit code `0`.** *(Outcome in §8.6; full record in the execution plan under "OWNER GATE — `S2` APPLIED AND P8b PASSED". The gate definition below is retained unchanged.)* **NOT AN `S2` MERGE GATE — an owner-gated checkpoint after `S2` is applied to `Atlas Production`, before `S3` begins.** *Corrected by the required review of `039c28c`, which found this gate unproducible under `S2`'s own rules: `S2` applies migrations to a disposable CI database only and is **forbidden** to apply schema to `Atlas Production`, while P2's database is plain Postgres with no Supavisor and no second hosted project is named. As a merge gate it demanded evidence that could only be produced by breaking `S2`'s own constraint or by silently provisioning another hosted project.* What **does** gate the `S2` merge is the local equivalent: the four roles and their exact grants are created and proven on the from-empty Postgres database, as the real roles (P7c). The hosted proof below then runs **after the owner applies `S2` to `Atlas Production`** and **before `S3` starts**, and `S3` may not begin until it passes. **The real Render-compatible connection path works.** Open a **Supavisor session-mode** connection as **each of the four roles** — including the owner-only `atlas_rebuild`, which needs a working connection when a rebuild runs — run a multi-statement transaction, and prove a **session-level advisory lock survives across statements** — the exact behaviour the exporter depends on and the exact behaviour transaction mode would silently break. Prove each pooler connection authenticates as its intended role. Assumed IPv6 reachability does not count as proof. |
| P9 | Every drift and authority guard passes. `npm test`, the Playwright suite, lint, syntax, and the secret scan pass. |
| P10 | **No GitHub-triggered path can reach production** (§8.5). **SATISFIED BY REMOVAL, 2026-08-09** — the owner deleted both project↔repository connections, so no Supabase GitHub integration exists on this repository and there is no OFF setting to show. **Unconditional and enforced today:** no GitHub-triggered path holds a production credential, and none may apply production schema (`npm run check:supabase-safety`, at every head). **Conditional on reintroduction:** *if* an integration is ever reintroduced, production auto-deploy and automatic migration must be shown **OFF** at the exact head, and a merge to the default branch must be proven to leave `Atlas Production`'s migration count unchanged. **P2's database is proven independent of the integration** — it can be absent entirely and P2 still runs, which is what keeps a required proof off a paid plan (ruling D3). **That independence is what made deletion free.** |

### 6.2 Gate for `S3` (backfill, parity and readiness — no cutover)

| # | Requirement |
|---|---|
| P1 | Deterministic tests for every read path the `S4` cutover will move. |
| P2 | Integration tests against a real disposable Postgres database, on the same terms as §6.1 P2. |
| P3 | **Backfill reconciliation.** For each of the four tabs: equal row counts; every row matched by its export identity key; and a field-by-field comparison reporting zero differences after the §4.7 blank/null rule is applied. A count match alone is not reconciliation — identity and content must both be proven. The reconciliation report is committed as evidence, with workout values redacted. |
| P4 | **No in-request Sheets read on the migrated Save path, plus a measured and bounded background dependency.** *Renamed from "No athlete-facing dependency on the Sheets quota" after the required review of `2ce7be3`: a session replay can prove zero in-request reads, and it cannot prove that Save availability is independent of the Sheets quota over the mirror-age window.* Two parts, both required. **(a)** Measured, not asserted: replay `test/fixtures/liveSessionManifest.json` against the prospective read path and record the residual in-request Sheets read count per range. Expected zero on the migrated Save path; the measurement is the proof. **(b)** State and gate the background dependency the catalog mirror introduces: the sync interval, `CATALOG_MIRROR_MAX_AGE`, the fail-closed behaviour past that age, and the exact residual — how long a total Sheets outage may last before a Save fails. **Do not certify unqualified quota independence.** |
| P5 | **Cutover readiness.** Every read `S4` will move returns, against the backfilled database, what the Sheets read returns today **after the frozen owner-approved migration dispositions are applied**. The claim is EQUIVALENCE, not byte identity against the raw tab. Sheets still holds every row the owner excluded, every surplus identical copy, and every legacy session id, so the Sheets side of each comparison is resolved through `migrationLegacyIdentityMap.resolveSheetRows` — the one resolver the backfill and the sweep already call — and its verdicts are consumed verbatim. Three verdicts still REFUSE readiness, with an aggregate redacted reason and no invented identity: an unmapped legacy session id, a genuinely identityless non-blank row, and an owner approval whose multiplicity the tab no longer matches. An undisposed duplicate export identity refuses too. *Stated exactly on 2026-08-13, after the live `Atlas Production` run reported P5 at 2 of 7 while the backfill reconciliation and the five-concept sweep were both clean: `services/migrationReadParity.js` was comparing the raw pre-migration tab, which measured the owner's own rulings as data loss.* |
| P6 | The open-divergence count reaches **zero** and the sweep that established it ran to completion. |
| P7 | The repair path is proven to close a divergence only on a passing re-comparison. |
| P8a | **`atlas.write_freeze` exists, is constrained, is seeded, and is granted as specified — proven by `S3`, not inherited from `S2`.** The migration creates §3.10, and a test proves: a second row is **rejected** by the `CHECK (id)` single-row primary key; the seeded row is present with `frozen = false`; `atlas_app` **can** `SELECT` it; and `atlas_app` is **refused** `INSERT`, `UPDATE` and `DELETE` on it, executed as the real role. A grant written in `S2` proves nothing about a table that does not exist until `S3`. |
| P8b | **The production gate is discharged before any `S3` freeze evidence counts.** The `S3` migration must be applied to `Atlas Production` by the owner (§5.3, owner gate) before P8–P12 can be claimed against the deployed system. Evidence gathered only against the disposable CI database proves the code, not the deployment, and must be labelled as such. |
| P8 | **The freeze activates without a restart.** Update `atlas.write_freeze` while an instance is serving and prove **that same process** — proven by process start identity, not by behaviour alone — refuses the affected routes on its next request. Prove a receipt minted before activation is still decided by the same in-memory map afterwards. An activation demonstrated only across a restart proves the opposite of what §5.5 step 1 needs. |
| P9 | **A replacement instance starts frozen.** Start a new instance while the row says frozen and prove it refuses the affected routes on its **first** request, with no window in which it serves them. |
| P10 | **All seven `beginWrite` routes fail closed**, each with an explicit refusal and **no side effect** — no Sheets append, no shadow write, no receipt claimed. Proven per route, not on one representative route. |
| P11 | **Control loss cannot reopen writes.** With the freeze active, make the freeze read fail — drop the connection, then delete the row — and prove the routes stay refused. Separately prove an instance that has never read the row successfully refuses. Separately prove **no environment variable and no file** can open writes while the row says frozen; a local override would be a second authority. |
| P12 | **Dormant is byte-identical to today.** With `frozen = false`, the athlete-facing responses of all seven routes are unchanged from the pre-`S3` build. |
| P13 | **The receipt migration seam works against the real module.** `exportLiveReceipts()` returns a **memory-only** record that never reached disk, proven by forcing `persistDisabled` — the case a disk read loses. `importReceipts()` replaces the live map of an **already-running** process, proven by a `peekWrite` that returns an imported record the process never loaded from disk; the same proof executed by writing `/tmp` instead must **fail**, because `ensureLoaded` has already run. Both routes are proven **inert when not frozen** — refused with no side effect while `frozen = false`, and refused when the freeze read fails. **The auth negative is proven explicitly:** a request carrying a **valid `atlas_session` cookie and no `x-atlas-api-key`** is **refused** while frozen, even though the ordinary `/api/*` middleware would admit it; only `req.authMethod === 'api_key'` passes. **No second secret exists to configure**, which is itself the proof that no cutover-time environment change is needed. The **single-instance invariant** is proven three ways: with the platform reporting more than one live process the cutover is proven to **abort** — and proven **not** to trigger a scale-down; with two distinct `process_id` values observed across the handover it is proven to abort rather than merge; and **the loss it prevents is demonstrated** — force `persistDisabled`, create a receipt that exists **only** in one process's in-memory map, retire that process, and prove the receipt is gone from both the file and every surviving map. That is the state the old "reduce to one instance first" step would have produced. |

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
| P14c | **Verification spans the whole tab.** Seed one duplicate identity **outside** the allocated range and prove acknowledgement is **refused**, `sheets_export_error` records `mirror_duplicate_identity`, and `sheets_exported_at` stays null. A verifier that reads only its own block cannot pass this. **No `migration_divergences` row is written** — that table is gone by `S4`. |
| P14d | **The export refuses rather than overwrites when its range is not what it expects.** Shift a mirrored tab under a live allocation — delete a row above the block, then export — and prove the worker **writes nothing**, records `sheets_export_error = 'mirror_range_occupied'`, and leaves `sheets_exported_at` unset. Repeat with another session's rows seeded into the block. Prove **the workout itself is unaffected** and that **no post-`S4` path touches `migration_divergences`**. A test that only proves a clean range is written does not discharge P14d. |
| P14i | **A structural refusal does not loop.** Drive a session to `mirror_range_occupied`, then run the export worker repeatedly and prove: the session is **not claimed**, **no whole-tab read is issued for it**, and it stays visible in `atlas:status` as owner action required. Separately prove a transient failure retries only on its bounded backoff and becomes `blocked` at the attempt ceiling rather than retrying forever. Measured in Sheets reads, not in intent. |
| P14h | **Refusal recovers, and only through §5.7, executed as the real principal.** The rebuild must additionally be proven to (a) reset the **whole export-state tuple** so the session actually returns to `queued` rather than staying `blocked`, (b) rebuild only the **closed-session** projection — an **open** workout present during the rebuild must not be projected and must export normally after it closes — and (c) run against a **fixed snapshot**, proven by mutating Supabase mid-rebuild and showing the verification is unaffected and the late session exports afterwards. Beyond that: Drive one structural-drift case to refusal, then run the owner-only mirror rebuild **as `atlas_rebuild` under its actual grants** and prove: the export pauses; the four tabs are reconstructed from Supabase; allocations and cursors are reissued past the new tail; the whole projection verifies; the error clears and `sheets_export_state` returns to `queued`; the session exports. Prove `atlas_rebuild` is **refused** any write to `logged_sets`, `session_effort`, `session_plan_events`, `session_plan_set_recommendations` and `write_receipts` — the grant, not the procedure, is what protects workout authority. A refusal with no proven recovery is a permanent stall, and a recovery no principal may execute is not one either. |
| P14e | **Undo reaches the mirror.** Undo a Save on an already-exported session and prove: the session re-enters the export queue; the rewrite stays **inside its own allocated block**, blanking the tail; no other session's rows are touched; and the cursor does not move backwards. Separately prove `deleteRowsByRange` is **absent** for every mirrored tab. |
| P14f | **Any post-export mutation re-enters the queue.** Mutate an exported session's Supabase data — including a `closeout_write_id` seal — and prove `sheets_exported_at` is cleared and the session is re-exported. A session that changed and stayed exported is a stale mirror. |
| P14g | **A session with no `Effort` row receives no `Effort` allocation**, and the `Effort` cursor does not advance for it. |
| P16a | **The five authority guarantees of `test/idempotencyPersistence.test.js` are re-proven against Supabase**, including **WRITE-3 by its actual mechanism**: an `in_progress` row owned by the **live** process must be **refused** even when older than five minutes, and reclaimable only by a process that is genuinely gone — proven by `owner_instance_id`, never by a released advisory lock. *Corrected by the required review of `ad18907`: the earlier wording made "reclaimable once that connection drops" the guarantee, which is the defect. A test that reclaims on elapsed time, or on a freed lock, proves the opposite of WRITE-3.* The **single-instance invariant** §5.3/§5.5 require is a stated precondition of this rule and must be enforced before `S4` wires it. Also — restart replay, stale-`in_progress` retryability, recent-`in_progress` duplicate blocking, the WRITE-3 rehydrated downgrade, and WRITE-2's `peekWrite` recovery of the server-minted `session_id` — **before** that suite is deleted. A deleted suite whose guarantees were not re-proven is a lost proof, not a cleanup. |
| P16b | **`peekWrite` has a working Supabase implementation with its live consumer (`index.js:2511`) exercised**, and an expired row is proven to read as absent. It must return a **non-null server-minted `session_id`** for a prior attempt — proving the adapter actually persisted it (§3.6) — and an obsolete attempt must be proven unable to overwrite a newer attempt's value. |
| P15 | **The open-divergence count is zero** and every `atlas.migration_divergences` row is `closed`. If not, `S4` does not merge. |
| P16 | **The legacy receipt store is absent.** The file store, `ATLAS_IDEMPOTENCY_FILE`, `/tmp/atlas-idempotency.json` and all six test references are gone, and **no caller remains**, proven by search. *The two-stage `S4a` / `S4b` form of this gate was withdrawn with ruling D6: the `S4` build never needed to carry the legacy implementation, because a rollback restores the previously merged `S3` build, which already contains it, and the rollback data comes from `atlas.write_receipts`.* |
| P17 | The deletion list of §5.4 is verified absent at `S4`. **`atlas.migration_divergences` is the one item whose TABLE outlives the merge** — every consumer and writer of it is verified absent, the table is proven **inert** (no writer, no reader on any post-`S4` path), and the drop is verified present as an owner-run artifact **outside `supabase/migrations/`**, so no migration run can apply it early. Absence is verified in **two** places, not one: in `Atlas Production` when the owner executes that file after the rollback window, and in **a fresh replay of `supabase/migrations/`** once the post-window versioned migration lands (§5.4 step 5). A replay that still creates the table is an open loop even if production is clean. `atlas.write_freeze` and its route check are not on the list — **permanent Atlas safety infrastructure rather than a bridge, and carrying no sunset**, by owner ruling **D7**, APPROVED 2026-08-09 (§5.3, §9). |
| P18 | A second non-counting deployed debug workout, after the cutover. |
| P19a | **The receipt authority is handed over, not discarded, in both directions — against the REAL file shape and the REAL live authority.** Must additionally: **inject the `persistDisabled` persistence-failure fallback** and prove a memory-only receipt crosses the boundary (a disk-only fixture does not discharge this); prove a **retried receipt whose original `created_at` is older than 24 hours but whose refreshed `expires_at` is still live** survives the rollback un-pruned; and exercise the **fresh-at-freeze → stale-after-freeze** `in_progress` record, proving the drain's own normalization (§5.5 step 2 sub-step i) lets the drain reach zero. The fixture must be the actual persisted JSON (`created_at_ms`, `response`, `metadata`, no `expires_at`, no `attempt`), never a schema-shaped stand-in, and must exercise the forward **and reverse** mappings of §5.5a. Additionally: **inject a new receipt concurrent with the rollback** and prove it cannot fall through the reverse freeze/drain/snapshot boundary. Seed the file store with unexpired live state — a completed replay record with a body, a retryable `failed` record, and a server-minted `session_id` — then run the §5.5a handover and prove a **lost-response retry across the cutover** is replayed from the carried receipt rather than treated as new. Prove it for a **server-minted workout** (the retry recovers the prior `session_id`; **no second identity is minted**) **and for at least one non-workout D4 route** (**no second Sheets append**). Then prove the same scenario **across a rollback after writes reopened**. Prove the transfer reads the **live authority** rather than the file alone, and that the carried rows are verified in `atlas.write_receipts` **before** any new decider opens. A handover proven only forwards is proven half. |
| P19b | **The receipt freeze covers all seven callers.** Prove each of the seven `beginWrite` routes fails closed during the freeze, and that no route is left deciding duplicates against the old store while another decides against Supabase. |
| P19d | **The rollback source survives every deploy boundary — and rollback stops when it cannot be read.** Prove both losses: the **cutover deploy** destroying `/tmp` after step 6, and the **rollback deploy** destroying a `/tmp` file written before the old build restarted. In both, the receipt rows committed into `atlas.write_receipts` at step 2a must still restore into the live old process **through the §5.3 seam** before writes reopen — proven by `peekWrite` returning a restored record in a process that never loaded it from disk. Never assert an ephemeral file is "intact" across a deploy. **Then prove the fail-closed case:** with Supabase unreachable during the rollback, prove the code may be restored but the seven writes **stay frozen**, and that a backup older than the newest receipts is **not** accepted as the restore source. |
| P19e | **The cutover aborts when no complete source exists.** With the live map gone and no verified rows in `atlas.write_receipts`, prove the transfer **fails closed**: the freeze stays on, the old decider stays authoritative, no new decider opens, and a stale `/tmp` file does **not** authorize continuing. |
| P19i | **The restored `S3` build runs against the post-`S4` schema.** Deploy the `S3` build against a database carrying the full `S4` schema — `write_id` foreign keys present, `atlas.migration_divergences` **not yet dropped** — and prove its shadow write, sweep and repair worker all operate, that a divergence can be opened, swept and repaired, and that the null `write_id` children it writes satisfy the new foreign keys. Then prove the negative that makes the sequencing matter: with `migration_divergences` **dropped**, the same build **fails** — which is why the drop is gated on the rollback window closing, not on the `S4` merge. |
| P19g | **No partial carry can ever authorize a cutover.** Kill the carry after a **proper subset** of the mapped rows has been written but before `COMMIT`, then restart and re-run the transfer. Prove `atlas.write_receipts` contains **no** rows from the killed attempt, that the resumption rule therefore does not mistake a partial write for a verified carry, and that the cutover either completes the full carry or aborts. Then prove the retry path itself: re-run the committed carry a second time against the same frozen source and prove it converges — same set, no duplicate, no abort. |
| P19h | **An extra unexpired destination receipt aborts the transfer.** Seed `atlas.write_receipts` with an unexpired `completed` row that the live source does **not** hold, run the carry, and prove the transaction **aborts**, the row is neither removed nor accepted, no new decider opens, and the freeze stays on. Then prove the benign case is not caught by it: an **expired** row left by an earlier attempt does not abort. An extra unexpired receipt that survived into the new authority would make a genuinely new `write_id` replay as a duplicate — a lost write. |
| P19c | **The freeze does not itself destroy the transfer source, and an unrelated loss at that boundary aborts rather than proceeds.** *Narrowed by the required review of `4f8e180`: the earlier wording demanded the receipt set survive a process-and-filesystem loss **at** the freeze boundary, which this design cannot provide — the durable set does not exist until step 2a, and no set is closed before the freeze, so none can be made durable earlier.* Two parts. **(a)** Activation is **restart-free**: the process serving before activation is the same process after it (process start identity), and a receipt minted before activation is still decided by it afterwards. The freeze is therefore not itself a loss event. **(b)** If the old process and its filesystem are lost at that boundary anyway, the transfer finds neither a live map nor verified rows in `atlas.write_receipts`, and the cutover **fails closed** by P19e — the freeze stays on, the old decider stays authoritative, no new decider opens, and a surviving `/tmp` file does not authorize continuing. The design claims no mechanism that preserves receipts across that loss (§11). |
| P19f | **The drain normalizes before it asserts** (§5.5 step 2, sub-step i before sub-step ii). Seed a `rehydrated` `in_progress` record **just under** `STALE_IN_PROGRESS_MS` at the moment of freeze, then run the drain and prove it crosses the threshold, is normalized to `failed` **by the drain itself**, and the zero assertion succeeds. Prove the normalization repeats until no abandoned record remains. A drain that asserts before normalizing deadlocks here. |
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
| `S4` | Revert the PR — which restores the previously merged `S3` build and with it the legacy receipt implementation **and the migration seam** — then **prove exactly one live restored old process** by the §5.3 invariant and restore the committed receipt rows from `atlas.write_receipts` into **that** process through the seam (§5.5a reverse transfer). Then re-import any session written to Supabase after the cutover into Sheets. **If the single-process invariant is not satisfied, writes do not reopen.** *Corrected by the required review of `eae382e`: this row still said "every live old process", the unaddressable collector shape review 13 removed.* The post-`S4` schema stays `S3`-compatible for the whole window, because the `migration_divergences` drop is applied only after the window closes (§5.5, gate P19i). | Real. The only irreversible step, which is why it needs an owner gate, a verified backup, and the receipt rows in `atlas.write_receipts` as its rollback source. **Rollback is not unconditional:** if those rows cannot be read and verified, the code may be restored but the seven writes **stay frozen** (P19d). |

Ruling D5 concentrates all the risk into one step and leaves the two steps before it fully
reversible. That is the point of it.

### 7.3 The `S4` rollback window

Before `S4` merges, record:

1. a verified Supabase backup and a proven restore (§8.4);
2. the exact export command that reproduces a Sheets row set from Supabase;
3. a stated rollback window — the period during which a revert is a supported operation
   rather than a data-recovery exercise. **The window's close is the trigger for BOTH deferred
   closure steps, not one.** *Corrected by the required review of `eae382e`.* **Step 1:** the
   owner executes `supabase/operations/drop_migration_divergences.sql` against
   `Atlas Production` as `atlas_migrate`, converging production. **Step 2:** the same statement
   enters `supabase/migrations/` as a normal versioned file so a fresh replay converges too —
   delivered by the one bounded cleanup PR **ruling D8 approved** (§5.4 step 5, §9). Step 1's file is
   **not** a pending migration and no `db push` can apply it early
   (§5.4 step 5). Until it runs the table stays, inert, so a restored `S3` build works
   (§5.5, gate P19i).

If any of the three is missing, `S4` does not merge.

---

## 8. Security design

### 8.1 The access model — Supavisor session mode, with scoped roles

**Correction, from the required review of `5f42d3c`.** An earlier version of this section
specified a single service-role key **and** separate least-privilege roles **and** `DELETE`
on `logged_sets` only — while §3.7 required a transactional catalog swap that needs `DELETE`
on the mirror. Those cannot all be true at once. One service-role key does not authenticate
as three distinct database roles, and the stated grants could not perform the described
operations. The model below is the one executable choice, and the grants match what the
design actually does.

**Second correction, from the required review of `771ff83`. "Direct Postgres" was not executable
on this deployment.** Supabase's direct database endpoint is **IPv6** on the Free plan, and
Supabase's own IPv4/IPv6 troubleshooting page lists **Render** among IPv4-only hosts. The
IPv4 add-on is a paid feature and so conflicts with the owner's Free-tier ruling. A design
that specifies a connection Render cannot open has specified nothing.

**Owner ruling (2026-08-07): Atlas runtime connects through Supavisor in SESSION MODE
(port 5432).** Not the direct endpoint, and **not transaction mode**.

- References: [connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) ·
  [IPv4/IPv6 compatibility](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP).
- **No paid IPv4 add-on.**

**Why session mode specifically, and why transaction mode would break this design.** Supavisor
transaction mode returns a different backend connection per transaction, so anything scoped to
a *session* rather than a transaction does not survive. This design has exactly such a
dependency: the export's `pg_try_advisory_lock` is a **session-level** lock held across
read-back, write, verify and acknowledge (§5.4). Under transaction mode that lock would be
taken and released on a connection the next statement may not even be using — it would appear
to work and hold nothing. Session mode preserves the semantics the adapter needs.

**Migration and read-only tooling.** They may use the direct endpoint **only from an
environment whose IPv6 reachability is actually proven**, not assumed. GitHub Actions is also
IPv4-only, so CI uses the session pooler. Where reachability is not proven, tooling uses the
session pooler too.

**The scoped roles are unchanged (§8.2), and each gets its own pooler connection.**
Supavisor authenticates the role through the pooler username, so role separation survives
pooling — it is not collapsed into one shared identity. Each role's pooler connection string
is a separate secret. **Proving that each one authenticates as its intended role through the
pooler is NOT an `S2` merge gate** — `S2` may not apply schema to `Atlas Production` and its
from-empty Postgres database has no Supavisor, so `S2` proves the roles and grants locally
(P7c) and the hosted session-pooler authentication and advisory-lock proof is the **owner-gated
checkpoint between `S2` and `S3`** (§6.1 P8b). *Corrected by the required review of `eae382e`,
which found this security section restoring the impossible `S2` gate that P8b had just
removed.*

**Atlas does not use the Supabase Data API, the service-role key, or the anon key.**

Why not the Data API:

- The design needs **multi-statement transactions** (the Save, the seal, the catalog swap).
- It needs **session-level advisory locks** to serialise export workers (§5.4) — for
  throughput, not for correctness. The Data API has no equivalent.
- It needs **real role separation**. A service-role key is one identity that bypasses RLS;
  it cannot express "this connection may not run DDL".

Consequences, stated plainly:

- **There is no service-role key and no anon key in the runtime path**, so the entire class
  of key-leak and RLS-bypass exposure that comes with them does not arise here.
- Credentials are Supavisor session-mode connection strings, one per role, read from
  environment variables on the server only.
- The connection is held by one module — the adapter of §5.2 — exactly as the read-write
  Sheets client is held only by `sheets.js`.
- **No Supabase credential of any kind appears in browser code.** `src/app/` never imports a
  Supabase client, never receives a connection string, and never contacts Supabase directly.
  The browser keeps talking to the Express API.

### 8.2 Least privilege — four roles, and the exact grants

Four distinct database roles, each with its own credential: three for the application and its tooling, and one owner-only principal that exists solely for the §5.7 rebuild.

**`atlas_app`** — the runtime role, used by the Express server.

| Grant | Objects |
|---|---|
| `SELECT` | every table in `atlas` |
| `INSERT` | every table in `atlas` **except `write_freeze`** |
| `UPDATE` (column-scoped) | `closeout_write_id` on `session_plan_set_recommendations`; `status`, `attempt`, `attempt_token`, `attempt_started_at`, **`created_at`**, **`expires_at`**, **`session_id`**, `response_body`, `rows_written`, `appended_range`, `completed_at` on `write_receipts`; `sheets_exported_at`, `sheets_export_attempts`, `sheets_export_error`, **`sheets_export_state`**, **`sheets_export_next_attempt_at`**, `export_claim_token` on `workout_sessions`; `next_row`, `base_established_at` on `sheets_mirror_cursor`; `status`, `verified_at`, `last_error` on `exercise_catalog_sync`; the state columns on `migration_divergences` while it exists |

*`created_at` and `expires_at` were missing from this list while the retry claim updated both — the claim was permission-denied under its own security model. Corrected from the required review of `0e324ac`.*
| `DELETE` | `logged_sets` (undo), `exercise_catalog_mirror` (the §3.7 generation swap), and `migration_divergences` while it exists. **Never on a Sheets tab** — the export does not delete mirror rows to correct itself (§5.4). |
| `EXECUTE` | `pg_try_advisory_lock` / `pg_advisory_unlock` (available to any role; named here because the export depends on it) |

It holds **no** `DROP`, `ALTER`, `TRUNCATE`, or other DDL grant. The catalog swap uses
`DELETE` inside a transaction rather than `TRUNCATE` precisely so the runtime role needs no
DDL privilege.

**`atlas.write_freeze` is `SELECT`-only for `atlas_app`** — no `INSERT`, no `UPDATE`, no
`DELETE`. The runtime reads the freeze; it can never lift it. `atlas_migrate` holds one scoped
`INSERT` on that table, used once by the `S3` migration to seed the single dormant row.
**`UPDATE` on it is granted to no role in this list**: it is executed by the Supabase project
owner role, which is the owner-authentication boundary §5.3 relies on. P11 proves the runtime
cannot open writes by any local means.

**`atlas_migrate`** — **migration-only: DDL, plus exactly ONE declared DML operation.**
*Corrected by the required review of `310b01b`, which found it described as "DDL only" while
the design assigned it DML in two places; narrowed back to one by the required review of
`65310b3`, finding 1.* Used by migration runs in CI and by the owner-run application to
`Atlas Production`. **Never used by the server at runtime.**

| Operation | Objects | Why it is not `atlas_app`'s |
|---|---|---|
| DDL | every object in `atlas` **except `atlas.write_freeze`** | schema is never a runtime privilege |
| the cutover receipt carry | `INSERT`, `UPDATE`, `DELETE` on `atlas.write_receipts`, for the one crash-atomic transaction of §5.5a step 5 | `atlas_app` deliberately holds **no `DELETE`** on `write_receipts` — a runtime role that could delete a receipt could erase duplicate protection |

**`atlas.write_freeze` is the one object this role touches at all.** The `S3` migration seed was
previously counted as its second declared DML operation. It is not: the seed runs as the
**applying principal**, which owns that table, and `atlas_migrate` holds **no privilege on it
whatsoever — not even `SELECT`** — and does not own it, so it can neither write the control nor
alter nor drop it. A migration role able to drop the control could remove the freeze, and D7
recognises exactly one mutator.

It holds no other DML on any table. P7c executes the declared operation **as this role**, and
§6.2 P8a proves the `write_freeze` refusals as each real role.

**`atlas_readonly`** — `SELECT` only, on every table in `atlas`. Used by
`npm run atlas:status` and `npm run atlas:review-live`, mirroring the existing rule that
read-only tools build their own `spreadsheets.readonly` client.

**`atlas_rebuild`** — the owner-only principal for the §5.7 mirror rebuild, and nothing else.
*Added by the required review of `0e324ac`, which found the rebuild owner-gated but executable by
no declared principal: `atlas_app` holds no `DELETE` on `sheets_mirror_allocations`,
`atlas_migrate` holds no DML on it either — its one declared DML operation is scoped to
`write_receipts` — and `atlas_readonly` is `SELECT` only. A recovery path no
credential may execute is not a recovery path.*

| Grant | Objects |
|---|---|
| `SELECT` | every table in `atlas` |
| `DELETE`, `INSERT` | `sheets_mirror_allocations` — clear and reissue |
| `UPDATE` | `next_row`, `base_established_at` on `sheets_mirror_cursor` |
| `UPDATE` | `sheets_export_state`, `sheets_export_error`, `sheets_export_next_attempt_at`, `sheets_exported_at`, **`sheets_export_attempts`**, **`export_claim_token`** on `workout_sessions` — the **complete** tuple §5.7 step 5 resets. A rebuild that may reset four of six columns is permission-denied on the other two. |

It holds **no** grant on `logged_sets`, `session_effort`, `session_plan_events`,
`session_plan_set_recommendations` or `write_receipts` beyond `SELECT` — so the rebuild
**cannot touch Supabase workout authority**, which §5.7 requires and which is now enforced by
the grant rather than by the procedure's good intentions. It holds no DDL.

**Its credential is not configured in the Render runtime.** It is owner-operated and supplied
only for the duration of a rebuild, which is what preserves the rule that the normal runtime
cannot rebase allocations. This is one role and one procedure — **not** a generic admin
framework.

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
  matter under §8.1**; service-role JWTs, anon keys and the `sb_secret_` / `sb_publishable_`
  formats are also matched, so a later reintroduction of the Data API cannot slip a key past
  the scanner. The existing rule holds, with its scope now stated exactly: **no secret, no
  `.env`, no separately governed production identifier — the production Sheet ID being the
  named example — and no private workout data** in a commit or a PR. **"Production id" here
  does NOT include the Supabase project reference**, which the owner ruled non-secret on
  2026-08-09 (next bullet). Every credential restriction is unchanged; only the classification
  of that one identifier is.
- **The project reference is a NON-SECRET project IDENTIFIER.** *Owner ruling, 2026-08-09,
  recorded in [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md).* It is
  metadata: **not a password, not a key, not a token, and not an authorization mechanism**.
  Possessing it grants nothing — every path into `Atlas Production` still requires a
  credential §8.1 governs. **Exposure of the reference alone therefore requires no rotation
  and no project replacement**, and the scanner carries **no project-reference rule**; the one
  that existed is deleted, and nothing — no detector, no masking mechanism — replaces it.
  *This ruling changes the classification of the reference and nothing else.*
- **Credentials stay secret, and this ruling does not touch them.** Postgres and database
  connection strings, passwords, `ATLAS_SUPABASE_*` role URLs carrying credentials, Supabase
  secret and service-role keys, OAuth tokens, private keys, the production Sheet ID and every
  other separately governed identifier remain **prohibited** from the repository, a PR body,
  an evidence file, and GitHub Actions. **The boundary is authentication material, not
  identifiers**, and the scanner gives exactly that one answer: a bare reference or a
  reference-bearing hostname passes, while the identical host carrying a password is refused
  by `postgres-connection-string-with-password`. `test/secret-scan.test.js` and
  `test/supabaseMigrationS2.test.js` prove both halves.
- **Backups.** Before `S3`'s backfill and before `S4`'s cutover, take a backup and prove a
  restore into a scratch database. A backup that has never been restored is not a backup.
  `npm run backup:sheets` remains and keeps covering the Sheets mirror.
- The `S4` gate requires a restore proof, not a backup setting.

### 8.5 The Supabase GitHub integration — REMOVED 2026-08-09, and what it may not do if it returns

**Current state: there is no Supabase GitHub integration on this repository.** On 2026-08-09
the owner removed **both** Supabase project↔repository connections pointing at this repository,
from the Supabase organization's Integrations page. The removal is owner action, out of band; no
repository path performed it and none may be added.

**Why it was removed, and what the reference exposure did and did not mean.** The history, in
order:

1. While reviewing PR #1279, the integration's public `Supabase Preview` check target was found
   to carry the **project reference**.
2. Under the **then-current** §8.4 policy the reference was classified as a secret, so that
   observation triggered an **owner security review**. It was routed to Dale as
   `OWNER DECISION REQUIRED` rather than folded into #1279, because the integration predated
   that PR.
3. **Dale removed both project↔repository integrations** — on the grounds that the integration
   was **unnecessary**, not that it had leaked authentication material. It had no consumer
   here, so deletion was simpler than retaining unused infrastructure and stronger than adding
   a layer to hide what it published.
4. **Dale has since ruled the project reference NON-SECRET** (2026-08-09, §8.4): it is a
   project identifier, not a password, key, token, or authorization mechanism.

**Therefore the historical check targets are not an unresolved credential leak, and they
require no rotation, no project replacement, and no remediation.** What appeared there was
metadata. **No credential was ever exposed by that path**, and the credential rules of §8.4 are
unchanged. The integration nonetheless **stays removed** — the reclassification does not
resurrect a component nobody needed — and **nothing replaces it**: no masking layer, no
fallback, no adapter, no reconciliation mechanism. **Net architecture complexity decreased.**

*The paragraphs below are retained because they remain the governing constraints. They were
written when the integration existed (added by the advisory review of `ec53270`); they now
describe what may not happen **if one is ever reintroduced**, and reintroduction itself
requires a **new explicit owner security decision**. **The project reference is not a
constraint on that decision** — §8.4 classifies it as non-secret identifier / metadata, so
there is **no requirement to hide it** and no masking mechanism or replacement detector may be
added to do so. What binds a reintroduction is what binds everything else here: **credentials
and production authority**, in the constraint list below.*

**It was never the P2 database, and P2 never depended on it.** That independence is why its
removal costs this migration nothing: the schema proof runs against a plain disposable Postgres
instance and always did.

**What it may NOT be: the P2 database.** *Corrected by the required review of `8195632`, which
found the previous version selecting a mechanism that contradicts the owner's own tier ruling.*
Two independent reasons, either of which is disqualifying:

- **Plan.** Supabase's PR preview **Branching is a paid-plan feature**, and ruling D3 records
  `Atlas Production` as a **Free-tier** project. A required proof that cannot run under the
  recorded tier is not a proof; it is a purchase order written as a gate.
- **Lifecycle.** A preview branch is **PR-scoped**, not run-scoped: it persists across commits,
  applies only newly-added migrations, and disappears when the PR closes. P2 requires a
  database **created and destroyed per CI run**, applying the migration set **from empty**.
  Those are different guarantees, and the weaker one hides exactly the class of defect P1 and
  P7a exist to catch — a constraint that passes because an earlier commit's data or an
  earlier commit's schema is still there.

**What the P2 database actually is.** A **plain disposable Postgres instance recreated for the
exact CI run** — a Postgres service container in the job, or the local Supabase stack — with
every file in `supabase/migrations/` applied from empty, and destroyed with the job. It needs
**no Supabase plan at all**, which is what makes it compatible with D3. The migrations are the
same files `Atlas Production` will receive, so the proof is about the real schema.

If the owner later changes tier, a hosted preview branch may be added as an **optional
acceleration**. It may never become the authority for P2 while D3's Free-tier ruling stands.

**What it may not do, and this is the load-bearing half.**

- **Production auto-deploy and automatic migration must be OFF.** No branch merge, no push, no
  workflow run and no GitHub event may apply a migration to `Atlas Production`.
- **No GitHub-triggered path may hold a production credential.** The preview path gets
  preview-branch credentials only. `Atlas Production`'s connection strings and role passwords
  stay out of Actions entirely — they are the credentials §8.1 says matter, and §8.4 already
  forbids committing them.
- **Production schema application stays an owner gate**, executed by Dale against
  `Atlas Production` (§9). A green preview check is evidence about a disposable database and is
  **never** evidence that production schema is correct or applied.
- **Reintroduction is itself an owner security decision.** No agent may reconnect a Supabase
  GitHub integration, and no PR may add one as a side effect. *The project reference is **not**
  a reason to refuse one — §8.4 now classifies it as non-secret metadata — so the standing
  constraints are the credential and authority ones above, not an identifier rule.*

**Proven, not assumed — and what P10 now requires.** **There is no integration, so there is no
OFF setting to show and no auto-deploy path to disprove.** That is a stronger state than a
toggle: a path that does not exist cannot be switched back on by a settings change.

- **Unconditional, and true today.** No GitHub-triggered path may hold a production credential,
  and no GitHub-triggered path may apply production schema. `npm run check:supabase-safety`
  enforces the second mechanically, at every head.
- **Conditional on reintroduction.** *If* a Supabase GitHub integration is ever reintroduced,
  production auto-deploy and automatic migration **must be shown OFF at the exact head**, and a
  merge to the default branch **must be proven not to change `Atlas Production`'s migration
  count**. A setting nobody has looked at is a setting nobody controls.

### 8.6 The `S2` → `Atlas Production` owner-gate runbook

> **EXECUTED 2026-08-08 — PASS.** The owner ran every step below against `Atlas Production`.
> The eight reviewed migration files are applied unmodified, local and remote migration history
> match, and step 6's checkpoint **PASSED with exit code `0`**: four roles authenticated as
> themselves through Supavisor session mode on port 5432, a multi-statement transaction stayed
> on one backend, a session-level advisory lock survived across statements and released, the
> eleven `S2` tables were present, `atlas.write_freeze` was **absent**, no unreviewed `atlas`
> table existed, the four roles existed, and `atlas_app`'s column-scoped `write_receipts`
> `UPDATE` grant was exactly the declared set with `route` and `effect_authority` not updatable.
> Step 7's condition is therefore met: **`S3` may begin from this gate**, and it has not begun.
> No credential, connection string, project reference or hostname is recorded anywhere in this
> repository (§8.4). **The procedure below is the one that was executed, and its steps are
> unchanged.** **TWO editorial corrections were made to it after the run**, both to *rationale*
> text and both because the retired "the project reference is a secret" classification survived
> in prose after §8.4 reversed it:
>
> 1. **Step 3** — the parenthetical rationale for ignoring `supabase/.temp/` cited that retired
>    policy, and now cites the **credential-bearing and transient CLI state** that is the real
>    reason.
> 2. **Step 6** — the rationale for supplying `ATLAS_SUPABASE_EXPECTED_PROJECT_REF` at run time
>    cited that retired policy, and now cites the real reason: it **binds the checkpoint to the
>    owner-selected production target**, so the gate cannot be discharged against the wrong
>    hosted project.
>
> **Neither correction changed an executable step, the step order, an action, a gate
> requirement, the target-binding or fail-closed behaviour, or any PASS evidence.** The variable
> stays required and its absence stays a `FAIL`. **The executed P8b PASS therefore stands, and
> the gate that PASSED is the gate recorded here.**

*Added when the gate was prepared.* Every step below is **owner-executed, out of band**. No
repository path performs any of it, and none may be added: `scripts/apply-supabase-migrations.js`
refuses every hosted host with no flag to lift it (§6.1 P10), and `npm run check:supabase-safety`
proves no workflow can reach production. This section records the procedure so it is governed
rather than improvised; it grants no authority and moves no gate.

**Preconditions, as they stood when this runbook was prepared, at `main` `5dbc99d` — before the
gate was run.** `S2` was merged; the eight migration files under `supabase/migrations/` — which
define the eleven `S2` tables — were the exact reviewed set; the schema **was at that time applied to no persistent or hosted
target**; no Supabase connection string of any role was configured. *The third precondition was
consumed by running this runbook: the schema is now applied to `Atlas Production`. The fourth
still holds today.* This block records the entry state of a completed procedure. It is not a
statement about the present.

1. **Confirm the dashboard half of P10 first, before anything is applied.** Production
   auto-deploy **OFF** and automatic migration **OFF** on the `Atlas Production` project. This
   is owner evidence `S2` deliberately did not claim, and it must hold *before* a migration
   exists to be auto-applied, not after.
2. **Confirm the project is empty.** Zero public tables, zero migrations, no `atlas` schema.
   The migrations are written to apply **from empty**; a non-empty target is a different
   operation, and this runbook does not cover one.
3. **Apply the eight files in lexical order, as the project owner role.** If linking inside a
   checkout of this repository, note that `supabase/.temp/` is git-ignored because it is CLI
   transient state that can carry **credential-bearing** connection and configuration
   artifacts. *It is not ignored for the project reference: §8.4 classifies that as non-secret
   metadata (owner ruling 2026-08-09).* `supabase/config.toml` is deliberately tracked —
   `supabase init` writes only a local directory name there. They create the four
   roles and run `ALTER … OWNER TO atlas_migrate`, so a lesser principal cannot apply them.
   Any owner-side path is acceptable — Supabase CLI against the linked project, or the SQL
   editor, file by file in order. **Apply them unmodified**: the reviewed bytes are the proof
   surface, and an edit made during application is an unreviewed migration.
4. **Give the four roles LOGIN and a password each.** The migrations deliberately create every
   role `NOLOGIN` with **no password**, because §8.4 forbids a credential in the repository.
   Four separate credentials, one per role — sharing one defeats §8.2 entirely.
5. **Compose four Supavisor SESSION-mode connection strings**, port **5432**, one per role
   (§8.1). The pooler username is **`[DB-USER].[PROJECT REF]`** — the four Atlas roles are
   **custom** database roles, so the user part is `atlas_app`, `atlas_readonly`,
   `atlas_migrate`, `atlas_rebuild`, **not** `postgres`. Supavisor authenticates the role
   through that username, which is what makes §8.2's role separation survive pooling. Not port 6543: transaction mode returns a different backend per transaction, and the
   §5.4 export's session-level advisory lock would appear to work and hold nothing. Keep all
   four out of the repository, out of any PR body, and out of GitHub Actions (§8.4, §8.5).
6. **Run the checkpoint** with those four strings **and the expected project reference** in
   the environment — `ATLAS_SUPABASE_EXPECTED_PROJECT_REF`, supplied at run time because it
   **binds the checkpoint to the owner-selected production target**, so the gate cannot be
   discharged by proving the wrong hosted project. *It is **not** supplied at run time for
   secrecy: §8.4 classifies the reference as non-secret identifier / metadata.* Run
   `npm run atlas:p8b` (add `-- --json` for the machine record).
   **It is required, and its absence is a `FAIL`.** Every hosted Supabase project shares the
   same `*.pooler.supabase.com` host shape, so without it four strings aimed at a different
   project carrying the same schema would satisfy every other check and discharge this gate
   without ever touching `Atlas Production`. The checkpoint also requires all four roles to
   resolve to **one** project, and **opens no connection at all** until the project is
   identified — a result gathered from an unknown target would read as a fact about production.
   Neither the expected reference nor the actual one is ever printed — **retained as a
   conservative default, not as a secrecy requirement**. It is read-only, applies no
   schema, and writes no row. It proves, per role: the pooler authenticates as the **intended**
   role; a multi-statement transaction commits on one pinned backend; and a **session-level
   advisory lock survives across later statements**. It then verifies the eleven `S2` tables are
   present, `write_freeze` is **absent**, no unreviewed table exists, the four roles exist, and
   `atlas_app`'s column-scoped `UPDATE` grant on `write_receipts` is exactly the declared set
   with `route` and `effect_authority` **not** updatable.
   **It fails closed**: a missing credential, an unreachable host, a transaction-mode endpoint
   or a direct-endpoint host is a `FAIL`, never a skip. Exit `0` is `PASS`; exit `1` is `FAIL`.
7. **`S3` begins only on `PASS`.** A `FAIL` is a blocker, not a warning.

**What this gate does NOT do.** It enables no athlete-facing read or write, sets
`ATLAS_SUPABASE_SHADOW_WRITE` nowhere, and moves no authority: Google Sheets plus
`services/idempotency.js` remain the sole live authority through `S3`, and Supabase becomes the
decider only at `S4`. Applying the schema makes `Atlas Production` a **persistent hosted
migration / bridge target** — schema existence, not runtime integration, and not a live shadow
path: the lane stays dormant and unconfigured. It is not a competing authority (§9, concept 18
of the authority map).

---

## 9. Data ownership

The record below is the summary. The per-concept record is
[`docs/ATLAS_SYSTEM_AUTHORITY.md`](./ATLAS_SYSTEM_AUTHORITY.md), concept 18.

| Field | Value |
|---|---|
| **Current winner** | Google Sheets, through `sheets.js`, for all seven concepts, plus the file-backed store in `services/idempotency.js` for write receipts. |
| **Intended winner** | Supabase. Sheets becomes an export mirror for the migrated concepts, and stays the editing authority for `Exercise_Catalog`. |
| **Bridge** | The shadow write, `atlas.migration_divergences`, the reconciliation sweep, and the repair worker. **Exists through `S2` and `S3` only; the runtime stays dormant until configured.** That is a lifecycle bound, not a runtime claim: no Supabase role connection string is set in any live Atlas environment, so none of the four runs today. The `S4` sunset below is unchanged. |
| **Exact sunset** | **`PR S4`** deletes every consumer and writer of the four bridge components plus the §5.3 receipt migration seam, and ships the `atlas.migration_divergences` drop as an **owner-run artifact outside `supabase/migrations/`**, executed after the rollback window closes (§5.4 step 5, §5.5). Closure is **two steps**: that execution converges `Atlas Production`, and a post-window versioned migration converges the repository's reproducible schema. **The chain is not closed until both land** — an out-of-band drop alone leaves every fresh replay recreating the table. and deletes the Sheets hot-path reads, the read-budget machinery, the backfill script, the verify-range route, and the file-backed idempotency store with its env var, its file and its six test references — proving no caller remains. `S4` itself is one PR, one merge, one exact-head review — but **the migration's sunset is not `S4`'s merge**: it is reached only when the owner-run drop and the bounded post-window cleanup PR (ruling D8) have both landed. The one thing `S4` does not delete is `atlas.write_freeze` and its route check, **permanent Atlas safety infrastructure** rather than a bridge, carrying a named permanent consumer and **no sunset** — owner ruling **D7**, APPROVED 2026-08-09 (§5.3, §9). |
| **Code and tests deleted at closure** | The list in §5.4 step 3. **Nothing on it survives `S4`.** |
| **Net complexity after migration** | Expected **negative**. Removed: the per-request `batchGet` read context, the route range declarations, the 30-second row cache, the session read-budget harness and its fixture, the reconstruction script, the read-budget document, the verify-range route and its client fallback, and the file-backed idempotency store. Added: eleven permanent tables — including `atlas.write_freeze` with its per-route check, permanent by owner ruling D7 (2026-08-09) — one adapter module, the `Exercise_Catalog` sync, and the asynchronous export worker. The twelfth table, `atlas.migration_divergences`, and the whole bridge are temporary and are dropped. This expectation is **not yet measured**; `S4` must report the actual net line and module change. |

### Owner rulings — D1 through D5, all resolved

The required review of `b38de8b` resolved every open decision. They are recorded here as
rulings, not as questions.

**D1 — `Exercise_Catalog` mirror: RESOLVED, build it.** Add the read-only mirror
(§3.7) needed to remove the last **in-request** Sheets read from the migrated Save path. It
bounds rather than eliminates the background dependency, in the wording P4 adopts. Sheets remains its
editing authority; Supabase is the Save-path read mirror.

**D2 — Constitution amendment: RESOLVED, content dictated (extended 2026-08-07).** The
amendment additionally carries the **mirror editing contract** of §5.6: after cutover the four
migrated tabs are generated export surfaces, Supabase is the sole editing authority for
migrated workout data, `Exercise_Catalog` remains Sheets-edited, and structural edits to the
generated tabs are unsupported. The editing boundary belongs where the storage boundary is
stated. Amend `docs/CONSTITUTION.md`
before the cutover so that **Supabase wins for migrated hot-path concepts**, **Sheets wins
for unmigrated concepts**, and **Sheets is the export mirror for migrated concepts**. Lines
14 and 55 carry the current claim. The amendment lands before the `S4` cutover — not before
`S3`, because ruling D5 means `S3` moves no authority. Dale writes the amendment; no agent
writes Constitution text.

**D3 — the Supabase project: RESOLVED.** Use the owner-created Free-tier project **Atlas
Production**, `us-west-2`. **As ruled**, it was verified healthy and empty — zero public
tables, zero migrations — and applying a schema to it was a separate owner action, still
outstanding at the time of the ruling. No identifier and no credential is committed.

> **D3's project state is SUPERSEDED as of 2026-08-08; the ruling itself stands.** The
> selection of `Atlas Production` and the no-identifier-no-credential rule are unchanged and
> still binding. What is no longer current is the *empty* state: the owner applied the `S2`
> schema on 2026-08-08 under owner gate 1(a), and the hosted P8b checkpoint **PASSED** with
> exit code `0`, so the project now carries the eleven `S2` tables and the four scoped roles.
> **The `S2` application is not pending.** Every *further* schema application — `S3`'s
> `write_freeze`, `S4`'s cutover schema, and `S4`'s deferred drop — remains a separate owner
> gate. The runtime is still unconfigured, no connection string is set in any live Atlas
> environment, and no read or write authority has moved.

**D6 — the `S4` repository topology: WITHDRAWN by owner ruling (2026-08-07).** The chain stays
the owner-approved **four** PRs, `S1 → S2 → S3 → S4`, and the `S4a` / `S4b` topology is deleted
from this design. D6 assumed the cutover build had to retain the legacy receipt store as its
rollback source. The durable-capture correction of review 10 had already removed that premise:
the rollback **data** is the verified receipt rows in `atlas.write_receipts`, and the rollback
**code** is the previously merged `S3` build, which a revert restores and which already
contains the legacy implementation. `S4` therefore never needed to ship code with no surviving
consumer, and no fifth PR is required **for the reason D6 was raised about**. *Narrowed by
ruling D8 (2026-08-07): "no fifth PR is required" was later found not to describe the chain,
because reproducible schema history needs one post-window cleanup PR that D6 never considered.
D6's substance stands — no PR retains code with no surviving consumer — and D8 records the one
approved exception.* `S4` deletes the store, its env var, its file and its
six test references exactly as ruling D4 always said, and the gate split introduced for the
two-stage form is withdrawn with it (P16, P17).

**D8 — the schema-history closure needs a fifth repository change: RESOLVED by owner ruling
(2026-08-07). Option (a) approved — exactly one narrowly scoped post-window cleanup PR.**
Raised by the required review of `eae382e`.

The facts are settled and not in dispute. `S4` cannot drop `atlas.migration_divergences`,
because a restored `S3` build queries it through the rollback window. An owner-run operations
file converges `Atlas Production` after that window. But it sits **outside migration history**,
so every fresh database built by replaying `supabase/migrations/` recreates the bridge table
forever — production right, repository permanently wrong. The statement must therefore also
land as a **normal versioned migration**, and that is a repository change with a branch, a PR
and an exact-head review.

The topology was Dale's to decide, because ruling **D6** said the chain stays four PRs and "no
fifth PR is required", and because `CLAUDE.md` requires an explicit owner-approved reason for a
positive open-loop change. The builder may not reinterpret an owner ruling, and the head at
`eae382e` did exactly that with its "owner acknowledgement at the `S4` gate" wording. That is
withdrawn, and the question was put to the owner instead.

**The ruling: option (a).** Exactly **one** narrowly scoped post-window cleanup PR is approved.
After the `S4` rollback window closes and the owner-run drop has converged `Atlas Production`,
one follow-up repository PR may add the same statement to normal versioned migration history so
every fresh replay of `supabase/migrations/` converges without recreating the temporary bridge
table.

**The bounds are part of the ruling, not commentary.** The cleanup PR:

- does **not** reopen `S4a` / `S4b`, and retains no dead code;
- moves **no runtime authority** and changes **no workout data**;
- adds **no new framework, bridge, or feature**;
- exists **only** to close reproducible schema history, after the future rollback-window
  trigger.

**The migration remains open until both the owner-run production drop and this repository
cleanup land.**

**What this changes elsewhere.** The chain is now **four PRs plus one narrowly scoped
post-window cleanup PR**. D6 is unaffected in substance — it refused a fifth PR that would
*retain* code with no surviving consumer, and this one *removes* a table — but its literal
"no fifth PR is required" no longer describes the chain, and every surface says so. The two
closure **steps** were always required; the ruling settles only the repository shape of
step 2.

**D7 — the write freeze is PERMANENT Atlas safety infrastructure, not a bridge: RESOLVED by
owner ruling (2026-08-09), APPROVED.** Raised as a proposal for owner confirmation at the `S3`
gate, and ruled there. It is now settled authority, and no section may describe it as open.
§5.3 specifies one bounded control — a single row in `atlas.write_freeze`, `SELECT`-only
to the runtime, written only by the Supabase project owner, read per request with no cache,
and fail-closed on any read failure. It carries **no sunset**, for two exact
reasons the ruling adopts: `S4` cannot delete it, because the `S4` reverse transfer freezes the
`S4` build itself; and it has a named permanent consumer in `CLAUDE.md`'s standing rule *"Any
production data-integrity anomaly freezes writes immediately"*, which Atlas had **no**
mechanism to execute before `S3`. Retaining it is therefore not the retained-dead-code case D6
was withdrawn over.

**The bounds are part of the ruling, not commentary.** One single-row write-admission control,
governing exactly one question — may the seven existing `beginWrite` routes write? The runtime
holds `SELECT` and nothing else, and only the Supabase project owner may mutate the row. It is
**not** a feature-flag framework: fixed shape, no name column, no per-feature rows, **no second
controlled behaviour**, no second mechanism and no fallback. `preview → approve → write` is
unchanged, and no workout-data authority moves before `S4`. Anything beyond that list is
outside the ruling and needs its own authorization. The authorization is recorded in
`docs/ATLAS_V1_EXECUTION_PLAN.md`, under the 2026-08-07 owner-instruction block; an owner
ruling governs only once it is recorded there.

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

- It no longer claims `Atlas Production` is empty. It was verified empty — zero public tables,
  zero migrations — and the owner then applied the `S2` schema to it on 2026-08-08, so the
  eleven `S2` tables and the four scoped roles now exist there. It still claims **no data has
  migrated**: those tables are unwritten, no connection string is configured, and Sheets decides
  alone.
- **It claims `S3` has landed on `main`, and nothing beyond that.** `S3` **merged on 2026-08-11
  as PR #1281**. It claims nothing about that deployment: whether the migration has been applied
  to `Atlas Production`, and whether `atlas.write_freeze` exists there, are **UNVERIFIED as of
  this writing** — last verified 2026-08-08, when both were absent. **No deployed evidence
  exists**, which is a present fact and not an ageing one: none has ever been gathered. §6.2 P8b
  is outstanding, and P8–P12 are proven at the code level only, against the from-empty proof
  database. Nothing in `S3` has moved a read or a write: Google Sheets, plus the file-backed
  store in `services/idempotency.js`, remains the sole live authority for every migrated
  concept, and it stays so until `S4`. Where this document describes `S3` in the present tense
  it is describing **the reviewed design and the merged implementation**, never the state of the
  deployment. A merge is repository truth; it is not deployment truth, and this document does
  not let the first stand in for the second.
- It does not claim a measurement it has not taken. The net-complexity expectation in §9 is
  unmeasured and marked as such. **The §6.2 P4(a) residual read count IS now measured** — 255
  in-request Sheets range reads over the captured live manifest, 204 of them on migrated tabs —
  and the census is recorded in
  [`docs/verification/S3_CUTOVER_READINESS_2026-08-09.md`](./verification/S3_CUTOVER_READINESS_2026-08-09.md).
  P4(b)'s bounded background dependency is stated and gated there too, and **no unqualified
  quota-independence claim is made anywhere.**
- It does not authorize applying a schema or deploying.
- It does not amend the Constitution, and it writes no amended wording. Ruling D2 states the
  substance; Dale writes the text.
- It does not claim Row Level Security is configured.
- It no longer withholds the write freeze's permanence: **D7 was APPROVED by the owner on
  2026-08-09**, recorded in `docs/ATLAS_V1_EXECUTION_PLAN.md`, and `atlas.write_freeze` is
  permanent Atlas safety infrastructure with no sunset. It still claims no more than the ruling
  grants — one single-row write-admission control, and no feature-flag framework.
- It does not claim the migration closes at `S4`'s merge. Two steps follow it: the owner-run
  drop against `Atlas Production`, and a post-window versioned migration so a fresh replay of
  `supabase/migrations/` converges.
- It does not claim `S4`'s merge closes the loop. Ruling **D8** (2026-08-07) approved exactly
  **one** narrowly scoped post-window cleanup PR for the versioned drop migration, and the
  migration stays open until **both** the owner-run production drop and that cleanup land.
- It does not claim a revert alone restores a runnable `S3` posture. The post-`S4` schema
  is `S3`-compatible only because the `migration_divergences` drop is deferred past the
  rollback window, and that compatibility is a gate (P19i), not an assumption.
- It does not claim that write receipts survive an unrelated loss of the old process **and**
  its filesystem before §5.5 step 2a. No receipt set is closed before the freeze, so none can
  be made durable earlier; that case **aborts** the cutover (P19c, P19e) rather than being
  recovered.
- It is not a roadmap, a campaign, or a second execution plan. The execution plan's
  2026-08-07 owner-instruction block is the sole work-selection authority for this chain.
