# S4 accidental-deploy recovery — S3 rollback verification

**Date:** 2026-08-14
**Status:** ROLLBACK COMPLETE — production verified on S3; receipt quarantine active
**Does not authorize:** S4 cutover, S4 schema, freeze activation, production writes, write reopening, Stage B, or Phase 5

This file is the evidence for the completed S3 production rollback. It selects
no further campaign work. Sequencing stays in
`docs/ATLAS_V1_EXECUTION_PLAN.md`.

## Current-state verification

1. **Source.** Owner instruction 2026-08-14: the authorized Render rollback is
   complete. Verify and record the restored S3 production. Do not continue the
   S4 cutover.
2. **Duplicate / stale search.** Recovery record already exists (PR #1292,
   `main` `959a0d6c44b3c8a463261ebbe1ff9ec4673c71fe`). That record described
   rollback as pending. Repository S4 merge remains
   `21e5d616ee3726e027331e66f2af6812760dd230` (PR #1291). GitHub has no
   Supabase project connection. Owner gate 1(b) (`atlas.write_freeze` apply)
   and owner gate 1(c) (S4 schema apply) remain outstanding in the plan.
3. **Verdict.** `ALREADY FIXED` on the production process. Receipt quarantine
   remains active. S4 cutover remains stopped.
4. **Evidence.** Public production `GET /version`, `GET /health`, and
   `GET /.well-known/atlas-status.json` on 2026-08-14, recorded in §7, plus
   owner Render screenshot evidence recorded there.
5. **Allowed next action.** Record the completed rollback. Then stop. No
   runtime code, no schema, no freeze, no write, no S4 continuation.

Sections 1–5 below are the 2026-08-14 investigation that prepared the
rollback. They are retained as evidence. Current production state is §7.

## 1. Production has produced no S4 authoritative effects

**Observed fact.** At `generated_at` `2026-08-14T02:26:14.494Z`, production
reported:

| Field | Value |
|---|---|
| `deployed_commit` | `21e5d616ee37` |
| `app_version` | `PR #1291` |
| `deployed_at` | `2026-08-14T02:24:37.691Z` |
| `supabase_migration.configured` | `false` |
| `supabase_migration.observed` | `false` |
| `supabase_migration.reason` | `not_observed_from_endpoint` |

`configured: false` is env presence of `ATLAS_SUPABASE_APP_URL` on the running
process (`services/atlasStatus.js`). It is unset.

PR #1291 merged at `2026-08-14T01:12:36Z`. Render auto-deploy then served that
head. The ChatGPT PASS on PR #1291 authorized merge only. It did not authorize
deployment.

**Supported conclusion.** This process cannot open a Supabase app-role
connection. Every S4 authority path uses that role:

- `services/writeReceipts.js` `beginWrite` returns `unavailable` when the
  adapter throws `SUPABASE_NOT_CONFIGURED`. All seven `beginWrite` callers
  then refuse with HTTP 503 and `sheet_written: false`.
- `services/workoutAuthority.js` Save, undo, and hot-path reads throw the same
  error. The Save catch on `/api/log-workout` and `/api/complete-workout`
  returns 500 and does not fall through to Sheets.
- `services/exerciseCatalog.js` and `services/coachingInputsAuthority.js` have
  no Sheets fallback.
- `services/sheetsMirrorScheduler.js` starts only when
  `ATLAS_MIRROR_EXPORT_ENABLED=1`. That flag is not a production-status field.
  Even if it were on, export still needs the app role.

S4 deleted the Sheets hot-path writers. With the app role unset, this build
cannot write the seven migrated concepts to Supabase and cannot write them to
Sheets either.

**What this does not prove.**

- It does not read `Atlas Production`. The public endpoint never opens a
  database (`not_observed_from_endpoint`).
- It does not prove a prior process in the same deploy window held a different
  env. Render env is shared across deploys unless the owner changes it. The
  last recorded production state (2026-08-08 owner gate) is that no Supabase
  connection string of any role is set in any live Atlas environment.
- It does not prove Sheets telemetry tabs (`Flight_Recorder`, `Intent_Shadow`,
  `Brain_Shadow`) were quiet. Those are not S4 workout authority.

**Stop if.** The owner sees `ATLAS_SUPABASE_APP_URL` set on Render, or sees S4
migrations in `Atlas Production`. Then this no-S4-write conclusion is void.
Report the new evidence.

## 2. How the seven write routes behave after S3 is restored

The seven `beginWrite` routes, identical on S3 `da16cd4b` and on the
unauthorized S4 head:

1. `POST /api/coaching-notes`
2. `POST /api/constraints`
3. `POST /api/log-modality`
4. `POST /api/bodyweight`
5. `POST /api/complete-workout`
6. `POST /api/log-workout`
7. `POST /api/log-workout/undo-last`

S3 `services/writeFreeze.js` admits a write when the control is unarmed. The
control arms only when `ATLAS_SUPABASE_APP_URL` is set. Production still has
that variable unset. Restoring the S3 build against that Render env therefore
left the freeze **dormant**. Dormant freeze returns
`{ open: true, armed: false, code: 'not_armed' }`.

There is no local override. No environment variable, header, or request field
can freeze the seven routes on S3 without the live `atlas.write_freeze` row.
Owner gate 1(b) — apply `supabase/migrations/20260809000100_write_freeze.sql`
to `Atlas Production` — is still outstanding. Freeze activation is a separate
owner authorization. This recovery does not request it.

**Supported conclusion.** After the S3 restore, the seven routes became
technically available again. They do not remain unavailable by mechanism.
Keeping them unused until the receipt-safety horizon is an **operational
hold** by the owner and by every agent: do not Save, undo, log modality,
write bodyweight, or write coaching notes or constraints.

This is not a fallback, bridge, or emergency code path. It is a hold on the
existing S3 routes until receipts are safe.

## 3. Destroyed / unprovable S3 receipt state

S3 receipts live in the per-process map and, best-effort, in
`/tmp/atlas-idempotency.json` (`services/idempotency.js` at `da16cd4b`).
TTL is `DEFAULT_TTL_MS` = 24 hours from `created_at_ms`.

The S4 build deletes that module. The S4 process start replaces the S3
process. `/tmp` is process-adjacent on Render. The S3 receipt set is therefore
gone. It cannot be exported. The S4 receipt table cannot hold it, because the
app role is unset and the designed freeze-and-carry never ran.

The designed reverse transfer (`docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.5a)
needs frozen writes, a verified `atlas.write_receipts` snapshot, one restored
S3 process, and `importReceipts`. None of those preconditions hold. This
recovery does not invent a substitute carry.

**Observed fact.** The S3 receipt set is destroyed and unprovable.

## 4. Receipt-safety horizon

A retry of a pre-deploy S3 `write_id` against an empty file store is treated
as a new claim. If the original Sheets write landed and the client retries,
the duplicate shield is gone. Composite-key dedupe on `Log_Cleaned` is a
second line of defense for some Saves. It is not a shield for all seven
routes.

Design rule (`§5.3`): after a restart that can drop memory-only receipts, do
not reopen writes until a full receipt TTL horizon has elapsed.

**Horizon.** `DEFAULT_TTL_MS` after the last moment an S3 process could have
minted a receipt.

| Bound | Instant (UTC) | Meaning |
|---|---|---|
| Earliest S4 merge | `2026-08-14T01:12:36Z` | PR #1291 merged; auto-deploy could start |
| Observed S4 process start | `2026-08-14T02:24:37.691Z` | Public `/version` `deployed_at` |
| Conservative horizon | `2026-08-15T02:24:37.691Z` | 24 hours after the observed S4 start |

Using the later observed S4 start is conservative if S3 died earlier. It is
not proof that no S3 instance overlapped a first S4 instance during a rolling
replace.

**Stronger proof, if the owner can produce it from Render logs.** The exact
time the last S3 instance exited, plus platform confirmation of exactly one
instance across the replace. The horizon is then that exit time plus 24 hours.
If those logs are absent, use `2026-08-15T02:24:37.691Z`.

**Writes may not reopen before that instant.** Reopening after it is a
separate owner action. This recovery does not reopen writes.

## 5. Rollback requires no schema reversal

S4 schema files in the repository, not applied by this process:

- `supabase/migrations/20260813152939_s4_catalog_sole_authority.sql`
- `supabase/migrations/20260813152952_s4_cutover_write_id_foreign_keys.sql`
- `supabase/migrations/20260813170000_s4_coaching_inputs.sql`

**Observed fact.**

- Owner gate 1(c) is still outstanding in the plan.
- GitHub has no Supabase project connection (P10, 2026-08-09).
- The running process has `ATLAS_SUPABASE_APP_URL` unset, so it cannot apply
  DDL.
- S2 is applied. `atlas.write_freeze` was last verified ABSENT (2026-08-08
  P8b). S3 freeze apply (gate 1(b)) is still outstanding.

S3 `da16cd4b` reads `Exercise_Catalog` from Google Sheets
(`sheets.getExerciseCatalog`). It does not require the S4 rename of
`atlas.exercise_catalog_mirror`. Restoring that commit against the last
verified hosted schema does not reverse S4 DDL, because that DDL was not
applied.

**Stop if.** Atlas Production migration history already contains any of the
three S4 files, or `exercise_catalog_mirror` has been renamed. Then rollback
of the S3 *code* against an S4 *schema* is unsafe. Do not reverse schema in
this recovery. Stop and report.

## 6. Exact Render rollback target and post-rollback verification

**Target commit (full):** `da16cd4b13912569870e9a6dee7a3281730027b1`

**What that commit is.** PR #1290, "Read the S3 readiness comparison through
the one frozen resolver". It is the `main` parent of PR #1291. Public
production URL:
`https://atlas-workout-updater.onrender.com`

**Owner action.** The owner rolled that service back to the target commit
through the Render Dashboard. The owner did not manual-deploy `main`.
Repository `main` still holds the S4 wiring from PR #1291. Auto-deploy must
remain off so a later push to `main` does not ship S4 again.

**Post-rollback verification** is recorded in §7. Until
`2026-08-15T02:24:37.691Z` (or the stronger logged horizon in §4), do not
Save. Do not undo. Do not log modality, bodyweight, coaching notes, or
constraints. Do not reopen writes. Do not apply S4 schema. Do not activate
the freeze. Do not continue the S4 cutover. Do not advance Stage B or
Phase 5.

## 7. Completed rollback proof — 2026-08-14

**Observed fact — owner-supplied Render screenshot.** The owner reported a
successful Live deploy with:

- Trigger: Rolled back by owner via Dashboard
- Source: `da16cd4...`
- startup log: `commit=da16cd4 pr=1290`
- service reported live

This process did not open the Render Dashboard and did not change Render.

**Observed fact — independent public HTTP, fetched
`2026-08-14T02:41:55Z` UTC from
`https://atlas-workout-updater.onrender.com`.**

`GET /version` returned HTTP 200:

| Field | Value |
|---|---|
| `data.version` | `da16cd4b13912569870e9a6dee7a3281730027b1` |
| `data.pr` | `1290` |
| `data.deployed_at` | `2026-08-14T02:39:16.221Z` |
| `data.commit_subject` | `Read the S3 readiness comparison through the one frozen resolver (#1290)` |

`GET /health` returned HTTP 200:

```json
{"status":"ok","message":"Health check passed","data":{"service":"atlas-workout-updater"}}
```

`GET /.well-known/atlas-status.json` returned HTTP 200 at
`generated_at` `2026-08-14T02:41:55.879Z`:

| Field | Value |
|---|---|
| `deployed_commit` | `da16cd4b1391` |
| `app_version` | `PR #1290` |
| `deployed_at` | `2026-08-14T02:39:16.221Z` |
| `supabase_migration.configured` | `false` |
| `supabase_migration.observed` | `false` |
| `supabase_migration.reason` | `not_observed_from_endpoint` |
| `sheets_configured` | `true` |
| `llm_configured` | `true` |
| `overall_status` | `degraded` |
| `status_reason_codes` | `LATEST_TEST_FAILED` |
| `latest_test_id` | `LT-012` |
| `latest_test_freshness_days` | `29` |

**Supported conclusions.**

1. Production is serving the full S3 SHA
   `da16cd4b13912569870e9a6dee7a3281730027b1` (PR #1290).
2. The unauthorized S4 build `21e5d616ee3726e027331e66f2af6812760dd230`
   (PR #1291) is no longer serving.
3. Production is answering public requests (HTTP 200 on `/version`,
   `/health`, and `/.well-known/atlas-status.json`).
4. The restored process still has `ATLAS_SUPABASE_APP_URL` unset
   (`configured: false`). This process cannot open a Supabase app-role
   connection from that endpoint.
5. No public evidence indicates an S4 authoritative write. The prior S4
   process also reported `configured: false`. This verification called none
   of the seven write routes.

`overall_status: degraded` is the pre-existing `LT-012` test-queue signal
(`latest_test_freshness_days: 29`). It is not evidence that the rollback
failed.

**Auto-deploy.** This process cannot read the Render auto-deploy toggle.
Owner screenshot evidence shows a Dashboard rollback, not an auto-deploy.
The last recorded owner instruction is that auto-deploy remains off. This
verification changed nothing on Render.

**Atlas Production schema.** This environment has no Atlas Production
credentials. The public endpoint does not open a database
(`not_observed_from_endpoint`). This verification therefore cannot newly
prove that the three S4 migration files named in §5 are absent. Gate 1(c)
remains outstanding in the plan. The stop condition in §5 is unchanged: if
Atlas Production already contains those files, or if
`exercise_catalog_mirror` has been renamed, report that evidence and do not
treat this rollback as schema-safe.

**Authenticated Sheets health.** This environment has no production API
key. `GET /api/health/sheets` was not called.

**Receipt quarantine.** Successful rollback is not permission to reopen
writes. The S3 file-backed receipt mechanism is newly running and empty of
pre-deploy receipts. The conservative no-write horizon remains
`2026-08-15T02:24:37.691Z`. Sunset of that quarantine is that horizon plus
clean recovery verification plus explicit owner authorization to resume
production workout writes. No new freeze, receipt store, bridge, or
fallback was added.

## Architecture accounting

| Item | Record |
|---|---|
| Classification | Closure of the existing authority defect |
| Current live authority | S3 / Google Sheets, with the S3 file-backed receipt mechanism newly running. Production writes are quarantined because prior receipt continuity is unprovable. |
| Intended final authority | Supabase after a future fresh authorized §5.5 cutover |
| Competing production authority removed | Unauthorized S4 deployment |
| Compatibility bridge | None |
| Temporary safety mechanism | Operational no-write quarantine only |
| Sunset | Receipt horizon passes, recovery verification remains clean, and Dale explicitly authorizes resuming production workout writes |
| Net complexity | No increase |

## Non-goals

- No git revert of PR #1291 on `main`. Repository S4 wiring stays on `main`.
  Production is pinned to S3 by Render until a later authorized action.
- No new freeze, flag, fallback, bridge, or emergency write path.
- No production data write by this investigation or this verification.
