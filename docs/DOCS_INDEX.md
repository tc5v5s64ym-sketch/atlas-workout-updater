# Atlas Documentation Index

This file explains which docs are active instructions, which are reference/spec docs, and which are historical plans. It exists so agents do not accidentally follow an old roadmap.

## Source of truth

- `BACKLOG.md` — single source of truth for open and deferred work.
- `docs/ACTIVE_ROADMAP.md` — current critical path; Roadmap Steps 355–370 are complete, Step 371 (Coach Voice Polish) is next.

When these two disagree, stop and ask the owner before changing direction.

> **Warning for agents:** Do NOT use any historical or archived doc as an active execution queue. The sections below mark which docs are stale. Treating a stale doc as current will cause you to re-build completed work or diverge from the owner's direction.

## Agent entry points

- `docs/GOVERNANCE.md` — **read first**. Defines how Dream, Vision, Constitution, Roadmap, and Backlog relate and where to file new ideas.
- `CLAUDE.md` — operating brief for Claude Code and other AI agents.
- `CODEX.md` — operating brief for Codex/coding agents.
- `docs/AGENT_WORKFLOW.md` — Dale + ChatGPT + Claude Code + CODEX Review + GitHub workflow.
- `docs/ACTIVE_ROADMAP.md` — current queue; read before selecting the next PR.
- `BACKLOG.md` — open/deferred work and owner decisions.

Agents should not start from old plan docs.

## Automation framework (active)

The automation-first contract. Read with `docs/AGENT_WORKFLOW.md`.

- `docs/DECISION_KERNEL.md` — the operational distillation of Vision / Roadmap / Architecture / Constitution / Invariants: the durable principles + document precedence read FIRST for routine autonomous decisions (so the full north-star docs are not re-read every PR).
- `docs/AUTOMATION_PROTOCOL.md` — the automation contract: roles (Claude builder, Codex contract guard, GitHub Actions enforcement, owner exception-handler), the skipped/errored/incomplete-review-is-a-failure principle, and merge eligibility.
- `docs/OWNER_CHECKIN_RULES.md` — the decision criteria and who answers each (Codex by default; owner only on escalation); everything else proceeds automatically.
- `docs/DECISION_ROUTING.md` — the Codex Decision Desk: Claude's decision panels route to Codex (not the owner), answered in GitHub via the existing Claude subscription token (no new paid API).
- `docs/RISK_LABELS.md` — risk classification labels and when each applies (manifest: `.github/labels.yml`).
- `docs/AUTOMATION_AUDIT.md` — snapshot of existing automation, gaps, and next automation PRs.
- `.github/PULL_REQUEST_TEMPLATE.md` — the one-screen merge card every PR must produce.

## Active roadmap / queue

- `docs/ACTIVE_ROADMAP.md` — active queue; current workstream is the Trust-Critical Coach Interaction Layer (P0–P4) after June 2026 live testing.
- `docs/COACH_INTERACTION_TRUST_INVESTIGATION.md` — active diagnosis doc for the Trust-Critical Coach Interaction Layer (P0 active-session context, P1 substitution-signal visibility). Read before implementing any P0/P1 fix.

## Product and architecture reference

These are reference docs. Use them when relevant, but do not treat them as the active build queue.

- `docs/ATLAS_PRODUCT_VISION.md`
- `docs/CONSTITUTION.md`
- `docs/ARCHITECTURE.md`
- `docs/INVARIANTS.md`
- `docs/SHEET_CONTRACT.md`
- `docs/SAFETY_RULES.md`
- `docs/MISSION_CONTROL.md`

## Current/valid specs

These describe specific systems or constraints. Use them when your PR touches that area.

