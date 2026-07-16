# Atlas V1 Execution Plan

> **Status:** CANONICAL EXECUTION AUTHORITY
> **Owner adopted:** 2026-07-15
> **Current active milestone:** M2 — close remaining silent-correctness risks (M1/Soul closed 2026-07-16)
> **Rule:** Atlas has one execution plan. This document selects and sequences work until V1 is declared and the stabilization period ends.

## 1. Purpose

This document replaces the former active-roadmap, Soul, Soul-readiness, Post-Soul, remediation, and historical product-plan queues as execution authority.

Atlas is no longer choosing among overlapping plans. The governed path is:

> **Close Soul → harden trust seams → prove the whole product → complete five clean live sessions → declare V1 → stabilize → simplify the UI from observed use.**

The repository, not a Claude conversation, remembers campaign state. A fresh implementation session reads this file, selects the first eligible unfinished card, verifies current state, and continues from current `main`.

## 2. Authority and document roles

Read in this order for routine work:

1. `CLAUDE.md` — operating, safety, branch, review, and merge rules.
2. `docs/ATLAS_V1_EXECUTION_PLAN.md` — the sole work-selection and sequencing authority.
3. `docs/DECISION_KERNEL.md` — durable product and trust principles.
4. `BACKLOG.md` — intake/deferred ledger and supporting finding detail; **not a competing queue** while this plan has eligible work.
5. Relevant specs, invariants, tests, and evidence ledgers.

The following remain separate because they are not execution plans:

- `docs/ATLAS_PRODUCT_VISION.md` — product north star.
- `docs/CONSTITUTION.md` and `docs/INVARIANTS.md` — non-negotiable rules.
- `docs/ARCHITECTURE.md` — current system boundaries.
- `docs/TEST_QUEUE.md` — owner/live evidence ledger.
- `docs/ONE_BRAIN_PROMOTION_CRITERIA.md` — reusable evidence standard for Brain promotion.
- `docs/BUG_TRIAGE_LEDGER.md` — Bug_Reports done/open record.
- Narrow design/spec/research docs — consulted only when the active card touches their surface.

If another document appears to select or sequence work, this plan wins and the conflicting document must be corrected in the same focused governance PR.

## 3. Execution contract

Claude works this plan as a durable campaign controller.

For every implementation card:

1. Refresh and verify current `main` and deployed version where applicable.
2. Run the Current-State Verification Gate and record exactly one verdict:
   `STILL BROKEN`, `ALREADY FIXED`, `PARTIALLY FIXED`, `FIXED BUT UNTESTED`, `STALE / SUPERSEDED`, or `NEEDS OWNER APP-TEST`.
3. If already fixed, do not manufacture code. Add the missing proof/status only.
4. Create one fresh `claude/<concern>` or `agent/<concern>` branch from current `main`.
5. Implement one concern only, with the smallest safe diff and live-path or closest-integration tests.
6. Run deterministic GitHub hard gates; address Codex advisory findings that are real and in scope.
7. Merge the exact passing head under Claude's standing authority unless a genuine owner-reserved data-safety category is involved.
8. Update this card's status and merged PR/commit as part of the card's PR when practical; otherwise make the smallest immediate status-only follow-up.
9. Refresh `main` and select the next eligible unfinished card.

### Stop conditions

Stop only for:

- a real production write requiring explicit authorization;
- schema, migration, deletion, credentials, or security-sensitive infrastructure;
- a Constitution/Invariant amendment;
- genuine owner-only gym/device evidence;
- the explicit One-Brain promotion decision;
- a truly non-derivable product conflict.

Do **not** stop merely because a PR is merge-ready, a session is getting long, or the next card is in a different milestone. Repository state is the handoff.

## 4. Campaign status

| Milestone | Goal | Status | Exit condition |
|---|---|---|---|
| **M0** | Consolidate execution authority | ✅ COMPLETE in the installation PR | One canonical plan; old plan bodies retired; governance points here |
| **M1** | Close Soul honestly | ✅ COMPLETE (2026-07-16) | LT-010 required Part 1 PASS with profanity OFF; S5 and Soul recorded complete |
| **M2** | Close remaining silent-correctness risks | ▶ ACTIVE | F02–F10 complete and no open P0/P1 silent-trust finding in these seams |
| **M3** | Prove cross-seam behavior automatically | QUEUED | F11 proving packs green in deterministic CI |
| **M4** | Prove Atlas in real use | BLOCKED on M3 | Five consecutive clean live sessions recorded |
| **M5** | Declare and stabilize V1 | BLOCKED on M4 | V1 declaration merged; minimum two-week defect-only period completed |
| **P-A** | One-Brain promotion evidence | PARALLEL / OWNER-RESERVED | Criteria met, human review complete, explicit owner decision recorded |
| **M6** | UI simplification from evidence | FUTURE / BLOCKED on M5 | Separate owner-approved plan based on observed usage, not speculation |

## 5. Current-state summary

At plan installation:

