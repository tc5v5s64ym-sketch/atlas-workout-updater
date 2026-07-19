# F10D — Production readiness: proof coverage, first live write, rollback

**Status:** F10D is built and proven in dry-run/stub/sandbox/integration coverage only. The production `Session_Plan_Sets` tab does **not** exist, `SESSION_PLAN_SETS_WRITE_ENABLED` is **not** set, and no production ledger write has occurred. Everything below this line is the evidence package and the owner-gated procedure; **none of it may be executed without Dale's explicit authorization** (CLAUDE.md owner-reserved: schema action, flag change, first live write).

This document is items 4–7 of the owner's return bundle (2026-07-18 directive). Items 1–3 (PRs, CI/Codex status, transcript + screenshots) live in the PRs and the regenerated artifacts under `test-results/f10d-closeout/<project>/` (run `npx playwright test tests/e2e/gate/f10d-closeout.spec.js` to regenerate).

## 1. The thirteen proving items — where each is proven

| # | Item | Proof |
|---|---|---|
| 1 | Rejected confirmation writes nothing | E2E `tests/e2e/gate/f10d-closeout.spec.js` **F10D-R**: confirmation rendered, abandoned; ZERO Log/Effort appends, ZERO finalized events, ZERO seal updates; the accept-time checkpoint stays durable and UNSEALED; session intact after reload |
| 2 | Approved closeout end-to-end | E2E **F10D-A**: one Save writes Log + Effort + finalized event and seals the ledger under one `closeout_write_id` |
| 3 | Visible-plan ↔ ledger parity | E2E **F10D-A** (sealed rows keep the immutable original codes `[OHP01, RDL01, RDL01, SQ01]` while Front Squat was performed) + `test/closeoutSealIntegration.test.js` (dry-run both-truths parity) |
| 4 | Visible-actual ↔ Log_Cleaned parity | E2E **F10D-A** (appended rows ≡ the session log visible at approval, name/weight/reps multiset) + `test/api-smoke.test.js` F10D block |
| 5 | Substitutions and skipped work | E2E **F10D-A** (card: "Front Squat (substituted — in for Back Squat)", "Overhead Press (skipped)") + `test/closeoutSummary.test.js` |
| 6 | Revised future-set targets | `test/closeoutSummary.test.js` (per-set effective-version targets; revised tag) + `test/sessionLedger.test.js` / `test/sessionRevisionWiring.test.js` (F10B revision lanes) |
| 7 | Unannounced exercise — reliable and `no_reliable_target` | `test/implicitRecommendationWiring.test.js` + `test/sessionPlanSetsRoutes.test.js` (F10C: derivation, leakage exclusion, rule 5 no-append) + summary `no_reliable_target` honesty in `test/closeoutSummary.test.js` |
| 8 | Effort write | E2E **F10D-A** (typed manual effort rides the one approval; `average_hr`/`peak_hr` distinct) + `test/closeoutSealIntegration.test.js` |
| 9 | Idempotent retry | E2E **F10D-RT** (fresh-`write_id` retry after seal outage: zero duplicate Log/Effort rows, event folded, seal lands) + integration same-`write_id` replay + already-sealed `conflicting_seal` fail-closed |
| 10 | Partial append failure fails closed | `test/closeoutSealIntegration.test.js` (Effort append failure → no seal attempted, honest error) |
| 11 | Reload/resume before closeout | E2E **F10D-RL**: reload mid-session, resume, closeout seals the SAME pre-reload checkpoint rows (no re-checkpoint) |
| 12 | Malformed ledger chain fails closed | `test/closeoutSealIntegration.test.js` + `test/sessionPlanSetsStore.test.js` (`malformed_chain` diagnostics; no partial seal) + card warning render in `test/closeoutConfirmWiring.test.js` |
| 13 | Zero production writes throughout | Structural: every lane above runs against the in-process stub (`sheets.js` require.cache-replaced; no Google client initialized; state server attests `sheets_stubbed_in_memory`). The default-posture F10S-GATE spec additionally proves ZERO appends/updates end-to-end with the flags off — the exact production posture of today |

## 2. Exact proof payload and failure behavior

An approved closeout (`POST /api/log-workout`, no `test_mode`, with `closeout_context`) returns:

- **Log:** `sheet_write: 'success'`, `log_appended_range` (positive range evidence), appended-row count.
- **Effort:** `effortWritten: true` with its append result (absent if no effort row staged).
- **Session_Plans event:** `session_plans_closeout: { captured: true, status: 'written' | 'skipped' }` — `skipped` = idempotent fold on retry; `disabled` / `no_plan` only when the lane is off or the session has no accepted `pv_` token (both count as *inapplicable*, not verified-failure).
- **Ledger seal:** `ledger_seal: { sheet_written: true, sealed, already_sealed, sealed_ok: true, column: 'O' }` — proof is the exact updated-cell count; a count disagreement returns `seal_proof_mismatch` and is **not** `sealed_ok`.
- **The composite verdict:** `closeout_fully_verified: true` only when every applicable surface above verified.

Failure behavior (all proven):

- Seal outage after committed appends → `closeout_fully_verified: false`; the client reports honestly ("Workout written … but the plan-ledger record could not be verified. Your sets are safe; tap Save again to re-verify (no rows will duplicate)."), keeps the staged write alive under a **fresh** `write_id` with the effort row dropped, and the review card's Save becomes `Retry ledger seal` — the retry re-appends nothing (composite-key dedup), folds the event idempotently, and seals.
- Unreadable ledger (metadata or row read outage) → `ledger_read_failed`, seal fails **closed**; never reported as "no stored plan".
- Planned closeout with zero ledger rows → **not** fully verified (a lost checkpoint never masquerades as success); a freestyle no-item session stays verified-empty.
- Malformed ledger chain (duplicate version, fork, dangling/non-immediate supersedes, non-contiguous) → seal refused with diagnostics; the confirmation shows the inconsistency warning; sets still save.
- Already-sealed session retried under a **different** `write_id` → `conflicting_seal`, fail-closed (a closeout can never be re-claimed).
- Same-`write_id` replay → idempotent `all_sealed`, `sealed_ok: true`.

