# Atlas Workout Updater

A small Node.js Express app that accepts finalized workout data and appends it to a Google Sheet with two tabs: `Log` and `Effort`.

## Features

- `GET /health`
- `POST /api/log-workout` (requires `x-atlas-api-key` header)
- `POST /api/parse-workout-image` (requires `x-atlas-api-key`; placeholder for future image ingestion)
- Accepts JSON payload with:
  - `session_id` (required)
  - `date` (required)
  - `log_rows` (required, non-empty array with 11 values per row or objects matching Log_Cleaned fields; missing canonical fields are auto-filled from `Exercise_Catalog`)
  - `effort_row` (required, 9 values or object with Effort schema)
- Appends `log_rows` to the `Log` sheet tab
- Appends `effort_row` to the `Effort` sheet tab
- Rejects duplicate Session IDs already present in the Effort sheet
- Enriches incoming exercise names from the `Exercise_Catalog` tab
- Uses Google Sheets API with a service account
- Stores credentials in environment variables

## Required environment variables

For Railway deployment, set all of the following variables in the service:

- `GOOGLE_SHEETS_ID` (Google Spreadsheet ID)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` (service account email)
- `GOOGLE_PRIVATE_KEY` (service account private key; keep line breaks escaped as `\n`)
- `LOG_SHEET_NAME` (sheet tab name for workout log rows, typically `Log`)
- `EFFORT_SHEET_NAME` (sheet tab name for effort rows, typically `Effort`)
- `ATLAS_API_KEY` (shared secret required in `x-atlas-api-key` header for `POST /api/log-workout`)
- `OPENAI_API_KEY` (required for `/api/parse-workout-image` OpenAI Vision parsing)

`PORT` is provided automatically by Railway at runtime, and the server already listens on `process.env.PORT`.

## Local setup

1. Clone the repository.
2. Install dependencies:

```bash
npm install
```

3. Create a Google service account with access to the Google Spreadsheet.
4. Share the spreadsheet with the service account email.
5. Copy `.env.example` to `.env` and add values:

```bash
cp .env.example .env
```

> `.env` is ignored by git and should never be committed.

## Run locally

```bash
npm start
```

The server listens on `http://localhost:3000` by default.

## Deploy on Railway

1. Push this repository to GitHub/GitLab.
2. In Railway, create a new project and choose **Deploy from GitHub repo**.
3. Select this repository.
4. In Railway service settings, set these environment variables:
   - `GOOGLE_SHEETS_ID`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`
   - (optional) `LOG_SHEET_NAME`
   - (optional) `EFFORT_SHEET_NAME`
5. Set Start Command to:

```bash
npm start
```

6. Redeploy the service.
7. Verify deployment using:
   - `GET /health`
   - your production service URL from Railway

### Railway notes

- Railway sets `PORT` dynamically; do not hardcode a port.
- Keep `GOOGLE_PRIVATE_KEY` exactly as one env var string with escaped newlines (`\n`).

## API

### All Endpoints (Route Summary)

| Endpoint | Method | Auth | Read-Only | Purpose |
|----------|--------|------|-----------|---------|
| `/api/session/:sessionId/summary` | GET | Yes | Yes | Get comprehensive session summary with quality score |
| `/api/exercises/:liftCode/progress` | GET | Yes | Yes | Track exercise progress over time with trends |
| `/api/volume/muscle-groups` | GET | Yes | Yes | Aggregate volume by muscle group (configurable days) |
| `/api/search/sessions` | GET | Yes | Yes | Find sessions by exercise, lift code, date range, muscle group |
| `/api/prs/recent` | GET | Yes | Yes | Get recent personal records by lift code |
| `/api/recommend/next/:liftCode` | GET | Yes | Yes | Get coaching recommendation for next working set |
| `/api/bodyweight` | POST | Yes | No | Log bodyweight entry (requires Bodyweight tab) |
| `/api/bodyweight/history` | GET | Yes | Yes | Retrieve bodyweight history with trend analysis |
| `/api/admin/preview-test-rows` | POST | Yes | Yes | Preview rows marked as test data (does NOT delete) |
| `/api/history/recent` | GET | Yes | Yes | Returns recent sessions, sets, and effort rows |
| `/api/exercises/:liftCode` | GET | Yes | Yes | Returns detail for a lift code |
| `/api/recommend/next/:liftCode` | GET | Yes | Yes | Returns coaching guidance for the next working set |
| `/api/summary/weekly` | GET | Yes | Yes | Returns a 7-day workout summary |
| `/api/catalog/exercises` | GET | Yes | Yes | List all exercises from Exercise_Catalog |
| `/api/catalog/search` | GET | Yes | Yes | Search Exercise_Catalog by name or lift code |
| `/api/session/:sessionId` | GET | Yes | Yes | Returns all Log_Cleaned rows for a session |
| `/api/complete-workout` | POST | Yes | No | Full workout ingestion (image + log rows) |
| `/api/parse-workout-image` | POST | Yes | No | Parse workout screenshot only, no data write |
| `/api/log-workout` | POST | Yes | No | Append log and effort rows directly |

---

### Feature Breakdown

#### 1. Session Summary API
**GET /api/session/:sessionId/summary**

Returns a comprehensive summary of a single workout session including:
- `session_id`, `date`, `exercises` list, `total_sets`, `total_volume`
- `top_set` (highest weight × reps set with weight > 0)
- `effort` (HR, duration, calories from Effort tab if present)
- `quick_summary` (narrative summary of the session)
- `quality_score` (out of 5: +1 each for ≥10 sets, ≥30 min duration, ≥100 avg HR, ≥3 exercises, no warnings)

Example:
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  https://your-api.com/api/session/20250517-AM-01/summary
```

