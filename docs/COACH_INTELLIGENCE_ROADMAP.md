# Atlas Coach Intelligence Layer — PR Roadmap

> **Source of truth:** `docs/research/coaching-intelligence/atlas-coach-intelligence-roadmap.pdf`
> This file is a live-status markdown mirror of that PDF. Update status here when a PR ships. The PDF is authoritative for scope; this file is authoritative for current progress.

**Prime directive:** The LLM is the voice, the code is the brain. The LLM never makes a progression or safety decision and never computes a number — that one line never moves.

**Safe ladder (how behavior is introduced):** Preserve → read-only math → prescription (preview) → decisions → thin LLM explanation → autoregulation → personalization, memory, confidence → advanced.

---

## Status key

- ✅ **shipped** — merged to main
- ⚠️ **partial** — some pieces exist; core "Done when" not fully met
- 🔲 **not started** — no code exists for this PR's concern

---

## Phase 0 — Knowledge Foundation

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 1 | Preserve + structure research (scaffold) | Sonnet | ✅ shipped | `docs/research/coaching-intelligence/` + `config/coaching/` trees created; 4 PDFs in source-archive |
| 2 | Expand exercise ontology (4 to ~50) | Sonnet | ✅ shipped | 52 exercises in `config/coaching/exercises/`; `_index.json` updated |

---

## Phase 1 — Read-only Foundations

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 3 | IntensityModule: e1RM + RPE/%1RM (read-only) | Opus | ✅ shipped | `services/intensityModule.js`; 32 tests |
| 4 | VolumeModule: weekly sets per muscle (read-only) | Opus | ✅ shipped | `services/volumeModule.js` + `services/volumeAssessmentModule.js`; landmarks in `config/coaching/volume/landmarks.json` |
| 5 | SafetyModule (classifier) + onboarding health screen | Opus | ✅ shipped | `services/safetyRulesModule.js` + `services/safetyClassifierModule.js`; PAR-Q onboarding screen in `config/coaching/safety/safety.rules.json`; [trust-critical] matcher gap filed in BACKLOG |
| 6 | Per-user State / Feature object (read-only substrate) | Opus | ✅ shipped | `services/userStateModule.js`; 43 tests. `buildUserState(logEntries, { asOf, windowDays, trendSessions })` → `{ liftStates, muscleVolume, adherence }`. |

---

## Phase 2 — Core Coaching Loop (MVP)

**Milestone at PR 10: a working beginner coach.**

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 7 | Starter program templates (state machines) | Opus | ✅ shipped | `config/coaching/programs/stronglifts-5x5.json` + `config/coaching/programs/gzclp.json` + `services/starterProgramModule.js`; 56 tests. `buildNextSession(programId, state)` → full session prescription (sets/reps/targetWeight/tier/progressionNote). |
| 8 | ProgressionModule (double progression + beginner LP) | Opus | ✅ shipped | `services/progressionRulesModule.js` + `services/progressionModule.js`; decision table tested |
| 9 | Cold-start onboarding flow | Opus | ⚠️ partial | `services/onboardingState.js` (PR-O1) + `services/onboardingSessionPlan.js` (PR-O2) shipped. Full questionnaire → template assignment flow not yet wired end-to-end. Depends on PR 5, PR 7, PR 8. |
| 10 | Thin LLM explanation layer (v1) | Opus | ⚠️ partial | `services/coach.js` + coach endpoints exist but were built independently of the Brian engine interface. A formal `getNextWorkout / getProgressionDecision / getVolumeStatus / checkSafety` function-calling interface exposing the Brian engine has not been wired. Depends on PR 5, PR 8. |

---

## Phase 3 — Recovery & Autoregulation

**Milestone at PR 15: an adaptive coach.**

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 11 | Readiness check-ins + ReadinessModule | Opus | ✅ shipped | `scoreReadiness()` in `services/fatigueAssessmentModule.js` covers sleep/soreness/stress/motivation/recent_load/hrv with weighted scoring and confidence tiers |
| 12 | FatigueModule (recovery clocks + acute:chronic load) | Opus | ✅ shipped | `assessRecovery()` in `services/fatigueAssessmentModule.js`; recovery windows per muscle category. ACWR (acute:chronic load ratio) not yet implemented — filed in BACKLOG. |
| 13 | DeloadModule | Opus | ✅ shipped | `checkDeloadTriggers()` in `services/fatigueAssessmentModule.js` (planned + autoregulated triggers); full deload state machine in `services/deloadStateMachine.js`, `deloadProtocols.js`, `deloadState.js`; frontend lifecycle wired (Roadmap Step 385) |
| 14 | ExpectedPerformance + PlateauModule | Opus | ✅ shipped | `services/expectedPerformanceModule.js`; 35 tests. `assessExpectedPerformance / detectLiftPlateaus / assessLift` — structured-entry adapter + plateau detection + composite with readiness adjustment. |
| 15 | Autoregulation upgrade to ProgressionModule | Opus | 🔲 not started | Set loads from current e1RM + readiness rather than fixed template; graduate-from-LP logic. Depends on PR 8, PR 11, PR 14. |

