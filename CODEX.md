# Atlas Agent Instructions

These instructions define Codex behavior in this repository. They are not the Atlas roadmap.

## Product North Star

Codex must read [docs/ATLAS_PRODUCT_VISION.md](docs/ATLAS_PRODUCT_VISION.md) before product, UI, coaching, data-model, or architecture work.

Atlas is a personal AI fitness companion, not just a backend service. The backend exists to support a finished app where workout capture is low-friction, coaching becomes more intelligent over time, and the owner can safely approve structured training data before it is saved.

Approve-before-save is a product principle. The current Google Sheets, Render, GitHub Actions, ChatGPT/Codex, and Node/Express architecture is the practical v1 path, not something to defend forever.

## Atlas Summary

Atlas is a personal fitness platform. This repository contains the Node/Express backend that parses, validates, enriches, and writes workout data to Google Sheets. Render deploys production from GitHub `main`. GitHub Actions Mission Control validates production safely.

## Current Execution Sources

Use the active docs in this order:

1. `BACKLOG.md`
2. `docs/ACTIVE_ROADMAP.md`
3. `docs/AGENT_WORKFLOW.md`

Document responsibilities:

- `CLAUDE.md` defines Claude Code and implementation-agent operating instructions.
- `CODEX.md` defines Codex reviewer / agent behavior.
- `BACKLOG.md` defines priorities and is the source of truth for open and deferred work.
- `docs/ACTIVE_ROADMAP.md` defines the current execution queue.
- `docs/DOCS_INDEX.md` defines document status and separates active docs from historical/reference docs.
- `docs/AGENT_WORKFLOW.md` defines the Dale + ChatGPT + Claude Code + CODEX Review + GitHub process.

Rules:

- Do not use `CODEX.md` as a roadmap.
- Do not select the next implementation PR from `CODEX.md`.
- If `CODEX.md` appears to conflict with `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, or `docs/AGENT_WORKFLOW.md`, follow the execution source and update this file in a docs-only PR.
- Historical plans and old PR notes are context only unless the backlog or active roadmap explicitly points to them.

## Current Production State

- Production URL: `https://atlas-workout-updater.onrender.com`
- GitHub `main` is the source of truth.
- Render auto-deploys from `main`.
- Google Sheets is the current production database.
- The cleaned dashboard-free sheet is live in production.
- Dashboard is intentionally absent and optional.
- Mission Control is working.
- Dry-run safety has been proven.
- No real post-cutover write should be assumed unless the owner explicitly says it has happened.

## Required Sheet Contract

Required tabs:

- `Metadata`
- `Log_Cleaned`
- `Exercise_Catalog`
- `Effort`
- `Logic`
- `Session_Summary`

Dashboard:

- intentionally absent
- optional only
- must never be required by health checks, code, tests, or docs

## Absolute Safety Rules

- No real Google Sheets writes without explicit owner approval.
- Always use `test_mode=true` for dry-runs.
- Never run real workout ingestion unless the owner explicitly approves it for that turn.
- Never expose secrets or API keys.
- Never print `ATLAS_API_KEY`.
- Never commit `.env` files.
- Never commit spreadsheets.
- Never commit screenshots or private workout data.
- Never commit Google credentials.
- Never change Render environment variables without explicit owner approval.
- Never change `GOOGLE_SHEETS_ID` without explicit owner approval.
- Never merge PRs without owner approval.
- Never restore Dashboard as a required tab.
- Prefer small, safe PRs.
- Create PRs only unless the owner explicitly asks for a merge.

## No-Write And `test_mode` Rules

- `would_write:true` is not proof of no-write safety.
- Valid no-write proof requires:
  - `test_mode:true`
  - `sheet_written:false`
  - `no_write_confirmed:true`
- Legacy compatibility may also accept `sheet_write:"skipped"` when `test_mode:true`.
- A dry-run session must not appear in history.
- Mission Control full mode must remain `test_mode=true` only.

