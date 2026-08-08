# Atlas Workout Updater

Atlas is Dale's conversation-first personal strength coach and workout logger. It parses natural gym language, maintains session truth, previews the exact rows that would be saved, and writes to Google Sheets only after explicit approval.

> **Current source of truth (2026-07-22).** Atlas is running the **Atlas Recovery Campaign (Issue #1073)**, embedded in [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md). That plan and [`CLAUDE.md`](CLAUDE.md) govern; [`docs/BUILDER_PORTABILITY.md`](docs/BUILDER_PORTABILITY.md) maps the canonical brief's legacy tool-specific wording so any owner-approved implementation agent can operate under one contract. Some documents linked below predate the campaign and may be stale. Start from [`docs/DOCS_INDEX.md`](docs/DOCS_INDEX.md) for the authority map.

## Production

- Render deploys from GitHub `main`.
- Google Sheets is the permanent V1 record today. The owner authorized migrating the workout hot path to Supabase on 2026-08-07 ([`docs/SUPABASE_HOT_PATH_MIGRATION.md`](docs/SUPABASE_HOT_PATH_MIGRATION.md)). Nothing has migrated yet.
- The application is served at `/app`.
- Data requests require the Atlas API key or a durable owner-session cookie (see [docs/OWNER_SESSION.md](docs/OWNER_SESSION.md)).
- Static assets are public; workout data and APIs are not.
- The authoritative Sheet contract lives in `config/columns.js`, `config/sheetContract.js`, and `docs/SHEET_CONTRACT.md`.

## Trust contract

- Never commit `.env`, API keys, Google credentials, production Sheet IDs, screenshots, spreadsheets, or private workout data.
- Never run a real production write without explicit authorization.
- Dry-runs pass `test_mode:true` and prove `sheet_written:false` plus `no_write_confirmed:true`.
- The preview → approve → write flow is mandatory.
- The deterministic engine owns numbers and decisions; the LLM only words whitelisted facts.

## Start here

- [AGENTS.md](AGENTS.md) — the universal entrypoint for implementation agents, on every surface. Start here.
- [CLAUDE.md](CLAUDE.md) — canonical detailed operating and safety brief.
- [docs/BUILDER_PORTABILITY.md](docs/BUILDER_PORTABILITY.md) — surface-neutral authority mapping, handoff protocol, and the fresh-agent cold-start acceptance trial.
- [docs/ATLAS_V1_EXECUTION_PLAN.md](docs/ATLAS_V1_EXECUTION_PLAN.md) — sole active execution campaign.
- [docs/DECISION_KERNEL.md](docs/DECISION_KERNEL.md) — durable product/trust principles.
- [docs/DOCS_INDEX.md](docs/DOCS_INDEX.md) — documentation authority map.
- [docs/ATLAS_PRODUCT_VISION.md](docs/ATLAS_PRODUCT_VISION.md) — product north star.
- [docs/CONSTITUTION.md](docs/CONSTITUTION.md) and [docs/INVARIANTS.md](docs/INVARIANTS.md) — non-negotiable rules.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — current system boundaries.
- [docs/AGENT_LIVE_TESTING.md](docs/AGENT_LIVE_TESTING.md) — safe live-test tiers.
- [docs/MISSION_CONTROL.md](docs/MISSION_CONTROL.md) — production checks.
- [docs/ATLAS_OPERATIONS_CONTRACT.md](docs/ATLAS_OPERATIONS_CONTRACT.md) — Atlas Control Tower status: `npm run atlas:status` and the public `GET /.well-known/atlas-status.json`.
- [docs/BACKUP_ROLLBACK.md](docs/BACKUP_ROLLBACK.md) — recovery.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — diagnosis.

Historical plans and compatibility pointers do not select work.

## For implementation agents

Every owner-approved implementation agent uses the same launcher and the same authority, on every surface — Claude Code, Codex, Cursor, or another the owner approves. Start at [`AGENTS.md`](AGENTS.md); it carries the one compact launcher. Verify current state and open PRs before editing; execute one concern on a fresh `agent/<concern>` branch; run deterministic hard gates; declare your builder surface and model in the merge card; merge the exact passing head under standing authority; update campaign state when required; refresh `main`; and continue.

`CODEX.md` and any surface pointer file are pointers only. They do not create a second process, a second authority, or a second execution queue.

## Local setup and checks

Use `.env.example` as a placeholder template. Never commit real secrets.

```bash
npm run lint
npm test
```

Run other applicable build, wiring, secret-scan, E2E, and trust/write/schema checks named by the active card and PR template.
