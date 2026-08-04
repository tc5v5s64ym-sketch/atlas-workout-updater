# Atlas Agent Workflow

This document defines how Dale, ChatGPT, the active implementation agent, GitHub, and the repository execute Atlas work. `CLAUDE.md` is the canonical detailed rulebook; `docs/BUILDER_PORTABILITY.md` maps its legacy tool-specific wording; `docs/ATLAS_V1_EXECUTION_PLAN.md` selects the work.

## Read order

For routine work:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/BUILDER_PORTABILITY.md`
4. `docs/ATLAS_V1_EXECUTION_PLAN.md`
5. `docs/DECISION_KERNEL.md`
6. `BACKLOG.md` for awareness and deferred discoveries
7. this workflow and the relevant specs/invariants/tests

Historical plans, audits, proposals, chat transcripts, and Git history never select the next PR.

## Roles

### Dale

Owns product direction, real production-data authorization, owner-only gym/device evidence, destructive/schema/security decisions, Constitution/Invariant changes, and One-Brain promotion. Dale may merge or revoke authority, but routine PRs do not wait for him to click merge.

### ChatGPT

Acts as Atlas's project decision desk. It resolves genuinely non-derivable product/scope/trust forks with Dale, and it performs the required Atlas Contract / Systems Review. A clean-context review by the implementation agent is advisory only and never satisfies that gate. `CLAUDE.md` holds the one trigger list.

### Active implementation agent — Claude Code or Codex

The assigned builder runs the current-state gate, implements one card/concern on a fresh branch, tests it, opens the PR, addresses real in-scope advisory findings, merges the exact passing head under standing authority, updates campaign state when required, refreshes `main`, and continues.

Claude Code and Codex have identical implementation and merge authority. Tool identity never changes an owner-reserved gate. See `docs/BUILDER_PORTABILITY.md` for the legacy wording map and switch protocol.

### GitHub and independent review

GitHub Actions supplies deterministic hard gates. A missing, stale, skipped, errored, timed-out, cancelled, incomplete, or failed required check is a failure.

Independent agent review—Codex reviewing Claude, Claude reviewing Codex, or another clean-context review—is advisory only. The active builder fixes confident, real, in-scope findings; files non-blocking future work when authorized; and records false alarms without creating a synthetic status gate.

## Standard campaign loop

1. Fetch/verify current `main`, confirm the worktree is clean, inspect open/recent PRs, and identify the first eligible unfinished card in `docs/ATLAS_V1_EXECUTION_PLAN.md`.
2. Run the Current-State Verification Gate before editing.
3. Create a fresh `agent/<concern>` branch from current `main`. Existing `claude/*` branches remain valid historical branches but are not the default for new work.
4. Implement one concern only.
5. Run focused tests, the full applicable suite, lint/build/wiring/secret checks, and the live path or closest integration path.
6. Inspect the diff, commits, secrets, and unrelated drift.
7. Push and open one PR with the Atlas Merge Card and one primary risk label.
8. Obtain the Atlas Contract / Systems Review when a trigger in `CLAUDE.md` fires, and record it in the merge card.
9. Address real in-scope advisory findings. Do not widen the PR.
10. When every required deterministic check passes and no genuine blocker remains, merge the exact head. Do not stop merely to say it is merge-ready.
11. Verify `main` and deployment when applicable, update the campaign card/completion record, and continue from a fresh branch.

A long or exhausted chat session is not a blocker. The repository is the handoff: start a fresh session and resume from repository state.

## Current-State Verification Gate

Before implementation, report:

1. **Source:** canonical plan card and supporting finding/issue.
2. **Duplicate/stale search:** current code, tests, backlog, recent PRs/issues, and deployed behavior where relevant.
3. **Verdict:** exactly one of:
   - `STILL BROKEN`
   - `ALREADY FIXED`
   - `PARTIALLY FIXED`
   - `FIXED BUT UNTESTED`
   - `STALE / SUPERSEDED`
   - `NEEDS OWNER APP-TEST`
4. **Evidence:** exact file/function/test/PR/issue and failure/fix path.
5. **Allowed next action:** smallest implementation, tests/evidence only, status-only update, or stop.

If already fixed, do not implement. If fixed but untested, add proof rather than refactoring. A card's existence is not proof that work remains.

## Branch and scope hygiene

- New work begins on `agent/<concern>` from current `main` regardless of builder.
- Never run Claude and Codex on the same concern in parallel.
- Never inherit another agent's branch without verifying its head, diff, PR state, and current `main`.
- One PR equals one concern.
- Never stack the next card on an open/merged feature branch.
- Stage only intended files; never include `.env`, credentials, production evidence, Sheet IDs, private workout data, or unrelated work.
- High-risk files (`index.js`, `src/app/app.js`, `services/workoutTextParser.js`) may be touched only when the active card requires them, with a tiny focused diff and live-path tests.
- If the fix spreads, split it. Do not paper over scope drift.

## Merge gate

The active implementation agent may merge when:

- every applicable required GitHub check passed on the exact current head;
- real advisory findings are fixed or explicitly judged non-issues;
- the PR implements one canonical-plan concern or explicit owner instruction;
- branch hygiene, risk label, Vision Alignment Check, and merge card are complete;
- no unresolved P0/P1, invariant, trust-loop, schema, security, or write-safety defect remains; and
- no owner-reserved authorization is outstanding.

Prefer auto-merge when available; otherwise merge the exact head SHA directly. Never merge with missing or failed required checks.

A clean-context review is optional confidence work, not a required marker, status, account, or human sign-off.

## Owner-reserved stops

Stop for Dale only when the work requires:

- genuine owner-only gym/device evidence;
- real production-write authorization;
- product vision, coaching philosophy, new scope, or application/runtime/provider/model selection;
- schema, migration, deletion, credentials, or security-sensitive infrastructure;
- Constitution/Invariant amendment;
- One-Brain or other promotion;
- an explicit owner hold or genuine unresolved governance conflict.

Routine code, tests, derivable UX/wording, refactors, and clean merges are not owner stops.

## Live testing

Read `docs/AGENT_LIVE_TESTING.md` and local `.env` rather than asking Dale for known URLs/keys/sheet details.

- Tier 1 read-only and Tier 2 `test_mode` dry-run tests are pre-authorized.
- Tier 3 real writes require explicit per-test authorization.
- Always mark synthetic traffic as required by the testing playbook.
- Never fabricate owner/gym evidence or GATE A eligible traffic.
- Any production data-integrity anomaly freezes writes and returns control to Dale.

## Campaign maintenance

- Update the active card when work merges or a premise is proven stale.
- File adjacent discoveries in `BACKLOG.md`; do not add them to the campaign without an explicit owner-approved plan change.
- Do not create a second roadmap, fix-it doc, or session master plan.
- When a genuine new precedent appears, update only the smallest relevant governance document.

## Builder switch

Use `docs/BUILDER_PORTABILITY.md`. The default is to switch only after the current concern is merged or explicitly abandoned. Repository state, not a custom handoff prompt, carries the work.

## Compact launcher

> Read `AGENTS.md`, `CLAUDE.md`, `docs/BUILDER_PORTABILITY.md`, and `docs/ATLAS_V1_EXECUTION_PLAN.md`. Act as the active Atlas implementation agent. Verify current state and open PRs before editing, execute the first eligible unfinished concern on a fresh `agent/<concern>` branch, run every applicable deterministic gate, merge the exact passing head under standing authority, update campaign state when required, refresh `main`, and continue. Stop only for an explicit owner-reserved gate.
