# Agent Live Testing — self-serve playbook

> **Status:** Active standing owner authorization. Companion to `CLAUDE.md`, `docs/ATLAS_V1_EXECUTION_PLAN.md`, `docs/OWNER_CHECKIN_RULES.md`, and `docs/MISSION_CONTROL.md`.

When the owner says “test the app for/against X,” the agent designs and runs the smallest safe test itself. Do not ask Dale to repeat URLs, API keys, Sheet IDs, or tab names available in local `.env` and repository contracts.

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