#### 2. Exercise Progress API
**GET /api/exercises/:liftCode/progress**

Tracks a specific lift over time:
- `sessions` (all sessions where this lift was performed)
- `best_weight_over_time` (weight progression per session)
- `estimated_1rm_over_time` (estimated 1RM progression)
- `volume_over_time` (total volume per session)
- `recent_trend` ("up", "flat", or "down" based on last two sessions)

Example:
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  https://your-api.com/api/exercises/SQ/progress
```

#### 3. Muscle Group Volume API
**GET /api/volume/muscle-groups?days=14**

Aggregates volume by muscle group for recent sessions:
- Query param: `days` (default 14)
- Returns: array of `{ muscle_group, volume, set_count }`
- Ignores weight=0 rows for volume calculation but counts them as sets

Example:
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "https://your-api.com/api/volume/muscle-groups?days=7"
```

#### 4. Session Search API
**GET /api/search/sessions**

Find sessions matching multiple criteria (all optional):
- Query params: `exercise`, `liftCode`, `dateFrom` (YYYY-MM-DD), `dateTo`, `muscleGroup`
- Returns: `{ session_ids, rows }` matching all provided filters
- Does NOT write to Sheets

Example:
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "https://your-api.com/api/search/sessions?liftCode=BP&dateFrom=2025-05-01"
```

#### 5. Recent PRs API
**GET /api/prs/recent**

For each lift code in recent history, returns:
- `bestWeightSet` (highest weight set)
- `bestRepSet` (highest reps set)
- `bestEstimated1RMSet` (highest estimated 1RM)
- All ignore weight=0 rows
- Includes date and session_id

Example:
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  https://your-api.com/api/prs/recent
```

#### 6. Recommended Next Set API
**GET /api/recommend/next/:liftCode**

Intelligent recommendation for the next working set:
- Returns: `{ recommendation, reasoning, last_working_sets }`
- Logic:
  - If RIR ≥ 2 and reps stable: recommend +5 lb (upper body) or +10 lb (lower body)
  - If RIR ≤ 0: recommend repeat or reduce 5%
  - Otherwise: same weight, add reps
- Simple, explainable reasoning

