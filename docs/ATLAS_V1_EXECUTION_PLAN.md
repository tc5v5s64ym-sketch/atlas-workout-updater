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
| **M2** | Close remaining silent-correctness risks | ▶ ACTIVE | F02–F10 **plus the owner-directed 2026-07-16 stabilization insertion (F09A–F09J, F10A–F10E)** complete, and no open P0/P1 silent-trust finding in these seams |
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

**Completion record:** PR — this PR · Commit — client-only change in `src/app/app.js` (new `reconcileSessionLogFromTable()` folds hand-edits into `sessionLog` before a rebuild — called at the top of `rowsFromWorkoutInput` before the reparse wipe and in `emitSetLogged` before its wipe; `addSetRow` flags fields `data-user-edited` on input; defensive so the eval/source harnesses stay green) and `src/app/coach-conversation.js` (a coach-accepted `update_set` marks the changed fields user-edited too). Shell bumped v137→v138 (SW cache + `ATLAS_SHELL_BUILD` + wiring/unit version pins). Tests: red-first `tests/e2e/preview-edit-preserve.spec.js` drives the real flow (log → done → edit → log → done) and proves the edited weight/reps survive and reach the write (edit 230 vs parser 225 — fails before, passes after), plus a middle-row/duplicate-name identity case. Full node suite 5519 pass; full E2E suite 65 pass; lint 0 errors. The preview→approve→write trust loop and write payload source (`collectLogRows`) are unchanged. **Follow-up (this PR, shell v138→v139):** a Codex review on the merged PR #1031 flagged that reconciliation keyed the buffer lookup on the row's CURRENT `.set-exercise` value, so renaming the exercise dropped the row's entire edit (name + numbers) — the unknown-lift "check the name" flow. Fixed: `addSetRow` stamps the row's original name (`data-origin-exercise`) and marks `.set-exercise` edits too; `reconcileSessionLogFromTable` matches on the stamped original name and preserves the exercise field. Red-first exercise-rename E2E case added (fails before, passes after).

### F07 — Ignore stale dry-run/preview responses

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first E2E; shell v140). The preview path set `pendingWrite` unconditionally after each dry-run `await` (and `populateSetRows` after each parse) with no request identity, so a slow OLDER response could overwrite a NEWER request's preview/pending write and Approve would write the stale rows. Fix adds a monotonic `previewRequestSeq` bumped at each submit start (`submitSeq`); the parse (`rowsFromWorkoutInput`) and every dry-run branch (manual / effort-only / screenshot) drop their response when their captured seq no longer matches the latest. Approval already binds to `pendingWrite`, which now stays the latest — approval semantics unchanged (autonomous per the owner gate).

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

**Completion record:** PR — this PR · Commit — client-only change in `src/app/app.js`: new module-level `previewRequestSeq`; the logger-form submit handler captures `submitSeq = ++previewRequestSeq` at start; guards `if (submitSeq !== previewRequestSeq) return;` sit at the top of the dry-run try and before each `pendingWrite` assignment (manual / effort-only / screenshot), and `rowsFromWorkoutInput` captures `parseSeq` and drops a superseded parse before it can overwrite the table. Shell bumped v139→v140 (SW cache + `ATLAS_SHELL_BUILD` + wiring/unit version pins; the `rowsFromWorkoutInput` source-slice window widened to 3000 for the grown function). Red-first `tests/e2e/preview-stale-response.spec.js`: two closeout dry-runs overlap and resolve out of order (newer first, stale older last); each submit mints its own `write_id`, and the test asserts the live write carries the NEWER preview's `write_id` — fails before the guard (the stale response wins), passes after. Full node suite 5519 pass; E2E green (the lone `undo-stale-card.spec.js:162` failure is a pre-existing timing flake on the undo path, unrelated to this change and covered by CI retries); lint 0 errors. Approval semantics and the write payload source (`pendingWrite`) are unchanged.

### F08 — Canonical screenshot session date

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first api-smoke integration tests on the real `/api/complete-workout` route). On the closeout path the Effort row always used the resolved canonical `dateValue`, but the Log rows honoured a client per-row `date_clean` first (`normalizeLogRowObject` precedence), so a prior-day screenshot (or a backdated manual entry) dated the Effort row on the screenshot date while the Log rows kept today's auto-fill. Fix: a pure `withCanonicalSessionDate(row, dateValue)` stamps the resolved session date onto every Log row before enrichment at the complete-workout call site — applied to the dry-run preview AND the live write, so the preview shows exactly what Approve writes. Only the rows being written now are stamped (no historical rewrite); date resolution/validation, the screenshot plausibility guard (out-of-window → today-fallback + `screenshot_date_rejected` asks for correction), the effort builder, the dedup keys, and the preview→approve→write trust loop are all unchanged. Server-only (`index.js` + tests; no `src/app` change → no SW/shell bump).

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

**Completion record:** PR — this PR · Commit — server-only change in `index.js`: new pure `withCanonicalSessionDate(row, sessionDate)` (handles the client object shape and the Log_Cleaned array shape, date at index 0), applied at the `/api/complete-workout` enrich call so `parsedLogRows` are stamped with the resolved `dateValue` before `enrichAndFormatLogRows`. The Effort row already used `dateValue`; both now share one canonical date on preview and write. Tests: red-first `test/api-smoke.test.js` F08 block (7 real-route cases — prior-day screenshot, month boundary, prior-year Dec 31, timezone-edge local-today fallback, invalid/implausible screenshot rejected→today-fallback asks-for-correction, same-day + backdated manual closeout, and a LIVE-write case asserting the appended Log_Cleaned + Effort rows carry the same date); the 4 divergence cases fail before the fix (Effort = screenshot date, Log = today) and pass after. Full node suite 5526 pass; lint 0 errors. `BACKLOG.md` CLIENT-4 marked fixed. No shell/SW bump (no client asset changed).

### F09 — Current-state coach narration

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first Playwright E2E on the real coach listeners; shell v140→v141). **SESS-1:** `handleSetLogged` (`src/app/coach-conversation.js`) announced next-up/closeout from the emit-time `detail` snapshot, computed before up to two ~9s coach-LLM awaits — so a concurrent set-logged handler could leave it announcing an already-logged "next up" or a superseded closeout. Fix: re-derive next-up, plan order, completed set, and plan-completeness from the LIVE bridged selectors (`remainingPlannedExercises`/`plannedExerciseOrder`/`getSessionCompleted`) right before the announce block, with the snapshot as a typeof-guarded fallback (source/eval harnesses). **SESS-3:** the one-shot `closeoutAnnounced` guard reset only on `atlas:session-reset`, so adding exercises after a plan closed out (reopen) suppressed the second session-close prompt for the rest of the session. Fix: the `atlas:plan-mutated` listener re-arms `closeoutAnnounced` + `lastAnnouncedNextUp` when a closed-out plan has live remaining work again. Client-only (coach render layer); the write path, proof fields, and preview→approve→write trust loop are untouched.

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

**Completion record:** PR — this PR · Commit — client-only change in `src/app/coach-conversation.js`: `handleSetLogged` re-derives `currentNextPlanned`/`currentPlannedOrder`/`currentCompleted`/`currentPlanIsComplete` from the live bridged selectors before the handoff/closeout (snapshot fallback via `typeof`), and the `atlas:plan-mutated` listener re-arms `closeoutAnnounced`/`lastAnnouncedNextUp` when a closed-out plan is reopened. Shell v140→v141 (`ATLAS_SHELL_BUILD` + `sw.js` `CACHE_NAME` + 6 version pins). Tests: red-first `tests/e2e/coach-current-state.spec.js` (SESS-3 closeout→reopen→closeout renders two closeouts; SESS-1 a stale out-of-order set-logged snapshot never re-announces an already-logged next-up) — both fail before the fix, pass after; updated the source-introspection lock-in tests (`celebrationLockIn`, `freestyleNextUp`, `sessionPlanExecutor`, `unit.test.js` handoff/closeout/P0-2a) to the live-re-derive shape + a new SESS-3 guard-reset assertion. Full node suite 5527 pass; full E2E 70 pass; lint 0 errors. `BACKLOG.md` SESS-1/SESS-3 marked fixed.

### Owner-directed insertion — live-session stabilization (F09A–F09J, then F10, then F10A–F10E)

**Authority:** Explicit owner-approved change to the canonical campaign sequence (Dale, 2026-07-17). Dale paused normal V1 progression at the clean boundary after F09 to repair defects demonstrated during the 2026-07-16 owner gym session. This is **not** a second roadmap, fix-it document, or competing plan — it is inserted into this canonical plan. Completed cards F01–F09 are **not** renumbered or erased; existing F10 and F11 keep their numbers. **Execution order:** F09A → F09B → … → F09J → **existing F10** → F10A → F10B → … → F10E → F11.

**Goal:** not to polish Atlas — to make the normal workout loop trustworthy end to end:

> executable plan → conversational execution and pivots → accurate confirmation → approved write → truthful planned-versus-actual history → replayable test evidence.

**Evidence base:** the 2026-07-16 owner live session (real upper-body workout through the production app; shell v141; backend changed mid-session from `029d508…` to `cefc34c…` — a split-build caveat, do not attribute every observation to one build). Bounded evidence recorded in `docs/TEST_QUEUE.md` **LT-012** (owner verdict FAIL overall; trust-boundary PASS because the owner rejected the final preview so no bad workout row entered permanent history). Do **not** copy private production workout details, Sheet IDs, ranges, screenshots, credentials, or raw transcripts into commits or PRs — use synthetic equivalents in automated tests.

**Product decision — living coach-plan ledger (owner-approved):** Atlas maintains **two separate truths**: (1) Atlas's **evolving recommendation ledger** — what Atlas independently recommended at each point; and (2) **actual execution** — what the athlete performed. **Never copy actual performance backward and label it Atlas's plan.** Semantics:

