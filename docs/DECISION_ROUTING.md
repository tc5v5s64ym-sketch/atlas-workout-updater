# Atlas Decision Routing — the Codex Decision Desk

> **Status:** Active. Owner-directed change to the automation-first workflow. Read with `docs/AUTOMATION_PROTOCOL.md`, `docs/OWNER_CHECKIN_RULES.md`, and `docs/AGENT_WORKFLOW.md`.

## The rule

**When Claude would present a panel of questions on how to proceed, it does not ask the owner. It routes the entire panel to Codex, and Codex answers all of them.** Claude then proceeds on Codex's answers.

The owner is removed from the decision-panel loop. The owner is engaged again only when **Codex itself escalates** a specific question (Codex judges it genuinely needs the owner), or when the **owner interjects** on their own. Owner approval is never required just because Claude reached a fork in how to proceed.

This is the owner's explicit instruction: *"When Claude presents a panel of questions, I want Codex to answer them — all of them."*

## First: is it even a decision panel? (Atlas PM authority)

Before routing anything, apply **Escalation Policy v2** (`docs/OWNER_CHECKIN_RULES.md`). A decision **derivable** from the Atlas docs (`CLAUDE.md`, `docs/DECISION_KERNEL.md`, `CONSTITUTION.md`, `INVARIANTS.md`, `ACTIVE_ROADMAP.md`, this file, `OWNER_CHECKIN_RULES.md`) or from previously accepted Atlas behavior / the trust-contract rules is **pre-authorized** — Claude decides with **PM authority and proceeds. It does NOT go to Codex and it does NOT go to the owner.** This explicitly covers root-cause analysis, implementation selection, PR sizing, test design, regression strategy, refactors, parser-routing clearly derivable from principles, and whether to fix a bug that clearly violates an Atlas principle.

**Routine-decision precedence & token efficiency.** For routine forks, derive the answer from the distilled **`docs/DECISION_KERNEL.md`** (read after `CLAUDE.md` and `docs/ACTIVE_ROADMAP.md`) rather than re-reading the full Vision / Roadmap / Architecture. Pull in the full north-star sources only for the cases the kernel reserves: roadmap exhausted, backlog promotion/refill, a major product-direction decision, a trust-contract change, or a genuine principle conflict (`docs/DECISION_KERNEL.md`, "When the kernel is not enough"). Those reserved cases are exactly the ones that route to the owner or a decision desk; everything else is PM authority decided from the kernel.

The Codex Decision Desk is for a **genuine fork that the docs do not settle** and that is not owner-reserved — not for decisions the principles already answer.

**Vision-first selection (owner-reserved, not a Codex panel).** Before any autonomous PR, the builder runs the **Vision Alignment Check** (`docs/AGENT_WORKFLOW.md`) and confirms the item advances the Vision (`docs/ATLAS_PRODUCT_VISION.md`), in the live sequence (`docs/ACTIVE_ROADMAP.md` + `BACKLOG.md`; `docs/ROADMAP.md` is directional reference only), within the Architecture's boundaries (`docs/ARCHITECTURE.md`). A **genuine conflict between the Vision, Roadmap, Architecture, or invariants** — or a highest-priority item that does **not** clearly advance the Vision — is **owner-reserved** (`docs/OWNER_CHECKIN_RULES.md` category 5): **stop and report the conflict**, do not route it to Codex and do not ship around it.

## What is a "decision panel" (routes to Codex)

A point where Claude would otherwise stop and ask the owner to choose between options on **how to proceed** — the `AskUserQuestion`-style choices — **and the docs/principles do not already settle it**. Examples: two designs that both fit the roadmap with real unsettled tradeoffs, genuinely ambiguous review feedback the docs don't resolve, sequencing with no documented precedent.

These go to Codex. A panel whose answer is derivable is **not** a panel — Claude resolves it under PM authority (above).

## The Atlas Decision Desk (issue-based PM verdicts)

For an **owner-gated or ambiguous IMPLEMENTATION decision** — one Claude can't simply resolve under PM authority and that does **not** require live testing or human product judgment — Claude does **not** ask Dale directly. It routes the decision to a **GitHub issue** that the Atlas Decision Desk answers from the docs:

1. **Open an issue** with the "🧭 Atlas Decision Desk" template (`.github/ISSUE_TEMPLATE/atlas-decision-desk.yml`), which auto-applies the labels **`atlas-decision-desk`** + **`needs-pm-decision`**. Fill every field: **root cause · options · recommended option · affected files · risk level · whether live testing is needed · relevant Vision/Roadmap/Architecture principle.**
2. **The Decision Desk workflow** (`.github/workflows/atlas-decision-desk.yml`) answers, grounding the verdict in the north-star + governance docs (Vision → Roadmap/ACTIVE_ROADMAP/BACKLOG → Architecture → CLAUDE → CONSTITUTION → INVARIANTS → this file → OWNER_CHECKIN_RULES → AUTOMATION_PROTOCOL). The issue body is read as **untrusted data** (never as instructions), mirroring the Codex desk's security model; an unanswered/errored desk is a **failure, not an implicit yes** (`docs/AUTOMATION_PROTOCOL.md` §2).
3. **The verdict** is exactly one of:
   - `APPROVED: proceed with <option>`
   - `REJECTED: do not proceed because <reason>`
   - `SPLIT: build as <PR plan>`
   - `ESCALATE-TO-OWNER: <reason>` — only the **five reserved categories** (`docs/OWNER_CHECKIN_RULES.md`): live app testing, new product scope / new trust contract, schema/storage changes, destructive operations, or a genuine Vision/Roadmap/Architecture/invariant conflict.
