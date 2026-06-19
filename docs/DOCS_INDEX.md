# Atlas Documentation Index

This file explains which docs are active instructions, which are reference/spec docs, and which are historical plans. It exists so agents do not accidentally follow an old roadmap.

## Source of truth

- `BACKLOG.md` — single source of truth for open and deferred work.
- `docs/ACTIVE_ROADMAP.md` — current critical path and PR 355-371 execution queue.

When these disagree, stop and ask the owner before changing direction.

## Agent entry points

- `CLAUDE.md` — operating brief for Claude Code and other AI agents.
- `CODEX.md` — operating brief for Codex/coding agents.
- `docs/AGENT_WORKFLOW.md` — Dale + ChatGPT + Claude Code + CODEX Review + GitHub workflow.
- `docs/ACTIVE_ROADMAP.md` — current queue; read before selecting the next PR.
- `BACKLOG.md` — open/deferred work and owner decisions.

Agents should not start from old plan docs.

## Active roadmap / queue

- `docs/ACTIVE_ROADMAP.md` — active PR 355-371 path after June 2026 app testing.

## Product and architecture reference

These are reference docs. Use them when relevant, but do not treat them as the active build queue.

- `docs/ATLAS_PRODUCT_VISION.md`
- `docs/CONSTITUTION.md`
- `docs/ARCHITECTURE.md`
- `docs/INVARIANTS.md`
- `docs/SHEET_CONTRACT.md`
- `docs/SAFETY_RULES.md`
- `docs/WORKFLOW.md`
- `docs/ROADMAP.md`
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

## Historical / archived plans

These are useful history, but they are not the current execution queue unless `BACKLOG.md` or `docs/ACTIVE_ROADMAP.md` explicitly points to a step.

- `FIX_PLAN.md` — archived; already marked as superseded by `BACKLOG.md`.
- `COACH_PLAN.md` — historical coach intelligence build plan; much of it has shipped.
- `COACH_INTELLIGENCE_PLAN.md` — historical PR 341-344 substitution/intelligence plan; much has shipped.
- `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN.md` — historical performance-intelligence plan; steps 345-353 largely shipped, remaining wiring is folded into `docs/ACTIVE_ROADMAP.md` PR 362-365.
- `docs/COACH_NEXT_LEVEL_BUILD_PLAN.md` — future/reference; do not execute ahead of active roadmap.
- `docs/PRODUCT_PLAN.md` — product reference; not the active PR queue.

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
