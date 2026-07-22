# Atlas Documentation Index

This index tells agents which documents have authority and prevents old plans from being mistaken for current work.

## Read first

1. [`CLAUDE.md`](../CLAUDE.md) — canonical agent operating brief: safety, roles, branches, review, merge, and execution rules.
2. [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md) — **the sole active execution queue and work-selection authority** through V1 stabilization. It currently carries the **Atlas Recovery Campaign (Issue #1073)** as the active controlling owner insertion; that campaign lives inside the plan, never beside it.
3. [`docs/DECISION_KERNEL.md`](./DECISION_KERNEL.md) — durable principles for routine decisions.
4. [`BACKLOG.md`](../BACKLOG.md) — open/deferred intake ledger and supporting finding detail; not a competing queue while the V1 plan has eligible work.
5. The relevant spec, invariant, test, or evidence document for the active card.

If another document appears to sequence work, the V1 execution plan wins and the conflict must be corrected.

## Governing product truth

- [`docs/ATLAS_PRODUCT_VISION.md`](./ATLAS_PRODUCT_VISION.md) — Dream, Vision, product shape, and what good feels like.
- [`docs/CONSTITUTION.md`](./CONSTITUTION.md) — mission and trust contract.
- [`docs/INVARIANTS.md`](./INVARIANTS.md) — rules that must never be broken.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — current system boundaries; Sheets-primary V1.
- [`docs/GOVERNANCE.md`](./GOVERNANCE.md) — document roles and filing rules.

These govern direction and constraints. They do not independently select the next PR.

## Active execution and workflow

- [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md) — milestones M0–M6, executable cards F01–F12, five-session proving run, stabilization, the parallel One-Brain evidence lane, and the embedded **Atlas Recovery Campaign (Phases 1–7, Issue #1073)** — the active controlling insertion that freezes M2/F10E until its Phase 1 owner gate passes.
- [`docs/AGENT_WORKFLOW.md`](./AGENT_WORKFLOW.md) — Current-State Verification Gate, branch hygiene, PR loop, and compact-prompt rules.
- [`docs/AUTOMATION_PROTOCOL.md`](./AUTOMATION_PROTOCOL.md) — deterministic hard gates and standing merge authority.
- [`docs/ATLAS_OPERATIONS_CONTRACT.md`](./ATLAS_OPERATIONS_CONTRACT.md) — the agent-first status surface (`npm run atlas:status` and the public `GET /.well-known/atlas-status.json`). A status contract, not a work-selection plan.
- [`docs/ATLAS_OWNERSHIP_CONNECTIVITY_INVENTORY.md`](./ATLAS_OWNERSHIP_CONNECTIVITY_INVENTORY.md) — the single connectivity inventory of every route, service, client module, flag, Sheet tab, and planning doc, each with a provisional keep/adapt/retire disposition (Atlas Recovery Campaign, Phase 2 Work item 1b). An assessment that feeds later owner gates; it authorizes nothing.
- [`docs/CAPABILITY_COMPLETION_LADDER.md`](./CAPABILITY_COMPLETION_LADDER.md) — the published nine-rung completion ladder for every coach capability (Atlas Recovery Campaign, Phase 2 Work item 3; closes H-05/H-15). The skimmable view of the `ladder` fields in `config/coaching/manifests/capabilities.json`, replacing the retired single `status`.
- [`docs/OWNER_CHECKIN_RULES.md`](./OWNER_CHECKIN_RULES.md) — the narrow owner-reserved categories and absolute data safety.
- [`docs/DECISION_ROUTING.md`](./DECISION_ROUTING.md) — ChatGPT decision desk for genuinely non-derivable product/trust forks.
- [`docs/RISK_LABELS.md`](./RISK_LABELS.md) — primary risk labels.
- [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) — merge-card evidence format.

`AGENTS.md` and `CODEX.md` are compatibility pointers to `CLAUDE.md`; they define no independent process.

## Evidence and operational ledgers

- [`docs/TEST_QUEUE.md`](./TEST_QUEUE.md) — owner/live evidence cards. LT-010 recorded the original Soul closeout (M1, 2026-07-16); the active Soul work is now **Phase 1 — Soul Recovery (Issue #1073)** of the Atlas Recovery Campaign embedded in the execution plan, gated by an owner Soul gate workout.
- [`docs/ONE_BRAIN_PROMOTION_CRITERIA.md`](./ONE_BRAIN_PROMOTION_CRITERIA.md) — reusable evidence standard for Brain promotion; promotion is always explicit and owner-reserved.
- [`docs/AGENT_LIVE_TESTING.md`](./AGENT_LIVE_TESTING.md) — agent-run live-test tiers and production safeguards.
- [`docs/TESTING_INDEX.md`](./TESTING_INDEX.md) — the single catalogue of every test/CI/verification system, its exact command, and whether it can touch the real Sheet. A map, not an authority.
- [`docs/BUG_TRIAGE_LEDGER.md`](./BUG_TRIAGE_LEDGER.md) — Bug_Reports open/done record.
- [`BACKLOG.md`](../BACKLOG.md) — intake, deferred work, and finding detail.
- [`BACKLOG_ARCHIVE.md`](../BACKLOG_ARCHIVE.md) — shipped/cancelled history only.

## Current product and system specs

Use these only when the active execution card touches their area:

- `SESSION_DESIGN.md`
- `CONVERSATION_DESIGN.md`
- `COACH_PERSONALITY.md`
- `API_REFERENCE.md`
- `docs/SHEET_CONTRACT.md`
- `docs/SAFETY_RULES.md`
- `docs/COACHING_ENGINE_ARCHITECTURE.md`
- [`docs/CANONICAL_CONTRACTS.md`](./CANONICAL_CONTRACTS.md) — ratification charter + ledger for the eight canonical contracts (Phase 2 Work item 2): the versioning convention and each contract's current home, status, and ratification target. Per-contract schemas land as sequenced follow-up PRs.
- `docs/COACHING_CONTRACTS_SPEC.md`
- `docs/COACHING_STATE_ASSEMBLY_SPEC.md`
- `docs/COACHING_SESSION_GENERATOR_SPEC.md`
- `docs/SUBSTITUTION_SPEC.md`
- `docs/DELOAD_SPEC.md`
- `docs/COACH_VOICE_VALIDATION.md`
- `docs/COACHING_NOTE_VOICE.md`
- `docs/COACH_MOMENTS_ENGINE.md`
- `docs/TODAY_SCREEN_SPEC.md`
- `docs/RECOMMENDATION_PIPELINE_V1_5.md`
- `docs/TRAINING_SME_LAYER.md`
- `docs/SESSION_PLANS_CAPTURE_SPEC.md`
- `docs/WORKOUT_SHEET_DESIGN.md`

Planning/design specs do not become execution queues merely by existing. Their work must be selected by the canonical V1 plan or a later owner-approved replacement after V1 stabilization.

## Research and audits

Research, architecture reviews, audits, diagnosis docs, and proposal packets are preserved source material. They may explain a decision or supply evidence, but they never choose the next PR.

Examples:

- [`docs/research/knowledge-foundation/`](./research/knowledge-foundation/README.md) — the completed 26-prompt **Atlas Knowledge Foundation** research package (research cutoff 2026-07-18). Records the authoritative Drive/tracker location and the six canonical deliverables, and reconciles the package's six P0 production-runtime assurance gates against current repository truth. Research/reference input only — it selects no work; the Recovery Campaign remains the sole authority.
- `docs/research/coaching-intelligence/`
- `docs/AUDIT_2026-07-07_DEEP_REVIEW.md`
- `docs/REMEDIATION_REVIEW_2026-07-08.md`
- `docs/COACH_VOICE_ARCHITECTURE_REVIEW_2026-07-09.md`
- `docs/COACH_INTERACTION_TRUST_INVESTIGATION.md`
- `docs/proposals/`
- `docs/reference/ATLAS_RECOVERY_CAMPAIGN_SPEC.md` — verbatim owner input for the Atlas Recovery Campaign. **Reference input only**; the executable truth is the campaign embedded in the execution plan.
- `docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md` + `docs/reference/ATLAS_SOUL_CORPUS_V2_SYNTHESIS.md` — the owner-provided Atlas Soul Corpus V2 (fifteen annotated coaching sessions + its engineering synthesis). **Reference input only** — a behavioral corpus, not a prompt/template/roadmap; it selects no work. Replayed against the real read-only code by the Corpus Baseline Runner (scoreboard: `docs/verification/CORPUS_BASELINE_SCOREBOARD.md`).
- `docs/reference/ATLAS_SOUL_CORPUS_V2_SECTION_F_RECONCILIATION.md` — maps each Soul Corpus V2 Section-F gap to the campaign phase that already owns it; genuinely-new items filed as `BACKLOG.md` intake. **A mapping, not a plan** — sequences nothing; the execution plan governs.
- `docs/SOUL_RECOVERY_AUDIT.md` — the Phase 1 recovery audit: every live workout voice path mapped to its facts/model/persona/override/output. Evidence for Issue #1073; read-only.

## Retired compatibility pointers

The following filenames remain only because old docs, PRs, and issues link to them. Their former plan bodies are gone and they redirect to the canonical plan:

- `FIX_PLAN.md`
- `COACH_PLAN.md`
- `COACH_INTELLIGENCE_PLAN.md`
- `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN.md`
- `docs/ACTIVE_ROADMAP.md`
- `docs/SOUL_PLAN_V1.md`
- `docs/POST_SOUL_V1_FINISHING_PLAN.md`
- `docs/REMEDIATION_PLAN_V2.md`
- `docs/ROADMAP.md`
- `docs/PRODUCT_PLAN.md`
- `docs/COACH_NEXT_LEVEL_BUILD_PLAN.md`
- `docs/COACH_INTELLIGENCE_ROADMAP.md`
- `docs/ATLAS_CONVERSATION_PROTOTYPE_V1_PLAN.md`
- `docs/COMPOSER_FIRST_MIGRATION.md`
- `docs/CODEX_SESSION_STARTER.md`

`docs/ATLAS_SOUL_READINESS_PLAN.md` was deleted because its useful content was fully reconciled and it had no independent durable authority.

Git history is the archive. Do not resurrect retired prompts, sequencing, model advice, or workflow rules from history.

## Operations, release, and security

These remain active when their domain applies:

- `DEPLOYMENT_GUIDE.md`
- `QUICKSTART.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/BACKUP_ROLLBACK.md`
- `docs/TROUBLESHOOTING.md`
- `docs/OWNER_SESSION.md` — durable owner-session cookie (F04C): endpoints, cookie flags, migration, and the `ATLAS_SESSION_SECRET` activation step.
- `docs/SECRET_HYGIENE_PLAN.md`
- `docs/SECRET_HYGIENE_CHECKLIST.md`
- `docs/SECRET_ROTATION_RUNBOOK.md`
- `docs/NO_WRITE_SAFETY.md`
- `docs/MISSION_CONTROL.md`

## Rule for future documents

Before adding a document, classify it as exactly one of:

1. durable product truth;
2. invariant/architecture/specification;
3. evidence/operations ledger;
4. research/audit/reference;
5. the canonical execution plan.

Atlas may have only **one** canonical execution plan. Do not add another roadmap, phase plan, fix-it plan, campaign controller, or session-specific master prompt. Add new work to `BACKLOG.md`; promote it into the execution plan only through an explicit owner-approved campaign change.
