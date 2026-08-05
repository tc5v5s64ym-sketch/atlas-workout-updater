# Atlas Agent Entrypoint

This is the universal entrypoint. Every implementation agent starts here, on every surface.

Atlas work is implemented by the **approved active implementation agent** — the one agent Dale has approved to implement Atlas work at a given time. It is a role, not a product name. Claude Code, Codex, Cursor, and any other owner-approved implementation surface may hold it, running whichever model that surface runs. [`CLAUDE.md`](CLAUDE.md) carries the canonical definition; this file does not restate it.

The surface and the model change nothing. Branch rules, one-concern discipline, the Current-State Verification Gate, testing requirements, trust contracts, owner-reserved stops, the exact-head Atlas Contract / Systems Review, and merge authority are identical for every agent that holds the role.

Read in this order:

1. [`CLAUDE.md`](CLAUDE.md) — canonical Atlas operating and safety brief. It holds the definition above, the merge gate, and the merge-card attribution rule.
2. [`docs/BUILDER_PORTABILITY.md`](docs/BUILDER_PORTABILITY.md) — the portability contract: legacy wording map, repository-state handoff, and the fresh-agent cold-start acceptance trial.
3. [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md) — sole active work-selection authority.
4. [`docs/CONTROLLED_TECHNICAL_WRITING.md`](docs/CONTROLLED_TECHNICAL_WRITING.md) — the one writing standard for plans, reviews, failure reports, handoffs, and implementation summaries. Controlled technical writing inspired by ASD-STE100; no formal ASD-STE100 compliance is claimed. The rules live only in that file.
5. Relevant specs, invariants, tests, and evidence ledgers.

Legacy wording map: wherever an active governance document says **Claude** as the implementation or merge operator, read it as **the approved active implementation agent**. Wherever it says **Codex review or comments are advisory**, read it as **independent agent review is advisory**; no agent is reduced to reviewer status when it is the active builder. `CLAUDE.md` keeps its filename for historical continuity and stays the canonical brief. There is no second canonical brief.

Roles that never move: Dale owns product direction, owner-only evidence, production-write authorization, schemas, destructive changes, security and credentials, runtime/provider/model selection, and final phase progression. ChatGPT is Atlas's architectural owner and decision desk, and ChatGPT performs the required Atlas Contract / Systems Review whenever a trigger fires. An implementation agent never satisfies that gate with its own clean-context review.

This file adapts entry and wording only. It defines no independent product, safety, branch, merge, or sequencing rules. The execution plan still selects the work, deterministic GitHub checks remain the hard gates, and every owner-reserved stop is unchanged.

Use `agent/<concern>` for new branches on every surface. Existing `claude/*` branches stay valid historical branches. Do not continue another agent's stale branch without first verifying current `main`, open PRs, and the Current-State Verification Gate. Two agents never implement the same concern at the same time.

Declare your builder surface and model in the Atlas Merge Card. `CLAUDE.md` holds the four required attribution fields and the rule that a model identity is reported, never guessed.

## Compact launcher

This is the one implementation launcher. Do not write a second one.

> Read `AGENTS.md` and execute the first eligible unfinished Atlas concern as the approved active implementation agent. Use a fresh `agent/<concern>` branch. Stop only for an owner-reserved gate or required external review.

"First eligible unfinished concern" means the first eligible unfinished card in [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md), and nothing else. Never select work from `BACKLOG.md`, a retired plan, an audit, a proposal, a standalone issue, Git history, or a chat transcript while the plan has eligible work.

## Cold-start acceptance trial

A fresh agent with no prior chat history proves it can start from repository state alone. The trial is read-only and it is documented in [`docs/BUILDER_PORTABILITY.md`](docs/BUILDER_PORTABILITY.md).

> Read `AGENTS.md` and perform the documented Atlas fresh-agent cold-start acceptance trial. Make no edits and invoke no live service. Report the required evidence and stop.

**The trial is deferred, and it blocks nothing.** It runs when Dale elects to switch surfaces or explicitly requests it. A missing trial does not block implementation, testing, PRs, merges, or any campaign work. Do not perform or simulate it on your own initiative. Portability is structurally ready and not live-proven; no PASS may be claimed until the trial actually runs.

## At a glance

Run `npm run atlas:status` (`-- --json` for machine output). The same bounded, redacted status is available at `GET /.well-known/atlas-status.json`; see [`docs/ATLAS_OPERATIONS_CONTRACT.md`](docs/ATLAS_OPERATIONS_CONTRACT.md). No Sheet ID or tab names need to be supplied. For the newest genuine owner app session, run `npm run atlas:review-live` (`-- --json`).
