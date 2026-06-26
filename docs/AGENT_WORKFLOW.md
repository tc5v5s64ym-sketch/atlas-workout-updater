# Atlas Agent Workflow

This document defines the Atlas build workflow between Dale, ChatGPT, Claude Code, Codex Review, GitHub PRs, and GitHub checks.

## North-star context — read FIRST, every loop (Vision-first execution)

Atlas is **not a backlog grinder**. Every autonomous loop builds toward the owner's Vision and Dream, in the Roadmap's sequence, within the Architecture's boundaries. Before **selecting, planning, or implementing any work**, read, in this order:

1. **Atlas Vision** — `docs/ATLAS_PRODUCT_VISION.md` (the product **north star**)
2. **Atlas Roadmap (the sequencing layer)** — `docs/ROADMAP.md` for **directional milestones only** (historical/reference per `docs/DOCS_INDEX.md`; **NOT** used to select or sequence PRs). The **live sequencing** comes from `docs/ACTIVE_ROADMAP.md` (the active queue, #7) + `BACKLOG.md` (the work queue, #8).
3. **Atlas Architecture** — `docs/ARCHITECTURE.md` / `docs/export/atlas-architecture.html` (the **system boundary**)
4. `CLAUDE.md`
5. `docs/CONSTITUTION.md`
6. `docs/INVARIANTS.md`
7. `docs/ACTIVE_ROADMAP.md`
8. `BACKLOG.md` (the **work queue**)
9. `docs/DECISION_ROUTING.md`
10. `docs/OWNER_CHECKIN_RULES.md`
11. `docs/AUTOMATION_PROTOCOL.md`

**Operating rule.** The Vision is the product north star; the Roadmap **layer** is the sequencing map — directional milestones live in `docs/ROADMAP.md` (reference only), and the **live sequence** is `docs/ACTIVE_ROADMAP.md` + `BACKLOG.md`; the Architecture defines the system boundaries; the Backlog is the work queue. **A backlog item is valid to build only if it moves Atlas toward the Vision and respects the Architecture.** The Vision's load-bearing principles: **conversational logging · deterministic engine ownership · approve-before-write trust loop · coach restraint · depth-before-breadth training intelligence · eventual multi-user product path.**

### Routine-execution precedence (token-efficient path)

The reading list above is the **full** north-star order, required when selecting a major direction, refilling the roadmap, or resolving a principle conflict. For **routine** PR execution, read the distilled path instead:

1. `CLAUDE.md`
2. `docs/ACTIVE_ROADMAP.md`
3. `docs/DECISION_KERNEL.md` — the durable principles distilled from Vision / Roadmap / Architecture / Constitution / Invariants.

**If `docs/ACTIVE_ROADMAP.md` has eligible work, continue roadmap execution and do not consult `BACKLOG.md` for work selection.** When the roadmap is exhausted, read **4. `BACKLOG.md`** and run the Roadmap Refill Loop.

**Token-efficiency rule:** do **not** re-read the full `docs/ATLAS_PRODUCT_VISION.md` / `docs/ROADMAP.md` / `docs/ARCHITECTURE.md` for routine PR selection — `docs/DECISION_KERNEL.md` is the operational reference. Consult the full sources only when the roadmap is exhausted, a backlog promotion/refill is required, a major product-direction decision is being made, a trust contract changes, or a genuine principle conflict exists (`docs/DECISION_KERNEL.md`, "When the kernel is not enough"). The Vision Alignment Check below can be satisfied from the kernel for routine work.

### Vision Alignment Check (required before every autonomous PR)

State this on the merge card / in the PR body before opening any autonomous PR:

- **Vision/Roadmap/Architecture principle advanced** — which north-star principle this PR moves toward (name it).
- **Smallest safe step** — why this slice is the smallest safe increment of that principle.
- **Invariant protected** — which `docs/INVARIANTS.md` rule (or trust-contract guarantee) it upholds.
- **User-facing trust change** — whether it introduces any user-facing trust change (and if so, that it is owner-gated per `docs/OWNER_CHECKIN_RULES.md`).

### Selection rule (Vision-first)

When choosing the next item, take the highest-priority **eligible** backlog/roadmap item that **clearly advances the Vision** and respects the Roadmap and Architecture. If the highest-priority item does **not** clearly advance the Vision, or conflicts with the Roadmap/Architecture/invariants, **stop and report the conflict** (do not ship it) — that is a genuine-conflict escalation (`docs/OWNER_CHECKIN_RULES.md` category 4, Escalation Policy v3 / `docs/DECISION_ROUTING.md`), not a license to silently reorder product direction.

## Roles

### Dale

- Owns product direction, phase approval, and hands-on app testing.
- Starts each phase; initiates app tests (owner-initiated, not an automatic stop).
- Can merge directly, and has granted Claude Code full merge authority for merge-ready PRs under the automation-first workflow (`docs/AUTOMATION_PROTOCOL.md`); can revoke at any time.
- App-tests when he chooses to call a hold, or when review flags product risk.

### ChatGPT

- Acts as decision desk with Dale.
- Helps brainstorm, plan phases, update the roadmap, and shape Claude Code prompts.
- Reviews app-test results and turns findings into backlog/roadmap work.
- Does not merge.

### Claude Code

> **Automation-first (operative).** These bullets are reconciled to the **Autonomous Build Loop** (`docs/AUTOMATION_PROTOCOL.md`): Claude builds, tests, reviews, classifies risk, fills the merge card, **merges merge-ready PRs (it holds full merge authority)**, and continues to the next approved task — stopping only when an owner check-in criterion is met (`docs/OWNER_CHECKIN_RULES.md`) or the owner interjects. The older "opens a PR and stops / does not merge / does not start the next without owner approval" cadence is **legacy human-driven** and is superseded.

- Implements one concern per PR (Invariant PR1).
- Reads `CLAUDE.md`, `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, `docs/DOCS_INDEX.md`, and this file before starting; runs the Current-State Verification Gate.
- Opens the PR, runs tests + reviews, classifies risk, and fills the merge card.
- If review requests changes, fixes only the in-scope finding, pushes, and re-runs tests/review — it does not broaden scope, and it does not stop unless an owner check-in criterion applies.
- Holds **PM authority** (Escalation Policy v3, `docs/OWNER_CHECKIN_RULES.md`): a decision derivable from the Atlas docs/principles/prior accepted behavior is **pre-authorized** — Claude decides and proceeds, with no owner stop and no Codex panel (root-cause, fix selection, PR sizing, test design, regression strategy, refactors, principle-derivable parser-routing, fixing a clear-principle-violation bug, and coach wording/rendering/UX whose behavior is derivable from governance).
- Routes only a **genuinely non-derivable** decision panel — one the docs do not settle and that is not owner-reserved — to the **Codex Decision Desk** (`docs/DECISION_ROUTING.md`), never to the owner.
- Merges a PR once it is merge-ready (`docs/AUTOMATION_PROTOCOL.md` §4) and continues to the next approved task; refills `docs/ACTIVE_ROADMAP.md` from `BACKLOG.md` when the queue empties (Roadmap Refill Loop).
- Stops for the owner only on one of the **four reserved categories** (`docs/OWNER_CHECKIN_RULES.md` Escalation Policy v3): a live test only the owner can perform; a change to product vision / coaching philosophy / new product scope; destructive or irreversible operations (schema, migrations, deletion, credentials, security-sensitive infra); or a genuine, unresolvable principle conflict. Coach wording/rendering/UX is not a stop when derivable.

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

> **Automation-first note:** under the Autonomous Build Loop Claude does **not** stop after each CODEX Review round. It fixes in-scope blockers, re-runs tests + review, and continues; it merges once the PR is merge-ready. The "stop" steps below are the legacy human-driven cadence, reconciled inline.

If CODEX Review returns `BLOCKING` and the issue is in scope for the current PR:

1. Claude Code fixes only that issue.
2. Claude Code pushes the update.
3. GitHub checks rerun.
4. CODEX Review reruns.
5. Claude Code re-confirms green and continues — it does **not** stop unless an owner check-in criterion applies (`docs/OWNER_CHECKIN_RULES.md`).

If CODEX Review finds future-scope work:

1. Claude Code must not build it inside the current PR.
2. Claude Code adds it to `BACKLOG.md` or creates/links an issue.
3. Claude Code mentions the deferral in the PR notes.
4. Claude Code continues with the current PR / next approved task — future scope is filed, not built, and is not a stop.

If CODEX Review returns `NON-BLOCKING`:

- Claude Code may leave the finding as a note/deferred item.
- The PR is merge-ready once GitHub checks are green; **Claude merges** (it holds full merge authority — `docs/AUTOMATION_PROTOCOL.md`). Dale may also merge directly.

If CODEX Review returns `READY FOR OWNER MERGE`:

- The PR is merge-ready once GitHub checks are green; **Claude merges** under its delegated merge authority (Dale may merge directly or revoke that authority at any time).

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
10. The PR is merged once merge-ready. Under the automation-first workflow Claude Code holds full merge authority and merges (`docs/AUTOMATION_PROTOCOL.md`); Dale can merge directly or revoke that authority.
11. App tests are owner-initiated (see "Hold points" below); they do not automatically pause the loop.

> Steps 2–3 and 10–11 describe the legacy human-driven cadence; the **Autonomous Build Loop** and **Roadmap Refill Loop** below are the operative automation-first workflow.

## Autonomous Build Loop

Atlas is automation-first. The standard loop above describes the roles; this is the **loop the builder runs without owner involvement** until an owner check-in criterion is met. It is governed by `docs/AUTOMATION_PROTOCOL.md` (the automation contract), `docs/OWNER_CHECKIN_RULES.md` (when to stop for the owner), and `docs/RISK_LABELS.md` (risk classification).

For each unit of work, the builder:

1. **Read the roadmap** — `BACKLOG.md` (source of truth) and `docs/ACTIVE_ROADMAP.md` (current queue).
2. **Select the next approved task** — the next roadmap/backlog item; run the Current-State Verification Gate (below) before editing. (Build on Opus 4.8 — no model gate.)
3. **Build** — implement one concern only; file discovered future work in `BACKLOG.md` in the same PR.
4. **Run tests** — `npm test` + lint; cover the live path or closest integration path, not only new helpers.
5. **Run review** — open the PR; Claude Code Review (GitHub Actions) and CODEX Review run.
6. **Fix failures** — fix failing tests and in-scope BLOCKING / P0–P1 review findings only; do not broaden scope.
7. **Re-run tests** — confirm green after fixes.
8. **Re-run review** — confirm Claude Code Review and CODEX Review pass after fixes.
9. **Classify risk** — apply exactly one primary risk label + any category labels (`docs/RISK_LABELS.md`).
10. **Generate the merge card** — fill the PR template completely (`.github/PULL_REQUEST_TEMPLATE.md`).
11. **Decide with PM authority; escalate only the four reserved categories.** When the loop reaches a fork, first apply **Escalation Policy v3** (`docs/OWNER_CHECKIN_RULES.md`): if the answer is derivable from the Atlas docs/principles/prior accepted behavior, Claude **decides and proceeds** — no owner, no Codex panel (coach wording/rendering/UX is included here when derivable). Only a genuinely non-derivable, non-reserved fork posts a Codex Decision Request (`docs/DECISION_ROUTING.md`). Escalate to the owner **only** for the four reserved categories (a live test only the owner can perform; product vision / coaching philosophy / new product scope; destructive or irreversible operations — schema, migrations, deletion, credentials, security-sensitive infra; genuine, unresolvable principle conflict). Live app testing is **owner-initiated** — flag `owner-live-test` with a script, but do **not** halt. Otherwise mark the PR merge-ready and proceed; the next approved task starts without blocking on the owner.

### Bug-discovery routing (default — no owner stop)

When Claude discovers a bug (in a live-test report, review, or its own work), it does **not** stop to ask "should I fix this / how." It runs the loop: **investigate → produce root cause → determine the smallest safe fix → check it against Atlas principles (`docs/INVARIANTS.md` / `docs/CONSTITUTION.md` / prior accepted behavior) → build → test → open one PR → merge if `docs/AUTOMATION_PROTOCOL.md` §4 authorizes it.** A bug whose behavior **clearly violates** an Atlas principle (e.g. deterministically-loggable input routed to the coach; valid gym language unloggable; the trust path silently discarding user intent) is **pre-authorized to fix** — proceed and request only a **live validation test** afterward. Stop only if fixing it would trip a reserved category (a schema change, a new trust contract, a destructive op, or a genuine principle conflict with no precedent).

**Pass/fail principle (non-negotiable):** a review or check that was skipped, errored, was unavailable, timed out, or returned incomplete is a **failure, not a pass** (`docs/AUTOMATION_PROTOCOL.md` §2). The loop never treats a missing signal as green.

A PR is **merge-ready** only when: tests pass · required reviews pass · no open P0/P1 finding · no unresolved contract violation · risk classification done · merge card generated. Any skipped or failed required review blocks readiness.

## Branch hygiene gate (mandatory — every PR)

One concern per PR means **one branch per concern, cut fresh from `main`**. This gate is non-negotiable and applies to every PR the builder opens. (Precedent: the 2026-06-24 24-commit mixed-bundle PR, which had to be split into six clean one-concern PRs after the fact — never again.)

**Before any new work — start clean:**

1. `git checkout main`.
2. `git pull` the latest `main`.
3. Verify the working tree is **clean** (`git status` shows nothing to commit).
4. Create a **fresh branch from `main`** (`git checkout -b claude/<concern> origin/main`).
5. Verify the branch is **zero commits ahead of `main`** (`git rev-list --count origin/main..HEAD` → `0`).
6. Build **exactly one concern**.

**Before opening the PR — prove it's clean:**

1. List the changed files (`git diff --stat origin/main..HEAD`).
2. List the commits on the branch (`git log --oneline origin/main..HEAD`).
3. Verify **every commit belongs to this one concern** — no drive-by edits.
4. Verify **no prior autonomous work is bundled** — the branch contains only this PR's commits, never carry-over from an earlier session or branch. `BACKLOG.md` edits are limited to **this PR's own item**.

**Before merging — reject the unclean:**

- **Reject mixed PRs** (more than one concern).
- **Reject branches carrying unrelated or prior-session commits** not part of this concern.
- **Reject PRs where the required CI checks did not run** — a check that did not run is **not** a pass (the §2 pass/fail principle). The only exception is a missing check **explicitly documented in the merge card AND owner-approved**.

**Always:**

- **Never continue new roadmap/backlog work on an existing feature branch after its PR is opened.** A new concern means going back to "start clean" and cutting a new branch from `main` — no stacking.
- **After every merge, return to `main` and resync** (`git checkout main && git pull`) before starting the next concern.

If a branch is already dirty (mixed, or carrying prior commits), do **not** paper over it: split it into clean one-concern branches off `main` and reopen — exactly as the 2026-06-24 split did.

## Roadmap Refill Loop (continuous autonomy)

Atlas does not idle when the active roadmap is exhausted. When the active queue in `docs/ACTIVE_ROADMAP.md` is empty (every step complete), the builder — automatically, without waiting for the owner:

1. **Reviews `BACKLOG.md`** — the single source of truth for open and deferred work.
2. **Re-reads the Vision and the Dream** (`docs/ATLAS_PRODUCT_VISION.md`) and the Constitution (`docs/CONSTITUTION.md`, `docs/INVARIANTS.md`), so the refill serves the product direction and stays inside the trust contract (layering: `docs/GOVERNANCE.md`).
3. **Repopulates `docs/ACTIVE_ROADMAP.md`** — sequences the next priority-ordered, already-filed backlog items that advance the Vision/Dream into a fresh active queue (tiny, one concern each; built on Opus 4.8).
4. **Executes** the new queue through the Autonomous Build Loop above.
5. **Repeats** — when the queue empties again, refill again. Keep going until the owner says stop.

This refill draws **only** from work already in `BACKLOG.md` (which the owner curates) and orders it to serve the Vision/Dream — it is not a license to invent product direction.

**Keep an eye on the Vision and the Dream.** Each refill checks that the selected steps trace upward to the Vision and do not drift from the Dream. If the backlog no longer holds Vision-serving work — or the next meaningful direction needs a Dream/Vision/Constitution decision, or means promoting an owner-gated backlog item (`Someday / future scope`, `NEEDS DESIGN`, `Strategic direction — deferred brainstorm`, or trust-sensitive new scope) — the builder **stops and asks the owner** (`docs/OWNER_CHECKIN_RULES.md` criteria 6/8) rather than inventing scope.

## Merge gate

A PR is not ready for Dale to merge unless:

- GitHub checks are green.
- Claude Code Review has no unresolved blocker.
- CODEX Review is `READY FOR OWNER MERGE` or `NON-BLOCKING`.
- The PR matches `docs/ACTIVE_ROADMAP.md` or an explicitly approved owner task.
- No write-path/schema changes are present unless explicitly scoped.
- The **Branch hygiene gate** above is satisfied — one concern, one branch cut fresh from `main`, no bundled prior/unrelated commits, and the required checks actually ran. A mixed PR, a branch carrying unrelated commits, or a PR whose checks did not run is **not** mergeable (split it first).

## Hold points

Under the automation-first workflow, hold points are **owner-initiated**, not automatic. Claude Code does not halt the build loop for an app test on its own — it flags `owner-live-test` and includes a live test script in the merge card, then keeps going. The owner calls an app-test hold when they want one and says stop; until then, work continues.

When the owner does call a hold:

Dale app-tests.

ChatGPT interprets app-test results with Dale.

Only Dale resumes the held phase.

(Per **Escalation Policy v3** in `docs/OWNER_CHECKIN_RULES.md`, the loop stops for the owner only on one of the **four reserved categories** — a live test only the owner can perform; a change to product vision / coaching philosophy / new product scope; destructive or irreversible operations (schema, migrations, deletion, credentials, security-sensitive infra); or a genuine, unresolvable principle conflict. Everything derivable from the Atlas docs/principles — including coach wording/rendering/UX — is PM authority and does not stop the loop.)

## Compact Atlas Prompt Mode

Future owner prompts may be short because agents are expected to read the repo docs first. A compact prompt is valid only when the agent reads `CLAUDE.md`, `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, `docs/DOCS_INDEX.md`, and this file before acting.

Reading those five files is mandatory before any compact prompt is honored. If the agent has not read them, it must do so first.

### Compact prompt examples

**Continue next roadmap item**

```text
Use compact Atlas prompt mode.
Continue the next active roadmap item.
Build on Opus 4.8.
Open one small PR.
```

**Create bugfix from latest app-test failure**

```text
Use compact Atlas prompt mode.
Create a narrow bugfix PR for the latest app-test failure.
Build on Opus 4.8.
If related future work is discovered, add it to BACKLOG.md.
Open one small PR.
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
- risk level

Record this report on the merge card (built on Opus 4.8 — no model line needed). Stop for owner confirmation before editing only when an owner check-in criterion applies (`docs/OWNER_CHECKIN_RULES.md` — e.g. trust/write-path/coach/roadmap-sensitive work); otherwise proceed, open one PR, and continue through the Autonomous Build Loop.

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
   - If `STILL BROKEN`, proceed to implement (on Opus 4.8).
   - If `PARTIALLY FIXED`, scope only the remaining gap.
   - If `FIXED BUT UNTESTED`, do not refactor; add the smallest regression test.
   - If `ALREADY FIXED` or `STALE / SUPERSEDED`, do not edit code; update `BACKLOG.md`/issue/roadmap status only.
   - If `NEEDS OWNER APP-TEST`, stop.

Hard rule: A Claude/Codex agent must not begin implementation simply because a backlog item or issue exists. Existence of a task is not proof the bug still exists.

If a stale item is discovered, the same PR should either:

- update `BACKLOG.md` / `docs/ACTIVE_ROADMAP.md` to mark it resolved, deferred, or superseded, or
- add a GitHub issue comment explaining the current-state verdict.

The builder runs on Opus 4.8 for all work — there is no model gate after this verification gate.

## gstack Skills (judgment-driven)

Atlas assumes gstack is installed in Claude Code. Before beginning each phase, determine whether an installed gstack skill would improve the work and use the most appropriate skill(s) when they add value. Not every task requires a skill; do not invoke them mechanically.

```
Read project docs  →  Apply applicable gstack skill(s)  →  Investigate / Plan  →  Implement  →  Self-review  →  Tests  →  PR
```

In cases of conflict, Atlas governance takes precedence: follow `CLAUDE.md`, `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, owner decisions, and Atlas trust-first development principles.

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
