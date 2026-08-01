# Phase 4 Stage A — Session 2 — PASS

**Verdict: PASS. Stage A streak 2/5.**

Synthetic evidence. Never owner evidence, LT evidence, or a GATE A eligible event. Method, scorecard semantics, and the ambient-isolation reasoning are documented once in [`STAGE_A_SESSION_1_2026-08-01.md`](STAGE_A_SESSION_1_2026-08-01.md) and are not repeated per session.

## Run identity

| Field | Value |
|---|---|
| Date / time (UTC) | 2026-08-01, session began 05:40:36.456Z |
| Run purpose | `STAGE_A_SESSION`, session 2 of 5 |
| Source commit (`main`) | `0945475c45b0a7604e789ec770770bac614d3f9a` (clean, = `origin/main`) |
| Prior canonical count | 1/5, read from the execution plan |
| Command | `npm run atlas:stage-a-session -- --session=2 --model-up` |
| Run id | `stage-a-s2-20260801T054012-F35849` |
| Synthetic session id | `STAGEA-S2-20260801T054012-F35849` |
| Synthetic athlete id | `stage-a-athlete-F35849` |
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
| Grounded session question | PASS — "Bench Press today: 185 lbs.", naming the planned lift and its exact planned load; answered on a different turn from the provider turn, so neither rests on echoed input |
| Genuine workout logged | PASS — 4 sets across 2 exercises |
| No durable write before approval | PASS — 0 durable rows, 0 appends |
| Preview before write | PASS — exactly the 4 intended sets, preview proof present |
| Browser approval | PASS — real review-card Save click routed through the gated `#approve-btn`; no direct write route |
| `Log_Cleaned` | PASS — exactly 4 rows |
| `Effort` | PASS — exactly 1 row |
| No duplicates or contamination | PASS — 0 foreign-identity rows, 0 cross-session delta, repeated approval added 0 rows |
| Closeout and seal | PASS — sealed ("✓ Saved to your sheet"), no unsaved review card left |
| InteractionTrace | PASS — 6 valid records, all carrying stages |
| Turn-write proof | PASS — 1 authoritative live write (4 log rows, 1 effort row), preview-established on its own turn |
| Trace / write-proof join | PASS — joined on the live write's own `turn_id` `turn:2026-08-01T05:40:47.651Z_7_wk1v6g` |
| Evidence withholding honest | PASS |
| Artifacts privacy-safe | PASS — 9 artifacts scanned, 0 violations, within bound |
| Synthetic provenance | PASS — origin `playwright`, synthetic and evidence-ineligible; session id matches its declared purpose |

## Session-start boundary

`RUN_START.json` records the crossing at **05:40:36.456Z**, so this is a completed session rather than a run that never began.

## Artifacts

Preserved locally and git-ignored at `stage-a-artifacts/session-2-20260801T054012-F35849/` (378,287 bytes; 7 screenshots + 4 records). Screenshots and full logs are not committed.

| File | Bytes | SHA-256 |
|---|---|---|
| `scorecard.json` | 7,693 | `80342f293d4689f0046d0cc00eac22a708d683523dc9903c3b2a0920cbfffb46` |
| `SCORECARD.md` | 5,212 | `7772163fa5922e8ae96cdddbc697da9da205f74f0e3aae0071403cf00d7f1f54` |
| `evidence.json` | 22,255 | `122537e0f32abe76b6ec484fe4a1fe485f7476283e8b030b2ff3c6e44869c887` |
| `RUN_START.json` | 359 | `7e4d2bbdb61e4fc891710fff9ee356fbcb172f76408de3467a0fb8970ee352c4` |

No credentials, no full Sheet id, no owner data, no unbounded logs.

Two consecutive sessions have now passed. Three remain. Stage B stays unopened; Phase 5 stays unauthorized.