- A user-selected load does not automatically become "Atlas's plan." It becomes the plan only when Atlas explicitly recommends or endorses it.
- On a pivot, Atlas computes what it *would* recommend for the new exercise using history and pre-work session context; that recommendation becomes the active plan for the pivot. Performed sets remain actuals whether or not they match.
- If Atlas revises its recommendation after seeing a set, the revision applies **only to future sets** — it must not retroactively change the target for a completed set.
- When the athlete begins an exercise without requesting a target, Atlas derives the recommendation from pre-exercise information, **excluding the new result it is about to evaluate**.
- When evidence is insufficient, record **no reliable target available**; do not invent or copy the result.
- Replaced/skipped exercises are plan changes, not automatically failures.
- Original and revised plans both remain in history; assessment uses the recommendation effective when each set occurred.
- No mid-session production Sheet writes are required — maintain the evolving ledger in trusted pending-session state and include it in the final reviewed closeout, which the owner approves once.

A production Sheet schema change still follows the explicit schema safety gate (owner-reserved). Per-card rules: refresh `main`; run the Current-State Verification Gate and record one verdict; write the failing test/replay first; one fresh branch and one PR per concern; smallest safe fix; focused live-path + full deterministic + applicable Playwright/E2E + lint + secret-scan + wiring/trust checks; address real in-scope Codex findings (advisory; deterministic CI is the hard gate); merge the exact passing head; update the card and supporting evidence; refresh `main` and continue. If a card proves to contain multiple independent root causes, split it into smaller lettered cards.

### F09A — Install the stabilization campaign and record the owner test

**Status:** ✅ COMPLETE (2026-07-17) — docs-only.

**Objective**

Install this owner-directed insertion into this canonical plan (no second document), record the 2026-07-16 owner live session as the next owner live-test entry in `docs/TEST_QUEUE.md`, and file narrow `BACKLOG.md` findings for the observed defects without turning the backlog into a competing queue.

**Acceptance criteria**

- This insertion added to `docs/ATLAS_V1_EXECUTION_PLAN.md` before F11; F01–F09 not renumbered/erased; existing F10 executed at the stated point; F10A–F10E follow.
- `docs/TEST_QUEUE.md` LT-012 records: shell/app version (v141), split-build caveat (`029d508…`→`cefc34c…`), tested workflow, trust-boundary PASS (rejected preview ⇒ no permanent bad write), the bounded findings, and the required retest after fixes. Owner verdict: **FAIL overall.**
- Narrow BACKLOG findings added/updated for the new observations (F09B–F09J tags), not a competing queue.
- No other campaign document created.

**Completion record:** PR — this PR · Commit — inserted F09A–F09J + F10A–F10E into this plan (F10 unchanged at its stated point), added `docs/TEST_QUEUE.md` LT-012 (bounded, no private data), filed narrow BACKLOG findings `FR-REPLAY-1`, `REVIEW-LIVE-1`, `AUTH-DURABLE-1`, `PLAN-EXEC-1`, `PLAN-COACH-SPLIT-1`, `CONVO-LOG-1`, `PR-CLAIM-1`, `SIDECAR-DATE-1`, `UNDER-TARGET-1`, `PLAN-LEDGER-1`. Docs-only; no code, test, or schema change.

### F09B — Restore full Flight Recorder replay

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `FR-REPLAY-1`

**Objective**

Reproduce why production v141 recorded only server `api_response` rows and restore the useful **client** replay so a reviewer can see what the athlete typed, what Atlas showed, and what pending state existed at each step.

**Required behavior**

- One stable `flight_session_id` per app observation session; monotonic `seq` ordering; device linkage where available.
- Client `user_input` and `user_action` events; visible card/tile/confirmation snapshots; coach-message snapshots; pending-session and active-plan state snapshots; linked server API responses.
- Pagehide/background flush that does not lose the final closeout sequence.
- Existing redaction, truncation, feature flag, best-effort behavior, and trust-path isolation intact. Recorder failure never blocks workout logging or saving; it never touches preview→approve→write, `test_mode`, proof fields, or the parser.

**Required tests**

Red-first browser test drives an owner-like flow — session-plan card; several conversational logs; a coaching response; a correction/pivot; Done; final confirmation card; reject or approve — and proves the replay captures the athlete input, what Atlas showed, and the pending state at each step. Do not redesign the UI or modify preview/write semantics.

**Owner gate:** Autonomous (telemetry only; default-OFF flag; no write/schema/trust-loop change).

**Resolution:** **Root cause (single):** `src/app/flightRecorder.js` `initBrowser()` gated activation on the raw `localStorage['atlas_api_key']`, which the **F04C cookie migration removes** — so for a cookie-authenticated owner (the production v141 state) the client recorder was fully INERT: it captured no `user_input`/`user_action`/card/coach/session-state events and, because `requestHeaders()` returns `{}` while inactive, the server's `api_response` rows had no `flight_session_id`/`seq`/`device` linkage. **Fix (smallest):** authenticate the enabled-check + flush via the same-origin session cookie (the legacy key header still rides along pre-migration); the server's auth on `/api/flight/recent` is the real gate (unauthenticated → 401 → inert; default-OFF flag unchanged). Also enriched `snapshotSessionState()` to capture a bounded view of the pending session (active-plan order/remaining/completed + captured-not-saved log) from the client store, so the replay shows *what pending state existed at each step*. Client-only (`src/app/flightRecorder.js`); shell v142→v143. Trust loop / `test_mode` / proof fields / parser untouched.

**Completion record:** PR — this PR · Commit — `src/app/flightRecorder.js` (cookie-auth activation + bounded pending-session snapshot); shell bump v142→v143 (`sw.js` `CACHE_NAME`, `app.js` `ATLAS_SHELL_BUILD`, 6 wiring-test pins). Red-first browser proof `tests/e2e/flight-recorder-replay.spec.js` (cookie-only owner + flag ON → client replay captured with real session linkage; flag OFF → inert) — RED before the fix (recorder never activates → no ingest, no linkage header), GREEN after; deterministic guards in `test/flightRecorderClient.test.js` (no raw-key gate; pending-state snapshot fields; keepalive byte-budget trim). **Codex P2 addressed:** the unload keepalive flush now bounds the batch to the newest events under a ~55KB budget (the closeout is newest, so trimming the oldest preserves it) and caps per-event `pending_sets` at 20 (true count kept as `pending_set_count`), so an oversized tail batch can't be silently dropped by the browser and lose the closeout this fix preserves. Also fixed `playwright.config.js` to apply the pre-installed-browser `executablePath` via `launchOptions` (the top-level `use.executablePath` was silently ignored on @playwright/test 1.60, so every e2e spec failed at launch in the remote container; CI never sets `PLAYWRIGHT_BROWSERS_PATH` so it's a no-op there). Full node suite 5527 pass; full E2E 150 pass; lint 0 errors. `docs/FLIGHT_RECORDER_SPEC.md` + `BACKLOG.md` `FR-REPLAY-1` updated.

### F09C — One-command latest live-test review

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `REVIEW-LIVE-1`

**Objective**

Create the missing agent workflow for "Review my latest live app test." One obvious canonical command (name per existing conventions, e.g. `npm run atlas:review-live`).

**Required behavior**

- Uses local `.env`, known Sheet configuration, and `config/sheetContract.js`; never asks Dale for Sheet IDs, tab names, session IDs, or row ranges already available.
- Automatically identifies the newest genuine owner/app session; prefers `flight_session_id`; bounded timestamp/build/device fallback when older evidence lacks linkage.
- Joins the relevant Flight Recorder, Intent Shadow, Brain Shadow, Session Plans, Log, and Effort evidence; detects a deployment/build change during a session.
- Reconstructs user inputs, actions, visible cards, coach replies, plan state, API errors, preview, approval/rejection, and verified writes.
- Outputs PASS / FAIL / UNKNOWN per trust criterion; clearly distinguishes **missing evidence** from **passing behavior**; never reports a false green.
- Redacts secrets; does not commit generated private reports; read-only; no new database or dashboard.

**Docs:** update `docs/AGENT_LIVE_TESTING.md`, `CLAUDE.md`, and the operations documentation so a fresh agent knows `atlas:status` answers general health/campaign status and `atlas:review-live` reviews the newest real app session.

**Required tests:** deterministic fixture tests, including the v141-shaped failure where only server rows exist.

**Owner gate:** Autonomous (read-only; no write/schema/credential change).

**Resolution:** New `npm run atlas:review-live` (`scripts/atlas-review-live.js`) builds on `scripts/flight-review.js` (session grouping, correlation, anomaly detection — reused, not duplicated) and adds: newest-session selection that compares LINKED sessions and UNLINKED (server-only) clusters on the **same time axis** — so the newest broken v141-shape session (only unlinked server rows) is reviewed even when older linked sessions sit in the same cumulative tab, never silently skipped in favor of an old green (Codex P1); Session_Plans + Effort joins; build-change detection; and a **PASS/FAIL/UNKNOWN per-trust-criterion** verdict where UNKNOWN = missing evidence (never a false green). Read-only (`spreadsheets.readonly`); reads local `.env` + `config/sheetContract.js`; supports `--json`, `--session=<id>`, `--from-dir=<backup>` (offline); prints to stdout only (no committed private report).

**Completion record:** PR — this PR · Commit — `scripts/atlas-review-live.js` (pure `reviewCorpora` core + IO shell), `npm run atlas:review-live` in `package.json`, deterministic fixtures `test/atlasReviewLive.test.js` (healthy → all PASS; **v141-shaped only-server-rows → client_replay/session_linkage FAIL, overall FAIL**; coaching-notes 503 → FAIL; rejected preview → write_verified UNKNOWN not FAIL; missing/target-less Session_Plans → plan_captured UNKNOWN; newest-session + `--session` selection; build-change detection; TOTAL empty corpora; no raw-content leak). Discoverability wired into `docs/AGENT_LIVE_TESTING.md`, `CLAUDE.md`, `docs/ATLAS_OPERATIONS_CONTRACT.md` (`atlas:status` = general health; `atlas:review-live` = newest app session). `BACKLOG.md` `REVIEW-LIVE-1` marked fixed. Full node suite green; lint 0 errors.

### F09D — Durable owner-session verification

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `AUTH-DURABLE-1` (treated as **unverified** — F04C previously passed live on v137)

**Objective**

Determine whether the repeated-credential-entry observation was a real persistence regression or expected loss of site data, before changing any auth.

**Required behavior**

Test normal owner-device behavior **without** clearing browser history or website data: authenticate; refresh; close and reopen; receive a service-worker/shell update; encounter a temporary session-status timeout; return later within the configured cookie lifetime. Expected: no repeated API-key entry; Settings and Coach never disagree; a transport failure never becomes a key prompt; only a **server-confirmed** unauthenticated response asks to reconnect.

