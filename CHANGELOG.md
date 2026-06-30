# Changelog

## [Unreleased]

### Added — Periodization & peaking engine (roadmap PR 22)

Three new periodization configs (`config/coaching/periodization/`):
- **`block-intermediate.json`**: 3-phase block model (accumulation 4 wk / intensification 3 wk / realization 1 wk). Intensity ranges: 65–75% / 75–87% / 90–97% TM. Volume factors: 1.0 / 0.75 / 0.50.
- **`dup-patterns.json`**: Daily Undulating Periodization patterns for 3-day (strength/hypertrophy/power) and 4-day (strength/hypertrophy/power/hypertrophy) splits. Session types carry rep range, %TM range, and RPE target.
- **`peaking.json`**: 2-week competition taper. Phase 1 (week −2): keep 60% volume, maintain intensity. Phase 2 (week −1): keep 40% volume, intensity ceiling at 97% TM. Eligible: powerlifting goal only; excluded: youth, older-adult (intensity caps incompatible with competition prep).

New engine module **`services/periodizationModule.js`**:
- `selectPeriodizationModel(goalId, trainingLevel)` → `{ modelId, goalId, trainingLevel, notes }` — maps goal × level to the appropriate model (`531_wave` delegates to `intermediateProgramModule`; `block-intermediate` or `dup-patterns` handled here). Returns null for beginner (LP handled by `starterProgramModule`).
- `buildBlockPhases(modelId)` → full phase structure for `block-intermediate`.
- `getDupSessionTypes(daysPerWeek)` → ordered session-type descriptors for 3- or 4-day DUP pattern.
- `isPeakingAppropriate(goalId, populationId)` → boolean; false for non-powerlifting goals or youth/older-adult populations.
- `buildPeakingPhase(params)` → 2-phase taper prescription keyed by lift code; each prescription carries `trainingMax`, `targetIntensityMax` (round5), `volumeFactor`, `repRange`. Returns null for ineligible goal/population.

82 new tests. No Sheets access, no write-path change, no LLM involvement. No runtime consumer yet. Depends on PR 15 (AutoregulationModule) and PR 17 (goal/population templates + 5/3/1). Completes Phase 6 periodization capability.

---

### Added — Goal/population templates & caps + 5/3/1 intermediate program (roadmap PR 17)

Four goal template configs (`config/coaching/goals/`): `general-fitness`, `powerlifting`, `bodybuilding`, `weight-loss`. Each maps a user goal to recommended program IDs by training level (beginner/intermediate/advanced) and carries a `knowledge_goal_id` linking to the existing `trainingKnowledge.js` goal taxonomy.

Five population caps configs (`config/coaching/populations/`): `general` (all nulls — uncapped baseline), `older-adult` (≤4 days/week, ≤60 min, RIR floor 2, intensity ceiling 85%), `youth` (≤4 days/week, ≤60 min, RIR floor 2, intensity ceiling 80%), `busy-parent` (≤3 days/week, ≤45 min), `home-gym` (preferred equipment list; no day/intensity caps).

One program config (`config/coaching/programs/531-intermediate.json`): Wendler 5/3/1 four-week wave cycle. 4-day split (Squat / OHP / Deadlift / Bench). Wave percentages: 65/75/85% (5s week), 70/80/90% (3s week), 75/85/95% (5/3/1 week), 40/50/60% (deload week). Top set is always AMRAP; deload sets are fixed. +5 lb upper / +10 lb lower after each cycle.

Three new engine modules:
- **`services/goalTemplateModule.js`** — `getGoalTemplate(id)`, `listGoalTemplates()`, `selectPrograms(goalId, {trainingLevel})`. `listGoalTemplates()` returns summary-only objects (no `recommended_programs` exposed). `selectPrograms` filters by `training_levels` array.
- **`services/populationCapsModule.js`** — `getPopulationCaps(id)`, `listPopulations()`, `applyPopulationCaps(params, populationId)`. Caps applied only when the param field is non-null/non-undefined in the input; unknown population IDs return an unmodified copy. `listPopulations()` summary omits `constraints`.
- **`services/intermediateProgramModule.js`** — `buildNextSession531(state)`, `suggestNextCycleMaxes(trainingMaxes)`, `computeTrainingMax(tested1RM)`. State is minimal: `{ sessionCount, trainingMaxes }`. Cycle position derived as `sessionCount % 16`; week as `floor(cyclePos/4)`; day as `cyclePos % 4`. `isCycleBoundary` signals when the caller should have already incremented maxes. All weights rounded to nearest 5 lb (`_round5`).

125 new tests across three new test files. No Sheets access, no write-path change, no LLM involvement. Unblocks roadmap PR 22 (periodization engine).

---

### Added — ConfidenceModule: ask-vs-act decision engine (roadmap PR 19)

New pure-engine module `services/confidenceModule.js`. No Sheets access, no side effects, no LLM involvement.

**`scoreConfidence(params)`** — Synthesizes signals from prior Brian-layer modules into a single confidence score that drives the `act` / `act_with_caveat` / `ask` recommendation. All params are optional; absent fields degrade the score rather than throwing. Returns a `ConfidenceResult` or `null` for invalid input.

Four weighted dimensions (weights sum to 1.0):
- **completeness** (0.30): sessions tracked toward e1RM trend [0–50 pts] + readiness inputs used [0–30 pts] + entity-resolved exercise [0 or 20 pts].
- **recency** (0.25): days since last session → score 100/80/60/40/20/0 at ≤3/≤7/≤14/≤21/≤30/>30 days.
- **consistency** (0.25): trend label (improving=100, stalling/flat=70, declining=60, noisy=30, other=20) × trend-confidence multiplier (high=1.0, medium=0.7, else=0.3).
- **selfReportReliability** (0.20): readiness confidence base (high=100, medium=60, low=30) × penalty (0.7) when inputs absent outnumber inputs used.

