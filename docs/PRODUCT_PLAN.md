# Atlas Product Plan

> Product reference only. This is not the active PR queue.
> Use `BACKLOG.md` for priorities, `docs/ACTIVE_ROADMAP.md` for current execution, and `docs/AGENT_WORKFLOW.md` for agent handoff.

For the finished product north star, read [ATLAS_PRODUCT_VISION.md](ATLAS_PRODUCT_VISION.md).

## MVP App

Goal: make Atlas usable without raw API calls.

First useful screen:

- Recent sessions.
- Start workout.
- Enter sets.
- Upload Apple Watch screenshot.
- Review parsed effort.
- Preview enriched rows.
- Approve write.
- See next recommendation.

## Coaching Intelligence

Start with transparent rules before opaque automation:

- RIR-aware progression.
- Deload/stall detection.
- Exercise rotation suggestions.
- Fatigue guardrails.
- Notes for soreness or injury.
- Weekly adherence summary.

## Nutrition and Bodyweight

- Bodyweight trend.
- Calories/macros logging.
- Weekly adherence.
- Training feedback that accounts for bodyweight trend and recovery.

## Mission Control UI

Eventually expose:

- Current production sheet label.
- Last smoke result.
- Required tab status.
- Dry-run no-write status.
- Rollback instructions.

## First Product PRs

1. API response contract tests.
2. Session/progress endpoint fixtures.
3. Frontend wireframe/spec for review-before-write.
4. Database migration architecture decision record.
