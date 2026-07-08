# Exercise Identity Bridge (Migration PR-A)

**Status:** inert data only — zero runtime behaviour change.
**Consumes:** nothing. **Consumed by:** nothing (yet).
**Plan:** `docs/EXERCISE_NAME_UNIFICATION_MIGRATION_PLAN.md` §6 PR-A.

This PR builds the permanent identity bridge that future enrichment-inversion
migrations (plan PR-B onward) will read. It ships two JSON files plus this doc and
a regression test. It **does not** change the parser, enrichment, `Log_Cleaned`,
`Exercise_Catalog`, aliases, analytics, or any display/canonical name. The test
`test/exerciseIdentityBridge.test.js` proves the bridge is inert (no production
module references it) and internally faithful to the current engine.

---

## Why a bridge

Atlas has two exercise-identity worlds that must eventually reconcile:

- **JSON world** (`data/exercise_catalog.v1.json` + `data/exercise_aliases.v1.json`):
  keyed by `exercise_id` (`barbell_bench_press`), with a granular
  `primary_muscles[]` token taxonomy (17 tokens: `chest`, `rear_delts`,
  `hamstrings`, …).
- **Sheet world** (`Log_Cleaned` / `Exercise_Catalog`): keyed by `lift_code`
  (`BEN01`) — the **immutable** grouping key analytics use — with a coarse
  `Muscle_Group` label vocabulary (`Chest`, `Posterior Chain`, `Rear Delts`, …).

Future migrations need a **frozen, hand-verified** map between them so inversion
never has to re-derive identity on the fly (and never silently changes a
`lift_code`, which would fracture every historical analytics join). That map is
this bridge.

---

## 1. Lift-code bridge — `data/lift_code_bridge.v1.json`

`exercise_id → lift_code`. The permanent source of truth for a catalog identity's
sheet code.

- **Codes come from** `services/exerciseEnrichment.js :: knownLiftCodeOverrides`
  (the current, live authority — the bridge does not invent codes).
- **exercise_ids come from** joining each override name to the catalog by
  id/name, else the highest-confidence alias in `exercise_aliases.v1.json`.
- 14 catalog identities across 12 resolved codes are mapped. Every entry records
  `resolved_via`, `min_confidence`, and the `override_names` it claims.

### Known structural facts (recorded in the file)

- **`DIP01` is many-to-one.** Three catalog identities (`dip`, `dips`,
  `weighted_dip`) fold to one code. The sheet does not distinguish bodyweight vs
  weighted dips; inversion must preserve that fold, not split it.
- **`KR01` is low-confidence.** `knee raise` resolves to `hanging_leg_raise` via a
  0.70 shorthand alias. Semantically imperfect (a knee raise is not exactly a
  hanging leg raise); flagged for owner review before inversion trusts it.
- **`BC01` is unresolved** — see blockers below.

---

## 2. Muscle-group bridge — `data/muscle_group_bridge.v1.json`

`primary_muscle token → proposed sheet Muscle_Group label`. **Proposed and
UNCALIBRATED** — this environment has no live-sheet access, so the labels are not
yet reconciled against a real `Muscle_Group` value dump. Nothing consumes it.

Each of the 17 primary-muscle tokens maps to a label, and the file records
`classifies_as` — how `services/analytics.js :: classifyMuscleGroup` buckets that
label **today** (push / pull / hinge / lower / core / null). The two orderings
that matter are honoured:

- `rear_delts → "Rear Delts" → pull` (pull regex precedes push — must not fold
  into "Shoulders", which would classify as push).
- `hamstrings` / `glutes` / `lower_back → "Posterior Chain" → hinge` (sheet
  convention; hinge regex precedes lower).

Flagged **owner-decision** points (all inert until decided):

- Delts: `front_delts` + `side_delts` both → `Shoulders`. Split into
  `Front Delts` / `Side Delts`, or keep coarse?
- `upper_back` and `traps` both → `Back`. Keep coarse, or finer `Upper Back` /
  `Traps`? (Both finer labels still classify pull.)
- `forearms → Arms`, which `classifyMuscleGroup` buckets as **null**. Acceptable
  only if forearms is never a recovery-tracked primary; otherwise remap.

---

## 3. Blockers to future enrichment inversion (documented, NOT solved here)

Per the PR-A brief: identify what would prevent inversion, document it, do not
solve it now.

1. **`BC01` (generic curl) has no single catalog identity.** The catalog splits
   bicep-curl work across `barbell_curl`, `dumbbell_curl`, `cable_curl`,
   `ez_bar_curl`, `machine_biceps_curl`, and ~13 more. The sheet's `BC01` bucket
   is genuinely ambiguous — it cannot be inverted to one `exercise_id` without an
   owner taxonomy decision. Recorded under `unresolved_lift_codes.BC01` with a
   candidate list. **Inversion cannot proceed for `BC01` rows until this is
   resolved.**
2. **`"Calves"` does not classify.** `classifyMuscleGroup("Calves")` returns
   `null` because the `analytics.js` `lower` regex matches the token `calf`, not
   `calves`. An inversion that writes the label `Calves` would drop calf work out
   of the lower/recovery pattern. The fix is a one-token analytics change
   (`calve?s?`), which belongs in a behaviour-changing PR, **not** this data-only
   one. Recorded as `calves.blocker` in the muscle bridge.
3. **Muscle-group labels are uncalibrated.** Final `primary_muscle → Muscle_Group`
   labels need reconciliation against a live `Muscle_Group` value dump plus owner
   decisions on the flagged split points. Until then the muscle bridge is
   proposal-only and must not be consumed.
4. **`KR01` low-confidence identity** (§1) — inversion should confirm the
   `knee raise → hanging_leg_raise` pairing with the owner before trusting it.

These are also filed in `BACKLOG.md`.

---

## Regeneration

The bridge was generated by joining the three live sources, then hand-verified.
Do **not** hand-edit `lift_code` values — they are the immutable identity
contract. To regenerate after a source change, re-run the documented join
(override-name → catalog/alias → `exercise_id`, codes from `knownLiftCodeOverrides`)
and re-verify against `test/exerciseIdentityBridge.test.js`.