Example:
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  https://your-api.com/api/recommend/next/BP
```

#### 7. Bodyweight Logging
**POST /api/bodyweight**

Append a bodyweight entry (requires Bodyweight tab to exist):
- Request body:
  ```json
  {
    "date": "2025-05-17",
    "weight": 240.5,
    "notes": "morning"
  }
  ```
- If Bodyweight tab missing: returns 400 error (does not auto-create)

Example:
```bash
curl -X POST -H "x-atlas-api-key: $ATLAS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"date":"2025-05-17","weight":240.5}' \
  https://your-api.com/api/bodyweight
```

#### 8. Bodyweight History
**GET /api/bodyweight/history?days=30**

Retrieve bodyweight entries with trend:
- Query param: `days` (default 30)
- Returns: `{ entries, latest, average, trend }`
- `trend`: "up", "down", or "flat"

Example:
```bash
curl -H "x-atlas-api-key: $ATLAS_API_KEY" \
  "https://your-api.com/api/bodyweight/history?days=90"
```

#### 9. Cleanup Test Data Preview
**POST /api/admin/preview-test-rows**

Admin helper to identify test data (does NOT delete):
- Returns rows where:
  - Notes contain "test"
  - Session ID contains "test"
  - Session ID contains "session-2026"
- Returns: `{ log_candidates, effort_candidates }`
- ⚠️ **Preview only—no rows are deleted**

Example:
```bash
curl -X POST -H "x-atlas-api-key: $ATLAS_API_KEY" \
  https://your-api.com/api/admin/preview-test-rows
