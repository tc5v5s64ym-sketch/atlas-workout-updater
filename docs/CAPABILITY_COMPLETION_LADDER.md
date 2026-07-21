# Capability Completion Ladder

**Current as of:** 2026-07-21 · **Owner:** Atlas Recovery Campaign (Issue #1073), Phase 2 Work item 3 · **Status:** living assessment, refreshed as capabilities advance.

This is the honest replacement for the single self-declared `status` field the capability manifest used to carry (`complete | partial | missing`). That one word overstated capability — a module could read "complete" while never reaching a live route or a real session. This ladder splits "complete" into **nine ordered rungs** so the gap between *built* and *actually driving proven, user-visible output* is explicit. It closes **H-05** ("manifest overstates capability") and **H-15** ("'complete' ambiguity").

The machine-readable source of truth is the `ladder` object on each capability in [`config/coaching/manifests/capabilities.json`](../config/coaching/manifests/capabilities.json). This document is the skimmable published view.

## The nine rungs (low → high)

The ladder is **monotonic**: a higher rung may not be true while a lower rung is false. A capability's honest position is the **highest contiguous rung** it reaches. `services/capabilityManifest.js` validates the shape and monotonicity; Drift Guard 4 (`scripts/check-completion-ladder.js`, forthcoming in its own PR) enforces the evidence rule below.

| # | Rung | True when… |
|---|---|---|
| 1 | **built** | The module file exists and contains real logic for the capability (not a build-ahead stub, not a missing file). |
| 2 | **unit_tested** | A test exercises that module's capability directly. |
| 3 | **runner_wired** | An adapter in `services/coachRunners.js` `buildRunners()` lets the Orchestrator actually invoke it (a capability with no runner is skipped-with-flag at runtime). |
| 4 | **inputs_available** | Every `requires` input the capability needs is populated by State Assembly (`services/stateAssembly.js`) from a durable source at runtime. |
| 5 | **route_consumed** | A production HTTP route reads the capability's orchestrated output and can let it shape the served response. **Requires a named `consumer`.** |
| 6 | **user_visible** | That consumed output actually reaches rendered, user-facing text/UI. |
| 7 | **validator_covered** | The consumed, user-visible output is gated by a schema/contract validator on the live path. |
| 8 | **live_proven** | A real (non-synthetic) session trace proves it ran end to end in production. **Requires a linked trace id.** |
| 9 | **owner_accepted** | The owner has explicitly accepted the capability at a gate. |

## Assessment rules (owner rulings, 2026-07-20)

1. **Understate when unsure.** When a capability is genuinely ambiguous between two rungs, the **lower** one is assigned. Understating is safe; overstating is the disease being cured.
2. **Name the consumer.** Nothing may claim `route_consumed` or higher without a non-empty `consumer` naming the live route/seam. (Validated in `capabilityManifest.js`.)
3. **Evidence for `route_consumed` / `live_proven`.** A capability at either rung must carry an `evidence` array of linked test or trace ids. (Enforced by **Drift Guard 4**.)
4. **`owner_accepted` is owner-gate-only.** No agent may ever self-assign `owner_accepted = true`; it is set solely at an explicit owner gate. Every capability is therefore `owner_accepted = false` today.

## The ladder table

Legend: **✓** = true · **·** = false. Rungs are abbreviated in ladder order.

| Capability | Module | built | unit | run | inp | route | user | valid | live | owner | **Highest rung** |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| `scenario_classifier` | scenarioClassifier.js | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | **inputs_available** |
| `progression` | progressionModule.js | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | **inputs_available** |
| `safety` | safetyClassifierModule.js | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | **inputs_available** |
| `constraint_resolver` | constraintResolver.js | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | **inputs_available** |
| `session_generator` | sessionGenerator.js | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | **inputs_available** |
| `confidence` | confidenceModule.js | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | **inputs_available** |
| `goals` | goalTemplateModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `memory` | memoryModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `user_state` | userStateModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `intensity` | intensityModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `expected_performance` | expectedPerformanceModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `fatigue` | fatigueAssessmentModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `volume` | volumeAssessmentModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `ontology` | entityResolutionModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `program_templates` | periodizationModule.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `onboarding` | onboardingRouter.js | ✓ | ✓ | · | · | · | · | · | · | · | **unit_tested** |
| `equipment` | equipmentModule.js | · | · | · | · | · | · | · | · | · | **(not built)** |
| `movement_patterns` | movementPatternModule.js | · | · | · | · | · | · | · | · | · | **(not built)** |
| `nutrition` | nutritionModule.js | · | · | · | · | · | · | · | · | · | **(not built)** |

**Summary:** 6 capabilities reach `inputs_available`, 10 reach `unit_tested`, 3 are not built. **Zero** reach `route_consumed` or higher.

## Why nothing reaches `route_consumed` yet

The capabilities in this manifest are the Brain modules the **One-Brain Coach Orchestrator** runs. The Orchestrator is invoked from `index.js` at `/api/plan/today`, `/api/plan/intent-recommendation`, and `/api/recommend/next/:liftCode`, **but only when `ATLAS_COACH_ENGINE` is `hybrid` or `brian`**:

- In `hybrid` (the shadow mode) the orchestrated decision is recorded to Brain Shadow and, at most, attached as an inert `brian` summary that **never affects the served response**.
- In `brian` mode the decision *can* override recommendations — but `brian` mode is One-Brain promotion, which is **owner-gated (H-04) and not yet promoted**.

So on the default production path no capability's orchestrated output shapes user-visible output. Genuine route consumption is explicitly **Phase 4** work ("make the live coach route consume the CoachTurnPacket"). Under the understate rule, `route_consumed` is therefore `false` for every capability today. As Phase 4 wires the packet in behind its flag and proves it live, capabilities advance up the ladder — each new `route_consumed` claim naming its consumer route and carrying a linked test/trace id.

## Interpretation notes (the non-obvious calls)

- **The six runner-wired capabilities** (`scenario_classifier`, `progression`, `safety`, `constraint_resolver`, `session_generator`, `confidence`) are exactly the adapters in `coachRunners.buildRunners()`. Their `requires` inputs are all served by State Assembly (`log_history`, `profile_goal`), so they reach `inputs_available` — but stop there because consumption is shadow/flag-gated (above).
- **`onboarding`** was previously "complete". It is built and unit-tested but has **no runner** (`onboardingRouter.js` states the Orchestrator registers no onboarding runner), and its required `training_level` has no durable source in State Assembly. Honest ceiling: `unit_tested`.
- **`ontology`** (`entityResolutionModule.js`) was previously "complete". Its `resolveExercise` is used directly by production reads/catalog paths, but **as an orchestrated capability it has no runner**, so its ladder position is assessed on the orchestrated pipeline: `unit_tested`. The independent direct use is real but is a different consumer of the same code, not this capability being orchestrated.
- **`user_state`** was previously "partial". It is a `depends_on` of `scenario_classifier` and `confidence`, but their runners recompute what they need directly (`deriveLiftState`, `queryTrend`) rather than reading a `user_state` runner output — so `user_state` itself is not runner-wired. Honest ceiling: `unit_tested`.
- **`equipment`, `movement_patterns`, `nutrition`** were "missing". Their module files **do not exist on disk** — they are declared build-ahead slots — so they are honestly `built = false` (every rung false). The Orchestrator skips a not-built capability with a provenance flag, never dropping it (unchanged from the retired `status:'missing'` behavior).

## How this is enforced

- **Shape + monotonicity + name-the-consumer:** `services/capabilityManifest.js` `validateManifest()` (unit-tested in `test/capabilityManifest.test.js`).
- **Not-built ↔ missing-file drift:** `test/manifest-module-files.test.js` and `test/contracts-integrity.test.js` (a built capability must resolve on disk; a not-built one must not).
- **Runtime skip-with-flag:** `services/coachOrchestrator.js` skips `ladder.built === false` capabilities (`test/coachOrchestrator.test.js`).
- **Evidence for consumption claims:** **Drift Guard 4** — `scripts/check-completion-ladder.js` / `npm run check:ladder` — fails CI if any capability claims `route_consumed` or `live_proven` without a linked test or trace id. (Lands in its own PR.)
