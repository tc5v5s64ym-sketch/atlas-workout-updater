# Atlas API Quick Reference

All endpoints require `x-atlas-api-key` header. All are read-only except where noted.

## Session & Summary Endpoints

```bash
# Get comprehensive session summary with quality score
GET /api/session/:sessionId/summary

# Get all data for a session
GET /api/session/:sessionId

# Get weekly 7-day summary
GET /api/summary/weekly
```

## Exercise & Lift Endpoints

```bash
# Get lift detail (best weight, volume, recent sets)
GET /api/exercises/:liftCode

# Get exercise progress over time with trend
GET /api/exercises/:liftCode/progress

# Get recent personal records
GET /api/prs/recent

# Get recommendation for next working set
GET /api/recommend/next/:liftCode
```

## Volume & Analysis Endpoints

```bash
# Get volume by muscle group (default 14 days)
GET /api/volume/muscle-groups?days=7

# Search sessions with filters
GET /api/search/sessions?liftCode=SQ&dateFrom=2025-05-01&dateTo=2025-05-31

# Get recent sessions and sets
GET /api/history/recent?limit=5&exercise=Bench%20Press&exclude_test=true
```

## Bodyweight Endpoints

```bash
# Log a bodyweight entry (requires Bodyweight tab)
POST /api/bodyweight
# Body: {"date": "2025-05-17", "weight": 240.5, "notes": ""}

# Get bodyweight history with trend (default 30 days)
GET /api/bodyweight/history?days=90
```

## Admin Endpoints

```bash
# Preview test data (does NOT delete)
POST /api/admin/preview-test-rows
```

## Workout Ingestion Endpoints

```bash
# Parse workout screenshot (image only)
POST /api/parse-workout-image
# Multipart form-data: image=[file], auto_write=true

# Complete workout (image + log rows)
POST /api/complete-workout
# Multipart form-data: image=[file], log_rows_json=[JSON]
# No-image dry run: test_mode=true, effort_json=[JSON], log_rows_json=[JSON]

# Direct log/effort append
POST /api/log-workout
# JSON body with session_id, date, log_rows
# Optional: effort_row
# Optional: test_mode=true to preview without writing
# Optional live-write idempotency: write_id
# Reusing the same write_id after a completed live write returns duplicate_write=true
# and does not append rows again. V1 stores write_id state in process memory, so it
# resets on service restart/deploy.
```

## Catalog Endpoints

```bash
# List all exercises
GET /api/catalog/exercises

# Search catalog
GET /api/catalog/search?q=squat
```

## Health & Debug Endpoints

```bash
GET /health
GET /
GET /version
GET /routes
GET /api/schema/log
GET /api/schema/effort
GET /api/schema/complete-workout
GET /api/health/sheets
GET /api/health/openai
GET /api/debug/config
GET /api/pending-exercises
```

---

## Response Format

All successful responses:
```json
{
  "status": "ok",
  "message": "Description",
  "data": { /* endpoint-specific data */ }
}
```

Error responses:
```json
{
  "status": "error",
  "message": "Error description",
  "details": "Optional details"
}
```

## Query Parameters

| Endpoint | Param | Default | Type |
|----------|-------|---------|------|
| `/api/volume/muscle-groups` | `days` | 14 | int |
| `/api/bodyweight/history` | `days` | 30 | int |
| `/api/history/recent` | `limit` | 5 | int |
| `/api/history/recent` | `exercise` | - | string |
| `/api/history/recent` | `exclude_test` | false | bool |
| `/api/search/sessions` | `liftCode` | - | string |
| `/api/search/sessions` | `exercise` | - | string |
| `/api/search/sessions` | `dateFrom` | - | YYYY-MM-DD |
| `/api/search/sessions` | `dateTo` | - | YYYY-MM-DD |
| `/api/search/sessions` | `muscleGroup` | - | string |

## Quality Score Calculation

Score: 0-5 points
- +1 if ≥ 10 total sets
- +1 if effort duration ≥ 30 minutes
- +1 if average HR ≥ 100
- +1 if ≥ 3 unique exercises
- +1 if no validation warnings

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Invalid parameters |
| 401 | Missing or invalid API key |
| 404 | Resource not found |
| 409 | Duplicate session |
| 500 | Server error |

## Rate Limiting

Currently unlimited (no rate limiting implemented).

## Required Environment Variables

```bash
GOOGLE_SHEETS_ID=<spreadsheet-id>
GOOGLE_SERVICE_ACCOUNT_EMAIL=<service-account-email>
GOOGLE_PRIVATE_KEY=<service-account-private-key>
ATLAS_API_KEY=<your-api-key>
OPENAI_API_KEY=<openai-api-key>
LOG_SHEET_NAME=Log_Cleaned
EFFORT_SHEET_NAME=Effort
BODYWEIGHT_SHEET_NAME=Bodyweight (optional)
PORT=3000 (optional, defaults to Railway env)
```

## Tabs Required

Core Atlas tabs:
- `Metadata`
- `Log_Cleaned` (or custom LOG_SHEET_NAME)
- `Exercise_Catalog`
- `Effort` (or custom EFFORT_SHEET_NAME)
- `Logic`
- `Session_Summary`

Optional:
- `Dashboard` (display/reporting only; backend health must not require it)
- `Bodyweight` (required if using `/api/bodyweight` endpoints)

Safe sheet promotion checklist:
- Back up the current production sheet before switching IDs.
- Validate a copied test sheet first with read-only backend checks.
- Run a `test_mode=true` complete-workout dry run before any real write.
- Never commit `.env`, API keys, Google credentials, screenshots, `.xlsx` exports, or private workout data.

## Date Formats Accepted

- ISO: `2025-05-17`
- Spreadsheet: `2025-05-17 0:00:00`
- Excel serial: `45447` (auto-converted)
- Various timezone formats

## Notes

- All data reads are non-destructive
- Bodyweight endpoint does not auto-create tabs
- Admin preview endpoint does NOT delete data
- Quality scores included in session summaries and complete-workout responses
- Test data detection looks for: "test" in notes/session_id, "session-2026" in session_id
