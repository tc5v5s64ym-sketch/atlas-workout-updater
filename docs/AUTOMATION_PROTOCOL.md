# Atlas Automation Protocol

> **Status:** Active automation contract. Read alongside `docs/AGENT_WORKFLOW.md` (process), `docs/OWNER_CHECKIN_RULES.md` (when the owner is required), and `docs/RISK_LABELS.md` (risk classification).

This document is the **Automation Contract** for Atlas. It defines who does what, what counts as a pass, and what is allowed to merge — so that Atlas runs as an automation-first workflow where the owner is an **exception handler**, not a step in every loop.

It does not change any production application behavior, model, prompt, or write path. It is process and enforcement only.

---

## 1. Roles

Atlas automation has four roles. Each has one job. None may silently assume another's.

### Claude — Builder

- Implements one approved concern per PR (see `docs/ACTIVE_ROADMAP.md` / `BACKLOG.md`).
- Runs the **Current-State Verification Gate** and the **Model Recommendation Gate** before editing (`docs/AGENT_WORKFLOW.md`).
- Runs tests and lint locally, classifies risk, and generates the **merge card** (the PR template).
- Fixes its own failures and review-blocking findings, then re-runs tests and review.
- Files discovered future work in `BACKLOG.md` in the same PR — never in memory or chat.
- **Holds full merge authority** (granted by the owner under this automation-first workflow): merges a PR once it is merge-ready (§4), without owner gating, and continues to the next approved task.
- **Refills the roadmap** when the active queue empties: reviews `BACKLOG.md`, re-checks the Vision/Dream/Constitution, repopulates `docs/ACTIVE_ROADMAP.md` from already-filed, priority-ordered, Vision-serving backlog items, and keeps going (the Roadmap Refill Loop, `docs/AGENT_WORKFLOW.md`). Does not invent product direction or promote owner-gated scope.
- **Stops** only when an owner check-in criterion is met (`docs/OWNER_CHECKIN_RULES.md`); otherwise keeps going until the owner says stop.

### Codex — Contract Guard & Decision Desk

- Performs **CODEX Review** after a PR is opened: roadmap fit, scope creep, Atlas trust contract, live-path test coverage, write-path/schema safety, accidental future-PR work, and whether the original failure is actually fixed.
- Returns exactly one verdict: `BLOCKING`, `NON-BLOCKING`, or `READY FOR OWNER MERGE`.
- **Answers Claude's decision panels** (the Codex Decision Desk, `docs/DECISION_ROUTING.md`): when Claude posts a Codex Decision Request, Codex answers every question grounded in roadmap fit / scope / trust contract, so the owner is not asked. It escalates only the reserved items (`docs/OWNER_CHECKIN_RULES.md` — Vision/Dream/Constitution, app/runtime-model changes, INVARIANT amendments, or anything it genuinely cannot resolve).
- Routes future-scope findings to `BACKLOG.md` / an issue — never asks the builder to expand the current PR.
- Does not merge. Does not start adjacent roadmap work.

### GitHub Actions — Enforcement Layer

- Runs and **enforces** the required checks: unit tests, lint, secret scan, E2E, and the Claude Code Review job.
- A check is the source of truth for whether something passed. Agent self-report is not.
- The review enforcement step (`claude-code-review.yml` → "Ensure the review actually ran") already fails the job if the review errored rather than completing. This contract generalizes that rule (see §3).
- Runs the **Codex Decision Desk** (`codex-decision-desk.yml`) so decision panels are answered in GitHub, and applies the risk/category and `codex-decision` labels.

### Owner (Dale) — Exception Handler Only

