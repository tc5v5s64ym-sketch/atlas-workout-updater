# Phase 4 Stage A — Session 5 — PASS — **STAGE A COMPLETE 5/5**

**Verdict: PASS. Stage A streak 5/5. Stage A is closed.**

Synthetic evidence. Never owner evidence, LT evidence, or a GATE A eligible event. Reaching 5/5 does **not** open Stage B and does **not** authorize Phase 5; both remain owner-reserved.

Method and scorecard semantics are documented once in [`STAGE_A_SESSION_1_2026-08-01.md`](STAGE_A_SESSION_1_2026-08-01.md).

## Run identity

| Field | Value |
|---|---|
| Date / time (UTC) | 2026-08-01, session began 06:00:21.378Z |
| Run purpose | `STAGE_A_SESSION`, session 5 of 5 |
| Source commit (`main`) | `fa25776332aa8704df82407c09f0162b467766de` (clean, = `origin/main`) |
| Prior canonical count | 4/5, read from the execution plan |
| Command | `npm run atlas:stage-a-session -- --session=5 --model-up` |
| Run id | `stage-a-s5-20260801T060010-041E19` |
| Synthetic session id | `STAGEA-S5-20260801T060010-041E19` |
| Synthetic athlete id | `stage-a-athlete-041E19` |
| Model posture / model | model-up / `gemini-2.5-flash-lite` |
| Sandbox workbook | declared sandbox, last 6 `H3CeXE` |
| `stage_a_eligible` | **true** |
| Runner duration | 36.1 s |

## Scorecard

**PASS 26 · FAIL 0 · ERROR 0 · NOT_APPLICABLE 1**

The single `NOT_APPLICABLE` is the owner-authorized `Session_Plans` / `Session_Plan_Sets` condition carrying that ruling's exact reason. No plan-ledger write was attempted or refused, ledger write flags were off, and neither tab was created, stubbed, or hidden.

| Criterion | Result |
|---|---|
| Sandbox posture proven before the port was published | PASS — 15 preflight checks, last 6 `H3CeXE`, no in-memory stub |
| Production non-contact | PASS — 0 guard refusals; appends only to `Log_Cleaned` and `Effort`; telemetry persistence off |
| Schema untouched | PASS — 0 `ensureSheetTab`, 0 deletions, 0 cell rewrites |
| Model-up proven | PASS — provider reachable, coach not scripted, `gemini-2.5-flash-lite` |
| Live-provider use on the eligible turn | PASS — `/api/coach/chat` returned `source: gemini` with the model named |
| Grounded session question | PASS — "Bench Press today: 185 lbs."; a different turn from the provider turn |
| Genuine workout logged | PASS — 4 sets across 2 exercises |
| No durable write before approval | PASS — 0 durable rows, 0 appends |
| Preview before write | PASS — exactly the 4 intended sets, preview proof present |
| Browser approval | PASS — real review-card Save click routed through the gated `#approve-btn` |
| `Log_Cleaned` | PASS — exactly 4 rows |
| `Effort` | PASS — exactly 1 row |
| No duplicates or contamination | PASS — 0 foreign-identity rows, 0 cross-session delta, repeated approval added 0 rows |
| Closeout and seal | PASS — sealed ("✓ Saved to your sheet") |
| InteractionTrace | PASS — 6 valid records, all carrying stages |
| Turn-write proof | PASS — 1 authoritative live write (4 log rows, 1 effort row), preview-established on its own turn |
| Trace / write-proof join | PASS — joined on `turn:2026-08-01T06:00:32.573Z_7_pnybkk` |
| Evidence withholding honest | PASS |
| Artifacts privacy-safe | PASS — 9 artifacts scanned, 0 violations, within bound |
| Synthetic provenance | PASS — origin `playwright`, synthetic and evidence-ineligible |

## Session-start boundary

`RUN_START.json` records the crossing at **06:00:21.378Z**.

## The complete five-session chain

Every session ran model-up against the declared sandbox workbook, from a clean `main` equal to `origin/main`, at a canonical prior count of exactly `n-1`, with freshly minted synthetic identities. Each scored **PASS 26 · FAIL 0 · ERROR 0 · N/A 1** with `stage_a_eligible: true`, and each wrote exactly 4 `Log_Cleaned` rows and 1 `Effort` row with no duplicates and no contamination.

