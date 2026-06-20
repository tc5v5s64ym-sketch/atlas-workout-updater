# Atlas Owner Check-In Rules

> **Status:** Active. Companion to `docs/AUTOMATION_PROTOCOL.md` (the automation contract) and `docs/AGENT_WORKFLOW.md` (the build loop).

Atlas runs automation-first. The owner (Dale) is an **exception handler**, not a step in every PR. This document is the exhaustive list of situations that **require** the owner. If none of these apply, automation proceeds without owner involvement and informs the owner via the merge card.

---

## When the owner IS required

Stop and check in with the owner — do not self-approve — when any of the following is true.

1. **Live application testing is required.** Automation cannot exercise the running app against the production Google Sheet. Any change whose correctness can only be confirmed by the owner driving the live app (a hold point in `docs/ACTIVE_ROADMAP.md`, a UI/interaction change, anything that needs a real device or real sheet) requires an owner live test. Provide a live test script in the merge card.

2. **Write-path behavior changes.** Any change to how rows are written to `Log_Cleaned`, `Effort`, `Constraints`, or `Deload_State`; the `test_mode`/live-write decision; row enrichment/append; or the dry-run vs live-write proof fields (`sheet_written`, `no_write_confirmed`, `sheet_write`, `log_rows_written`). See the "Critical behaviours" table in `CLAUDE.md`.

3. **Approval-gate behavior changes.** Any change to the preview → approve → write trust loop (`public/app.js`), including how the user approves before a real write.

4. **Coach behavior changes.** Any change to what the coach says or how it decides to speak — `services/coach.js`, `services/vision.js`, coach prompts, sanitizer whitelists, or coach-surface narration. The engine owns numbers; the coach only words them, and changes to that boundary are owner-gated.

5. **Trust-contract behavior changes.** Any change touching an `docs/INVARIANTS.md` rule or the `docs/CONSTITUTION.md` trust contract: no blind writes, the engine owns the numbers, the owner approves, undo read-back/log-tab restriction, phantom-set suppression.

6. **Roadmap or vision changes.** Reordering, adding, or removing `docs/ACTIVE_ROADMAP.md` steps, or any change to Dream / Vision / Constitution layer docs (`docs/ATLAS_PRODUCT_VISION.md`, `docs/CONSTITUTION.md`). See `docs/GOVERNANCE.md`.

7. **Model recommendation changes.** Any change to the Model Recommendation Gate outcome, the Sonnet/Opus selection guidance, or any runtime/LLM/app model, prompt model, or API model. (The gate itself is a workflow gate — changing it or overriding its recommendation is owner-gated.)

8. **Automation cannot determine safety.** Whenever the builder or reviewer cannot establish that a change is safe — ambiguous review feedback, an unverifiable premise, a schema question, conflicting docs, or anything where the safe direction is unclear. Uncertainty is itself a trigger; it is never resolved by guessing.

---

## When the owner is NOT required

All other work proceeds without owner involvement, through the autonomous build loop in `docs/AGENT_WORKFLOW.md`. This includes, when nothing above is triggered:

- Documentation, comments, and reference-doc updates that do not touch roadmap/vision/constitution.
- Pure engine/service/data logic with full test coverage that does not change the write path, approval gate, coach behavior, or a trust invariant.
- Test-only additions and regression captures.
- Housekeeping: dead-code removal, DRY refactors with no behavior change, lint/format, dependency-free cleanups.
- Infrastructure, workflow, template, and label changes that do not alter production application behavior.

For this work, automation builds, tests, reviews, classifies risk, generates the merge card, and reports — the owner reads the card but is not blocked on.

---

## How a check-in is raised

When a criterion above is met, the builder:

1. Stops at the check-in boundary (does not proceed past it).
2. Sets **`owner action required: Yes`** on the merge card and names which criterion (1–8 above) triggered it.
3. Provides the **live test script** in the merge card when criterion 1 applies.
4. Applies the matching risk label (`owner-live-test`, `owner-decision`, or `blocked`) per `docs/RISK_LABELS.md`.
5. Asks a single, self-contained question if a decision is needed — enough context that the owner can answer without scrolling back.

The owner remains the only role that merges, regardless of whether a check-in was raised.
