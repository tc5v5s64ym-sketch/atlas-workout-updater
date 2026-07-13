# Atlas Agent Workflow

This document defines the active workflow between Dale, ChatGPT, Codex,
GitHub, and the repository's required checks. It changes no Atlas product,
runtime, prompt, model, schema, or write-path behavior.

## North-star and execution order

Atlas is not a backlog grinder. Work must advance the Vision, follow the active
sequence, respect Architecture, and preserve the Constitution and Invariants.

For routine implementation read, in order:

1. `AGENTS.md`
2. `docs/ACTIVE_ROADMAP.md`
3. `docs/DECISION_KERNEL.md`
4. `BACKLOG.md` for awareness and deferred work
5. this workflow and the relevant specs/invariants

If the active roadmap has eligible work, select from it. Use `BACKLOG.md` for
work selection only when the roadmap is exhausted and Dale has authorized the
next direction. Historical plans are never execution queues.

Every PR records a short Vision Alignment Check: the principle advanced, why
this is the smallest safe step, the invariant protected, and whether it changes
user trust. A conflict between Vision, roadmap, architecture, or invariants is
owner-reserved; stop and report it.

## Roles

### Dale

- Owns product direction, owner-reserved decisions, production promotion, and
  real-data authorization.
- Is the only person allowed to merge a PR.
- May request live app or gym validation and is the only authority that can
  resume an explicit owner hold.

### ChatGPT

- Is Atlas's product decision desk with Dale.
- Performs the external **Atlas Contract Review** after a PR is open: roadmap
  fit, one-concern scope, product intent, Atlas trust contract, live-path fit,
  write/schema risk, and accidental future work.
- Returns `BLOCKING`, `NON-BLOCKING`, or `READY FOR DALE MERGE`.
- Does not replace native Codex GitHub Review.

### Codex implementation agent

- Runs the Current-State Verification Gate before editing.
- Implements one approved concern on a fresh `codex/*` or `agent/*` branch.
- Runs tests/lint, opens the PR, completes the merge card, and addresses only
  in-scope blockers.
- Requests current-head native review with `@codex review` after the final push.
- Never merges, enables auto-merge, or starts adjacent work on the PR branch.

### Native Codex GitHub Review

- Is the mandatory correctness/security review lane.
- Reviews the exact current head for correctness, security, invariant,
  schema, write-safety, trust-loop, and live-path test regressions.
- Is read-only and independent of the implementing Codex session.

### GitHub and GitHub Actions

- GitHub is the PR handoff bus.
- Required checks enforce normal deterministic CI: tests, lint, secret scan,
  E2E where applicable, and merge-card completeness. Native Codex GitHub Review
  is a separate GitHub review lane, not a custom status check.
- A skipped, errored, unavailable, timed-out, or incomplete required check is a
  failure, not a pass.

## Standard PR loop

1. Verify latest `origin/main`, named prerequisite PRs, and a clean worktree.
2. Run the Current-State Verification Gate.
3. Create a fresh `codex/<concern>` or `agent/<concern>` branch.
4. Implement exactly one approved concern.
5. Run relevant tests and lint; prove the live path or closest integration path.
6. Inspect scope, diff, commits, secrets, and unrelated-file drift.
7. Push and open one PR with a complete Atlas Merge Card.
8. Obtain the external ChatGPT Atlas Contract Review.
9. Address only in-scope blocking findings; file authorized future work without
   expanding the PR.
10. After the final push, comment `@codex review`, wait for the exact-head native
    Codex result, resolve every actionable review conversation, and confirm the
    normal required checks.
11. When every merge-readiness gate is satisfied, report `READY FOR DALE MERGE`
    and stop. Dale alone decides whether and when to merge.

Any new push invalidates the prior native review. Re-run tests as appropriate,
request `@codex review` again, and re-check the exact head.

### Required-check failure loop

A failed required CI check or actionable review finding sends the same PR back
through diagnosis, smallest in-scope correction, verification, push, and
current-head review. Codex continues that loop until normal required checks pass
and all actionable review conversations are resolved; it does not stop after
merely reporting the failure. Stop only for a genuine owner-reserved decision,
an external blocker Codex cannot change, or an explicit owner instruction to
stop.

## Current-State Verification Gate

Before implementation, verify whether the reported failure still exists in
current code. The pre-edit report must include:

1. **Source:** roadmap step, backlog item, issue, bug ID, or owner instruction.
2. **Duplicate/stale search:** `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, current
   code/tests, and relevant open/recently merged PRs or issues.
3. **Verdict:** exactly one of:
   - `STILL BROKEN`
   - `ALREADY FIXED`
   - `PARTIALLY FIXED`
   - `FIXED BUT UNTESTED`
   - `STALE / SUPERSEDED`
   - `NEEDS OWNER APP-TEST`
4. **Evidence:** exact file/function/test/PR/issue and the current failure path or
   fix location.
5. **Allowed next action:** smallest implementation, test-only change,
   status/docs-only update, or stop.

If `ALREADY FIXED`, do not implement. If `FIXED BUT UNTESTED`, do not refactor.
If the premise is wrong, report it. A task's existence is not proof it remains
valid. Bug IDs also require `docs/BUG_TRIAGE_LEDGER.md` verification.

## Branch hygiene gate

Before work:

- fetch latest `origin/main`;
- verify the worktree is clean;
- create a fresh `codex/*` or `agent/*` branch from `origin/main`;
- verify the new branch begins zero commits ahead of `origin/main`.

Before the PR:

- inspect `git diff --stat origin/main..HEAD` and
  `git log --oneline origin/main..HEAD`;
- prove every file and commit belongs to the one concern;
- do not carry prior-session, stacked, or unrelated work;
- do not stage private files or broad `BACKLOG.md` edits.

If a branch is mixed, split it into clean one-concern branches. Never paper over
scope drift. After Dale merges, a later concern starts from newly fetched main;
it never continues on the merged feature branch.

## Decision routing

Codex may make implementation decisions already settled by Atlas governance:
root cause, smallest fix, PR sizing, test design, regression strategy, and
principle-derivable wording/rendering. Document the reasoning and proceed.

A genuinely non-derivable product/scope/trust fork goes to ChatGPT's Atlas
Decision Desk (`docs/DECISION_ROUTING.md`). The owner is required for:

1. a live test only Dale can perform;
2. product vision, coaching philosophy, new product scope, or application/runtime
   model changes;
3. destructive or irreversible work, including schema, migrations, deletion,
   credentials, or security-sensitive infrastructure; or
4. a genuine unresolved conflict between governing principles.

Decision routing never authorizes a production write, weakens the approval gate,
or transfers merge authority.

## Merge gate

A PR may be described as `READY FOR DALE MERGE` only when:

- every required GitHub check passed;
- the exact current head has a completed native Codex GitHub Review requested
  after the final push with `@codex review`;
- every actionable review conversation and unresolved contract violation is
  resolved;
- ChatGPT Atlas Contract Review is `NON-BLOCKING` or
  `READY FOR DALE MERGE`;
- the PR matches the active roadmap or explicit owner scope;
- branch hygiene, one-concern scope, risk label, Vision Alignment Check, and
  merge card are complete; and
- owner-reserved items are resolved.

Merge-ready is a handoff state. It grants no merge permission to Codex or any
automation. Dale alone merges.

## Hold points and live validation

Owner live tests are explicit holds only when Dale calls them. Supply a script
and report the need; do not silently convert an advisory live test into merge
authority or a production-write grant. Gym-gated evidence remains owner-only.

The standing agent-performed production-verification amendment in
`docs/OWNER_CHECKIN_RULES.md` remains unchanged: read-only/dry-run by default;
test-marked same-session-reverted writes are last resort; production data
integrity anomalies stop all writes and require Dale.

## Compact prompt mode

Short owner prompts are valid only after reading `AGENTS.md`, `BACKLOG.md`,
`docs/ACTIVE_ROADMAP.md`, `docs/DOCS_INDEX.md`, and this file. A model name is
not required. Compact prompts never waive current-state verification, scope,
tests, review lanes, safety, or Dale's sole merge authority.

## Tooling

Use available skills and tools when they improve investigation, planning,
review, QA, or publication. Atlas governance always wins. Tooling must not add
scope, create background work, weaken safety, or merge.

## Non-negotiables

- One PR equals one concern.
- `codex/*` or `agent/*` branches only for new agent work.
- Tests prove the previous failure cannot recur through the live or closest
  integration path.
- No write-path, schema, parser grammar, progression-math, approval-gate, or
  trust-contract change unless explicitly scoped and approved.
- The deterministic engine decides; the application LLM explains.
- Native Codex GitHub Review and ChatGPT Atlas Contract Review are distinct and
  both required.
- Dale is the only merge authority.
