# AGENTS.md

Read `CLAUDE.md` first — it is the authoritative operating brief, governance, and safety contract for this repo. This file only adds environment/run notes.

## Cursor Cloud specific instructions

Atlas is a single Node.js (Express) service — `node index.js` — with a static PWA served at `/app/`. There is no separate frontend build and no database (Google Sheets is the only datastore). Standard commands live in `package.json` and `README.md`; use them as the source of truth:

- Lint: `npm run lint` (runs `node --check` on every `.js`)
- Tests: `npm test` (built-in `node --test`, 2800+ tests)
- Run (dev): `npm start` / `npm run dev` (both are `node index.js`)
- E2E (optional): `npm run test:e2e` (Playwright; needs Chromium installed)

Non-obvious caveats for running locally in this VM:

- The server boots only when these four env vars are present (`index.js` + `sheets.js` `validateConfig()` throw otherwise): `ATLAS_API_KEY`, `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`. dotenv loads a gitignored `.env` (see `.env.example`). For a local dev boot, stub values are enough — a `.env` with placeholder values lets the server start.
- With stub/placeholder Google credentials the process still listens on port 3000. Startup diagnostics logs `{"event":"startup_diagnostics","ok":false,...}` (a Google DECODER error) — this is expected and non-fatal. Endpoints that read/write Google Sheets (dashboard, history, recommendations, log-workout) will error, but the in-code parser/knowledge-base paths work without real Google.
- Every `/api/*` call requires the `x-atlas-api-key` header matching `ATLAS_API_KEY`. In the web UI, paste the key on the Settings screen (stored in browser localStorage).
- `POST /api/parse-workout-text` is dry-run only and requires `test_mode: true` in the body (else it 400s). It is the safest end-to-end smoke of the slash-notation parser and needs no real Google. Example: `{"text":"Bench Press 225 5/2","test_mode":true}` → parses `225 5/2` to 225 lb × 5 reps @ RIR 2 with proof fields `sheet_written:false`, `no_write_confirmed:true`.
- `npm test` needs no real credentials: it sets its own stub env vars and replaces `sheets.js` via `require.cache` injection before `index.js` loads (see `test/api-smoke.test.js`). Do not swap this for a mocking library without reading that pattern.
- Never run a real Google Sheets write. Real writes require real credentials AND explicit owner approval per `CLAUDE.md` / `docs/SAFETY_RULES.md`.
