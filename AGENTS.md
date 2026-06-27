# AGENTS.md

For full product governance, safety rules, and PR workflow, read `CLAUDE.md` first — it is the authoritative agent brief for this repo.

## Cursor Cloud specific instructions

Atlas is a single Node.js/Express service (`index.js`) that parses natural-language gym input, previews rows, and writes to Google Sheets on explicit approval. There is no database. The lightweight web UI is served at `/app/`.

### Running things (standard commands)

Commands are defined in `package.json` scripts:
- Lint (syntax-only `node --check` over all `*.js`): `npm run lint`
- Unit/integration tests (`node:test`, ~2858 tests): `npm test`
- End-to-end UI tests (Playwright): `npm run test:e2e`
- Run the server in dev: `npm run dev` (serves on `PORT`, default 3000; UI at `/app/`)

### Non-obvious caveats

- **`npm test` and `npm run lint` need no credentials.** The test suite injects a stubbed `sheets.js` via `require.cache` before the app loads, so no Google access is required.
- **The server requires env vars to boot.** `startServer()` calls `validateConfig()`, which throws unless `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY` are all present; `ATLAS_API_KEY` gates every `/api/*` call. If these are not injected as secrets, create a local `.env` (gitignored) with stub values to boot — copy `.env.example`. Stubs are enough to run the deterministic read-only paths; only real Google service-account credentials enable live Sheets reads/writes.
- **With stub Google credentials**, startup logs `{"event":"startup_diagnostics","ok":false,...}` and any endpoint that reads/writes Sheets (Progress, History, dashboards, `/api/log-workout`, etc.) will fail — this is expected. The deterministic, read-only trust-loop preview still works fully without Sheets: `POST /api/parse-workout-text` with header `x-atlas-api-key: <key>` and body `{"text":"...","test_mode":true}`. `test_mode:true` is mandatory — the endpoint is dry-run only and rejects requests without it. A successful dry-run returns `sheet_written:false` and `no_write_confirmed:true` (the no-write proof contract).
- **Never run a real workout write without explicit owner approval** (see `CLAUDE.md` / `README.md` safety rules). Use the `test_mode=true` dry-run path for verification.
- **Playwright e2e** uses Chromium only (both desktop and mobile projects force `chromium`). The browser binary must be installed once (`npx playwright install chromium`); the update script handles this. The e2e suite mocks all `/api/*` calls via `tests/e2e/static-server.js`, so it needs no backend or credentials.