- If current behavior passes, **close this card proof-only** with no production-code change.
- If it fails, make the smallest F04C follow-up. Do **not** restore raw keys to `localStorage`, add a second client truth, add a new authentication system, weaken protected routes, or expose secrets.

**Owner gate:** Autonomous unless a new server-side secret is required (owner-reserved — name + steps, never a value).

**Resolution:** **ALREADY FIXED (proof-only close, no production-code change).** Verification: the LT-012 "required the credential again" observation was traced (by **F04C, live-validated on shell v137**) to expected loss of site data — clearing Safari history/website data correctly clears the session — **not a persistence regression.** The session is durable and server-authoritative: `services/session.js` issues a **120-day** (`DEFAULT_TTL_MS`) HttpOnly + Secure + SameSite=Lax signed cookie that **renews after 60 days** (`RENEW_AFTER_MS`), so it survives refresh, close/reopen, service-worker/shell updates, and a return later within the window; a transport failure never becomes a key prompt and only a **server-confirmed** unauthenticated response asks to reconnect (`tests/e2e/session-auth.spec.js`: cookie-only reload, delayed status, status-timeout-then-success, genuine 401, Settings/Coach agreement). None of the forbidden changes were made (no raw keys to `localStorage`, no second client truth, no new auth system, no weakened routes, no exposed secrets).

**Completion record:** PR — this PR · Commit — no production code changed. Added durable-lifetime regression pins in `test/session.test.js` (TTL ≥ ~90 days and renews before expiry; a cookie stays valid across an 80-day gap and expires only after the TTL; a durable Set-Cookie carries HttpOnly + Secure + SameSite=Lax + a long Max-Age) so a future change that shortens the lifetime — re-prompting the owner sooner — is caught. `BACKLOG.md` `AUTH-DURABLE-1` resolved. Full node suite green.

### F09E — Generate complete executable session plans

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `PLAN-EXEC-1`

**Objective**

Every planned exercise must carry an **executable prescription**: explicit set count; target weight or bodyweight; reps; target RIR when applicable; warm-up vs work-set distinction; unambiguous formatting. The accepted plan must preserve the same structured set information in session state — it cannot exist only as prose.

**Formatting rules**

- Repeated identical work sets may use `×3`.
- Different set targets appear as separate lines.
- Bodyweight knee raises read like `BW — 15 reps ×3`, **not** `15/3`.
- Slash notation continues to mean reps/RIR, never set count.
- Low-confidence or unsupported targets ask for clarification rather than displaying a misleading isolated number.

**Required tests:** red-first planner/rendering test matching the failed upper-body-plan shape. Do not add general program generation, templates, or UI redesign.

**Owner gate:** Autonomous within existing plan/parser contracts (slash `225 5/2` semantics unchanged).

**Resolution (render-layer completeness).** The failure mode was in the plan card render (`src/app/coach-conversation.js` `formatPlanSetLine` / `appendWorkoutPlan` / `suggestedExercisesBlock`), not the engine — the deterministic engine already emits `target_sets`/`target_reps`/`target_rir` and the accepted plan already retains them in session state (`normalizePlanExercise` → `activePlannedSession`, so the prescription is not prose-only). Two concrete defects fixed: (1) a **bodyweight** lift (the engine emits `weight: 0`) rendered a meaningless `0lbs 15/?` because `Number.isFinite(0)` is truthy — now it renders **`BW — 15 reps ×3`** (grouped, explicit set count, RIR only when applicable), distinguished from a load-**omitted** accessory (`weight: null`, e.g. Face Pull) which keeps `15 reps/2`; (2) an exercise with **no confident rep target** (`reps == null`, the "isolated targets" case) rendered a **bare name** — now it shows a clarify prompt ("confirm reps and sets — I don't have a target for this yet") instead of a misleading isolated number. Weighted complete-target rendering (`225lbs 5/2`) and the `225 5/2` slash contract are unchanged.

**Completion record:** PR — this PR · Commit — `src/app/coach-conversation.js` (bodyweight `BW —` grouped line via a new `isBodyweightTarget` = `weight === 0` signal; `reps == null` → `.workout-plan-clarify` prompt; text-fallback `suggestedExercisesBlock` mirrors it), `src/app/styles.css` (`.workout-plan-clarify`), shell v143→v144 (`sw.js`/`app.js`/6 wiring pins). Red-first deterministic tests in `test/workoutPresentationConsistency.test.js` (BW → `BW — 15 reps ×3`, never `0lbs`/`15/3`; `reps==null` → clarify not a bare name; weighted + load-omitted regression unchanged) — RED before, GREEN after. Full node suite 5552 pass; plan-render e2e (app-smoke Suggested Workout) green; lint 0 errors. `BACKLOG.md` `PLAN-EXEC-1` marked fixed.

### F09F — Make the visible plan and live coach share one current target

**Status:** COMPLETE

**Finding:** `PLAN-COACH-SPLIT-1`

**Objective**

Reproduce synthetically (accepted plan target A; athlete performs target B; the live coach/recommendation engine treats B as though it were the original plan) and create one authoritative **current-plan selector/state** used by the visible plan card, next-up guidance, per-lift recommendation, coach response, recap, and closeout.

**Required semantics**

- The pre-set target remains authoritative for the completed set.
- A post-set recommendation change is an explicit revision applying only to future sets; the coach must say when it is revising the plan.
- It must not silently rewrite history; displayed plan and coach facts must agree; actual performance never becomes plan merely because it was logged.
- Deterministic-engine ownership of every number preserved.

**Required tests:** the reproduced case above plus cross-surface parity (plan card / next-up / per-lift rec / coach / recap / closeout agree). If F09F and F10 (completion identity) turn out to be the same selector, sequence F10 before the ledger cards as planned.

**Owner gate:** Autonomous (derivable from current-state truth).

