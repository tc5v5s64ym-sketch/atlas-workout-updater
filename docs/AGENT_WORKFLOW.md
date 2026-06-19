# Atlas Agent Workflow

This document defines the Atlas build workflow between Dale, ChatGPT, Claude Code, Codex Review, GitHub PRs, and GitHub checks.

## Roles

### Dale

- Owns product direction, phase approval, hands-on app testing, and final merge.
- Starts each phase.
- Merges only after checks and reviews are clean.
- App-tests at planned hold points or when review flags product risk.

### ChatGPT

- Acts as decision desk with Dale.
- Helps brainstorm, plan phases, update the roadmap, and shape Claude Code prompts.
- Reviews app-test results and turns findings into backlog/roadmap work.
- Does not merge.

### Claude Code

- Implements one PR at a time.
- Reads `CLAUDE.md`, `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, `docs/DOCS_INDEX.md`, and this file before starting.
- Opens a PR and stops.
- If review comments request changes, fixes only those requested changes, pushes updates, and stops again.
- Does not broaden scope during fixes.
- Does not start the next PR without owner approval.
- Does not merge.

### GitHub

- Runs CI and required checks.
- Holds PR discussion, review comments, status checks, and merge history.
- Acts as the shared handoff bus between agents.

### CODEX Review

CODEX Review is the product-trust / roadmap-fit / scope-control review performed after Claude Code opens a PR.

CODEX Review checks:

- roadmap fit
- scope creep
- Atlas trust contract
- live-path test coverage
- write-path/schema safety
- accidental future-PR work
- whether the PR fixes the original failure

CODEX Review returns one of:

- `BLOCKING`
- `NON-BLOCKING`
- `READY FOR OWNER MERGE`

## CODEX Review action rules

If CODEX Review returns `BLOCKING` and the issue is in scope for the current PR:

1. Claude Code fixes only that issue.
2. Claude Code pushes the update.
3. GitHub checks rerun.
4. CODEX Review reruns.
5. Claude Code stops again.

If CODEX Review finds future-scope work:

1. Claude Code must not build it inside the current PR.
2. Claude Code adds it to `BACKLOG.md` or creates/links an issue.
3. Claude Code mentions the deferral in the PR notes.
4. Claude Code stops.

If CODEX Review returns `NON-BLOCKING`:

- Claude Code may leave the finding as a note/deferred item.
- Dale may still merge after GitHub checks are green.

If CODEX Review returns `READY FOR OWNER MERGE`:

- The PR is ready for Dale's final merge decision once GitHub checks are green.

## Standard PR loop

1. Dale + ChatGPT plan the phase.
2. Claude Code implements the next approved PR only.
3. Claude Code opens the PR and stops.
4. GitHub checks run.
5. Claude Code Review runs, if enabled.
6. CODEX Review runs.
7. Blocking in-scope findings go back to Claude Code.
8. Future-scope findings go to `BACKLOG.md` or a GitHub issue.
9. Repeat until checks are green and reviews are ready/non-blocking.
10. Dale merges.
11. At hold points, Dale app-tests before the next phase continues.

## Merge gate

A PR is not ready for Dale to merge unless:

- GitHub checks are green.
- Claude Code Review has no unresolved blocker.
- CODEX Review is `READY FOR OWNER MERGE` or `NON-BLOCKING`.
- The PR matches `docs/ACTIVE_ROADMAP.md` or an explicitly approved owner task.
- No write-path/schema changes are present unless explicitly scoped.

## Hold points

At hold points, Claude Code must stop even if all PRs are green.

Dale app-tests.

ChatGPT interprets app-test results with Dale.

Only Dale can approve continuing to the next phase.

## Prompt compression target

Once this workflow is in place, Dale's standard Claude Code prompt should be:

```text
Read CLAUDE.md, BACKLOG.md, docs/ACTIVE_ROADMAP.md, docs/DOCS_INDEX.md, and docs/AGENT_WORKFLOW.md.

Execute the next incomplete PR only.

Open the PR and stop.
```

## Non-negotiables

- `BACKLOG.md` is the source of truth.
- `docs/ACTIVE_ROADMAP.md` is the current critical path.
- `docs/DOCS_INDEX.md` separates active docs from historical/reference docs.
- One PR equals one concern.
- Tests must prove the previous failure cannot recur.
- Tests should cover the live path or closest integration path, not only helper functions.
- No write-path changes unless scoped.
- No Sheet schema changes unless explicitly approved.
- The engine decides; the AI explains.
