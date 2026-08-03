# Accepted-set-count discrepancy — source-first trace (2026-08-03)

Owner instruction, run read-only after the accepted-plan identity fix merged
(PR #1246, `main` at `3ae4fc9`). The claim under adjudication: *"all 24
`Session_Plan_Sets` rows carried `set_index=1` and `target_set_count=1` while the
visible proposal said × 3 sets."*

## Verdict — NON-DEFECT: the captured claim is unsupported by the durable authority

The production `Session_Plan_Sets` tab (read-only, Tier 1) holds 30 data rows
across two workouts, and **not one row carries `target_set_count=1`**:

| Workout | Items | Rows | `target_set_count` | `set_index` | source | seal |
|---|---|---|---|---|---|---|
| `20260724-PM-01` | 6 | 18 | 3 (every row) | 1..3 per item | `accepted` | one write id |
| `20260801-PM-01` (the 2026-08-02Z Stage B rerun) | 6 | 12 | 2 (every row) | 1..2 per item | `accepted` | one write id `09a00fe3…` |

`atlas:review-live --session=FR-20260802003433-ekvc9w8r` independently reports
`ledger_sealed` PASS: **12 of 12** correlated rows sealed under one
`closeout_write_id`, chain valid, one session identity (`20260801-pm-01`),
matching the finalized closeout.

## The trace, source-first

1. **Where proposal set counts originate.** The engine's intent recommendation
   carries per-exercise `target_sets` (3 on 2026-07-24, 2 on 2026-08-01 —
   engine-derived, not a constant). Separate engine surfaces (the replacement
   proposal via `/api/recommend/next`, `src/app/activeReplacement.js`) render
   their own `× N sets` from their own recommendation — a substitute proposal
   saying "× 3 sets" while the accepted plan's items carry 2 is two engine
   prescriptions on two surfaces, not a ledger contradiction.
2. **What acceptance sends.** `normalizePlanExercise` maps `target_sets → sets`;
   `buildLedgerAcceptedItems` projects `target_set_count = sets` per item
   (verified live against the gate sandbox: the checkpoint POST carried
   `target_set_count: 2` per item when the displayed pick prescribed 2 working
   sets per exercise).
3. **What creates each checkpoint row.** `buildAcceptedRows`
   (`services/sessionPlanLedger.js`) expands one row per planned set —
   `set_index` 1..`target_set_count`, source `accepted`. The production rows
   match this shape exactly.
4. **Why `target_set_count` "becomes 1".** It does not — no inspected durable row
   shows it, in any lane. Two lanes can structurally write
   `(set_index=1, target_set_count=1)`: the implicit-recommendation lane always
   does (`buildImplicitRows`, one next set only by design, source
   `implicit_unplanned`), and the accepted lane does for a genuinely one-set item
   (`buildAcceptedRows` loops 1..count for any positive count). The lanes are
   distinguished by `recommendation_source`, and the conclusion here is limited
   to the production rows actually inspected: all 30 carry source `accepted` with
   counts 3 and 2 — zero `(1,1)` rows of either lane exist. The likeliest origin
   of the claim is a column misread of a capture (`plan_version` is `1` on every
   row and sits three columns left of `set_index`).
5. **What the rows represent.** One accepted slot's each planned set, with the
   full target — per design amendment A2. Neither a one-set truncation nor a
   malformed projection.
6. **Whether visible remaining-work consumes those rows.** No. Remaining work
   derives from the client store (`effectivePrescription`:
   `acceptedSetCount = slot.sets`). On the un-substituted path that is the same
   accepted-exercise value the ledger's `target_set_count` was projected from at
   acceptance — one source, two consumers.

   **The substitution path COULD diverge the two grains — and that divergence
   was a real defect, established in review and fixed the same day (correction
   2026-08-03).** The original version of this paragraph called it recorded
   design; adversarial review (Codex P1 on PR #1248) established the full
   failure chain and it was verified link-by-link: `applySessionSubstitution`
   overwrote `slot.sets` with a replacement prescription's own (larger) set
   count; `effectivePrescription` read that mutable value as `acceptedSetCount`;
   an approved post-log set revision carried it into `buildFutureRevisions`,
   which emitted a v2 revision for a set with no v1 predecessor
   (`nextRevisionVersion` never consults the durable ledger); the closeout
   seal's `validateChain` then failed `non_contiguous_version` →
   `malformed_chain` with nothing stamped — permanently, since every retry
   recomputes the same chain. The verified seal became unreachable for that
   workout. The fix: `accepted_set_count` is stamped immutably per slot at
   acceptance (the same value the accepted checkpoint projects into
   `target_set_count`), never overwritten by a substitution, and every revision
   path is bounded by it; `slot.sets` remains the display grain. Regression +
   defect reproduction against the real store and seal:
   `test/immutableAcceptedSetCount.test.js`. None of this changes the capture
   adjudication above: the inspected session's ledger contains zero revision
   rows, so no substitution grain shaped the rows the capture described.

## Figure discrepancy noted honestly

The campaign state recorded the rerun as "24 rows sealed"; the durable tab and
`atlas:review-live` both show **12** rows for that session under one seal. The
12-row figure is the durable truth (the tab's other 18 rows belong to
`20260724-PM-01` under a different seal). The "24" and the "all rows (1,1)"
figures appear to come from the same capture artifact, which the durable records
do not support. Because the execution plan is the sole campaign authority, the
correction is applied there in this same PR (the rerun block now carries the
12-row figure with a dated correction note); the settled conclusion it supported
— workout 1's zero checkpoint rows were the write flag's own rollout, not a
checkpoint defect — survives unchanged, since 12 sealed rows on the same code
path prove the checkpoint exactly as 24 would have.

## Consequence

- No product fix FOR THE CAPTURED CLAIM. No authority defect there: one
  projection (`buildLedgerAcceptedItems` → `buildAcceptedRows`) owns the
  checkpoint's set counts and the durable rows agree with the displayed plan.
  *(Correction 2026-08-03: the adjacent substitution-inflated revision defect
  established in review — step 6 above — WAS a real product defect and is fixed
  with its own regression; the capture verdict is unaffected.)*
- The earlier "the pin displayed 1 of 3 sets" claim stays retired — unsupported
  by artifacts, per the owner instruction.
- F-SB4B rehearsal assertions about `Session_Plan_Sets` should assert the real
  contract: per-item `target_set_count` equal to the accepted plan's per-item
  set count (the immutable v1 grain — never a substitute's display count),
  `set_index` enumerating 1..count, source `accepted`, revisions only for sets
  within the v1 grain, one seal per session.

Everything in this trace was read-only; nothing was created, changed, or written
in any workbook.
