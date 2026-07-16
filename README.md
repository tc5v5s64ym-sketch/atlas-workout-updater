# Atlas Workout Updater

Atlas is Dale's conversation-first personal strength coach and workout logger. It parses natural gym language, maintains session truth, previews the exact rows that would be saved, and writes to Google Sheets only after explicit approval.

## Production

- Render deploys from GitHub `main`.
- Google Sheets is the permanent V1 record.
- The application is served at `/app`.
- Data requests require the Atlas API key.
- Static assets are public; workout data and APIs are not.
- The authoritative Sheet contract lives in `config/columns.js`, `config/sheetContract.js`, and `docs/SHEET_CONTRACT.md`.

## Trust contract

- Never commit `.env`, API keys, Google credentials, production Sheet IDs, screenshots, spreadsheets, or private workout data.
- Never run a real production write without explicit authorization.
- Dry-runs pass `test_mode:true` and prove `sheet_written:false` plus `no_write_confirmed:true`.
- The preview → approve → write flow is mandatory.
- The deterministic engine owns numbers and decisions; the LLM only words whitelisted facts.

## Start here

- [CLAUDE.md](CLAUDE.md) — canonical agent operating and safety brief.
- [docs/ATLAS_V1_EXECUTION_PLAN.md](docs/ATLAS_V1_EXECUTION_PLAN.md) — sole active execution campaign.
- [docs/DECISION_KERNEL.md](docs/DECISION_KERNEL.md) — durable product/trust principles.
- [docs/DOCS_INDEX.md](docs/DOCS_INDEX.md) — documentation authority map.
- [docs/ATLAS_PRODUCT_VISION.md](docs/ATLAS_PRODUCT_VISION.md) — product north star.
- [docs/CONSTITUTION.md](docs/CONSTITUTION.md) and [docs/INVARIANTS.md](docs/INVARIANTS.md) — non-negotiable rules.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — current system boundaries.
- [docs/AGENT_LIVE_TESTING.md](docs/AGENT_LIVE_TESTING.md) — safe live-test tiers.
- [docs/MISSION_CONTROL.md](docs/MISSION_CONTROL.md) — production checks.
- [docs/BACKUP_ROLLBACK.md](docs/BACKUP_ROLLBACK.md) — recovery.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — diagnosis.

Historical plans and compatibility pointers do not select work.

## For implementation agents

Read `CLAUDE.md` and `docs/ATLAS_V1_EXECUTION_PLAN.md`, then execute the first eligible unfinished card. Verify current state before editing, use one concern per PR, run deterministic hard gates, merge the exact passing head under standing authority, update campaign state, and continue from refreshed `main`.

`AGENTS.md` and `CODEX.md` are compatibility pointers only.

## Local setup and checks

Use `.env.example` as a placeholder template. Never commit real secrets.

```bash
npm run lint
npm test
```

Run other applicable build, wiring, secret-scan, E2E, and trust/write/schema checks named by the active card and PR template.