```

#### 10. Quality Score Calculation

Used in session summaries and complete-workout responses. Simple rules:
- +1 if total_sets ≥ 10
- +1 if effort duration ≥ 30 minutes
- +1 if average_hr ≥ 100
- +1 if session has ≥ 3 unique exercises
- +1 if no validation warnings
- **Score out of 5**

---

### Existing Endpoints (Maintained)

- `GET /api/history/recent` — Returns recent sessions, sets, and effort rows. Requires `x-atlas-api-key` header. Query params: `limit` (default 5), `exercise` (optional filter), `exclude_test=true` (optional to filter out rows where notes contain "test").
- `GET /api/exercises/:liftCode` — Returns detail for a lift code (names seen, total sets, best weight/reps, best weight set, best volume set, estimated 1RM, and recent working sets). Requires `x-atlas-api-key`.
- `GET /api/summary/weekly` — Returns a 7-day workout summary across Log and Effort rows. Requires `x-atlas-api-key`.
- `GET /api/pending-exercises` — Read-only placeholder. Returns an empty pending exercise list and a message that persistence is not implemented. Requires `x-atlas-api-key`.
- `GET /api/session/:sessionId` — Returns all `Log_Cleaned` rows and the matching Effort row for a given session. Requires `x-atlas-api-key`.

---

### Authentication & Admin Routes

All `/api/*` endpoints require `x-atlas-api-key` header.

Admin routes (`/api/admin/*`) use the same key. **No destructive delete endpoints are implemented.** Currently:
- `/api/admin/preview-test-rows` — Preview-only, never modifies data


### POST /api/parse-workout-image

Required header:

```http
x-atlas-api-key: <ATLAS_API_KEY>
```

This endpoint accepts `multipart/form-data` uploads using the `image` field and stores files temporarily in `/tmp/uploads` before cleanup.

Optional form-data fields:
- `session_id`
- `date`
- `location`
- `notes`
- `auto_write` (`true` to append generated `effort_row` to the Effort sheet)

Validation and normalization (applies when `auto_write=true`):
- `duration` is required and will be normalized to `HH:MM:SS` (examples: `52:28` -> `00:52:28`, `0:52:28` -> `00:52:28`, `1:05:00` -> `01:05:00`).
- `activeCalories` must be a number between `1` and `3000`.
- `totalCalories` must be a number between `1` and `4000`.
- `averageHR` must be a number between `40` and `220`.
- `peakHR` must be a number between `40` and `230`.

- `averageHR` must be a number between `40` and `220`.
- `peakHR` is optional; if present must be a number between `40` and `230`.

If validation fails when `auto_write=true`, the endpoint returns `400` with a clear error message and nothing is written to Google Sheets. If validation passes but values are inconsistent, the response may include `warnings` (for example, when `totalCalories < activeCalories` or `peakHR < averageHR`) but the row is still written.

If `session_id` is omitted, the server generates one from the current date/time.

Example upload request:

```bash
curl -X POST https://<your-service-url>/api/parse-workout-image \
  -H "x-atlas-api-key: $ATLAS_API_KEY" \
  -F "image=@/path/to/workout-screenshot.jpg"
```

Current response:

```json
{
  "status": "image received",
  "filename": "<saved-temp-filename>",
  "size": 12345,
  "session_id": "20260519-PM-01",
  "date": "2026-05-19",
  "parsed": {
    "duration": "00:54:00",
    "activeCalories": 485,
    "totalCalories": 580,
    "averageHR": 132,
    "peakHR": 158,
    "workoutType": "Mixed Cardio"
  },
  "effort_row": [
    "2026-05-19",
    "session-2026-05-19-2026-05-19T17-45-10-123Z",
    "00:54:00",
    485,
    580,
    132,
    158,
    "Gym",
    "Imported from screenshot"
  ],
  "sheet_write": "success"
}
```

The endpoint uses OpenAI Vision via `services/vision.js` to extract structured workout metrics (`duration`, `activeCalories`, `totalCalories`, `averageHR`, `peakHR`, `workoutType`). It returns an `effort_row` array formatted for the Effort sheet schema: `Date, Session ID, Duration, Active Calories, Total Calories, Average HR, Peak HR, Location, Notes`.

If `auto_write=true` is provided, it attempts to append `effort_row` to the Effort sheet using existing duplicate protection on `session_id`. The response includes `sheet_write` as `success`, `skipped` (duplicate or auto_write not enabled), or `failed`.

If parsing fails or `OPENAI_API_KEY` is missing, it returns an error and does not write anything to Google Sheets.

### POST /api/log-workout

Required header:

```http
x-atlas-api-key: <ATLAS_API_KEY>
```

Request body:

```json
{
  "session_id": "session-123",
  "date": "2026-05-19",
  "log_rows": [
    {
      "date_clean": "2026-05-19",
      "session_id": "session-123",
      "exercise": "Bench Press",
      "set_number": 3,
      "weight": 225,
      "reps": 8,
      "rir": 2,
      "notes": "Good control"
    }
  ],
  "test_mode": true,
  "effort_row": {
    "date": "2026-05-19",
    "session_id": "session-123",
    "duration": "00:54:00",
    "active_calories": 485,
    "total_calories": 580,
    "average_hr": 132,
    "peak_hr": 158,
    "location": "Gym",
    "notes": "Focused on form and tempo"
  }
}
```


`effort_row` is optional. If omitted, the endpoint writes only `log_rows` to `Log_Cleaned` and skips Effort duplicate-session checks and Effort writes.

If `test_mode` is `true` (boolean) or `"true"` (string), the endpoint still validates payload fields, enriches `log_rows`, and formats `effort_row` when provided, but **does not write** to Google Sheets. The response includes `test_mode: true`, `sheet_write: "skipped"`, `log_rows_preview`, and `effort_row_preview` (only when provided).

Example authenticated request:

```bash
curl -X POST https://<your-service-url>/api/log-workout \
  -H "Content-Type: application/json" \
  -H "x-atlas-api-key: $ATLAS_API_KEY" \
  -d @workout-payload.json
```

### POST /api/complete-workout

Full ingestion endpoint that accepts an Apple Watch screenshot plus simplified log rows and appends both the `Log_Cleaned` and `Effort` tabs.

Required header:

```http
x-atlas-api-key: <ATLAS_API_KEY>
```

Accepts `multipart/form-data` with fields:
- `image`: Apple Watch screenshot file (required)
- `session_id`: optional (server generates one if omitted)
- `date`: optional (defaults to today if omitted)
- `location`: optional
- `notes`: optional
- `test_mode`: optional (`true` to validate and preview without writing to Sheets)
- `log_rows_json`: required — JSON array of simplified log rows with this shape:

```json
[
  {
    "exercise": "Back Squat",
    "set_number": 1,
    "weight": 225,
    "reps": 5,
    "rir": 2,
    "notes": ""
  }
]
```

Behavior:
- Uses the same Vision parser (`/services/vision.js`) to extract effort metrics from the screenshot.
- Generates `session_id` in the format `YYYYMMDD-AM-01` or `YYYYMMDD-PM-01` when omitted.
- Validates and normalizes parsed effort metrics before writing (same rules as documented above). If validation fails, nothing is written and the endpoint returns `400` with an error.
- Enriches `log_rows_json` using the `Exercise_Catalog` and formats them for the `Log` sheet. If enrichment/validation fails, nothing is written and the endpoint returns `400`.
 - Enriches `log_rows_json` using the `Exercise_Catalog` and formats them for the `Log` sheet. If enrichment/validation fails, nothing is written and the endpoint returns `400`.
  - Canonical exercise names, muscle group, and lift codes are populated from the `Exercise_Catalog`.
  - Example: `Back Squat` -> `SQ01`; `Lat Pulldown` -> `LPD01` (these values come from your `Exercise_Catalog` sheet).
  - If an exercise is not found, the row will have blank `Canonical_Exercise`, `Muscle_Group`, and `Lift_Code`, and the response will include the entry in `pending_exercises` for manual review.
- Applies duplicate `session_id` protection before writing; if duplicate, returns `409` and writes nothing.
- Appends enriched log rows to the `Log` sheet and the normalized effort row to the `Effort` sheet.
- If `test_mode=true`, performs parsing, validation, and enrichment only and does not write to Google Sheets; the response includes the rows that would have been written.

Response (200 on success):

```json
{
  "status": "image received",
  "session_id": "20260519-PM-01",
  "date": "2026-05-19",
  "log_rows_written": 4,
  "effort_written": true,
  "parsed_effort": {
    "duration": "00:52:28",
    "activeCalories": 400,
    "totalCalories": 520,
    "averageHR": 130,
    "peakHR": 150,
    "workoutType": "Mixed Cardio"
  },
  "warnings": ["totalCalories is less than activeCalories"]
}

Pending exercises
- When `/api/complete-workout` encounters an exercise not present in `Exercise_Catalog`, the response will include `pending_exercises`, an array of objects:

```json
[
  {
    "exercise": "Some New Lift",
    "suggested_canonical_name": "Some New Lift",
    "reason": "No Exercise_Catalog match"
  }
]
```

These are only returned in the response for manual review — they are not written to Google Sheets automatically.
```

This endpoint does not change the behavior of `/api/log-workout` or `/api/parse-workout-image` — it simply combines parsing, enrichment, validation, and append steps into one flow.

Response:

- `200` if data was appended successfully
- `401` if `x-atlas-api-key` is missing or invalid
- `400` if payload validation fails
- `409` if the session already exists in the Effort sheet
- `500` if the Sheets API operation fails

Successful responses may include a `warnings` array if an exercise name could not be matched in `Exercise_Catalog`.

### GET /health

Response:

```json
{
  "status": "ok",
  "service": "atlas-workout-updater"
}
```


## Future workflow notes

- Continue using `POST /api/log-workout` for structured payload ingestion into Google Sheets.
- Future screenshot ingestion should call `POST /api/parse-workout-image`, then transform parsed output into the existing `log_rows` + `effort_row` schema before calling `POST /api/log-workout`.
- Keep Google Sheets append behavior centralized in the current workflow; do not append directly from image parsing until OCR/parsing is production-ready.

## Test payload

Use `workout-payload.json` as a sample request payload.

## Notes

- Tab names must exist in the spreadsheet as `Log` and `Effort`.
- The app uses `INSERT_ROWS` semantics to append data at the bottom.
