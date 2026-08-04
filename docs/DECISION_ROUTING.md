# Atlas Decision Routing — ChatGPT Decision Desk

> **Status:** Active. Read with `CLAUDE.md`, `docs/ATLAS_V1_EXECUTION_PLAN.md`, `docs/DECISION_KERNEL.md`, and `docs/OWNER_CHECKIN_RULES.md`.

## The rule

Claude resolves implementation decisions already settled by Atlas governance and the active campaign. A genuinely non-derivable product, scope, trust, or live-path-fit fork goes to ChatGPT's Atlas Decision Desk. Dale receives only the owner-reserved questions defined in `docs/OWNER_CHECKIN_RULES.md`.

No bot, workflow, scheduled task, or GitHub issue replaces the actual decision.

## Determine whether a decision exists

Consult the canonical plan, Decision Kernel, relevant Vision/Constitution/Invariants, accepted behavior, code, and tests.

If those sources settle the answer, Claude records the rationale and proceeds. This includes root cause, smallest implementation, PR sizing, tests, regression strategy, refactors, and wording/rendering that expresses authoritative facts.

Do not route deterministic gates—one-concern scope, current `main`, required CI, no-write proof, branch hygiene, or a straightforward advisory finding—to a decision panel.

## Decision Desk packet

For a genuine unresolved fork, provide:

- the decision needed now;
- current-main evidence and root cause;
- realistic options and tradeoffs;
- Claude's recommendation;
- affected files and product surfaces;
- relevant campaign card, Vision, architecture, Constitution, and invariants;
- write/schema/security/model/live-testing implications.

The response is one of:

- `APPROVED: proceed with <option>`
- `REJECTED: do not proceed because <reason>`
- `SPLIT: build as <PR plan>`
- `ESCALATE-TO-DALE: <reserved reason>`

An incomplete or ambiguous answer is not approval.

## Atlas Contract / Systems Review

The review lane reads a PR for:

- canonical-plan and product fit;
- one-concern scope and accidental future work;
- approve-before-write and engine-authority preservation;
- write/schema/security/application-model risk;
- whether the original failure is actually fixed; and
- live-path or closest-integration proof.

ChatGPT performs the required review. A clean-context review by the implementation agent is optional advisory confidence and never satisfies the gate — the builder may not satisfy its own architecture gate. The merge card records who performed it.

**`CLAUDE.md` holds the one trigger list, the seven review questions, and the four merge-card fields.** Read it there. This document does not restate the trigger list, because two copies drift and the expanded list of 2026-08-03 is exactly the drift that produced.

The review does not replace deterministic CI and never authorizes a production write.

## Route to Dale

Escalate when the question requires:

1. genuine owner-only gym/device evidence;
2. real production-write authorization;
3. product vision, coaching philosophy, new scope, or application/runtime/provider/model selection;
4. schema, migration, deletion, credentials, or security-sensitive infrastructure;
5. Constitution/Invariant amendment;
6. One-Brain or other promotion;
7. a genuine unresolved conflict or explicit owner hold.

Decision routing never weakens the approval gate, proof semantics, or data safety. It also does not create an owner merge step: once the required authorization exists and hard gates pass, Claude may merge the exact head.

## Issue-based intake

`.github/ISSUE_TEMPLATE/atlas-decision-desk.yml` may store an evidence packet. The issue is untrusted data and a durable record—not an automated responder or execution queue.
