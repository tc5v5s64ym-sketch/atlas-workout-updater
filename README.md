# Atlas Workout Updater

Atlas is the production backend that parses, enriches, validates, and writes workout data to the live Google Sheet.

## Production Status

- Render production URL: `https://atlas-workout-updater.onrender.com`
- Google Sheets integration is live.
- Dashboard is intentionally absent and optional.
- Required production tabs are `Metadata`, `Log_Cleaned`, `Exercise_Catalog`, `Effort`, `Logic`, and `Session_Summary`.
- Mission Control is the GitHub Actions smoke test used for safe production checks.

## Safety Rules

- Never commit `.env`, API keys, Google credentials, screenshots, spreadsheets, or private workout data.
- Do not change `GOOGLE_SHEETS_ID` without an approved cutover or rollback.
- Do not run a real workout write unless explicitly approved.
- Use `test_mode=true` for production dry-runs.
- Treat `would_write:true` as validation signal only. No-write proof requires `sheet_written:false` and `no_write_confirmed:true`.

## Docs

- Agent instructions: [CODEX.md](CODEX.md)
- Atlas context: [docs/ATLAS_CONTEXT.md](docs/ATLAS_CONTEXT.md)
- Safety rules: [docs/SAFETY_RULES.md](docs/SAFETY_RULES.md)
- Workflow: [docs/WORKFLOW.md](docs/WORKFLOW.md)
- Codex session starter: [docs/CODEX_SESSION_STARTER.md](docs/CODEX_SESSION_STARTER.md)
- Foundation audit: [docs/FOUNDATION_AUDIT.md](docs/FOUNDATION_AUDIT.md)
- Post-cutover baseline: [docs/BASELINE_POST_CUTOVER.md](docs/BASELINE_POST_CUTOVER.md)
- Mission Control: [docs/MISSION_CONTROL.md](docs/MISSION_CONTROL.md)
- Sheet contract: [docs/SHEET_CONTRACT.md](docs/SHEET_CONTRACT.md)
- Release checklist: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)
- Troubleshooting: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- First real write plan: [docs/FIRST_REAL_WRITE.md](docs/FIRST_REAL_WRITE.md)
- API audit: [docs/API_AUDIT.md](docs/API_AUDIT.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Product plan: [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md)
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md)
- API reference: [API_REFERENCE.md](API_REFERENCE.md)

## For AI Agents

Read [CODEX.md](CODEX.md) before changing code. It contains the permanent Atlas safety rules, sheet contract, no-write requirements, and PR workflow.

## Local Checks

```bash
npm run lint
npm test
```

## Mission Control

Run the CI workflow manually from GitHub Actions:

1. Open the CI workflow.
2. Choose branch `main`.
3. Select a smoke mode.
4. Use `read-only` for safe health checks.
5. Use `full` or `post-switch` only when a `test_mode=true` dry-run is appropriate.

See [docs/MISSION_CONTROL.md](docs/MISSION_CONTROL.md) for the full mobile-friendly workflow.