Tiers: ≥75 → `high` → `act`; ≥45 → `moderate` → `act_with_caveat`; <45 → `low` → `ask`.

Safety inversion: an active safety flag always escalates the action one step toward `ask` (high→act_with_caveat with `safetyInverted:true`; moderate→ask with `safetyInverted:true`; low unchanged).

Six machine-readable caveat keys (exported as `CAVEAT_KEYS`): `insufficient_history`, `stale_data`, `low_trend_confidence`, `limited_readiness_inputs`, `exercise_unresolved`, `safety_flag_present`. The LLM reads these and chooses appropriate language; it never derives them itself.

New test `test/confidenceModule.test.js` — 42 tests: null/non-object guards, full-data score=100 (act), empty-data score=0 (ask), moderate-data score=55 (act_with_caveat), sparse+stale tier=low, tier boundary at 75 and 74, all three safety inversion branches, all six caveat keys (present and absent), multiple simultaneous caveats, complete result shape and dimension sub-fields, numeric `inputsUsed` format, trend variant ordering (improving > stalling/flat > declining), recency boundary scores at 7 and 14 days.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change. Unblocks roadmap PR 20 (BrianOrchestrator).**

---

### Added — AutoregulationModule: e1RM-driven, readiness-aware load prescription (roadmap PR 15)

New pure-engine module `services/autoregulationModule.js`. No Sheets access, no side effects, no LLM involvement.

**`computeCurrentE1RM(liftCode, logEntries)`** — Computes the best estimated one-rep max from the most recent 3 sessions for a given lift. Filters warm-up sets (explicit warm-up note, weight < 60% of session max, or RIR ≥ 4) before computing. Uses the RIR-adjusted Epley formula (`weight / percentOf1RM(reps, rir)`) when a valid RIR (0–4) is present; falls back to plain Epley otherwise. Returns `null` when there is insufficient or invalid data.

**`detectLPGraduation(liftCode, logEntries, opts?)`** — Detects whether a lifter should graduate from session-to-session linear progression for a lift. Delegates to `detectLiftPlateaus` (PR 14): fires when e1RM has not improved across `minSessions` (default 3) consecutive sessions. Returns `{ shouldGraduate, reason, plateauDetails }`.

**`autoregulateLoad(params)`** — Builds a readiness-adjusted, e1RM-derived load prescription for one lift session. Params: `{ liftCode, logEntries, targetReps=5, targetRIR=1, readinessInputs=null, bodyRegion='upper_body' }`. Flow: (1) score readiness via `scoreReadiness` (PR 11) → tier (`high`/`moderate`/`low`) → add 0/1/2 RIR to effective RIR; (2) compute current e1RM; (3) derive weight via `targetWeightForRIR(e1rm, reps, effectiveRIR)` → plate-round (2.5 lb upper body, 5 lb lower body); (4) run plateau check. Returns `{ recommendedWeight, targetReps, effectiveRIR, e1rm, readinessTier, readinessAdjustment, graduateFromLP, plateauDetails, basis }`. `basis` is `'e1rm_derived'` | `'increment_fallback'` | `'insufficient_data'`.

New test `test/autoregulationModule.test.js` — 41 tests: `computeCurrentE1RM` guards (null inputs, no-match, case-insensitive), RIR-adjusted vs Epley formulas, 3-session window, warm-up exclusion (note / weight / RIR), best-across-session selection; `detectLPGraduation` guards, flat vs improving plateau detection, cross-lift isolation; `autoregulateLoad` guards, default values, round-trip weight derivation, readiness tier adjustments (high/moderate/low ordering verified), plate rounding (2.5 lb and 5 lb), result shape, LP graduation wiring, case-insensitive code matching.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change. Unblocks roadmap PR 17, PR 22, PR 23.**

---

### Added — MemoryModule: long-term trends store + entity resolution (roadmap PR 18)

Two new pure-engine modules. No Sheets access, no side effects, no LLM involvement.

**`services/entityResolutionModule.js`** — Maps raw exercise names and colloquialisms to canonical exercise IDs in the Atlas ontology. Reads `config/coaching/exercises/_index.json` and individual exercise JSON files (both cached after first load). Resolution priority (highest to lowest): `exact` (direct ID match, e.g. `'back-squat'`), `name` (canonical display name, e.g. `'Back Squat'`), `alias` (alias listed in exercise JSON, e.g. `'military press'` → `overhead-press`, `'deadlift'` → `conventional-deadlift`, `'BB squat'` → `back-squat`), `progression` (variant listed in `progressions` array, e.g. `'low-bar back squat'` → `back-squat`). Normalization strips hyphens and collapses whitespace so `'bent-over row'` and `'bent over row'` both resolve. Higher-priority matches win: `'goblet squat'` resolves to `goblet-squat` (name match) not `back-squat` (progression match). Two exports: `resolveExercise(rawName)` → `{ exerciseId, name, confidence, method }` | null; `listExerciseIds()` → sorted canonical ID list.

**`services/memoryModule.js`** — Brian-layer composite that formalizes the long-term-trends store, coach-memory pattern detection, and entity resolution as a single read-only module. Wraps `trendDetector.js` (`detectTrend`) and `coachMemory.js` (`detectPatterns`, `detectMissedLifts`). Five exports: `resolveExercise` (re-exported from entityResolutionModule), `listExerciseIds`, `queryTrend(liftCode, logRows)`, `queryPatterns(liftCode, logRows, opts?)`, `buildMemorySnapshot(logRows, opts?)`. `buildMemorySnapshot` sweeps all lift codes present in the 12-column Log_Cleaned rows and returns `{ liftsEncountered, liftTrends, liftPatterns, missedLifts }` — a full memory snapshot across all active lifts. `opts.substitutionHistory` is forwarded to pattern detection; `opts.missedLiftHistory` is forwarded to missed-lift detection.

