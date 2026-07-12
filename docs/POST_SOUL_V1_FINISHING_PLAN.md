# Atlas — Post-Soul V1 Finishing Plan (current-main-reconciled)

> **Status:** Adopted as governance, **queued behind Soul** (docs-only). Not active. The active execution queue stays the required Soul work in `docs/SOUL_PLAN_V1.md`; this plan becomes the governed next phase **only** when every required Soul exit criterion is recorded complete (see `docs/SOUL_PLAN_V1.md` → "Soul completion & Post-Soul handoff contract" and §Handoff below).
> **Governance layer:** a finishing lane subordinate to the Vision / Constitution / Invariants / Decision Kernel. It closes trust risks and proves the product; it does **not** add product scope.
> **Source:** the owner-provided external "Atlas Post-Soul V1 Finishing Plan" (baseline verified 2026-07-09, drafted at **PR #946**). This file is the **reconciled** installation of that plan against current `main` (**PR #995**). Every proposed item below is re-classified — *shipped / superseded / partially complete / still current* — with the PR, file, test, or code that supports the classification. The original task queue is **not** installed unchanged.
> **Model:** builder runs Opus 4.8 for all work (`CLAUDE.md` §"Model: Opus 4.8, always"). No model check-in.

---

## 0. Why this document is reconciled, not transcribed

The external plan was written against **PR #946**. Current `main` is **PR #995** — 49 merged PRs later. The honest, evidence-backed finding is:

**The post-Soul trust-risk queue (the `WRITE-*`, `CLIENT-*`, `SESS-*`, `PARSE-4/5` findings behind POST-02…POST-10) is almost entirely still-current.** The #947–#995 work was Soul-build, Session_Plans capture, the Workout Sheet, GATE A evidence provenance, and substitution correctness — **not** the specific finishing findings. What *did* land is **adjacent hardening** (see each item below), which changes the reconciliation of a few items but closes none of the core POST-02…POST-09 findings.

Therefore this plan installs the external doctrine (close silent-correctness risks → prove the seams → prove live → declare V1 → stabilize) and re-points every PR at the finding as it exists in current `main`, citing `BACKLOG.md` line-level status. **No status is invented; no item is reprioritized without cited evidence.**

---

## 1. The finishing thesis (preserved)

After Soul, the goal is **not** to make Atlas more capable. It is to prove that its parser, state, coaching voice, preview loop, and write path stay **truthful when the whole product is used together**.

- Atlas already has enough architecture, intelligence, governance, and personality to finish V1.
- The remaining danger is **silent correctness failure**: a dropped set, a stale preview, an ambiguous retry, conflicting session state, or a write without exact proof.
- Thousands of isolated unit tests are valuable, but the final gate must exercise the **seams** where the real app has historically failed.
- A V1 declaration must be **earned by live use**, not by reaching the bottom of another roadmap.

### Binding owner decisions (from the external plan — recorded, not re-litigated)

1. **Five consecutive clean live gym sessions define Atlas V1 done.**
2. **Any material (dirty) session resets the clean-session count to zero.**
3. **A substituted or recognized exercise variant satisfies the original planned slot** across recap, next-up, pin, handoff, and closeout. *(This is the material behaviour decision behind POST-10; see the POST-10 reconciliation for its current-main state — the semantics are owner-approved, the unified implementation is not yet built.)*
4. **Atlas V1 is a trustworthy owner-operated personal coaching product**; public multi-user readiness is explicitly out of scope.
5. **No new feature roadmap begins** during the finishing campaign or the two-week stabilization period.

> The **V1 Proving Run definition-of-done** (decision 1–2) is already filed as owner-reserved intake in `BACKLOG.md` → "ATLAS v1 proposal packet — intake" (Proposal B). Adopting it as the official "v1 done" definition is an owner check-in (`docs/OWNER_CHECKIN_RULES.md` criterion 2). This plan records it as the finishing lane's target; it does not unilaterally declare it adopted.

### The finish line (preserved)

> Soul complete → trust gaps closed → cross-seam proof green → five clean sessions → V1 declared → two-week defect-only stabilization.

### What this plan deliberately does NOT build (preserved)

User accounts / multi-tenant isolation · a database migration · a mobile app · a frontend-framework rewrite · broad wearable-vendor support · a public beta · another large coaching-intelligence roadmap · speculative cleanup without evidence of a product problem.

---

## 2. Entry gate and completion gate (reconciled to current main)

### Entry gate — **NOT yet satisfied**

POST-01 (this plan's adoption) may be installed as *queued* governance now, but the finishing **build** (POST-02+) may begin only after the repository can truthfully answer all of the following. Current-main state is recorded honestly:

| # | Entry-gate condition | Current-main state (2026-07-12) |
|---|---|---|
| 1 | Mandatory Soul Plan items complete | **NOT met.** Required Soul exit criteria remain open — see `docs/SOUL_PLAN_V1.md` → completion contract. |
| 2 | Optional Soul items clearly marked optional/deferred | Addressed by the Soul completion contract added in this PR (PR-B8b optional; PR-12B / drift Part 2b deferred). |
| 3 | Independent One-Brain burn-in / legacy-deletion clock documented and non-silent | **Documented.** GATE A (One-Brain promotion) runs on its own evidence clock; PR-GATEA1/GATEA2 shipped the provenance + scorecard, and the observation window was **reset** to a fresh provenance-tagged window (`docs/verification/GATEA1_WINDOW_RESET_RUNBOOK.md`). It is a **parallel clock**, per the Soul Plan's "two clocks" framing. See §Handoff for how it relates to Soul completion. |
| 4 | `main` is green | Assumed green at #995 (CI-gated merges). Re-verify at build time. |
| 5 | No open Soul PR | Re-verify at build time (this PR is docs-only and does not itself start a Soul PR). |
| 6 | Deployed app matches current `main` | Owner/deploy-verified live check required at build time. |
| 7 | Soul live-validation cards complete or carried | LT-007 **PASS**; LT-009 **PASS**; LT-010 (register/profanity) and LT-011 (reassure re-run) **pending** — carried into the Soul completion contract. |

**Honesty rule (preserved):** this plan may *record* missing gates; it may not pretend they are complete. The entry gate is **open** because Soul is not complete.

### Completion gate — Atlas may be declared V1 only when ALL hold (preserved)

1. POST-01…POST-11 merged.
2. No open P0/P1 finding can silently damage logging, preview approval, session truth, or write verification.
3. The full automated suite is green.
4. The cross-seam proving packs are green.
5. Five consecutive live sessions recorded clean.
6. POST-12 records the release.
7. Atlas enters a minimum two-week defect-only stabilization period.

### Definition of a clean session (preserved)

No fabricated/dropped/misinterpreted sets · correct lift identity, weight, reps, RIR, units · no false save claim · every live write returns adequate proof, no duplicate write · no stale preview, stale coach narration, white screen, or broken transition · session-completion and remaining-exercise state correct · naturally-occurring coaching reactions factual and calibrated · owner review within 24 h.

---

## 3. Reconciled PR matrix — classification with evidence

Legend: **Shipped** (already done) · **Superseded** (replaced by a different landed approach) · **Partial** (adjacent hardening landed; core finding open) · **Current** (still-open, still valid as written, refreshed to current main).

| PR | Concern | Finding | Classification | Evidence |
|---|---|---|---|---|
| **POST-01** | Adopt the finishing plan | governance | **Current — executed here (adapted)** | This PR installs the reconciled plan + Soul handoff contract; the five TEST_QUEUE proving-session cards are deferred until the proving run actually begins (post-POST-11), not created now. |
| **POST-02** | Closeout write-proof parity | `WRITE-1` | **Current** | `WRITE-1` still open — `BACKLOG.md` (`/api/complete-workout` discards append responses, no `logAppendedRange`, contra Invariant W3). |
| **POST-03** | Interrupted closeout idempotency | `WRITE-2`, `WRITE-3` | **Current** | Both still open — `BACKLOG.md` (stale-`in_progress` retry double-write; rehydration wedges `write_id` 409 for ~24 h). |
| **POST-04** | Ambiguous Sheets append recovery | `WRITE-5` | **Current** | Still open — `BACKLOG.md` (retrying `values.append` on 503 can double-write; `services/sheets.js`, pinned `test/unit.test.js`). |
| **POST-05** | Parser full-consumption + `@N` guard | `PARSE-4`, `PARSE-5` | **Current — adjacent parser trust hardened** | `PARSE-4`/`PARSE-5` still open. `PARSE-1/2/3` **shipped** (PR-0E/0F/0G) and D7(a) unresolved-**lift** gate **shipped** (#957, `services/unresolvedLiftGate.js`) — a **route-boundary** refuse-and-ask precedent to reuse, but neither closes unconsumed-set-token or `@N≤10` ambiguity. |
| **POST-06** | Preserve user-edited preview rows | `CLIENT-2` | **Current** | Still open — `BACKLOG.md` (table edits reverted when another set is logged before closeout; `src/app/app.js`). |
| **POST-07** | Ignore stale dry-run/preview responses | `CLIENT-3` | **Current** | Still open — `BACKLOG.md` (no staleness guard on `pendingWrite`). Related `CLIENT-1` (stale undo card) **shipped** (PR-0D) — client-trust hardening precedent, different bug. |
| **POST-08** | Canonical screenshot session date | `CLIENT-4` | **Current** | Still open — `BACKLOG.md` (Log rows dated today + Effort row dated screenshot date in one session). |
| **POST-09** | Current-state coach narration | `SESS-1`, `SESS-3` | **Current — foundation laid** | Both still open. PR-10 delivered the single store `SESS-1`'s fix reads from; `SESS-1` is dispositioned to the coach-announce (PR-11) scope. `SESS-3` (`closeoutAnnounced` never resets on plan re-open) unchanged. |
| **POST-10** | Authoritative planned-slot completion identity | PR-24 slice-3 divergence, `SESS-4`, `SESS-5` | **Partial — substring hardening landed; unified selector open** | See detailed note below. Substring→exact-name precedence **shipped** in plan-mutation/remove/skip paths (#993, #994, `matchesPlanEditName` follow-up); Session_Plans now folds substitution outcomes (#992); the **unified completed-planned-slot selector** across recap/next-up/pin/handoff/closeout (the slice-3 divergence) remains **open + owner-gated**. New consumer surfaced: the Workout Sheet duplicate-name completion-identity finding (`BACKLOG.md`, 2026-07-12). |
| **POST-11** | Cross-seam V1 proving packs | Proposal A Wave 1 | **Current — extend, don't duplicate** | Filed as `[housekeeping]` intake in `BACKLOG.md` ("ATLAS v1 proposal packet"); **not** promoted. Much CHAOS coverage already exists (Simulation Harness, Flight-Recorder replay, Playwright e2e — enumerated in the intake note); SIM-DALE/TERSE/RAMBLER unbuilt. Depends on POST-02…POST-10 fixtures. |
| **POST-12** | Declare Atlas V1 | release | **Current — terminal, blocked** | Blocked on POST-01…POST-11 + five clean sessions. The V1 definition-of-done itself is owner-reserved intake (Proposal B). |

**No POST item is marked *Shipped* or *Superseded*.** The reconciliation conclusion is that the finishing queue survives current main almost intact — one item (POST-10) is partially hardened, the rest are unchanged-and-valid, and POST-01 is what this PR executes in adapted form.

---

## 4. Reconciled item detail (refreshed to current main)

Only the items whose *execution detail* has drifted since #946 are expanded. The paste-ready prompts in the external plan remain the build spec; the notes below correct stale premises so a builder does not trust #946 line numbers.

### POST-05 — Parser full-consumption + `@N` ambiguity
- **Do not** wire a refusal inside `services/workoutTextParser.js` "with zero goldens changed" — that premise already failed once (D7(a), Decision Desk #942): the parser's alias table is narrower than the Exercise KB, so a parser-level refusal over-refuses catalog-known lifts. D7(a) shipped the refusal at the **route-orchestration boundary** (`services/unresolvedLiftGate.js` in `/api/parse-workout-text`) instead. `PARSE-4` (unconsumed set-shaped tokens) and `PARSE-5` (`@N≤10` weight-vs-RIR) are a **different** ambiguity than unresolved lift identity — reuse the *pattern* (route-level, KB-injected, fail-to-ask, parser goldens untouched), not the same module. `PARSE-1/2/3` already close variant-collapse, phantom-header, and implausible bare-pair loads; POST-05 closes the two remaining set-shape cases.

### POST-09 — Current-state coach narration
- The store single-source (PR-10) already exists; `SESS-1`'s re-derivation must read from it. The fix is in the **coach announce path** (`src/app/coach-conversation.js`), explicitly deferred out of the structural store migration ("relocate, don't change"). `SESS-3` (reopened closeout) is independent and unchanged.

### POST-10 — Authoritative planned-slot completion identity (the material behaviour decision)
This is the most-drifted item. Current-main reconciliation:
- **Owner semantics (binding decision 3)** — a substituted/recognized variant satisfies the original planned slot everywhere — are **recorded/owner-approved** in this plan, but the code does **not** yet unify them. The open core is the **PR-24 slice-3 divergence** (`BACKLOG.md`): `canonicalSessionRecap().remaining` (variant-aware, via `reconcileSubstitutedRemaining`) vs `remainingPlannedExercises()` (plain name-set, powers next-up/pin/handoff/closeout) can disagree after a substituted-variant log. Unifying them is a **coach-surface behaviour change** → owner-gated; lock-in tests currently pin both as store-derived.
- **Adjacent substitution correctness that DID land** (refresh, do not re-build): implicit-substitution decline + "give me something else" no longer skips (#984); context-aware auto-substitution avoids next-slot redundancy (#985); Leg Extension had no substitute catalog entry → explicit swap fell through and coach falsely said "Plan updated" — fixed (#986); "Done" after a substitution no longer erases the deviation from the Session_Plans fold (#992); **exact-name precedence outranks substring** in `resolvePlanTargets` / `remove_exercises` / `skip` (#993, #994, `matchesPlanEditName`→`planEditNameEquals` follow-up). These harden specific substring bugs — the same class as `SESS-5`'s raw-name substring hazard — but in the plan-mutation paths, not the completion selector.
- **`SESS-4`** (declared-swap skip guard only in `currentPlannedExercise`; `emitSetLogged` clears `pendingSubstitution` on a no-op apply) and **`SESS-5`** (`resolveCompletedIdentity` substring-first, no ambiguity refusal) remain open.
- **New consumer** to route through the single selector: the Workout Sheet's name-keyed card classification (`buildSheetCards`, `src/app/workoutSheet.js`) flips all same-named slots on one log — filed 2026-07-12. POST-10's "one canonical selector, every surface routed through it" must include this surface.

### POST-11 — Cross-seam proving packs
- **Extend the existing harnesses, do not create a new framework.** The Simulation Harness (`scripts/sim/`), Flight-Recorder replay fixtures (`test/fixtures/replays/`), and Playwright e2e already carry much of the CHAOS "historical live-bug reproduction" set (see the intake note for the exact fixture-by-fixture map). Add SIM-DALE / TERSE / RAMBLER and **extend** CHAOS with the POST-02…POST-10 repaired cases. Tier-1 deterministic checks join the suite; Tier-2 advisory text scans stay **report-only** (the `scripts/sim/run.js` runner hits a live model → nondeterministic; never a blocking LLM judge). Wave 2 stays gated on "Wave 1 caught/prevented ≥1 real defect."

---

## 5. Five-session V1 Proving Run (preserved, non-PR gate)

Starts only after POST-11 deploys. Feature development pauses; the next work is five real sessions, not another PR idea. Cards are filed in `docs/TEST_QUEUE.md` as LT-### session cards **when the run begins** (not created by this PR).

- **Session A — Normal workout + write proof:** planned workout, edit ≥1 preview row before Save, save, verify exact proof, inspect bound Undo identity.
- **Session B — Screenshot closeout:** import a screenshot with a real session date, confirm Log + Effort dates match, approve closeout, receive exact ranges, Undo removes only that write, resave if desired.
- **Session C — Substitution + plan mutation:** substitute one, reorder/skip another, add an off-plan exercise, verify recap/next-up/pin/closeout agree.
- **Session D — Interrupted + resumed:** reload/resume, exercise restart-safe state, interrupt a dry-run/preview and confirm an older response cannot overwrite the current one.
- **Session E — Ambiguous + natural language:** terse notation + a long dictation entry + one intentionally ambiguous set format; confirm Atlas asks instead of guessing, then finishes.

**Evidence per session:** date + session id · app version + deployed commit · scenario coverage · Flight Recorder reference · writes + proof ranges · observed coach moments · defects · owner verdict + current clean count.
**Reset rule:** a defect resets the count. Evidence → replay → fix → deploy → restart. Three resets → root-cause review.

---

## 6. Post-V1 stabilization (preserved)

For ≥2 weeks after POST-12: use Atlas normally; fix demonstrated defects only (with a reproduction); no V2 planning inside a defect PR; no storage/frontend migration; no public-user broadening; no ratified-voice change from one awkward sentence without a pattern.

**Stabilization exit review:** Did Atlas remain trustworthy? Which features were used? Which were ignored? What defects recurred? Is Atlas staying personal, or beginning a separately-authorized public-product V2?

---

## 7. Handoff — how this plan becomes active

This plan is **queued behind Soul**. The rule (authoritative copy in `docs/SOUL_PLAN_V1.md` → "Soul completion & Post-Soul handoff contract"):

1. **While any *required* Soul exit criterion remains open, Soul retains execution priority.** The active queue stays the required Soul work.
2. **Once every required Soul exit criterion is recorded complete**, the normal agent work-selection process (`CLAUDE.md` Backlog discipline → `docs/DECISION_KERNEL.md` document precedence → `docs/ACTIVE_ROADMAP.md`) must select **this document** as the next governed phase — **without requiring another owner prompt.**
3. **"Automatic handoff" means document-driven work selection only.** It creates **no** trigger, reminder, scheduled job, check-in, watcher, or background task. An agent selects this plan because the governance documents point here when Soul is done — nothing fires on a clock.

The One-Brain promotion clock (GATE A → PR-A5 → burn-in → PR-12B) is a **parallel clock** per the Soul Plan's own framing; whether its completion is a *blocking* Soul exit criterion is recorded in the Soul completion contract as an owner-gated question, not decided here.

---

## 8. Final sequence and owner review points (preserved)

POST-01 → POST-02 → POST-03 → POST-04 → POST-05 → POST-06 → POST-07 → POST-08 → POST-09 → POST-10 → POST-11 → **five clean sessions** → POST-12 → **two-week stabilization**.

- **POST-10 is the material behaviour decision.** A recognized substituted variant satisfying the original planned slot everywhere is the cleanest UX but changes next-up/closeout semantics — recorded as binding decision 3, implemented only when its owner-gated unification PR runs.
- **Final rule:** after Soul, Atlas does not need another personality. It needs to prove that the personality, state, parser, preview loop, and write path remain truthful when the whole product is used together. **Finish. Prove. Declare.**