**Resolution.** A read-layer map (six surfaces) established that the "actual silently becomes plan" behavior is **not** a stored write-back — no code ever overwrites `activePlannedSession.exercises[i].{weight,reps,rir}` with a performed value. It is a **read-time provenance gap** in the deterministic coach-answer layer (`services/sessionQuestionAnswer.js`), in two seams: (1) `targetFromContext` sourced a "target" from `current_preview` (performed rows) when the accepted plan lacked the lift — echoing a performed value as a prescription; (2) the engine fallback (`recommendNextSet`, recomputed from the just-performed set) was merged into the answer and worded identically to a frozen-plan value. The visible plan card, next-up, `currentPlanForChat`, recap, and closeout already read the frozen accepted plan (or carry no targets at all), so the divergence was concentrated in the coach's spoken facts. The fix makes every deterministic answer's target **explicitly one of**: the accepted plan (worded as today's plan), a **revised next-set recommendation** (live engine, labeled "no planned target — recommended for your next set: …", never merged into plan wording), or **"no reliable target available."** `targetFromContext` is now accepted-plan-only (tagged `source:'plan'`); preview still resolves lift identity but never prescribes numbers; the engine may fill genuinely-missing guidance for a real plan lift (e.g. a missing set count) still worded as the plan; context still outranks the engine where a real accepted-plan target exists. The pre-Gemini lanes defer (null) when they can't ground an answer so the LLM/education path is preserved; "no reliable target available" is the honest floor only in the LLM-down lane. Scope stayed inside the answer layer — no F10 ledger, schema, recap/closeout, or slot-completion-identity work (F09F ≠ F10: the target-value selector is distinct from F10's `plan_item_id` completion-identity selector).

**Completion record:** PR — this PR (F09F) · Commit — `services/sessionQuestionAnswer.js` (provenance: `targetFromContext` plan-only + `source`, `resolveAnswerTarget`, provenance-aware `formatAnswer`, `buildSessionQuestionAnswer`/`answerBareShorthand` rewired, honest "no reliable target available" floor). Red-first tests in `test/sessionQuestionAnswer.test.js` (the six required cases: plan-A-over-performed-B, preview-not-echoed, labeled next-set recommendation, no-reliable-target floor, next-set-scoped revision, missing-set-count stays green) + updated the two integration pins in `test/api-smoke.test.js` (#452 unplanned-lift engine answer now labeled a recommendation) and `test/sessionStateStress.test.js` (P4 preview resolves identity but no longer prescribes). Full node suite 5567 pass; lint 0 errors; secret scan clean.

### F09G — Repair conversational logging and final confirmation exactness

**Status:** COMPLETE — delivered as two focused PRs (parser slice + conversation-state slice)

**Finding:** `CONVO-LOG-1`

**Objective**

Make conversational multi-message logging exact through Done and the final confirmation card.

**Required proof (red-first E2E replay of synthetic equivalents of the observed flow — normal compound-lift entry; a repeated multi-set accessory where the weight is stated once; a second clarification/rephrasing of that accessory; "Just log it"; a bodyweight exercise expressed as several bare rep counts; Done; final confirmation):**

- No duplicate exercise created from a clarification; no completed set dropped; no set silently invented.
- Weight inheritance occurs only under an existing supported grammar rule; ambiguous input asks one bounded question.
- "Just log it" resolves the pending clarification rather than becoming a fabricated set.
- Bodyweight sets retain all rep counts and correct set numbering; Done does not mutate captured sets.
- The final confirmation card exactly equals the authoritative pending-session buffer; approval would write exactly the displayed rows; rejection writes nothing.

If parser behavior and conversation-state behavior are separate root causes, split this card into focused PRs. Do not loosen the parser into guessing.

**Owner gate:** Autonomous within the parser/trust contract (grammar changes beyond ambiguity handling are owner-reserved).

**Root-cause split (from a six-surface pipeline map).** The failure is BOTH parser and conversation-state, and they are independent:
- **Parser (`services/workoutTextParser.js`):** the bare-rep bodyweight (knee raise) clarification message was HARDCODED `"20, 15, 15"` regardless of the actual reps, so the lifter was asked back a set they never entered. The detected reps were already correct in `partial.sets`; only the human-facing question string drifted. (Auto-logging bare bodyweight reps without the ask, and cross-message weight inheritance, are **grammar changes beyond ambiguity handling → owner-reserved**; the card itself wants ambiguous input to "ask one bounded question", so the parser is otherwise correct — no grammar change made.)
- **Conversation-state (`src/app/app.js` + `coach-conversation.js`):** on a `needs_clarification` throw the parser's `partial.sets` are discarded (only `recognizedExercise` is kept), so clarified sets never reach the `getSessionLog()` buffer; "Just log it" is not a recognized closeout/resolution token; and the Done→confirmation closeout falls back to a Gemini re-parse of chat history whenever the buffer is empty, so the "card == buffer" invariant does not hold in that branch. **This is the follow-up PR.**

**Completion record (parser slice):** PR #1047 · Commit — `services/workoutTextParser.js`: the knee-raise bodyweight clarification now echoes the reps ACTUALLY detected (`Knee raises: do you mean bodyweight reps ${repCounts.join(', ')}?`) instead of a hardcoded `"20, 15, 15"`. Red-first `test/parser-golden.test.js` ("Knee raises 15 12 10" → the question echoes `15, 12, 10`, never `20, 15, 15`). Full node suite 5568 pass; lint 0 errors.

**Completion record (conversation-state slice):** PR — this PR (F09G conversation-state slice) · A new focused module `src/app/pendingClarification.js` (peer of `drawer.js`/`workoutSheet.js`) HOLDS a `needs_clarification` that already carries detected reps and commits **exactly** those sets on a short affirmation:
- `rowsFromBackendParsedWorkout` now carries `err.partialSets` instead of discarding the parser's `partial.sets`.
- The composer resolves a held clarification on a tight affirmation ("Just log it" / "yes" / "log it") **before** the closeout / "log it" routing, committing the held sets through the same `emitSetLogged` buffer path — so the reps reach the authoritative `getSessionLog()` buffer, retain all rep counts and set numbering, and land as bodyweight sets (weight `0`). "Done" is deliberately not an affirmation, so it still closes out.
- A sets-carrying `needs_clarification` is held and its bounded question surfaced (not leaked to the coach); a real set log or a superseding clarification clears the hold.
- **Result:** no clarified set is dropped, "Just log it" resolves the pending clarification instead of becoming a fabricated set or a session close, and because confirmed sets reach the buffer, the Done→confirmation card is the buffer (the empty-buffer Gemini recompile only fires when nothing was ever confirmed to the buffer, and remains a preview→approve-gated last resort — never a silent write; filed for optional further hardening).
- **Tests:** red-first `test/pendingClarification.test.js` (11 module unit tests for the state machine + shapes, 4 app.js-wiring source-slice guards) and a browser replay `tests/e2e/pending-clarification-resolve.spec.js` ("Knee raises 15 12 10" → held + coach not called + buffer empty → "Just log it" → exactly reps 15/12/10 as bodyweight sets). SW cache `atlas-shell-v144`→`v145` + `ATLAS_SHELL_BUILD` matched; new module precached in `SHELL_ASSETS`. Full node suite 5583 pass; lint 0 errors; e2e green (both viewports).

### F09H — Route PR claims correctly

**Status:** COMPLETE

**Finding:** `PR-CLAIM-1`

**Objective**

A "that was a PR" statement must not be parsed as workout-set input, must not open coaching-note consent, and must not write `Coaching_Notes`.

**Required behavior (red-first cases: "That was a PR!"; "I think that was a PR"; "That felt like a PR"; a false typed claim; a genuine PR in pending unsaved sets; a genuine PR after verified save):**

- Before verified workout save, Atlas may say it *appears* to be a candidate based on captured sets, but must not claim permanent history.
- After verified save, PR status is calculated from actual approved rows and historical data.
- A typed claim cannot manufacture a PR. A note-service failure cannot interrupt workout logging or closeout. PR state belongs to workout/progress records, not durable free-form memory.

**Owner gate:** Autonomous (no write/schema change; a failed note write must never 503-block logging).

**Resolution (from a four-surface map).** Two of the four surfaces were already correct and needed no change: the **parser** never parses a PR claim as a set ("pr" resolves to no alias; `parseWorkoutText` returns `needs_clarification`, never `log_sets` — verified against the alias table), and the **note-service is already isolated** — `POST /api/coaching-notes` returns an ordinary 503/500 that is swallowed by the client `showSaveNotePrompt` try/catch, and no logging/closeout path (`emitSetLogged`, `runCloseout`, `handleLogIt`) ever calls the note endpoint, so a note failure cannot interrupt logging (the 503 in the incident was a benign side-effect of the mis-proposed note). The **primary root cause** was that a self-reported PR claim could become a coaching-note: the note-proposing prompt had no exclusion for it and the server passed `propose_note` through untouched. Fixed deterministically:
- New pure classifier `looksLikePrClaim(message)` (`services/coach.js`, exported) detects a self-reported PR / personal-best CLAIM (or question) about a set just performed, but NOT a training GOAL that mentions a PR (a goal is a durable, note-worthy fact).
- The coach route (`routes/coachOps.js`) drops BOTH `propose_note` and `propose_constraint` when the message is a PR claim — so no "Save note?" consent opens and nothing reaches `Coaching_Notes` — while the grounded prose reply still stands.
- The chat prompt's note-proposing guidance now explicitly excludes a self-reported PR claim and states PR status is engine-owned (from logged rows), never a typed claim (defense in depth). The existing set-reaction IRON RULE + register suppressor already prevent the coach's prose from claiming a permanent PR without `progression_verdict.level === 'new_ground'`, and PR status is computed from actual rows (`progressionVerdict` / `athlete_identity.lift_prs`), so a typed claim cannot manufacture a PR.

**Completion record:** PR — this PR (F09H) · Commit — `services/coach.js` (`looksLikePrClaim` + prompt exclusion), `routes/coachOps.js` (drop note/constraint for a PR claim). Red-first `test/prClaimGuard.test.js` (claim vs goal vs ordinary), integration `test/api-smoke.test.js` (a "That was a PR!" claim yields `propose_note: null` + `propose_constraint: null` + a prose reply + no sheet write; a genuine injury note still proposes), prompt-content pin in `test/coachPromptRules.test.js`. Full node suite 5589 pass; lint 0 errors. The OPTIONAL deterministic client "appears-to-be-a-candidate" grounded lane is filed as an enhancement (not required; the LLM prose is already grounded by the IRON RULE).

### F09I — Use one canonical local session date for sidecar writes

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `SIDECAR-DATE-1`

**Objective**

Replace UTC-day derivation such as `new Date().toISOString().slice(0,10)` on owner-facing sidecar records with one canonical Atlas date utility and the configured owner timezone (**America/Vancouver**).

**Required coverage:** evening Pacific time; UTC midnight crossover; month/year boundary; daylight-saving transitions; Coaching Notes; Constraints; any adjacent owner-session sidecar using the same broken pattern. Do not rewrite historical rows. Verify the production timezone setting before the eventual live retest.

**Owner gate:** Autonomous within existing date semantics (no historical rewrite). Setting `ATLAS_TIMEZONE` in production is an owner env action if not already set.

**Resolution.** The canonical Atlas date utility already existed — `localTodayIso(now, tz = ATLAS_TIMEZONE)` in `services/analytics.js` (IANA-zone `en-CA` → `YYYY-MM-DD`; UTC fallback when unset). The two owner-facing sidecar write routes (`POST /api/coaching-notes`, `POST /api/constraints` in `index.js`) and the adjacent `Deload_State` `deload_start_date` (`services/deloadEngine.js`) each derived the date with a raw `new Date().toISOString().slice(0,10)` (UTC), so an evening-Pacific write was stamped tomorrow. All three now call `localTodayIso()`. No historical rows rewritten; behavior is unchanged until `ATLAS_TIMEZONE` is set (owner env action, `America/Vancouver`, verified at the final gate).

**Completion record:** PR — this PR · Commit — `index.js` (import `localTodayIso`; coaching-notes + constraints use it), `services/deloadEngine.js` (`deload_start_date` uses it). Red-first route tests in `test/api-smoke.test.js` (F09I: with `ATLAS_TIMEZONE=America/Vancouver` the coaching-note and constraint dates equal the Vancouver local day, not the raw UTC slice) — deterministically RED before / GREEN after (verified during the evening-Pacific window where UTC day ≠ Vancouver day). Added `localTodayIso` unit coverage for month/year boundary + daylight-saving transitions (`test/unit.test.js`). Full node suite 5556 pass; lint 0 errors. `BACKLOG.md` `SIDECAR-DATE-1` marked fixed.

### F09J — Stop calling benchmark comparisons "under target"

**Status:** COMPLETE

**Finding:** `UNDER-TARGET-1`

**Objective**

Preserve the current benchmark detector only where it is analytically valid, but correct its **claims**. Without a stored historical prescription, allowed language: "below your recent benchmark"; "below your established performance range"; a factual trend using actual numbers. Without a stored plan, Atlas must **not** say "missed target", "under target", "failed the plan", or "beat expectations".

**Required tests:** deliberately lighter sessions, alternate rep prescriptions, and recovery sessions are not described as plan failures merely because estimated performance is below a benchmark. This card fixes truthfulness now; full plan-aware assessment arrives in F10E.

**Owner gate:** Autonomous (wording/claim truthfulness; no number or write change).

**Resolution:** The `consistent_underperformance` challenge lives ONLY in the chat coach's CHALLENGE MODE prompt block (`services/coach.js` `buildChatSystemPrompt`) — there is no deterministic string that stamped "under target" onto a benchmark trend; the detector already forwards only `sessions_below of sessions_checked`. The fix rewords that prompt block: it now frames the signal explicitly as a `BENCHMARK/TREND comparison` against the lift's own established performance, `NOT a missed plan` (no per-session prescription was stored), forbids `"under target"`, `"missed target"`, `"failed the plan"`, and `"beat expectations"`, and supplies the honest replacement wording ("below your recent benchmark" / "below your established range"), including the worked example. Deterministic tests in `test/coachPromptRules.test.js` pin the benchmark framing, the plan-failure-vocabulary prohibition, and the replacement wording. The valid prescribed-RIR `effort_verdict` "way under target" path (a real per-set target comparison) is untouched.

**Completion record:** PR — this PR (F09J) · Commit — reword the chat CHALLENGE MODE prompt block to benchmark/trend framing (`services/coach.js`), add `test/coachPromptRules.test.js` F09J assertions, sync the LT-011 narration comment.

### F10 — Authoritative planned-slot completion identity

**Status:** COMPLETE — executed after F09J per the 2026-07-16 owner insertion. Its canonical `plan_item_id` and ambiguity-safe slot completion semantics are prerequisites for the F10A–F10E evolving-plan ledger.

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

**Current-state architecture map + exact stopping point (captured 2026-07-17, pause handoff — NOT yet implemented; from a read-only surface trace).**

*Authoritative spine to build on (already `plan_item_id`-keyed):* `src/app/planAcceptance.js:61-81` `buildAcceptedItems` mints one immutable crypto-only `pi_`-prefixed id per slot (fail-closed, never timestamp/random), building `items[]` = `{plan_item_id, planned_order, planned_lift_code, movement_pattern, outcome:'planned', performed_lift_code}`; `:147` tags the execution list 1:1 so `activePlannedSession.exercises[i]` (names/targets, read by every visible surface) carries its slot's `plan_item_id`. `src/app/planOutcome.js:30-35` `resolveItemForOutcome` resolves by `plan_item_id` ONLY, fail-closed; `src/app/planCompletion.js:35-56` `mostRecentCompletablePlanItem` (the "Done with X" lane) is the closest existing model — name used only as logged-evidence, target completed by id. Server side already folds by `(session_id + plan_version + plan_item_id)` (`services/sessionPlanReader.js:14-15,60-133`); `config/columns.js:76-84` already persists `plan_item_id`/`planned_lift_code`/`performed_lift_code`.

*The NAME-keyed completion to replace (the duplicate-name bug):* `services/sessionPlanExecutor.js:67-94` `computePlanState` builds `doneNames`/`doneCodes` Sets and filters `remaining` by name/liftCode membership — so two same-named slots both drop out on one logged set (no `plan_item_id` anywhere). Client twins: `src/app/app.js:4544-4550` `remainingPlannedExercises` (name-Set), `:4951-4952` the `sessionCompleted[]` fold (`resolveCompletedIdentity` → a NAME string array), `:4865-4918` `resolveCompletedIdentity` (tier-3 substring, no ambiguity refusal — `SESS-5`), `src/app/workoutSheet.js:83-103` `buildSheetCards` (status by normalized-NAME set membership).

*Only the explicit-outcome lane is slot-safe today* (`planOutcome.js` `runOutcome`, `completePlanItemById`, `app.js:2334-2342`). **Every visible surface decides by NAME:** recap `canonicalSessionRecap` (`app.js:4269-4283`), pin/next-up `renderSessionPin`/`currentPlannedExercise`/`firstUnloggedPlannedLift` (`app.js:4645-4742`), handoff `getNextExerciseInPlan` (`coach-conversation.js:1221-1254`, bidirectional substring), chat `currentPlanForChat`/`plan_completed` (`app.js:5625-5673`), closeout `planStateFromContext`/`computeCloseout` (`sessionPlanExecutor.js:260-274`, `services/sessionCloseout.js:28-37`, `routes/coachOps.js:887,1143`), Workout Sheet `buildSheetCards`.

*Substitution → original slot:* `applySessionSubstitution` (`app.js:1625-1678`) finds the slot by name but **retains the original `plan_item_id`** (`:1669`) and emits the `substituted` outcome by id — so the id spine is preserved, but downstream completion is still name-decided via `sessionCompleted[]` and `reconcileSubstitutedRemaining` (`activeSession.js:361-373`, name-only). `SESS-4`: `emitSetLogged` clears `pendingSubstitution` even on a no-op apply (`app.js:4932-4937`).

*Hazards (exact-match code):* `computePlanState:74`, `remainingPlannedExercises:4545-4548`, `buildSheetCards:85,97-99`, `resolveCompletedIdentity:4895-4901` (substring-first), `matchesPlanEditName:2475-2480` (the strong `planEditNameEquals:2484-2488` + `exactByName` guard at `:2565` is the pattern to generalize), `getNextExerciseInPlan:1230,1246-1250`, `entryMatches:63-64` (mitigated by `findMatchIndex`'s unique-only rule `activeSession.js:78-98`).

*Canonical selector to introduce:* a pure, DI, `plan_item_id`-keyed per-slot resolver — the generalization of `mostRecentCompletablePlanItem` + `resolveItemForOutcome`, e.g. `planSlotStatuses(activePlan, sessionCompleted) → [{plan_item_id, name, liftCode, status}]` with derived `remainingSlots`/`firstUnloggedSlot`/`isSlotComplete`/`isPlanComplete`. Keys on `plan_item_id`; uses name/liftCode ONLY as logged-evidence to attribute a log to a slot, with **exact-outranks-substring + ambiguity refusal** (reuse `findMatchIndex`'s unique-only rule); a substituted slot resolves via its retained `plan_item_id`. Route through it: `remainingPlannedExercises`, `firstUnloggedPlannedLift`, `renderSessionPin`, `currentPlannedExercise`, `canonicalSessionRecap`, the `sessionCompleted[]` fold, `isPlanCloseoutAwaitingSave`, `buildSheetCards`, `computePlanState` (+ `planStateFromContext`/`computeCloseout`/`coachOps`), `getNextExerciseInPlan`, and `reconcileSubstitutedRemaining`.

*Hard cases (only a NAME at the decision point):* (a) the **server coach-chat / closeout** path receives `current_plan`/`plan_completed` as NAMES over the wire (`routes/coachOps.js`) — routing it through the selector needs the client to additionally send `plan_item_id` on the chat context (an additive payload field, **not** a `Session_Plans` schema change), or the server stays name-keyed while the client surfaces become authoritative; (b) `sessionCompleted[]` is name-sourced (the log has no slot id), so the log→slot attribution is unavoidably a name match — the selector must do it ONCE, safely, then key everything downstream by id; (c) an **engaged-but-unaccepted** Coach's Pick has no `plan_item_id` (`plan.accepted !== true`) → id-keyed selectors fail-closed to a hardened name path there.

*Schema migration:* **NONE required.** `plan_item_id` is minted at acceptance, rides on every store slot, and is already persisted + folded server-side. F10 is a read-layer/selector consolidation over existing data (consistent with the card's owner gate).

*Exact stopping point (historical, now resolved):* the pause handoff captured F10 as not-started; it is now implemented per the map below.

**Resolution.** Introduced `src/app/planSlotStatuses.js` — one pure/DI, `plan_item_id`-keyed per-slot completion selector (`planSlotStatuses` + `remainingSlotNames`/`firstUnloggedSlot`/`isSlotComplete`/`isPlanComplete`). It seeds each slot from the authoritative id-keyed explicit-outcome lane (`items[].outcome`) then attributes each logged completion to AT MOST ONE slot, keyed by slot position, with exact-identity-outranks-substring and ambiguity refusal (a duplicate name stays slot-distinct; an ambiguous substring resolves none; a directional abbreviation and the qualifier-gated variant rule handle aliases/variants, so "Romanian Deadlift" never completes a bare "Deadlift" slot while "Incline Dumbbell Flyes" satisfies "Dumbbell Flyes"). A substituted slot retains its `plan_item_id`, so logging the substitute completes the original slot. Routed every consumer through it: `remainingPlannedExercises` (hence the pin, next-up, `firstUnloggedPlannedLift`, `isPlanCloseoutAwaitingSave`, and `emitSetLogged`'s nextPlanned/plannedQueue), `canonicalSessionRecap`'s remaining, and `workoutSheet.buildSheetCards` (now status-by-slot, not name-set membership). Hardened `resolveCompletedIdentity` (exact-outranks-substring + unique-only refusal + qualifier-gated reverse) and the coach handoff `getNextExerciseInPlan` (unique-only substring). Made server `computePlanState` duplicate-distinct (greedy per-slot attribution). The equipment/angle variant rule is single-homed in `activeSession.js` (`variantSatisfies`, consumed by both `reconcileSubstitutedRemaining` and the F10 selector). **No `Session_Plans` schema migration** — `plan_item_id` was already minted/persisted/folded; F10 is a read-layer consolidation.

**Completion record:** PR — this PR (F10) · Commit — new `src/app/planSlotStatuses.js` selector + routing in `src/app/app.js` (`remainingPlannedExercises`, `canonicalSessionRecap`, `resolveCompletedIdentity`, `plannedExerciseEntries` carries `plan_item_id`), `src/app/workoutSheet.js` (`buildSheetCards` by slot status), `src/app/coach-conversation.js` (ambiguity-safe handoff), `src/app/activeSession.js` (single-home `variantSatisfies`), `services/sessionPlanExecutor.js` (greedy `computePlanState`), `src/app/sw.js` (precache the new module). Red-first repro `test/planSlotCompletionIdentity.test.js` (executor duplicate broadcast) — RED before / GREEN after; selector contract `test/planSlotStatuses.test.js` (duplicate names, substring collision, variant/substitution, alias, plural, out-of-order, skip, reload); cross-surface parity `test/planSlotSurfaceParity.test.js` (recap = next-up = closeout = Workout Sheet from one selector); Workout Sheet duplicate-name case in `test/workoutSheet.test.js`; slice-harness + lock-in tests updated to the single-source shape. Full node suite 5609 pass; lint 0 errors; syntax/wiring/secret-scan clean.

### F10A — Define the set-level recommendation ledger and storage contract

**Status:** COMPLETE (executed after F10)

**Resolution.** Registered the append-only companion tab: `config/columns.js` `sessionPlanSetsColumns` (the owner-approved 16-column schema, `docs/SESSION_PLANS_LEDGER_DESIGN.md` §2) + `Session_Plan_Sets` in `config/sheetContract.js` `optionalSheetTabs` (503/no-op until the owner creates it). Added the pure contract module `services/sessionPlanLedger.js` (mirrors `services/sessionPlanEvents.js`): frozen `RECOMMENDATION_SOURCES`/`REVISION_SOURCES`/`CONFIDENCE`; a deterministic `idempotencyKey` over `(session_id, plan_version, plan_item_id, set_index)` only (never targets/timestamp); `buildAcceptedRows` (ledger v1 — one row per set, `supersedes_key` empty, blank targets when `no_reliable_target`, bodyweight `0` preserved); `buildRevisionRow` (an EXPLICIT future-set revision — rejects any non-`live_revision`/`user_endorsed` source so a performed value can never revise, amendment 1); and the chain-validating `effectiveRecommendation`/`effectivePlan`/`planHistory` that fold to the highest version but **fail closed to `no_reliable_target` + diagnostics** on duplicate versions, forks, missing/dangling/non-immediate `supersedes_key`, cross-session/item/set references, and non-contiguous versions (amendment 3) — never a silently-selected max-version row. Added the idempotent creation-time checkpoint path `services/sessionPlanSetsStore.js` (amendment 2), **dry-run by default**: gated behind `SESSION_PLAN_SETS_WRITE_ENABLED` (off), every checkpoint returns the W1–W3 proof (`sheet_written:false`/`no_write_confirmed:true`) and touches no sheet; the live path (append-only, idempotent-retry, revision-collision-fail-closed, tab-missing 503) is proven under an env-override + stubbed sheets so F10D only flips the flag. Both new services are staged in `config/wiring-allowlist.json` (F10B wires them). No production tab, no live write, no `Session_Plans`/`Log_Cleaned`/`Effort` migration.

**Completion record:** PR — this PR (F10A) · Commit — `config/columns.js` (`sessionPlanSetsColumns`), `config/sheetContract.js` (optional tab), new `services/sessionPlanLedger.js` + `services/sessionPlanSetsStore.js`, `config/wiring-allowlist.json` (staged entries), tests `test/sessionPlanLedger.test.js` (schema, idempotency, accepted/revision builders, the July 16 dips fixture, and every malformed-chain fail-closed shape) + `test/sessionPlanSetsStore.test.js` (dry-run no-write proof + live idempotent/collision/tab-missing). Full node suite 5636 pass; lint 0 errors; syntax/wiring/secret-scan clean.

**Objective**

Implement the smallest append-only model capable of preserving: session identity; plan version; plan item identity; target set identity or set count; target weight; target reps; target RIR; recommendation source; effective event/set boundary; replacement/supersession; confidence / no-reliable-target status; original and revised plan history; final effective plan; closeout/write identity.

**Direction & trust requirements**

- Prefer a narrowly scoped extension of the existing `Session_Plans` system or a companion `Session_Plan_Sets` tab. **Do not introduce another database.**
- No historical rewrite; no actual-result-to-plan copying; no mid-session production Sheet write requirement; deterministic IDs and idempotency; reload/resume safe; bounded JSON only where justified; exact schema contract and tests; migration forward-only.
- The owner approves the **product model**, but **applying a production Sheet schema migration remains an explicit owner-reserved action.** Build and merge code, contracts, fixtures, and dry-run behavior; continue through downstream cards using test/sandbox contracts. Stop only before the actual production schema change if it cannot be applied safely without owner authorization — do **not** halt all development at this point.

**Completion record:** PR — · Commit —

### F10B — Capture accepted plans and explicit live revisions

**Objective**

When Atlas proposes and the athlete accepts a session, create ledger **version 1** including every planned set, preserving ordering and `plan_item_id`.

**During the workout**

- Explicit substitution/pivot generates a new recommendation **before** the substitute's work is evaluated.
- Skipping or replacing an exercise records the plan outcome.
- A user-requested change becomes Atlas's recommendation **only** when Atlas explicitly endorses or revises it.
- Post-set adjustments apply only to future sets; completed-set targets remain immutable.
- All revisions are visible in current plan state; reload/resume retains them.

**Durability model (superseded by owner amendment A2, `docs/SESSION_PLANS_LEDGER_DESIGN.md` §10):** the original "keep the pending ledger in session state until closeout" model was **rejected as insufficiently durable**. Each accepted plan (v1) and each explicit revision is durably + idempotently **checkpointed at creation** via a non-blocking sidecar (dry-run until F10D enables live writes); session state is a **cache reconstructed from the durable ledger** on reload/resume.

**Status:** COMPLETE — slice 1 (acceptance capture + revision infrastructure) and slice 2 (`F10B-REVISION-WIRING-1`: mid-session explicit-revision **triggers** + reload reconstruction) shipped.

**Resolution (slice 1).** Built the ledger creation-time checkpoint lane end-to-end, dry-run: `services/sessionPlanSetsCapture.js` (the failure-isolated envelope + exact-16-col-header validation over the F10A store, mirroring `services/sessionPlanCapture.js`); two authenticated `writeCapable` sidecar routes `POST /api/session-plan-sets/accept` (ledger v1) and `POST /api/session-plan-sets/revision` (one explicit future-set revision — the route rejects any non-`live_revision`/`user_endorsed` source, `plan_version < 2`, or missing `supersedes_key`, so a performed value can never revise, amendment 1), declared in `config/routes.js`. Client: `src/app/planAcceptance.js` `buildLedgerAcceptedItems` (pure — joins the immutable accepted items with the displayed prescription; an item with no set count is NOT invented into the ledger, an item with a set count but no load/reps is an honest `no_reliable_target`, bodyweight `0` preserved) + `runAcceptance` now posts the v1 checkpoint via an additive non-blocking `postLedgerCheckpoint` dep (injected in `src/app/app.js` — never the preview→approve→write path; a sidecar failure never unwinds the accepted snapshot). The three F10A ledger services left the wiring allowlist (now production-reachable). All dry-run: `captured:false`/no sheet touched until F10D.

**Resolution (slice 2, `F10B-REVISION-WIRING-1`).** Wired the mid-session explicit-revision TRIGGER end-to-end, still dry-run. New pure client ledger `src/app/sessionLedger.js`: `performedSetCount` (the frozen floor — a revision may target only set indexes above the count already logged, plural/singular-tolerant, mirrors the executor's normalization); `buildFutureRevisions` (one revision per FUTURE set only — performed sets stay frozen; returns `[]` unless an EXACT `target_weight` AND `target_reps` are present so a revision is never fabricated, bodyweight `0` preserved; idempotent — a re-fired identical substitution adds no redundant version, a genuinely-different target appends the next linear version); `appendRevisions` (append-only — an existing `(item, set, version)` is a no-op, prior rows never mutated). `src/app/app.js` `emitFutureSetRevision` builds the future revisions, appends them to the store, persists the reload snapshot, and posts each to `POST /api/session-plan-sets/revision` non-blocking; it is called from exactly one site — the explicit `applySessionSubstitution` replace path — so a logged set (`emitSetLogged`) can never create a revision (proven structurally). The future-set bound is the slot's **accepted (v1) set count**, captured before the in-place swap overwrites it — never the substitute's own prescribed set count — so every revised set keeps a v1 predecessor (an over-count can't dangle the chain, an under-count can't strand a stale v1 row). Revisions live in a new `_sessionRevisions` store signal persisted in the reload snapshot (shape v2→v3, back-compatible hydrate) and reconstructed on resume; cleared at every session-reset point. Server `POST /api/session-plan-sets/revision` no longer requires the client to send `supersedes_key` — it is derived server-side from version N-1 via `services/sessionPlanLedger.js` `supersedesKeyFor` (revision chains are linear), closing the client/route contract.

**Completion record:** PR (slice 1) — F10B · PR (slice 2) — this PR · Commits — slice 1: `services/sessionPlanSetsCapture.js`, `routes/sessionPlans.js` + `config/routes.js` (accept/revision routes), `src/app/planAcceptance.js` + `src/app/app.js` (`postLedgerCheckpoint`), `config/wiring-allowlist.json`; slice 2: new `src/app/sessionLedger.js`, `src/app/app.js` (`emitFutureSetRevision` + reset wiring), `src/app/store.js` (`_sessionRevisions` signal + snapshot v3), `services/sessionPlanLedger.js` (`supersedesKeyFor`), `routes/sessionPlans.js` (server-derived `supersedes_key`), `src/app/sw.js` (precache). Tests: `test/sessionLedger.test.js`, `test/sessionRevisionWiring.test.js` (new — incl. the accepted-set-count bound), `test/sessionPlanLedger.test.js`, `test/sessionPlanSetsRoutes.test.js`, `test/store.test.js` (additions). Full suite 5669 pass; lint 0 errors. Codex P2 (set-count-change corrupts effective ledger) fixed by the accepted-set-count bound; Codex P2 (checkpoint suggested substitutions before the log) dispositioned non-issue — a declared swap is checkpointed at application (still before any future set is performed), matching the existing `emitPlanItemOutcome` timing; checkpointing an un-adopted suggestion would create phantom revisions.

### F10C — Generate an independent recommendation for an unannounced exercise

**Status:** COMPLETE — slice 1 (the leakage-safe derivation + `implicit_unplanned` ledger-row builder, pure) and slice 2 (`F10C-IMPLICIT-WIRING-1`: the dry-run derive+checkpoint route + the client trigger on an unplanned log + reload reconstruction) shipped.

**Owner contract:** the 7-point decision (Dale, 2026-07-18) is written verbatim into `docs/SESSION_PLANS_LEDGER_DESIGN.md` §4A (amendment A4) — one next set only; no rep/RIR range collapsed to a scalar; an `implicit_unplanned` row only when exact weight+reps+rir derive from pre-session history; current session excluded (the leakage guarantee); absent/ambiguous/range-only → `no_reliable_target`, no row; a performed value never becomes the recommendation.

**Resolution (slice 1).** `services/implicitRecommendation.js` `deriveImplicitRecommendation(...)` — PURE and deterministic. It excludes the current session from `logRows` first (rule 4/6 — the leakage guarantee), then derives an EXACT target: `target_weight` = the engine's pinned `recommendedWeight` (undefined on a cold start → `no_reliable_target`), `target_reps`/`target_rir` = the exact most-recent prior WORKING SET's reps/rir (the engine emits rep/RIR only as `{min,max}` RANGES, which rule 2 forbids collapsing — so a blank prior reps/rir reads strict-null, never a fabricated 0). Any of the three not exactly derivable → `no_reliable_target` (`target_set_count 1`, no row). `services/sessionPlanLedger.js` `buildImplicitRows` builds the standalone v1 `implicit_unplanned` row (`set_index 1`, `target_set_count 1`, `supersedes_key ''`, bodyweight `0` preserved) for a reliable target, and appends **no** row for a `no_reliable_target` item (§4A rule 5 — an unannounced exercise with no confident target has no recommendation to record). Red-first `test/implicitRecommendation.test.js` (the required leakage proof — a wild vs a light just-submitted set derive the identical target — plus exclusion, cold-start, blank-rir-not-0, one-set) + `test/sessionPlanLedger.test.js` (`buildImplicitRows`). `services/implicitRecommendation.js` is staged in `config/wiring-allowlist.json` (slice 2 wires it). No route/app/write change; no production tab.

**Resolution (slice 2, `F10C-IMPLICIT-WIRING-1`).** Wired the derivation end-to-end, still dry-run. Server: `POST /api/session-plan-sets/implicit` (`routes/sessionPlans.js`, now given `{getSheetRows, logSheetName, effortSheetName}` in `index.js`) DERIVES server-side over the full Log_Cleaned history with the current session excluded (the leakage guarantee — the just-logged set is never sent and its session is excluded regardless), then checkpoints a reliable target via `captureImplicit`/`checkpointImplicit` (`services/sessionPlanSetsCapture.js` / `sessionPlanSetsStore.js`, mirroring accept/revision, dry-run) — a `no_reliable_target` derivation routes through the same builder that appends **no** row. Client (`src/app/app.js`): `emitSetLogged` detects an off-plan logged exercise via `isOffPlanLoggedExercise` (the F10 `planSlotStatuses` selector in isolation — no divergence) and calls `emitImplicitRecommendation`, which POSTs to `/implicit` under a DETERMINISTIC per-(session,lift) `plan_item_id` (idempotent re-log) and stores only a reliable result in a new `_sessionImplicitRecs` store signal (snapshot shape v3→v4) for reload reconstruction; scoped to accepted-plan sessions, never a planned slot or a substitute, never the performed value (only prior evidence is read server-side). Red-first `test/implicitRecommendationWiring.test.js` + `test/sessionPlanSetsRoutes.test.js` (`/implicit`) + `test/store.test.js` (v4 round-trip). `services/implicitRecommendation.js` left the wiring allowlist (now production-reachable).

**Objective**

When the athlete simply logs an exercise that was not requested or planned:

1. snapshot history and current-session context **before** incorporating that exercise result;
2. call the deterministic recommendation engine as though the athlete had asked for the target;
3. record that recommendation as an implicit plan addition;
4. record the submitted sets separately as actual execution;
5. compare them without moving the goalposts.

The just-submitted result must be **excluded** from the evidence used to derive its own target. When there is insufficient history: record **no reliable target available**; preserve the actual; do not invent a target; do not call the actual result the plan.

**Required tests:** leakage tests proving that changing the submitted result does not change the recommendation derived from the same pre-exercise evidence. ✅ delivered in `test/implicitRecommendation.test.js` (slice 1).

**Completion record:** PR (slice 1) — #1056 · PR (slice 2) — this PR · Commits — slice 1: new `services/implicitRecommendation.js`, `services/sessionPlanLedger.js` (`buildImplicitRows`), `docs/SESSION_PLANS_LEDGER_DESIGN.md` §4A/A4, `test/implicitRecommendation.test.js`; slice 2: `routes/sessionPlans.js` + `config/routes.js` (`/implicit` route) + `index.js` (DI), `services/sessionPlanSetsStore.js`/`sessionPlanSetsCapture.js` (`checkpointImplicit`/`captureImplicit`), `src/app/app.js` (`emitImplicitRecommendation` + off-plan trigger) + `src/app/store.js` (`_sessionImplicitRecs`, snapshot v4), `config/wiring-allowlist.json` (implicitRecommendation now wired), tests `test/implicitRecommendationWiring.test.js`, `test/sessionPlanSetsRoutes.test.js`, `test/store.test.js`. Full suite 5689 pass; lint 0 errors.

### Post-F10 stabilization insertion — F10S1–F10S6 + F10S-GATE (owner-directed, 2026-07-18)

**Authority:** Explicit owner instruction (Dale, 2026-07-18). The July 18 owner Work-mode smoke test is treated as a **failed stabilization gate**: it demonstrated that F10's completion identity is not yet authoritative on every surface, plus two older parser/intent failures. **F10D is paused** — no F10D implementation, no production `Session_Plan_Sets` tab, no production-write enablement, and no live ledger write until every F10S card is complete and the F10S-GATE rerun passes. This is an insertion into this canonical plan, not a second roadmap. **Execution order: F10S1 → F10S2 → F10S3 → F10S4 → F10S5 → F10S6 → F10S-GATE → F10D.**

Rules for the insertion (owner-set): work red-first; one focused PR per card **unless two cards are proven to share one root cause** (record the shared-root-cause evidence in the merge card); route every UI and coach surface through the canonical completion selector (`src/app/planSlotStatuses.js`) rather than patching wording locally. Run the Current-State Verification Gate per card — a card may resolve as root-caused by another card (e.g. F10S2's entry path may prove to be F10S6c), and that verdict must be recorded, not assumed. Positive finding preserved from the smoke test: closeout kept actuals separate and did not overwrite the original plan — the two-truths foundation is sound; the broken part is **progression and binding across surfaces**.

### F10S1 — Planned-slot completion multiplicity

**Status:** COMPLETE

One performed set must not complete an entire multi-set planned slot. Completion status must account for the required set count per `plan_item_id`, not merely whether any performed row matches the item. **Reproduce:** accepted RDL target has 3 working sets; perform one RDL set; the slot remains **in progress**, not complete; rail, pin, next-up, recap, handoff, and closeout agree. (The smoke failure: one RDL set completed the whole RDL slot.)

**Resolution.** `src/app/planSlotStatuses.js` is now set-count aware: `buildSlots` reads the slot's prescribed `sets` as `requiredSets`, and `planSlotStatuses(activePlan, completedNames, sessionLog)` takes the per-set log — attribution (unchanged tiers) claims a slot, but COMPLETION additionally requires the performed-set count to reach `requiredSets` (below it the slot stays PENDING and exposes `performedSets`/`requiredSets`/`attributedName`). The explicit id-outcome lane (Done/skip) stays authoritative; a slot with no known count and legacy no-log callers keep the old rule; over-logging never blocks. Set counting matches rows by the attributed identity OR slot name, floored at 1 when attributed — and `emitSetLogged` now stamps each buffer row with its resolved identity (`canonical`) so alias-form rows ("RDL") count toward their planned lift (`sessionLedger.performedSetCount` honors it too, tightening the F10B frozen floor). Consumers routed: `plannedExerciseEntries` carries `sets`; `remainingPlannedExercises`/`firstUnloggedPlannedLift`/handoff/`isPlanCloseoutAwaitingSave` pass the log; the TODAY rail (`workoutSheet.js renderCards`) passes the log; `getCanonicalSession` replays completions THROUGH the selector (an in-progress slot is not marked done in the AS model and not inserted off-plan — recap/banner/current agree), with `canonicalSessionRecap`'s logged-work gate widened to the raw session log; `isOffPlanLoggedExercise` (F10C) now tests ATTRIBUTION, not completion, so an in-progress planned lift never triggers an implicit recommendation.

**Completion record:** PR — this PR · Commit — `src/app/planSlotStatuses.js`, `src/app/app.js`, `src/app/workoutSheet.js`, `src/app/sessionLedger.js`; red-first `test/planSlotMultiplicity.test.js` (10 cases incl. the smoke reproduce) + `test/planSlotSurfaceParity.test.js` (real-app.js surface agreement on the 1-of-3 case) + harness/pin updates (`activeSessionE2E`, `insertFinisherWiring`, `activeSessionPlanCard`, `postLogIdentity` owner-repro now proves hold-then-advance at 3/3, `identityCorrectionWiring`, `unit.test.js`). Full suite 5703 pass; lint 0 errors.

### F10S2 — Substitution binding

**Status:** COMPLETE

A recognized Front Squat substitution for Back Squat must satisfy the original Back Squat `plan_item_id` everywhere. **Reproduce:** plan Back Squat; perform "Front Squat … instead of Back Squat"; the substitution outcome binds to the original slot; Back Squat does not remain current; next-up advances consistently; the performed exercise remains Front Squat in actuals. (Verify first: the binding layer (`applySessionSubstitution` retains the original `plan_item_id`) may already be sound, with the failed entry path being the one-turn parser — F10S6c. If proven, record the shared root cause and fix at the true layer.)

**Verification verdict (as the card predicted):** the binding layer was sound; the smoke failure's root cause was the ENTRY — the one-turn phrase never parsed (F10S6c, fixed in the parser-grammar PR). This card's fix is the client wiring that carries the parsed directive into the existing binding lane.

**Resolution.** The parse consumer holds `parsed.substitution.for` one-shot (`lastParseSubstitution` — reset at every new parse), and the chat-lane log commit arms the EXISTING deferred-swap lane (Step 373b) with it: `setPendingSubstitution({ prescribed: <original>, prescription: null })` immediately before `emitSetLogged`, so this turn's first logged exercise replaces the named planned slot via `applySessionSubstitution` — original `plan_item_id` retained, `substituted` outcome emitted, F10B revision semantics unchanged (no explicit target → no fabricated revision), completion identity follows the substitute. A directive with no active plan drops harmlessly; one-shot either way, so it can never mis-bind a later log. Multiplicity correctness rides along (F10S1): with no substitute prescription the replacement slot **inherits the original's set count**, so one substitute set can never complete a multi-set slot (an explicit recommender prescription still wins). Proven through the REAL lanes in `test/substitutionBindingWiring.test.js` (real `applySessionSubstitution` + real `emitSetLogged` composed): binds (id retained), Back Squat not current, next-up = the in-progress substitute at 1/3 and advances at 3/3, actuals keep Front Squat, outcome bound to `pi_bsq`, plus structural one-shot wiring pins.

**Completion record:** PR — this PR (entry: the F10S6(b+c) parser PR) · Commit — `src/app/app.js` (`lastParseSubstitution` carrier + chat-commit arming + set-count inheritance in `applySessionSubstitution`); tests `test/substitutionBindingWiring.test.js` (new), `test/pendingClarification.test.js` (window widened, contract unchanged). Full suite 5725 pass; lint 0 errors.

### F10S3 — Single completion-state source

**Status:** COMPLETE

Fix the disagreement where chat says Overhead Press is next while the TODAY rail still shows Back Squat. Every completion/remaining consumer must read the same canonical selector result — no parallel completion state, no locally-derived "next".

**Root cause (verified):** typed session-state questions ("what's next?", "are we done?") were answered by the SERVER's parallel name-matcher (`services/sessionPlanExecutor.js` `computePlanState` via `planStateFromContext`) — which lacks the client selector's variant/ambiguity tiers and (post-F10S1) its multiplicity awareness. One Back Squat set on a 3-set slot: the name-matcher marked it done → chat said Overhead Press; the rail's selector said in-progress → Back Squat. Two engines, two answers.

**Resolution.** The canonical selector's VERDICT now travels with the question: `routeMessageToCoach` sends `context.plan_state` (`planned`/`completed`/`remaining` from the ONE multiplicity-aware selector the rail/pin/recap read) whenever a plan exists, and `planStateFromContext` PREFERS it — validated and bounded (strings only, trimmed, capped at 50) with `isComplete` recomputed server-side (the client flag is never trusted). Every consumer inherits it (the LLM chat context's `plan_state` and the deterministic Step-377 session-close answers read the same struct). A malformed or absent `plan_state` falls back to the legacy name-matcher unchanged (old clients identical). The pre-LLM bare-shorthand lane ("RIR?", "How much?" — `services/sessionQuestionAnswer.js` `currentLiftFromContext`) reads the same verdict: `plan_state.remaining[0]` decides the current lift, so a mid-set question answers for the in-progress lift the athlete is standing at instead of skipping past it (Codex P2). Red-first `test/sessionPlanExecutor.test.js` + `test/sessionQuestionAnswer.test.js`: the smoke reproduces (client verdict outranks the name-matcher; the close answer names the still-remaining lift; mid-set "RIR?" answers the in-progress lift), isComplete recompute, malformed/empty fallback, bounding/cleaning, and the client-wiring pin.

**Completion record:** PR — this PR · Commit — `services/sessionPlanExecutor.js` (`planStateFromContext` preference lane), `src/app/app.js` (`routeMessageToCoach` sends `plan_state`); tests `test/sessionPlanExecutor.test.js` (F10S3 block). Full suite 5731 pass; lint 0 errors.

### F10S4 — Session pin set attribution

**Status:** COMPLETE

The pin must show sets completed for the **current planned item only**, not total session sets. **Reproduce:** the bad state "Back Squat · 4 sets in" after one RDL set plus three Front Squat sets.

**Resolution.** `renderSessionPin` derived its count from `getSessionLog().length` (the whole session) while its current lift came from the selector — the mismatch. Now the pin's identity AND count come from the same selector verdict every other surface reads: `firstUnloggedSlot(activePlanForSlots(), completed, log)` supplies the current slot with `performedSets`/`requiredSets`, rendered as "N of M sets" (or "N sets in" when the slot has no known count — still the item's own count, never the session total). Freestyle (no plan) keeps the session-total behavior unchanged — there is no planned item to attribute to; the plan-complete fallback keeps the total too. Red-first `test/sessionPinAttribution.test.js` (real `renderSessionPin` sliced from the bundle, real selector, DOM-faithful fake pin): the smoke reproduce (1 RDL + 3 off-plan sets → "Romanian Deadlift · 1 of 3 sets", never 4), advancing 2/3 → next slot at 3/3, freestyle unchanged, a no-count slot shows its own 0 — never the off-plan total.

**Completion record:** PR — this PR · Commit — `src/app/app.js` (`renderSessionPin` + `firstUnloggedSlot` import); tests `test/sessionPinAttribution.test.js` (new). Full suite 5737 pass; lint 0 errors; workout-sheet E2E green locally.

### F10S5 — Closeout commentary deduplication

**Status:** QUEUED

The same substitution/coaching note must appear once, not once per performed set or source path. (The smoke failure: closeout duplicated substitution commentary three times.)

**Completion record:** PR — · Commit —

### F10S6 — Natural-language intent/parser regressions

**Status:** PARTIAL — (b) and (c) COMPLETE (the parser-grammar pair, one PR — shared root cause: NL grammar gaps in `services/workoutTextParser.js`); (a) intent routing remains.

**Resolution (b, c).** Two tiny additive grammar changes, red-first (`test/parserSmokeGrammar.test.js`): **(b)** `parseWeightRepsAtRir` — `WEIGHT x REPS [@ RIR]` (one set). The surface syntax collides with the existing sets-first claim (`3 x 8 @ 135` = 3 sets of 8 @ 135 lb), so the new reading engages only where sets-first rejects (first number > 10 → a load) and only for a plausible RIR (≤ 6); an implausible pair or a trailing `x3` compound still refuses to a clarification — never a guess, never a silent truncation. The `slp 70 x 12 @2` golden was updated to the owner-superseded truth (its two catastrophic-misparse protections retained). **(c)** a one-turn `<substitute log> instead of <original>` strips the trailing clause, parses the log normally, and carries `substitution: { for: <original> }` on the `log_sets` result — the F10S2 entry path; an unparseable remainder keeps the original full-text clarification (never a half-applied substitution). `225 5/2` byte-for-byte unchanged (golden + new guard).

Reproduce and fix, red-first:

1. "What should I do today?" must invoke **planning**, not the "keep logging" fallback.
2. "Romanian Deadlift 245 x 6 @3" must log correctly (compact slash notation worked; this natural form did not).
3. "Front Squat 185 7/2 x3 instead of Back Squat" must log **and** bind the substitution in one turn.

`services/workoutTextParser.js` is a protected contract: tiny focused grammar additions with live-path tests; the `225 5/2` semantics are untouched. (b) and (c) may share a parser root cause; (a) is intent routing and stays a separate concern unless proven otherwise.

**Completion record:** PR — · Commit —

### F10S-GATE — Smoke-test rerun (exit gate for the insertion)

**Status:** QUEUED — blocks F10D

After the fixes merge, rerun the **exact same non-destructive** July 18 Work-mode smoke test. Do **not** proceed to F10D until all of:

- one-of-three sets shows **in progress**;
- the substitution completes the **original** slot;
- chat, rail, pin, and closeout **agree**;
- natural-language inputs work;
- closeout commentary is deduplicated.

Return the rerun transcript and screenshots to the owner **before requesting F10D authorization**.

**Completion record:** rerun — · transcript/screenshots —

### F10D — Confirm and write planned versus actual together

**Status:** PAUSED (owner stabilization gate, 2026-07-18) — blocked on F10S1–F10S6 + a passing F10S-GATE rerun. The production tab / write-enablement / first-live-write authorizations remain owner-reserved on top of that gate.

**Objective**

Extend the **existing** closeout flow — do not create a second save workflow. When the athlete says Done or uploads the effort screenshot, the existing confirmation must show: final effective Atlas plan; actual performed sets; substitutions/pivots; skipped/replaced work; target-vs-actual differences; any no-reliable-target items; session date and effort information. The owner approves the whole closeout **once**.

**Required trust behavior**

- Rejected confirmation writes nothing; approved actual rows equal the visible actual rows; approved plan-ledger rows equal the visible effective plan/history.
- Original recommendations remain append-only history; final effective plan is clearly distinguished from the original plan.
- Log, Effort, and plan-ledger writes return exact proof; partial append failure never produces a false success; retries are idempotent; a plan-ledger failure does not silently leave Atlas claiming a fully verified closeout; no retroactive plan mutation during closeout.

Use dry-run and sandbox/integration coverage. A production schema application or real write remains owner-gated.

**Completion record:** PR — · Commit —

### F10E — Plan-aware historical assessment

**Status:** QUEUED

**Objective**

Build deterministic planned-versus-actual assessment using stored effective prescriptions. Allowed outcomes when a valid target exists: met plan; exceeded reps; used more/less load; worked closer to / farther from failure; completed fewer/more sets; met revised plan; self-selected work versus Atlas recommendation.

**Rules**

- Compare each actual set only to the recommendation effective for that set; a revision after set 1 cannot change set 1's target.
- Replaced/skipped items follow plan-outcome semantics; PRs derive from actual execution only.
- Historical sessions without stored plans receive benchmark/trend descriptions only; never fabricate a plan for legacy history; do not backfill old sessions from today's recommendation.
- Update challenge/reassure/progress wording to use plan-aware results when available and honest benchmark wording otherwise. (This completes the truthfulness fix begun in F09J.)

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

**Owner-directed expansion (2026-07-16 stabilization).** The proving packs must additionally include: normal owner-like plan and logging; a complete set-structured plan; explicit substitution; unannounced exercise; post-set plan revision; actual differing from plan; repeated accessory-set notation; bodyweight bare-rep entry; a PR claim; rejected confirmation; approved planned-versus-actual closeout; reload/resume; stale-response race; Flight Recorder full replay; automatic latest-live-test review; a legacy session with no historical plan; and all prior F02–F10 (and F09A–F10E) failures. Keep deterministic checks blocking and model-wording evaluation advisory. Do not create another test framework.

**Acceptance criteria**

- Tier-1 deterministic packs run in normal CI and are blocking.
- LLM wording scans remain advisory/report-only; no nondeterministic model judge becomes a hard gate.
- Every F02–F10 and F09A–F10E fix has at least one cross-seam fixture in addition to its focused regression.
- Failures identify the exact stage and preserve replay artifacts without secrets or production data.

**Likely surfaces**

`scripts/sim/`, `test/fixtures/replays/`, Playwright suites, CI workflow/config only as necessary.

**Owner gate**

None for synthetic/dry-run packs. Real production writes remain prohibited without authorization.

**Completion record:** PR — · Commit —

## 9. Milestone M4 — Five-session V1 proving run

Begins only after F11 is deployed. Feature development pauses. The run uses five owner-live cards created in `docs/TEST_QUEUE.md` when the run starts.

### Stabilization retest gate (owner-directed 2026-07-16)

After all F09A–F10E cards and the expanded F11 are green, and before M4's five-session count may begin:

1. Verify the exact deployed commit.
2. Verify Flight Recorder client **and** server capture are enabled.
3. Verify `ATLAS_TIMEZONE=America/Vancouver`.
4. Report whether a production Sheet schema action remains, and the exact smallest owner action if schema activation is required.
5. Create one bounded owner live-retest card (in `docs/TEST_QUEUE.md`) covering: plan generation; conversational logging; one pivot; one unannounced exercise; final planned-versus-actual confirmation; screenshot effort; approval and exact write proof; and automatic `atlas:review-live` review.

**The failed 2026-07-16 session does not count toward the five-session proving run. The five-consecutive-session M4 count does not begin until this stabilization retest passes.**

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
