# Agent Live Testing — self-serve playbook

> **Status:** Active. Standing owner authorization. Companion to
> `CLAUDE.md` (escalation policy), `docs/OWNER_CHECKIN_RULES.md`, and
> `docs/MISSION_CONTROL.md`.

**Standing owner authorization (2026-07-14):** when the owner says "test the app
for/against X" (in any wording), the agent designs and runs the test itself using
this doc. Do not ask the owner for URLs, API keys, sheet IDs, or tab names —
everything needed is here or in the local `.env`.

## Targets

- **Deployed app:** `ATLAS_BASE_URL` from `.env` (production on Render). Before
  any test, `GET /version` and record the deployed build in the results.
- **API key:** `ATLAS_API_KEY` from `.env`, sent as the `x-atlas-api-key` header.
  Never print, echo, or commit it.
- **Google Sheet (permanent data store):** `GOOGLE_SHEETS_ID` from `.env`. Tab
  contract lives in `config/sheetContract.js`. Required tabs: Metadata,
  Log_Cleaned, Exercise_Catalog, Effort, Logic, Session_Summary. Optional tabs
  include Session_Plans, Modality_Log, Brain_Shadow, Intent_Shadow,
  Flight_Recorder. Test/shadow evidence lands in Brain_Shadow and Intent_Shadow
  (plus their `Archive_*` snapshots). **Log_Cleaned is the owner's real training
  history — treat it as production data.**

## Mark every request synthetic

Every agent request MUST send `x-atlas-request-origin` with a recognized
synthetic token from `services/evidenceProvenance.js` — use `probe` for ad-hoc
agent tests, `smoke` for the smoke script, `playwright` for browser runs. This
classifies agent traffic `synthetic` so it can never count toward the GATE A
promotion floor. **Agent testing never substitutes for the owner's real gym
sessions — GATE A / proving-run evidence stays owner-only by provenance design.**

## Test tiers

- **Tier 1 — read-only (pre-authorized, run without asking):** GET endpoints,
  `/version`, read-only `POST /api/coach/chat` probes, Playwright page loads and
  screenshots, `scripts/live-retest.js` (read-only by contract),
  `scripts/smoke-test-render.js` in `read-only` / `dry-run-only` modes, and the
  offline suite (`npm test`).
- **Tier 2 — dry-run writes (pre-authorized, run without asking):** any write
  endpoint with `test_mode: true`. Every dry-run response must prove no-write:
  `sheet_written:false` and `no_write_confirmed:true` (or legacy
  `sheet_write:'skipped'`). If a dry-run ever reports a real write, STOP — that
  is a trust regression; file it immediately.
- **Tier 3 — real writes (only when the owner's instruction for THIS test
  explicitly authorizes it):** a real write lands in the owner's production
  sheet. If authorized: tag written rows identifiably (e.g. an `AGENT-TEST`
  marker in notes), record exactly what was written, and clean the rows up when
  the test ends unless told to keep them. Never escalate to Tier 3 on your own —
  almost everything is provable at Tier 1/2.
- **Never, at any tier:** bypass or weaken the preview → approve → write trust
  loop; change `test_mode` / proof-field semantics; write to Log_Cleaned outside
  an explicitly authorized Tier 3 test.

## How to run a test

1. Read the owner's ask; choose the smallest tier that proves it.
2. `GET /version`; confirm the expected build is live.
3. Design probes — reuse existing machinery first: `npm test`,
   `scripts/smoke-test-render.js`, `scripts/live-retest.js` + `tests/e2e/*.spec.js`,
   `test/fixtures/replays`. Hand-roll fetch/curl probes only when nothing
   existing fits.
4. Run; capture request, response, and verdict per check.
5. Report and file results (below).

## Where results go

- Live validation that closes a feature/PR gate → file or update an LT-xxx card
  in `docs/TEST_QUEUE.md` using the existing card format; mark it agent-run
  (precedent: LT-009, LT-011).
- Bugs found → file in `BACKLOG.md` per existing conventions. Do not reorder
  BACKLOG.
- Every run's report includes: deployed version tested, tier used, probes run,
  PASS/FAIL per check, evidence snippets (never the API key).

## What this doc is not

It claims no sequencing authority over `BACKLOG.md` or `ACTIVE_ROADMAP.md`. It is
not a merge gate. It does not replace owner live gym sessions.
