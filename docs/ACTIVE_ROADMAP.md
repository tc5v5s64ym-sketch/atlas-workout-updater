# Atlas Active Roadmap

> **Governance layer:** Roadmap — see [`docs/GOVERNANCE.md`](GOVERNANCE.md) for the full hierarchy.

This is the current execution queue after the June 2026 app test findings.

`BACKLOG.md` remains the single source of truth for open and deferred work. This file is the detailed active queue. When these two files disagree, stop and ask the owner before changing direction.

Use `docs/DOCS_INDEX.md` to understand which older docs are active reference, historical context, or archived plans.

## Roadmap Step numbers vs GitHub PR numbers

These are separate things. A Roadmap Step is a logical build unit defined here. A GitHub PR is a pull request opened on GitHub, which gets its own number from GitHub's sequence. They will often differ.

Use terminology like:

- **Roadmap Step 361** — the logical unit of work defined in this file
- **GitHub PR #366** — the actual pull request on GitHub

Do not assume they match. BACKLOG.md records both where they diverge (e.g. "Roadmap Step 364 / GitHub PR #366").

## Why priority changed

The performance intelligence layer has mostly been built, but app testing exposed session-execution trust failures:

- impossible lateral raise loading
- poor exercise ordering
- missing confirmation cards
- plan drift during active workouts
- reorder vs substitute confusion
- no clean session closeout

The test changed priority, not direction.

Build order:

1. Fix session execution and trust failures.
2. Wire existing intelligence into the live coach path.
3. Use intelligence for suggested workouts.
4. Polish coach voice last.

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
| 372 | Substitution updates session state (`applySubstitution`) | ✅ complete |
| 373 | Coach reads the authoritative live session | ✅ complete |

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

## Active queue — Session-state trust repair (Steps 372–377)

This series fixes the session-execution trust failures surfaced by the June 2026 app test (planned vs. completed drift during a live workout). The root cause is that the app has **no single authoritative session state**: `activePlannedSession` (the banner plan + cursor), `sessionCompleted` (logged names), and the coach's `current_plan` (re-fetched fresh from `/api/plan/intent-recommendation` each message) drift apart. Substitutions update none of them.

Build order is deterministic-engine-first, then live wiring, then coach narration — one concern per PR, stop after each.

### Roadmap Step 372 — Substitution updates authoritative session state (engine)

