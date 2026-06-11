# Atlas Safety Invariants

These rules must hold across every PR, every session, every AI agent action.
Violating any of them requires explicit owner approval before merging.

---

## 1. Parser Invariants

**P1. Slash = reps/RIR.** `225 5/2` is always 225 lb × 5 reps @ RIR 2. Never reps × set-count, never any other interpretation.

**P2. Parser changes require golden tests.** Any modification to the workout text parser must include or update golden-path test cases that cover the changed behaviour. No parser PR lands without them.

**P3. Slash notation is not configurable.** There is no flag, env var, or user setting that changes how `/` is interpreted in a workout string.

---

## 2. Sheet / Write Safety Invariants

**W1. Dry-run never writes.** When `test_mode=true` (or `confirm_delete` is absent), no row is appended, deleted, or modified in any Google Sheet. The response must carry `sheet_written:false` and `no_write_confirmed:true`.

**W2. `test_mode` absent = live write.** The default when `test_mode` is not supplied is a real write. Callers must pass `test_mode:true` explicitly for dry-runs. AI agents must never omit this field unless a real write is intended and approved.

**W3. Live writes require proof fields.** Every successful live write response must include:
- `sheet_write: 'success'`
- `log_rows_written: N` where N > 0
- `logAppendedRange` (the A1 range that was updated)

**W4. Log_Cleaned tab only for undo.** The undo-last endpoint (`POST /api/log-workout/undo-last`) may only delete rows from the `Log_Cleaned` tab. Any attempt to target another tab returns 400.

**W5. Read-back before delete.** Before deleting rows via undo-last, the endpoint reads back each target row and verifies the `session_id` matches the one in the request. A missing, empty, or mismatched row returns 409 — no delete occurs.

**W6. Never change GOOGLE_SHEETS_ID without a cutover.** Changing the spreadsheet ID is a production cutover. It requires an explicit owner decision, a rollback plan, and must not happen in a routine feature PR.

**W7. Undo span limit.** The undo endpoint will not delete more than 10 rows in a single request. `rows_to_delete` must match the span of the supplied A1 range; mismatches return 400.

---

## 3. Auth / Secrets Invariants

**S1. Never commit `.env` files, credentials, screenshots, or private workout data.** These must never appear in any commit, branch, or PR in this repository.

**S2. Never commit Google service account credentials.** Private key material must only be supplied via environment variables.

**S3. Never print ATLAS_API_KEY.** This key must not appear in logs, debug endpoints, or any response body visible outside the server process.

**S4. Never change Render environment variables without explicit owner approval.** Environment variable changes in the hosting provider are a production action.

---

## 4. Test / Dry-Run Invariants

**T1. All Sheets calls in tests use stubs.** No test may reach a real Google Sheets spreadsheet. `appendRows`, `deleteRowsByRange`, and all other sheet functions must be intercepted before `require('../index')` loads.

**T2. `allowAppend` flag gates live-write tests.** Tests that exercise the write path must flip `fakeSheetsState.allowAppend = true` before the call and restore it after. The default is `false` (stub returns without recording).

**T3. Undo tests verify indices, not just status.** A passing undo test must assert the correct `startIndex` / `endIndex` values passed to `deleteRowsByRange`, not just that a 200 was returned.

---

## 5. PR Scope Invariants

**PR1. Tiny PRs only.** Each PR changes one thing. A backend endpoint, a UI component, a test suite, or a doc file — not all of them together.

**PR2. Docs PRs touch only `docs/` and root markdown files.** No production code, no tests, no config changes in a documentation PR.

**PR3. Route additions require `config/routes.js` update.** Any new Express route must also appear in the route manifest so `/routes` stays accurate.

**PR4. No restoration of removed features without owner request.** Features removed from the UI (e.g. the Dashboard tab) must not be re-added by an AI agent acting autonomously.
