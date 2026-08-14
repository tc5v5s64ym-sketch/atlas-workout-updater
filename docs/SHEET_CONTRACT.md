# Sheet Contract

Dashboard is optional. Do not restore it just to satisfy Atlas.

## Required Tabs

- `Metadata`
- `Log_Cleaned`
- `Exercise_Catalog`
- `Effort`
- `Logic`
- `Session_Summary`

## `Log_Cleaned` Headers

1. `Date_Clean`
2. `Session ID`
3. `Exercise`
4. `Canonical_Exercise`
5. `Muscle_Group`
6. `Lift Code`
7. `Set #`
8. `Weight`
9. `Reps`
10. `RIR`
11. `Notes`
12. `Volume_Calc`

Extra derived columns after `Volume_Calc` are okay. Do not move or rename the first 12 columns.

## `Effort` Headers

1. `Date`
2. `Session ID`
3. `Duration`
4. `Active Calories`
5. `Total Calories`
6. `Average HR`
7. `Peak HR`
8. `Location`
9. `Notes`

## `Exercise_Catalog` Headers

The active production sheet (`1XQa…`) uses these four columns, in order (verified 2026-06-29 against the live tab):

1. `Canonical_Name`
2. `Muscle_Group`
3. `Lift_Code`
4. `Original_Variants` — comma/semicolon/pipe-separated alias list

`services/exerciseEnrichment.js` (`buildExerciseCatalogMap`) indexes rows by the normalized `Canonical_Name` **and** each `Original_Variants` entry, so a logged lift resolves when its name matches the canonical or any listed variant. The header matcher also accepts the legacy `Exercise` / `Canonical_Exercise` / `Lift Code` spellings, but the live sheet is `Canonical_Name | Muscle_Group | Lift_Code | Original_Variants`.

A good row:

```text
Romanian Deadlift | Posterior Chain | RDL01 | Romanian Deadlift, RDL, RDLs
```

`Muscle_Group` values are granular in the live sheet (e.g. `Chest`, `Biceps`, `Posterior Chain`, `Quads`, `Arms`), not just the coarse fallback set.

The old malformed (column-shifted) row must not return:

```text
Core | HNR01 | 3 | Hanging Knee Raises
```

## `Exercise_Catalog` authority (S4 owner correction, 2026-08-13)

Supabase `atlas.exercise_catalog` is the sole live authority for catalog lookup, enrichment, recommendations, substitutions, and workout saves. Google Sheets is not an editing source, sync source, fallback, freshness clock, or runtime dependency for this concept.

Owner maintenance uses the narrow Supabase command, which is dry-run by default:

```bash
npm run atlas:catalog -- --file rows.json
npm run atlas:catalog -- --file rows.json --apply
```

Apply mode is explicitly owner-controlled and writes only the Supabase catalog through the migration role. It validates and deduplicates the proposed rows and reads the authoritative rows back. There is no Sheets-to-catalog sync process.

## Safe Manual Edits

- Propose catalog rows in a local JSON file, review the default dry-run, then use `npm run atlas:catalog -- --file rows.json --apply` only with owner authorization.
- Add aliases only if the catalog layout supports them.
- Keep lift codes stable after they are used in logged workouts.

## Do Not Manually Edit

- `Log_Cleaned` headers
- `Effort` headers
- `Session_Summary` formulas
- `Logic` formulas used by summary/reporting
- Stored API keys or tokens in any tab
- `Exercise_Catalog` as a way to change live Atlas behavior; Sheets is no longer its authority

## Formula Ownership

The backend owns ingestion, enrichment, validation, and appends. The sheet owns formula-driven summaries such as `Session_Summary` and derived columns such as `Volume_Calc` when formulas are present.