---

## Phase 4 — Personalization, Memory & Confidence

**Milestone at PR 19: a personalized coach.**

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 16 | SubstitutionModule | Opus | ⚠️ partial | `services/substitutionRecommender.js`, `substitutionQuality.js`, `substitutionIntent.js` exist and are wired. A formal Brian-layer `SubstitutionModule` with the equipment-aware filtering + referential-integrity check described in the roadmap has not been built as a standalone composite. Depends on PR 2, PR 4. |
| 17 | Goal / population templates & caps (+ 5/3/1) | Opus | 🔲 not started | Powerlifting / bodybuilding / general / weight-loss templates; older-adult / youth / busy-parent / home-gym caps; 5/3/1 for intermediates. Depends on PR 7, PR 8, PR 15. |
| 18 | Memory architecture (trends + coach memory + entity resolution) | Opus | ✅ shipped | `services/entityResolutionModule.js` (name→exerciseId; aliases + progressions; priority: exact>name>alias>progression) + `services/memoryModule.js` (Brian-layer composite: `queryTrend`, `queryPatterns`, `buildMemorySnapshot`, `resolveExercise`, `listExerciseIds`); 51 tests. Depends on PR 6, PR 14. |
| 19 | ConfidenceModule (ask vs act) | Opus | 🔲 not started | Score confidence (completeness / recency / consistency / self-report reliability); act / act-with-caveat / ask thresholds; LLM asks clarifying question when confidence is low. Safety inverts: low confidence about a red flag → MORE caution. Depends on most prior modules. |

---

## Phase 5 — Nutrition & Communication

**Milestone at PR 21: a complete core coach.**

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 20 | NutritionModule (minimum viable + guardrails) | Opus | 🔲 not started | Protein + calorie targets, rate-of-change guardrails, evidence-ranked supplement reference. Hard limits: no clinical diets, no disordered-eating counsel, refer to dietitian/physician. Depends on PR 1 (evidence tiers); profile bodyweight + goal. |
| 21 | Behavior-change & communication layer | Opus | 🔲 not started | Adherence tracking, anti-repetition constraints, identity/encouragement language, nudge timing. Autonomy-supportive; anti-guilt (missing one session is not failure). Depends on PR 10, PR 18. |

---

## Phase 6 — Advanced / Frontier

Only after the core (through PR 21) is trustworthy. Each is optional.

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 22 | Periodization & peaking engine | Opus | 🔲 not started | Block / DUP scheduling; strength-sport peaking + taper. Peaking only for the right population. Depends on PR 15, PR 17. |
| 23 | VBT support (optional) | Opus | 🔲 not started | Velocity field + individual load-velocity profile regression; velocity-loss cutoffs. Optional. Depends on PR 15. |
| 24 | Wearables + outcome learning (frontier) | Opus | 🔲 not started | Optional HRV / sleep ingestion as supporting signals; individual dose-response + recovery learning. Last, not first. Depends on PR 11, PR 12, PR 18. |

---

## What's next

**Current position: completing Phase 1 / entering Phase 2.**

Shipped: PR 1–9 (partial), PR 10 (partial), PR 11–14 (fully), PR 16 (partial), PR 18 (fully).
More precisely — fully shipped: PR 1–8, PR 11–14, PR 18. Partial: PR 9, PR 10, PR 16.
Not started: PR 15, PR 17, PR 19–24.

**Immediate next candidates** (dependency-safe):

1. **PR 15 — Autoregulation upgrade to ProgressionModule** (depends on PR 7 ✅, PR 8 ✅, PR 11 ✅, PR 14 ✅ — all done). Fully unblocked.
2. **PR 9 — Cold-start onboarding flow (complete)** (depends on PR 5 ✅, PR 7 ✅, PR 8 ✅ — all done). Fully unblocked.
3. **PR 19 — ConfidenceModule** (depends on most prior modules — all shipped). Now unblocked by PR 18 ✅.

**Do not start PR 15** (Autoregulation) without PR 7 (templates) in place — the autoregulation upgrade assumes working templates exist. PR 7 is now shipped ✅.

---

## Rules that hold across every PR

- One concern per PR; split if the diff is too large.
- Trust loop preserved: preview → approve → write. No real Sheets writes without approval.
- Never expose secrets; never merge without CI green.
- Escalate to Dale on schema, destructive, or governance decisions.
- The LLM/safety line never moves: the LLM explains, the code decides; safety is the most conservative module and can veto.
