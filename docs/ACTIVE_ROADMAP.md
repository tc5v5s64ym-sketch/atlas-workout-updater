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

Deferred items from each completed step are recorded in `BACKLOG.md`.

---

## Active queue

### Roadmap Step 371 — Coach Voice Polish

**Status:** NEXT — ready to implement  
**Type:** Polish  
**Trust-critical:** No  
**GitHub PR:** TBD (will be assigned when opened; will differ from Roadmap Step 371)

**What this fixes:** Steps 362–370 wired intelligence into the live coach path. The coaching voice wording has not been updated to reflect these facts. Coach may word deviation, trend, confidence_factors, and reason_codes awkwardly, repeat itself, or use phrasing patterns written before those signals existed.

**Exact failure prevented:** Wording that ignores or contradicts live engine signals (e.g. says "hard to say" when `trend` is present, or celebrates a set the deviation signal flagged as fell_short).

**Scope:** Presentation-only. No new engine logic. No new workout decisions. No write-path changes. No new endpoints.

**Acceptance criteria:**
- Coach voice wording updated to reference available facts: `deviation`, `trend`, `confidence_factors`, `reason_codes`.
- Wording passes tonal review against `docs/COACH_VOICE_VALIDATION.md`.
- No new engine signals added in this step.
- No changes to scoring, recommendation, or write paths.
- No changes to `index.js` log/write path or `services/workoutTextParser.js`.

**Expected tests:**
- Existing `test/coachPromptRules.test.js` must pass without modification.
- If system prompt changes: update prompt-rule tests to cover new rules. Do not delete existing rules.
- No golden-fixture regressions in `test/liveIntelligence.test.js`, `test/analytics-edge.test.js`, or `test/sessionPlanExecutor.test.js`.

**Explicit out-of-scope:**
- New engine signals or scoring changes.
- New coach chat endpoints.
- Substitution-quality voice (blocked on `scoreSubstitutionQuality` fix — see BACKLOG.md).
- Verbosity/chattiness dial (needs design — see Settings epic in BACKLOG.md).
- Load sanity, deload, or write-path changes.
- Any feature from the "What not to build" list in `CLAUDE.md`.

**Hold points:** None before this step — intelligence wiring confirmed complete (Steps 362–370 ✅). Owner app-tests coach wording after this step before the next phase begins.

---

## After Step 371

The next phase is not yet sequenced. Owner + ChatGPT review BACKLOG.md after Step 371 ships and the owner app-tests.

Candidates visible in BACKLOG.md (not yet approved for sequencing):

- Deload prescription consolidation (#291) — BUMPED to high priority
- Frontend deload lifecycle wiring (#289)
- AC8 — phantom-set suppression (credibility floor)
- Coaching Depth / Verbosity setting (needs design)
- Conversational input robustness (behavior-changing — Opus 4.8 when time to build)

## New chat / agent instruction

Read this file before changing roadmap direction. Execute the next step only. Stop for owner review after every PR. Do not merge.
