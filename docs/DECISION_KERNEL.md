# Atlas Decision Kernel

> **Status:** Active operational distillation. This convenience document never overrides `CLAUDE.md`, `docs/CONSTITUTION.md`, or `docs/INVARIANTS.md`.

## Durable principles

### Trust and data safety

- **Approve before write.** No real Google Sheets write without explicit owner authorization. Dry-runs pass `test_mode:true` and prove `sheet_written:false` plus `no_write_confirmed:true`.
- **No silent state changes.** Writes, deletions, and state transitions must be visible, attributable, and proof-carrying.
- **Preserve user intent.** Deterministically loggable gym input must not be silently discarded or rerouted as conversation.
- **Truth beats convenience.** Missing or ambiguous proof is a failure, not permission to guess.

### Engine and coach

- **The deterministic engine owns numbers and decisions.** Weight, reps, RIR, set count, progression, safety, and rule verdicts never come from the LLM.
- **The LLM words facts.** It explains or answers from whitelisted state; it never writes or invents.
- **Slash notation is fixed.** `225 5/2` always means 225 lb × 5 reps @ RIR 2.
- **Quiet when normal.** Coaching energy must be earned by real engine evidence.

### Product

- **Conversation is the product.** Other surfaces support the conversation rather than compete with it.
- **Trust over cleverness.** Predictable, truthful behavior beats sophistication.
- **Depth before breadth.** Finish and prove the existing owner-operated coaching product before adding capabilities.
- **Sheets-primary V1.** No second permanent database, public multi-user system, nutrition product, or broad platform expansion during the V1 campaign.

### Execution

- **One canonical campaign.** Work selection comes from `docs/ATLAS_V1_EXECUTION_PLAN.md`.
- **Verify before building.** An item existing in a document is not proof the defect still exists.
- **Smallest safe slice.** One concern per PR; split work that spreads.
- **Engine first, wording second.** Deterministic behavior precedes narration.
- **Future discoveries go to `BACKLOG.md`.** Do not carry them in chat or expand the current PR.
- **Finish the loop.** After hard gates pass and real advisory findings are handled, Claude merges the exact head, refreshes `main`, updates campaign state, and continues.

## Routine read order

1. `CLAUDE.md`
2. `docs/ATLAS_V1_EXECUTION_PLAN.md`
3. `docs/DECISION_KERNEL.md`
4. `BACKLOG.md` for awareness and deferred discoveries
5. Relevant specs, invariants, tests, and evidence ledgers

Do not select work from retired plans, Git history, audits, proposal packets, or the backlog while the canonical plan has eligible work.

## Card eligibility

A campaign card is eligible only when:

- its acceptance criteria are clear;
- dependencies and owner gates are satisfied;
- it can be executed as one safe concern;
- the live path or closest integration path can be tested;
- it does not require unapproved production writes, schema/destructive work, credentials/security changes, or a Constitution/Invariant amendment.

If a card is not eligible, record the blocker and move only when the plan explicitly provides another independent lane. Never invent substitute work.

## Decision boundary

Claude decides implementation details already settled by governance: root cause, smallest fix, PR sizing, tests, regression strategy, refactors, and principle-derivable wording/rendering.

Use ChatGPT's Atlas Decision Desk only for a genuinely non-derivable product/scope/trust fork.

Dale is required for:

1. genuine owner-only gym/device evidence;
2. new product direction, coaching philosophy, scope, or application/runtime/provider/model changes;
3. real production-write authorization;
4. schema, migration, deletion, credentials, or security-sensitive infrastructure;
5. Constitution/Invariant amendments;
6. One-Brain or other promotion decisions;
7. a genuine unresolved conflict between governing principles.

Dale is **not** required to click merge on a clean routine PR.

## Risk and review

- Deterministic GitHub CI checks are hard gates.
- Codex comments are advisory. Claude fixes real, in-scope findings and records false alarms as such.
- A clean-context review may be used for additional confidence on higher-risk work, but it is not a required status, marker, or human sign-off.
- The Atlas Contract / Systems Review is trigger-based, not a status check. `CLAUDE.md` holds the one trigger list and the merge-card fields; this kernel does not restate them.

## Compact decision record

```text
Decision:           <what was decided>
Rationale:          <governing principle or plan card>
Invariants checked: <relevant trust/safety rules>
Confidence:         <high / medium / low>
Owner needed:       <yes/no and why>
```

## Process-change restraint

Do not refine governance because a hypothetical improvement sounds tidy. Change process only to fix a demonstrated bottleneck or contradiction. Otherwise, return effort to finishing Atlas.
