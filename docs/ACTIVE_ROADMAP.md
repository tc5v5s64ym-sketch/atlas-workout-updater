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

## Active queue - Roadmap refill (Steps 383-387)

This sequence is intentionally small. It refills the active roadmap from `BACKLOG.md` and recent app-test findings after the session-state trust-repair series.

Build order:

1. Restore prescription trust where a lift's historical identity can be split across old and canonical lift codes.
2. Consolidate deload logic before changing deload behavior.
3. Correct deload triggers on the most visible coach surface.
4. Point visible deload prescriptions at one source of truth.
5. Wire deload lifecycle only after trigger and prescription trust are repaired.

### Roadmap Step 383 - Lift-code history merge for prescribed load sanity

**Status:** pending

**Recommended model:** Sonnet 4.6 if verification confirms no canonical-code regression; Opus 4.8 if the fix touches recommendation behavior beyond normalization.

**Risk level:** Medium.

**Failure or opportunity addressed:** Old rows written before `knownLiftCodeOverrides` can carry generated lift codes that differ from the current canonical code. That splits one lift's history, causing Atlas to miss the owner's real working weights and weakening the prescribed-load sanity guard. This is the remaining `SESSION_DESIGN AC5a` gap after the per-lift ceiling guard shipped.

**Why it belongs now:** Load trust is upstream of every coaching and recommendation surface. A bad or history-blind prescribed weight poisons the coach's next explanation even when the voice layer behaves correctly.

**Vision / Dream fit:** Atlas earns the next step from real history. Merging split lift identity helps the engine understand what the owner actually did instead of treating old and new names as separate athletes.

**Constitution / trust guardrails:** Engine owns numbers; AI only words facts. No parser change. No write-path or Sheet schema change. Tests must prove old rows normalize to the canonical lift code without contaminating distinct exercises.

**Scope:** Isolated normalization/read-path fix, likely `services/exerciseEnrichment.js` plus focused tests. No UI, no write path, no LLM prompt.

**Acceptance criteria:**
- Old rows for a lift with a canonical override resolve to the canonical `lift_code`.
- Distinct exercises do not merge accidentally.
- Existing load-sanity fixtures still pass, including the lateral raise guard.
- No write-path or schema change is present.

---

### Roadmap Step 384 - Deload policy housing

**Status:** pending

**Recommended model:** Sonnet 4.6.

**Risk level:** Low-medium.

**Failure or opportunity addressed:** Deload decision code is scattered across `analytics.js` and `coach.js`; `services/deloadPolicy.js` does not exist. That makes the next deload changes harder to reason about and easier to regress.

**Why it belongs now:** Extracting the policy before changing trigger behavior keeps the deload series reviewable. It separates the "where does this logic live?" problem from "what should the trigger decide?"

**Vision / Dream fit:** Atlas's coaching should be explainable and consistent. A single deterministic policy module is a better foundation for a training-intelligence engine than scattered heuristics.

**Constitution / trust guardrails:** Behavior-preserving extraction only. Golden fixtures must pin the current `DELOAD_SPEC.md` behaviors. No LLM decision-making, no write path, no Sheet schema change.

**Scope:** Pure service-layer refactor and tests. Do not alter visible deload behavior in this step.

**Acceptance criteria:**
- Deload policy logic lives in one focused module.
- Existing behavior is unchanged under golden fixtures.
- Callers route through the new module.
- No write-path, schema, UI, or prompt change is present.

---

### Roadmap Step 385 - Deload trigger nuance: no accessory/deprioritized false positives

**Status:** pending

**Recommended model:** Opus 4.8.

**Risk level:** Medium.

**Failure or opportunity addressed:** Live app testing showed deloads triggered from Dumbbell Curl while e1RM was progressing 40 -> 53 lb, and from Shrugs even though the owner barely trains them directly. The trigger currently treats every flat lift as equally meaningful.

**Why it belongs now:** Coach's Pick is the surface the owner starts from. False deloads on low-priority accessories erode trust faster than missing a marginal deload.

**Vision / Dream fit:** Atlas should understand what actually matters in training, not just collect flat signals. The engine should distinguish primary training evidence from accessory noise.

**Constitution / trust guardrails:** Deterministic trigger logic only. Coach voice may word the engine result but must not invent the reason. No write path, no schema change, no LLM prompt change.

**Scope:** Isolated deload-trigger evaluation change after Step 384. No prescription-surface consolidation and no lifecycle wiring in this step.

