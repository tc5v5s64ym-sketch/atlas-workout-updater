# Phase 4 Stage A — Session 1 — PASS

**Verdict: PASS. Stage A streak 1/5.**

Synthetic evidence. This is **never** owner evidence, LT evidence, or a GATE A eligible event, and it does not advance Stage B, the Milestone M4 proving run, or the Phase 7 owner streak.

## Run identity

| Field | Value |
|---|---|
| Date / time (UTC) | 2026-08-01, session began 05:12:34Z, scored 05:12 |
| Run purpose | `STAGE_A_SESSION` |
| Stage A session number | 1 of 5 |
| Source commit (`main`) | `4a233617bfe7186d804aed12cd271d7ae1f2b83e` |
| Prior canonical count | 0/5, read from `docs/ATLAS_V1_EXECUTION_PLAN.md` |
| Command | `npm run atlas:stage-a-session -- --session=1 --model-up` |
| Run id | `stage-a-s1-20260801T051224-868A33` |
| Synthetic session id | `STAGEA-S1-20260801T051224-868A33` |
| Synthetic athlete id | `stage-a-athlete-868A33` |
| Model posture | model-up |
| Model | `gemini-2.5-flash-lite` |
| Sandbox workbook | declared sandbox, last 6 `H3CeXE` |
| `stage_a_eligible` | **true** |

## Scorecard

**PASS 26 · FAIL 0 · ERROR 0 · NOT_APPLICABLE 1**

Every required condition passed. The single `NOT_APPLICABLE` is the one the owner ruling authorizes — Sheet-level `Session_Plans` / `Session_Plan_Sets` evidence — carrying that ruling's exact reason. No plan-ledger write was attempted or refused, the ledger write flags were off, and **neither tab was created, stubbed, or hidden**.

### Trust-loop results

| Criterion | Result |
|---|---|
| Sandbox posture proven before the port was published | PASS — 15 preflight checks, workbook last 6 `H3CeXE`, no in-memory Sheets stub |
| Production non-contact | PASS — 0 guard refusals; every append targeted `Log_Cleaned` or `Effort`; telemetry persistence off |
| Schema untouched | PASS — 0 `ensureSheetTab`, 0 row deletions, 0 cell rewrites |
| Model-up proven | PASS — provider reachable, coach not scripted, `gemini-2.5-flash-lite` answered |
| Live-provider use on the eligible turn | PASS — `/api/coach/chat` returned `source: gemini` with the model named; unambiguous |
| Grounded session question | PASS — "Bench Press today: 185 lbs.", naming the planned lift **and** its exact planned load |
| Genuine workout logged | PASS — 4 sets across 2 exercises (Back Squat, Bench Press) |
| No durable write before approval | PASS — 0 durable rows and 0 appends before the approval click |
| Preview before write | PASS — exactly the 4 intended sets, preview proof present |
| Browser approval | PASS — real click on the review card's Save, routed through the gated `#approve-btn`; no direct write route used |
| `Log_Cleaned` | PASS — exactly 4 rows, matching load / reps / RIR / set identity |
| `Effort` | PASS — exactly 1 row, matching duration / calories / HR |
| No duplicates or contamination | PASS — 0 foreign-identity rows, 0 cross-session row delta, and a repeated approval added 0 rows |
| Closeout and seal | PASS — rendered, approved, sealed ("✓ Saved to your sheet"), no unsaved review card left |
| InteractionTrace | PASS — 6 valid records, all carrying recorded stages |
| Turn-write proof | PASS — exactly 1 authoritative live write (4 log rows, 1 effort row), preview-established on its own turn |
| Trace / write-proof join | PASS — joined on the live write's own canonical `turn_id` `turn:2026-08-01T05:12:45.312Z_7_3cvfsq` |
| Evidence withholding honest | PASS — every record carries an explicit `withheld_evidence` list (0 withheld) |
| Artifacts privacy-safe | PASS — 9 artifacts scanned, 0 violations, within the byte bound |
| Synthetic provenance | PASS — origin `playwright`, classified synthetic and evidence-ineligible; session id matches its declared purpose |

### Ambient workbook isolation — two independent facts

The operator command reported an ambient `GOOGLE_SHEETS_ID` (last 6 `DuDcA0`) present in the shell and **not passed to the child**. The scorecard separately reported *no ambient workbook id present*. Both are true at their own level, and together they are the point: the launcher withheld the value, so the run's own process never received it, and the gate server resolved the declared sandbox from `config/sandboxSheet.js` on its own. Neither statement alone would prove isolation; the pair does.

## Session-start boundary

`RUN_START.json` records the crossing at **05:12:34.223Z** — written by the runner at the first composer submission, before the click. The session therefore genuinely began, and this PASS is a completed session rather than a run that never started.

## Artifacts

Raw artifacts are preserved locally, outside the repository, at:

```
stage-a-artifacts/session-1-20260801T051224-868A33/
```

That directory is git-ignored and holds 7 screenshots plus the four records below (378,326 bytes total). Screenshots and full logs are deliberately **not** committed. SHA-256 of the bounded evidence files:

| File | Bytes | SHA-256 |
|---|---|---|
| `scorecard.json` | 7,693 | `72d030b25b496b9e4b060f744df849ab26b5fb66b079a9173fff6521e2fe1d2b` |
| `SCORECARD.md` | 5,212 | `81319d7c62386d5df709cfafdecaf367f06222d517145194e4caa64dc3a683cc` |
| `evidence.json` | 22,255 | `2ce3e0ea105aedc86e37c74b6bdaf59c3315e8ba7dcdc0cc74da20455475bd11` |
| `RUN_START.json` | 359 | `8d58b3a73971a27840ed26f5664f92de4652323e558ee550d1e5e54466eaa58e` |

No credentials, no full Sheet id, no owner data, no unbounded logs.

## Observations (no action taken)

- Screenshots `06-after-approval.png` and `07-sealed.png` are byte-identical. That is correct behaviour, not a defect: the sealed state is what the client renders immediately after the approval completes, so the two capture points show the same screen.
- Two frozen scorecard conditions still word their evidence as "this canary" (`no_contamination`, and the owner-ruled `NOT_APPLICABLE` reason). The `NOT_APPLICABLE` string is the owner ruling's **exact required text** and must not be edited. The `no_contamination` detail is cosmetic wording only and decides nothing; changing it would mean re-running a passed session for a comment, so it is rejected rather than fixed.

## What this does and does not establish

It establishes that the whole machine path — real browser, real built client, real local Express backend, real production parser / router / session / coach / validator paths, real preview→approve→write loop, real closeout and seal — holds end to end for a complete session against the sandbox workbook, with the live model in the loop.

It establishes **one** session. Stage A needs five consecutive. It opens neither Stage B nor Phase 5.
