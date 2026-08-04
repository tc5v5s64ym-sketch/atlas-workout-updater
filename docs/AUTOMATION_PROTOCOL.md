# Atlas Automation Protocol

> **Status:** Active governance contract. `CLAUDE.md` is canonical. `docs/ATLAS_V1_EXECUTION_PLAN.md` authorizes and sequences campaign work.

This protocol defines positive evidence, review roles, merge authority, and safety. It changes no Atlas runtime, prompt, schema, approval gate, or write behavior.

## Roles

### Claude — implementation and merge operator

- Runs the Current-State Verification Gate.
- Implements one canonical-plan concern per fresh branch and PR.
- Runs tests and deterministic checks, completes the merge card, and fixes real in-scope advisory findings.
- Merges the exact passing head under standing authority and continues from refreshed `main`.
- Stops only for an unresolved owner-reserved authorization.

### GitHub Actions — deterministic hard gates

Applicable required checks include build, tests, lint, wiring, secret scan, merge-card validation, E2E, and trust/write/schema tests.

A required check that is missing, stale, skipped, errored, timed out, cancelled, incomplete, or failed is a failure. An agent's claim is not a substitute for a workflow conclusion.

### Codex — advisory review

Codex may comment on PRs. Its comments are advisory, not a required status or human approval.

Claude:

- fixes real, confident, in-scope findings;
- routes a genuine non-derivable fork appropriately;
- records false alarms as non-issues; and
- never turns bot wording, reactions, or identity into a synthetic trust status.

### Decision desk and the Atlas Contract / Systems Review

ChatGPT helps Dale resolve genuinely non-derivable product/scope/trust decisions. Separately, one review lane — the Atlas Contract / Systems Review — reads a triggered PR.

**`CLAUDE.md` holds the one trigger list, the seven review questions, and the four merge-card fields.** This protocol does not restate them, because a second copy drifts.

This review does not authorize production writes and is never a GitHub status or a required check.

### Dale — owner-reserved authority

Dale owns product direction, owner-only gym/device evidence, production-data authorization, schema/destructive/security decisions, Constitution/Invariant changes, and promotion decisions. Dale may merge or revoke Claude's authority, but routine clean PRs never wait for an owner merge click.

## Positive-evidence principle

Silence is not a pass. Every required signal needs positive evidence.

| Signal | Pass requirement |
|---|---|
| Required CI | Applicable jobs conclude successfully on the current head |
| Advisory findings | Real in-scope findings fixed; false alarms explicitly dispositioned |
| Atlas Contract / Systems Review | Recorded in the merge card when a `CLAUDE.md` trigger fires: required or not, exact reviewed head, reviewer, findings and dispositions |
| Risk classification | Exactly one primary risk label |
| Merge card | Complete and current |
| Scope | One concern authorized by the canonical plan or explicit owner instruction |

A clean-context review has two distinct uses, and only one of them is a merge condition.

- **As an optional confidence device** on higher-risk work, it is not a required marker, status, account, or merge condition. Nothing changes here.
- **As the performer of the Atlas Contract / Systems Review**, when a `CLAUDE.md` trigger fires, the recorded review is a merge-card condition — the same condition it would be had ChatGPT performed it. The obligation belongs to the lane, never to the performer.

Neither use is ever a GitHub status, a required check, or a reviewer account.

## Merge authority

Claude merges when all of the following hold:

1. Every applicable required GitHub check passed on the exact current head.
2. No genuine P0/P1, invariant, trust-loop, schema, security, secret, or write-safety problem remains.
3. Real Codex/advisory findings are addressed.
4. One primary risk label, the merge card, and the Vision Alignment Check are complete.
5. The branch is current, clean, mergeable, and contains one concern.
6. The concern is authorized by `docs/ATLAS_V1_EXECUTION_PLAN.md` or an explicit owner instruction.
7. No owner-reserved authorization is outstanding.

Prefer GitHub auto-merge when available; otherwise merge the exact head SHA directly. After merge, verify `main`, confirm deployment when applicable, update campaign state, and continue from a fresh branch.

Do not stop merely to report that a routine PR is merge-ready.

## Severity handling

- **P0:** data/trust corruption, critical safety/security, write/schema/invariant break — blocks.
- **P1:** material live-path correctness or missing trust-critical regression proof — blocks.
- **P2:** safe non-blocking correctness/polish — file without expanding the PR.
- **P3:** housekeeping/wording — file only when worthwhile.

Never downgrade a real trust, safety, security, privacy, or acceptance failure to avoid blocking.

## Owner boundary

Dale is required for:

1. genuine owner-only gym/device evidence;
2. real production writes outside already-approved product use;
3. product vision, coaching philosophy, new scope, or application/runtime/provider/model changes;
4. schema, migration, deletion, credentials, or security-sensitive infrastructure;
5. Constitution/Invariant amendments;
6. One-Brain or other promotion decisions;
7. genuine unresolved principle conflicts and explicit owner holds.

Routine implementation, tests, derivable wording/UX, and clean merges remain Claude authority.

## Absolute safety

- No real Sheets write without explicit authorization.
- Dry-runs use `test_mode:true` and prove `sheet_written:false` plus `no_write_confirmed:true`.
- No manual Sheet edits by agents.
- No secret, `.env`, production Sheet ID, private evidence, or workout data in commits or PRs.
- No schema migration, historical rewrite, approval-gate weakening, parser-contract change, or proof-field change unless explicitly scoped and approved.
- Tests cover the live path or closest integration path.
- One concern per PR; discoveries go to `BACKLOG.md`.

## Relationship to active documents

- `CLAUDE.md` — canonical operating brief.
- `docs/ATLAS_V1_EXECUTION_PLAN.md` — sole campaign queue.
- `docs/AGENT_WORKFLOW.md` — branch, verification, PR, and continuation loop.
- `docs/OWNER_CHECKIN_RULES.md` — owner-reserved categories.
- `docs/DECISION_ROUTING.md` — ChatGPT decision desk.
- `docs/INVARIANTS.md` and `docs/CONSTITUTION.md` — rules no process may relax.

If active governance conflicts, reconcile it in the smallest focused docs PR. Do not create another governance layer.
