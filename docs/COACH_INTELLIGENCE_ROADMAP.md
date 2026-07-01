# Atlas Coach Intelligence Layer — PR Roadmap

> **This is a progress ledger, NOT an execution queue.** It records what the coach-intelligence build series has shipped; it is **subordinate to `docs/ACTIVE_ROADMAP.md` (the active queue) and `BACKLOG.md` (the source of truth)**. Do not select or sequence work from this file — if it disagrees with `ACTIVE_ROADMAP.md`/`BACKLOG.md`, those win. The current active build is the **One-Brain coaching engine** (`docs/COACHING_ENGINE_ARCHITECTURE.md`; sequence in `BACKLOG.md`).
>
> **Source of truth (for this file's scope):** `docs/research/coaching-intelligence/atlas-coach-intelligence-roadmap.pdf`
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
| 9 | Cold-start onboarding flow | Opus | ✅ shipped | `services/onboardingState.js` (PR-O1) + `services/onboardingSessionPlan.js` (PR-O2) + `services/onboardingRouter.js` (PR-O5) shipped. `routeOnboarding(params)` routes questionnaire answers (goalId, trainingLevel, availableEquipment, daysPerWeek, logEntries) to cold-start calibration, beginner LP, 5/3/1, block, or DUP assignment. 59 tests. Voice gate (PR-O3) shipped. UX wiring (PR-O4: frontend banner + live producer wiring) deferred to owner direction. Depends on PR 5, PR 7, PR 8. |
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
| 15 | Autoregulation upgrade to ProgressionModule | Opus | ✅ shipped | `services/autoregulationModule.js`; 41 tests. `computeCurrentE1RM`, `detectLPGraduation`, `autoregulateLoad` — e1RM-derived load prescription with readiness-adjusted RIR and plate rounding; graduate-from-LP plateau detection. Depends on PR 8, PR 11, PR 14. |

---

## Phase 4 — Personalization, Memory & Confidence

**Milestone at PR 19: a personalized coach.**

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 16 | SubstitutionModule | Opus | ⚠️ partial | `services/substitutionRecommender.js`, `substitutionQuality.js`, `substitutionIntent.js` exist and are wired. A formal Brian-layer `SubstitutionModule` with the equipment-aware filtering + referential-integrity check described in the roadmap has not been built as a standalone composite. Depends on PR 2, PR 4. |
| 17 | Goal / population templates & caps (+ 5/3/1) | Opus | ✅ shipped | Goal templates (`config/coaching/goals/`): general-fitness, powerlifting, bodybuilding, weight-loss → `goalTemplateModule.js` (`getGoalTemplate`, `listGoalTemplates`, `selectPrograms`). Population caps (`config/coaching/populations/`): general, older-adult, youth, busy-parent, home-gym → `populationCapsModule.js` (`applyPopulationCaps`). 5/3/1 config (`config/coaching/programs/531-intermediate.json`) → `intermediateProgramModule.js` (`buildNextSession531`, `suggestNextCycleMaxes`, `computeTrainingMax`). 125 tests. Depends on PR 7, PR 8, PR 15. |
| 18 | Memory architecture (trends + coach memory + entity resolution) | Opus | ✅ shipped | `services/entityResolutionModule.js` (name→exerciseId; aliases + progressions; priority: exact>name>alias>progression) + `services/memoryModule.js` (Brian-layer composite: `queryTrend`, `queryPatterns`, `buildMemorySnapshot`, `resolveExercise`, `listExerciseIds`); 51 tests. Depends on PR 6, PR 14. |
| 19 | ConfidenceModule (ask vs act) | Opus | ✅ shipped | `services/confidenceModule.js` — `scoreConfidence(params)` → `{ confidenceScore, tier, action, caveats, safetyInverted, dimensions }`. Four weighted dimensions: completeness (0.30), recency (0.25), consistency (0.25), selfReportReliability (0.20). Tiers: ≥75=high→act, ≥45=moderate→act_with_caveat, <45=low→ask. Safety inversion escalates action one step toward ask when flags are active. Six machine-readable `CAVEAT_KEYS` (LLM words them). 42 tests. Depends on PR 6, PR 11, PR 15, PR 18. |

---

## Phase 5 — Nutrition & Communication

**Milestone at PR 21: a complete core coach.**

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 20 | NutritionModule (minimum viable + guardrails) | Opus | 🔲 not started | Protein + calorie targets, rate-of-change guardrails, evidence-ranked supplement reference. Hard limits: no clinical diets, no disordered-eating counsel, refer to dietitian/physician. Depends on PR 1 (evidence tiers); profile bodyweight + goal. |
| 21 | Behavior-change & communication layer | — | 🔬 reclassified → research | The coach **communication** layer is now filed as **research**, not a build-PR here: see `docs/research/coaching-intelligence/` source `05-coach-communication-intelligence` and the captured direction in `docs/CONVERSATION_CONTRACT_V1.md` (communication policy, coach-note tone, autonomy-supportive/anti-guilt language, when to speak vs. stay quiet). Behavior-change *triggers* remain engine work under One-Brain. |

---

## Phase 6 — Advanced / Frontier

Only after the core (through PR 21) is trustworthy. Each is optional.

| PR | Title | Model | Status | Notes |
|---|---|---|---|---|
| 22 | Periodization & peaking engine | Opus | ✅ shipped | `config/coaching/periodization/` (block-intermediate, dup-patterns, peaking configs) + `services/periodizationModule.js` (`selectPeriodizationModel`, `buildBlockPhases`, `getDupSessionTypes`, `isPeakingAppropriate`, `buildPeakingPhase`). Block: 8-week 3-phase cycle (accumulation/intensification/realization). DUP: 3- and 4-day weekly patterns (strength/hypertrophy/power). Peaking: 2-week taper, powerlifting only, youth/older-adult excluded. 82 tests. Depends on PR 15, PR 17. |
| 23 | VBT support (optional) | Opus | 🔲 not started | Velocity field + individual load-velocity profile regression; velocity-loss cutoffs. Optional. Depends on PR 15. |
| 24 | Wearables + outcome learning (frontier) | Opus | 🔲 not started | Optional HRV / sleep ingestion as supporting signals; individual dose-response + recovery learning. Last, not first. Depends on PR 11, PR 12, PR 18. |

---

## What's next

**Current position: Phase 4 complete through PR 19; PR 9, PR 17 and PR 22 shipped.**

Shipped: PR 1–9, PR 11–15, PR 17–19, PR 22 (fully). Partial: PR 10, PR 16.
Not started: PR 20, PR 21, PR 23, PR 24.

**Immediate next candidates** (dependency-safe):

1. **PR 20 — NutritionModule** (depends on PR 1 ✅, PR 19 ✅ — all done). Blocked by CLAUDE.md "What not to build: Nutrition tracking" — needs owner direction to unblock.
2. **PR 10 — Thin LLM explanation layer (complete)** (depends on PR 5 ✅, PR 8 ✅ — all done). `services/coach.js` + coach endpoints exist; formal `getNextWorkout / getProgressionDecision / getVolumeStatus / checkSafety` function-calling interface not yet wired.

---

## Rules that hold across every PR

- One concern per PR; split if the diff is too large.
- Trust loop preserved: preview → approve → write. No real Sheets writes without approval.
- Never expose secrets; never merge without CI green.
- Escalate to Dale on schema, destructive, or governance decisions.
- The LLM/safety line never moves: the LLM explains, the code decides; safety is the most conservative module and can veto.
