# Baseline After Cleaned Sheet Cutover

Baseline commit reviewed: `44c84a0337ac290d46cbdbead20d9f249a000407`

## Bottom Line

Atlas is live on Render with the cleaned dashboard-free Google Sheet. Dashboard is intentionally absent and optional. No real post-cutover write has been performed yet.

## Open PRs At Baseline

- PR #22: post-cutover hardening, draft, overlaps with later no-write and sheet-contract work.
- PR #19: older smoke-test upgrade, superseded by merged Mission Control work and should not be merged without review.

## Recent Merged PRs

- PR #23: foundation audit and hardening.
- PR #21: Mission Control workflow.
- PR #20: expanded Render smoke tests.
- PR #18: dashboard-free cleaned-sheet stabilization.

## Package Scripts

- `start`: runs the backend.
- `dev`: runs the backend.
- `lint`: Node syntax checks for backend/service/smoke files.
- `test`: Node built-in test runner.
- `smoke:render`: Mission Control smoke script.

## Workflows

- `.github/workflows/ci.yml`
  - Pull requests: install, lint, unit tests.
  - Push to `main`: unit checks plus Render smoke job.
  - Manual dispatch: Mission Control modes.

## Endpoint Inventory

Public:

- `GET /`
- `GET /health`
- `GET /routes`
- `GET /version`

Protected read-only:

- `GET /api/health/sheets`
- `GET /api/health/openai`
- `GET /api/history/recent`
- `GET /api/session/:sessionId`
- `GET /api/session/:sessionId/summary`
- `GET /api/exercises/:liftCode`
- `GET /api/exercises/:liftCode/progress`
- `GET /api/recommend/next/:liftCode`
- `GET /api/volume/muscle-groups`
- `GET /api/search/sessions`
- `GET /api/prs/recent`
- `GET /api/catalog/search`
- `GET /api/pending-exercises`
- `GET /api/bodyweight/history`
- `GET /api/debug/config`
- `GET /api/debug/exercise-match`
- `GET /api/schema/log`
- `GET /api/schema/effort`
- `GET /api/schema/complete-workout`

Protected write-capable:

- `POST /api/log-workout`
- `POST /api/parse-workout-image`
- `POST /api/complete-workout`
- `POST /api/bodyweight`
- `POST /api/admin/preview-test-rows` is intended as read-only preview behavior.

## Current Test Inventory

- Sheet contract tests.
- Column contract tests.
- Exercise normalization/catalog/enrichment tests.
- Duration normalization tests.
- Mission Control no-write parser tests.
- Recommendation helper test.

## Known Risks

- `.env` is tracked in Git history. Handle with a separate secret-rotation/history-cleanup plan.
- `sheets.js` logs the spreadsheet ID and append response metadata. Redact in a future observability PR.
- No rate limiter is present.
- Endpoint-level no-append tests need server modularization before they can be added safely.
- Debug/admin endpoints are protected but should remain reviewed.

## Smoke Script Restoration Check

`scripts/smoke-test-render.js` is restored and contains strict no-write logic. It does not rely on `would_write` as no-write proof. It requires `test_mode=true` plus explicit no-write fields.
