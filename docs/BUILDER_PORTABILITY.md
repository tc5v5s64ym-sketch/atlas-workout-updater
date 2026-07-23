# Atlas Builder Portability

## Purpose

Atlas may use **Claude Code or Codex as the active implementation agent**. Switching tools must not create a second workflow, a second roadmap, a weaker safety standard, or a re-onboarding project.

This document is a compatibility and handoff contract. It does not select work. [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md) remains the sole active work-selection authority.

## One role, two tools

The active implementation agent—Claude Code or Codex—has the same responsibilities and standing authority:

- run the Current-State Verification Gate before editing;
- implement one concern on a fresh branch;
- run the live path or closest integration path plus all applicable deterministic gates;
- open and complete the PR;
- address real in-scope advisory findings without widening scope;
- merge the exact passing head when authorized and all hard gates pass;
- verify `main` and deployment when applicable;
- update campaign state/completion evidence when required; and
- continue from refreshed `main` until an owner-reserved gate.

Tool identity never changes production-write, schema, security, invariant, promotion, or owner-evidence gates.

## Legacy wording map

`CLAUDE.md` remains the canonical detailed rulebook. Until its historical filename and role wording are retired through a separate focused governance change:

- **“Claude” as builder/merge operator** means **the active implementation agent (Claude Code or Codex)**.
- **“Codex comments/review are advisory”** means **independent agent review is advisory**. When Codex is the builder, Claude or another clean-context reviewer may fill that optional lane.
- **`claude/<concern>` branches** remain valid historical branches. New branches use **`agent/<concern>`** so handoffs are tool-neutral.

This mapping changes no product or safety rule and creates no independent process.

## Repository-state handoff

The repository is the handoff. Chat transcripts, local scratchpads, and model memory are never the source of truth.

Before switching builders:

1. Finish, merge, or explicitly abandon the current concern. Never have Claude and Codex independently implement the same concern.
2. Confirm there is no overlapping open PR or stale feature branch being treated as current.
3. Refresh from `main` and verify a clean worktree.
4. Run `npm run atlas:status -- --json` when the environment supports it.
5. Leave the canonical plan card, PR, tests, and evidence in the repository—not only in chat.

After switching builders:

1. Read `AGENTS.md`, `CLAUDE.md`, this document, and `docs/ATLAS_V1_EXECUTION_PLAN.md`.
2. Inspect recent/open PRs and current code before assuming the next card is untouched.
3. Report the Current-State Verification Gate verdict.
4. Start a fresh `agent/<concern>` branch from current `main`.
5. Continue the normal campaign loop.

A new agent should not need a custom history dump from Dale. If repository state is insufficient, that is a repository documentation/evidence defect to fix—not a reason to invent context.

## Review and merge

GitHub Actions and deterministic checks are the hard gates. Agent reviews are useful but advisory.

- The inactive agent may review the active builder's PR.
- A builder must not manufacture a required review status from its own identity, wording, reaction, or comment.
- A missing optional agent review does not block an otherwise authorized routine PR.
- Real P0/P1 or in-scope findings do block until fixed or truthfully dispositioned.
- Risk-triggered ChatGPT Atlas Contract Review and owner-reserved authorizations remain unchanged.

## Standard launcher

Use the same launcher for Claude Code or Codex:

> Read `AGENTS.md`, `CLAUDE.md`, `docs/BUILDER_PORTABILITY.md`, and `docs/ATLAS_V1_EXECUTION_PLAN.md`. Act as the active Atlas implementation agent. Verify current state and open PRs before editing, execute the first eligible unfinished concern on a fresh `agent/<concern>` branch, run every applicable deterministic gate, merge the exact passing head under standing authority, update campaign state when required, refresh `main`, and continue. Stop only for an explicit owner-reserved gate.

## Forced mid-PR handoff

Avoid switching mid-PR. When unavoidable, the outgoing builder must leave these facts in the PR body or a top-level PR comment:

1. concern and canonical source;
2. exact current head SHA;
3. current-state verdict and root cause;
4. files changed and remaining work;
5. tests run, failures, and unrun gates;
6. owner authorization or live evidence still required; and
7. any real advisory findings still open.

The incoming builder re-verifies all seven items. It never trusts a prose handoff over the diff, tests, and current repository state.
