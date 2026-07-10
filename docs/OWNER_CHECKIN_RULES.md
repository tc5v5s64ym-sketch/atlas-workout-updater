# Atlas Owner Check-In Rules

> **Status:** Active. Companion to `docs/AUTOMATION_PROTOCOL.md` (the automation contract) and `docs/AGENT_WORKFLOW.md` (the build loop).

Atlas runs automation-first. The owner (Dale) is an **exception handler**, not a step in every PR. Decision panels route to **Codex**, not the owner: when Claude reaches a fork in how to proceed, it posts a Codex Decision Request and Codex answers (`docs/DECISION_ROUTING.md`). The owner is engaged only when **Codex escalates** a reserved item, or the owner interjects.

This document lists the decision criteria and, for each, **who answers** — Codex (the default) or escalate-to-owner. The numbering (criteria 1–8) is preserved so other docs' references stay valid; what changed is the *disposition*.

---

## Escalation Policy v3 — minimum-escalation, ship-by-default (owner standing instruction, 2026-06-24)

**This section is authoritative and supersedes Escalation Policy v2 below.** Where v2, the criteria table, or any other doc differs, read it through v3. v2 is retained only for the numbering and rationale it still shares with v3.

**Reduce owner escalations to the minimum. The default behavior is to continue shipping.** Do **not** escalate simply because a change touches the **coach surface, coach wording, coach rendering, frontend presentation, or UX**. If the correct behavior is already determined by existing governance, decide autonomously and proceed.

### Consult-then-decide

Before treating anything as an escalation, consult the governing documents:

- `docs/ATLAS_PRODUCT_VISION.md` (Vision / "The Dream")
- `docs/ACTIVE_ROADMAP.md`
- `docs/DECISION_KERNEL.md`
- `docs/CONSTITUTION.md`
- `docs/INVARIANTS.md`
- `docs/AUTOMATION_PROTOCOL.md`

If the requested behavior is **derivable** from those (plus `CLAUDE.md`, `docs/DECISION_ROUTING.md`, this file, or previously accepted Atlas behavior / the trust-contract rules), Claude holds **PM authority**: decide and proceed — no owner, no Codex panel. This explicitly includes coach wording/rendering, frontend, and UX work whose correct behavior is already determined by governance.

### Escalate to the owner ONLY when one of these four is true

