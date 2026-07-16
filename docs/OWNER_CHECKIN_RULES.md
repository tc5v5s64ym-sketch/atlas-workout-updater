# Atlas Owner Check-In Rules

> **Status:** Active. `CLAUDE.md` is canonical; `docs/ATLAS_V1_EXECUTION_PLAN.md` selects work.

Claude is the implementation and routine merge operator. ChatGPT is the product decision desk. Dale owns the narrow categories that require human authority or real-world evidence.

## Consult first

Before escalating, consult:

1. `CLAUDE.md`
2. `docs/ATLAS_V1_EXECUTION_PLAN.md`
3. `docs/DECISION_KERNEL.md`
4. `docs/ATLAS_PRODUCT_VISION.md`, `docs/CONSTITUTION.md`, and `docs/INVARIANTS.md` when the decision reaches those layers
5. relevant accepted behavior, specs, tests, and evidence

Claude decides derivable implementation details: root cause, smallest safe fix, PR sizing, tests, regression strategy, refactors, and wording/rendering that expresses already-authoritative facts.

A genuinely non-derivable product/scope/trust fork goes to ChatGPT's Atlas Decision Desk.

## Dale is required when

1. **Only Dale can produce the evidence.** Genuine gym/device use and GATE A eligible activity may not be fabricated.
2. **A real production write needs authorization.** The ordinary user approve-before-write flow remains owner-controlled; agent test writes require explicit per-test permission.
3. **Product direction changes.** Vision, coaching philosophy, new capability/workflow/logging/trust contract, or application/runtime/provider/model selection.
4. **Work is destructive or irreversible.** Schema, migrations, production-data deletion/backfill/rewrite, credentials, or security-sensitive infrastructure.
5. **The Constitution or Invariants would change.** These are not implementation details.
6. **A Brain or other decision system would be promoted.** Evidence informs the decision; it never makes it automatic.
7. **Governing principles genuinely conflict** with no accepted precedent.
8. **Dale has placed an explicit hold.**

Dale is not required for routine implementation, tests, derivable UI/wording, advisory-review disposition, or the final merge click on a clean authorized PR.

## Live verification

- Tier 1 read-only and Tier 2 `test_mode` dry-run checks follow `docs/AGENT_LIVE_TESTING.md` and are agent-run by default.
- Real write tests are last resort, explicitly authorized, unmistakably test-marked, verified, and reverted within the same session when the approved test design requires that.
- Dale's real training record must be unchanged except for Dale's own approved activity.
- Missing/invalid credentials are a stop; never guess or hardcode them.
- Any production data-integrity anomaly freezes writes and returns control to Dale.
- Genuine gym evidence remains owner-only.

## Absolute data safety

- No real Google Sheets write without explicit owner authorization.
- Dry-runs pass `test_mode:true` and prove `sheet_written:false` and `no_write_confirmed:true`.
- Agents never manually append, edit, or delete Sheet rows.
- No secrets, credentials, production Sheet IDs, private payloads, Render env values, or workout evidence in commits/PRs.
- No schema migration, approval-gate weakening, proof-field change, or historical rewrite without Dale.
- ChatGPT review, Codex comments, CI, or Claude's merge authority never authorizes a production write.

## Merge boundary

Claude merges an authorized routine PR after the deterministic hard gates pass, real in-scope advisory findings are addressed, scope/risk/merge-card evidence is complete, and no owner-reserved authorization remains.

There is no required owner merge step and no required cold-review account or marker. Dale may still merge anything directly or revoke standing authority.

## This governance cleanup

Dale explicitly authorized consolidation of the execution plans and removal of obsolete plan bodies. Deleting or replacing repository documentation under that instruction is not production-data deletion and does not create an additional owner hold.