**Acceptance criteria:**
- Progressing Dumbbell Curl does not trigger a deload.
- Shrugs alone do not trigger a deload when primary compounds are progressing normally.
- Genuine primary-lift stalls still trigger correctly.
- Tests cover the two live false-positive examples and at least two true-positive stall cases.

---

### Roadmap Step 386 - Deload prescription consolidation (#291)

**Status:** pending

**Recommended model:** Opus 4.8.

**Risk level:** Medium.

**Failure or opportunity addressed:** `computePrescription` and the older volume-first `suggestDeloads` path can produce competing deload advice. Coach's Pick and the next-set card must not disagree about the same training state.

**Why it belongs now:** After the trigger is trustworthy, visible prescription surfaces need one canonical source before the frontend starts advancing deload state.

**Vision / Dream fit:** The finished Atlas coach should feel calm and coherent. One engine verdict with readable evidence supports the dream of a reusable training-intelligence layer.

**Constitution / trust guardrails:** Anchor on deterministic `computePrescription`; do not let AI choose numbers. No write path, no Sheet schema change. Tests must prove both surfaces agree.

**Scope:** Service/surface consolidation. Retire or subordinate `suggestDeloads` where it can conflict. No lifecycle wiring.

**Acceptance criteria:**
- Coach's Pick and next-set deload card derive from the same prescription source.
- Contradictory deload prescriptions cannot appear on live surfaces.
- `DELOAD_SPEC.md` behavior fixtures remain pinned.
- No write-path or schema change is present.

---

### Hold point - App-test: deload trigger + prescription

After Steps 384-386 are merged, pause for owner review and app-test before frontend lifecycle wiring.

**Focus test:** Coach's Pick deload recommendation, next-set deload prescription, accessory-vs-primary trigger accuracy, and consistency between visible prescription surfaces.

---

### Roadmap Step 387 - Frontend deload lifecycle wiring (#289)

**Status:** pending

**Recommended model:** Opus 4.8.

**Risk level:** High.

**Failure or opportunity addressed:** The deload state machine exists server-side, but the client never calls `/api/deload/begin|advance|resolve`. Saving a workout does not advance the machine, so `deload_sessions_remaining` and exit criteria remain dark.

**Why it belongs now:** Lifecycle writes should happen only after the deload trigger and prescription are trustworthy. Wiring state transitions before that would persist questionable decisions.

**Vision / Dream fit:** Atlas should remember recovery state across sessions, not just display a one-off recommendation. This deepens the engine while preserving the approve-before-save trust loop for workout data.

**Constitution / trust guardrails:** This is write-path-adjacent and requires explicit scope before editing `public/app.js`. Deload lifecycle calls write only to append-only `Deload_State`; they must never alter `Log_Cleaned`, `Effort`, workout rows, or dry-run proof fields. No Sheet schema change.

**Scope:** Frontend lifecycle wiring only. Begin on explicit deload start, advance only after successful session write, resolve only when exit criteria are met.

**Acceptance criteria:**
- `begin` is called only when a deload is explicitly started.
- `advance` is called only after a successful live session write, never during `test_mode=true`.
- `resolve` is called only when exit criteria are met.
- Preview->approve->write proof fields remain unchanged.
- Tests prove lifecycle calls do not touch `Log_Cleaned` or `Effort`.

---

## Future / backlog items - not active execution

Do not start these from this roadmap refill unless the owner explicitly promotes them:

- Reorder session index bugfix from the prior active queue.
- Coach / Deep Coach verbosity tiers.
- Conversational input robustness and elasticity.
- Settings / user-preferences panel.
- Preference learning from edits.
- Substitution-history and missed-lift memory expansion beyond shipped state.
- Suggested workout engine expansion and new routes.
- Friendly errors / contradictory panel polish.
- Pending-exercise queue persistence decision.
- Nutrition, bodyweight expansion, signature programs, auth/productization, multi-user, and platform/API work.

---

## Origin

Steps 372–377 were sequenced from the June 2026 app-test failures (six findings, priority-ordered). Steps 383–387 refill the active roadmap from `BACKLOG.md`, the product Vision/Dream, and the remaining trust-sensitive app-test findings. Each implementation PR stays tiny and one-concern; deferred discoveries go to `BACKLOG.md` in the same PR.

## New chat / agent instruction

Read this file before changing roadmap direction. Execute the next step only. Stop for owner review after every PR. Do not merge.
