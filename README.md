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
  "session_id": "session-2026-05-19-2026-05-19T17-45-10-123Z",
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


Example authenticated request:

```bash
curl -X POST https://<your-service-url>/api/log-workout \
  -H "Content-Type: application/json" \
  -H "x-atlas-api-key: $ATLAS_API_KEY" \
  -d @workout-payload.json
```

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
