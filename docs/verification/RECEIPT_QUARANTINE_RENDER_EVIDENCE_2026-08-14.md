# Receipt quarantine — Render log evidence — 2026-08-14

**Status:** EVIDENCE ONLY. This document records read-only Render platform
evidence about the destroyed S3 receipt state. It changes no runtime, schema,
or Render setting. It does not reopen writes. It does not authorize ending the
quarantine immediately.

**Provenance.** Render facts below were first gathered on leftover branch
`agent/receipt-quarantine-render-evidence` at
`b7da0b4c3817bcf1c6cf1a7394a372e7c43c415d`. That branch was not merged. This
file keeps those observed facts and withdraws one overclaim: finished-request
logs do not prove that the receipt-risk class was empty at every instant.

**Governing horizon.** The defensible last-S3-process bound is approximately
`2026-08-13T19:10:00Z`. The resulting 24-hour receipt-safety horizon is
approximately `2026-08-14T19:10:00Z` (August 14 about 12:10 PM PDT). Writes
remain closed until that instant, and reopening after it is a separate owner
action.

The earlier conservative horizon (`2026-08-15T02:24:37.691Z`,
[`S4_ACCIDENTAL_DEPLOY_ROLLBACK_2026-08-14.md`](./S4_ACCIDENTAL_DEPLOY_ROLLBACK_2026-08-14.md)
§4) remains a later bound. It is no longer the governing recorded horizon.

## 1. Method — all read-only

Render API queries on 2026-08-14 (~04:00Z), service `atlas-workout-updater`
(`srv-d86vs9f7f7vs73b1smdg`, region virginia, free plan): service record,
deploy list, and log queries. No Render setting, deploy, environment variable,
or production request-with-side-effect was issued. The one production HTTP call
made was public `GET /version`.

**How requests are observed.** This service has **no `request`-type log
stream** — `list_log_label_values(label=type)` over 2026-08-13T01:00Z →
2026-08-14T03:00Z returns only `app` and `build`. The request record is the
application's own `requestLogger` (`index.js:269-286` at `da16cd4b`), which
logs one JSON line per **finished** HTTP request
(`{"timestamp","method","path","status","requestId","duration_ms"}`) to stdout,
which Render captures as `app` logs. Boot lines (`[build-info] commit=… pr=…`),
`[sheets-read]` instrumentation, and `startup_diagnostics` identify each
process and build.

**Limitation that this file must not overclaim.** `requestLogger` records a
line only on `res.on('finish')`. An unfinished request, a process death before
the response finishes, or a receipt minted and then lost with the process, does
not appear in that stream. Finished-request search therefore does not prove
that the receipt-risk class was literally empty at every instant. This file
does not use that search to end the quarantine immediately.

**Filter validation.** Regex alternation (`a|b`) inside one Render text filter
matches nothing and was discarded after a control query with known-present
content returned empty. Every finding below uses single-substring filters or
multi-entry filter arrays, each validated against known-present lines
(`/health` request lines, `Constraints!A:Z` inside `[sheets-read]` lines).

## 2. Observed facts

### 2.1 Service configuration (read 2026-08-14 ~04:00Z)

| Field | Value |
|---|---|
| `autoDeploy` / `autoDeployTrigger` | `no` / `off` |
| `numInstances` | 1 |
| `plan` | free (single instance; idle spin-down) |

Official Render Free-service behavior: the service spins down after 15 minutes
without inbound traffic.

### 2.2 Deploy timeline around the incident (UTC)