## PR Rules

- Branch from latest `origin/main`.
- Before branching, fetch/pull and verify required prior PRs are merged when the owner names them.
- Keep changes reviewable.
- Separate risky code changes from docs-only changes.
- Do not stage private files or unrelated local changes.
- Do not commit `.env`, credentials, spreadsheets, screenshots, or private data.
- Open PRs with clear safety notes and tests run.

## Merge Rules

- Do not merge without explicit owner approval.
- After a production-affecting merge, run Mission Control:
  1. `read-only` with `expected_sheet_label=cleaned`
  2. `full` with `expected_sheet_label=cleaned`
- Do not proceed to a real write just because Mission Control is green.

## Mission Control Rules

- Mission Control lives in GitHub Actions CI.
- Use `read-only` for safe production validation.
- Use `full` only when a `test_mode=true` dry-run is appropriate.
- Full mode must prove no-write safety.
- Failure after a cleaned-sheet switch means pause and consider rollback.
- Do not print secrets in logs or summaries.

## What Codex May Do

- Read code and docs.
- Create branches.
- Edit code, tests, and docs.
- Run local tests and syntax checks.
- Open PRs.
- Run GitHub Actions Mission Control when asked.
- Summarize risks and blockers.
- Perform CODEX Review after Claude Code opens a PR.
- Flag roadmap drift, scope creep, and trust-contract risk.
- Run the **Codex Decision Desk**: answer Claude's decision panels (`docs/DECISION_ROUTING.md`) so the owner is not asked. Answer every question in a `Codex Decision Request` grounded in roadmap fit, scope, and the trust contract; escalate to the owner only the reserved items (Vision/Dream/Constitution, model-recommendation, INVARIANT amendments, or anything you cannot resolve). Do not punt routine scope/approach/roadmap-fit calls to the owner.

## What Codex Must Never Do

- Do not change Render settings.
- Do not change `GOOGLE_SHEETS_ID`.
- Do not write to Google Sheets.
- Do not run real workout ingestion.
- Do not expose credentials.
- Do not restore Dashboard as required.
- Do not merge PRs without explicit owner approval.
- Do not delete old or cleaned sheets.
- Do not begin the next roadmap PR unless the owner explicitly asks.
- Do not convert historical/reference docs into active execution plans without owner approval.

## CODEX Review

CODEX Review is the roadmap-fit, trust-contract, and scope-control review that happens after Claude Code opens a PR. It does not replace GitHub checks or Dale's merge decision.

CODEX Review checks:

- roadmap fit
- scope creep
- Atlas trust contract
- live-path test coverage
- write-path/schema safety
- accidental future-PR work
- whether the original failure is actually fixed

CODEX Review outcomes:

- `BLOCKING`
- `NON-BLOCKING`
- `READY FOR OWNER MERGE`

If a finding is future-scope work, do not ask Claude Code to build it inside the current PR. Route it to `BACKLOG.md`, an issue, or owner decision instead.

## Workflow Alignment

Atlas now uses this workflow:

- Dale + ChatGPT = planning, roadmap, app testing, and product decisions.
- Claude Code = implementation.
- GitHub = CI/checks and PR handoff.
- CODEX Review = roadmap fit, trust contract, and scope control.
- Dale = final merge.

Codex may help with implementation when explicitly asked, but the default alignment role after Claude Code opens a PR is review, not starting adjacent roadmap work.

## Morning Summary Format

Use this format after longer autonomous work:

```text
Atlas Summary

Bottom line:
- What changed
- Whether production was touched
- Whether any writes happened

PRs:
- PR number/link
- branch
- risk level
- tests run
- merge recommendation

Safety:
- Render env vars changed? yes/no
- Google Sheets writes? yes/no
- real workout ingestion? yes/no
- secrets/private files touched? yes/no
- Dashboard restored or required? yes/no

Next:
- exact recommended next step
- blockers
- owner decisions needed
```
