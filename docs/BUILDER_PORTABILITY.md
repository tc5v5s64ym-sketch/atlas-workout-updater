# Atlas Builder Portability

## Purpose

Atlas work is implemented by the **approved active implementation agent**, on whichever owner-approved surface it runs. Changing surface or model must not create a second workflow, a second roadmap, a weaker safety standard, or a re-onboarding project.

This document is a compatibility and handoff contract. It does not select work. [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md) remains the sole active work-selection authority. [`CLAUDE.md`](../CLAUDE.md) carries the canonical definition of the role; this document does not restate it.

## One role, any approved surface

The approved active implementation agent has the same responsibilities and standing authority on Claude Code, on Codex, on Cursor, and on any other surface Dale approves:

- run the Current-State Verification Gate before editing;
- implement one concern on a fresh branch;
- run the live path or closest integration path plus all applicable deterministic gates;
- open and complete the PR, and declare the builder surface and model in the merge card;
- address real in-scope advisory findings without widening scope;
- merge the exact passing head when authorized and all hard gates pass;
- verify `main` and deployment when applicable;
- update campaign state/completion evidence when required; and
- continue from refreshed `main` until an owner-reserved gate.

Surface identity and model identity never change production-write, schema, security, invariant, promotion, or owner-evidence gates. They never change who performs the Atlas Contract / Systems Review.

## Legacy wording map

`CLAUDE.md` keeps its historical filename and remains the canonical detailed rulebook. There is no second canonical brief.

- **“Claude” as builder/merge operator** in any active governance document means **the approved active implementation agent**.
- **“Codex comments/review are advisory”** means **independent agent review is advisory**. The reviewer is any agent that is not the active builder.
- **`claude/<concern>` branches** remain valid historical branches. New branches use **`agent/<concern>`**, on every surface, so handoffs are tool-neutral.
- **`.claude/rules/*`** are retained filenames. Those rules bind every agent, but they auto-load only on a surface that reads that directory. On any other surface, read them directly when the matching file is in scope.

This mapping changes no product or safety rule and creates no independent process. `CODEX.md` and any surface pointer file are pointers only: they carry no implementation authority.

## Repository-state handoff

The repository is the handoff. Chat transcripts, local scratchpads, and model memory are never the source of truth.

Before switching agents:

1. Finish, merge, or explicitly abandon the current concern. Two agents never implement the same concern.
2. Confirm there is no overlapping open PR or stale feature branch being treated as current.
3. Refresh from `main` and verify a clean worktree.
4. Run `npm run atlas:status -- --json` when the environment supports it.
5. Leave the canonical plan card, PR, tests, and evidence in the repository—not only in chat.

After switching agents:

1. Read `AGENTS.md`, `CLAUDE.md`, this document, and `docs/ATLAS_V1_EXECUTION_PLAN.md`.
2. Inspect recent/open PRs and current code before assuming the next card is untouched.
3. Report the Current-State Verification Gate verdict.
4. Start a fresh `agent/<concern>` branch from current `main`.
5. Continue the normal campaign loop.

A new agent should not need a custom history dump from Dale. If repository state is insufficient, that is a repository documentation/evidence defect to fix—not a reason to invent context.

## Fresh-agent cold-start acceptance trial

This trial proves the claim above. A fresh agent, on a surface Atlas has not used before, with no prior chat history and no handoff prompt, opens the repository, reads `AGENTS.md`, and reports the state of the work. If it cannot, the repository is the defect.

### When it runs — deferred, and it blocks nothing

The trial is a **deferred portability acceptance proof**. It runs when Dale elects to switch surfaces, or when Dale explicitly requests it. It is not scheduled, no card depends on it, and it is not a prerequisite to any campaign work.

- Claude is the current approved active implementation agent. Portability means the role *can* move on an owner instruction, not that it *has* moved.
- Cursor portability is structurally ready and not live-proven.
- A missing trial blocks nothing: not implementation, not testing, not opening a PR, not merging under standing authority, and not F-SB4B, qualifying Session 1, or any other campaign work.
- No portability PASS may be claimed until the trial actually runs.

The owner clarification recording this is in [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md), which is where an owner instruction governs. This section restates the timing only; it creates no second authority.

Launch it with exactly this prompt:

> Read `AGENTS.md` and perform the documented Atlas fresh-agent cold-start acceptance trial. Make no edits and invoke no live service. Report the required evidence and stop.

### Required report

The agent reports all ten items:

1. current `main` SHA;
2. whether local `main` equals `origin/main`;
3. open PR state;
4. current campaign and count state;
5. the first eligible action, or the exact blocker;
6. every owner-reserved stop relevant to that action;
7. the required branch form;
8. the applicable status, unit, lint, guard, secret-scan, and browser-test commands;
9. whether the Atlas Contract / Systems Review would be required for the identified action;
10. what it is explicitly forbidden to do next.

### Trial bounds

The trial:

- makes no file edit;
- creates no branch;
- makes no provider call;
- makes no Google Sheets request;
- runs no qualifying rehearsal session;
- changes no deployment and no configuration.

### Verdict

A PASS is claimed only after a real fresh agent on a new surface performs the trial and reports all ten items correctly. Structural readiness in the repository is not a PASS. A missing or wrong item is a documentation defect: fix the smallest relevant document, then run the trial again.

No agent may perform or simulate this trial on its own initiative. An agent that reports the ten items from its own session is not a fresh agent on a new surface, and recording that as a PASS would be a fabricated proof.

## Review and merge

GitHub Actions and deterministic checks are the hard gates. Independent agent reviews are useful but advisory.

- Any agent that is not the active builder may review the active builder's PR.
- A builder must not manufacture a required review status from its own identity, wording, reaction, or comment.
- A missing optional agent review does not block an otherwise authorized routine PR.
- Real P0/P1 or in-scope findings do block until fixed or truthfully dispositioned.
- The trigger-based Atlas Contract / Systems Review and owner-reserved authorizations remain unchanged. ChatGPT performs that review; an independent builder-model review never substitutes for it, and never substitutes for a required deterministic gate.

## Launcher

[`AGENTS.md`](../AGENTS.md) carries the one compact implementation launcher, for every surface. Do not write a second one here or anywhere else.

## Forced mid-PR handoff

Avoid switching mid-PR. When unavoidable, the outgoing agent must leave these facts in the PR body or a top-level PR comment:

1. concern and canonical source;
2. exact current head SHA;
3. current-state verdict and root cause;
4. files changed and remaining work;
5. tests run, failures, and unrun gates;
6. owner authorization or live evidence still required; and
7. any real advisory findings still open.

Write those seven items under [`docs/CONTROLLED_TECHNICAL_WRITING.md`](./CONTROLLED_TECHNICAL_WRITING.md), the shared writing standard. That file holds the rules; this document does not repeat them.

The incoming agent re-verifies all seven items. It never trusts a prose handoff over the diff, tests, and current repository state.