| Deploy | Commit | Trigger | Started | Live | Deactivated |
|---|---|---|---|---|---|
| `dep-d9us5a67…` | `da16cd4b` (S3, PR #1290) | `new_commit` | 08-13 13:12:08 | 13:12:58 | **08-14 01:13:27** |
| `dep-d9v6n1oa…` | `21e5d616` (S4, PR #1291) | `new_commit` | 08-14 01:12:39 | 01:13:27 | 02:35:29 |
| `dep-d9v7tfu7…` | `959a0d6c` (PR #1292) | `new_commit` | 08-14 02:34:39 | 02:35:29 | 02:39:26 |
| `dep-d9v7vfjl…` | `da16cd4b` (S3 restore) | **`rollback`** | 08-14 02:38:54 | 02:39:26 | (live) |

Two corrections to the working picture this table establishes:

1. **The S3 → S4 replacement happened at 01:12:56–01:13:27Z**, not at
   02:24:37Z. The `deployed_at` of `2026-08-14T02:24:37.691Z` in the rollback
   record is a **process start** (a free-tier idle wake of the already-deployed
   S4 build), not the deploy. The conservative horizon anchored on it is
   therefore anchored ~71 minutes **after** the last instant any S3 *deploy*
   remained live.
2. **The incident was two unauthorized auto-deploys, not one.** PR #1292's
   merge also auto-deployed (02:34:39Z) and served 02:35:29–02:39:26Z, before
   the owner's dashboard rollback. Auto-deploy was still on between the two
   merges.

### 2.3 Process (instance) timeline for the final S3 build

| Instance | Build | First line | Last line | Note |
|---|---|---|---|---|
| `…-9b65m` | S3 `da16cd4` | 08-13 13:12 (boot) | 13:13:50 (`/health`,`/version`,`/routes`) | post-deploy checks; idle after |
| `…-7ss58` | S3 `da16cd4` | 08-13 18:54:31 (idle wake) | **18:54:59** (two `GET /robots.txt` 404) | last observed S3 app activity |
| `…-mr7fl` | S4 `21e5d61` | 08-14 01:13:06 | 01:18:26 window | the S4 deploy's process |
| `…-t7b29` | S4 `21e5d61` | 08-14 ~02:24:37 (idle wake) | — | the process the 02:26 status fetch observed |

**Observed fact.** Last observed S3 app activity:
`2026-08-13T18:54:59Z`. Between that instant and the S4 deploy line at
01:12:56Z the service emitted **no log line of any kind** (`hasMore: false`
over the whole window). No later S3 boot or S3 app activity appears before the
S4 replacement.

### 2.4 Finished write-route request lines

Search window 2026-08-07T01:00Z → 2026-08-14T02:45Z (earliest retained log
line observed: 2026-08-07T12:38:00Z), full app-log text search:

- **Write-route request lines** (filters `log-workout`, `complete-workout`,
  `coaching-notes`, `constraints`, `log-modality`, `bodyweight`, `undo-last`):
  the only matches are `[sheets-read]` lines whose *ranges* contain
  `Constraints!A:Z` / `Deload_State!A:Z` — read-only daily
  `GET /api/recommend/next/{SQ01,BEN01,OHP01}` probes (~12:24–12:42Z each
  day), every one `range_unresolved` HTTP 400. **Zero finished requests to any
  of the seven write routes reached any process in the entire window.**
- **Mutating requests** (filter `"method":"POST"`; `PUT`/`DELETE`/`PATCH` also
  checked): **exactly one finished POST in seven days** —
  `{"timestamp":"2026-08-14T02:27:39.066Z","method":"POST","path":"/api/log-workout","status":401,"requestId":"5e48b039","duration_ms":1}`
  on instance `…-t7b29`, i.e. on the **S4 build**, during the recovery
  investigation window. A 401 is issued by `requireApiKeyMiddleware`
  (`index.js:312` at both heads) **before any route handler**: no `beginWrite`,
  no receipt, no Sheets access, and the S4 build additionally has no Sheets
  writers for the seven concepts and no Supabase credential
  (`configured: false`).
- All other finished traffic in the window: `GET /health`, `GET /version`,
  `GET /routes`, `HEAD /`, `GET /`, `GET /robots.txt`, and the daily
  read-only recommend probes.

These are finished-request observations. They do not prove that no receipt
existed in a live S3 process at every instant.

## 3. Supported conclusions

1. **Last observed S3 app activity is `2026-08-13T18:54:59Z`.** No later S3
   boot or S3 app activity appears before the S4 replacement.
2. **The platform topology is one Free instance.** `numInstances: 1`, plan
   `free`. Official Render Free-service behavior spins the service down after
   15 minutes without inbound traffic.
3. **The defensible last-S3-process bound is approximately
   `2026-08-13T19:10:00Z`.** That is last observed S3 app activity plus the
   official 15-minute Free spin-down, with no later S3 boot before the S4
   replacement. A receipt that process could have held is gone when that
   process exits.
4. **The governing 24-hour receipt-safety horizon is approximately
   `2026-08-14T19:10:00Z`** (August 14 about 12:10 PM PDT). Design rule
   (`docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.3): after a restart that can drop
   memory-only receipts, do not reopen writes until a full receipt TTL horizon
   has elapsed. `DEFAULT_TTL_MS` is 24 hours.
5. **The S3 → S4 replacement at 01:12:56–01:13:27Z is later than that process
   bound.** The conservative horizon `2026-08-15T02:24:37.691Z` remains a later
   bound. It is not the governing recorded horizon after this evidence.
6. **Single-instance topology is platform-confirmed** for this inspection:
   `numInstances: 1`, free plan, and sequential instance lifecycles in the log
   record.

## 4. What this does not prove, and stop-ifs

- **Finished-request logs are not a complete receipt inventory.**
  `requestLogger` records finished requests only. This evidence does not prove
  that the receipt-risk class was literally empty at every instant. It does
  not prove that no unfinished write minted a receipt on the last S3 process.
  **Do not end the quarantine immediately on that search.**
- **The 15-minute spin-down is official Free-service behavior**, not a
  measured exit timestamp from Render process-exit logs. The last-S3-process
  bound is therefore approximate (`2026-08-13T19:10:00Z`).
- **The 401 probe's origin is unrecorded.** Whoever sent it, the finished line
  shows HTTP 401 on the S4 build. Any retry of it is refused identically at
  the API-key middleware.
- **This inspection did not read `Atlas Production`** and adds nothing about
  schema state. Gate 1(b)/1(c) records are unchanged.
- **Stop if** Render log retention is shown to have gaps inside
  2026-08-13T13:12Z → 2026-08-14T01:13Z, or any additional S3 boot or S3 app
  activity is found after `2026-08-13T18:54:59Z`. Then conclusion 3 is void and
  the conservative horizon `2026-08-15T02:24:37.691Z` governs again.

## 5. Disposition

Record the stronger process-lifetime horizon. Keep the operational no-write
quarantine until approximately `2026-08-14T19:10:00Z`. Do not reopen writes.
Do not deploy. Do not change Render. Do not change schema. Reopening writes
after the horizon remains a separate owner action.

## Authority accounting

| Item | Record |
|---|---|
| Classification | evidence record — governing receipt-safety horizon updated; no mechanism added |
| Current live authority | S3 / Google Sheets, S3 file-backed receipts newly running, writes operationally quarantined until the horizon in this file |
| Intended sole authority | Supabase after a future fresh authorized §5.5 cutover |
| Competing authority removed | none |
| Bridge | none |
| Sunset of this quarantine | approximately `2026-08-14T19:10:00Z`, then only after explicit owner authorization to resume production workout writes |
| Net complexity | none |
