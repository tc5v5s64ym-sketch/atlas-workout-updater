# Atlas Automation Protocol

> **Status:** Active automation contract. Read alongside `docs/AGENT_WORKFLOW.md` (process), `docs/OWNER_CHECKIN_RULES.md` (when the owner is required), and `docs/RISK_LABELS.md` (risk classification).

This document is the **Automation Contract** for Atlas. It defines who does what, what counts as a pass, and what is allowed to merge — so that Atlas runs as an automation-first workflow where the owner is an **exception handler**, not a step in every loop.

It does not change any production application behavior, model, prompt, or write path. It is process and enforcement only.

---

## 0. Vision-first execution (north star before the queue)

Atlas is **not a backlog grinder.** Every autonomous loop builds toward the owner's Vision and Dream, in the Roadmap's sequence, within the Architecture's boundaries. Before selecting, planning, or implementing any work, the builder reads the **north-star context order** in `docs/AGENT_WORKFLOW.md` ("North-star context — read FIRST"): **Vision (`docs/ATLAS_PRODUCT_VISION.md`) → Roadmap (`docs/ROADMAP.md` directional milestones / reference) → Architecture (`docs/ARCHITECTURE.md`)**, then `CLAUDE.md` / `CONSTITUTION.md` / `INVARIANTS.md` / `ACTIVE_ROADMAP.md` / `BACKLOG.md` / `DECISION_ROUTING.md` / `OWNER_CHECKIN_RULES.md` / this file.

- **The Vision is the product north star; the Roadmap layer is the sequencing map — `docs/ROADMAP.md` holds directional milestones (reference only, not used to sequence PRs per `docs/DOCS_INDEX.md`), and live sequencing is `docs/ACTIVE_ROADMAP.md` + `BACKLOG.md`; the Architecture defines system boundaries; the Backlog is the work queue.**
- **A backlog item is eligible only if it moves Atlas toward the Vision and respects the Architecture.** If the highest-priority item does not clearly advance the Vision, or conflicts with the Roadmap/Architecture/invariants, the builder **stops and reports the conflict** instead of shipping it (a genuine-conflict escalation, §5 / `docs/OWNER_CHECKIN_RULES.md` category 4, Escalation Policy v3).
- **Vision Alignment Check is part of merge-readiness** (§4): every autonomous PR states which Vision/Roadmap/Architecture principle it advances, why this is the smallest safe step, which invariant it protects, and whether it introduces any user-facing trust change.

### Document precedence (routine execution)

For **routine** autonomous work, read in this order — not the full north-star documents:

1. `CLAUDE.md`
2. `docs/ACTIVE_ROADMAP.md`
3. `docs/DECISION_KERNEL.md` — the durable principles distilled for routine decisions.

**If `docs/ACTIVE_ROADMAP.md` has eligible work, continue roadmap execution and do not consult `BACKLOG.md` for work selection.** Only when the roadmap is exhausted:

4. `BACKLOG.md` — then run the Roadmap Refill Loop (`docs/AGENT_WORKFLOW.md`).

**Token-efficiency rule:** do **not** re-read the full `docs/ATLAS_PRODUCT_VISION.md` / `docs/ROADMAP.md` / `docs/ARCHITECTURE.md` for routine PRs — use `docs/DECISION_KERNEL.md`. Consult the full sources only when (a) the kernel is insufficient, (b) the roadmap is exhausted and refill needs full product direction, (c) a backlog promotion/refill is required, (d) a major product-direction decision is being made, (e) a trust contract changes, or (f) a genuine principle conflict exists. The Vision-first selection rule and the Vision Alignment Check still apply — they can be satisfied from the kernel for routine work.

**Operational completeness:** with the kernel in place, the Atlas automation architecture is **operationally complete**. Further process/workflow changes require **evidence of an actual bottleneck**, not a hypothetical refinement; default effort returns to building Atlas (`docs/DECISION_KERNEL.md`, "Operational completeness").

---

## 1. Roles

Atlas automation has four roles. Each has one job. None may silently assume another's.

### Claude — Builder

- Implements one approved concern per PR (see `docs/ACTIVE_ROADMAP.md` / `BACKLOG.md`).
- Runs the **Current-State Verification Gate** before editing (`docs/AGENT_WORKFLOW.md`); builds on **Opus 4.8** (no model gate).
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

### Enforcement map — who enforces each signal

So the loop is reliable, every required signal has a named enforcer. "Workflow-enforced" means a GitHub Actions job fails the PR when the signal is absent or errored; "builder-enforced" means Claude must not merge without positive evidence (§2), recording it on the merge card.

| Signal | Enforced by | Mechanism |
|---|---|---|
| Unit tests / lint / secret scan / E2E | **Workflow** | `ci.yml` jobs must conclude `success` |
| Claude Code Review | **Workflow** | `claude-code-review.yml` → "Ensure the review actually ran" guard (`is_error=false`) |
| Merge card present + filled | **Workflow** | `merge-card-check.yml` (no template placeholders) |
| Codex **Decision** answer (decision panels) | **Workflow** | `codex-decision-desk.yml` → "Ensure the desk actually answered" guard; an unanswered/errored desk fails (`docs/DECISION_ROUTING.md`) |
| CODEX **Review** verdict (`NON-BLOCKING` / `READY FOR OWNER MERGE`) | **Builder** (agent-performed review) | recorded in the merge card's **Codex status** field; a missing/`BLOCKING`/errored verdict blocks merge per §2 — there is no workflow that fabricates a verdict, and silence is never a pass |
| Risk classification | **Builder** | exactly one `docs/RISK_LABELS.md` label, recorded on the merge card |

