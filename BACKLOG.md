# Atlas — Backlog

**Single source of truth for open and deferred work.** Priority-ordered. One line per item with a link to its issue/PR where one exists.

Seeded from the open GitHub issues, the not-yet-done items in [`FIX_PLAN.md`](./FIX_PLAN.md), and owner decisions. See the "Backlog discipline" section in [`CLAUDE.md`](./CLAUDE.md) for how to keep this current.

---

## Near-term

- **[#291](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/291) — Deload prescription consolidation (one model).** **BUMPED** — it's on the Coach's Pick surface the user starts from, not a secondary screen. Anchor on `computePrescription` as the single prescription source; point **both** the next-set card **and** the Coach's Pick / insights overview at it; retire the volume-first `suggestDeloads` path.
- **NEW — Deload trigger nuance: don't trigger a deload off accessory or deprioritized lifts.** Live example: it flagged Dumbbell Curl as stalled while its e1RM was progressing 40 → 53, and flagged Shrugs, which the user barely trains directly. The trigger should weigh what actually counts, not flag every flat lift.
- **[#289](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/289) — Frontend deload lifecycle wiring.** State machine is built but dark — the client never calls `/api/deload/begin|advance|resolve`, so saving a workout doesn't advance the machine.

## Then

- **Phase 2 hardening (from [`FIX_PLAN.md`](./FIX_PLAN.md)):** service-worker cache bug (HI-5), CSP / inline styles (HI-2), parser set-count cap (HI-3), friendly errors + no contradictory panels (ME-1/2/3), weekly-report row shape (ME-8).
- **Triage the older open issues:** lift-code fallback collision (`generateLiftCode` in `services/exerciseEnrichment.js` — no collision check/increment), and the flaky e2e ([#262](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/262)).

## Future epic

- **Coach intelligence build (COACH_PLAN.md).** Phased build: muscle-coverage data → coverage-aware stalls → proactive suggestions → goal- & coverage-aware workout selection.
  - ✅ **PR 1.1** — `services/muscleCoverage.js`: `musclesFor` / `liftsForMuscle`, 17-muscle taxonomy, pattern-based, pure data (31 tests).
  - ✅ **PR 1.2** — `services/muscleVolume.js`: `weeklyMuscleVolume`, rolling-window volume per muscle, direct 1.0 + indirect 0.5 credit (16 tests).
  - ✅ **PR 1.3** — `services/movementPattern.js`: `patternFor`; 14-pattern vocabulary (squat/hinge/push/pull/isolation/trunk/carry/other); pattern-based, pure data (20 tests).
  - ✅ **Hold Point 1** — owner reviews coverage map + per-muscle volumes against real log before behavior changes. _(Sonnet → Opus 4.8 after hold)_
  - ✅ **PR 2.1** — Coverage-aware stall/deload: `coverageStalls.annotateStallsForDeload`; accessories downgraded when primary muscles covered by other lifts; `weeklyMuscleVolume` extended with `today`/`excludeLiftCode` options (929 tests).
  - ✅ **Hold Point 2** — live-app test confirmed: Face Pull correctly feeds deload (rear_delts 1.5 eff. sets < 2.0 threshold); OHP main stall feeds independently. Coverage logic verified correct.
  - ✅ **PR 3.1** — `services/underCoverage.js`: `computeUnderCoverage`; per-muscle status (`under`/`adequate`/`optimal`) + reason string vs. MEV-style target ranges (950 tests).
  - ✅ **PR 3.2** — Surface under-coverage in coaching chat: `muscle_gaps` (sorted by severity) wired into `buildChatContext` + `sanitizeChatContext`; LLM nudges 1–2 under-served muscles when asked what to train (952 tests).
  - ✅ **Hold Point 3** — gap nudges reviewed and approved in live conversations. Wording reads naturally; style confirmed.
  - ✅ **PR 3.3 — expectation verdict engine** — `computeExpectationVerdict` in `analytics.js`; emits `{ outcome, why, prescribedRir, actualRir, rirDelta }` per set; outcome ∈ beat/met/fell_short/swap; rirDelta sign convention: negative = pushed harder; golden fixtures for all 4 outcomes (29 tests). Pure data, nothing surfaces it yet.
  - **PR 3.4 — coach voice reaction** _(open, awaiting output approval)_ — `buildVerdictReactionSystemPrompt`, `sanitizeVerdictFacts`, `isVerdictWorthReacting`, `generateVerdictReaction` in `coach.js`; gated (met → quiet, beat/fell_short/swap → react); 26 tests. **Merge gate: owner must approve 2–3 live example outputs** (see PR description).
  - ✅ **PR 3.5 — swap detection + working-weight finder** — `detectSwap` (case-insensitive name comparison, null-safe) + `buildWorkingWeightProtocol` (calibration protocol; 70% reference anchor → nearest 5 lb startHint; "Start conservative" when no reference); feeds `computeExpectationVerdict` swapped flag; pure data (36 tests).
  - ✅ **PR 3.x — systemic-cost tier** — `services/liftCost.js`: `costFor`; HIGH/MEDIUM/LOW by name pattern; pure data (16 tests).
  - ✅ **PR 3.x — balance signal** — `services/balanceSignal.js`: `computeBalanceSignal`; antagonist volume-ratio engine for 4 pairs (horizontal push:pull, vertical push:pull, anterior:posterior, quad:hamstring) → `{ pair, aSets, bSets, ratio, status, reason }`; wide bands; pure data (39 tests).
  - ✅ **PR 4.0** — `services/profileGoal.js`: `getProfileGoal()` reads `ATLAS_PROFILE_GOAL` env var, normalises through goal vocabulary (aliases included), returns null when absent; wired into `/api/recommendation/preview` as stored-goal fallback behind per-request `?profileGoal=` (23 tests).
  - ✅ **PR 4.1** — Goal- + coverage-aware ranking: `scoreIntents` enriched with `goal` option + under-coverage signal; GOAL_BONUS table for 8 goals; coverage-gap bonus for `fix_blind_spots` and hypertrophy `build_muscle`; `build_strength` includes lower/hinge when goal=strength + legs fresh; `/api/plan/intent-recommendation` wired to `getProfileGoal()`; `options.underCoverage` override for test isolation (15 tests).
  - ✅ **PR 4.2 — session builder** — `services/sessionBuilder.js`: `buildWarmupRamp` (50 %/70 %/85 % ramp, priming-flagged), `isBlockedPair` (fine-grained pattern + HIGH-cost guard; blocks Deadlift+RDL, allows Squat+Deadlift), `buildIntentSession` (anchor → support → balance; de-dup by name + code; isolation cap ≤1 per muscle; balance slot from full allRecs pool); wired into `fix_blind_spots`, `build_muscle`, `balanced` in `analytics.js`; AC1 fixed (focus/why_today filtered to scheduled patterns only); 47 tests.
  - **Open decision — RESOLVED:** Squat (`squat` pattern) + hinge (Deadlift/RDL) same day = **allow**. Two hinges (Deadlift + RDL) same session = **block** — both `hinge` pattern, too similar a stimulus. Rule for 4.2: block `hinge + hinge`; allow `squat + hinge`.
  - **Deferred — full pairwise blocking in `buildIntentSession`**: `isBlockedPair` currently guards anchor vs. each support lift. Two HIGH-cost same-pattern support lifts can coexist when the anchor is MEDIUM (e.g. Bench as anchor → Deadlift + RDL both pass). Edge case in practice (anchor loop usually picks HIGH first), but technically violates "at most one heavy hinge per session." Fix: after anchor selection, also check each new support candidate against all previously added HIGH-cost exercises.

- **Conversational input robustness / elasticity** — see [`CONVERSATION_DESIGN.md`](./CONVERSATION_DESIGN.md). Defines the composer interaction model: save-and-echo (evolves the user-facing approve-before-save step; real-write safeguards unchanged), conversational corrections, fluid log/ask switching. 7 acceptance scenarios (non-uniform sets, batch brain-dumps, log-vs-ask intent, floor deviations, load ambiguity, conversational undo, mid-session stats). Separate future thread — NOT part of the 4.x session builder. Behavior-changing → Opus 4.8 when it's time to build; scope and PR it separately.

## Housekeeping

- **Close obsolete PR [#288](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/288)** (superseded by [#290](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/290)). ✅ Already closed 2026-06-16.
- **Reconcile [`FIX_PLAN.md`](./FIX_PLAN.md)** — mark shipped items done (e.g. Phase 1: write-path integrity, deload spec + module, ME-7/HI-8 analytics correctness), or fold the remaining ones into this backlog.