| # | Source `main` SHA | Synthetic session id | Runner duration | Record |
|---|---|---|---|---|
| 1 | `4a233617bfe7186d804aed12cd271d7ae1f2b83e` | `STAGEA-S1-20260801T051224-868A33` | 28.9 s | [1](STAGE_A_SESSION_1_2026-08-01.md) |
| 2 | `0945475c45b0a7604e789ec770770bac614d3f9a` | `STAGEA-S2-20260801T054012-F35849` | ~1.1 min | [2](STAGE_A_SESSION_2_2026-08-01.md) |
| 3 | `0c74e79f9e883ab94ef33305664ad1d4e1800fed` | `STAGEA-S3-20260801T054717-B864BE` | ~1.1 min | [3](STAGE_A_SESSION_3_2026-08-01.md) |
| 4 | `5605d68eac7f1679cfca77a5bf6e4abd355b861d` | `STAGEA-S4-20260801T055358-5F031A` | 34.2 s | [4](STAGE_A_SESSION_4_2026-08-01.md) |
| 5 | `fa25776332aa8704df82407c09f0162b467766de` | `STAGEA-S5-20260801T060010-041E19` | 36.1 s | this record |

Five distinct source commits, five distinct synthetic identities, no session repeated and none skipped — each was legal only at its own prior count, and the qualifying command refused any other number.

## Run-duration observations

Recorded as **measurements only**. Sessions 2 and 3 took roughly twice as long as sessions 1, 4, and 5, all of it inside the post-approval durable readback.

**The cause is not established.** An earlier version of these records asserted that Sheets read-quota throttling explained it. That claim was withdrawn: the runner's read-retry path is silent — it matches `/quota/i` and backs off without logging the error, the attempt, or the fact that it retried — and no captured run output contains any quota, `429`, `RESOURCE_EXHAUSTED`, or rate-limit indication. The claim was inference from a known code path plus a timing difference, not evidence.

Read-quota throttling remains one **unverified hypothesis**. It is not the only one, and nothing here rules out an intermittent runner or product effect. The evidence that would settle it — a logged retry carrying the provider's own error — was never captured. It is not being captured now: the runner is removed in the same PR that publishes this record, so instrumenting it on its way out would produce motion rather than proof.

What **is** established is that no verdict depended on the durations. All five sessions scored identically on every condition, and the durable readback found exactly the intended rows every time.

## Artifacts

Preserved locally and git-ignored at `stage-a-artifacts/session-5-20260801T060010-041E19/` (378,327 bytes; 7 screenshots + 4 records).

| File | Bytes | SHA-256 |
|---|---|---|
| `scorecard.json` | 7,693 | `38ac15e7c0626edc63319b9e4c72e472e7919e7ba02a6b42446f829b5295f58b` |
| `SCORECARD.md` | 5,212 | `e2c7793ec3816d0fdf27cc4ac4a723c2678b2e60b8a7ff9f2fa74008083d07e0` |
| `evidence.json` | 22,255 | `3493a4ec99bcfa4176cb43de1934fb1b495493b24c7de0c336eee07f21fa4d8d` |
| `RUN_START.json` | 359 | `2310595626d5f7871d5d1e2f22a6669451720d70d43ea01a792f9045a8b06ac5` |

All five sessions' raw artifacts remain under `stage-a-artifacts/`, git-ignored. No credentials, no full Sheet id, no owner data, no unbounded logs entered the repository.

## What Stage A establishes, and what it does not

**Establishes:** the machine path holds for a complete session — real browser, real built client, real local Express backend, real production parser / router / session / coach / validator paths, real preview→approve→write loop, real closeout and seal, with the live model in the loop — repeatably, five times, across five different source commits.

**Does not establish:** anything about owner operation. Stage A evidence is synthetic by construction and is never owner evidence, LT evidence, or a GATE A eligible event.

**Next:** Stage B is five consecutive owner-run workouts and is opened only by the owner, via step (a) of the Phase 4 gate script, which sets `SESSION_PLAN_SETS_WRITE_ENABLED=1` on Render. That flag stays `0` until the owner sets it. Phase 5 begins only after Stage B also reaches 5/5 **and** the owner explicitly authorizes it.