New test `test/memoryModule.test.js` — 51 tests: entity resolution (exact, name, alias, progression, normalization, priority, no-match); `listExerciseIds` (non-empty, sorted, no duplicates); `queryTrend` (insufficient data guards, improving/declining/flat detection, confidence tiers); `queryPatterns` (empty guards, substitution threshold); `buildMemorySnapshot` (shape, lift enumeration, sort order, trend/pattern per-lift, missedLifts propagation, snapshot with mixed lifts).

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change. Unblocks roadmap PR 19 (ConfidenceModule).**

---

### Added — StarterProgramModule: StrongLifts 5×5 + GZCLP templates + deterministic session runner (roadmap PR 7)

New pure-engine module `services/starterProgramModule.js` — deterministic template runner for beginner starter programs. No Sheets access, no side effects, no LLM involvement. Depends only on `config/coaching/programs/` JSON data files.

Two new program data files:
- **`config/coaching/programs/stronglifts-5x5.json`** — StrongLifts 5×5: 2-session (A/B) alternating cycle, 3 days/week. Session A: Squat 5×5 / Bench 5×5 / Row 5×5. Session B: Squat 5×5 / OHP 5×5 / Deadlift 1×5. Linear progression: +10 lb per session (lower body) / +5 lb (upper body). Deload 10% after 3 consecutive fails.
- **`config/coaching/programs/gzclp.json`** — GZCLP: 4-session (Day 1–4) cycle, 4 days/week. Tiered structure: T1 (main compound, 5×3+ → 6×2+ → 10×1+), T2 (secondary compound, 4×6+ / 4×10+ on stall), T3 (accessories, 3×10 fixed). Progressive stall handling via tier escalation.

Three exported functions:
- **`getProgram(programId)`** — load and return the parsed program config or null.
- **`listPrograms()`** — return `[{ id, name }]` for all programs found in `config/coaching/programs/`.
- **`buildNextSession(programId, state)`** — deterministic session prescription from program state. For SL5×5: reads `sessionCount` to determine A/B, applies LP (increase/hold/deload) from `consecutiveFails`. For GZCLP: reads `sessionCount` for Day 1–4 rotation; T1 tier from `t1Tiers` (0=5×3+, 1=6×2+, 2=10×1+, clamped to max); T2 hold/deload from `consecutiveFails`; T3 from session template fixed scheme. Each exercise in the returned `exercises` array carries: `exerciseId`, `liftCode`, `sets`, `reps`, `repsScheme` ('fixed'/'amrap'), `targetWeight`, `bodyRegion`, `tier` (null for SL5×5, 'T1'/'T2'/'T3' for GZCLP), `progressionNote`.

New test `test/starterProgramModule.test.js` — 56 tests covering: all invalid-input/null guard paths; cycle alternation (A/B over 6 sessions, Day 1–4 over 8 sessions); start-weight fallback; LP increment correct per body region (upper +5 lb, lower +10 lb); hold on 1–2 fails; deload after 3 fails rounded to nearest 5 lb; T1 tier switching (0→1→2) and out-of-bounds clamping; T2 normal vs stall scheme; T2 deload after 2 consecutive fails; T3 fixed accessory shape; all required prescription fields present; GZCLP tier labels on all 4 days.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change. Unblocks roadmap PR 9 (full onboarding flow) and PR 17 (goal/population templates).**

---

### Added — ExpectedPerformanceModule: composite expected-performance + plateau assessment (Brian PR 16 / roadmap PR 14)

New read-only composite engine `services/expectedPerformanceModule.js` — wraps the two partial Phase-3 components (`expectedPerformance.js` and plateau/stall detection) into a formal structured assessment API. No Sheets access, no side effects, no LLM involvement. Depends on IntensityModule, FatigueAssessmentModule (PR 11/12), and UserStateModule substrate (PR 6).

Three exported functions:

- **`assessExpectedPerformance(liftCode, logEntries, targetWeight)`** — structured-entry adapter for `computeExpectedPerformance`. Converts named-field objects to the 12-column positional array the inner function expects, then calls it. Returns `{ expectedReps, expectedRirRange, basis }` or null when fewer than 3 sessions match the ±10% weight window. Lift-code matching is case-insensitive.

- **`detectLiftPlateaus(logEntries, opts)`** — stall detection directly on structured objects. Groups entries by lift code; per session tracks best weight and best Epley e1RM (`w × (1 + r/30)`). A lift is stalled when the maximum e1RM across the last `opts.minSessions` sessions (default 3, min 2) does not exceed the first session's e1RM by more than 1e-6. Warm-up sets (matched via `isWarmupNote`) are excluded. Returns an array of stall descriptors: `{ liftCode, exercise, sessions_stalled, last_best_weight, first_session_date, last_session_date }`.

- **`assessLift(liftCode, logEntries, targetWeight, opts)`** — composite: runs both above, looks up the plateau (if any) for the specific lift, and optionally scores readiness via `scoreReadiness(opts.readinessInputs)`. Applies a conservative rep adjustment: high readiness → no change; moderate → −1 rep; low → −2 reps (clamped to minimum 1). Returns `{ liftCode, targetWeight, expectedPerformance, plateau, readiness, adjustedExpectedReps, readinessAdjustment }` or null for invalid inputs.

