# Changelog

## [Unreleased]

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
