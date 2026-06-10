# Mission Control

Mission Control is the GitHub Actions smoke test for Atlas production.

## What It Checks

- Public endpoints: `/health`, `/version`, `/routes`
- Sheet contract: required tabs exist and Dashboard is not required
- Read-only API paths: history, session lookup, catalog, volume, PRs, pending exercises
- Lift checks for known lift codes
- Optional dry-run: `POST /api/complete-workout` with `test_mode=true`
- No-mutation proof: dry-run session must not appear in recent history

## Safe Modes

- `basic`: public endpoints only
- `contract`: public endpoints plus sheet contract
- `read-only`: contract plus read-only production APIs
- `dry-run-only`: contract plus complete-workout dry-run
- `full`: read-only checks plus dry-run and no-mutation check
- `post-switch`: full validation after a sheet cutover

## Dry-Run Safety Contract

Mission Control only treats a dry-run as safe when the response proves:

```json
{
  "test_mode": true,
  "sheet_written": false,
  "no_write_confirmed": true
}
```

`would_write:true` is useful, but it is not proof of no-write safety.

## First Real Write Planning

Run Mission Control `full` with sheet label `cleaned` before and after first real write planning. Until the owner gives explicit approval, `test_mode=true` and no-write proof remain required.

## iPhone Run Steps

1. Open GitHub.
2. Open `tc5v5s64ym-sketch/atlas-workout-updater`.
3. Open Actions.
4. Select the CI workflow.
5. Tap Run workflow.
6. Select branch `main`.
7. Choose the smoke mode.
8. Run and open the Summary tab.

## Failure Rules

Rollback or pause if:

- `/api/health/sheets` fails.
- A required tab is missing.
- Dashboard appears as required.
- Dry-run reports `sheet_written:true`.
- Dry-run does not report `no_write_confirmed:true`.
- A dry-run session appears in recent history.
- Auth fails unexpectedly.
