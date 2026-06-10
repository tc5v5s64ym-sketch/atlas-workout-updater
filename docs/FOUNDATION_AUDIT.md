# Atlas Foundation Audit

Last reviewed from `main` commit `98a62fe468c26f0e01b28f6def4c902f73d3b882`.

## Current Inventory

- Runtime entrypoint: `index.js`
- Google Sheets integration: `sheets.js`
- API auth/request context: `middleware.js`
- Response helper: `response.js`
- Sheet contract: `config/sheetContract.js`
- Column contract: `config/columns.js`
- Route inventory: `config/routes.js`
- Core services: `services/analytics.js`, `services/cache.js`, `services/duration.js`, `services/exerciseEnrichment.js`, `services/validation.js`, `services/vision.js`
- Smoke test: `scripts/smoke-test-render.js`
- Tests: `test/unit.test.js`
- CI workflow: `.github/workflows/ci.yml`

## Production Assumptions

- Render owns production environment variables.
- `GOOGLE_SHEETS_ID` points at the live Atlas sheet.
- Dashboard is intentionally absent and optional.
- Required tabs are `Metadata`, `Log_Cleaned`, `Exercise_Catalog`, `Effort`, `Logic`, and `Session_Summary`.
- Real writes must only happen through write endpoints when `test_mode` is false or absent.
- Mission Control dry-runs must prove `test_mode=true`, `sheet_written=false`, and `no_write_confirmed=true`.

## Production Safety Findings

Critical:

- `.env` is tracked in Git history. Do not print it, copy it, or open it in logs. Treat this as a repository hygiene issue requiring a separate secret-rotation/history-cleanup plan. A normal PR deletion can expose removed lines in the PR diff, so do not casually delete it in a visible PR.

Medium:

- `sheets.js` logs the spreadsheet ID and append API response metadata. This is useful for debugging but should be reduced or redacted in a future observability PR.
- There is no rate limiter. API key auth protects `/api/*`, but abuse control should be documented or added later.
- Some debug/admin endpoints are protected, but they should stay reviewed because they are powerful diagnostic surfaces.
- API response shapes are mostly standardized, but some older endpoints still return endpoint-specific data layouts.

Low:

- Several docs and local artifacts mention placeholder key names. That is expected, but docs should keep using placeholders only.
- Mission Control output had some garbled symbols in local terminal rendering; this PR keeps future docs ASCII-safe.

No action needed:

- Public endpoints are limited to `/`, `/health`, `/version`, and `/routes`.
- `/api/*` is protected by `x-atlas-api-key`.
- Dashboard is optional in the central contract.
- Multipart uploads have a file size limit.
- `complete-workout` supports no-image dry-runs with manual effort fields.

## Suggested PR Sequence

1. Foundation audit and hardening: tests, docs, strict Mission Control dry-run assertion.
2. Secret hygiene PR/process: remove tracked `.env` safely after secret rotation and history cleanup planning.
3. Observability PR: redact sheet IDs in logs, add clearer structured request timing.
4. API consistency PR: normalize response helper usage without breaking existing callers.
5. Enrichment PR: add more alias coverage and pending-exercise workflow documentation.
6. CI/CD PR: branch protection checklist, PR template, and optional sanitized smoke-test summary artifact.