- The core Atlas experience exists: conversation-first logging, preview-before-write, Google Sheets as the permanent record, session state, recommendations, coaching voice, Flight Recorder, and shadow telemetry.
- Soul criteria S1, S2, S3, S4, S6, and S7 are complete.
- The remaining Soul gate is **S5 / LT-010 required Part 1**: production evidence that routine activity stays routine and genuine engine-confirmed new ground earns elevated/max voice, with `ATLAS_COACH_PROFANITY` OFF.
- PR #1007 added bounded server-owned `decision_summary_json` to Flight Recorder for `/api/coach/message`.
- PR #1011 fixed the visible set/block response so signal-carrying engine modes are not collapsed into the generic acknowledgment.
- Therefore M1 begins as an **evidence/closeout task, not another Soul build**, unless the live re-validation proves a remaining defect.
- One-Brain GATE A remains a parallel evidence clock and never promotes automatically.
- Atlas stays Sheets-primary for V1. No Supabase/Postgres migration is part of this campaign.

## 6. Milestone M1 — Close Soul

### F01 — LT-010 production re-validation and Soul closeout

**Status:** ✅ COMPLETE (2026-07-16)

**Objective**

Prove the final required Soul behavior on deployed current `main`, record the evidence, and close Soul without adding more personality work.

**Current-state verification**

1. Confirm `main` contains PR #1007 and PR #1011.
2. Confirm the deployed `/version` matches current `main` or a commit containing both fixes.
3. Confirm `ATLAS_COACH_PROFANITY` is OFF.
4. Inspect `docs/TEST_QUEUE.md` LT-010 before running anything.

**Required evidence — LT-010 Part 1 only**

- **Routine case:** log an ordinary on-target set/block. Visible reply stays brief and matter-of-fact. Flight Recorder records routine/silent-or-neutral mode and routine register.
- **Earned case:** during genuine owner training, log a real engine-confirmed new-ground set. Visible reply reflects the earned mode; Flight Recorder records the corresponding celebrate/elevated-or-max decision and bounded facts.
- **Forgery/control:** a typed claim or client-shaped fake PR does not manufacture new-ground telemetry or elevated voice.
- **Profanity:** remains OFF. The optional profanity experiment is not required and must not be run without a separate explicit owner decision.

**Allowed implementation**

None unless the production evidence fails. If it fails, file the exact mismatch, reproduce through the closest deterministic route test, and fix only that seam.

**Acceptance criteria**

- Required LT-010 Part 1 is marked PASS in `docs/TEST_QUEUE.md` with deployed commit, Flight Recorder session/reference, routine evidence, earned evidence, and owner verdict.
- This plan records F01 complete and M1 complete.
- No optional profanity activation, tone-dial work, drift challenge, Moments work, or new Soul feature is bundled.

**Owner gate**

The genuine new-ground event must come from real owner training. Claude may perform read-only deploy/recorder checks and analyze evidence, but must not fabricate the qualifying workout. **Owner override (2026-07-16):** Dale explicitly authorized a controlled production test for LT-010 — a synthetic recent baseline (written and undone via the trusted path) to clear the layoff condition, followed by the routine/false-PR/real-PR probes — overriding the "genuine owner workout only" restriction for this gate only.

**Completion record**

