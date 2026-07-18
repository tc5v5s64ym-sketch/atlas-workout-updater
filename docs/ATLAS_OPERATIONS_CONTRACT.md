# Atlas Operations Contract (Control Tower)

> **Status:** Active operational contract. `CLAUDE.md` is canonical and
> `docs/ATLAS_V1_EXECUTION_PLAN.md` selects work — this document defines the
> **status surface**, not the roadmap. It never selects a PR.

One agent-first way to answer, from a clean checkout and nothing else:

- **Where are we?** → active milestone + first unfinished card.
- **Is prod healthy?** → deployed commit, service configuration, overall verdict.
- **Did the latest write + undo actually hold?** → latest trusted test verdict and its write/undo verdicts.

You do **not** need a Sheet ID, tab names, session IDs, or a doc path to get this.
Two entry points, one schema:

| Surface | Who | Auth | Command / URL |
|---|---|---|---|
| Command | agent at repo root | none | `npm run atlas:status` (human) · `npm run atlas:status -- --json` (schema) |
| Endpoint | anyone / uptime checks | **none** (public, redacted) | `GET /.well-known/atlas-status.json` |

> **Companion command (not this surface):** `npm run atlas:review-live`
> (`scripts/atlas-review-live.js`, F09C) reviews the **newest real app session** —
> it selects the latest session, joins Flight Recorder / Intent Shadow / Brain Shadow /
> Session Plans / Log / Effort, and reports PASS/FAIL/UNKNOWN per trust criterion
> (UNKNOWN = missing evidence, never a false green). `atlas:status` answers **general
> health / campaign status**; `atlas:review-live` reviews **one specific session**. Both
> are read-only.

The command, when `ATLAS_BASE_URL` is set, fetches and presents the deployed
endpoint's document (and warns if your local `HEAD` differs from the deployed
commit). Offline or with no base URL, it degrades to a **local view** assembled
from the checked-out plan + test ledger + env-presence flags; the deployed commit
is unknown offline, so health honestly reports `unknown`.

The assembler and the redaction whitelist live in
[`services/atlasStatus.js`](../services/atlasStatus.js); the CLI is
[`scripts/atlas-status.js`](../scripts/atlas-status.js); the public route is
registered in `index.js` alongside `/health` and `/version`.

## Schema (`schema_version: 1.0`)

The JSON document is a flat object whose keys are a **closed whitelist**
(`ALLOWED_KEYS` in `services/atlasStatus.js`). Nothing outside that set is ever
emitted.

| Key | Meaning |
|---|---|
| `schema_version` | Contract version (`"1.0"`). |
| `generated_at` | ISO timestamp the document was assembled. |
| `generated_by` | `"endpoint"` (server) or `"cli"` (local fallback). |
| `overall_status` | `healthy` \| `degraded` \| `unknown`. Never a false green — see rules below. |
| `status_reason_codes` | Machine codes explaining the verdict. |
| `deployed_commit` | Short commit the running build reports (`unknown` when not known). |
| `app_version` | Friendly build label, e.g. `"PR #1021"`, or `null`. |
| `deployed_at` | Process-start ISO time of the running server, or `null`. |
| `active_milestone` | The plan's current active milestone line, or `null`. |
| `active_card` / `active_card_title` / `active_card_status` | First non-COMPLETE card in the execution plan. |
| `sheets_configured` | `true`/`false`/`null` — Google Sheets **credentials present** (a presence check, **not** a live read). |
| `llm_configured` | `true`/`false`/`null` — coach LLM (Gemini) **key present** (presence, not a live ping). |
| `llm_provider` / `llm_model` | Coach provider + model name (never a key). |
| `flight_recorder_enabled` | Whether `ATLAS_FLIGHT_RECORDER` is on. |
| `latest_test_id` | Newest trusted test (by recorded date) in `docs/TEST_QUEUE.md`. |
| `latest_test_verdict` | `PASS` \| `FAIL` \| `UNKNOWN`. |
| `latest_test_write_verdict` | `verified` \| `attempted` \| `unknown` \| `n/a`. |
| `latest_test_undo_verdict` | `confirmed` \| `attempted` \| `unknown` \| `n/a`. |
| `latest_test_freshness_days` | Whole days since that test's newest recorded date, or `null`. |
| `synthetic_rows_remaining` | Count of leftover synthetic rows, or `null` when not scanned. |
| `owner_action_required` / `owner_action_codes` | Whether an owner/agent action is outstanding, and which. |
| `source_freshness` | Per-source availability (`execution_plan`, `test_queue`, `build_info`). |
| `unavailable_sources` | `[{source, reason}]` — sources that could not be read. Failures are surfaced, never swallowed. |

## Sources (all read-only, all best-effort)

- **Build / version:** `services/buildInfo.js` + the runtime commit (`RENDER_GIT_COMMIT`).
- **Campaign:** the `**Current active milestone:**` line and the first non-COMPLETE `### F..` card in `docs/ATLAS_V1_EXECUTION_PLAN.md` (ids like `F09`, `F10A`, and the 2026-07-18 stabilization insertion's `F10S1`…`F10S6` / `F10S-GATE`).
- **Services:** `getSafeSpreadsheetConfig().canVerify` (sheets), `coach.isConfigured()` + `coach.coachModel()` (LLM), `isFlightRecorderEnabled()` (recorder) — **presence probes only**.
- **Latest test:** newest-by-date LT card in `docs/TEST_QUEUE.md`, with conservative write/undo extraction.
- **Synthetic rows:** not scanned by the status surface (a live authenticated read). Use `POST /api/admin/preview-test-rows` when a real count is needed.

## Redaction (hard rules)

- Output keys are a **closed whitelist**; arbitrary source objects are never spread in.
- Never emits secrets/API keys, Sheet IDs or ranges, workout/health data, Flight Recorder transcripts, emails, raw GitHub comments, or stack traces.
- The public endpoint requires **no** browser API key and performs **no** write and **no** authenticated live read.

## Honesty rules (no false green)

- `overall_status: healthy` requires **all** of: `deployed_commit` known, `sheets_configured` and `llm_configured` true, plan available, and `latest_test_verdict === 'PASS'`. Configuration presence alone is necessary but never sufficient.
- A hard problem (sheets/LLM unconfigured, latest test FAIL, or `synthetic_rows_remaining > 0`) → `degraded`.
- Missing/unparseable evidence (build unknown, plan/test unreadable, latest test not confirmed PASS) → `unknown`.
- A write is reported `verified` / an undo `confirmed` **only** when the ledger explicitly says so; a mere attempt reads as `attempted`, and anything unclear stays `unknown`. "Completed" and "merely attempted" are never conflated.

## Fallback behaviour

Every source degrades independently. A single unreadable file or an unreachable
deployed endpoint lands in `unavailable_sources` and pulls `overall_status` away
from `healthy` — it never crashes the command or fakes a value. If the endpoint's
own assembler throws, it returns `overall_status: "unknown"` with
`STATUS_ASSEMBLY_FAILED`, never a green.

## Scope (deliberately small)

This is a status surface, not a dashboard. There is no new database, no Supabase,
no duplicate telemetry store, and no second results ledger. It composes existing
readers and the existing evidence docs.