New test `test/expectedPerformanceModule.test.js` — 35 tests covering: all invalid-input paths for all three functions; weight-window boundary (entry outside ±10% excluded); warm-up exclusion from both expected performance and plateau detection; confidence tiers ('medium' at 3–4 sessions, 'high' at 5+); stall detection with flat vs improving vs rep-gain-at-same-weight patterns; `opts.minSessions` override; multi-lift isolation; stall descriptor shape; readiness-tier adjustments (high/moderate/low) and clamp to 1; null `adjustedExpectedReps` when `expectedPerformance` is null.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — UserStateModule: per-user per-lift state substrate (Brian PR 15)

New read-only composite engine `services/userStateModule.js` — aggregates raw `Log_Cleaned` entries into a compact per-user feature object used as the substrate for coaching decisions and the LLM explanation layer. No Sheets access, no side effects, no LLM involvement. Depends on IntensityModule (PR 3) and VolumeAssessmentModule (PR 4).

Single entry point: `buildUserState(logEntries, opts)` — accepts an array of log row objects (one row = one set, matching the 12-col `Log_Cleaned` schema) and options `{ asOf (required ISO date), windowDays (default 7), trendSessions (default 5) }`. Returns `null` for non-array input or missing/invalid `asOf`. Returns a structured state object:

- `liftStates` — keyed by `canonical_exercise`:
  - `e1rm.current` — best RIR-adjusted Epley e1RM from the most recent session (null if no valid sets).
  - `e1rm.trend` — `'improving'` / `'stalling'` / `'declining'` / `'insufficient_data'` computed from the last `trendSessions` sessions. Older and newer halves are averaged; a 2 % delta triggers a trend call.
  - `e1rm.sessionsTracked` — sessions inside the trend window.
  - `pr.bestE1rm` — all-time best estimated e1RM across all entries.
  - `pr.bestSetWeight` / `pr.bestSetReps` — heaviest set lifted and the reps recorded at that weight.
  - `staleness.daysSinceLastSession` / `staleness.lastSessionDate` — days since last session relative to `asOf`.
- `muscleVolume` — keyed by normalised muscle name (lowercase, parenthetical qualifier stripped). Within the `windowDays` window, each row counts as one set for its `muscle_group`. Known muscles include zone classification (`below_mev` / `mev_to_mav` / `mav_to_mrv` / `above_mrv`) and `{ landmarks: { mev, mav, mrv }, distanceToMav, distanceToMrv }`. Unknown muscles are still tracked with `zone: null, landmarks: null`.
- `adherence` — `{ sessionsInWindow, windowDays, sessionsPerWeek }`: distinct training dates in the window and derived frequency.

Uses RIR-adjusted e1RM (`weight / percentOf1RM(reps, rir)`) when `rir` is 0–4; falls back to plain Epley when absent or out of range. `reps > 20` entries are skipped for e1RM but still contribute to PR tracking and volume counting. `asOf` is required (not inferred from wall-clock time) so the function is fully deterministic and testable. Also exports `_normalizeMuscle` for downstream consumers.

New test `test/userStateModule.test.js` — 43 tests covering: all invalid-input paths (null, non-array, missing/invalid `asOf`); entry filtering (missing exercise, bad date, null entries); liftState shape validation; e1RM estimation with and without RIR; PR tracking (bestSetWeight selection, all-time bestE1rm); staleness (daysSinceLastSession = 0 on training day, 3-day gap); trend classification (1 session → insufficient_data; 2 sessions each direction; same-session best-set dedup; `trendSessions` cap); multiple independent lifts; muscleVolume (window inclusion/exclusion, capitalised + parenthetical normalization, known vs unknown muscle, zone classification); adherence (distinct dates, window exclusion, sessionsPerWeek math, exercises same date = one session); and default/fallback option handling.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — VolumeAssessmentModule: composite volume assessment engine (Brian PR 14)

New composite engine `services/volumeAssessmentModule.js` — combines `VolumeModule` (per-muscle landmarks, zone logic, set accumulation) with session and weekly exercise data to produce structured per-muscle volume assessments. No Sheets access, no side effects, no LLM involvement.

- `classifyMuscleVolume(muscle, weeklySets)` — maps a muscle name and weekly set count to a volume zone (`below_mev` / `mev_to_mav` / `mav_to_mrv` / `above_mrv`) plus landmark distances. Returns `{ muscle, weeklySets, zone, landmarks: { mev, mav, mrv }, distanceToMav, distanceToMrv }`, or null for invalid inputs or unknown muscle. `distanceToMav`/`distanceToMrv` are negative when above the landmark.
- `assessSessionVolume(exercises[])` — computes per-muscle set counts for a single session's exercise list. Returns `{ muscleSets, trackedMuscles[], untrackedMuscles[] }` where `trackedMuscles` are muscles with known landmarks and `untrackedMuscles` are those without. Returns null for non-array input. Volume counted from primary muscles only.
- `assessWeeklyVolume(sessionSetMaps[])` — aggregates per-session set maps into weekly totals and classifies each tracked muscle's volume zone. Returns a map of `{ muscle → { weeklySets, zone, landmarks, distanceToMav, distanceToMrv } }`. Only muscles with known landmarks appear. Returns `{}` for non-array input.

New test `test/volumeAssessmentModule.test.js` — 39 tests covering invalid inputs (null, non-array, NaN, negative, unknown muscle), all four zone transitions at exact boundaries (mev, mav, mrv), distance arithmetic (negative when above landmark), gluteus maximus mev=0 edge case, `assessSessionVolume` tracked vs untracked muscle separation, and `assessWeeklyVolume` accumulation and round-trip correctness from `assessSessionVolume.muscleSets`.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — SafetyClassifierModule: composite safety classification engine (Brian PR 13)

