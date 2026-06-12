# Atlas Agent Instructions

These instructions are for Codex and any coding agent working in this repository.

## Product North Star

Codex must read [docs/ATLAS_PRODUCT_VISION.md](docs/ATLAS_PRODUCT_VISION.md) before product, UI, coaching, data-model, or architecture work.

Atlas is a personal AI fitness companion, not just a backend service. The backend exists to support a finished app where workout capture is low-friction, coaching becomes more intelligent over time, and the owner can safely approve structured training data before it is saved.

Approve-before-save is a product principle. The current Google Sheets, Render, GitHub Actions, ChatGPT/Codex, and Node/Express architecture is the practical v1 path, not something to defend forever.

## Atlas Summary

Atlas is a personal fitness platform. This repository contains the Node/Express backend that parses, validates, enriches, and writes workout data to Google Sheets. Render deploys production from GitHub `main`. GitHub Actions Mission Control validates production safely.

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

## What Codex Must Never Do

- Do not change Render settings.
- Do not change `GOOGLE_SHEETS_ID`.
- Do not write to Google Sheets.
- Do not run real workout ingestion.
- Do not expose credentials.
- Do not restore Dashboard as required.
- Do not merge PRs without explicit owner approval.
- Do not delete old or cleaned sheets.

## Current PR Status And Priority

As of this instruction refresh, the recent merged UI/product sequence is:

1. PR #96: merged - two-surface Coach/Progress shell with design tokens.
2. PR #98: merged - Coach chat thread, composer send, and in-thread preview card.
3. PR #99: merged - trust loop as in-thread card states.
4. PR #100: merged - Progress surface v1.
5. PR #101: merged - frontend sends `write_id` for duplicate protection.
6. PR #102: merged - Coach declutter, bottom-docked composer, and service-worker cache bump.
7. PR #103: merged - glanceable dashboard with friendly one-liners first and full data one tap deeper.

At handoff, no open PRs were visible.

If another AI agent may have run out mid-build and no PR is open yet, assume there may be unpushed local or session-only work. In that situation, avoid recently touched UI files unless the owner gives explicit direction.

Current safe next lanes after interrupted UI work:

1. Docs-only status refresh work.
2. Parser golden tests or other isolated tests-only work.
3. Small isolated backend work outside likely interrupted UI files.

Verify current GitHub state before relying on any PR/status summary in this file.

## Interrupted Agent Work Rule

When an AI coding session runs out mid-build and no PR is open, do not guess and continue the same feature.

1. First check open PRs and recent PRs.
2. Avoid files likely touched by the interrupted agent, especially recent UI files.
3. Prefer docs-only, tests-only, or isolated backend work until the owner confirms the unfinished branch state.

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