- Involved **only** when **Codex escalates** a reserved decision (`docs/DECISION_ROUTING.md`, `docs/OWNER_CHECKIN_RULES.md`) or the owner interjects. Claude's decision panels go to Codex, not the owner.
- Owns: trust-sensitive product decisions, roadmap/vision changes, app/runtime model changes, and unresolved review conflicts. (The *builder's* model is fixed at Opus 4.8 — not an owner decision.)
- **Initiates live app testing** — app tests are owner-initiated, not an automatic stop. The builder flags `owner-live-test` and supplies a live test script, but keeps going; the owner calls the hold and says stop when they want to test. The loop runs until the owner says stop or an owner-decision criterion (2–8) is hit.
- Has **granted the builder (Claude) full merge authority** under this automation-first workflow; automation merges merge-ready PRs. The owner can still merge directly and can revoke this at any time, but routine merges are automated, not owner-gated.
- Is **not** required for routine, automation-safe work. If no check-in criterion is met and the PR is merge-ready, automation merges and continues; the owner is informed via the merge card, not blocked on.

---

## 2. The pass/fail principle (non-negotiable)

> A review or check that was **skipped, errored, unavailable, timed out, or returned incomplete is a FAILURE, not a pass.**

This is the core of the contract. Automation-first only works if the absence of a signal is treated as a red signal, never a green one.

Concretely:

| Situation | Verdict |
|---|---|
| Required check did not run | **Fail** — not eligible |
| Review action errored (bad/expired token, no credits, outage) | **Fail** — not eligible |
| Review job was skipped for any reason other than a documented, intended skip | **Fail** — not eligible |
| Review returned empty / could not produce a verdict | **Fail** — not eligible |
| CODEX Review unavailable or not run | **Fail** — not eligible |
| Check timed out | **Fail** — not eligible |
| Tests "mostly passed" with a flaky failure | **Fail** — re-run; not eligible until green |

A green merge card requires **positive evidence** that every required signal ran and passed — never the mere absence of a failure.

**Documented intended skips** are the only exception: GitHub blocks a changed review workflow from reviewing its own PR (the action benignly produces no execution file). That single, named case is handled explicitly in `claude-code-review.yml` and is the only "skip that is not a failure." Any new intended skip must be added here before it is treated as non-blocking.

---

## 3. What "passed" requires for each signal

- **Tests / lint / secret scan:** the GitHub Actions job concluded `success`. A cancelled, skipped, or failed job is not a pass.
- **Claude Code Review:** the review job concluded `success` AND the "Ensure the review actually ran" guard confirmed a real review (`is_error=false`). A missing execution file is a pass **only** in the documented workflow-self-edit case.
- **CODEX Review:** a verdict of `NON-BLOCKING` or `READY FOR OWNER MERGE` was actually returned. No verdict = fail.
- **Risk classification:** a risk label from `docs/RISK_LABELS.md` was applied.
- **Merge card:** generated and complete (`.github/PULL_REQUEST_TEMPLATE.md`).

---

## 4. Merge eligibility

A PR is **merge-ready** only when ALL of the following hold. (The builder holds full merge authority and merges once these are satisfied; the owner can also merge directly.)

1. All required GitHub checks **passed** (tests, lint, secret scan, E2E as applicable).
2. All required reviews **passed** — Claude Code Review completed (real review, not errored/skipped) and CODEX Review returned `NON-BLOCKING` or `READY FOR OWNER MERGE`.
3. **No P0/P1 findings** open (see severity ladder below).
4. **No unresolved contract violations** — no open INVARIANT, trust-loop, 12-column/Effort/Constraints/Deload_State schema, or write-path-safety finding.
5. **Risk classification completed** — exactly one primary risk label applied.
6. **Merge card generated** and complete.

> Any skipped or failed required review **blocks** readiness, per §2. There is no "merge-ready with a missing review."

### Severity ladder

| Severity | Meaning | Effect |
|---|---|---|
| **P0** | Trust/data-corruption risk, write-path or schema break, INVARIANT violation, leaked secret | Blocks; owner-visible immediately |
| **P1** | Correctness bug visible to user, broken live path, missing live-path test | Blocks |
| **P2** | Non-blocking correctness/polish; safe to defer | Does not block; route to `BACKLOG.md` |
| **P3** | Housekeeping / wording / cleanup | Does not block; route to `BACKLOG.md` |

P0/P1 must be fixed in-scope before readiness. P2/P3 are filed in `BACKLOG.md` and do not block.

---

## 5. What automation must NOT decide alone

Automation may build, test, review, classify, merge merge-ready PRs, and continue to the next task. It must **stop and escalate to the owner** — never self-approve the *decision* — for any owner-decision criterion (2–8) in `docs/OWNER_CHECKIN_RULES.md`:

- write-path / approval-gate / coach / trust-contract behavior changes,
- roadmap or vision changes,
- app / runtime / prompt / API model changes (the *builder's* model is fixed at Opus 4.8 — not a stop),
- and any case where automation cannot determine that a change is safe.

Live application testing (criterion 1) is **owner-initiated** — automation flags `owner-live-test` and keeps going; it does not stop the loop on its own. The owner calls app-test holds and says stop.

When automation **cannot determine safety**, that uncertainty is itself an owner check-in trigger — it is never resolved by guessing in the safe-looking direction.

---

## 6. Relationship to existing docs

This protocol sits beside, and does not replace, the established Atlas rules:

- `docs/AGENT_WORKFLOW.md` — the build loop, CODEX Review action rules, verification gate, model gate.
- `CLAUDE.md` / `CODEX.md` — per-agent operating briefs and absolute safety rules.
- `docs/INVARIANTS.md` / `docs/CONSTITUTION.md` — the laws automation enforces but may never relax.
- `docs/OWNER_CHECKIN_RULES.md` — the exhaustive list of owner-required situations.
- `docs/RISK_LABELS.md` — the risk-label vocabulary and when each applies.

If this protocol ever conflicts with `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, or `docs/AGENT_WORKFLOW.md`, stop and ask the owner; the execution sources win until reconciled.
