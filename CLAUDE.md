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

### Effort tab (9 columns)

Apple Watch / session effort rows written by `/api/complete-workout` go to the `Effort` tab in this order:

```
date | session_id | duration | active_calories | total_calories | average_hr | peak_hr | location | notes
```

`average_hr` and `peak_hr` are distinct metrics — never copy one into the other (see Invariant / the vision prompt in `services/vision.js`). These columns feed the recovery curve via `effortIntensityBySession()` in `services/analytics.js`.

---

## Coaching voice (LLM)

Atlas's deterministic engine owns every number; the LLM only ever *words* facts and *answers questions* — it never writes, and never invents numbers.

- **Provider selection** (`services/vision.js`, `getProviderConfig`): `ATLAS_LLM_PROVIDER` (`openai` default, or `gemini`) + `GEMINI_API_KEY` / `OPENAI_API_KEY` + optional `ATLAS_LLM_MODEL`. `gemini` with no key throws — never a silent fallback.
- **`services/coach.js`** — the Gemini coaching voice (separate `GEMINI_COACH_MODEL`, defaults to `gemini-2.5-flash-lite`). Three read-only voices: set reaction, plan "why today", and free-form chat. All degrade to `null`/templated copy when Gemini is down.
- **Read-only endpoints**: `POST /api/coach/message` (set/plan narration), `POST /api/coach/chat` (two-way Q&A grounded in a training snapshot). Neither touches Google Sheets. Both are `writeCapable:false` in `config/routes.js`.
- **Frontend**: `public/coach-conversation.js` types the replies (visual layer); `public/chat.js` paints user bubbles. Neither calls a write path — the trust loop stays in `public/app.js`.

When adding to the coach: forward only whitelisted fields to the model (see `sanitizeFacts` / `sanitizeChatContext`), never raw client objects.

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
| `services/analytics.js` | Recovery curve, intent scoring, stalls, session/progress builders |
| `services/vision.js` | Apple Watch screenshot parsing + LLM provider selection |
| `services/coach.js` | Gemini coaching voice (set / plan / chat) — read-only |
| `services/idempotency.js` | `write_id` dedup (in-memory, 24h TTL) for every write path |
| `services/exerciseEnrichment.js` | Catalog match, fuzzy lookup, lift-code generation |
| `public/app.js` | Single-page frontend — owns the trust loop (preview → approve → write) |
| `public/coach-conversation.js` | Visual coaching/chat layer — types replies, never writes |
| `public/chat.js` | Paints user bubbles; never calls the API |
| `config/routes.js` | Route manifest for `/routes` endpoint |
| `config/columns.js` | Column definitions for Log_Cleaned / Effort / Exercise_Catalog |
| `rules/` | Pre-write bounds, safety flags, progression rules |
| `test/api-smoke.test.js` | Full API smoke suite with stubbed Sheets |
| `test/coach.test.js` | Coach prompt guardrails + fact/context sanitizers |
| `tests/e2e/` | Playwright end-to-end suite (Coach shell + approve flow) |
| `docs/CONSTITUTION.md` | Mission, scope, product laws |
| `docs/INVARIANTS.md` | Safety rules |

### Write paths (all `write_id`-idempotent)

`POST /api/log-workout`, `POST /api/log-workout/undo-last`, `POST /api/complete-workout` (screenshot/effort), and `POST /api/bodyweight`. Each uses `beginWrite`/`completeWrite`/`failWrite`; a repeated `write_id` replays the original response instead of writing twice. Everything else is read-only.