## 3. Production tab headers — exact, in order

`Session_Plan_Sets` (16 columns, `config/columns.js` `sessionPlanSetsColumns`, design §2):

```text
idempotency_key | session_id | session_date | plan_version | plan_item_id | planned_lift_code | set_index | target_set_count | target_weight | target_reps | target_rir | recommendation_source | supersedes_key | confidence | closeout_write_id | recorded_at
```

This line is pinned by a test to `config/columns.js` `sessionPlanSetsColumns` — if they ever disagree, the suite fails. (Codex P1 on the original draft: `supersedes_key`/`confidence` were hand-typed swapped; the capture layer's exact-header validation would have rejected the mis-created tab fail-closed, but the owner-facing template must be exact, so it is now generated-verified, not trusted.)

Append-only. `closeout_write_id` (column **O**) is the ONLY cell ever updated in place, exclusively by the seal (`sheets.updateColumnCells`, bounded single-column), stamping the shared approved `write_id` onto the session's rows.

## 4. Smallest bounded first-live-write procedure (owner-gated — DO NOT EXECUTE without Dale)

1. **Owner creates the tab** (no agent schema action): a `Session_Plan_Sets` tab in the production spreadsheet with row 1 exactly as §3 (16 headers, exact order/spelling). No other rows.
2. **Owner sets the flag** on Render: `SESSION_PLAN_SETS_WRITE_ENABLED=1` (`ATLAS_SESSION_PLANS_WRITE` per its current production setting — it is a separate, already-governed lane). Deploy; confirm boot via `npm run atlas:status`.
3. **One bounded owner session** (the smallest complete exercise of every lane): accept a small real plan (2 slots is enough) by pressing **"Start this plan"** — the acceptance boundary now enforces this: a set logged from a displayed-but-unaccepted plan blocks with that one action, so the first canary's silent-freeform shape cannot recur → log it (include one substitution or skip if convenient, not required) → type or upload effort → "done" → review the single confirmation → **Save once**.
4. **Verify immediately** with `npm run atlas:review-live` — the `ledger_sealed` criterion now automatically verifies the seal (one nonblank shared `closeout_write_id` on every correlated ledger row, valid chain, cross-tab closeout agreement, exact evidence range); corroborate with the response evidence (`closeout_fully_verified: true`, `ledger_seal.sealed_ok: true`, positive Log/Effort ranges).
5. **Stop.** No second session until the owner reviews the first write's evidence.

## 5. Rollback / containment if the first write misbehaves

- **Freeze:** owner unsets `SESSION_PLAN_SETS_WRITE_ENABLED` (lane reverts to dry-run instantly — the store is flag-gated per request; no deploy required beyond the env change). Per CLAUDE.md, any production data-integrity anomaly freezes writes immediately.
- **Contain (ledger):** `Session_Plan_Sets` is an append-only companion tab with exactly one mutable column (O). Wrong/partial seal → the rows are inert history; nothing reads them for coaching decisions in V1 runtime paths (F10E is not built). Do not hand-edit; leave the evidence in place for triage. The seal's fail-closed lanes (`conflicting_seal`, `seal_proof_mismatch`, `malformed_chain`) mean a bad state is *visible*, never silently absorbed.
- **Contain (Log/Effort):** unchanged existing surfaces with the existing undo: the review card's Undo (`/api/log-workout/undo-last`) removes the appended Log range read-back-verified, fail-closed. Effort follows the existing duplicate-session guard.
- **Recover:** because the ledger is append-only + idempotency-keyed, a corrected retry after a fix re-appends nothing and re-seals under the governing rules; no migration, no rewrite, no deletion is ever part of recovery. Anything beyond flag-off + evidence triage is owner-decision territory.

## 6. Residual gaps

**None.** The two gaps declared in earlier revisions of this document are closed (owner readiness directive, 2026-07-18):

- **Screenshot-with-rows closeout** now routes through the SAME single confirmation: the upload converts client-side into the one `/api/log-workout` closeout payload (vision parse → screenshot-date resolution → rows re-stamped under the resolved identity → `effort_row` + `closeout_context`), inheriting the confirmation, seal, finalized event, verification, and reachable retry. There is no second closeout workflow — the `/api/complete-workout` write lane remains only for effort-only uploads (no session rows), which are not session closeouts. Proven end-to-end by the `F10D-SS-R` / `F10D-SS-A` / `F10D-SS-RT` scenarios (rejected-writes-nothing, approved parity with the parsed effort riding the one approval, idempotent seal retry).
- **`atlas:review-live` evaluates the seal**: the `ledger_sealed` criterion verifies, for the newest tested session, that expected ledger rows exist, every applicable row carries the SAME nonblank `closeout_write_id`, the sealed count matches the correlated-row count, no mixed/conflicting/partially-sealed/malformed state exists (chain-validated through the same fail-closed selectors the seal uses), and Log / Effort / Session_Plans / Session_Plan_Sets agree on session identity and closeout. PASS / FAIL / UNKNOWN per criterion with exact evidence ranges (`Session_Plan_Sets!A2:P4` style) and concise failure reasons; an absent or unreadable tab is UNKNOWN, never an inferred PASS — so §4 step 4's verification is now fully automatic.
