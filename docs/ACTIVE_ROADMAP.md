# Atlas Active Roadmap

> **Governance layer:** Roadmap — see [`docs/GOVERNANCE.md`](GOVERNANCE.md) for the full hierarchy.

This is the current execution queue after completing the June 2026 session-state trust-repair series (Steps 372–377) and the trust-first refill (Steps 379–385, all merged).

**Current active workstream: Trust-Critical Coach Interaction Layer (P0–P4).** Live testing (2026-06-20) surfaced a trust failure — Atlas loses active-session context and answers session questions with generic fitness education — that takes priority over remaining backlog work. This is a **diagnosis-first** workstream: see the section "Active workstream — Trust-Critical Coach Interaction Layer" below and the investigation doc [`COACH_INTERACTION_TRUST_INVESTIGATION.md`](./COACH_INTERACTION_TRUST_INVESTIGATION.md). No implementation until the P0/P1 findings are reviewed.

`BACKLOG.md` remains the single source of truth for open and deferred work. This file is the detailed active queue. When these two files disagree, stop and ask the owner before changing direction.

Use `docs/DOCS_INDEX.md` to understand which older docs are active reference, historical context, or archived plans.

## Roadmap Step numbers vs GitHub PR numbers

These are separate things. A Roadmap Step is a logical build unit defined here. A GitHub PR is a pull request opened on GitHub, which gets its own number from GitHub's sequence. They will often differ.

GitHub issue numbers are a third namespace. A Roadmap Step may reference a GitHub issue, but they are not the same number; for example, Roadmap Step 380 may reference GitHub issue #359, which is not Roadmap Step 359.

Use terminology like:

- **Roadmap Step 381** — the logical unit of work defined in this file
- **GitHub PR #392** — the actual pull request on GitHub

Do not assume they match. BACKLOG.md records both where they diverge (e.g. "Roadmap Step 364 / GitHub PR #366").

## Why priority changed

The performance intelligence layer has mostly been built, but app testing exposed session-execution trust failures:

- impossible lateral raise loading
- poor exercise ordering
- missing confirmation cards
- plan drift during active workouts
- reorder vs substitute confusion
- no clean session closeout

Steps 372-377 repaired session-state trust. Step 378 re-verified coach sanitizer null guards. Steps 379-385 now follow a trust-first order: fix the residual session cursor bug, repair history and recommendation trust failures from app testing, then return to deload consolidation and lifecycle wiring.

Build order:

1. Fix session execution and trust failures. Done (372-377)
2. Wire existing intelligence into the live coach path. Done (372-377)
3. Re-verify coach surface runtime guards. Done (378)
4. Fix residual session-cursor staleness from reorders. (379)
5. Repair history, recommendation, and save-boundary trust failures from app testing. (380-382)
6. Consolidate and correct the deload recommendation system. (383-385)

## Global rules

- Tiny PRs.
- One concern per PR.
- Automation-first: do **not** stop after every PR. Proceed through the Autonomous Build Loop and **merge merge-ready PRs** (Claude holds full merge authority), continuing to the next approved task; stop only when an owner check-in criterion is met (`docs/OWNER_CHECKIN_RULES.md`) or the owner interjects. (Hold points below are **owner-initiated**, not automatic — `docs/AGENT_WORKFLOW.md` "Hold points".) The earlier "stop after every PR for owner review" rule is the legacy human-driven cadence and is superseded.
- Deterministic engine first, AI voice second.
- Do not touch write paths unless the PR explicitly says so.
- Do not change Sheet schema unless explicitly approved.
- Tests must prove the previous failure cannot recur.
- Tests must cover the live path or closest integration path, not only new helpers.

---

## Completed steps

All steps below are merged. Recorded here for traceability; do not re-execute.

