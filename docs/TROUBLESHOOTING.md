# Troubleshooting

## Missing `ATLAS_BASE_URL`

Add the production Render URL as a GitHub Actions secret or workflow environment value.

## Missing `ATLAS_API_KEY`

Add the API key as a GitHub Actions secret. Never paste it into logs, docs, screenshots, or PR comments.

## 401 or 403

The API key is missing, wrong, or not being sent as `x-atlas-api-key`.

## Missing Tab

Open the Google Sheet and confirm the required tabs from `docs/SHEET_CONTRACT.md`. Dashboard is optional and should not be recreated just for health checks.

## Service Account Permission Denied

Confirm the Google service account still has access to the sheet. Do not expose the service account key.

## Dry-Run Is Unsafe

Pause if any dry-run reports:

- `test_mode` missing or false
- `sheet_written:true`
- `no_write_confirmed` missing or false
- the dry-run session appears in history

## Render Seems Stale

Redeploy the service, then run Mission Control again. Check `/version` and the Render logs if the smoke test still sees old behavior.

## Formula Problems

If `Session_Summary` stops updating, inspect the formulas in the sheet first. The backend reads the summary but does not rebuild those formulas.

## Tracked `.env`

The repository currently has a tracked `.env` file in history. Handle this with a separate secret-rotation and history-cleanup plan. Do not expose its contents in a normal PR diff.
