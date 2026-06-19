# Atlas Roadmap

> Historical/reference-only. This is not the active execution queue.
> Use `BACKLOG.md` for priorities, `docs/ACTIVE_ROADMAP.md` for the current queue, and `docs/AGENT_WORKFLOW.md` for the agent process.

For the finished product north star, read [ATLAS_PRODUCT_VISION.md](ATLAS_PRODUCT_VISION.md).

## Milestone 1: Stability and Safety

Goal: keep production boring and recoverable.

- Harden no-write dry-runs.
- Keep Dashboard optional.
- Improve smoke tests and docs.
- Add release and rollback checklists.

First PR: foundation audit and hardening.

## Milestone 2: Better Workout History APIs

Goal: make Atlas better at answering training-history questions.

- Richer session search.
- Exercise history summaries.
- Weekly volume trends.
- PR tracking by lift and rep range.
- Stall and deload signals.

First PR: add tests around history/session/progress response contracts.

## Milestone 3: Coaching Intelligence

Goal: turn logged training into useful next-step guidance.

- RIR-aware load suggestions.
- Next workout recommendations.
- Fatigue guardrails.
- Soreness or injury notes.
- Program adherence checks.

First PR: document recommendation rules and add test fixtures for common lifts.

## Milestone 4: Nutrition and Bodyweight

Goal: connect training progress with bodyweight and nutrition context.

- Bodyweight trend.
- Calories and macros logging.
- Weekly adherence summaries.
- Coaching feedback.

First PR: harden bodyweight endpoints and add no-write preview support.

## Milestone 5: Frontend/App

Goal: make Atlas usable without manual API calls.

- Mobile workout entry.
- Screenshot review before approving writes.
- Progress dashboard.
- Admin Mission Control status.

First PR: product spec and API contract for the review-before-write screen.

## Milestone 6: Data Backend Evolution

Goal: outgrow Sheets only when needed.

- Keep Sheets as export/reporting.
- Add database-backed storage when write volume or query needs justify it.
- Plan backups and migration.

First PR: architecture decision record comparing Sheets-only versus database-backed Atlas.
