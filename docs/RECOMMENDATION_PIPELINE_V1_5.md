# Recommendation Pipeline v1.5 — constraints, endurance, autoregulation

Builds on the v1 deterministic rulebook (`services/trainingKnowledge.js`,
`services/trainingGoalClassifier.js`, `services/recommendationPolicy.js`). Same law: **the rule
engine owns the numbers; the LLM only explains them; cold start never invents a weight.**

## 1. `muscular_endurance` goal

A first-class training goal, distinct from `conditioning_fat_loss`:

- higher reps (preferred **15–25**, allowed 12–30),
- shorter rest (target **30–60s**),
- density-first progression (`['density', 'reps', 'sets', 'load']`),
- reason codes: `goal_muscular_endurance`, `high_rep_bias`, `endurance_density_bias`,
  and on progression `endurance_density_progress`.

Classifier nuance: resistance-specific phrases (`muscular endurance`, `high reps`, `endurance reps`)
map directly. Bare `endurance` / `stamina` only map to `muscular_endurance` when the text carries a
lifting/resistance signal **and** is not an obvious cardio/running question — so "running endurance"
is **not** misread as muscular endurance.

## 2. Optional pass-through constraints

`recommendExercisePrescription({ ..., constraints })` accepts, all optional:
`sessionMinutes`, `equipmentTier`, `painFlags`, `injuryConstraints`, `trainingDaysPerWeek`,
`experienceLevel`. They nudge an already-computed prescription when present and are inert when
absent. **This is not a profile system** — no persistence, no schema. Implemented in
`services/recommendationConstraints.js`:

- `painFlags` / `injuryConstraints` → never push load into pain (a load increase becomes `maintain`); flag `respect_pain_or_injury`, reason `constraint_pain_no_load_increase`.
- short `sessionMinutes` (≤30) → trim one set (min 1); reason `constraint_time_capped_volume`.
- limited `equipmentTier`, low `trainingDaysPerWeek`, beginner `experienceLevel` → add a reason code so downstream/UI can adapt.

## 3. Cold-start guidance

No previous weight and no estimated 1RM → `recommendedWeight: undefined`, a `weightGuidance`
string ("Choose a load that lands near your target RIR …"), and `reasonCodes: ["cold_start_no_history"]`.
Rep/set/RIR targets are still real. Atlas never fabricates a number it cannot ground.

## 4. Autoregulation helper (standalone)

`services/autoregulation.js` → `autoregulateNextSet(input)`. Deterministic, pure, **not** wired
into the planned-progression path (planned progression ≠ day-of autoregulation):

- pain ≥ threshold → `regress` (highest priority),
- power + high velocity-loss or grindy reps → `end_set_or_switch_low_fatigue` (never grind),
- actual RIR ≥1 below target → reduce load ~2–5% / drop a back-off set,
- actual RIR ≥1 above target + solid technique → increase load ~2–5% (technique gates load),
- otherwise → `hold`.

## Out of scope (future)

Olympic lifting, MetCon, rehab/mobility, periodization planning, exercise-substitution ontology,
profile schema, endpoints/UI, coach/Gemini wiring, and any Sheets/write/approval/auth changes.
