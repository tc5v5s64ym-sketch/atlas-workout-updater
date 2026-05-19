# Atlas Workout Updater

A small Node.js Express app that accepts finalized workout data and appends it to a Google Sheet with two tabs: `Log` and `Effort`.

## Features

- `POST /api/log-workout`
- Accepts JSON payload with:
  - `session_id`
  - `date`
  - `log_rows`
  - `effort_row`
- Appends `log_rows` to the `Log` sheet tab
- Appends `effort_row` to the `Effort` sheet tab
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
    ["session-123", "2026-05-19", "Exercise", "Sets", "Reps", "Weight"]
  ],
  "effort_row": ["session-123", "2026-05-19", "Total Effort", "8.5"]
}
```

Response:

- `200` if data was appended successfully
- `400` if payload validation fails
- `500` if the Sheets API operation fails

## Test payload

Use `workout-payload.json` as a sample request payload.

## Notes

- Tab names must exist in the spreadsheet as `Log` and `Effort`.
- The app uses `INSERT_ROWS` semantics to append data at the bottom.
