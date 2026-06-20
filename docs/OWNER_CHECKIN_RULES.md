# Atlas Owner Check-In Rules

> **Status:** Active. Companion to `docs/AUTOMATION_PROTOCOL.md` (the automation contract) and `docs/AGENT_WORKFLOW.md` (the build loop).

Atlas runs automation-first. The owner (Dale) is an **exception handler**, not a step in every PR. Decision panels route to **Codex**, not the owner: when Claude reaches a fork in how to proceed, it posts a Codex Decision Request and Codex answers (`docs/DECISION_ROUTING.md`). The owner is engaged only when **Codex escalates** a reserved item, or the owner interjects.

This document lists the decision criteria and, for each, **who answers** — Codex (the default) or escalate-to-owner. The numbering (criteria 1–8) is preserved so other docs' references stay valid; what changed is the *disposition*.

---

## Decision criteria and disposition

For each, "Codex decides" means Codex answers the panel and Claude proceeds; "escalate-to-owner" means Codex routes that specific item to the owner.

1. **Live application testing — owner-initiated, NOT an automatic stop.** The owner decides when an app test is warranted and says so; automation does not halt for one. When a change would benefit from live validation (UI/interaction change, anything only confirmable on a real device or the real sheet, a roadmap hold point), the builder labels it `owner-live-test`, includes a **live test script** in the merge card, and **keeps going**. _Disposition: owner-initiated (advisory)._

2. **Write-path behavior changes.** Any change to how rows are written to `Log_Cleaned`, `Effort`, `Constraints`, or `Deload_State`; the `test_mode`/live-write decision; row enrichment/append; or the dry-run vs live-write proof fields (`sheet_written`, `no_write_confirmed`, `sheet_write`, `log_rows_written`). See the "Critical behaviours" table in `CLAUDE.md`. _Disposition: **Codex decides** the design/approach. Executing a real production write still needs owner approval — see "Absolute data-safety" below._

3. **Approval-gate behavior changes.** Any change to the preview → approve → write trust loop (`public/app.js`). _Disposition: **Codex decides**._

4. **Coach behavior changes.** Any change to what the coach says or how it decides to speak — `services/coach.js`, `services/vision.js`, coach prompts, sanitizer whitelists, coach-surface narration. _Disposition: **Codex decides**._

5. **Trust-contract behavior changes.** Any change touching an `docs/INVARIANTS.md` rule or the `docs/CONSTITUTION.md` trust contract: no blind writes, the engine owns the numbers, the owner approves, undo read-back/log-tab restriction, phantom-set suppression. _Disposition: **Codex decides** within the contract; **escalate-to-owner** if the change would amend or weaken an INVARIANT/Constitution rule._

6. **Vision / Dream / Constitution changes, and new-scope roadmap direction.** Any change to the Dream, Vision, or Constitution (`docs/ATLAS_PRODUCT_VISION.md`, `docs/CONSTITUTION.md`, `docs/INVARIANTS.md`); promoting an owner-gated backlog item (`Someday / future scope`, `NEEDS DESIGN / not yet scoped`, `Strategic direction — deferred brainstorm`, or trust-sensitive new scope) into the active queue; or roadmap direction requiring a product/trust judgment the backlog has not settled. _Disposition: **escalate-to-owner**._ **NOT a decision at all:** the routine **Roadmap Refill Loop** (automation refills `docs/ACTIVE_ROADMAP.md` from already-filed Vision-serving backlog items — `docs/AGENT_WORKFLOW.md`). See `docs/GOVERNANCE.md`.

7. **Model recommendation changes.** Any change to the Model Recommendation Gate outcome, the Sonnet/Opus guidance, or any runtime/LLM/app/prompt/API model. _Disposition: **escalate-to-owner**._

8. **Automation cannot determine safety.** Ambiguous review feedback, an unverifiable premise, a schema question, conflicting docs, or anything where the safe direction is unclear. _Disposition: **Codex decides** if it can resolve it on the contract; **escalate-to-owner** only if Codex also cannot. Uncertainty is never resolved by silently guessing._

---

## Absolute data-safety (unchanged — always owner-approved, never a panel)

Decision routing does **not** touch these. They are standing Constitutional safety, not "how to proceed" panels, and are never delegated to Codex:

- No real Google Sheets write without explicit owner approval (`test_mode=true` for dry-runs); the preview → approve → write trust loop and the dry-run/live-write proof fields are unchanged.
- No secret/credential exposure; no `GOOGLE_SHEETS_ID` or Render env change without owner approval.

Codex answering a *decision* never authorizes a real production write. If the owner wants even these delegated, that requires a separate explicit instruction.

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

## How a decision is routed

When the builder reaches a decision, it does **not** ask the owner. It:

1. **Posts a Codex Decision Request** (`## 🧭 Codex Decision Request`) on the PR/issue and applies the `codex-decision` label (`docs/DECISION_ROUTING.md`). Codex answers every question; Claude proceeds on those answers.
2. For any item Codex marks **`Escalate-to-owner`** (the reserved set — criteria 6/7, INVARIANT amendments under 5, or what Codex cannot resolve under 8), sets **`owner action required: Yes`** on the merge card for that item and applies `owner-decision`. The rest still proceed.
3. For criterion **1 (live app testing)**, does **not** halt — flags `owner-live-test`, includes the **live test script** in the merge card, and continues until the owner says stop.
4. A Codex decision that was skipped/errored/unanswered is a **failure, not an implicit yes** (`docs/AUTOMATION_PROTOCOL.md` §2) — the builder waits for the answer rather than guessing on a consequential fork.

Routine merges are automated — Claude holds full merge authority (`docs/AUTOMATION_PROTOCOL.md`); the owner can always merge directly or revoke that authority. The owner is engaged only on a Codex escalation or by interjecting.
