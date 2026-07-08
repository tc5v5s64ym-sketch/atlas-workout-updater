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

## `Exercise_Catalog` source of truth & sync (Remediation PR-15)

The JSON catalog **`data/exercise_catalog.v1.json`** is the declared **source of truth** for the exercise roster; the `Exercise_Catalog` sheet is a **synced view** of it. The JSON carries `name` (canonical), `primary_muscles`, `movement_pattern`, etc. — it does **not** carry `Muscle_Group` (the sheet's granular label) or `Lift_Code`, which remain **sheet-owned** fields the owner maintains.

Reconcile the sheet against the source with the DRY-RUN reconciliation report (reads only, **never writes**):

```bash
node scripts/catalog-maintenance.js --sync-sheet
```

It lists source exercises absent from the sheet (add them, filling `Muscle_Group` + `Lift_Code`) and sheet rows with no source entry (add to the JSON, or retire). Applying the sync is an **owner-run action**: edit `data/exercise_catalog.v1.json` for roster changes, then append genuinely-new rows with `--file <rows.json> --confirm`. No automated process writes the sheet.

> Note: today `services/exerciseEnrichment.js` still resolves canonical/muscle/lift_code from the **sheet** at write time (the JSON lacks lift_code + muscle_group, and flipping canonical to the JSON names would rewrite `Log_Cleaned` history). Inverting enrichment to read the JSON directly is a deferred, history-affecting migration tracked in `BACKLOG.md`.

## Safe Manual Edits

- Add new exercises to `data/exercise_catalog.v1.json` (source of truth), then sync the sheet (see above).
- Add aliases only if the catalog layout supports them.
- Keep lift codes stable after they are used in logged workouts.

## Do Not Manually Edit

- `Log_Cleaned` headers
- `Effort` headers
- `Session_Summary` formulas
- `Logic` formulas used by summary/reporting
- Stored API keys or tokens in any tab

## Formula Ownership

The backend owns ingestion, enrichment, validation, and appends. The sheet owns formula-driven summaries such as `Session_Summary` and derived columns such as `Volume_Calc` when formulas are present.
