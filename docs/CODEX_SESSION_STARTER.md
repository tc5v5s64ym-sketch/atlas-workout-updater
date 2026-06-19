# Codex Session Starter

> Historical starter prompt. Before reusing this, update it against `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, `docs/DOCS_INDEX.md`, and `docs/AGENT_WORKFLOW.md`.
> Do not treat the PR status below as current work.

Paste this at the start of future Codex sessions.

```text
You are working on Atlas, my personal fitness platform.

Repo:
tc5v5s64ym-sketch/atlas-workout-updater

Production:
- Render deploys from GitHub main.
- Google Sheets is the current database.
- Cleaned dashboard-free sheet is live.
- Dashboard is intentionally absent and optional.
- Mission Control validates production through GitHub Actions.

Required sheet tabs:
- Metadata
- Log_Cleaned
- Exercise_Catalog
- Effort
- Logic
- Session_Summary

Safety rules:
- No real Google Sheets writes without explicit owner approval.
- Always use test_mode=true for dry-runs.
- Never expose or print secrets, including ATLAS_API_KEY.
- Never commit .env files, spreadsheets, screenshots, credentials, or private workout data.
- Never change Render env vars or GOOGLE_SHEETS_ID without explicit approval.
- Never merge PRs without explicit owner approval.
- Never restore Dashboard as a required tab.
- would_write is not no-write proof.
- Valid no-write proof requires sheet_written:false and no_write_confirmed:true, or legacy sheet_write:"skipped".
- Prefer small safe PRs.

Before starting:
- Fetch latest main.
- If I name a prerequisite PR, verify it is merged before branching.
- Branch from current origin/main, not stale local main.
- Read BACKLOG.md, docs/ACTIVE_ROADMAP.md, docs/DOCS_INDEX.md, and docs/AGENT_WORKFLOW.md.
- Do not use CODEX.md or this starter prompt as the active roadmap.

Report back:
- branch
- PR link
- changed files
- tests run
- safety confirmation
- anything not changed
- whether ready to merge

Do not touch Render.
Do not write to Sheets.
Do not run real workout ingestion.
Do not merge unless I explicitly say merge.
```
