# Atlas Backup and Rollback Plan

## Purpose

This document defines how to protect Atlas before the first real production write. It gives the owner a clear backup path, rollback path, and decision tree before any non-test-mode write reaches the cleaned production Google Sheet.

## Current Production Baseline

- Production backend: Render.
- Production branch: `main`.
- Verified commit/version: `202b3ac`.
- Production sheet label: `cleaned`.
- Dashboard: optional and absent.
- Mission Control `full` with sheet label `cleaned` passed.
- No-write proof passed:
  - `test_mode=true`
  - `sheet_written=false`
  - `no_write_confirmed=true`
- No-mutation check passed.
- Rollback recommended: `NO`.

## What Must Be Backed Up

- Cleaned production Google Sheet.
- Old rollback Google Sheet.
- Render environment variable state.
- GitHub `main` commit/version.
- GitHub Actions Mission Control run result.
- Current sheet contract:
  - `Metadata`
  - `Log_Cleaned`
  - `Exercise_Catalog`
  - `Effort`
  - `Logic`
  - `Session_Summary`

## Manual Backup Steps

Owner steps:

1. Open the cleaned production Google Sheet.
2. Make a copy named something like `Atlas_Master_Log_Cleaned_BACKUP_YYYY-MM-DD_before_first_write`.
3. Confirm the backup copy has the required tabs:
   - `Metadata`
   - `Log_Cleaned`
   - `Exercise_Catalog`
   - `Effort`
   - `Logic`
   - `Session_Summary`
4. Do not use the backup as production unless rollback is needed.
5. Record the current production sheet ID privately, not in public docs if sensitive.
6. Confirm the old sheet remains available as a rollback reference.

## Render Rollback Steps

1. Go to the Render service.
2. Confirm the current deploy is healthy.
3. If rollback is needed, either:
   - Roll back to the previous deploy if a code deploy failed.
   - Restore the previous `GOOGLE_SHEETS_ID` only if a sheet cutover broke.
4. Save and deploy after any environment rollback.
5. Run Mission Control `read-only`.
6. Run Mission Control `full`.
7. Do not keep changing environment variables randomly.

## Google Sheet Rollback Steps

If bad test data is written:

- Identify the exact session ID.
- Decide whether to leave a clearly marked test row, remove it manually, or copy from backup.

If sheet formulas break:

- Compare against the backup.
- Restore formulas or ranges manually.

If the wrong sheet receives writes:

- Stop writes.
- Verify `GOOGLE_SHEETS_ID`.
- Run read-only Mission Control.

Do not delete data until a backup exists.

## First Real Write Rollback Strategy

- Use a unique session ID.
- Use either a tiny smoke write or the next actual workout.
- Mark notes clearly if using a smoke write.
- Verify:
  - `Log_Cleaned` row.
  - `Effort` row, if applicable.
  - `Session_Summary`.
  - `/api/history/recent`.
  - `/api/session/:sessionId`.

If failure occurs:

1. Stop.
2. Do not repeat writes.
3. Inspect the exact rows.
4. Restore or correct manually from backup if needed.

## Rollback Decision Tree

- API auth failure: check `ATLAS_API_KEY`.
- OpenAI failure: check the OpenAI key.
- Sheets health failure: check Google credentials and sheet sharing.
- Sheet contract failure: check tabs and headers.
- Dry-run writes unexpectedly: stop immediately.
- Real write creates a bad row: isolate the session ID and restore manually.

## Do Not Do

- Do not change `GOOGLE_SHEETS_ID` casually.
- Do not restore Dashboard as required.
- Do not perform blind repeated writes.
- Do not rewrite Git history during rollback.
- Do not paste secrets into chat, docs, logs, or PRs.
- Do not merge rollback changes without owner approval.

## Completion Criteria

Backup and rollback phase is complete when:

- Backup sheet copy exists.
- Mission Control `full` with sheet label `cleaned` passed after backup.
- Current Render deploy is known.
- Current GitHub commit/version is known.
- Owner understands the rollback path.
- First real write plan is ready but not executed.
