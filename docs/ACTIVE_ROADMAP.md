# Atlas Active Roadmap

> **Governance layer:** Roadmap — see [`docs/GOVERNANCE.md`](GOVERNANCE.md) for the full hierarchy.

This is the current execution queue after completing the June 2026 session-state trust-repair series (Steps 372–377).

`BACKLOG.md` remains the single source of truth for open and deferred work. This file is the detailed active queue. When these two files disagree, stop and ask the owner before changing direction.

Use `docs/DOCS_INDEX.md` to understand which older docs are active reference, historical context, or archived plans.

## Roadmap Step numbers vs GitHub PR numbers

These are separate things. A Roadmap Step is a logical build unit defined here. A GitHub PR is a pull request opened on GitHub, which gets its own number from GitHub's sequence. They will often differ.

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

Steps 372–377 repaired session-state trust. Steps 378–382 harden the coach surface, fix residual session-cursor staleness, and bring the deload system to a consistent and correctly triggered state.

Build order:

1. Fix session execution and trust failures. ✅ (372–377)
2. Wire existing intelligence into the live coach path. ✅ (372–377)
3. Harden the coach surface against runtime failures. (378)
4. Fix residual session-cursor staleness from reorders. (379)
5. Consolidate and correct the deload recommendation system. (380–382)

## Global rules

- Tiny PRs.
- One concern per PR.
- Stop after every PR for owner review.
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

## Active queue — Coach hardening + deload correctness (Steps 378–382)

This series addresses two clusters of open work following the session-state trust repair:

1. **Steps 378–379:** Two focused correctness fixes — a runtime null-throw risk in the live coach surface and a session-cursor staleness bug left by the 372–377 reorder wiring.
2. **Steps 380–382:** The deload system is the most prominent coaching surface (Coach's Pick). It has confirmed live failures: wrong lifts triggering deloads and two competing prescription models disagreeing. Fix trigger correctness and consolidate prescriptions before wiring the lifecycle.

Build order: engine/correctness fixes first (378–379), then deload consolidation (380–381), then lifecycle wiring (382). Hold points separate the two clusters for app-testing.

### Roadmap Step 378 — Coach sanitizer null guard

**Status:** pending

**Type:** Correctness

**What this addresses:** The BACKLOG item "Harden null-element tolerance in the coach sanitizers" was written before PR 3.4 propagated the `s && typeof s === 'object'` null-element guard to all three arrays. Verification against current `services/coach.js` confirms the guards are already present: `today_sets` via `toSet` (line 71), `last_working_sets` via inline guard (lines 83–87), `current_preview` via inline guard (line 592). No uncaught throw exists today.

**Opportunity:** The BACKLOG item was never marked done and has no regression tests pinning the guards. The implementer should verify each guard holds, add a `[null]`-element test for each array, and mark the BACKLOG item resolved. If re-verification finds a genuinely unguarded array, add the guard too.

**Scope:** `services/coach.js` (guards only, if any are missing) + `test/coach.test.js` (null-element tests). No change to coach wording, system prompt, LLM model, write path, schema, or recommendation logic.

**Acceptance criteria:**
- Re-verify all three arrays (`today_sets`, `last_working_sets`, `current_preview`) against current `services/coach.js` before writing any code.
- A `[null]`-element test for each array proves the guard holds and cannot silently drift.
- If a guard is confirmed missing, add it; otherwise tests only.
- No coach wording, prompt rule, or recommendation behavior is altered.

**Expected tests:** three null-element tests in `test/coach.test.js` (one per sanitizer, each covering a `[null]` input element).

**Out-of-scope:** prompt changes, voice changes, write-path changes, schema changes, recommendation changes.

### Roadmap Step 379 — Reorder session index bugfix

**Status:** pending

**Type:** Correctness (session execution)

**Exact failure prevented:** When the user says something like "leg extension is taken, gonna do laterals first" and the coach routes accordingly, `activePlannedSession.index` is not advanced by the conversational reorder — only the "Next exercise →" button does so. On subsequent messages in the same session, `checkAndSuggestSubstitute` sends the wrong `current_exercise` to the substitute endpoint because the cursor still points at the skipped/taken exercise. The session-state model from Steps 372–373 is authoritative, but the index cursor lags behind it.

**Scope:** `public/coach-conversation.js` and `public/app.js` (coach-routing branch only — no write-path or preview-panel change). After a coach reorder is acknowledged, clear or re-point `activeExercise` so subsequent substitution/current-exercise checks use the correct planned slot. No write-path, no schema, no LLM change.

**Acceptance criteria:**
- A conversational reorder ("X is taken, doing Y first") advances or re-points the authoritative session cursor.
- Subsequent `checkAndSuggestSubstitute` calls send the correct `current_exercise`.
- The "what's next / what's left" coach answer still reads from the authoritative state (Step 373/375), not the stale cursor.
- No write-path or schema change is present.

**Expected tests:** integration or unit tests proving that after a simulated reorder message, the session index points at the correct next exercise and the substitute-check sends the right exercise name.

**Out-of-scope:** parser changes, schema changes, write-path changes.

> **Note on `public/app.js`:** This file contains the preview→approve→write trust loop and is a restricted file per `CLAUDE.md`. The fix touches the coach-routing branch only. It must be named in scope before editing begins.

---

### Hold point — App-test: reorder, "what's left," and substitution

After Steps 378–379 are merged, pause for owner review and optional app-test before deload work begins.

**Focus test:** active session reorder ("X is taken, doing Y first"), "what's next / what's left" response accuracy after a reorder, and substitution/current-exercise behavior on subsequent messages.

---

### Roadmap Step 380 — Deload prescription consolidation (#291)

**Status:** pending

**Type:** Correctness (recommendation logic) — BUMPED priority; on the Coach's Pick surface

**Exact failure prevented:** Two prescription paths currently coexist — `computePrescription` (the canonical engine) and the older volume-first `suggestDeloads` path. The Coach's Pick surface and next-set card may route through different models and can show contradictory prescriptions. Both surfaces must derive from a single canonical source.

**Scope:** Service-layer consolidation. Point both the next-set card and Coach's Pick/insights overview at `computePrescription` as the single prescription source. Retire or bypass the `suggestDeloads` volume-first path where it conflicts. Pure service-layer refactor — no write-path, no schema, no LLM change.

**Acceptance criteria:**
- Both the next-set card and Coach's Pick surfaces read from `computePrescription` only.
- `suggestDeloads` is either retired or explicitly subordinated so it cannot produce a contradictory recommendation on any live surface.
- Tests prove both surfaces agree (same prescription model, same output shape) when given identical inputs.
- All five `DELOAD_SPEC.md` behaviors remain pinned in golden fixtures.
- No write-path or schema change is present.

**Expected tests:** golden fixtures in the deload/prescription test suite covering all five spec behaviors; an integration test proving Coach's Pick and next-set card return consistent prescriptions from the same model.

**Out-of-scope:** frontend lifecycle wiring (→ Step 382), trigger-logic changes (→ Step 381), LLM prompt changes, schema changes.

### Roadmap Step 381 — Deload trigger nuance: no accessory/deprioritized false positives

**Status:** pending

**Type:** Correctness (recommendation logic)

**Exact failure prevented:** Confirmed live failures: Dumbbell Curl was flagged as stalled while its e1RM was actively progressing (40→53 lb); Shrugs was flagged despite being barely trained as a direct lift. The trigger evaluates all flat lifts equally regardless of their role in the program. A deload recommendation triggered by a secondary or accessory lift when primary compounds are progressing normally is worse than no recommendation — it erodes trust in every subsequent deload signal.

**Scope:** Isolated change to the deload-trigger evaluation logic. The trigger should weigh primary-lift evidence; accessories and deprioritized lifts should be downgraded or excluded as trigger sources when primary-compound signals do not corroborate. No change to what a deload prescribes, only when the trigger fires. No write-path, no schema, no LLM change.

**Acceptance criteria:**
- Dumbbell Curl with a progressing e1RM (40→53 lb) does not trigger a deload.
- Shrugs alone does not trigger a deload when compound lifts are progressing normally.
- Main compound lifts that are genuinely stalling continue to trigger correctly.
- Golden fixtures pin all five `DELOAD_SPEC.md` behaviors and the live false-positive examples.
- No write-path or schema change is present.

**Expected tests:** golden-fixture tests in the deload trigger suite covering the Dumbbell Curl progressing case, the Shrugs case, and at least two genuine-stall cases where the trigger must fire.

**Out-of-scope:** prescription model changes (→ Step 380), frontend lifecycle wiring (→ Step 382), LLM prompt changes, schema changes.

---

### Hold point — App-test: deload trigger + prescription

After Steps 380–381 are merged, pause for owner review and app-test before frontend lifecycle wiring (Step 382).

**Focus test:** Coach's Pick deload recommendation, next-set card deload prescription, deload trigger accuracy on accessory vs. primary lifts, and consistency between both prescription surfaces.

---

### Roadmap Step 382 — Frontend deload lifecycle wiring (#289)

**Status:** pending

**Type:** Correctness (write-path-adjacent) — HIGH RISK; explicit scope required before editing

**Exact failure prevented:** The deload state machine (`services/deloadState.js`, `Deload_State` tab) is fully built server-side but the client never calls `/api/deload/begin|advance|resolve`. Saving a workout does not advance the machine. `deload_sessions_remaining` never decrements, `deload_exit_criteria` is never evaluated, and the system accumulates no real state transitions — it is effectively dark.

**Scope:** Frontend lifecycle wiring only. Wire the `begin`, `advance`, and `resolve` calls in `public/app.js` at the correct approved lifecycle moments (begin on deload start, advance on session save, resolve on exit criteria met). No new schema columns. No `Log_Cleaned` or workout-row involvement. `Deload_State` tab writes only, per the existing 7-column append-only schema. No LLM change.

**Acceptance criteria:**
- `begin` is called only when a deload is explicitly started (not on every save).
- `advance` is called only on a successful session write, not on dry-run/test_mode.
- `resolve` is called only when exit criteria are met, not preemptively.
- None of the lifecycle calls alter `Log_Cleaned`, workout rows, or the preview→approve→write trust loop.
- Tests prove `begin`/`advance`/`resolve` calls happen only at the correct lifecycle moments and that `test_mode: true` dry-runs do not trigger them.
- `sheet_write`, `sheet_written`, `log_rows_written`, and `no_write_confirmed` proof fields are unaffected.

**Expected tests:** integration tests in `test/api-smoke.test.js` proving the lifecycle boundary conditions (dry-run does not call advance; approve calls advance exactly once per save; `Log_Cleaned` row count is unchanged by lifecycle calls).

> **`public/app.js` restriction:** This file contains the preview→approve→write trust loop and is a restricted file per `CLAUDE.md`. It must be named in scope before editing begins. The deload lifecycle calls are system-state writes to `Deload_State` only — they are NOT logged sets and do NOT route through the preview trust loop.

**Out-of-scope:** prescription model changes (→ Step 380), trigger-logic changes (→ Step 381), schema migrations, LLM prompt changes.

---

## Origin

Steps 372–377 were sequenced from the June 2026 app-test failures (six findings, priority-ordered). Steps 378–382 follow from BACKLOG.md near-term items and residual deferred findings from the 372–377 series. Owner granted full implement-and-merge authority for the series. Each PR stays tiny and one-concern; deferred discoveries go to `BACKLOG.md` in the same PR.

## New chat / agent instruction

Read this file before changing roadmap direction. Execute the next step only. Stop for owner review after every PR. Do not merge.