| Roadmap Step | Description | Status |
|---|---|---|
| 355 | Session Plan Executor | ✅ complete |
| 356 | Confirmation Card Consistency | ✅ complete |
| 357 | Reorder vs Substitute vs Skip vs Add Intent | ✅ complete |
| 358a | plan_completed wiring | ✅ complete |
| 358b | Readback card consistency | ✅ complete |
| 359 | Plan Action Classifier (`classifyPlanAction`) | ✅ complete |
| 360 | Session Closeout Flow | ✅ complete |
| 361 | Load Sanity Bounds (`loadSanity.js`) | ✅ complete |
| 362 | Live Intelligence Wiring | ✅ complete |
| 363 | Historical Context Reactions (system-prompt rules) | ✅ complete |
| 364 | Out-of-order closeout trust bug (GitHub PR #366) | ✅ complete |
| 365 | Missed Lift / Planned-vs-Completed Memory | ✅ complete |
| 366 | Suggested Workout Engine (`suggestedWorkout.js`) | ✅ complete |
| 367 | Workout Recommendation Evidence (`reason_codes`) | ✅ complete |
| 368 | Trend-Aware Recommendations | ✅ complete |
| 369 | Readiness-Aware Recommendations | ✅ complete |
| 370 | Coach Confidence Layer (`confidence_factors`) | ✅ complete |
| 371 | Coach Voice Polish (remove e1rm_trend ambiguity) | ✅ complete |
| 372 | Substitution updates authoritative session state (`applySubstitution`) | ✅ complete (GitHub PR #388) |
| 373 | Coach reads the authoritative live session | ✅ complete (GitHub PR #389) |
| 373b | Apply accepted substitution into the live session | ✅ complete |
| 374 | Planned exercise names are always loggable | ✅ complete (GitHub PR #392) |
| 375 | Coach "what's left" reads authoritative state | ✅ complete (GitHub PR #394) |
| 376 | Suppress cross-lift history contamination | ✅ complete (GitHub PR #399) |
| 377 | Deterministic fallback for session-close questions | ✅ complete (GitHub PR #400) |
| 378 | Coach sanitizer null guard — re-verification (guards + tests already present) | ✅ complete (pre-existing) |

Deferred items from each completed step are recorded in `BACKLOG.md`.

### Legacy step mapping

The original roadmap named Steps 358–360 and 364 differently from the numbers above. The build re-sequenced them as work progressed. Recorded here so future agents do not treat these as missing or unbuilt.

| Original roadmap label | What shipped | Where |
|---|---|---|
| Step 358 — Session Closeout Flow | Split into 358a (plan_completed wiring) + 358b (readback card) + 360 (closeout engine) | `services/sessionCloseout.js`; BACKLOG "Resolved PR 358a/358b/360" |
| Step 359 — Exercise Order Guardrails | Shipped as part of PR 4.2 session builder: `isBlockedPair` (compounds before accessories, no hinge+hinge) | `services/sessionBuilder.js`; BACKLOG "PR 4.2 — session builder" |
| Step 360 — Warm-Up / Ramp-Up Logic | Shipped as part of PR 4.2 session builder: `buildWarmupRamp` (50%/70%/85% ramp, priming-flagged) | `services/sessionBuilder.js`; BACKLOG "PR 4.2 — session builder" |
| Step 364 — Substitution History Builder | Shipped as GitHub PR #364: `services/substitutionHistory.js::buildSubstitutionHistory` (modal-lift heuristic, 3 false-positive guards) | BACKLOG "Resolved (PR 364)"; Roadmap Step 364 was later reused for the out-of-order closeout bug fix (GitHub PR #366) |

---

## Active queue - Trust-first roadmap refill (Steps 379-385)

This sequence is intentionally small. It refills the active roadmap from `BACKLOG.md` and recent app-test findings after the session-state trust-repair series.

Build order:

1. Fix the residual reorder cursor bug before more session-state work builds on it.
2. Repair history QA so Atlas answers from actual logged sets.
3. Repair recommendation identity/exclusion so recently trained movements are not repeated without justification.
4. Repair the recommendation preview/save boundary so planned work never looks like completed work.
5. Return to deload consolidation only after the new trust failures are filed.

### Roadmap Step 379 - Reorder session index bugfix

**Status:** complete

**Type:** Correctness (session execution)

**Recommended model:** Opus 4.8.

**Risk level:** Medium.

**Exact failure prevented:** When the user says something like "leg extension is taken, gonna do laterals first" and the coach routes accordingly, `activePlannedSession.index` is not advanced by the conversational reorder - only the "Next exercise ->" button does so. On subsequent messages in the same session, `checkAndSuggestSubstitute` sends the wrong `current_exercise` to the substitute endpoint because the cursor still points at the skipped/taken exercise. The session-state model from Steps 372-373 is authoritative, but the index cursor lags behind it.

**Why it belongs now:** The bug sits directly in the active session flow. More history and recommendation work should not build on a stale current-exercise cursor.

**Vision / Dream fit:** Atlas must understand what the owner is actually doing in the session, including real-world reorders, so the coach can adapt without losing the plan.

**Constitution / trust guardrails:** No write-path or Sheet schema change. The engine/session state decides; AI only explains. `public/app.js` is restricted and must be named in scope before editing.

**Scope:** `public/coach-conversation.js` and `public/app.js` (coach-routing branch only - no write-path or preview-panel change). After a coach reorder is acknowledged, clear or re-point `activeExercise` so subsequent substitution/current-exercise checks use the correct planned slot. No write-path, no schema, no LLM change.

**Acceptance criteria:**
- A conversational reorder ("X is taken, doing Y first") advances or re-points the authoritative session cursor.
- Subsequent `checkAndSuggestSubstitute` calls send the correct `current_exercise`.
- The "what's next / what's left" coach answer still reads from the authoritative state (Step 373/375), not the stale cursor.
- No write-path or schema change is present.

**Expected tests:** integration or unit tests proving that after a simulated reorder message, the session index points at the correct next exercise and the substitute-check sends the right exercise name.

**Out-of-scope:** parser changes, schema changes, write-path changes.

> **Note on `public/app.js`:** This file contains the preview->approve->write trust loop and is a restricted file per `CLAUDE.md`. The fix touches the coach-routing branch only. It must be named in scope before editing begins.

---

### Hold point - App-test reorder / "what's left" / substitution

After Step 379 is merged, pause for owner review and optional app-test before history/recommendation trust work begins.

**Focus test:** active session reorder ("X is taken, doing Y first"), "what's next / what's left" response accuracy after a reorder, and substitution/current-exercise behavior on subsequent messages.

---

### Roadmap Step 380 - GitHub issue #359: Historical lift retrieval must use actual logged sets

**Status:** complete (pre-existing; issue #359 closed). Verified in current `main`: `buildRecentSessions` (`services/analytics.js`) emits per-set `lift_sets` (weight/reps/RIR in order, capped 12); `buildChatContext` (`index.js`) forwards `lift_sets` into the `/api/coach/chat` context; `services/coach.js` carries the explicit HISTORY RULE (answer past-workout questions ONLY from `recent_sessions[*].lift_sets`, never prescription/plan/recommendation/benchmark) and `sanitizeChatContext` preserves the sets; `test/coach.test.js` pins the #359 regression (lift_sets fidelity + RIR-0 preservation). No code change required — re-listed by the #405 roadmap refill after the issue was already closed.

**Recommended model:** Opus 4.8.

**Risk level:** High.

**Failure or opportunity addressed:** Atlas must answer prior-workout questions from actual `Log_Cleaned` rows. Historical lift answers must preserve per-set weight, reps, and RIR. They must not substitute planned, prescribed, recommendation, or benchmark-style summaries for what was actually logged.

**Why it belongs now:** If Atlas cannot accurately answer "what did I do last time?", every downstream coach response and recommendation loses credibility.

**Vision / Dream fit:** The Dream depends on Atlas understanding actual training history, not just planned intent or derived summaries. Raw logs are the input; session understanding is the product.

**Constitution / trust guardrails:** Google Sheets is the source of truth. Engine/data retrieval owns the facts. AI may word them but must not invent or replace logged set details. No write-path or Sheet schema change.

**Scope:** History retrieval / coach-history QA only. No recommendation logic, no parser changes, no writes.

**Acceptance criteria:**
- Prior-lift answers are based on actual `Log_Cleaned` rows.
- Each returned/logged set preserves weight, reps, and RIR when present.
- Planned sets, prescriptions, benchmarks, and recommendation summaries are not substituted for logged sets.
- No write-path or schema change is present.

---

### Roadmap Step 381 - GitHub issue #402A: Recent-lift exclusion / Seated Row identity normalization

**Status:** complete (resolved by GitHub PR #404). The exact repro — Seated Row prescribed the day after it was logged — is fixed by the recency exclusion added to `scoreIntents` (`services/analytics.js`): an exercise trained yesterday (`daysSince === 1`) is dropped from `allRecs` before any intent builder runs, so ROW01 (Seated Row, last set 2026-06-18) is excluded on 2026-06-19. PR #404 also dedups `allRecs` by exercise name (the most-recently-trained variant wins) as a guard against the same display name appearing under multiple codes. **Identity investigation finding:** in current `main` only `seated row → ROW01` exists (`knownLiftCodeOverrides`); the `SR01`/`BOR01` codes named in the issue are hypothetical and not present, so there is no live multi-code split for Seated Row. The only genuine residual identity-split risk — rows logged under a generated code *before* an override existed — is already tracked in `BACKLOG.md` as the SESSION_DESIGN AC5a "liftCode history-merge for pre-override rows" item. No new code required for #402A.

**Recommended model:** Opus 4.8.

**Risk level:** High.

**Failure or opportunity addressed:** Exact failure: Atlas prescribed Seated Row after Seated Row was logged on 2026-06-18. Investigate exercise identity / lift-code normalization across Seated Row variants such as `ROW01`, `BOR01`, and `SR01` if present. Recently trained movements should not be recommended again unless explicitly justified.

**Why it belongs now:** This is a current recommendation-trust failure. The owner should not see a movement repeated as if it were fresh right after logging it.

**Vision / Dream fit:** Atlas should remember recent work and recommend the next justified step from real training history, not from fragmented identity records.

**Constitution / trust guardrails:** Engine owns recommendation facts. Do not invent justification in the LLM. No write path, no Sheet schema change, and no recommendation should bypass real logged history.

**Scope:** Recommendation identity / recent-lift exclusion investigation and fix. No deload work, no parser work, no writes.

**Acceptance criteria:**
- Seated Row logged on 2026-06-18 is recognized as recently trained for recommendation purposes.
- Seated Row variants / lift codes are normalized or grouped correctly where they represent the same movement.
- Recently trained movements are not recommended again unless the engine exposes an explicit justification.
- No write-path or schema change is present.

---

### Roadmap Step 382 - GitHub issue #402B: Suggested workout preview must not look save-ready

**Status:** complete (PR #410). Root cause: `public/nav.js` rotated the composer placeholder through `PLACEHOLDER_HINTS` (incl. "Say 'log it' to save your session") every 4.5s and only stopped on `atlas:set-logged` — so a *displayed suggested workout* (nothing performed yet) kept getting overwritten with the save-ready hint. Fix: `setWorkoutPlaceholder` (`public/coach-conversation.js`) now dispatches `atlas:placeholder-owned` whenever coach-conversation sets a contextual placeholder (suggestion, freestyle, plan-complete); `nav.js` suppresses the generic rotation on that event. The suggestion's own closing copy was already non-save-ready. Frontend-only; no write-path/schema/parser/LLM change. Source-introspection test added (`test/unit.test.js` "Step 382").

**Recommended model:** Opus 4.8.

**Risk level:** Medium.

**Failure or opportunity addressed:** Exact failure: the suggested workout screen showed save-oriented copy like "Say 'log it' to save your session" even though no actual sets were performed/logged. Recommendation previews must remain distinct from completed workout sessions.

**Why it belongs now:** This is a save-boundary trust failure. Suggested work must not create phantom-save pressure or imply that unperformed sets are ready to commit.

**Vision / Dream fit:** Atlas should reduce gym friction while staying clear about what happened versus what is only suggested. The owner approves actual training data, not hypothetical plans.

**Constitution / trust guardrails:** No blind writes. No phantom sets. Recommendation previews are not completed workout sessions. AI can suggest and preview; the owner approves only actual logged work before production writes.

**Scope:** Suggested workout preview copy/state boundary only. Do not change write semantics, Sheet schema, or production behavior outside this boundary.

**Acceptance criteria:**
- Suggested workout previews do not show completed-session or save-ready copy.
- Recommendation preview state remains distinct from performed/logged session state.
- The UI does not pressure the owner to save sets that were never performed.
- No write-path or schema change is present.

---

### Hold point - App-test history / recommendation / save-boundary trust

After Steps 380-382 are merged, pause for owner review and app-test before deload work resumes.

**Focus test:** prior-lift history QA, today's workout recommendation after recent logs, and confirmation that recommendation preview does not create phantom-save pressure.

---

### Roadmap Step 383 - GitHub issue #291: Deload prescription consolidation

**Status:** complete. DRY cleanup: added `computePrescription` to the `deloadProtocols` import in `index.js` and replaced the 9-line inline load-cut math at ~line 1569 with a single `computePrescription(protocol, { working_weight: nt.weight })` call — identical arithmetic, one canonical source. The path becomes user-visible once Step 385 wires the lifecycle. No behavioral change.

**Recommended model:** Opus 4.8.

**Risk level:** Low–Medium (smaller than originally framed).

**Type:** Correctness (recommendation logic)

**Investigation finding (2026-06-20):** The original premise — "two prescription paths coexist and show *contradictory* prescriptions on Coach's Pick vs the next-set card" — is **inaccurate**. Evidence: (1) `computePrescription` (`services/deloadProtocols.js`) has **zero production callers** — it is dark, referenced only by its own module + test. (2) There is **no "Coach's Pick" UI** anywhere in `public/` — the term exists only in this roadmap's prose. (3) The only live "deload suggestions" surface is `GET /api/coaching/insights` via `suggestDeloads` (volume-first, *holds* weight). (4) The next-set card's active-deload load-cut is computed **inline in the route** (`index.js` ~1569-1579: `next_target.weight × protocol.load_multiplier`), duplicating `computePrescription`'s math instead of calling it — and it only fires when `Deload_State` is active, which the client never sets (Step 385 is dark). So the two surfaces never describe the same lift simultaneously and cannot contradict.

**Real (reduced) scope:** A DRY cleanup — have the inline route math call `computePrescription` so there is a single prescription source — which only becomes user-visible once Step 385 wires the lifecycle. Because the load-cut path is dark today, this is low-urgency and best done alongside (or just before) Step 385. **Original (inaccurate) framing retained below for history.**

**Original failure-or-opportunity statement (superseded):** Two prescription paths currently coexist - `computePrescription` (the canonical engine) and the older volume-first `suggestDeloads` path. The Coach's Pick surface and next-set card may route through different models and can show contradictory prescriptions. Both surfaces must derive from a single canonical source.

**Why it belongs now:** After the new history/recommendation trust failures are filed, visible deload prescription surfaces still need one canonical source before the frontend starts advancing deload state.

**Vision / Dream fit:** The finished Atlas coach should feel calm and coherent. One engine verdict with readable evidence supports the dream of a reusable training-intelligence layer.

**Constitution / trust guardrails:** Anchor on deterministic `computePrescription`; do not let AI choose numbers. No write path, no Sheet schema change. Tests must prove both surfaces agree.

**Scope:** Service-layer consolidation. Point both the next-set card and Coach's Pick/insights overview at `computePrescription` as the single prescription source. Retire or bypass the `suggestDeloads` volume-first path where it conflicts. Pure service-layer refactor - no write-path, no schema, no LLM change.

**Acceptance criteria:**
- Both the next-set card and Coach's Pick surfaces read from `computePrescription` only.
- `suggestDeloads` is either retired or explicitly subordinated so it cannot produce a contradictory recommendation on any live surface.
- Tests prove both surfaces agree (same prescription model, same output shape) when given identical inputs.
- All five `DELOAD_SPEC.md` behaviors remain pinned in golden fixtures.
- No write-path or schema change is present.

**Expected tests:** golden fixtures in the deload/prescription test suite covering all five spec behaviors; an integration test proving Coach's Pick and next-set card return consistent prescriptions from the same model.

**Out-of-scope:** frontend lifecycle wiring (-> Step 385), trigger-logic changes (-> Step 384), LLM prompt changes, schema changes.

---

### Roadmap Step 384 - Deload trigger nuance: no accessory/deprioritized false positives

**Status:** complete (done before Step 383, re-ordered after investigation — it is the real, concrete bug). The accessory-downgrade engine `annotateStallsForDeload` (`services/coverageStalls.js`) already existed but was wired ONLY into `scoreIntents` (session planning), not into the live deload-suggestions surface (`suggestDeloads` → `GET /api/coaching/insights`) the owner actually sees. Fix: `suggestDeloads` (`services/analytics.js`) now applies `annotateStallsForDeload` and filters out `ignored_for_deload` accessories, so a flat accessory whose primary muscle is covered by other lifts (the live Shrugs case) no longer surfaces a deload. The Dumbbell-Curl-progressing (40→53 lb) case is already handled upstream: `detectStalls` measures estimated-1RM, so a genuinely rising lift is never flagged. Golden test added (`test/analytics-edge.test.js` "Step 384"). The five `DELOAD_SPEC.md` protocol behaviors remain pinned by `test/deload-protocols.test.js` (unchanged). No write-path/schema/LLM change.

**Type:** Correctness (recommendation logic)

**Recommended model:** Opus 4.8.

**Risk level:** Medium.

**Failure or opportunity addressed:** Confirmed live failures: Dumbbell Curl was flagged as stalled while its e1RM was actively progressing (40 -> 53 lb); Shrugs was flagged despite being barely trained as a direct lift. The trigger evaluates all flat lifts equally regardless of their role in the program. A deload recommendation triggered by a secondary or accessory lift when primary compounds are progressing normally is worse than no recommendation - it erodes trust in every subsequent deload signal.

**Why it belongs now:** Coach's Pick is the surface the owner starts from. False deloads on low-priority accessories erode trust faster than missing a marginal deload.

**Vision / Dream fit:** Atlas should understand what actually matters in training, not just collect flat signals. The engine should distinguish primary training evidence from accessory noise.

**Constitution / trust guardrails:** Deterministic trigger logic only. Coach voice may word the engine result but must not invent the reason. No write path, no schema change, no LLM prompt change.

**Scope:** Isolated change to the deload-trigger evaluation logic. The trigger should weigh primary-lift evidence; accessories and deprioritized lifts should be downgraded or excluded as trigger sources when primary-compound signals do not corroborate. No change to what a deload prescribes, only when the trigger fires. No write-path, no schema, no LLM change.

**Acceptance criteria:**
- Dumbbell Curl with a progressing e1RM (40 -> 53 lb) does not trigger a deload.
- Shrugs alone does not trigger a deload when compound lifts are progressing normally.
- Main compound lifts that are genuinely stalling continue to trigger correctly.
- Golden fixtures pin all five `DELOAD_SPEC.md` behaviors and the live false-positive examples.
- No write-path or schema change is present.

**Expected tests:** golden-fixture tests in the deload trigger suite covering the Dumbbell Curl progressing case, the Shrugs case, and at least two genuine-stall cases where the trigger must fire.

**Out-of-scope:** prescription model changes (-> Step 383), frontend lifecycle wiring (-> Step 385), LLM prompt changes, schema changes.

---

### Hold point - App-test deload trigger + prescription

After Steps 383-384 are merged, pause for owner review and app-test before frontend lifecycle wiring.

**Focus test:** Coach's Pick deload recommendation, next-set card deload prescription, deload trigger accuracy on accessory vs. primary lifts, and consistency between both prescription surfaces.

---

### Roadmap Step 385 - GitHub issue #289: Frontend deload lifecycle wiring

**Status:** complete. Wired `begin`/`advance`/`resolve` in `public/app.js`. `begin` fires fire-and-forget when a `deload_reset` planned session starts (409 absorbed — already-in-deload is valid). `advance` fires after a confirmed live log write when the active session is `deload_reset` and was not a duplicate-blocked replay. When `advance` returns `training_state: POST_DELOAD_EVALUATION`, `resolve` fires immediately (auto-resolve after the final deload session). None of the calls touch `Log_Cleaned`, workout rows, or proof fields. Source-introspection tests added to `test/unit.test.js`.

**Type:** Correctness (write-path-adjacent) - HIGH RISK; explicit scope required before editing

**Recommended model:** Opus 4.8.

**Risk level:** High.

**Failure or opportunity addressed:** The deload state machine (`services/deloadState.js`, `Deload_State` tab) is fully built server-side but the client never calls `/api/deload/begin|advance|resolve`. Saving a workout does not advance the machine. `deload_sessions_remaining` never decrements, `deload_exit_criteria` is never evaluated, and the system accumulates no real state transitions - it is effectively dark.

**Why it belongs now:** Lifecycle writes should happen only after the deload trigger and prescription are trustworthy. Wiring state transitions before that would persist questionable decisions.

**Vision / Dream fit:** Atlas should remember recovery state across sessions, not just display a one-off recommendation. This deepens the engine while preserving the approve-before-save trust loop for workout data.

**Constitution / trust guardrails:** This is write-path-adjacent and requires explicit scope before editing `public/app.js`. Deload lifecycle calls write only to append-only `Deload_State`; they must never alter `Log_Cleaned`, `Effort`, workout rows, or dry-run proof fields. No Sheet schema change.

**Scope:** Frontend lifecycle wiring only. Wire the `begin`, `advance`, and `resolve` calls in `public/app.js` at the correct approved lifecycle moments (begin on deload start, advance on session save, resolve on exit criteria met). No new schema columns. No `Log_Cleaned` or workout-row involvement. `Deload_State` tab writes only, per the existing 7-column append-only schema. No LLM change.

**Acceptance criteria:**
- `begin` is called only when a deload is explicitly started (not on every save).
- `advance` is called only on a successful session write, not on dry-run/test_mode.
- `resolve` is called only when exit criteria are met, not preemptively.
- None of the lifecycle calls alter `Log_Cleaned`, workout rows, or the preview->approve->write trust loop.
- Tests prove `begin`/`advance`/`resolve` calls happen only at the correct lifecycle moments and that `test_mode: true` dry-runs do not trigger them.
- `sheet_write`, `sheet_written`, `log_rows_written`, and `no_write_confirmed` proof fields are unaffected.

**Expected tests:** integration tests in `test/api-smoke.test.js` proving the lifecycle boundary conditions (dry-run does not call advance; approve calls advance exactly once per save; `Log_Cleaned` row count is unchanged by lifecycle calls).

> **`public/app.js` restriction:** This file contains the preview->approve->write trust loop and is a restricted file per `CLAUDE.md`. It must be named in scope before editing begins. The deload lifecycle calls are system-state writes to `Deload_State` only - they are NOT logged sets and do NOT route through the preview trust loop.

**Out-of-scope:** prescription model changes (-> Step 383), trigger-logic changes (-> Step 384), schema migrations, LLM prompt changes.

---

## Active workstream — Trust-Critical Coach Interaction Layer (P0–P4)

**Origin:** live testing 2026-06-20. Atlas occasionally loses active-session context and answers educational questions when the lifter is clearly asking about the active workout ("What am I doing next?", "Weight? Reps? RIR?", "How much am I lifting, how many reps, how many sets?"). Expected: answer from the active-session prescription. Actual: generic explanations of RIR / rep ranges / volume. This is a trust issue — it makes Atlas appear to forget the workout in progress. This workstream supersedes remaining backlog priority until P0/P1 are resolved.

**Goal:** Atlas must always prioritize active workout context over generic fitness knowledge.

**Mode:** diagnosis-first. Full root-cause analysis is in [`COACH_INTERACTION_TRUST_INVESTIGATION.md`](./COACH_INTERACTION_TRUST_INVESTIGATION.md). **No code changes until the owner reviews the P0/P1 findings.**

### P0 — Active Session Context Integrity

**Status:** ✅ **shipped (GitHub PR #442, owner-approved/merged).** Routing fix only.

**Root cause (confirmed):** chat is routed **SME-first**. `public/coach-conversation.js::getChatReply` calls `POST /api/coach/ask` (the deterministic training-knowledge SME, which has *no* session context) before the session-aware coach `POST /api/coach/chat`, and short-circuits on any non-`log_only` card answer. Session questions whose wording collides with an SME card's match terms (`RIR` → `rir_rpe`; `how many reps` → `rep_ranges`; `how many sets` → `training_volume`) are intercepted and answered with generic education, never reaching the coach that knows the prescription. Secondary contributor: the coach prompt permits generic education and lacks an explicit "answer current-exercise prescription from session state first" rule.

**What shipped (PR #442):** new `public/sessionQuestion.js` (UMD pure `isSessionStateQuestion`) flags live workout-state questions and returns false for explicit education; `getChatReply` skips the SME and routes to `/api/coach/chat` first **only** when an active workout exists (`current_plan`/`current_preview`/`plan_completed` in the chat context) AND the message is session-shaped. Education and ambiguous messages keep SME-first routing. Read-only; no LLM/prompt, write-path, schema, trust-loop, or parser change. Tests: `test/sessionQuestion.test.js` + SW cache-guard update; full suite green.

**Deferred (documented complementary item, not built — per owner "no broad AI prompt changes"):** the `buildChatSystemPrompt` "answer current-exercise prescription from session state first" rule. Filed in `BACKLOG.md`. The LLM answer currently relies on the `current_plan`/`current_preview` context the session coach already receives.

**Non-blocking note from review (for the owner live spot-check):** a few classifier patterns are broad (`/\binstead\b/`, `/\bhow much\b/`); during an active workout an education-flavored question containing those tokens routes to the (read-only, grounded) session coach. Safe; could tighten later if it misroutes real education questions.

**Success criteria:** active-workout questions always use session context first; prescription requests never route into generic education; "what next" always references current workout state; session state has higher priority than general chat intent.

### P1 — Coach Signal Visibility Audit

**Status:** diagnosed (needs one live repro to disambiguate); **implementation held.**

**Finding:** the substitution-quality signal (`scoreSubstitutionQuality`, wired PR #439) only fires when a prescribed-vs-logged pair reaches `buildSubstitutionPreviews` via `prescribedList`. That list is built from parser-detected swap phrasing / explicitly-attached `plan_exercises`, **not** from silently comparing logged lifts against the active plan. A passive deadlift→RDL log without explicit swap phrasing yields no pair → no signal. Same active-session-context gap as P0. Secondary, by-design contributor: RDL-for-deadlift is a *good* swap → owner-approved rule keeps good swaps intentionally brief/quiet, so even when it fires it is easy to miss. **Reproduce the live flow** (was it phrased as a swap? was `plan_exercises` attached? did `data.substitutions` come back non-empty?) to disambiguate (a) never fired vs (b) fired-but-quiet vs (c) routing conflict before any code change.

### P0 follow-ups — shipped

- ✅ **Free-form chat counts as active context** (#446): `getChatReply` treats an in-progress conversation as active context, so session shorthand no longer leaks to SME mid-conversation.
- ✅ **Coach-down deterministic engine fallback** (#449): `services/sessionQuestionAnswer.js` answers in-session shorthand from `recommendNextSet`/plan-preview targets when Gemini is unavailable, instead of "Coach is unavailable." See `BACKLOG.md` for the two deferred review notes + the open Gemini-reliability item.

### P2 — Extra Work Coach Signal (PR #440)

**Status:** ✅ **shipped/merged (#440).** Engine fact `extra_work` wired into the coach chat context (on-ask/recovery-gated wording). Follow-ups tracked in `BACKLOG.md`.

### P3 — Coach Brevity Pass

**Status:** not started. Responses should prefer Conclusion first, Reason second, Details only when asked (e.g. "Hold 116. You're right on target." over "Trend is flat over the last 8 sessions…").

### P4 — Session-State Stress Testing

**Status:** ✅ **shipped.** Test-only — new `test/sessionStateStress.test.js`: a system-level stress corpus of messy human inputs ("rack busy", "I'll do RDL instead", "skip that", "legs are toast", "what now", "how much", "what am I doing next") run across the deterministic routing/answering guards *together* (`isSessionStateQuestion`/`isPlannedLiftQuestion`, `answerBareShorthand`/`answerPlannedLiftQuestion`, `isTirednessExpression`/`buildTirednessRecoveryAnswer`, `classifyMessageIntent`) to prove session state is preserved and prioritized over generic chat/education — independent of LLM availability (all helpers are pure). Includes negative controls (education + plain logging not hijacked), the ambiguous-lift "ask which one" guard, the never-hype/never-invent-a-load recovery guarantee, and the AC8 phantom-set floor under messy input. No production code change. Full suite green (2381). Detector-gap finding filed in `BACKLOG.md` (recovery `FRAMING` list omits "quads").

---

## Active queue — Onboarding + working-weight discovery (Steps 386–387, promoted 2026-06-20)

Promoted from `BACKLOG.md` by owner decision (2026-06-20) after approval of Owner
Review Pack #2 ([`docs/ONBOARDING_WORKING_WEIGHT_SPEC.md`](./ONBOARDING_WORKING_WEIGHT_SPEC.md)).
Owner scope: **promote PR-O1 and PR-O2, build PR-O1, then hold before PR-O2 for
review.** Deterministic-engine-first; the voice gate (PR-O3) and UX (PR-O4) remain in
`BACKLOG.md`, unpromoted, until PR-O1/O2 land and the owner promotes them. All numbers
trace to existing engine facts; nothing here changes write-path, schema, the trust
loop, or any LLM/prompt.

### Roadmap Step 386 — PR-O1: onboarding state engine

**Status:** in progress (this PR).

**Type:** Correctness (engine, pure). **Risk level:** Low. **Recommended model:** Opus 4.8.

**Scope:** `services/onboardingState.js` — a pure, deterministic module that derives a
per-lift `calibration_status` (`calibrating` | `graduated`) from the EXISTING
`lift_confidence` ladder (`services/exerciseBenchmark.js`: `none`/`low` → calibrating,
`medium`/`high` → graduated). Re-encodes no threshold — consumes the ladder's label.
**Per-lift only**, never majority-gated (owner call 4). No I/O, no LLM, no write-path,
no schema, no route, no `index.js`/`public/app.js` edit.

**Acceptance criteria:**
- `calibration_status` is `graduated` exactly when `lift_confidence ∈ {medium, high}`
  (the existing `medium` = ≥3-logged-sessions boundary), else `calibrating`.
- Status is reported per lift; a calibrated squat and an unknown deadlift stay
  distinguishable (no single session-level "still learning" flag).
- Unknown/missing confidence maps to `calibrating` (safe direction).
- Golden tests pin the spec's F4/F5 grounding (ladder-driven status; confidence_factors
  shape). No write-path or schema change.

### Roadmap Step 387 — PR-O2: onboarding session-template builder

**Status:** in progress (this PR) — owner released the hold (2026-06-21, "Go O2").

**Type:** Correctness (engine, pure). **Risk level:** Low–Medium. **Recommended model:** Opus 4.8.

**Scope:** `services/onboardingSessionPlan.js` — a pure, deterministic
`buildOnboardingSessionPlan({ availableEquipment, lifts })` that emits the spec §3
full-body calibration plan (3 sessions, 8 reps @ 2 RIR across
squat/push/pull/hinge, widening to a vertical push + one isolation in S2/S3),
selecting a lift variant per pattern from available equipment. Every number is
engine-owned: start hints from `buildWorkingWeightProtocol` (70% hint / "Start
conservative"), ramps from `buildWarmupRamp` (50/70/85%) offered **only once a
working weight exists** (F7), per-lift `calibration_status` from PR-O1's
`calibrationStatusFor` (no majority gate). A user reference seeds the start hint
but never raises confidence (owner call 5); unsupported-equipment patterns are
dropped (spec §5). No I/O, no LLM, no write-path, no schema, no route, no
`index.js`/`public/app.js` edit.

**Acceptance criteria (met):**
- Three sessions, 8 reps @ 2 RIR; cold start → every slot `calibrating` with a
  "Start conservative" hint and no ramp.
- F1–F3 start-hint rounding flows through `buildWorkingWeightProtocol` (185→130,
  225→160, 275→195, 100→70); a reference never flips `calibration_status`.
- F7 warm-up ramp appears only when a working weight is present; a `graduated`
  label without a working weight falls back to a calibration hint (never fabricates
  a ramp).
- Per-lift only: a graduated squat and a calibrating hinge coexist in one plan.
- Equipment-aware variant selection (barbell default; dumbbell/bodyweight swaps;
  unsupported patterns dropped). Golden tests in `test/onboardingSessionPlan.test.js`.

---

## Active queue — Training Intelligence Implementation Series (promoted 2026-06-22)

Promoted by owner decision (2026-06-22) as the build series implementing the Training Profile Taxonomy ([`docs/TRAINING_PROFILE_TAXONOMY.md`](TRAINING_PROFILE_TAXONOMY.md)) and the Session Planning Engine ([`docs/SESSION_PLANNING_ENGINE.md`](SESSION_PLANNING_ENGINE.md)) planning specs. **The owner promoted the full 478–486 series into the active queue (2026-06-23)** — build one tiny PR at a time, in order. Deterministic-engine-first; the LLM only words facts. Tiny PRs. (The `PR 47x` labels are the owner's logical slice numbers; GitHub PR numbers are a separate namespace.)

**Series progress (2026-06-23):**
- ✅ **PR 477** — RIR-aware coach accountability (engine PR-A #478 + wiring PR-B #479) — shipped.
- ✅ **PR 478 — Exercise Modality Schema** — shipped: pure-data `services/exerciseModality.js` (`modalityFor`), reference-only, no write-path/schema change. Golden-fixture coverage of Taxonomy §3.
- ✅ **PR 479 — Session Objective Scoring Fixtures** — shipped: pure `services/objectiveScoring.js` (frozen §3 weights + `combineObjectiveScore`/`selectObjective`), golden-fixture-protected before the scorer.
- ◐ **PR 480 — Pure Session Objective Scorer** — next: computes the term sub-scores from real inputs, satisfying the PR 479 fixtures.
- PRs 481–486 follow in order (see `BACKLOG.md` "Training Intelligence Implementation Series").

### Roadmap Step / PR 477 — RIR-aware coach accountability + live pressing fatigue routing

**Status:** approved; pre-coding report delivered. **Owner confirmation required before editing production files** (owner standing instruction for this slice — no production edits until confirmed).

**Type:** Behavior-changing coach/session logic. **Trust-sensitive.** **Risk level:** Medium-high. **Recommended model:** Opus 4.8.

**Scope guardrails (explicit):**
- **Current weighted/RIR workflow only** — the resistance grammar Atlas already parses.
- **No parser grammar expansion.**
- **No Sheet schema change** (12-col `Log_Cleaned` / 9-col `Effort` / 5-col `Constraints` / 7-col `Deload_State` untouched).
- **No write-path change**; preview→approve→write trust loop, `test_mode`/proof fields, and undo unchanged.
- **No multi-modality logging yet** (cardio/bodyweight/holds/AMRAP/EMOM/circuits → PR 486+).
- **No full profile-score engine yet** (→ PR 480/482).
- **No deload implementation yet** (→ PR 485; does not change `docs/DELOAD_SPEC.md` / `computePrescription`).

**Exact behavior change:** When a weighted set sequence is logged (e.g. `Bench 135 10/5 185 10/2 235 6/2 6/0 4/1`), Atlas (a) ignores warmup/feeder sets (early, RIR ≥ 4, clearly lighter than the working load) — no sandbag callout; (b) flags an unplanned RIR-0 work set as a redline and a same-load rep drop after it as fatigue confirmation; (c) holds/caps pressing progression and marks pressing intra-session yellow; (d) when the next planned move shares the prime mover (weighted dips/incline/heavy OHP), suggests a pull movement first, else a lighter/optional next press; (e) words a high-RIR work set as underdosed ("bump coming"). Isolation RIR 0 is caution-only — not treated like a heavy compound. Pain (if already flagged) keeps priority over progression.

**Proposed files/functions:** new pure `services/setEffortSignals.js` (`analyzeSetSequence`, `assessNextMoveConflict`); new reason codes in `services/trainingKnowledge.js` (`REASON_CODES`); wiring via `services/analytics.js` (`recommendNextSet`), `services/coach.js` (prompt rule + one sanitized field), `public/coach-conversation.js` (routing + deterministic copy), possibly a tiny `public/app.js` thread-through. Deterministic-first; LLM-down fallback templates required (reuse `effortVerdict`, `patternFor`, `musclesFor`, `classifyLiftRole`, the verdict/rule-decision coach channel).

**Reason codes:** `warmup_feeder_ignored`, `redline_set`, `rep_drop_after_redline`, `pressing_readiness_yellow`, `same_prime_mover_conflict`, `reroute_pull_first`, `cap_next_press`, `high_rir_workset_underdosed`.

**Tests:** pure-helper golden fixtures (`test/setEffortSignals.test.js`): `bench_warmup_high_rir_not_sandbagging`, `bench_redline_rep_drop_blocks_progression`, `bench_redline_before_weighted_dips_reroutes`, `high_rir_workset_callout`, `isolation_rir0_not_treated_like_heavy_compound`, `no_overreaction_to_one_hard_set_without_overlap`; plus a coach-copy wording/severity test and an api-smoke assertion that no row is written by the dry-run path.

**Owner check-in:** trust-sensitive coach surface + restricted files (`public/app.js`, `services/coach.js`) → owner confirmation gate before editing production (`docs/OWNER_CHECKIN_RULES.md` criteria 2/3). Pre-coding report stands; await owner go.

---

## Future / backlog items - not active execution

Do not start these from this roadmap refill unless the owner explicitly promotes them:

- Coach / Deep Coach verbosity tiers.
- Conversational input robustness and elasticity.
- Settings / user-preferences panel.
- Preference learning from edits.
- Substitution-history and missed-lift memory expansion beyond shipped state.
- Suggested workout engine expansion and new routes beyond the filed #402A/#402B trust fixes.
- Friendly errors / contradictory panel polish.
- Pending-exercise queue persistence decision.
- Lift-code history merge for pre-override rows (`SESSION_DESIGN AC5a`) unless separately promoted.
- Nutrition, bodyweight expansion, signature programs, auth/productization, multi-user, and platform/API work.

---

## Origin

Steps 372-377 were sequenced from the June 2026 app-test failures (six findings, priority-ordered). Step 378 re-verified pre-existing coach sanitizer guards. Steps 379-385 refill the active roadmap from `BACKLOG.md`, the product Vision/Dream, GitHub issues #359, #402A, #402B, #291, and #289, and the remaining trust-sensitive app-test findings. Each implementation PR stays tiny and one-concern; deferred discoveries go to `BACKLOG.md` in the same PR.

## New chat / agent instruction

Read this file before changing roadmap direction. Execute the next approved step. Under the automation-first workflow (`docs/AUTOMATION_PROTOCOL.md`), proceed through the Autonomous Build Loop and merge merge-ready PRs without stopping — pausing only when an owner check-in criterion applies (`docs/OWNER_CHECKIN_RULES.md`). When this queue empties, refill it from `BACKLOG.md` per the Roadmap Refill Loop (`docs/AGENT_WORKFLOW.md`) rather than idling. Changing roadmap *direction* (Vision/Dream/Constitution, or promoting owner-gated scope) remains an owner decision.