- `SESSION_DESIGN.md`
- `CONVERSATION_DESIGN.md`
- `docs/SUBSTITUTION_SPEC.md`
- `docs/DELOAD_SPEC.md`
- `docs/COACH_VOICE_VALIDATION.md`
- `docs/COACHING_NOTE_VOICE.md`
- `docs/TODAY_SCREEN_SPEC.md`
- `docs/RECOMMENDATION_PIPELINE_V1_5.md`
- `docs/TRAINING_SME_LAYER.md`
- `docs/TRAINING_PROFILE_TAXONOMY.md` — planning spec for multi-style training support (five training profiles, profile-score model, modality schema, onboarding classifier, profile-aware stimulus governor). Owner-gated, not active roadmap; filed in `BACKLOG.md`.
- `docs/SESSION_PLANNING_ENGINE.md` — planning spec for the Session Planning Engine (daily objective scoring, supported session objectives, deterministic exercise order rules, fatigue-adjusted plans, a recovery/deload model — trigger convergence, profile-aware deload styles, the normal-routing→recovery_reload→deload→taper→maintenance→complete-rest boundary — and a golden-fixture proposal). Builds on the Training Profile Taxonomy; the deload section is planning-only and does not change `docs/DELOAD_SPEC.md`. Owner-gated, not active roadmap; filed in `BACKLOG.md`.

## Historical / archived plans

**DO NOT TREAT THESE AS THE ACTIVE EXECUTION QUEUE.** They are useful history but must not be used to select or sequence PRs. If any of these conflict with `BACKLOG.md` or `docs/ACTIVE_ROADMAP.md`, the latter two win.

- `FIX_PLAN.md` — archived; superseded by `BACKLOG.md`.
- `COACH_PLAN.md` — historical coach intelligence build plan; much has shipped.
- `COACH_INTELLIGENCE_PLAN.md` — historical PR 341–344 substitution/intelligence plan; much has shipped.
- `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN.md` — historical performance-intelligence plan; Steps 345–353 largely shipped; remaining wiring folded into `docs/ACTIVE_ROADMAP.md` Steps 362–370 (now ✅ complete).
- `docs/COACH_NEXT_LEVEL_BUILD_PLAN.md` — future/reference; do not execute ahead of active roadmap.
- `docs/ROADMAP.md` — historical milestone roadmap; not the active execution queue.
- `docs/PRODUCT_PLAN.md` — product reference; not the active PR queue.
- `docs/WORKFLOW.md` — historical workflow reference; current process lives in `docs/AGENT_WORKFLOW.md`.
- `docs/CODEX_SESSION_STARTER.md` — historical prompt starter; verify against active docs before reuse.

## Operations / release / security docs

Use these for deployment, rollback, release, secret handling, and troubleshooting.

- `DEPLOYMENT_GUIDE.md`
- `QUICKSTART.md`
- `COMPLETION_CHECKLIST.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/BACKUP_ROLLBACK.md`
- `docs/TROUBLESHOOTING.md`
- `docs/SECRET_HYGIENE_PLAN.md`
- `docs/SECRET_HYGIENE_CHECKLIST.md`
- `docs/SECRET_ROTATION_RUNBOOK.md`
- `docs/NO_WRITE_SAFETY.md`

## Audit / baseline docs

Useful for history and context. Do not use them as current task lists.

- `AUDIT.md`
- `docs/AUDIT_2026-06-12.md`
- `docs/AUDIT_TRIAGE_2026-06-20.md` — current-state triage of the AUDIT.md Medium/Low findings (ME-5/6/9/10/11/12, LO-1…LO-11), verified against `main` with file:line evidence.
- `docs/API_AUDIT.md`
- `docs/FOUNDATION_AUDIT.md`
- `docs/BASELINE_POST_CUTOVER.md`
- `docs/COACH_LOOP_V1_QA.md`
- `docs/FIRST_REAL_WRITE.md`

## Rule for future docs

Before adding a new roadmap or plan doc, ask whether it belongs in:

1. `BACKLOG.md` as the source-of-truth queue,
2. `docs/ACTIVE_ROADMAP.md` as detailed current execution path, or
3. a narrow spec doc linked from one of those two.

Do not create a new competing roadmap.
