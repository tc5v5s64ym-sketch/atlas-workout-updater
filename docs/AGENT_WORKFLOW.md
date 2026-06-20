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

## Autonomous Build Loop

Atlas is automation-first. The standard loop above describes the roles; this is the **loop the builder runs without owner involvement** until an owner check-in criterion is met. It is governed by `docs/AUTOMATION_PROTOCOL.md` (the automation contract), `docs/OWNER_CHECKIN_RULES.md` (when to stop for the owner), and `docs/RISK_LABELS.md` (risk classification).

For each unit of work, the builder:

1. **Read the roadmap** — `BACKLOG.md` (source of truth) and `docs/ACTIVE_ROADMAP.md` (current queue).
2. **Select the next approved task** — the next roadmap/backlog item; run the Current-State Verification Gate and Model Recommendation Gate (below) before editing.
3. **Build** — implement one concern only; file discovered future work in `BACKLOG.md` in the same PR.
4. **Run tests** — `npm test` + lint; cover the live path or closest integration path, not only new helpers.
5. **Run review** — open the PR; Claude Code Review (GitHub Actions) and CODEX Review run.
6. **Fix failures** — fix failing tests and in-scope BLOCKING / P0–P1 review findings only; do not broaden scope.
7. **Re-run tests** — confirm green after fixes.
8. **Re-run review** — confirm Claude Code Review and CODEX Review pass after fixes.
9. **Classify risk** — apply exactly one primary risk label + any category labels (`docs/RISK_LABELS.md`).
10. **Generate the merge card** — fill the PR template completely (`.github/PULL_REQUEST_TEMPLATE.md`).
11. **Keep going until the owner says stop, or an owner-decision criterion is met** (`docs/OWNER_CHECKIN_RULES.md` criteria 2–8: write-path / approval-gate / coach / trust-contract change, roadmap/vision change, model-recommendation change, or "automation cannot determine safety"). Live app testing (criterion 1) is **owner-initiated** — the builder flags `owner-live-test` and includes a live test script, but does **not** halt for it; the owner calls app-test holds explicitly. Otherwise the PR is marked merge-ready and proceeds; the next approved task is started without blocking on the owner.

**Pass/fail principle (non-negotiable):** a review or check that was skipped, errored, was unavailable, timed out, or returned incomplete is a **failure, not a pass** (`docs/AUTOMATION_PROTOCOL.md` §2). The loop never treats a missing signal as green.

A PR is **merge-ready** only when: tests pass · required reviews pass · no open P0/P1 finding · no unresolved contract violation · risk classification done · merge card generated. Any skipped or failed required review blocks readiness.

## Merge gate

A PR is not ready for Dale to merge unless:

- GitHub checks are green.
- Claude Code Review has no unresolved blocker.
- CODEX Review is `READY FOR OWNER MERGE` or `NON-BLOCKING`.
- The PR matches `docs/ACTIVE_ROADMAP.md` or an explicitly approved owner task.
- No write-path/schema changes are present unless explicitly scoped.

## Hold points

Under the automation-first workflow, hold points are **owner-initiated**, not automatic. Claude Code does not halt the build loop for an app test on its own — it flags `owner-live-test` and includes a live test script in the merge card, then keeps going. The owner calls an app-test hold when they want one and says stop; until then, work continues.

When the owner does call a hold:

Dale app-tests.

ChatGPT interprets app-test results with Dale.

Only Dale resumes the held phase.

(Owner-decision criteria 2–8 in `docs/OWNER_CHECKIN_RULES.md` still stop the loop automatically — only the live-app-test stop is owner-initiated.)

## Compact Atlas Prompt Mode

Future owner prompts may be short because agents are expected to read the repo docs first. A compact prompt is valid only when the agent reads `CLAUDE.md`, `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, `docs/DOCS_INDEX.md`, and this file before acting.

Reading those five files is mandatory before any compact prompt is honored. If the agent has not read them, it must do so first.

### Compact prompt examples

**Continue next roadmap item**

```text
Use compact Atlas prompt mode.
Continue the next active roadmap item.
Include the model recommendation gate.
Stop for owner confirmation before implementation.
Open one small PR.
Do not merge.
```

**Create bugfix from latest app-test failure**

```text
Use compact Atlas prompt mode.
Create a narrow bugfix PR for the latest app-test failure.
Include the model recommendation gate.
Stop for owner confirmation before implementation.
If related future work is discovered, add it to BACKLOG.md.
Open one small PR.
Do not merge.
```

**Update backlog only**

```text
Use compact Atlas prompt mode.
Update BACKLOG.md only with the latest deferred item or app-test finding.
No code changes.
Open one docs-only PR.
Do not merge.
```

**Review open PR**

```text
Use compact Atlas prompt mode.
Review the open PR against CLAUDE.md, BACKLOG.md, docs/ACTIVE_ROADMAP.md, docs/DOCS_INDEX.md, and docs/AGENT_WORKFLOW.md.
Report merge / fix / park.
Do not change code unless explicitly asked.
```

**Pre-edit report (use before any implementation PR)**

Before editing files, report:

- which docs currently contain repeated rules
- which docs need changes
- whether any docs conflict
- smallest docs-only fix
- model recommendation
- one-line model reason
- risk level

Then STOP and wait for owner confirmation before editing. After owner confirms, create one PR and stop for review.

## Current-State Verification Gate

Before implementing any roadmap, backlog, or GitHub issue fix, the agent must first verify whether the reported failure still exists in the current repo.

The pre-coding report must include:

1. Source being worked:
   - Roadmap step, `BACKLOG.md` item, or GitHub issue number.
2. Duplicate/stale search:
   - Search `BACKLOG.md`.
   - Search `docs/ACTIVE_ROADMAP.md`.
   - Search open and recently merged PRs.
   - Search open/closed GitHub issues when relevant.
   - Search current code for the named functions/files/behaviors.
3. Current-state verdict:
   Use exactly one of:
   - `STILL BROKEN` -- implement fix
   - `ALREADY FIXED` -- no code change
   - `PARTIALLY FIXED` -- narrow remaining gap
   - `FIXED BUT UNTESTED` -- add/adjust regression test only
   - `STALE / SUPERSEDED` -- update docs or close issue
   - `NEEDS OWNER APP-TEST` -- stop and ask
4. Evidence:
   - Cite the current file/function/test/PR/issue evidence.
   - If possible, identify the exact current failure path.
   - If already fixed, identify where it was fixed.
5. Allowed next action:
   - If `STILL BROKEN`, proceed to the normal model recommendation gate.
   - If `PARTIALLY FIXED`, scope only the remaining gap.
   - If `FIXED BUT UNTESTED`, do not refactor; add the smallest regression test.
   - If `ALREADY FIXED` or `STALE / SUPERSEDED`, do not edit code; update `BACKLOG.md`/issue/roadmap status only.
   - If `NEEDS OWNER APP-TEST`, stop.

Hard rule: A Claude/Codex agent must not begin implementation simply because a backlog item or issue exists. Existence of a task is not proof the bug still exists.

If a stale item is discovered, the same PR should either:

- update `BACKLOG.md` / `docs/ACTIVE_ROADMAP.md` to mark it resolved, deferred, or superseded, or
- add a GitHub issue comment explaining the current-state verdict.

The normal model recommendation gate remains after this verification gate.

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
