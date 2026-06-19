# Atlas Active Roadmap

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

**Status:** NEXT — ready to implement  
**Type:** Trust-critical  
**GitHub PR:** TBD (will differ from the Roadmap Step number)

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

### Roadmap Step 373 — One authoritative session state feeds the coach

**Status:** queued  
**Type:** Trust-critical (touches `public/app.js` + `public/coach-conversation.js` — trust-loop files, named scope)

**Exact failure prevented:** After logging substituted Rows, Atlas still thinks Lat Pulldown remains; the coach's `current_plan` is a fresh re-fetch independent of the live session. Remaining/completed must derive from ONE authoritative session state.

**Scope:** Wire Step 372's `applySubstitution` into `activePlannedSession`; make `currentPlanForChat` derive `current_plan`/remaining from the live session (with substitutions applied) instead of re-fetching the recommended intent. Keep-in-sync inline copy pattern where the browser can't `require()`.

**Out-of-scope:** parser changes (Step 374), history intelligence (Step 376).

### Roadmap Step 374 — Planned exercise names are always loggable

**Status:** queued  
**Type:** Correctness

**Exact failure prevented:** Atlas suggested "Single-Leg Leg Curl" but later rejected that exact wording with "Didn't catch that lift." Any name Atlas prescribes in a plan must be recognizable when logged later (alias registration / canonicalization round-trip).

### Roadmap Step 375 — Coach "what's left" reads authoritative state

**Status:** queued  
**Type:** Trust-critical

**Exact failure prevented:** After completed lifts, Atlas told the user everything (Deadlift, Leg Extension, Leg Curl, Lat Pulldown, Bench, Dips) was still remaining. Coach answers about "what's left" must read the authoritative completed/remaining state from Step 373, not separate memory.

### Roadmap Step 376 — Suppress cross-lift history contamination

**Status:** queued  
**Type:** Trust-critical

**Exact failure prevented:** Leg Extension commentary claimed today's 60 was below a recent working range of 105–170 — numbers from an unrelated lift. Almost certainly the pre-override `liftCode` history-merge gap (BACKLOG SESSION_DESIGN AC5a). If same-lift evidence is not clean, suppress the claim rather than cite foreign history.

### Roadmap Step 377 — Deterministic fallback for session-close questions

**Status:** queued  
**Type:** Correctness

**Exact failure prevented:** "Ok so we are done?" returned coach-unavailable instead of resolving session status. Investigate API/model failure vs malformed payload vs missing fallback; add a deterministic engine-computed session-status answer (from `computePlanState`) when the LLM is down.

---

## Origin

Steps 372–377 were sequenced from the June 2026 app-test failures (six findings, priority-ordered). Owner granted full implement-and-merge authority for the series. Each PR stays tiny and one-concern; deferred discoveries go to `BACKLOG.md` in the same PR.

## New chat / agent instruction

Read this file before changing roadmap direction. Execute the next step only. Stop for owner review after every PR. Do not merge.