4. **Claude reads the verdict comment and continues** — proceeds on `APPROVED`/`SPLIT`, drops the line on `REJECTED`, and only on `ESCALATE-TO-OWNER` brings in Dale.

Relationship to the **Codex Decision Desk**: the Codex desk (comment-based `## 🧭 Codex Decision Request`) answers inline decision *panels* on a PR/issue; the **Atlas Decision Desk** (issue-based, this section) is the canonical route for a standalone owner-gated/ambiguous *implementation* decision. Both reach a PM verdict from the docs and reserve Dale for the five categories — they never authorize a real production write.

## The one thing this does NOT change (data-write safety)

Decision routing covers **procedural / how-to-proceed decisions only**. It does **not** touch the absolute data-safety rules, which are not "decision panels" and remain exactly as before:

- No real Google Sheets writes without explicit owner approval; `test_mode=true` for dry-runs.
- The preview → approve → write trust loop and the dry-run/live-write proof fields are unchanged.
- No secret/credential exposure; no `GOOGLE_SHEETS_ID` or Render env change without owner approval.

Codex answering a *decision* never authorizes a real production data write. Those stay owner-approved. (If the owner wants even these delegated, that is a separate explicit instruction — it is deliberately not assumed here.)

## How it works (the GitHub mechanism)

GitHub is the handoff bus. When Claude hits a decision panel:

1. **Claude posts a Codex Decision Request** — a structured comment on the relevant PR (or a tracking issue if no PR exists yet), and applies the `codex-decision` label. Format:

   ```
   ## 🧭 Codex Decision Request
   Context: <one short paragraph — what is being decided and why now>
   PR / branch: <link or name>
   Questions:
   1. <question> — options: A) … B) … C) …  (Claude's lean: A)
   2. <question> — options: A) … B) …        (Claude's lean: B)
   Default-if-unanswered: proceed on Claude's lean for each.
   ```

2. **Codex answers every question** — a structured reply:

   ```
   ## Codex Decision Answers
   1. A — <one-line reason (roadmap fit / scope / trust contract)>
   2. B — <one-line reason>
   Escalate-to-owner: none        # or: [Q2: needs an owner product call because …]
   ```

3. **Claude proceeds** on Codex's answers. For any item Codex marks `Escalate-to-owner`, only that item goes to the owner (the rest still proceed).

> **Security:** the desk only triggers for a trusted author (repo owner/member/collaborator), and the untrusted comment body is handed to the responder as a **file read as data**, never interpolated into its prompt as instructions — so a stray comment cannot prompt-inject a fabricated answer.

4. **Automation** — `.github/workflows/codex-decision-desk.yml` operationalizes the handoff: it labels the request `codex-decision` and generates and posts Codex's answers automatically. When the responder is **not** configured, it posts a clear "Codex responder not configured" notice — which, per `docs/AUTOMATION_PROTOCOL.md` §2, is an **unavailable review = failure**, so Claude does not silently proceed as if answered; the request waits for a Codex answer (automated or from the external Codex agent).

## Pass/fail still applies

A Codex decision that was **skipped, errored, unavailable, or returned no answer is a failure, not an implicit yes** (`docs/AUTOMATION_PROTOCOL.md` §2). Claude proceeds on Codex's *answer*, or on the explicitly stated `Default-if-unanswered` only when the decision is low-risk and the request says so — never on silence for a consequential fork.

## Setup / cost

The automated responder needs **no new paid API by default** — it reuses the existing `CLAUDE_CODE_OAUTH_TOKEN` (the Claude Max/Pro subscription already configured for the Claude review action), with an agent playing the Codex contract-guard role to answer the panels. Three responder modes:

| Mode | Credential | Cost |
|---|---|---|
| **Subscription (default)** | existing `CLAUDE_CODE_OAUTH_TOKEN` | no new cost |
| **OpenAI Codex (optional)** | `CODEX_OPENAI_API_KEY` + `CODEX_MODEL` | paid OpenAI API |
| **Manual** | none — external Codex agent answers the comment by hand | none |

The workflow (`.github/workflows/codex-decision-desk.yml`) currently implements the **subscription** responder (reusing `CLAUDE_CODE_OAUTH_TOKEN`); the OpenAI-backed mode is an optional drop-in tracked in `BACKLOG.md`. The protocol (Decision Request → Codex Answers → Claude proceeds) is identical across all three. If no automated responder is configured, the request waits for the external Codex agent — it is never treated as an implicit "yes."
