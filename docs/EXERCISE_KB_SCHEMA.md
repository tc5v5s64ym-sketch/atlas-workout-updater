# Exercise Knowledge Base — Schema Proposal

Status: **proposed / reference-only (not wired into the live path).** Seed shipped as
data files; wiring is gated on the alias tests passing (see `EXERCISE_KB_WIRING.md`).

## Why two tables

Recognition accuracy matters more than raw exercise count. A user types many surface
forms for one lift (`bb row`, `barbell row`, `bent over row`, `BOR`). All must resolve
to **one** canonical id *before* coaching / progression / substitution / fatigue logic
runs. So the KB is two structures, not one:

1. **`data/exercise_catalog.v1.json`** — one canonical record per exercise.
2. **`data/exercise_aliases.v1.json`** — many aliases → one `exercise_id`.

Pipeline (implemented in `services/exerciseResolver.js`):

```
raw user text → normalize → strip set-notation tail → alias lookup → canonical exercise_id
```

Coaching logic never branches on a raw string.

## Canonical record schema

```jsonc
{
  "exercise_id": "lower_snake_case_unique",   // NEW recognition id, distinct from lift_code
  "name": "Human Readable Name",
  "category": "barbell | dumbbell | machine | cable | bodyweight | cardio | core | olympic | strongman | kettlebell | band | rehab | mobility | accessory",
  "exercise_type": "main_lift | accessory | isolation | bodyweight | conditioning | olympic | strongman | rehabilitation | mobility",
  "movement_pattern": "squat | hinge | lunge | horizontal_push | horizontal_pull | vertical_push | vertical_pull | carry | rotation | anti_rotation | flexion | extension | locomotion | conditioning",
  "primary_muscles": ["…"],   // from the 17-muscle taxonomy below ([] for pure cardio/mobility)
  "secondary_muscles": ["…"],
  "equipment": ["…"],          // ≥1 from the equipment vocab
  "difficulty": "beginner | intermediate | advanced",
  "fatigue_score": 1,          // int 1-10, systemic fatigue
  "skill_score": 1,            // int 1-10, technical complexity
  "substitution_group": "lower_snake_case",
  "is_unilateral": false,
  "is_bodyweight": false,
  "is_machine": false,
  "atlas_tags": ["compound", "hypertrophy", …]
}
```

## Alias record schema

```jsonc
{ "alias": "lowercase text", "exercise_id": "<catalog id>", "alias_type": "…", "confidence": 1.0 }
```

`alias_type` ∈ `common_name | abbreviation | misspelling | pluralization |
commercial_gym_name | bodybuilding_name | crossfit_name | british_name | shorthand |
equipment_variant`. `confidence` ∈ (0, 1].

## Controlled vocabularies (enforced by `services/exerciseKbSchema.js`)

- **Muscle taxonomy (17)** — aligned 1:1 with `services/muscleCoverage.js` so the KB is
  engine-usable without a second muscle vocabulary: `chest, front_delts, side_delts,
  rear_delts, traps, lats, upper_back, lower_back, biceps, triceps, forearms, quads,
  hamstrings, glutes, calves, abs, obliques`.
- **Equipment vocab** — `barbell, dumbbell, machine, cable, bodyweight, kettlebell, band,
  smith_machine, ez_bar, trap_bar, sled, medicine_ball, sandbag, plate, bench, box, rings,
  trx, treadmill, bike, rower, elliptical, jump_rope, stairmaster, ski_erg, none`.

## Validation rules (`validateKb`)

A KB is valid only when **all** hold:

- every catalog field present; every enum value in range; muscles ⊆ taxonomy; equipment
  ⊆ vocab and non-empty; `fatigue_score`/`skill_score` integers 1–10; booleans are booleans.
- `exercise_id` is lower snake_case and **unique** (no two ids for one lift).
- every alias points at a real `exercise_id`; `alias_type`/`confidence` valid; alias is
  lowercase.
- **no alias ambiguity**: a normalized alias may map to only ONE `exercise_id` (a clash is
  a hard error, never a silent guess).
- every catalog entry is reachable by ≥1 alias.

## Ambiguity policy

- A bare movement-class word (`press`, `row`, `curl`, `fly`, `raise`, `extension`) carries
  **no** alias → the resolver returns `null` and the caller must ask which lift.
- A shorthand that is *usually* one lift (`pulldown`→lat pulldown, `pushdown`→triceps
  pushdown) maps to the commonest meaning at **confidence < threshold**, returned with
  `confident:false` so the caller can confirm.

## Resolver contract (`services/exerciseResolver.js`)

`resolveExercise(text, { threshold = 0.8 })` → `null` | `{ exercise_id, name, confidence,
alias_type, confident, matched_alias, record }`. Pure, read-only; loads the JSON at
require time; never touches Sheets, the parser, or the write path.
