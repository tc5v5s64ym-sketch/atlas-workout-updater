# Phase 4 Stage A — Session 4 — PASS

**Verdict: PASS. Stage A streak 4/5.**

Synthetic evidence. Never owner evidence, LT evidence, or a GATE A eligible event. Method and scorecard semantics are documented once in [`STAGE_A_SESSION_1_2026-08-01.md`](STAGE_A_SESSION_1_2026-08-01.md).

## Run identity

| Field | Value |
|---|---|
| Date / time (UTC) | 2026-08-01, session began 05:54:07.558Z |
| Run purpose | `STAGE_A_SESSION`, session 4 of 5 |
| Source commit (`main`) | `5605d68eac7f1679cfca77a5bf6e4abd355b861d` (clean, = `origin/main`) |
| Prior canonical count | 3/5, read from the execution plan |
| Command | `npm run atlas:stage-a-session -- --session=4 --model-up` |
| Run id | `stage-a-s4-20260801T055358-5F031A` |
| Synthetic session id | `STAGEA-S4-20260801T055358-5F031A` |
| Synthetic athlete id | `stage-a-athlete-5F031A` |
| Model posture / model | model-up / `gemini-2.5-flash-lite` |
| Sandbox workbook | declared sandbox, last 6 `H3CeXE` |
| `stage_a_eligible` | **true** |

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
| Grounded session question | PASS — "Bench Press today: 185 lbs."; a different turn from the provider turn, so neither rests on echoed input |
| Genuine workout logged | PASS — 4 sets across 2 exercises |
| No durable write before approval | PASS — 0 durable rows, 0 appends |
| Preview before write | PASS — exactly the 4 intended sets, preview proof present |
| Browser approval | PASS — real review-card Save click routed through the gated `#approve-btn`; no direct write route |
| `Log_Cleaned` | PASS — exactly 4 rows |
| `Effort` | PASS — exactly 1 row |
| No duplicates or contamination | PASS — 0 foreign-identity rows, 0 cross-session delta, repeated approval added 0 rows |
| Closeout and seal | PASS — sealed ("✓ Saved to your sheet") |
| InteractionTrace | PASS — 6 valid records, all carrying stages |
| Turn-write proof | PASS — 1 authoritative live write (4 log rows, 1 effort row), preview-established on its own turn |
| Trace / write-proof join | PASS — joined on the live write's own `turn_id` `turn:2026-08-01T05:54:18.464Z_7_ij6lxi` |
| Evidence withholding honest | PASS |
| Artifacts privacy-safe | PASS — 9 artifacts scanned, 0 violations, within bound |
| Synthetic provenance | PASS — origin `playwright`, synthetic and evidence-ineligible; session id matches its declared purpose |

## Note on run duration

This session completed in **34.2 s**, back in line with sessions 1 and 2 and well under session 3's ~1.2 min. That confirms session 3's slowdown was transient Sheets **read**-quota throttling from three runs hitting the same workbook in quick succession, not a degradation in the product or the runner. No verdict was affected in either case.

## Session-start boundary

`RUN_START.json` records the crossing at **05:54:07.558Z**.

## Artifacts

Preserved locally and git-ignored at `stage-a-artifacts/session-4-20260801T055358-5F031A/` (378,324 bytes; 7 screenshots + 4 records).

| File | Bytes | SHA-256 |
|---|---|---|
| `scorecard.json` | 7,693 | `611647e14ab04694fa0d3aa875215ee70b1317a6eda265bc7fe759b0630427ed` |
| `SCORECARD.md` | 5,212 | `6f1c8f587708cf62b6050f931328cb0ba27a0458d19dc316ac4b9c122c52b8f2` |
| `evidence.json` | 22,255 | `1d70322411000941c284b717d34b316ba48c724d3fd45eead51f445ae9f419ac` |
| `RUN_START.json` | 359 | `1f1dfc55a7fe015734e8cb5feb5b54fb0a574b368dae26a8f2ae29a98305d15e` |

No credentials, no full Sheet id, no owner data, no unbounded logs.

Four consecutive sessions have passed. One remains. Stage B stays unopened; Phase 5 stays unauthorized.