- PR: this PR (Soul closeout — records LT-010 Part 1 PASS)
- Commit: validated on deployed `cc8f42d` (current `main`; contains #1007 + #1011)
- Evidence: `docs/TEST_QUEUE.md` LT-010 Owner result — routine on-target set→`silent`; forged new-ground→stripped (`silent`); genuine new-ground→`celebrate`/`register.intensity:max`, `profanity_ok:false`; drawn from Flight_Recorder `decision_summary_json`. Synthetic baseline + test sessions written via the trusted path, verified, and fully undone (no leftover rows). The earlier "`celebrate` never fired" observation was confirmed to be the ratified mode-ladder gates (layoff/safety/challenge/scarcity) out-ranking `celebrate`, not a wiring defect. (Raw set values and production sheet ranges omitted per CLAUDE.md data-safety.)

## 7. Milestone M2 — Trust-seam hardening

Run F02 through F10 in order. Each card is one PR unless the Current-State Verification Gate proves the concern already shipped or must be split for safety.

### F02 — Closeout write-proof parity

**Status:** ✅ COMPLETE (2026-07-16)

**Finding:** `WRITE-1`

**Objective**

Make `/api/complete-workout` return and verify the same exact append proof expected from Atlas's trusted write paths instead of discarding Sheets append responses.

**Likely surfaces**

`index.js` complete-workout route, Sheets append helpers, write-proof tests, Effort/Log closeout integration tests.

**Acceptance criteria**

- Every successful closeout write reports exact authoritative appended ranges/counts for each affected tab.
- A success response cannot be emitted when proof is absent or inconsistent.
- Dry-run proof semantics remain unchanged.
- No schema change.

**Required tests**

Red-first route/integration coverage for exact proof, partial append failure, empty/malformed append response, and dry-run non-write behavior.

**Owner gate**

Code/tests are autonomous. Any real production canary write requires explicit authorization.

**Completion record:** PR — this PR · Commit — `/api/complete-workout` now captures the `appendRows` response for both `Log_Cleaned` and `Effort`, reports the authoritative `logAppendedRange`/`effortAppendedRange` + `log_rows_written`/`effort_rows_written` (from `updates.updatedRange`/`updatedRows`, matching `/api/log-workout`), and a fail-closed gate returns an explicit `sheet_write:'unverified'` (never `success`) when a range is missing or a count disagrees with what was sent. Dry-run proof unchanged; no schema change. Red-first route/integration tests in `test/api-smoke.test.js` (exact-proof, inconsistent-proof fail-closed, dry-run no-proof); full suite green (5456).

### F03 — Interrupted-closeout idempotency

**Status:** ✅ COMPLETE (2026-07-16)

**Findings:** `WRITE-2`, `WRITE-3`

**Objective**

A closeout interrupted before the client receives success must be safe to retry: no duplicate write and no 24-hour wedge caused by a stale in-progress reservation.

**Likely surfaces**

Idempotency/reservation services, complete-workout orchestration, restart/retry integration tests.

**Acceptance criteria**

- Replay after a confirmed completed write returns the original result without appending again.
- A stale/incomplete reservation is recoverable through deterministic reconciliation.
- Concurrent retries produce at most one real append.
- Failure states are explicit; no false save claim.

**Required tests**

Interrupted request, process-restart rehydration, concurrent retry, stale reservation, and completed replay.

**Owner gate**

No production write without authorization.

**Completion record:** PR — this PR · Commit — **WRITE-3:** `services/idempotency.js` tags in_progress records rehydrated from disk and `beginWrite` now downgrades a stale (`>5min`) rehydrated reservation to retryable — not only at load — closing the ≤24h post-crash wedge. **WRITE-2:** the closeout route reuses the server-minted `session_id` stamped in the prior idempotency record (new read-only `peekWrite`) instead of re-minting on retry, and the duplicate-session hard-stop now also covers a reused minted id, so the composite-key (Log) + duplicate-session (Effort) dedupes catch the replay (no full-workout double write). Red-first tests: beginWrite downgrade of an early-rehydrated stale reservation, `peekWrite` recovery, and a route-level reused-minted-id retry that refuses (409) and never re-appends. Full suite green (5460). No schema change.

### F04 — Ambiguous Google Sheets append recovery

**Status:** ✅ COMPLETE (2026-07-16)

**Finding:** `WRITE-5`

**Objective**

Prevent a retry after an ambiguous Sheets `values.append` failure (for example a 503 after the remote append may have succeeded) from duplicating rows.

**Likely surfaces**

`services/sheets.js`, idempotent write orchestration, append-response/read-back helpers, unit/integration fixtures.

**Acceptance criteria**

- Ambiguous append outcomes enter reconciliation, not blind retry.
- Reconciliation can prove already-written vs not-written using deterministic identity/proof.
- At-most-once behavior is pinned by tests.
- Normal unambiguous failures remain retryable where safe.

**Required tests**

503-before-write, 503-after-write, timeout/unknown outcome, matching read-back, non-matching read-back.

**Owner gate**

No production fault injection or write canary without authorization.

**Completion record:** PR — this PR · Commit — `sheets.js` `isTransientAppendError` no longer retries an **ambiguous 503** on `values.append` (the append may have committed before the backend failed to respond), matching its existing treatment of 500 / post-send timeout. Only unambiguous **pre-write rejections** (429 rate-limit, 403 quota) are retried in-request. Recovery for an ambiguous 503 defers to the upstream reconciliation: the `write_id` idempotency guard + composite-key (Log) / duplicate-session (Effort) dedupes — hardened for at-most-once by F02/F03 — so the client's retry re-appends only what is genuinely not yet written. Red-first tests pin 503-non-retryable + at-most-once (one attempt) and 429-still-retryable; the prior 503-retryable pin was flipped. No schema change. Full suite green (5462).

_Note: the card's read-back-reconciliation framing is satisfied by the existing route-level composite-key/effort-session dedupe (the deterministic identity that proves already-written vs not-written); the smallest safe fix is to stop the in-request blind retry that bypassed it, rather than duplicate that reconciliation inside `appendRows`._

### Owner-directed insertion (F04A–F04C)

Dale inserted three narrow owner-directed concerns between F04 and F05 (2026-07-16). One focused PR each; existing cards are **not** renumbered; the canonical plan stays the sole queue (no competing plan). Resume F05 after F04C merges.

### F04A — Retire the cold-review compatibility mechanism

**Status:** ✅ COMPLETE (2026-07-16)

**Objective**

Delete the retired cold-review gate now that `cold-review/exact-head` is off `main`'s required checks.

**Acceptance criteria**

- `.github/workflows/cold-review-gate.yml`, `scripts/cold-review-gate.js`, `test/cold-review-gate.test.js`, `docs/COLD_REVIEW_GATE.md` deleted; no code can publish `cold-review/exact-head`.
- No active document tells an agent to post a compatibility marker; all stale references removed/corrected.
- Policy preserved: deterministic CI checks are hard gates; Codex review is advisory; no paid reviewer, reviewer account, marker, or replacement identity gate; the deleted workflow is not replaced by another review-status workflow.
- Full deterministic suite passes.

**Completion record:** PR — this PR · Commit — deleted the 4 files; corrected references in `.github/PULL_REQUEST_TEMPLATE.md`, `docs/OWNER_CHECKIN_RULES.md`, `docs/DOCS_INDEX.md`, `BACKLOG.md`, and rewrote the governance test's cold-review assertions into an anti-revival guard (files absent + no marker language in active docs).

### F04B — Atlas Control Tower / agent operations contract

**Status:** ✅ COMPLETE (2026-07-16)

**Objective**

One canonical, agent-first status contract so any agent (Claude/Codex/ChatGPT/fresh) can answer "check Atlas / where are we / did the write+undo happen / is prod healthy" without Dale supplying spreadsheets, tabs, commands, session IDs, or doc paths.

**Acceptance criteria**

- Public **redacted** `GET /.well-known/atlas-status.json` — no Atlas browser API key required; bounded safe fields only (schema_version, generated_at, overall_status, deployed_commit, app_version, active_milestone/card, llm/sheets_connected, flight_recorder_enabled, latest_test/write/undo verdicts + freshness, synthetic_rows_remaining, owner_action_required/codes, source_freshness/unavailable_sources, status_reason_codes). Never exposes secrets, sheet IDs/ranges, workout/health data, Flight Recorder transcripts, emails, raw GitHub comments, or stack traces. Never fabricates health (missing/stale ⇒ unknown/degraded, never false green). Read-only (no write behavior).
- `npm run atlas:status` and `-- --json` from repo root; combines existing readers (local/main commit, deployed `/version`, plan active card, health endpoints, Flight Recorder + `scripts/flight-review.js`, governed Sheet config, latest trusted test + write/verify/undo, leftover-synthetic detection). Human form short/decisive; JSON form is the authoritative machine schema, same as the endpoint where practical.
- Discoverability wired into CLAUDE.md, AGENTS.md, `docs/AGENT_LIVE_TESTING.md`, `docs/FLIGHT_RECORDER_VALIDATION.md`, `docs/DOCS_INDEX.md`, README quick-start; one canonical `docs/ATLAS_OPERATIONS_CONTRACT.md` (schema/sources/freshness/redaction/fallback — not a work-selection plan).
- Anti-forgetting tests: command exists; CLAUDE.md/AGENTS.md point to it; schema leaks no disallowed/private keys; stale/missing ⇒ not-healthy; human and JSON agree; source failures not swallowed; endpoint never gains write; endpoint needs no browser key; newest-test selection; completed vs merely-attempted write/undo not confused; clean-checkout acceptance proving a fresh agent following AGENTS.md finds the command without being told the Sheet ID / tab names.
- No large dashboard, no Supabase/new DB/duplicate telemetry/second results ledger (a tiny optional Settings "Atlas Health" link only if essentially free).

**Owner gate:** Autonomous — no production write, schema, or credential change.

**Completion record:** PR — this PR · Commit — new `services/atlasStatus.js` (bounded/redacted assembler + pure plan/test parsers, closed-whitelist `ALLOWED_KEYS`, honest overall-status logic), `scripts/atlas-status.js` (`npm run atlas:status [-- --json]`, deployed-fetch with offline local fallback), public read-only `GET /.well-known/atlas-status.json` in `index.js` (+ `config/routes.js` entry), canonical `docs/ATLAS_OPERATIONS_CONTRACT.md`, discoverability wired into CLAUDE.md/AGENTS.md/AGENT_LIVE_TESTING.md/FLIGHT_RECORDER_VALIDATION.md/DOCS_INDEX.md/README, and anti-forgetting + clean-checkout acceptance tests (`test/atlasStatus.test.js` + endpoint case in `test/api-smoke.test.js`). Synthetic-row count is reported `null`+unavailable rather than run as a live authenticated scan on the public endpoint; the existing `POST /api/admin/preview-test-rows` remains the path for a real count. Full suite 5465 pass.

### F04C — Durable owner session (remove repeated key entry)

**Status:** ✅ COMPLETE (2026-07-16, live-validated on shell v137). Three live failures traced to one root cause: **client-side auth-state guessing.** (1) reload/reopen showed "Set your API key" because four modules gated on `getApiKey()` (empty after cookie migration) — patched to `isConnected()`. (2) v134/v135 then showed **split-brain**: Settings said "Atlas connected on this device" while Coach immediately said "Set your API key." The deployed cookie path is correct (login returns `Set-Cookie: atlas_session=…; HttpOnly; SameSite=Lax; Secure` and `/api/session/status` with the cookie returns `authenticated:true`, verified live via curl), but the client kept **two independent truths** — a Settings claim from the login POST and a synchronous `isConnected()` (`sessionActive`/persistent flag/key) that reset on reload. A persistent `atlas_connected` localStorage flag was a client-side *guess* about an HttpOnly cookie and was **rejected by the owner**. This redesign makes the client **server-authoritative**: the `atlas_connected` flag is removed entirely; a single `serverAuthState` (`unknown`/`authenticated`/`unauthenticated`) is written ONLY by real server responses (a protected `api()` 2xx or login → authenticated; a `api()` 401 / a sessions-enabled `/api/session/status` `authenticated:false` / logout → unauthenticated; a timeout/abort/transport failure changes nothing). `isConnected()` is optimistic (false only on a server-confirmed negative), so a cookie-only owner is never pre-blocked on a synchronous flag; protected reads are attempted and the SERVER's 401 (not a client flag) drives "Connect Atlas in Settings"; a network/cold-start failure shows a connection message, never a key prompt; Settings reflects the same `serverAuthState` so it can never disagree with Coach. Shell bumped v136→v137. Red-first browser tests in `tests/e2e/session-auth.spec.js` (cookie-only reload, delayed status, status-timeout-then-success, genuine 401, "Settings and Coach never disagree") fail on the old flag model and pass on the redesign. **Live-validated 2026-07-16 on shell v137:** authentication holds across normal refresh and close/reopen; the earlier apparent failures were from clearing Safari history/website data, which correctly clears the session (expected behavior, not a defect). No further authentication changes.

**Objective**

Replace `atlas_api_key` in `localStorage` + per-call `x-atlas-api-key` with a long-lived server-managed owner session so Dale authenticates once per device and app-shell/service-worker refreshes don't erase it — without exposing workout APIs publicly.

**Acceptance criteria**

- Authenticate once per device via the existing owner credential → server issues a signed **HttpOnly, Secure, SameSite** session cookie (≈90–180 day lifetime, honest rotation/expiry); browser calls authenticate via the cookie; JS cannot read the session secret; raw credential removed from `localStorage` after migration.
- Bounded legacy `x-atlas-api-key` acceptance during migration; a separate machine-auth route preserved for trusted local scripts (agents never scrape Dale's browser cookie); the public redacted Control Tower endpoint stays login-free; all workout reads/writes stay protected.
- Settings shows "Atlas connected" (no permanent raw-key field); logout/reconnect under Advanced.
- Tests: CSRF, origin, expiry, replay, cookie flags, logout, legacy migration, unauthorized-write.
- No secret (OpenAI/owner credential) in Sheets, frontend bundles, repo files, status output, logs, Flight Recorder, or fixtures.

**Owner gate:** A **new server-side session-signing secret** (Render env var) is owner-only. If required, stop and give Dale the exact variable name + steps — never a value. All other code/tests are autonomous.

**Owner activation step (non-blocking):** The code merges safely with **no** behavior change — durable sessions stay OFF until the secret is provisioned, and auth falls back to the `x-atlas-api-key` header until then. To activate, set one Render env var on the Atlas service: **`ATLAS_SESSION_SECRET`** = a fresh 32-byte random hex value (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; never a value in the repo/PR/logs), then redeploy. Rotating it is the global-logout lever. Full runbook: `docs/OWNER_SESSION.md`.

**Completion record:** PR — this PR · Commit — `services/session.js` (HMAC-signed cookie sign/verify, expiry, rotation, CSRF `isAllowedOrigin`, cookie flags; secret read dynamically so absence = disabled); `middleware.js` (auth accepts the key header OR a valid session cookie, CSRF origin check on cookie-auth writes, publicPaths matched against the full URL); `index.js` (`POST /api/session/login|logout`, `GET /api/session/status`, dedicated login rate-limiter, publicPaths) + `config/routes.js`; client migration in `src/app/api.js` (`credentials`, conditional key header, `isConnected`/`sessionLogin`/`sessionLogout`/`refreshSessionStatus`), `src/app/app.js` (connect→login, disconnect→logout, one-time key→cookie migration bootstrap, all connection gates use `isConnected()`), `src/app/flightRecorder.js`, `src/app/index.html` (Connect/Disconnect); `.env.example` + `docs/OWNER_SESSION.md`. Tests: `test/session.test.js` (16 unit — sign/verify/tamper/expiry/wrong-secret/cookie-flags/origin/renew), the F04C integration block in `test/api-smoke.test.js` (login→cookie-auth→CSRF-refused→forged-cookie→legacy-header→unauthenticated→logout→disabled-503), and `test/sessionClientMigration.test.js`. Full suite 5499 pass; E2E unaffected (every spec mocks `/api/session/status` via its `**/api/**` fallback, so no migration fires under test). **Live-validation follow-ups:** PR #1025 (client gates → `isConnected()`), PR #1027/#1028 (durable-flag attempts, superseded), and the final **server-authoritative redesign PR #1029** — removed the `atlas_connected` flag, introduced a single server-written `serverAuthState`, made reads optimistic (401-driven "Connect Atlas", network-message on transport failure), reconciled Settings from the same state, bumped shell v137, and added red-first `tests/e2e/session-auth.spec.js`. Full suite 5519 pass; live-validated on shell v137.

### F05 — Parser full-consumption and `@N` ambiguity guard

**Status:** ✅ COMPLETE (2026-07-16)

**Findings:** `PARSE-4`, `PARSE-5`

**Objective**

Atlas asks instead of silently accepting a partially consumed set expression or guessing whether `@N` means weight or RIR in the ambiguous low-number range.

**Implementation direction**

Use the route-orchestration refusal/clarification pattern established by `services/unresolvedLiftGate.js`. Do not add an over-broad parser-level refusal that rejects Exercise-KB-known lifts, and do not rewrite stable parser goldens unnecessarily.

**Acceptance criteria**

- Set-shaped tokens left unconsumed cause a bounded clarification response; no preview/write is produced.
- Ambiguous `@N` inputs in the unsafe range ask for clarification.
- Unambiguous weight, reps/RIR, and established slash notation remain unchanged.
- `225 5/2` semantics remain fixed.

**Required tests**

Route-level ambiguity fixtures plus regression coverage for valid terse notation, aliases, multiple sets, and no invented rows.

**Owner gate**

Autonomous within the existing parser/trust contract. Any grammar-contract change beyond ambiguity refusal is owner-reserved.

**Completion record:** PR — this PR · Commit — new route-level `services/fullConsumptionGate.js` (`applyFullConsumptionGate(parsed, rawText)`), wired in `index.js` immediately after the unresolved-lift gate on `POST /api/parse-workout-text`. It downgrades a `log_sets` parse to `needs_clarification` when the raw text (a) mixes 2+ distinct set-notation families — slash `\d+/\d+`, `x\d+@`, `\d+ for \d+` — the exact shape where first-sub-parser-wins silently drops a group (PARSE-4), or (b) uses the barbell `NxM@W` form with `W ≤ 10` and the parser actually emitted that tiny weight (PARSE-5). **No parser grammar touched** — `services/workoutTextParser.js` and every parser golden are byte-identical; the `225 5/2` slash contract and repeated-slash / `@>10` / dumbbell-`@RIR` inputs are proven to still parse. Tests: `test/fullConsumptionGate.test.js` (9 unit — both downgrades, @10/@11 boundary, precision guard, no-over-rejection, no-op robustness) + a live-path F05 block in `test/api-smoke.test.js` (real parser+gate via the route: the three PARSE-4 inputs and the PARSE-5 input ask with zero rows and no write; five valid inputs still parse to exact sets). Full suite 5511 pass.

### F06 — Preserve user-edited preview rows

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first E2E; shell v138). Reproduced the CLIENT-2 defect through the real conversational flow: sets log into the `sessionLog` buffer, each closeout rebuilds the editable preview table from that buffer (`buildRowsFromSessionLog`), and logging another set reparses via `rowsFromWorkoutInput` → `populateSetRows`, which wiped the edited table while the buffer still held the original value — so the next closeout silently reverted the correction (edited 230 → parser 225, confirmed red). Fix folds hand-edits back into the buffer BEFORE any rebuild: fields are flagged `data-user-edited` on input, and `reconcileSessionLogFromTable()` maps each table row to its buffer entry by exercise + per-exercise occurrence (the same numbering `buildRowsFromSessionLog` uses) and overwrites only edited fields. The preview→approve→write trust loop is untouched (the write still reads the DOM via `collectLogRows`, and the DOM now rebuilds from the corrected buffer, so Save writes exactly the final preview).

**Finding:** `CLIENT-2`

**Objective**

A user correction made in the preview remains authoritative when another set/message updates the pending workout before Save.

**Likely surfaces**

`src/app/app.js`, preview/pending-write state, row-identity helpers, frontend integration/E2E tests.

**Acceptance criteria**

- Edited row fields survive an incremental reparse/append of additional sets.
- New engine rows are merged without overwriting user-owned edits.
- Conflicting identity is handled explicitly rather than by position-only replacement.
- Save writes exactly what the final preview displays.

**Required tests**

Edit-then-add-set, edit-then-remove, duplicate/similar exercise names, reload-safe state if applicable, final payload equality.

**Owner gate**

No owner gate unless the preview→approve→write authority model must change. Preserve the existing trust loop.

**Completion record:** PR — this PR · Commit — client-only change in `src/app/app.js` (new `reconcileSessionLogFromTable()` folds hand-edits into `sessionLog` before a rebuild — called at the top of `rowsFromWorkoutInput` before the reparse wipe and in `emitSetLogged` before its wipe; `addSetRow` flags fields `data-user-edited` on input; defensive so the eval/source harnesses stay green) and `src/app/coach-conversation.js` (a coach-accepted `update_set` marks the changed fields user-edited too). Shell bumped v137→v138 (SW cache + `ATLAS_SHELL_BUILD` + wiring/unit version pins). Tests: red-first `tests/e2e/preview-edit-preserve.spec.js` drives the real flow (log → done → edit → log → done) and proves the edited weight/reps survive and reach the write (edit 230 vs parser 225 — fails before, passes after), plus a middle-row/duplicate-name identity case. Full node suite 5519 pass; full E2E suite 65 pass; lint 0 errors. The preview→approve→write trust loop and write payload source (`collectLogRows`) are unchanged.

### F07 — Ignore stale dry-run/preview responses

**Status:** QUEUED

**Finding:** `CLIENT-3`

**Objective**

An older slow preview response must never overwrite a newer user request or newer pending write.

**Likely surfaces**

`src/app/app.js`, request/version identity, pending-write reducer/state, E2E race tests.

**Acceptance criteria**

- Every preview request has a monotonic/request identity.
- Only the latest eligible response may update pending preview state.
- Older success or error responses are ignored safely.
- Approval binds to the currently visible preview identity.

**Required tests**

Out-of-order success/success, success/error, error/success, approve-after-race, and cancellation/reload where applicable.

**Owner gate**

Autonomous if approval semantics remain unchanged.

**Completion record:** PR — · Commit —

### F08 — Canonical screenshot session date

**Status:** QUEUED

**Finding:** `CLIENT-4`

**Objective**

A screenshot-imported closeout uses one canonical session date across Log and Effort rather than mixing today's date with the screenshot's date.

**Likely surfaces**

Screenshot parse/preview state, complete-workout payload construction, date validation, closeout integration tests.

**Acceptance criteria**

- One reviewed canonical session date is shown before approval.
- Log and Effort rows use that same date.
- Calendar-invalid or ambiguous dates ask for correction.
- Ordinary same-day manual logging is unchanged.

**Required tests**

Prior-day screenshot, month/year boundary, timezone edge, invalid date, manual non-screenshot closeout.

**Owner gate**

Autonomous within existing date semantics; no historical rewrite.

**Completion record:** PR — · Commit —

### F09 — Current-state coach narration

**Status:** QUEUED

**Findings:** `SESS-1`, `SESS-3`

**Objective**

Coach narration always describes the current store-owned session after plan edits/reopen, and closeout narration can fire correctly after a session is reopened.

**Likely surfaces**

`src/app/coach-conversation.js`, store selectors, closeout announcement state, session-reopen tests.

**Acceptance criteria**

- Announced next/remaining work is derived from the canonical current store, not stale local reconstruction.
- Reopening or mutating a completed plan resets the closeout-announced guard appropriately.
- Coach text, pin, recap, and visible plan agree after reorder/skip/substitute/add/reopen.

**Required tests**

Plan mutation followed by narration, closeout→reopen→closeout, reload/resume, and no duplicate announcement without a state change.

**Owner gate**

Autonomous because the behavior is derivable from current-state truth.

**Completion record:** PR — · Commit —

### F10 — Authoritative planned-slot completion identity

**Status:** QUEUED

**Findings:** PR-24 slice-3 divergence, `SESS-4`, `SESS-5`, Workout Sheet duplicate-name identity

**Binding owner decision**

A recognized substituted exercise or variant satisfies the original planned slot everywhere: recap, next-up, pin, handoff, closeout, and Workout Sheet. Do not re-ask this product decision.

**Objective**

Create one canonical, ambiguity-safe planned-slot completion selector and route every consuming surface through it.

**Likely surfaces**

Canonical session selectors/store, completion identity resolution, substitution outcome folding, recap/remaining helpers, `src/app/workoutSheet.js`, closeout/handoff tests.

**Acceptance criteria**

- One logged substituted/recognized variant completes exactly the intended original `plan_item_id`.
- Duplicate exercise names remain slot-distinct; one log cannot complete every same-named slot.
- Exact identity outranks substring; ambiguous substring matches refuse/leave unresolved rather than guessing.
- Recap, next-up, pin, handoff, closeout, and Workout Sheet return the same status from the same selector.
- Existing Session_Plans `plan_item_id` semantics remain authoritative.

**Required tests**

Substituted variant, alias, duplicate planned names, substring collision, out-of-order completion, skip then log, reload/fold, and cross-surface parity.

**Owner gate**

The semantics are already owner-approved. Implementation is autonomous unless it requires a schema migration, which is not expected and must not be introduced casually.

**Completion record:** PR — · Commit —

## 8. Milestone M3 — Cross-seam proving packs

### F11 — Deterministic V1 proving packs

**Status:** QUEUED

**Objective**

Prove the repaired seams together using the existing simulation, Flight Recorder replay, and Playwright infrastructure. Do not create a fourth test framework.

**Required packs**

- **SIM-DALE:** normal owner-like three-day training language, substitutions, edits, closeout, and proof.
- **TERSE:** compact gym notation and fragmented updates.
- **RAMBLER:** long dictation, corrections, multiple intents, and late clarification.
- **CHAOS extension:** every repaired F02–F10 historical failure replayed across its nearest real seam.

**Acceptance criteria**

- Tier-1 deterministic packs run in normal CI and are blocking.
- LLM wording scans remain advisory/report-only; no nondeterministic model judge becomes a hard gate.
- Every F02–F10 fix has at least one cross-seam fixture in addition to its focused regression.
- Failures identify the exact stage and preserve replay artifacts without secrets or production data.

**Likely surfaces**

`scripts/sim/`, `test/fixtures/replays/`, Playwright suites, CI workflow/config only as necessary.

**Owner gate**

None for synthetic/dry-run packs. Real production writes remain prohibited without authorization.

**Completion record:** PR — · Commit —

## 9. Milestone M4 — Five-session V1 proving run

Begins only after F11 is deployed. Feature development pauses. The run uses five owner-live cards created in `docs/TEST_QUEUE.md` when the run starts.

### Clean-session definition

A clean session has:

- no fabricated, dropped, or misinterpreted set;
- correct lift identity, weight, reps, RIR, units, and date;
- no false save claim, duplicate write, or missing exact proof;
- no stale preview or stale coach narration;
- correct remaining/completed session state;
- factual, calibrated naturally occurring coach reactions;
- no white screen or broken transition;
- owner review within 24 hours.

A material defect resets the consecutive-clean count to zero. Evidence → replay → fix → deploy → restart. Three resets trigger a focused root-cause review before another attempt.

### Session A — Normal workout + write proof

Planned workout; edit at least one preview row; add more work; save; verify exact ranges/counts and bound Undo identity.

### Session B — Screenshot closeout

Import a screenshot with a real session date; verify Log and Effort date equality; save; verify proof; exercise safe Undo/resave if desired.

### Session C — Substitution + plan mutation

Substitute one exercise, reorder or skip another, add an off-plan exercise; verify recap/next-up/pin/handoff/closeout/Workout Sheet agree.

### Session D — Interrupted + resumed

Reload/resume; exercise retry-safe closeout state; intentionally race dry-run/preview responses; verify an older response cannot overwrite the latest.

### Session E — Ambiguous + natural language

Use terse notation, long dictation, and one intentionally ambiguous set format; Atlas must ask instead of guess, then complete normally.

### Evidence per session

Date/session ID · app version/deployed commit · scenario coverage · Flight Recorder reference · writes and exact proof ranges · observed coach behavior · defects · owner verdict · current clean count.

## 10. Milestone M5 — V1 declaration and stabilization

### F12 — Declare Atlas V1

**Status:** BLOCKED on five clean sessions

**Acceptance criteria**

- F01–F11 complete.
- No open P0/P1 finding can silently damage logging, preview approval, session truth, or write verification.
- Full automated suite and proving packs green.
- Five consecutive clean sessions recorded.
- Release record captures deployed commit, evidence links, known non-blocking limitations, rollback point, and the owner declaration.

**Completion record:** PR — · Commit —

### Two-week defect-only stabilization

For at least two weeks after F12:

- use Atlas normally;
- fix only demonstrated defects with a reproduction;
- no new capability roadmap;
- no database/storage migration;
- no frontend-framework rewrite;
- no public/multi-user expansion;
- no voice re-ratification from one awkward sentence;
- no speculative cleanup PRs.

Exit review:

- Did Atlas remain trustworthy?
- Which surfaces were actually used or ignored?
- What defects recurred?
- Is the next work UI simplification, deeper personal coaching, or a separately authorized public-product phase?

## 11. Parallel lane P-A — One-Brain promotion

This lane accumulates evidence while M1–M5 proceed. It does not block Soul closeout, trust hardening, proving packs, or the V1 proving run unless a specific card explicitly depends on promotion.

The authoritative evidence standard remains `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`.

Required before any promotion:

- varied genuine athlete activity across multiple sessions/days/lifts;
- production scorecard;
- zero unsafe recommendations and zero unresolved orchestrator errors;
- human safety/quality review of representative and divergent cases;
- explicit owner decision per decision type.

Crossing a numerical threshold never flips a flag automatically. Promotion, burn-in, and eventual legacy-lane deletion remain separate owner-governed work.

## 12. Explicitly outside this campaign

Do not add these while this plan is active unless Dale explicitly changes direction:

- Supabase/Postgres/SQLite or any second permanent store;
- multi-user/public-product architecture;
- nutrition tracking;
- broad wearable-vendor expansion;
- native mobile app;
- frontend-framework rewrite;
- another agent/orchestrator platform;
- new coaching-intelligence roadmap;
- profanity activation;
- speculative UI redesign;
- broad cleanup unrelated to a demonstrated trust/product problem.

## 13. UI work after stabilization

The current UI is allowed to be imperfect during finishing. After M5, run a separate evidence-based simplification review using actual owner behavior:

- what Dale uses every session;
- what he never opens;
- where the workout flow creates friction;
- which controls belong in conversation, the Workout Sheet, or the drawer;
- what can be removed rather than redesigned.

No UI plan is pre-written here. The point is to finish and observe before decorating.

## 14. Fresh-session launcher

A new Claude Code session can begin with:

> Read `CLAUDE.md` and `docs/ATLAS_V1_EXECUTION_PLAN.md`. Execute the first eligible unfinished card. Run the Current-State Verification Gate before editing, use one concern per PR, merge the exact passing head under standing authority, update the card's completion record, refresh `main`, and continue. Stop only for an explicit owner-reserved gate.

Before implementation, report only:

1. active milestone;
2. next eligible card;
3. current-state verdict;
4. whether code is actually required;
5. any genuine owner gate.

## 15. Plan maintenance

- This file is updated only for real campaign state, a proven stale premise, or a necessary split of one card into safer one-concern PRs.
- Do not add a second roadmap, phase plan, campaign controller, fix-it document, or session-specific master prompt.
- Narrow specs may be added when a card genuinely requires design, but the card remains the sequencing authority.
- New discoveries go to `BACKLOG.md`; they enter this plan only through an explicit owner-approved campaign change.
- Git history is the archive. Completed-plan prose does not need to remain in the live documentation tree.

> **Finish. Prove. Declare. Then make it pretty.**
