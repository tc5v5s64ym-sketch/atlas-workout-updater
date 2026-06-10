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

1. `Exercise`
2. `Muscle_Group`
3. `Lift Code`
4. `Canonical_Exercise`

The good Hanging Knee Raises row is:

```text
Hanging Knee Raises | Core | HNR01 | Hanging Knee Raises
```

The old malformed row must not return:

```text
Core | HNR01 | 3 | Hanging Knee Raises
```

## Safe Manual Edits

- Add new exercises to `Exercise_Catalog`.
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
