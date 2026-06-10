# Release Checklist

## Before Merge

- Unit tests pass.
- Syntax/lint checks pass.
- PR contains no `.env`, spreadsheets, screenshots, Google credentials, API keys, or private workout data.
- Dashboard remains optional.
- No real write was performed.
- No Render environment variable was changed.

## Before Production Change

- Current production sheet smoke is green.
- Candidate cleaned sheet read-only smoke is green.
- Candidate cleaned sheet dry-run is green.
- No-mutation check is green.
- Old sheet ID is saved privately for rollback.

## After Deploy

Run Mission Control:

1. `smoke_mode=read-only`, `expected_sheet_label=cleaned`
2. `smoke_mode=full`, `expected_sheet_label=cleaned`

Go only if:

- Required tabs exist.
- Dashboard is optional.
- Catalog loads.
- Recent history loads.
- A real session and summary load.
- Dry-run proves no write.
- Dry-run session does not appear in history.

## Real Write Policy

Do not run a real post-cutover write until explicitly approved. The first real write should be one tiny test session with a unique session ID and a cleanup or clear marking plan.
