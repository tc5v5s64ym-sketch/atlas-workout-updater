# Atlas Workout Updater

A small Node.js Express app that accepts finalized workout data and appends it to a Google Sheet with two tabs: `Log` and `Effort`.

## Features

- `GET /health`
- `POST /api/log-workout`
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

## Setup

1. Clone the repository.

2. Install dependencies:

```bash
npm install
```

3. Create a Google service account with access to the Google Spreadsheet.

4. Share the spreadsheet with the service account email.

5. Copy `.env.example` to `.env` and add your values:

```bash
cp .env.example .env
```

6. Set environment variables in `.env`:

- `GOOGLE_SHEETS_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `PORT` (optional)

> For `GOOGLE_PRIVATE_KEY`, keep the full private key text, escaping newlines as `\n` if needed.

## Run

```bash
npm start
```

The server listens on `http://localhost:3000` by default.

## API

### POST /api/log-workout

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

Response:

- `200` if data was appended successfully
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

## Test payload

Use `workout-payload.json` as a sample request payload.

## Notes

- Tab names must exist in the spreadsheet as `Log` and `Effort`.
- The app uses `INSERT_ROWS` semantics to append data at the bottom.
