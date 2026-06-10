# Atlas Secret Rotation Runbook

## Purpose

`.env` was previously tracked by Git. PR #30 prevents future tracking by removing `.env` from the index, preserving the local file, adding `.env.example`, and expanding ignore rules for local secret files.

This does not rotate secrets. This does not remove secrets from Git history. Manual rotation is required before considering the issue fully remediated.

## Golden Rule

Never paste secrets into:

- ChatGPT.
- Codex.
- Claude.
- Grok.
- GitHub comments.
- Docs.
- Logs.
- Screenshots.
- Commits.

## Rotation Order

### 1. `ATLAS_API_KEY`

Owner steps:

1. Generate a new strong random API key outside the repo.
2. Update Render environment variable `ATLAS_API_KEY`.
3. Update GitHub Actions repository secret `ATLAS_API_KEY`.
4. Redeploy or restart Render if needed.
5. Run Mission Control `read-only` against the cleaned sheet.
6. Run Mission Control `full` against the cleaned sheet.
7. Confirm dry-run proof:
   - `test_mode=true`
   - `sheet_written=false`
   - `no_write_confirmed=true`
8. Confirm the no-mutation check passed.
9. Revoke or retire the old key if applicable.

### 2. OpenAI API Key

Owner steps:

1. Create a new OpenAI API key.
2. Update the Render environment variable for the OpenAI key.
3. Revoke the old key.
4. Verify `GET /api/health/openai` if available.
5. Run a Mission Control mode that covers production health.
6. Confirm no key appears in logs.

### 3. Google Service Account Credentials

Owner steps:

1. Create a new service account key or safer credential setup.
2. Update Render credential environment variables.
3. Confirm the service account still has access to the cleaned production sheet.
4. Revoke or delete the old key.
5. Run `GET /api/health/sheets`.
6. Run Mission Control `read-only` with sheet label `cleaned`.
7. Run Mission Control `full` with sheet label `cleaned`.

### 4. `GOOGLE_SHEETS_ID`

Do not rotate this casually.

- The current cleaned sheet remains production.
- Only change this with an explicit cutover or rollback plan.
- Never change it as part of normal secret rotation unless the owner explicitly approves a sheet cutover.

### 5. GitHub Actions Secrets

Owner steps:

1. Confirm `ATLAS_BASE_URL` still points to the Render production URL.
2. Update `ATLAS_API_KEY` after API key rotation.
3. Do not print secret values in workflow logs.
4. Re-run Mission Control.

## Verification Checklist

- `/health` passes.
- `/version` passes.
- `/routes` passes.
- `/api/health/sheets` passes.
- Mission Control `read-only` with sheet label `cleaned` passes.
- Mission Control `full` with sheet label `cleaned` passes.
- Dry-run proof confirms:
  - `test_mode=true`
  - `sheet_written=false`
  - `no_write_confirmed=true`
- Dry-run session stays absent from history.
- No real Google Sheets write happened.
- Dashboard remains optional.
- No secrets appear in logs.

## Rollback Guidance

- If a new secret fails and the old secret is not compromised or revoked, temporarily restore the old value.
- If the old secret is compromised, do not restore it.
- Stop and diagnose before making repeated changes.
- Do not perform random repeated secret changes.
- Keep Mission Control as the gate.

## Git History Cleanup Warning

- Do not rewrite history until after rotation.
- History cleanup is optional after rotation because rotated secrets should no longer be useful.
- If history cleanup is desired, use a separate explicit owner-approved plan.
- History cleanup can disrupt branches, PRs, clones, Render deploys, and collaborators.

## Phase Completion Criteria

Secret hygiene phase is complete when:

- PR #29 is merged.
- PR #30 is merged.
- Secret rotation runbook is merged.
- Owner rotates or revokes exposed secrets manually.
- Mission Control `read-only` with sheet label `cleaned` passes.
- Mission Control `full` with sheet label `cleaned` passes.
- `.env` is no longer tracked.
- `.env.example` contains placeholders only.
- No new secrets appear in changed files.
- No Git history cleanup is pending unless the owner explicitly wants it.
