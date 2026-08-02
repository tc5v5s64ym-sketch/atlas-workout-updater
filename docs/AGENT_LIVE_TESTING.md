# Agent Live Testing — self-serve playbook

> **Status:** Active standing owner authorization. Companion to `CLAUDE.md`, `docs/ATLAS_V1_EXECUTION_PLAN.md`, `docs/OWNER_CHECKIN_RULES.md`, and `docs/MISSION_CONTROL.md`.

When the owner says “test the app for/against X,” the agent designs and runs the smallest safe test itself. Do not ask Dale to repeat URLs, API keys, Sheet IDs, or tab names available in local `.env` and repository contracts.

## Quick status first

Before probing anything, run `npm run atlas:status` (add `-- --json` for the schema) — it answers "where are we / is prod healthy / did the latest write+undo hold" from the deployed public `GET /.well-known/atlas-status.json` (or a local view offline), with no Sheet ID or tab name needed. Contract: [`ATLAS_OPERATIONS_CONTRACT.md`](./ATLAS_OPERATIONS_CONTRACT.md).

## Review the newest live app session

To answer "review my latest live app test", run `npm run atlas:review-live` (add `-- --json`, or `-- --session=<flight_session_id>` / `-- --workout-session=<session_id>` / `-- --from-dir=<backup>`).

> **Name the session when you know it.** `--session=<flight_session_id>` fixes which session is reviewed, and `--workout-session=<session_id>` makes the row join exact and switches the date heuristic off entirely. Both are the reliable path: without them the tool must fall back to a local-date window, because the Flight Recorder stores request field *names* and never their values, so a workout `session_id` is often undiscoverable in the transcript. That fallback now reaches **one day either side** of the session's UTC window — a 20:34 Pacific workout is captured on the next UTC date while its rows carry the correct local date — and it **refuses to correlate at all** when the matched rows name more than one workout, reporting exactly why instead of guessing.
 It automatically selects the **newest** genuine owner session (prefers `flight_session_id`; falls back to the newest unlinked server rows — the v141 shape — so a broken session is still reviewed), joins Flight Recorder / Intent Shadow / Brain Shadow / Session Plans / Log / Effort, detects a build change during the session, and reports **PASS / FAIL / UNKNOWN per trust criterion** (UNKNOWN = missing evidence, never a false green). READ-ONLY; needs no Sheet ID, tab, or session id (reads local `.env` + `config/sheetContract.js`).

> **Two commands, one job each:** `atlas:status` answers general health / campaign status; `atlas:review-live` reviews the newest real app session.

## Targets

- **Deployed app:** `ATLAS_BASE_URL` from `.env`. Before any live test, `GET /version` and record the deployed build.
- **API key:** `ATLAS_API_KEY` from `.env`, sent as `x-atlas-api-key`. Never print, echo, or commit it.
- **Google Sheet:** `GOOGLE_SHEETS_ID` from `.env`. The authoritative tab contract is `config/sheetContract.js`. `Log_Cleaned` is Dale's real training history and must be treated as production data.

## Mark every agent request synthetic

Every agent request must send `x-atlas-request-origin` with a recognized synthetic token from `services/evidenceProvenance.js`: use `probe` for ad-hoc checks, `smoke` for smoke scripts, and `playwright` for browser runs.

Synthetic agent traffic never counts toward GATE A, LT owner/gym evidence, or the five-session proving run.

## Test tiers

### Tier 1 — read-only, pre-authorized

Run without asking:

- GET endpoints and `/version`;
- read-only `POST /api/coach/chat` probes;
- Playwright page loads;
- `scripts/live-retest.js` where its contract is read-only;
- `scripts/smoke-test-render.js` in read-only/dry-run-only modes;
- offline tests.

### Tier 2 — `test_mode:true` dry-run, pre-authorized

Only use against handlers positively confirmed to honor `test_mode`, including the workout logging paths currently designed for dry-run validation.

Every dry-run response must prove no write with `sheet_written:false` and `no_write_confirmed:true` (or an explicitly supported legacy skipped proof). If a dry-run reports a real write, stop immediately and treat it as a trust regression.

`test_mode` is not universal. System-state endpoints that do not inspect it are Tier 3 even if a caller sends the field. Check `config/routes.js`, the handler, and proof fields before assuming an endpoint is dry-run safe.

### Tier 3 — real write, explicit per-test authorization only

A real write to Dale's production Sheet requires explicit authorization for that test. When authorized:

- use an unmistakable test marker;
- record exact rows/ranges written;
- verify the intended behavior;
- clean up only through an approved application/admin path and only when the test authorization includes cleanup;
- stop on any data-integrity anomaly.

Never escalate to Tier 3 because Tier 1/2 is inconvenient.

### Never

- bypass or weaken preview → approve → write;
- change `test_mode` or proof semantics during a test;
- print secrets or private evidence;
- manually edit Sheet rows;
- fabricate owner activity, PRs, new-ground events, or GATE A provenance.

## Test loop

1. Read the canonical campaign card or owner's ask.
2. Choose the smallest tier that can prove it.
3. `GET /version` and confirm the expected build is live.
4. Reuse existing tests, smoke scripts, replays, and Playwright before hand-rolling probes.
5. Run and record request class, response evidence, and PASS/FAIL without secrets.
6. File the result in the correct repository home.

## Where results go

- Feature/campaign live evidence → `docs/TEST_QUEUE.md` LT card and the canonical plan card completion record.
- Bugs and adjacent discoveries → `BACKLOG.md` without expanding or reordering the active campaign.
- One-Brain evidence → the governed Brain Shadow/scorecard path in `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`.

Every report includes deployed version, test tier, probes, PASS/FAIL, and bounded evidence.

## What this document is not

This playbook supplies test authority and safety rules. It does not select work, authorize real writes, replace genuine owner gym evidence, or act as a merge gate. Sequencing belongs only to `docs/ATLAS_V1_EXECUTION_PLAN.md`.
