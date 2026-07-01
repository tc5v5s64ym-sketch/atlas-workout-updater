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

**PR1. Tiny PRs only.** Each PR changes one thing — a backend endpoint, a UI component, a test suite, a doc file, or an infrastructure change (CI/workflows, templates, labels, scripts, repo config) — not all of them together.

**PR2. Docs PRs touch only `docs/` and root markdown files.** No production code, no tests, no config changes in a *documentation* PR. This defines what a docs PR is; it is not a blanket ban on config changes. An **infrastructure** PR (CI/workflows, templates, labels, scripts, automation, repo config — no production application behavior change, per [`docs/RISK_LABELS.md`](./RISK_LABELS.md)) is a distinct category from both docs PRs and app-code PRs: it may change those config surfaces and carries no `docs/`-only restriction, while still obeying PR1 (one concern per PR).

**PR3. Route additions require `config/routes.js` update.** Any new Express route must also appear in the route manifest so `/routes` stays accurate.

**PR4. No restoration of removed features without owner request.** Features removed from the UI (e.g. the Dashboard tab) must not be re-added by an AI agent acting autonomously.

---

## 6. LLM / Provider Invariants

> **Status note:** L1 and L5 are binding today — the deterministic paths are verified LLM-free. L2, L3, and L4 are **build targets**: they describe the required end-state that the 8-PR implementation sequence in [`docs/LLM_ARCHITECTURE.md`](./LLM_ARCHITECTURE.md) will establish. They become binding as each corresponding PR lands (error boundary → L2/L3; provider interface → L4). Until then, the existing `services/vision.js` and `services/coach.js` code is the known baseline — reviewers should not flag those files for L2–L4 violations until the relevant implementation PR has shipped.

**L1. Deterministic core is LLM-free.** *(binding now)* Parsing, logging, preview, save, undo, exercise identity, substitution classification, plate math, next-up calculation, and session mutation must never call an LLM provider. If behavior can be made deterministic, it must be. A review finding or test that detects an LLM call on any of these paths is a blocking finding — do not merge.

**L2. Provider failure must not reach the workout flow.** *(build target — binding after error boundary PR lands)* If any provider call fails (any error class: 429, 5xx, timeout, auth, malformed response), the deterministic core continues to completion. Workout state — session log, preview rows, save, session mutation — is never blocked or corrupted by a provider outage. The coach voice degrades to silence or a friendly message; the workout never does.

**L3. No raw provider output in any client response.** *(build target — binding after error boundary PR lands)* Every LLM provider call is wrapped in an error boundary that catches all exceptions and maps them to a fixed user-facing message. Raw provider error bodies, status codes, response metadata, and exception payloads are logged server-side only — never returned to the client.

**L4. Provider-specific code lives behind a provider interface.** *(build target — binding after provider interface PR lands)* Vendor SDK calls, auth, error classification, and retry behavior for each provider are isolated in that provider's adapter module. Application code (`services/coach.js`, `services/vision.js`) calls the interface, not the SDK directly. See [`docs/LLM_ARCHITECTURE.md`](./LLM_ARCHITECTURE.md) for the interface spec and implementation PR sequence.

**L5. Structured LLM output is validated before use.** *(binding now)* When a provider returns structured output (JSON for a composer command, a parsed intent), the response is validated server-side against the expected schema before it reaches application logic. A validation failure falls back to the deterministic intent-matching path — it never corrupts workout state or reaches the write path.

---

## 7. Product / Interface Invariants

> **Status note:** I1 is a **forward filter** — binding now on *new* work, so no future PR adds a competing surface. It does **not** assert the existing UI is already consolidated: today's surfaces (the parallel Progress dashboard, duplicated recommendation, etc.) are being reframed toward the conversation per the owner-reserved conversation-first direction (`docs/CONVERSATION_FIRST_DESIGN_REVIEW.md`), one tiny PR at a time. Removing or demoting an *existing* surface is still owner-gated (coach-surface / product-scope, and PR4). I1 stops new drift immediately; it does not authorize deletions.

**I1. The conversation is the product.** *(forward filter — binding on new work now)* Every capability and screen exists to **support** the conversation, not compete with it. A new UI surface is legitimate only as something the coach shows, or an intent the user expresses, inside the conversation — never as a separate destination the user must navigate to instead of talking to Atlas. The filter for any new surface is *"does this make the coach more helpful / would a coach do this naturally?"*, not *"what screen should we add?"*. **This does not mean chatbot-only:** capabilities (log, plan, review, analytics) remain first-class, and a one-tap shortcut that emits an intent (e.g. "log this set") *is* the conversation — the button is a sentence. What is disallowed is adding a rival navigation surface that pulls the user *out* of the conversation. Behavioral detail lives in [`docs/CONVERSATION_CONTRACT_V1.md`](./CONVERSATION_CONTRACT_V1.md); this invariant is the one-line guardrail. Adopting the full conversation-first consolidation (and any change to this invariant's binding scope) is owner-reserved.