New composite engine `services/safetyClassifierModule.js` — combines `SafetyRulesModule` (traffic-light states, safe defaults) with active signal inputs to produce structured safety tier classifications. No Sheets access, no side effects, no LLM involvement. Safety override rule: this module's output can override all others; red > yellow > green.

- `classifyTrafficLight(activeSignals[])` — maps an array of observed signal strings to the most severe matching traffic-light tier. Matching is case-insensitive substring (active signal ⊆ config signal OR config signal ⊆ active signal). Returns `{ state: 'green'|'yellow'|'red', meaning, action, matchedSignals[], unmatchedSignals[], confidence: 'none'|'low'|'moderate'|'high' }`, or null for non-array input. Defaults to `green` when no signals match (normal coaching context). Three tiers from `SafetyRulesModule`: green = proceed, yellow = reduce/modify/substitute, red = stop + medical evaluation.
- `getSafeDefault(field)` — returns a specific safe-default value by field name (`'on_uncertainty'` | `'never'` | `'onboarding_screen'` | `'confidence_inversion'`). Returns null for unknown or internal fields (e.g. `'provenance'` is not exposed).

Among *matched* signals the most severe tier wins (red > yellow > green). The config's `confidence_inversion` rule is **not yet implemented** — unmatched signals default to green/proceed, which contradicts `on_uncertainty: "err toward caution"`; see the `[trust-critical]` BACKLOG item that must be resolved before any consumer wires this module into the coach surface.

New test `test/safetyClassifierModule.test.js` — 30 tests covering invalid inputs (null, non-array, empty strings, non-string entries), all three traffic-light state paths (green signals, yellow signals, red signals), severity priority (red overrides yellow, yellow overrides green), matched/unmatched signal tracking, confidence tiers (none/low/moderate/high), result shape (meaning + action from config), case-insensitive matching, and all four `getSafeDefault` fields plus rejection of unknown/internal fields.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — FatigueAssessmentModule: composite fatigue/recovery/deload engine (Brian PR 12)

New composite engine `services/fatigueAssessmentModule.js` — combines `FatigueRulesModule` (recovery priors, readiness inputs, deload triggers) with input signals to produce structured, number-complete fatigue and readiness assessments. No Sheets access, no side effects, no LLM involvement.

- `assessRecovery(muscleCategory, hoursSinceLastSession)` — maps muscle category + hours since last session to a recovery status using config recovery priors. Returns `{ status: 'recovered' | 'possibly_recovering' | 'likely_underrecovered', hoursLeft, recoveryWindow }`, or null for invalid inputs. Categories: `small_muscles` [24, 48h], `large_compound` [48, 72h], `heavy_eccentric_or_to_failure` [72, 96h].
- `scoreReadiness(inputValues)` — scores composite readiness from raw 0–10 input values (sleep, soreness, stress, motivation, recent_load, hrv). Applies weight_hints from config (`high` = 3×, `medium` = 2×, `low` = 1×) and known directionality (soreness/stress/recent_load are inverted). Returns `{ score (0–100 or null), tier ('low'|'moderate'|'high'), inputsUsed, inputsAbsent, confidence ('low'|'moderate'|'high') }`.
- `checkDeloadTriggers(weeksSinceDeload, activeTriggerKeys)` — evaluates planned and autoregulated deload criteria. Planned due when `weeksSinceDeload >= planned_every_weeks[0]` (4 weeks); autoregulated when `activeTriggerKeys.length >= 2`. Returns `{ plannedDeloadDue, autoregulatedTriggersFired, deloadWarranted, reason ('planned'|'autoregulated'|'both'|'none'), triggersPresent, weeksSinceDeload }`.

New test `test/fatigueAssessmentModule.test.js` — 40 tests covering all three boundary conditions for each muscle category, hoursLeft arithmetic, invalid input handling (negative hours, unknown category, null, string), readiness scoring (best/worst/mid-range inputs, weight_hint ordering, invalid values skipped, inputsUsed/inputsAbsent completeness, confidence tiers), and deload trigger logic (planned threshold, autoregulated count ≥ 2, reason classification, defaults, echoed fields).

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — ProgressionModule: composite progression recommendation engine (Brian PR 11)

New composite engine `services/progressionModule.js` — combines `ProgressionRulesModule` (scenario → action) with `IntensityModule` (weight math) to produce structured, number-complete progression recommendations. No Sheets access, no side effects, no LLM involvement.

- `computeLoadStep(currentWeight, bodyRegion, direction)` — minimum plate-friendly increment for one progression step: upper_body = 2.5% of current weight rounded to nearest 2.5 lb (floor 2.5 lb); lower_body = flat 5 lb. Returns `null` for invalid weight, non-positive weight, or unknown direction.
- `recommendProgression(scenarioId, context)` — maps a pre-classified scenario id + set context to a fully computed `{ scenarioId, default_action, lever, targetWeight, targetReps, rationale }`. Validates all context fields; returns null for unknown scenario or invalid context. Six scenarios handled:
  - `underloaded` → `increase_load`: lever = `load`; targetWeight via e1RM/RIR step when RIR > 0, else plain increment; floors at minimum increment.
  - `on_target` → `maintain_or_add_reps`: lever = `reps`; targetReps = currentReps + 1; targetWeight unchanged.
  - `normal_variability` → `hold_progression`: lever = `none`; all params held.
  - `likely_fatigue` → `hold_or_reduce_load`: lever = `load`; targetWeight = max(0, currentWeight − step).
  - `injury_signal` → `swap_exercise_or_reduce_rom`: lever = `none`; targetWeight = null.
  - `candidate_plateau` → `change_variant_reps_or_volume`: lever = `none`.

