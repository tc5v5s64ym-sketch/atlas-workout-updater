# Atlas — AI Agent Operating Brief

This file is the first thing an AI agent (Claude Code, Codex, or any other) should read before touching this repository.

---

## What this repo is

Atlas is a personal workout logging assistant for one owner (Dale). It parses natural-language gym input, previews rows, and writes to Google Sheets on explicit approval. There is no database — Google Sheets is the permanent record.

Read `docs/CONSTITUTION.md` for mission and scope.
Read `docs/INVARIANTS.md` for rules that must never be broken.

---

## Branch strategy

- Develop on the branch specified in your task brief (typically prefixed `claude/`).
- Never push directly to `main`.
- PRs must be tiny — one concern per PR (see Invariant PR1).

---

## Before you write any code

1. Check `config/routes.js` — if you are adding a route, add it here too.
2. Check `docs/INVARIANTS.md` — if your change touches the parser, sheet writes, auth, or undo flow, re-read the relevant invariant group first.
3. Check existing tests in `test/api-smoke.test.js` — the stubs pattern matters (see Invariants T1–T3).

---

## Critical behaviours — never change without owner approval

| Behaviour | Where |
|---|---|
| Slash notation: `225 5/2` = 225 lb × 5 reps @ RIR 2 | `services/workoutTextParser.js` |
| `test_mode` absent = live write | `index.js` log-workout handler |
| Dry-run proof fields: `sheet_written:false`, `no_write_confirmed:true` | `index.js` |
| Live-write proof fields: `sheet_write:'success'`, `log_rows_written>0` | `index.js` |
| Undo read-back: missing/empty row = 409 | `index.js` undo-last handler |
| Log tab restriction in undo | `index.js` undo-last handler |

---

## 12-column row contract

Every row written to `Log_Cleaned` must have exactly these columns in this order:

```
date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code | set_number | weight | reps | rir | notes | volume_calc
```

Do not add, remove, or reorder columns without a schema migration and explicit owner approval.

---

## Test suite

```bash
npm test
```

Tests use `require.cache` injection to stub `sheets.js` before the Express app loads. Never replace this with a mocking library without reviewing the injection pattern first — the stub must capture the destructured function references that `index.js` grabs at load time.

---

## What not to build

Unless the owner explicitly requests it, do not add:

- Nutrition tracking
- Voice interface
- Multi-user support
- A secondary database (SQLite, Postgres, etc.)
- An "Atlas Brain" autonomous agent mode
- A Dashboard tab restoration
- Big refactors "to clean things up"

When in doubt, do less and ask.

---

## Security — hard stops

- Never commit `.env`, API keys, Google credentials, screenshots, or workout data.
- Never print `ATLAS_API_KEY` in any log or response.
- Never change `GOOGLE_SHEETS_ID` in a routine PR.
- Never change Render environment variables without explicit owner approval.
- Never call a real Google Sheets write during tests.

---

## Useful entry points

| File | Purpose |
|---|---|
| `index.js` | All Express routes and request handlers |
| `sheets.js` | Google Sheets client — read, append, delete |
| `services/workoutTextParser.js` | Natural-language parser (sacred) |
| `public/app.js` | Single-page frontend |
| `config/routes.js` | Route manifest for `/routes` endpoint |
| `test/api-smoke.test.js` | Full API smoke suite with stubbed Sheets |
| `docs/CONSTITUTION.md` | Mission, scope, product laws |
| `docs/INVARIANTS.md` | Safety rules |