1. **A live test is required that only the owner can perform** — browser/UI/mobile behavior, real user-workflow validation, verifying a fix in production. (Owner-initiated/advisory: flag `owner-live-test` with a live test script and **keep going**; the owner calls the hold.) **Live tests require deployed code and are therefore post-merge validations — they are never pre-merge gates.** The `owner-live-test` flag and live test script are informational; they do NOT set `Owner action required: Yes` on the merge card and do NOT produce `hold-for-owner` as the merge recommendation. The PR merges normally; the live test happens after deployment.
2. **The work changes Atlas's product vision, coaching philosophy, or introduces new product scope** — a new user-facing capability, a new workflow, a new logging model, a new trust contract, or a change to *what Atlas believes about training* (coaching **philosophy** — distinct from coach wording/rendering, which is not reserved). App/runtime/prompt/API **model** selection (`services/vision.js` / `services/coach.js`) stays here too; the **builder's** model is fixed at Opus 4.8 and is never a stop.
3. **The work performs destructive or irreversible operations** — Sheet/DB **schema** changes, data **migrations**, data **deletion** or historical rewrites, **credentials**, or **security-sensitive infrastructure**. (This folds v2's separate "schema/storage" and "destructive operations" categories into one.)
4. **The Decision Kernel finds a genuine conflict between governing principles and cannot resolve it** — two principles, or the Vision / Roadmap / Architecture / invariants, point to different outcomes and no documented precedent resolves it (incl. a highest-priority item that does not clearly advance the Vision). Stop and report the conflict rather than ship around it.

Nothing outside these four is an owner stop. A genuinely non-derivable fork that is **not** owner-reserved goes to the **Codex / Atlas Decision Desk** (`docs/DECISION_ROUTING.md`), not the owner.

### When uncertain

Do **not** default to escalation. **Document the reasoning, cite the governing documents used, make the smallest safe decision, and continue** (record it in the Decision Kernel response format — `docs/DECISION_KERNEL.md`). Escalate only when a reserved category above is genuinely triggered.

### Unchanged: absolute data-safety

v3 governs *who decides*, not data safety. The "Absolute data-safety" section below is unchanged: no real Google Sheets write without explicit owner approval, the preview→approve→write trust loop, the proof fields, and no secret/`GOOGLE_SHEETS_ID`/env exposure. **PM authority never authorizes a real production write, a data migration, or an INVARIANT/Constitution amendment** — those remain owner-reserved (categories 2–3 above and absolute data-safety).

---

## Owner amendment (2026-07-10) — standing full-auto authorization + agent-performed live verification

Owner standing instruction, given in-session 2026-07-10. Recorded here so it persists across sessions. It refines — does not replace — Escalation Policy v3.

1. **Full-auto execution reaffirmed.** Run continuously under the automation-first workflow (`docs/AUTOMATION_PROTOCOL.md`): work the queue in `docs/ACTIVE_ROADMAP.md` / `BACKLOG.md` order, one concern per PR, merge merge-ready PRs, and keep going. Stop only for the four reserved categories (v3 above) or the stop conditions in this amendment. Do not idle waiting for the owner: gym-gated items (LT-### cards, proving-run evidence) are queued clearly for the owner while work continues on the next non-gated item.
2. **Agent-performed live verification against production is authorized** (amends criterion 1 below, which previously framed live testing as owner-performed only — agent verification now complements, not replaces, owner live tests):
   - **Default: read-only.** Use read-only endpoints and dry-run/preview paths, following the Mission Control conventions (`docs/MISSION_CONTROL.md`, incl. its dry-run safety contract). Production base: `https://atlas-workout-updater.onrender.com`, authenticated via the production API key held only in the gitignored `.env` (never printed, logged, committed, or quoted anywhere).
   - **A live WRITE test is allowed only when a change cannot be verified any other way.** If performed: mark the data unmistakably as test data per repo convention, verify, then remove/revert it **in the same session**. The owner's real training log must be identical before and after, except for changes the owner made himself.
   - **Never** run destructive or bulk operations against production.
   - **Any production data-integrity anomaly is a reserved-category stop:** freeze writes, report, wait for the owner.
3. **Gym-gated tests remain owner-only.** Anything requiring a real gym session (LT-### live cards, proving-run evidence) only the owner can perform — queue it and continue.
4. **Credential stop.** A missing or invalid credential is a stop-and-ask; never guess or hardcode secrets.

**Relation to "Absolute data-safety":** the no-real-write-without-explicit-owner-approval rule stands; item 2 above **is** the explicit owner approval, standing and narrowly scoped to a last-resort, test-marked, same-session-reverted verification write. It does not authorize migrations, deletions of owner data, schema changes, or any write outside that scope.

---

## Escalation Policy v2 — SUPERSEDED BY v3 (pointer only)

> **Fully superseded by Escalation Policy v3 above; do not follow v2.** v2 pre-authorized the same PM-authority list under five reserved-owner categories instead of v3's four (v3 merged "schema/storage" + "destructive operations" into one, added coaching-philosophy as an explicit reserved category, and — the one substantive behavior change — stopped treating coach surface/wording/rendering/frontend/UX as an automatic escalation trigger). The criteria numbering (1–8) in the table below is unchanged across v2→v3 so other docs' references still resolve. Full v2 text lives in git history (`docs/OWNER_CHECKIN_RULES.md` pre-PR-21) if the rationale is ever needed.

---

## Decision criteria and disposition

> Read through **Escalation Policy v3** above (authoritative; v2 retained as superseded): a criterion's disposition is **owner** only when it maps to one of the **four** reserved categories; otherwise a derivable call is **PM authority** (Claude decides) — including coach wording/rendering/UX — and a genuine non-derivable fork is **Codex**.

For each, "Codex decides" means Codex answers the panel and Claude proceeds; "escalate-to-owner" means Codex routes that specific item to the owner.

1. **Live application testing — owner-initiated, NOT an automatic stop.** The owner decides when an app test is warranted and says so; automation does not halt for one. When a change would benefit from live validation (UI/interaction change, anything only confirmable on a real device or the real sheet, a roadmap hold point), the builder labels it `owner-live-test`, includes a **live test script** in the merge card, and **keeps going**. **Live tests require deployed code — they are post-merge validations, never pre-merge gates.** The `owner-live-test` flag does NOT set `Owner action required: Yes` on the merge card and does NOT produce `hold-for-owner` as the merge recommendation; the PR merges normally and the live test happens after deployment. _Disposition: owner-initiated (advisory)._ **Owner amendment 2026-07-10:** the agent may additionally perform its own live verification against production (read-only/dry-run by default; last-resort test-marked write) — see the amendment section above; gym-session tests remain owner-only.

2. **Write-path behavior changes.** Any change to how rows are written to `Log_Cleaned`, `Effort`, `Constraints`, or `Deload_State`; the `test_mode`/live-write decision; row enrichment/append; or the dry-run vs live-write proof fields (`sheet_written`, `no_write_confirmed`, `sheet_write`, `log_rows_written`). See the "Critical behaviours" table in `CLAUDE.md`. _Disposition: **Codex decides** the design/approach. Executing a real production write still needs owner approval — see "Absolute data-safety" below._

3. **Approval-gate behavior changes.** Any change to the preview → approve → write trust loop (`public/app.js`). _Disposition: **Codex decides**._

4. **Coach behavior changes.** Any change to what the coach says or how it decides to speak — `services/coach.js`, `services/vision.js`, coach prompts, sanitizer whitelists, coach-surface narration. _Disposition (v3): coach **wording / rendering / narration** that only words facts the engine already emits, with correct behavior derivable from governance, is **PM authority** — decide and proceed, no escalation. Escalate **only** when the change alters Atlas's **coaching philosophy** (reserved category 2) or the app/runtime/prompt/API **model** selection; a genuinely non-derivable but non-reserved fork still goes to **Codex**, not the owner._ **Carve-out — NOT PM authority:** expanding a **sanitizer whitelist** (forwarding any new field to the LLM via `sanitizeFacts` / `sanitizeChatContext`) is a **trust / data-exposure** change, not wording — it stays **Codex-gated under the trust contract** (criterion 5 below; `CLAUDE.md` "forward only whitelisted fields … never raw client objects"). The v3 relaxation is scoped to pure wording/rendering/narration that words already-emitted, already-whitelisted facts.

5. **Trust-contract behavior changes.** Any change touching an `docs/INVARIANTS.md` rule or the `docs/CONSTITUTION.md` trust contract: no blind writes, the engine owns the numbers, the owner approves, undo read-back/log-tab restriction, phantom-set suppression. _Disposition: **Codex decides** within the contract; **escalate-to-owner** if the change would amend or weaken an INVARIANT/Constitution rule._

6. **Vision / Dream / Constitution changes, and new-scope roadmap direction.** Any change to the Dream, Vision, or Constitution (`docs/ATLAS_PRODUCT_VISION.md`, `docs/CONSTITUTION.md`, `docs/INVARIANTS.md`); promoting an owner-gated backlog item (`Someday / future scope`, `NEEDS DESIGN / not yet scoped`, `Strategic direction — deferred brainstorm`, or trust-sensitive new scope) into the active queue; or roadmap direction requiring a product/trust judgment the backlog has not settled. _Disposition: **escalate-to-owner**._ **NOT a decision at all:** the routine **Roadmap Refill Loop** (automation refills `docs/ACTIVE_ROADMAP.md` from already-filed Vision-serving backlog items — `docs/AGENT_WORKFLOW.md`). See `docs/GOVERNANCE.md`.

7. **App / runtime / prompt / API model changes** — *not the builder's model.* Changing `services/vision.js` / `services/coach.js` provider or model selection, or any runtime/LLM/prompt/API model the app uses. _Disposition: **escalate-to-owner**._ The **builder's** model is fixed at **Opus 4.8** by owner standing instruction — no model check-in and no escalation for which model builds a PR (see `CLAUDE.md` → "Model: Opus 4.8, always").

8. **Automation cannot determine safety.** Ambiguous review feedback, an unverifiable premise, a schema question, conflicting docs, or anything where the safe direction is unclear. _Disposition: **Codex decides** if it can resolve it on the contract; **escalate-to-owner** only if Codex also cannot. Uncertainty is never resolved by silently guessing._

---

## Absolute data-safety (unchanged — always owner-approved, never a panel)

Decision routing does **not** touch these. They are standing Constitutional safety, not "how to proceed" panels, and are never delegated to Codex:

- No real Google Sheets write without explicit owner approval (`test_mode=true` for dry-runs); the preview → approve → write trust loop and the dry-run/live-write proof fields are unchanged. (The 2026-07-10 owner amendment above is a standing, narrowly-scoped approval for last-resort, test-marked, same-session-reverted verification writes only.)
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

When the builder reaches a decision, it does **not** ask the owner. It either:

0. **Opens an Atlas Decision Desk issue** for a standalone owner-gated/ambiguous **implementation** decision — the "🧭 Atlas Decision Desk" template (labels `atlas-decision-desk` + `needs-pm-decision`) with root cause / options / recommended option / affected files / risk / live-testing-needed / Vision principle. The desk (`.github/workflows/atlas-decision-desk.yml`) answers `APPROVED` / `REJECTED` / `SPLIT` / `ESCALATE-TO-OWNER` from the docs; Claude proceeds on the verdict (`docs/DECISION_ROUTING.md` "The Atlas Decision Desk"). **OR**
1. **Posts a Codex Decision Request** (`## 🧭 Codex Decision Request`) on the PR/issue and applies the `codex-decision` label (`docs/DECISION_ROUTING.md`) for an inline PR decision panel. Codex answers every question; Claude proceeds on those answers.
2. For any item Codex marks **`Escalate-to-owner`** (the reserved set — criteria 6/7, INVARIANT amendments under 5, or what Codex cannot resolve under 8), sets **`owner action required: Yes`** on the merge card for that item and applies `owner-decision`. The rest still proceed.
3. For criterion **1 (live app testing)**, does **not** halt — flags `owner-live-test`, includes the **live test script** in the merge card, and continues until the owner says stop.
4. A Codex decision that was skipped/errored/unanswered is a **failure, not an implicit yes** (`docs/AUTOMATION_PROTOCOL.md` §2) — the builder waits for the answer rather than guessing on a consequential fork.

Routine merges are automated — Claude holds full merge authority (`docs/AUTOMATION_PROTOCOL.md`); the owner can always merge directly or revoke that authority. The owner is engaged only on a Codex escalation or by interjecting.
