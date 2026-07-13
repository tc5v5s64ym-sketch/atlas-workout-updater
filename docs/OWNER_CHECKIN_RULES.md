# Atlas Owner Check-In Rules

> **Status:** Active. Companion to `docs/AUTOMATION_PROTOCOL.md` and
> `docs/AGENT_WORKFLOW.md`.

Codex is the implementation agent. ChatGPT is the product decision desk and
external Atlas Contract Review. Dale is the only merge authority.

## Consult first; escalate only when reserved

Before escalating, consult `AGENTS.md`, `docs/ATLAS_PRODUCT_VISION.md`,
`docs/ACTIVE_ROADMAP.md`, `docs/DECISION_KERNEL.md`,
`docs/CONSTITUTION.md`, `docs/INVARIANTS.md`, and the relevant accepted behavior.

Codex may decide implementation details derivable from those authorities:
root cause, smallest safe fix, PR sizing, tests, regression strategy, refactors,
principle-derivable parser routing, and wording/rendering that only expresses
already-authoritative facts. A genuinely non-derivable product/scope/trust fork
goes to ChatGPT's Atlas Decision Desk.

Escalate to Dale when any of these is true:

1. **A live test only Dale can perform.** Gym-session evidence remains owner-only.
2. **Product direction changes.** Vision, coaching philosophy, new user-facing
   scope/workflow/logging/trust contract, or application/runtime/prompt/API model
   selection.
3. **Destructive or irreversible work.** Schema, migrations, deletion,
   backfills/historical rewrites, credentials, security-sensitive
   infrastructure, or production data risk.
4. **A genuine unresolved principle conflict.** Vision, roadmap, architecture,
   constitution, or invariants point to incompatible outcomes with no precedent.

No builder model is mandated and builder-model choice is not an escalation.
This does not change owner control over Atlas application/runtime models.

## Standing production-verification amendment (2026-07-10, unchanged)

Dale's standing authorization for agent-performed verification remains narrow:

- **Default read-only/dry-run.** Use read-only endpoints and preview paths under
  `docs/MISSION_CONTROL.md`; never print or expose the production API key.
- **A live test write is last resort only.** It is allowed only when the change
  cannot be verified another way, must be unmistakably test-marked, verified,
  and removed/reverted in the same session. Dale's real training log must be
  identical before and after except for Dale's own changes.
- **Never perform destructive or bulk production operations.**
- **Any production data-integrity anomaly is an immediate stop:** freeze writes,
  report, and wait for Dale.
- **Gym-gated tests remain owner-only.** Queue the evidence need without
  fabricating it.
- **Missing/invalid credentials are a stop.** Never guess or hardcode them.

This is the only standing exception to the no-real-write rule. It does not
authorize migrations, schema changes, deletion of owner data, or writes outside
the same-session-reverted verification scope.

## Decision criteria

The established criteria remain, with current dispositions:

1. **Live application testing.** Codex may run safe read-only/dry-run validation
   under the standing amendment. Dale performs owner-only/gym tests.
2. **Write-path behavior.** Design must preserve the trust contract; a real write
   still requires explicit owner authorization or the narrow standing test
   exception above.
3. **Approval-gate behavior.** Any change to preview -> approve -> write is
   owner-reserved.
4. **Coach behavior.** Pure wording/rendering of authoritative, whitelisted facts
   may be governance-derivable. Coaching philosophy, new authority, application
   model changes, or sanitizer-whitelist expansion are owner-reserved.
5. **Trust-contract behavior.** Codex may implement within the existing contract;
   Dale must approve any amendment or weakening of Constitution/Invariants.
6. **Vision/Dream/Constitution/new scope.** Dale decides.
7. **Application/runtime/prompt/API model changes.** Dale decides. This criterion
   does not apply to the implementation agent's model.
8. **Safety cannot be determined.** ChatGPT reviews genuinely non-derivable
   product/scope/trust questions; unresolved safety or principle conflict goes to
   Dale. Never guess.

## Absolute data safety

Decision routing and review do not relax these rules:

- No real Google Sheets write without explicit owner approval, except the narrow
  standing same-session-reverted test authorization above.
- Dry-runs use `test_mode=true` and prove `sheet_written:false` and
  `no_write_confirmed:true`.
- No agent manually appends, edits, or deletes Sheet rows.
- No secret, credential, production Sheet ID, private bug payload, Render env, or
  `GOOGLE_SHEETS_ID` exposure/change without owner approval.
- No schema migration, approval-gate weakening, or historical data rewrite
  without Dale.

ChatGPT or native Codex review approval never authorizes a production write.

## Merge boundary

Only Dale may merge. `READY FOR DALE MERGE` means the mandatory native Codex
GitHub Review, external ChatGPT Atlas Contract Review, required checks, scope,
risk, and merge card are complete. It is not delegated merge permission.

Codex must never merge, enable auto-merge, or instruct a workflow/bot to merge.
