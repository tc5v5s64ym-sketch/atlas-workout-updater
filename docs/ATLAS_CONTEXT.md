# Atlas Context

## What Atlas Is

Atlas is a personal fitness platform. It is currently a production backend plus Google Sheets data layer, with a future path toward a mobile-friendly app and coaching system.

Atlas helps parse workout data, enrich exercises with canonical names and lift codes, store sessions, read history, detect progress, and recommend next sets.

## Current Backend Architecture

- Node/Express API
- API key auth for `/api/*`
- OpenAI Vision for Apple Watch screenshot parsing
- Google Sheets for persistence
- Exercise enrichment through `Exercise_Catalog`
- GitHub Actions Mission Control for production safety checks

## Render Deployment

Render hosts the production backend:

```text
https://atlas-workout-updater.onrender.com
```

Owner disabled Render auto-deploy on 2026-08-14 after an unauthorized S4 deploy of PR #1291, then completed the Render rollback to S3 `da16cd4b13912569870e9a6dee7a3281730027b1` (PR #1290). Leave auto-deploy off. Do not change Render environment variables unless the owner explicitly approves it. Production writes remain quarantined until `2026-08-15T02:24:37.691Z`. Evidence: `docs/ATLAS_V1_EXECUTION_PLAN.md` and `docs/verification/S4_ACCIDENTAL_DEPLOY_ROLLBACK_2026-08-14.md`.

## Google Sheets Persistence

Google Sheets is the current production database. The cleaned dashboard-free sheet is live. The backend depends on these required tabs:

- `Metadata`
- `Log_Cleaned`
- `Exercise_Catalog`
- `Effort`
- `Logic`
- `Session_Summary`

Dashboard is intentionally absent and optional.

## GitHub Actions Mission Control

Mission Control is the safety inspector. It runs from GitHub Actions and validates production using safe modes:

- `read-only`
- `full` with `test_mode=true`

Full mode must prove no-write safety before it is trusted.

## Completed Milestones

- Backend is live.
- Google Sheets integration works.
- OpenAI Vision parsing works.
- Workout ingestion works.
- Exercise enrichment works.
- Cleaned sheet is live.
- Dashboard is optional.
- Mission Control works.
- Dry-run safety is proven.

## Project Status Board

✅ Idea defined
✅ Backend built
✅ Google Sheets connected
✅ OpenAI Vision parsing working
✅ Workout ingestion working
✅ Exercise enrichment working
✅ Cleaned sheet live
✅ Mission Control working
✅ Dry-run safety proven

🔄 Codex hardening tests/docs/runbooks

⏳ First real write
⏳ First real workout logged end-to-end
⏳ Backup / rollback plan confirmed
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
