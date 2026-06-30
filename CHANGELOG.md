# Changelog

## [Unreleased]

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
