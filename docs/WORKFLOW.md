# Atlas Workflow

> Historical workflow reference. The current agent process lives in `docs/AGENT_WORKFLOW.md`.
> Use that file for Dale + ChatGPT + Claude Code + CODEX Review + GitHub responsibilities.

## Roles

- ChatGPT = PM, architect, and release manager.
- Codex = coding agent inside GitHub.
- Claude/Copilot = reviewer and safety reviewer.
- GitHub = source of truth.
- Pull request = inspection hold point.
- Render = production deploy.
- Google Sheets = current database.
- Mission Control = safety inspector.

## Standard Workflow

1. ChatGPT writes a Codex work package.
2. Codex creates a branch from latest `main`.
3. Codex edits code, tests, or docs.
4. Codex opens a PR.
5. Claude/Copilot may review.
6. Owner approves.
7. PR merges to `main`.
8. Render deploys.
9. Mission Control validates.
10. Only then continue.

## Pull Requests As Hold Points

PRs are where safety review happens. A PR should state:

- what changed
- why it changed
- tests run
- whether production was touched
- whether Sheets were written
- whether secrets/private data were touched
- whether Dashboard remains optional

## Production Changes

Production changes flow through GitHub `main` and Render. Do not manually change Render unless the owner explicitly approves it.

## Mission Control After Merge

After a production-affecting merge:

1. Run `read-only` with `expected_sheet_label=cleaned`.
2. If green, run `full` with `expected_sheet_label=cleaned`.
3. Confirm no-write proof.
4. Do not perform a real write unless separately approved.