**Status:** ✅ complete (GitHub PR #388)  
**Type:** Trust-critical

**Exact failure prevented:** User says "Lat bar is taken so I'll do seated rows instead"; Atlas acknowledges the swap but keeps Lat Pulldown on the remaining list. The planned session state must mark Lat Pulldown as substituted and Seated Row as the active slot once accepted, and complete it once logged.

**Scope:** Pure deterministic engine only — `services/sessionPlanExecutor.js`. No frontend, no write-path, no schema, no LLM. Adds `applySubstitution(planned, prescribed, substitute)` returning the updated planned list (prescribed slot replaced in place, order preserved, substitute liftCode carried so a later differently-named log still matches in `computePlanState`).

**Acceptance criteria:**
- `applySubstitution` replaces the prescribed slot with the substitute, preserving order.
- After substitution, `computePlanState` shows the prescribed lift gone from `remaining` and the substitute present until logged.
- Logging the substitute completes the slot and never resurfaces the swapped-out lift.
- Substitute liftCode rides along so a log under a different canonical name closes the slot.
- No-op when prescribed is absent / blank / identical to substitute. Inputs never mutated.

**Expected tests:** golden fixtures in `test/sessionPlanExecutor.test.js` proving each criterion (the Lat Pulldown → Seated Row scenario explicitly).

**Out-of-scope (→ Step 373):** wiring `applySubstitution` into `public/app.js` `activePlannedSession` and the `coach-conversation.js` swap-acknowledgment path; parsing "X is taken, I'll do Y" into (prescribed, substitute).

### Roadmap Step 373 — Coach reads the authoritative live session

**Status:** ✅ complete (GitHub PR #389)  
**Type:** Trust-critical (touches `public/app.js` — trust-loop file, named scope)

**Exact failure prevented:** The coach's `current_plan` was a fresh re-fetch from `/api/plan/intent-recommendation`, independent of the live session — so completed lifts showed as still remaining (name drift) and the coach narrated a different plan than the banner. Remaining/completed must derive from ONE authoritative session state.

**Scope (this PR):** `currentPlanForChat` derives `current_plan` from the live `activePlannedSession` (its exercises + cursor) when a session is active, keyed `canonicalName || name` to match `resolveCompletedIdentity`/`sessionCompleted` so the server's `computePlanState` reconciles completed↔remaining. Falls back to the cached recommendation only when no session is active. No write-path, no schema, no LLM.

**Out-of-scope:** applying an accepted substitution INTO `activePlannedSession` (→ Step 373b); parser changes (Step 374); history intelligence (Step 376).

### Roadmap Step 373b — Apply an accepted substitution into the live session

**Status:** in progress (this PR)  
**Type:** Trust-critical (touches `public/app.js` — trust-loop file, named scope)

**Exact failure prevented:** When the lifter swaps (logs Seated Row in place of planned Lat Pulldown), `activePlannedSession` still lists Lat Pulldown, so the now-authoritative coach view (Step 373) still shows it remaining. The accepted substitute must replace the prescribed slot in the live session.

**Scope (this PR):** an explicit swap declaration ("X is taken, I'll do Y") records the prescribed step in `pendingSubstitution`; the next logged exercise is applied as the substitute via `applySessionSubstitution` (inline keep-in-sync mirror of Step 372's `applySubstitution`) before completed-identity resolution, so the swapped-out lift leaves remaining and the substitute is marked done. Gated on the explicit declaration so it never misfires on ordinary added work; cleared on cursor advance and session end.

**Deferred (→ later):** swaps NOT preceded by a recognized constraint message (e.g. exercise outside the substitute catalog), and multi-exercise batch swaps — these don't set `pendingSubstitution` yet. Tracked in `BACKLOG.md`.

**Out-of-scope:** parser changes (Step 374), history intelligence (Step 376).

### Roadmap Step 374 — Planned exercise names are always loggable

**Status:** ✅ complete (GitHub PR #392)  
**Type:** Correctness

**Exact failure prevented:** Atlas suggested "Single-Leg Leg Curl" but later rejected that exact wording with "Didn't catch that lift." Any name Atlas prescribes in a plan must be recognizable when logged later (alias registration / canonicalization round-trip).

**Scope:** Added six new canonical entries to `EXERCISE_ALIASES` in `services/workoutTextParser.js`: Single-Leg Leg Curl, Leg Extension, Pull-Up, Chin-Up, Hip Thrust. Each entry lists the canonical name the plan uses as the alias key so the parser returns that exact name — ensuring `computePlanState` name-matches correctly. "Single-Leg Leg Curl" is placed before "Leg Curl" so its longer alias wins in the sorted match. Nine golden regression tests in `test/parser-golden.test.js` lock the round-trip and guard against "Leg Curl" absorbing the single-leg variant again.

### Roadmap Step 375 — Coach "what's left" reads authoritative state

**Status:** ✅ complete (GitHub PR #394)  
**Type:** Trust-critical

**Exact failure prevented:** After completed lifts, Atlas told the user everything (Deadlift, Leg Extension, Leg Curl, Lat Pulldown, Bench, Dips) was still remaining. Coach answers about "what's left" must read the authoritative completed/remaining state from Step 373, not separate memory.

**Root cause (two gaps):** (1) `routeMessageToCoach` (`public/app.js`) only sent `plan_completed` when `sessionCompleted.length > 0`, so before the first logged set the server's gate left `plan_state` null and the coach answered "what's left?" from `current_plan` (the whole session). (2) `buildChatSystemPrompt` (`services/coach.js`) had no rule telling the model to answer "what's left?" from `plan_state.remaining` rather than `current_plan` or prior chat turns.

**Scope:** `public/app.js` — send `plan_completed` (even `[]`) whenever `activePlannedSession` is active, so the server always computes an authoritative `plan_state`. `services/coach.js` — add a WHAT'S-LEFT RULE to the chat system prompt: answer remaining/next/done questions ONLY from `plan_state.remaining`/`isComplete`; never derive remaining work from `current_plan` or conversation turns; say there's no authoritative state when `plan_state` is absent. No write-path, schema, or trust-loop (preview→approve→write) change. Tests: 3 integration tests in `test/api-smoke.test.js` (empty/partial `plan_completed` drives `plan_state`; absent `plan_completed` keeps the stale-data guard) + 1 prompt-rule test in `test/coach.test.js`.

### Roadmap Step 376 — Suppress cross-lift history contamination

**Status:** ✅ complete (GitHub PR #399)  
**Type:** Trust-critical

**Exact failure prevented:** Leg Extension commentary claimed today's 60 was below a recent working range of 105–170 — numbers from an unrelated lift. Almost certainly the pre-override `liftCode` history-merge gap (BACKLOG SESSION_DESIGN AC5a). If same-lift evidence is not clean, suppress the claim rather than cite foreign history.

**Root cause:** `enrichCoachFacts` (`services/liveIntelligence.js`) pools history by `liftCode` alone — every analytics call (`computeBenchmark`, `resolveWorkingWeight`, `detectTrend`, `computeExpectedPerformance`) keeps rows where column 5 matches. When two genuinely different exercises share a `liftCode` (a generated-code collision from the pre-override era, or a catalog data-entry slip), their rows merge and the coach can cite a foreign lift's working range. `facts.exerciseName` was already forwarded by the frontend but never used to scope the history.

**Scope:** `services/liveIntelligence.js` only — added `cleanLogForLift(allLog, liftCode, exerciseName)`, called once before the analytics run. It intervenes **only when contamination is visible**: rows carrying the target `liftCode` disagree on `canonical_exercise`. Then it keeps only rows whose exercise matches today's lift (normalized name, or canonical `liftCode` via `canonicalLiftCodeFor` for known variants like "Lateral Raise"/"Lateral Raises"); if the target's own rows can't be confidently identified, all same-`liftCode` rows are dropped so the analytics degrade to null and the coach suppresses the claim. When the same-`liftCode` rows agree on one canonical name (the normal case), `allLog` is returned unchanged — a no-op except under real contamination. No write-path, schema, parser, or LLM change.

**Tests:** 4 golden-fixture tests in `test/liveIntelligence.test.js` — foreign-range leak blocked (benchmark reflects 60, not 150–170); unidentifiable-target suppression (benchmark null); clean single-exercise history unchanged when `exerciseName` is supplied (no over-filtering regression); name variants sharing a canonical `liftCode` survive contamination.

**Deferred (BACKLOG):** the inverse split — same exercise under *different* liftCodes (pre-override generated code missing from merged history, SESSION_DESIGN AC5a) — is a separate read-time normalization and remains deferred; this PR addresses contamination (foreign history leaking in), not the merge gap (own history missing).

### Roadmap Step 377 — Deterministic fallback for session-close questions

**Status:** ✅ complete (GitHub PR #TBD)  
**Type:** Correctness

**Exact failure prevented:** "Ok so we are done?" returned coach-unavailable instead of resolving session status.

**Root cause (three gaps, no malformed payload):** `/api/coach/chat` returns `message:null` both when Gemini is unconfigured (`index.js`, the early return) and when it errors/times out (the catch block) — and the client's `chatFallback` (`public/coach-conversation.js`) has no branch for session-close questions, so "Ok so we are done?" (no greeting, no digits) fell through to the generic "Coach is unavailable right now." The authoritative `plan_state` rides in on the client context (Step 375) but neither LLM-down path consulted it.

**Scope:** `services/sessionPlanExecutor.js` + `index.js` (read-only `/api/coach/chat` route only — no write path). Added three pure engine functions: `detectSessionCloseQuestion(message)` (recognizes "are we done?", "that's it?", "all finished?", etc. — tight, never fires on planning/logging asks), `buildSessionCloseAnswer(message, planState)` (confirms a complete plan and points at the save step, or names the outstanding lifts — engine owns the count/names, never writes, never triggers the save), and `planStateFromContext(context)` (the SINGLE plan_state gate now shared by `buildChatContext` and both fallback paths, so all three decide "is there authoritative session state?" identically). Both LLM-down paths in the chat route now answer session-close questions from the engine (`source:'engine'`) and fall back to `message:null` otherwise. No schema, no parser, no LLM, no trust-loop (`public/app.js`) change.

**Tests:** 11 engine unit tests in `test/sessionPlanExecutor.test.js` (gate, detector positive/negative, complete/remaining/singular grammar, null guards) + 6 integration tests in `test/api-smoke.test.js` (unconfigured close→engine answer; complete→done+save; no plan_completed→null; non-close→null; throw mid-session→engine answer; read-only/no append).

**Deferred (BACKLOG):** the pure client-side timeout edge (client `COACH_LLM_TIMEOUT_MS` 9s firing before the server responds) — the server's deterministic answer wins in the normal LLM-outage case (server Gemini timeout 8s < client 9s), so a client-only mirror of `computePlanState` (a keep-in-sync anti-pattern) is intentionally NOT added here.

---

## Origin

Steps 372–377 were sequenced from the June 2026 app-test failures (six findings, priority-ordered). Owner granted full implement-and-merge authority for the series. Each PR stays tiny and one-concern; deferred discoveries go to `BACKLOG.md` in the same PR.

## New chat / agent instruction

Read this file before changing roadmap direction. Execute the next step only. Stop for owner review after every PR. Do not merge.
