# Receipt quarantine — Render log evidence — 2026-08-14

**Status:** EVIDENCE ONLY. This document records read-only Render platform
evidence about the destroyed S3 receipt state. It changes no rule, reopens no
write, shortens no recorded horizon, and authorizes nothing. The recorded
conservative horizon (`2026-08-15T02:24:37.691Z`,
[`S4_ACCIDENTAL_DEPLOY_ROLLBACK_2026-08-14.md`](./S4_ACCIDENTAL_DEPLOY_ROLLBACK_2026-08-14.md)
§4) stands until ChatGPT rules on this evidence and Dale explicitly authorizes
resuming production writes.

§4 of the rollback record invited this evidence: *"Stronger proof, if the owner
can produce it from Render logs: the exact time the last S3 instance exited,
plus platform confirmation of exactly one instance across the replace."* The
receipt-safety rule itself
([`SUPABASE_HOT_PATH_MIGRATION.md`](../SUPABASE_HOT_PATH_MIGRATION.md) §5.3)
states: *"Any other proof that establishes the same fact is equally acceptable;
an elapsed timer alone without the stability precondition is not."*

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
   therefore anchored ~71 minutes **after** the last instant any S3 process
   existed.
2. **The incident was two unauthorized auto-deploys, not one.** PR #1292's
   merge also auto-deployed (02:34:39Z) and served 02:35:29–02:39:26Z, before
   the owner's dashboard rollback. Auto-deploy was still on between the two
   merges.

### 2.3 Process (instance) timeline for the final S3 build

| Instance | Build | First line | Last line | Note |
|---|---|---|---|---|
| `…-9b65m` | S3 `da16cd4` | 08-13 13:12 (boot) | 13:13:50 (`/health`,`/version`,`/routes`) | post-deploy checks; idle after |
| `…-7ss58` | S3 `da16cd4` | 08-13 18:54:31 (idle wake) | **18:54:59** (two `GET /robots.txt` 404) | **the last S3 process** |
| `…-mr7fl` | S4 `21e5d61` | 08-14 01:13:06 | 01:18:26 window | the S4 deploy's process |
| `…-t7b29` | S4 `21e5d61` | 08-14 ~02:24:37 (idle wake) | — | the process the 02:26 status fetch observed |

Between 18:54:59Z and the deploy line at 01:12:56Z the service emitted **no log
line of any kind** (`hasMore: false` over the whole window). The last S3
process was idle for hours and, per free-plan idle spin-down, had exited well
before the S4 deploy. **No S3 process was running at the replacement boundary,
so no request was in flight on one.**

### 2.4 Write-route traffic — the decisive finding

Search window 2026-08-07T01:00Z → 2026-08-14T02:45Z (earliest retained log
line observed: 2026-08-07T12:38:00Z), full app-log text search:

- **Write-route request lines** (filters `log-workout`, `complete-workout`,
  `coaching-notes`, `constraints`, `log-modality`, `bodyweight`, `undo-last`):
  the only matches are `[sheets-read]` lines whose *ranges* contain
  `Constraints!A:Z` / `Deload_State!A:Z` — read-only daily
  `GET /api/recommend/next/{SQ01,BEN01,OHP01}` probes (~12:24–12:42Z each
  day), every one `range_unresolved` HTTP 400. **Zero requests to any of the
  seven write routes reached any process in the entire window.**
- **Mutating requests** (filter `"method":"POST"`; `PUT`/`DELETE`/`PATCH` also
  checked): **exactly one in seven days** —
  `{"timestamp":"2026-08-14T02:27:39.066Z","method":"POST","path":"/api/log-workout","status":401,"requestId":"5e48b039","duration_ms":1}`
  on instance `…-t7b29`, i.e. on the **S4 build**, during the recovery
  investigation window. A 401 is issued by `requireApiKeyMiddleware`
  (`index.js:312` at both heads) **before any route handler**: no `beginWrite`,
  no receipt, no Sheets access, and the S4 build additionally has no Sheets
  writers for the seven concepts and no Supabase credential
  (`configured: false`).
- All other traffic in the window: `GET /health`, `GET /version`,
  `GET /routes`, `HEAD /`, `GET /`, `GET /robots.txt`, and the daily
  read-only recommend probes.

## 3. Supported conclusions

1. **The destroyed S3 receipt set was empty of any unexpired receipt.** A
   receipt exists only when a write route reaches `beginWrite`
   (`services/idempotency.js` at `da16cd4b`). No write-route request reached
   any S3 process for at least 6 days before the last S3 process exited —
   far beyond `DEFAULT_TTL_MS` (24 h). There was no receipt to destroy, so
   there is no acknowledged write whose client retry the lost shield was
   protecting.
2. **No request was in flight at any replacement boundary.** The last request
   an S3 process ever finished was at 18:54:59Z; no S3 process was running at
   the 01:12:56Z deploy. The 02:35:29Z and 02:39:26Z replacements concern only
   S4-build processes, which refuse all seven routes.
3. **No request capable of an ambiguous Google Sheets append was sent.** An
   append on the seven routes requires a handler invocation; none occurred.
   The one mutating request in the window was refused at the API-key
   middleware on the S4 build with no side effect.
4. **Single-instance topology is platform-confirmed.** `numInstances: 1`, free
   plan (no scale-out), and the log record shows strictly sequential instance
   lifecycles — at the S4 replacement, zero (not two) instances were serving.
5. **Under the recorded §4 stronger-proof formula alone** (last S3 exit +
   24 h), the horizon bound is at latest **2026-08-15T01:13:27Z** — the last
   instant any S3 process could have existed (the deploy that replaced the
   build) — and on the idle-spin-down evidence, earlier (~2026-08-14T19:10Z).
6. **Under §5.3's equally-acceptable-proof clause, the evidence establishes
   more than the elapsed horizon would**: the horizon exists so that no
   unexpired receipt can survive only on a retired process; the observed fact
   is that no unexpired receipt existed at all. On this evidence, the
   full conservative horizon protects an empty risk class.

## 4. What this does not prove, and stop-ifs

- **Log completeness.** `requestLogger` logs only *finished* requests, and log
  retention begins ~2026-08-07T12:38Z. Both bounds are covered: a receipt
  minted before 2026-08-13 is TTL-expired regardless, and an unfinished
  request required a running process — none existed at the boundary.
- **The 401 probe's origin is unrecorded.** Whoever sent it, it minted nothing
  and wrote nothing; any retry of it is refused identically.
- **This inspection did not read `Atlas Production`** and adds nothing about
  schema state. Gate 1(b)/1(c) records are unchanged.
- **Stop if** Render log retention is shown to have gaps inside
  2026-08-13T13:12Z → 2026-08-14T01:13Z, or any additional request line for a
  write route is found in that window. Then conclusion 1 is void and the
  recorded conservative horizon governs unqualified.

## 5. Disposition

Reported to ChatGPT / the owner for ruling. Until that ruling and Dale's
explicit authorization, the operational quarantine and the recorded horizon
stand exactly as written. This evidence does not reopen writes, and no write
was made while gathering it.

## Authority accounting

| Item | Record |
|---|---|
| Classification | evidence record — no authority change, no mechanism added |
| Current live authority | S3 / Google Sheets, S3 file-backed receipts newly running, writes operationally quarantined |
| Intended sole authority | Supabase after a future fresh authorized §5.5 cutover |
| Competing authority removed | none |
| Bridge | none |
| Net complexity | none |
