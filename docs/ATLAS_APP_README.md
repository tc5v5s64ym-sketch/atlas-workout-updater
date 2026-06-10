# Atlas App README

## What Atlas Is

Atlas is a personal AI fitness platform that helps the owner log workouts, parse Apple Watch screenshots, track progress, and receive coaching recommendations.

The finished app should feel like a trusted training assistant: fast enough for workout logging, careful enough to avoid bad production writes, and clear enough that the owner can inspect, recover, and improve the system over time.

## Core User Experience

The intended finished workflow:

1. User starts a workout.
2. User logs sets conversationally or through a UI.
3. User can upload an Apple Watch screenshot.
4. Atlas parses effort data.
5. Atlas enriches exercises using the catalog.
6. Atlas previews cleaned rows before writing.
7. User approves.
8. Atlas writes to the cleaned production log.
9. Atlas updates session summaries, progress, and recommendations.
10. User can review history, trends, and next workout guidance.

## Current Backend Capabilities

- Node.js and Express backend.
- Render deployment.
- Google Sheets persistence.
- OpenAI Vision screenshot parsing.
- API key auth.
- Workout ingestion.
- Exercise enrichment.
- Duplicate protection.
- `test_mode` dry-runs.
- Mission Control GitHub Actions.
- No-write safety proof.

## Finished App Features

### Workout Logging

Atlas should support conversational set logging and structured workout entry. It should track reps, load, RIR, notes, and volume calculation while protecting against duplicate sessions.

Session summaries should be understandable at a glance: what was trained, how much work was done, and what changed compared with prior sessions.

### Apple Watch Integration

Atlas should accept Apple Watch workout screenshots and parse effort data such as:

- Duration.
- Active calories.
- Total calories.
- Average heart rate.
- Peak heart rate.
- Location and notes.

The parsed effort data should be previewed before it is saved.

### Review Before Write

Atlas must not rely on blind writes. Before saving, the app should show:

- Parsed workout data.
- Parsed effort data.
- Enriched exercise rows.
- Canonical exercise names.
- Muscle groups.
- Lift codes.
- Warnings or validation issues.

The user approves before Atlas writes to production.

### Progress Dashboard

Atlas should provide a dashboard for:

- Recent sessions.
- Exercise progress.
- Muscle group volume.
- Top exercises.
- Workout consistency.
- PRs.
- Estimated strength trends.

Dashboard features belong in the app experience. The old Google Sheets `Dashboard` tab is optional and must not become a backend requirement.

### Coaching Intelligence

Atlas should turn logged training into useful next-step guidance:

- Next set recommendations.
- RIR-aware progression.
- Stall detection.
- Deload suggestions.
- Fatigue guardrails.
- Workout planning.

Coaching should start transparent and explainable, then become more sophisticated as the data and product mature.

### Nutrition and Bodyweight

Future Atlas versions should support:

- Bodyweight logging.
- Trend tracking.
- Nutrition summaries.
- Calorie and macro support.
- Training feedback that accounts for bodyweight and recovery.

## Safety and Mission Control

Atlas safety is part of the product, not just internal tooling.

Core safety features:

- Dry-run mode.
- No-write proof.
- Cleaned sheet contract.
- Backup and rollback procedures.
- Secret hygiene.
- Production smoke tests.

`would_write:true` is not proof of no-write safety. A trusted dry-run must prove `test_mode:true`, `sheet_written:false`, and `no_write_confirmed:true`.

## Data Storage

Google Sheets is the current database because it is simple, inspectable, and easy to recover from.

Required production tabs:

- `Metadata`
- `Log_Cleaned`
- `Exercise_Catalog`
- `Effort`
- `Logic`
- `Session_Summary`

Dashboard is optional and must not be required.

A real database may be better later for scale, speed, auth, mobile UX, and richer analytics. Future versions may move primary storage to a database while keeping Google Sheets as an export or reporting layer.

## Architecture Philosophy

Atlas is being built in practical stages.

The current version uses Google Sheets, Render, GitHub Actions, ChatGPT, Codex, and a Node/Express backend because that stack is simple, inspectable, easy to debug, and easy to recover from. That does not mean this is the permanent final architecture.

Atlas should remain open to better, safer, simpler, and more efficient ways to build the app as the product becomes clearer.

Future improvements may include:

- Moving from Google Sheets to a real database.
- Keeping Google Sheets as an export/reporting layer.
- Improving the frontend with a dedicated web or mobile app.
- Reducing manual AI handoffs.
- Improving authentication and private access.
- Adding better monitoring and alerting.
- Creating a cleaner approve-before-save workflow.
- Changing hosting or deployment if another platform becomes a better fit.

Render is the current hosting choice, but other deployment options may be considered later. The current AI workflow works, but future tooling may reduce the number of manual steps.

The goal is not to defend the current stack forever. The goal is to safely evolve Atlas toward the simplest, most reliable system that supports the product.

Any future architecture change must preserve Atlas's core safety principles:

- No blind writes.
- Owner approval before production writes.
- Dry-run and `test_mode` validation.
- Backup and rollback ability.
- Clear production verification.
- Protection of private workout and health data.

## AI Workflow

- ChatGPT is PM, architect, and release manager.
- Codex is the coding agent.
- Claude, Grok, and Copilot can review.
- GitHub PRs are inspection hold points.
- Render deploys `main`.
- Mission Control verifies safety.

This workflow is useful now, but it is not sacred. Atlas should keep whatever parts improve safety and speed, and replace whatever becomes unnecessary as the product matures.

## Safety Rules

- No real write without owner approval.
- Use `test_mode=true` for dry-runs.
- No secrets in repo, logs, docs, or PR bodies.
- No Render environment changes without approval.
- No `GOOGLE_SHEETS_ID` changes without approval.
- Dashboard is optional only.
- Small PRs are preferred.

## Current Status

✅ Idea defined
✅ Backend built
✅ Google Sheets connected
✅ OpenAI Vision parsing working
✅ Workout ingestion working
✅ Exercise enrichment working
✅ Cleaned sheet live
✅ Mission Control working
✅ Dry-run safety proven
✅ Codex hardening tests/docs/runbooks merged
✅ Agent instructions merged
✅ Secret hygiene docs merged
✅ `.env` untracked
✅ Manual secret rotation complete
✅ Post-rotation Mission Control passed

🔄 Backup / rollback plan

⏳ First real write
⏳ First real workout logged end-to-end
⏳ Monitoring / error alerts

⏳ Read-only UI
⏳ Progress dashboard
⏳ Workout logger UI
⏳ Apple Watch upload/review UI
⏳ Approve-before-save workflow

⏳ Coaching intelligence
⏳ Program/progression engine
⏳ Nutrition/bodyweight
⏳ User profile/settings
⏳ Better auth / private access
⏳ Full mobile app
⏳ Database/backend evolution

## Near-Term Roadmap

1. Backup / rollback plan merge.
2. Google Sheet backup copy.
3. Mission Control `full` with sheet label `cleaned`.
4. First real workout write.
5. Read-only UI.
6. Approve-before-save workflow.
7. Progress dashboard.
8. Coaching engine.
9. Update README.md as the product shape changes.
