# Atlas Agent Compatibility Adapter

Claude Code and Codex are both approved Atlas implementation agents. The active builder for a task has the same implementation, PR, and merge authority; the tool name does not change the safety contract.

Read in this order:

1. [`CLAUDE.md`](CLAUDE.md) — canonical Atlas operating and safety brief.
2. [`docs/BUILDER_PORTABILITY.md`](docs/BUILDER_PORTABILITY.md) — compatibility mapping for switching between Claude Code and Codex.
3. [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md) — sole active work-selection authority.
4. Relevant specs, invariants, tests, and evidence ledgers.

Compatibility rule: wherever `CLAUDE.md` or another active governance document says **Claude** as the implementation or merge operator, read it as **the active implementation agent (Claude Code or Codex)**. Wherever it says **Codex review/comments are advisory**, read that as **independent agent review is advisory**; Codex is not reduced to reviewer status when Codex is the active builder.

This file adapts tool-specific wording only. It defines no independent product, safety, branch, merge, or sequencing rules. The execution plan still selects the work, deterministic GitHub checks remain the hard gates, and all owner-reserved stops remain unchanged.

Use `agent/<concern>` for new branches regardless of builder. Do not continue another agent's stale branch without first verifying current `main`, open PRs, and the Current-State Verification Gate.

At a glance: run `npm run atlas:status` (`-- --json` for machine output). The same bounded, redacted status is available at `GET /.well-known/atlas-status.json`; see [`docs/ATLAS_OPERATIONS_CONTRACT.md`](docs/ATLAS_OPERATIONS_CONTRACT.md). No Sheet ID or tab names need to be supplied. For the newest genuine owner app session, run `npm run atlas:review-live` (`-- --json`).