Context shape: `{ currentWeight (lb), currentReps (integer ≥ 1), currentRIR (≥ 0), bodyRegion? ('upper_body' | 'lower_body', defaults 'upper_body'), e1rm? (optional pre-computed) }`.

New test `test/progressionModule.test.js` — 37 tests covering `computeLoadStep` (upper/lower body increments, percentage rounding, floor at 2.5 lb, invalid weight/direction → null), `recommendProgression` invalid inputs (unknown scenarioId, null context, non-positive weight, non-integer reps, negative RIR), all six scenario paths (lever, targetWeight direction, targetReps arithmetic, rationale content), result shape completeness across all six scenarios, and `bodyRegion` defaulting.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — EvidenceTiersModule: read-only access to the knowledge-trustworthiness ranking (Brian PR 10)

New read-only module `services/evidenceTiersModule.js` — pure lookup functions over `config/coaching/evidence-tiers.json`:

- `getAllTiers()` — all 5 tier records in config order (defensive `.slice()` copy); each carries `tier` (1–5), `name`, `examples[]`, `best_for`, `caution`
- `getTier(tierNumber)` — single tier record by integer tier number (1–5), or null; returns null for non-integer, out-of-range, or non-number inputs
- `getExcluded()` — `{ description, examples[] }` — sources to down-weight or exclude (anecdote, influencer marketing, single-study sensationalism, supplement-company claims)

Tier ranking: 1 = consensus statements & position stands (ACSM/NSCA/ISSN/IOC) → 5 = evidence-based practitioners/orgs (RP/SBS/MASS/3DMJ). Tier 1 is the safest default; tier 5 heuristics are flagged as models, not validated measurements.

Loads lazily on first call; `_resetForTesting()` clears the cache between test files.

New test `test/evidenceTiersModule.test.js` — 21 tests covering all exports, all 5 tier numbers, required schema fields (tier/name/examples/best_for/caution), tier content spot-checks (tier 1 → ACSM/NSCA, tier 2 → systematic reviews/meta-analyses, tier 5 → practitioners/RP), ascending tier order, mutation guard, non-integer/non-number/out-of-range → null, excluded examples including "anecdote", and cross-function consistency.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — MovementPatternsModule: queryable index over the movement-pattern taxonomy (Brian PR 9)

New read-only module `services/movementPatternsModule.js` — pure lookup functions over `config/coaching/movement-patterns/patterns.json`:

- `getAllPatterns()` — all 12 patterns in config order (defensive `.slice()` copy)
- `getAllPatternIds()` — all 12 pattern ids in config order
- `getPattern(id)` — full pattern record by id, or null (`squat` | `hinge` | `lunge` | `horizontal_push` | `vertical_push` | `horizontal_pull` | `vertical_pull` | `carry` | `rotation` | `anti_rotation` | `isolation` | `locomotion`)
- `getPatternsByFamily(family)` — patterns filtered by family (`lower` | `upper` | `full` | `trunk` | `modifier`), defensive copy
- `getFamilies()` — all 5 distinct families in first-appearance order

Loads lazily on first call; `_resetForTesting()` clears the cache between test files.

New test `test/movementPatternsModule.test.js` — 33 tests covering all exports, all 12 known pattern ids, all 5 families with expected member counts, required schema fields (id/family/description/typical_primary), config order preservation, family-coverage completeness (all 12 patterns reachable via family), mutation guards, cross-function consistency, and non-string edge cases.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — SafetyRulesModule: read-only access to the traffic-light classifier and safe defaults (Brian PR 8)

New read-only module `services/safetyRulesModule.js` — pure lookup functions over `config/coaching/rules/safety.rules.json`:

- `getTrafficLight()` — all 3 traffic-light states in config order (defensive `.slice()` copy): `green` → proceed, `yellow` → reduce/modify, `red` → stop + medical evaluation
- `getTrafficLightState(state)` — single traffic-light record by state (`'green'` | `'yellow'` | `'red'`), or null; each record carries `state`, `meaning`, `signals[]`, `action`
- `getSafeDefaults()` — `{ on_uncertainty, never: [...], onboarding_screen, confidence_inversion }` — the safety prime directives: err toward caution, never diagnose, never coach through red-flag symptoms

Loads lazily on first call; `_resetForTesting()` clears the cache between test files.

New test `test/safetyRulesModule.test.js` — 24 tests covering all exports, all 3 traffic-light states, required schema fields, action/signal content checks (green→proceed, red→stop+medical, chest-pain signal, "no pain" green signal), safe-defaults field presence and content (caution/diagnose/red-flag), mutation guard on the traffic-light array, cross-function consistency, and non-string edge cases.

**No runtime consumer yet. The safety layer is the most conservative module and can override all others when wired. No Sheets access, no write-path or trust-loop change.**

---

### Added — FatigueRulesModule: read-only access to recovery priors, readiness inputs, and deload triggers (Brian PR 7)

New read-only module `services/fatigueRulesModule.js` — pure lookup functions over `config/coaching/rules/fatigue.rules.json`:

- `getRecoveryPriors()` — `{ small_muscles: [24,48], large_compound: [48,72], heavy_eccentric_or_to_failure: [72,96] }` recovery-window heuristics in hours
- `getReadinessInputs()` — all 6 readiness inputs in config order (defensive `.slice()` copy): `sleep`, `soreness`, `stress`, `motivation`, `recent_load`, `hrv`
- `getReadinessInputByKey(key)` — single readiness input record by key, or null (`subjective` | `derived` | `wearable` types; `high` | `medium` | `low` weight hints)
- `getDeloadTriggers()` — `{ planned_every_weeks: [4,6], autoregulated_any_two: [...6 triggers] }` deload decision config

