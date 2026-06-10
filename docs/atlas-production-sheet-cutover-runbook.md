# Atlas Production Sheet Cutover Runbook

## Current State

- The cleaned Google Sheet is live in production through Render `GOOGLE_SHEETS_ID`.
- The cleaned sheet intentionally does not include `Dashboard`.
- `Dashboard` is optional and must not be required by backend health checks.
- The previous production sheet should remain available as a rollback backup for now.

## Required Tabs

Atlas requires these tabs:

- `Metadata`
- `Log_Cleaned`
- `Exercise_Catalog`
- `Effort`
- `Logic`
- `Session_Summary`

Optional tabs:

- `Dashboard`
- `Bodyweight`, only when bodyweight endpoints are used

## Mission Control Smoke Tests

Use the GitHub Actions workflow named `CI`, job `Render smoke test (Mission Control)`.

Recommended post-cutover checks:

1. Run `smoke_mode=read-only`, `expected_sheet_label=current`.
2. Run `smoke_mode=read-only`, `expected_sheet_label=cleaned`.
3. Run `smoke_mode=full`, `expected_sheet_label=cleaned`.

`full` mode must only use `test_mode=true` for workout ingestion. It must not perform a real production write.

## Running From iPhone

1. Open the GitHub repository.
2. Go to **Actions**.
3. Select the `CI` workflow.
4. Tap **Run workflow**.
5. Choose the smoke mode and sheet label.
6. Keep `require_no_dashboard=true`.
7. Start the run and read the step summary.

## Green Means

- Public endpoints respond.
- Protected read-only endpoints respond.
- `GET /api/health/sheets` reports no missing required tabs.
- `Dashboard` is not required.
- Catalog, recent history, session, lift, PR, and recommendation checks pass.
- `complete-workout` dry-run returns `test_mode=true`, `sheet_written=false`, and `no_write_confirmed=true`.
- The no-mutation check does not find the dry-run session in recent history.

## If Mission Control Fails

1. Do not run a real write.
2. Read the failing endpoint and error message.
3. If the failure happened after cutover and affects core reads, rollback.
4. If only a non-critical optional check failed, inspect before rollback.
5. Re-run `read-only` mode after any fix or rollback.

## Rollback

1. Open the Render service for Atlas.
2. Restore the previous `GOOGLE_SHEETS_ID` from Render environment history or your private backup notes.
3. Do not paste the old sheet ID into public docs, issues, PRs, or logs.
4. Redeploy the service if Render does not auto-redeploy after the environment variable change.
5. Run Mission Control with `smoke_mode=read-only`, `expected_sheet_label=current`.

Rollback triggers:

- `GET /api/health/sheets` fails or reports missing core tabs.
- `GET /api/history/recent` fails.
- Catalog endpoints fail or key exercises cannot be enriched.
- `complete-workout` dry-run fails.
- Schema mismatch appears in core tabs.
- Dry-run response reports `sheet_written=true`.
- Authentication fails unexpectedly after deploy.

## Real Write Policy

Do not perform a real write unless explicitly approved.

The first approved real write should be either:

- one tiny fake/test workout with a unique test session ID, or
- the next actual workout, if the owner prefers not to add test rows.

After the first real write:

1. Verify the row appears in `Log_Cleaned`.
2. Verify the effort row appears in `Effort`.
3. Verify duplicate protection rejects the same session.
4. Verify `Session_Summary` or backend session summary reflects the session.
5. Mark test data clearly if cleanup is not supported.

## Never Commit

- `.env`
- API keys
- Google credentials
- screenshots
- `.xlsx` exports
- private workout data