> **CODEX Review vs. the Codex Decision Desk are two different things.** The **Decision Desk** (`codex-decision-desk.yml`) answers Claude's *decision panels* and is workflow-automated with its own enforcement guard — present and complete (it is **not** missing). **CODEX Review** is the per-PR contract-guard *verdict* (roadmap fit, scope, trust contract, write-path/schema safety); it is performed by the external Codex agent and **builder-enforced** at the merge gate via §2 — it is not produced by a workflow. If CODEX Review is ever promoted to an automated job, it must carry an "Ensure the review actually ran" guard mirroring `claude-code-review.yml`, and this map updates accordingly.

---

## 4. Merge eligibility

A PR is **merge-ready** only when ALL of the following hold. (The builder holds full merge authority and merges once these are satisfied; the owner can also merge directly.)

1. All required GitHub checks **passed** (tests, lint, secret scan, E2E as applicable).
2. All required reviews **passed** — Claude Code Review completed (real review, not errored/skipped) and CODEX Review returned `NON-BLOCKING` or `READY FOR OWNER MERGE`.
3. **No P0/P1 findings** open (see severity ladder below).
4. **No unresolved contract violations** — no open INVARIANT, trust-loop, 12-column/Effort/Constraints/Deload_State schema, or write-path-safety finding.
5. **Risk classification completed** — exactly one primary risk label applied.
6. **Merge card generated** and complete.
7. **Vision Alignment Check stated** — the merge card / PR body names the Vision/Roadmap/Architecture principle advanced, why this is the smallest safe step, the invariant protected, and whether any user-facing trust change is introduced (`docs/AGENT_WORKFLOW.md` "Vision Alignment Check"). A PR that does not clearly advance the Vision is not merge-ready — stop and report the conflict.
8. **Branch hygiene satisfied** — the PR is **one concern** on a branch cut **fresh from `main`**, carrying **only this concern's commits** (no bundled prior-session or unrelated work; `BACKLOG.md` edits limited to this PR's own item), and the **required checks actually ran** (a check that did not run is not a pass — §2; the only exception is a missing check explicitly documented in the merge card and owner-approved). **Mixed PRs and branches with unrelated commits are not merge-ready** — split them into clean one-concern PRs off `main` first. Full gate (start-clean / pre-PR / pre-merge / always-resync-after-merge): `docs/AGENT_WORKFLOW.md` "Branch hygiene gate".

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

Automation may build, test, review, classify, merge merge-ready PRs, and continue to the next task. Under **Escalation Policy v3** (`docs/OWNER_CHECKIN_RULES.md`), it has **PM authority** for any decision derivable from the Atlas docs/principles/prior accepted behavior — root-cause, fix selection, PR sizing, test design, regression strategy, refactors, parser-routing clearly derivable from principles, whether to fix a bug that clearly violates an Atlas principle, **and coach wording / rendering / frontend / UX work whose correct behavior is already determined by governance**. These are **pre-authorized**: decide and proceed, no owner and no Codex panel. **The default behavior is to continue shipping; do not escalate simply because a change touches the coach surface or UX.**

It must **stop and escalate to the owner** only for the **four reserved categories** (Escalation Policy v3):

1. **A live test only the owner can perform** — owner-initiated/advisory: flag `owner-live-test` with a script and keep going; the owner calls the hold.
2. **Changes to product vision, coaching philosophy, or new product scope** — a new user-facing capability, workflow, logging model, new trust contract, or a change to *what Atlas believes about training*. App/runtime/prompt/API **model** selection stays here (the *builder's* model is fixed at Opus 4.8 — not a stop). Coach **wording/rendering** is **not** here — that is PM authority.
3. **Destructive or irreversible operations** — Sheet/DB schema changes, data migrations, deletion/backfills/historical rewrites, credentials, or security-sensitive infrastructure.
4. **A genuine, unresolvable principle conflict** — the Decision Kernel finds two principles, or the **Vision / Roadmap / Architecture / invariants**, point to different outcomes with no documented precedent (incl. a highest-priority item that does not clearly advance the Vision). Stop and report the conflict rather than ship.

A genuinely non-derivable fork that is **not** in those four goes to the **Codex Decision Desk** (`docs/DECISION_ROUTING.md`), not the owner. When uncertain, do not default to escalation: **document the reasoning, cite the governing docs, make the smallest safe decision, and continue.**

**Bug loop:** investigate → root cause → smallest safe fix → check Atlas principles → build → test → open PR → merge if §4 authorizes it; stop only if a reserved category triggers (typically just live validation afterward).

When automation **genuinely cannot determine safety** (a real principle conflict with no precedent), that uncertainty is the trigger — it is never resolved by guessing in the safe-looking direction. Mere derivable ambiguity is **not** such a trigger: resolve it with PM authority from the docs.

> **Absolute data-safety is unchanged.** PM authority never authorizes a real production write, a data migration, or an INVARIANT/Constitution amendment — see `docs/OWNER_CHECKIN_RULES.md` "Absolute data-safety."

---

## 6. Relationship to existing docs

This protocol sits beside, and does not replace, the established Atlas rules:

- `docs/AGENT_WORKFLOW.md` — the build loop, CODEX Review action rules, verification gate, model gate.
- `CLAUDE.md` / `CODEX.md` — per-agent operating briefs and absolute safety rules.
- `docs/INVARIANTS.md` / `docs/CONSTITUTION.md` — the laws automation enforces but may never relax.
- `docs/OWNER_CHECKIN_RULES.md` — the exhaustive list of owner-required situations.
- `docs/RISK_LABELS.md` — the risk-label vocabulary and when each applies.

If this protocol ever conflicts with `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, or `docs/AGENT_WORKFLOW.md`, stop and ask the owner; the execution sources win until reconciled.