Loads lazily on first call; `_resetForTesting()` clears the cache between test files.

New test `test/fatigueRulesModule.test.js` — 28 tests covering all exports, all 6 readiness input keys, required schema fields, enum validation (type/weight_hint values), mutation guard on the readiness inputs array, cross-function consistency checks, and non-string edge cases.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — ProgressionRulesModule: read-only access to the progression decision table (Brian PR 6)

New read-only module `services/progressionRulesModule.js` — pure lookup functions over `config/coaching/rules/progression.rules.json`:

- `getScenario(id)` — full scenario record by id, or null (`underloaded` | `on_target` | `normal_variability` | `likely_fatigue` | `injury_signal` | `candidate_plateau`)
- `getAllScenarios()` — all 6 scenario records in decision-table order (defensive `.slice()` copy)
- `getAllScenarioIds()` — all 6 scenario ids in decision-table order
- `getLeverOrder()` — `["load", "reps", "sets"]` (cheapest-to-most-expensive; defensive copy)
- `getIncrements()` — `{ upper_body_pct: [2.5, 5], lower_body_lb: [5, 10] }` default load jumps
- `getPlateauRule()` — `{ ignore_single_session_if, flag_plateau_if }` plateau detection config

Loads lazily on first call; `_resetForTesting()` clears the cache between test files.

New test `test/progressionRulesModule.test.js` — 31 tests covering all exports, all 6 scenario ids, required schema fields, mutation guards on copied arrays, cross-function consistency checks, and non-string edge cases.

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — VolumeModule: per-muscle set counting and MEV/MAV/MRV landmark zones (Brian PR 5)

New read-only module `services/volumeModule.js` — pure volume tracking layer; no Sheets access, no side effects:

- `computeExerciseSets(exerciseId, sets)` — primary-muscle set contribution for one exercise
- `computeSessionSets(exercises)` — aggregates `[{ exerciseId, sets }]` into per-muscle totals for a session
- `computeWeeklySets(sessions)` — aggregates multiple session set maps into weekly totals
- `getVolumeLandmarks(muscleGroup)` — MEV/MAV/MRV config for a muscle, or null if untracked
- `getAllVolumeLandmarks()` — all 16 tracked muscles with their landmark objects
- `volumeZone(weeklySets, muscleGroup)` — `'below_mev'` | `'mev_to_mav'` | `'mav_to_mrv'` | `'above_mrv'`

Volume is counted from **primary muscles only** (RP practitioner convention). Parenthetical name variants in the exercise ontology (e.g. `"quadriceps (rectus femoris, …)"`) are normalised to the base muscle name via a trailing-parenthetical strip before landmark lookup.

New config `config/coaching/volume/landmarks.json` — MEV/MAV/MRV ranges for 16 primary muscles (quadriceps, hamstrings, gluteus maximus, pectoralis major, latissimus dorsi, triceps brachii, biceps brachii, anterior deltoid, lateral deltoid, posterior deltoid, trapezius, mid-back, spinal erectors, rectus abdominis, gastrocnemius, soleus). All landmarks carry `contested: true` and `confidence: "low"` — they are highly individual heuristic starting points.

New test `test/volumeModule.test.js` — 38 tests covering all exports, parenthetical name normalisation, primary-only counting, cross-exercise accumulation, weekly aggregation, zone boundary conditions (at MEV, between MEV/MAV, at MAV, at MRV, above MRV), untracked muscles, edge cases (null/empty/non-array inputs), and an end-to-end session→weekly→zone roundtrip.

Uses `ExerciseLookupModule` for exercise→muscle mapping. **No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — ExerciseLookupModule: queryable index over the exercise ontology (Brian PR 4)

New read-only module `services/exerciseLookupModule.js` — loads `config/coaching/exercises/` once at require time and exposes pure lookup functions:

- `getExerciseById(id)` — full exercise record or null
- `hasExercise(id)` — boolean existence check
- `getAllExercises()` — all 52 exercises
- `getExercisesByMovementPattern(pattern)` — filtered by movement pattern
- `getExercisesByMuscle(muscleName)` — case-insensitive, covers primary + secondary muscles, no duplicates
- `getMovementPatterns()` — distinct patterns present in the catalog

Catalog is indexed once (lazy on first call) and cached in-process. `_resetForTesting()` clears the cache between test files.

New test `test/exerciseLookupModule.test.js` — 26 tests covering all exports, edge cases (null/empty/non-string inputs), completeness checks (52 exercises, 11 patterns), and catalog integrity (pattern sums, every exercise reachable by pattern).

**No runtime consumer yet. No Sheets access, no write-path or trust-loop change.**

---

### Added — IntensityModule: e1RM + RIR/%1RM read-only engine (Brian PR 3)

New pure read-only module `services/intensityModule.js` centralizing intensity calculations for the Coach Intelligence Layer:

- `estimateE1RM(weight, reps, formula?)` — Epley (default, consistent with analytics.js), Brzycki, or Lombardi formula
- `percentOf1RM(reps, rir)` — fraction of 1RM for a given reps × RIR combination (Epley-derived)
- `percentOf1RMByRPE(reps, rpe)` — RPE variant (RPE = 10 − RIR)
- `targetWeightForRIR(e1rm, targetReps, targetRIR)` — prescription weight from e1RM
- `targetWeightForRPE(e1rm, targetReps, targetRPE)` — RPE variant
- `estimateRIR(weight, reps, e1rm)` — inverse: estimate RIR from a logged set

