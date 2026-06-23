# Exercise Knowledge Base — Migration / Wiring Plan

Status: **reference-only.** This PR ships the catalog, alias table, schema/validator,
resolver, and tests. It does **not** wire the KB into the live write/coaching path.
Per the owner spec: *do not wire into live coaching until alias tests pass.* They now
pass — wiring is the next, separate, gated step below.

## What exists today (do NOT clobber)

Recognition is currently spread across three places. The new KB is additive and must
not overwrite any of them without explicit migration:

1. **`services/exerciseEnrichment.js`** — `normalizeExerciseKey` + `knownLiftCodeOverrides`
   (alias → `lift_code`, e.g. `bench → BEN01`) + `generateLiftCode`. The Sheets
   `Exercise_Catalog` tab is the **source of truth for `lift_code`**; enrichment fills blanks.
2. **`services/workoutTextParser.js`** — its own internal exercise alias map (parser grammar,
   owner-gated).
3. **`services/movementPattern.js` / `muscleCoverage.js` / `liftRole.js`** — engine
   vocabularies that downstream coaching/substitution/fatigue logic already uses.

## `exercise_id` vs `lift_code`

They are **different namespaces and must stay separate**:

| | `exercise_id` (new KB) | `lift_code` (Sheets/enrichment) |
|---|---|---|
| form | `barbell_bench_press` | `BEN01` |
| owner | this KB | `Exercise_Catalog` tab |
| role | recognition / resolution | the 12-col `Log_Cleaned` write contract |

The KB **never** reads or writes `lift_code`. A future wiring PR adds an explicit
`exercise_id ↔ lift_code` crosswalk (see step 3) rather than conflating them.

## Two taxonomy reconciliations baked into the seed

1. **Muscles** are already aligned to `muscleCoverage.js` (the 17-muscle taxonomy), so the
   KB feeds the existing muscle engine directly — no second vocabulary.
2. **`movement_pattern` uses the owner's generic enum** (`squat, hinge, lunge,
   horizontal_push/pull, vertical_push/pull, carry, rotation, anti_rotation, flexion,
   extension, locomotion, conditioning`). This is **NOT** the engine's
   `movementPattern.VALID_PATTERNS` (`knee_isolation, hip_isolation, arm_isolation,
   delt_isolation, calf_isolation, trunk, other …`). A wiring PR must add a KB→engine
   pattern map. Proposed mapping:

   | KB pattern | engine pattern |
   |---|---|
   | squat | squat |
   | hinge | hinge |
   | lunge | squat (no lunge slot in engine; closest) |
   | horizontal_push / vertical_push | horizontal_push / vertical_push |
   | horizontal_pull / vertical_pull | horizontal_pull / vertical_pull |
   | carry | carry |
   | flexion (curls/leg curl) | arm_isolation / knee_isolation (by muscle) |
   | extension (triceps/leg ext/calf) | arm_isolation / knee_isolation / calf_isolation |
   | rotation / anti_rotation / (core flexion) | trunk |
   | locomotion / conditioning | other |

   **Known enum gap (recommend to owner):** the generic enum has no `abduction/adduction`
   or `anti_extension` slot, so lateral/front raises and planks are mapped to the
   least-wrong bucket (`flexion` / `anti_rotation`). If precise isolation patterns matter
   for coaching, extend the enum or resolve isolation pattern from `substitution_group` +
   `primary_muscles` instead.

## Wiring steps (each its own small, gated PR — not in this PR)

1. **Shadow-resolve (read-only).** In the conversational log path, after the parser
   produces a name, also call `resolveExercise(name)` and log (telemetry only) whether it
   resolved, the id, and confidence. No behavior change. Confirms real-log coverage before
   anything depends on it.
2. **Clarify on low confidence.** When `resolveExercise` returns `confident:false` or
   `null` for a logged lift, the coach asks "which lift?" instead of guessing — still no
   write/schema change.
3. **`exercise_id ↔ lift_code` crosswalk.** Add a mapping (catalog field or a side table)
   so a resolved `exercise_id` yields the canonical `lift_code`. Reconcile with
   `knownLiftCodeOverrides` and the `Exercise_Catalog` tab; **owner-approved** since it
   touches the write contract's identity. **Reconcile normalization here:** the KB's
   `normalizeExerciseText` deliberately folds hyphens/underscores and trims, whereas
   `exerciseEnrichment.normalizeExerciseKey` does not — so hyphenated names (`bent-over
   row`, `t-bar row`) normalize differently across the two layers. Align them (or map
   explicitly) before comparing normalized forms at the crosswalk.
4. **Feed coaching identity.** Route `movement_pattern` / muscles / `exercise_type` from the
   KB into the substitution/fatigue/role engines via the maps above, replacing the regex
   heuristics in `movementPattern.js` / `liftRole.js` incrementally (behind tests).

## Safety invariants (unchanged by this PR)

- No write-path change. No Sheet schema change. No parser-grammar change. No trust-loop
  change. Conversational logging stays `test_mode` dry-run; real writes stay
  preview→approve→write.
- The KB is hand-editable JSON validated by `test/exerciseResolver.test.js`. Adding an
  exercise = add a catalog record + ≥1 alias; the test fails on any enum/dedup/coverage
  violation.

## Wiring-time hardening notes

- **Canonical names win over aliases (enforced).** A record's own name always resolves to
  itself: `exerciseResolver` registers canonical names *before* aliases, `validateKb`
  rejects any alias that normalizes to a *different* exercise's canonical name, and the
  build folds equipment-qualified duplicates (e.g. `barbell_back_squat`→`back_squat`,
  `machine_chest_fly`→`pec_deck`, the cable-fly family→`cable_fly`) so no two canonicals
  describe the same lift. Regression-tested ("every canonical name resolves to its own
  record").
- **Same-id alias confidence on collision.** `validateKb` rejects a normalized alias that
  maps to *two different* `exercise_id`s, and the build step dedups aliases by normalized
  form, so the committed data has no normalized collisions. But `exerciseResolver.register()`
  is *first-registration-wins*: if a future hand-edit introduces two aliases for the **same**
  `exercise_id` that normalize identically with different `confidence`, the first-listed one
  silently wins. Harmless reference-only today; before step 2 (clarify-on-low-confidence)
  depends on confidence, add a "keep the higher confidence" guard in `register()` (and a
  validator warning for same-id normalized duplicates).
