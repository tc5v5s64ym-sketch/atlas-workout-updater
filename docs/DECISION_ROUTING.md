# Atlas Decision Routing — the Codex Decision Desk

> **Status:** Active. Owner-directed change to the automation-first workflow. Read with `docs/AUTOMATION_PROTOCOL.md`, `docs/OWNER_CHECKIN_RULES.md`, and `docs/AGENT_WORKFLOW.md`.

## The rule

**When Claude would present a panel of questions on how to proceed, it does not ask the owner. It routes the entire panel to Codex, and Codex answers all of them.** Claude then proceeds on Codex's answers.

The owner is removed from the decision-panel loop. The owner is engaged again only when **Codex itself escalates** a specific question (Codex judges it genuinely needs the owner), or when the **owner interjects** on their own. Owner approval is never required just because Claude reached a fork in how to proceed.

This is the owner's explicit instruction: *"When Claude presents a panel of questions, I want Codex to answer them — all of them."*

## What is a "decision panel"

Any point where Claude would otherwise stop and ask the owner to choose between options on **how to proceed** — the `AskUserQuestion`-style choices. Examples: which approach to take, whether something is in scope, how to interpret ambiguous review feedback, which of two designs fits the roadmap, whether a premise still holds, how to sequence work, whether a finding is in-scope or future-scope.

All of these now go to Codex.

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