New config `config/coaching/intensity/e1rm-formulas.json` — formula catalog with provenance; documents the Epley-derived %1RM model and flags the contested note about divergence from practitioner RPE tables.

New test `test/intensityModule.test.js` — 32 unit tests covering all exported functions, boundary conditions, roundtrip correctness, and error cases.

**No runtime consumer yet. No Sheets access, no side effects, no write-path or trust-loop change.**

---

### Added — Exercise ontology expansion: 4 → 52 exercises (PR 2)

Expanded `config/coaching/exercises/` from the 4 seed exercises to a full 52-exercise ontology covering all 12 movement patterns. Each entry carries `id`, `name`, `movement_pattern`, `implement`, `laterality`, `loading_axis`, `primary_muscles`, `provenance`, plus rich optional fields (`secondary_muscles`, `stabilizers`, `systemic_fatigue`, `local_fatigue`, `joint_stress`, `technical_complexity`, `stimulus_to_fatigue`, `progressions`, `regressions`, `common_faults`, `substitutions`, `contraindications`, `resistance_profile`).

**48 new exercise files:**

*Squat (6):* `front-squat`, `goblet-squat`, `leg-press`, `hack-squat`, `box-squat`, `belt-squat`
*Hinge (6):* `romanian-deadlift`, `sumo-deadlift`, `trap-bar-deadlift`, `hip-thrust`, `good-morning`, `kettlebell-swing`
*Lunge (5):* `bulgarian-split-squat`, `walking-lunge`, `reverse-lunge`, `step-up`, `lateral-lunge`
*Horizontal Push (5):* `dumbbell-bench-press`, `incline-bench-press`, `push-up`, `dip`, `cable-chest-fly`
*Vertical Push (4):* `overhead-press`, `seated-dumbbell-shoulder-press`, `push-press`, `lateral-raise`
*Horizontal Pull (5):* `barbell-row`, `dumbbell-row`, `cable-row`, `face-pull`, `inverted-row`
*Vertical Pull (3):* `lat-pulldown`, `chin-up`, `cable-pull-over`
*Carry (2):* `farmers-carry`, `suitcase-carry`
*Anti-rotation (2):* `pallof-press`, `plank`
*Rotation (1):* `cable-woodchop`
*Isolation (9):* `bicep-curl`, `hammer-curl`, `tricep-pushdown`, `skull-crusher`, `leg-curl`, `leg-extension`, `calf-raise`, `rear-delt-fly`, `preacher-curl`

**`config/coaching/exercises/_index.json`** — updated to 52 entries, `_meta.status` set to `"active"`.

**`test/coachingIntelligence.test.js`** — expanded `EXERCISE_IDS` to all 52 exercises; added 9th test (`exercise _index.json: every indexed id has a corresponding file`) for bidirectional index/file integrity. All 9 tests pass.

**Static data + docs only. No module consumes any config. No behavior, no LLM wiring, no Sheets/user-data access.**

Dangling `substitutions`/`progressions`/`regressions` refs resolved for: `front-squat`, `belt-squat`, `leg-press`, `romanian-deadlift`, `trap-bar-deadlift`, `lat-pulldown`. One remaining dangling ref in `bench-press.json` (`machine-chest-press`) — filed in BACKLOG.

---

### Added — Coach Intelligence Layer scaffold (PR 1)

Added `docs/research/coaching-intelligence/` and `config/coaching/` trees:

**`docs/research/coaching-intelligence/`**
- `README.md` — layer overview and prime directive
- `source-archive/README.md` — immutable source record instructions
- `source-archive/MANIFEST.json` — four-document registry with canonical IDs, titles, topics, and placeholder checksums (PDFs to be placed by Dale before merge)
- `digest/coaching-knowledge-map.md` — eleven-domain disposition table and per-domain summaries (A–K)
- `digest/open-debates.md` — seven contested areas with Atlas's explicit stance on each
- `digest/glossary.md` — plain-language definitions for 19 coaching terms

**`config/coaching/`**
- `README.md` — machine-config layer overview
- `evidence-tiers.json` — five-tier knowledge trustworthiness ranking
- `schemas/provenance.schema.json` — shared provenance block (JSON Schema draft 2020-12)
- `schemas/exercise.schema.json` — exercise ontology entry shape
- `schemas/progression-rule.schema.json` — shape of progression.rules.json
- `schemas/fatigue-rule.schema.json` — shape of fatigue.rules.json
- `schemas/safety-rule.schema.json` — shape of safety.rules.json
- `exercises/_index.json` — exercise registry (4 seeded)
- `exercises/back-squat.json`
- `exercises/conventional-deadlift.json`
- `exercises/bench-press.json`
- `exercises/pull-up.json`
- `movement-patterns/patterns.json` — 12-pattern taxonomy
- `rules/_CONVENTIONS.md` — rules-file conventions
- `rules/progression.rules.json` — six-scenario decision table, lever order, increment defaults
- `rules/fatigue.rules.json` — recovery priors, readiness inputs, deload triggers
- `rules/safety.rules.json` — traffic-light classifier, red-flag list, safe defaults

**`test/coachingIntelligence.test.js`** — 8 structural validation tests (required fields, enum values, provenance shape, index integrity, rule _meta); no coaching logic.

**Static data + docs only. No module consumes any config. No behavior, no LLM wiring, no Sheets/user-data access.**

Contested entries flagged by design: `conventional-deadlift.json` (`contested: true` — deadlift systemic-fatigue heuristic), `fatigue.rules.json` recovery priors (`contested: true`) and deload triggers (`contested: true`).
