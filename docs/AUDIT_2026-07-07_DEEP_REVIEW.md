# Deep Review Audit — 2026-07-07

**Scope:** adversarial correctness audit of the five trust-critical surfaces — server write path, client trust loop, parser, session state / coach flow, and infrastructure — performed as a one-shot deep pass explicitly requested by the owner ("review the repo deeply; single most high-value task") before the frontier-model window closed.

**Method:** five independent specialist review passes (one per surface), each instructed to verify candidate findings against existing tests, `git log`, `docs/BUG_TRIAGE_LEDGER.md`, and `BACKLOG.md` before reporting, and to report only findings with a concrete failure scenario. The top findings were then **independently re-verified** by the coordinating session: every parser finding was re-executed against the real `parseWorkoutText` entry point, and the top client/server/session/infra findings were re-read at the cited lines. Verdict legend:

- **CONFIRMED (empirical)** — reproduced by executing the real code; input → actual wrong output shown.
- **CONFIRMED (code)** — mechanism verified by direct code-read at the cited lines; not executed end-to-end.
- **PLAUSIBLE** — every link is real code, but the triggering conditions were not executed; treat as a verification-first fix.

**Baseline:** `main` @ `eb3cc8d` (2026-07-07). Full test suite green at audit time (162 parser tests, full unit + e2e suites). Nothing in this audit overlaps an open ledger row — `docs/BUG_TRIAGE_LEDGER.md` shows 0 open bugs, so every finding below is new.

**This is an audit, not a fix PR.** Per the PR Execution Contract, every finding is filed in `BACKLOG.md` (same PR as this doc); fixes ship as separate, individually-scoped PRs.

---

## Priority fix order (recommendation)

The four **P0** items are live data-integrity hazards in the permanent record and warrant jumping the remediation queue (they are exactly the class Phase -1 of `docs/REMEDIATION_PLAN_V2.md` existed for), ahead of PR-08:

| # | ID | One line |
|---|---|---|
| P0-1 | CLIENT-1 | Undo on an old review card deletes the **newest** write |
| P0-2 | PARSE-1 | `front squat 225 5/2` silently logs as **Back Squat** (variant-qualifier collapse) |
| P0-3 | PARSE-2 | Unknown digit-free line merges the next line's sets into the **previous** lift |
| P0-4 | PARSE-3 | `bench 225 5 2 185 8 2` produces garbage rows (2 lb × 185 reps) |

Second tier (**P1**, correctness on the write/trust path): PARSE-4, PARSE-5, WRITE-1, WRITE-2, WRITE-3, SESS-2, SESS-3, CLIENT-2, INFRA-1, INFRA-2. Everything else can ride the normal backlog cadence. Several CLIENT/SESS items (CLIENT-3, SESS-1, SESS-4) sit in code that PR-09/10/11 will restructure — if a fix does not land before those PRs, its scenario **must** become a required test case in them.

---

## Parser — `services/workoutTextParser.js`

### PARSE-1 · `[trust-critical]` · CONFIRMED (empirical) — anywhere-match alias resolution silently logs exercise *variants* as the wrong canonical lift

`services/workoutTextParser.js:151` — `findExerciseInText` matches an alias `\b…\b` anywhere in the text, so a variant qualifier before the alias is silently discarded and the sets attribute to the base lift. No warning, no `needs_catalog_review` chip.

Reproduced:

| Input | Actual | Expected |
|---|---|---|
| `front squat 225 5/2` | Back Squat 225×5@2 | Front Squat (or unknown-exercise ask) |
| `goblet squats 60 12/2 x3` | Back Squat ×3 | Goblet Squat |
| `close grip bench 185 8/2` | Bench Press | CGBP |
| `stiff leg deadlift 275 8/2` | Deadlift | SLDL |

This corrupts the wrong lift's permanent history (feeds benchmarks, deload, progression). The code already acknowledges this exact hazard for curls (comment at lines 24–26) but leaves `squat`, `bench`, `deadlift`, etc. as bare aliases. `data/exercise_catalog.v1.json` carries Front/Goblet Squat and CGBP as distinct exercises.

**Fix sketch:** in `findExerciseInText`, when the match is anywhere-position (not at-start), reject if the token immediately preceding the alias is name-like (reuse the `isNameWord` predicate); input then falls to `parseUnknownExercise`, which preserves the typed name with `unknown_exercise` + `needs_catalog_review`. Golden tests per P2. *Also strategically relevant to PR-14 (catalog-generated aliases) — fixing the matcher first prevents PR-14 inheriting the hole.*

### PARSE-2 · `[trust-critical]` · CONFIRMED (empirical) — digit-free unknown-name line becomes a phantom header of the *previous* lift

`services/workoutTextParser.js:647-654`, `786-792` — in multiline rescue, an unknown digit-free line ("rear delt machine") parses via the carry branch into `missing_sets` with `partial.exercise = <previous lift>`, and the header branch accepts it as a header for that previous exercise.

Reproduced: `bench 225 5/2\nrear delt machine\n95 12/2` → **one** entry: Bench Press `[[225,5,2],[95,12,2]]`, zero warnings. The 95×12@2 belongs to the rear delt machine. This is the un-fixed sibling of the 2026-07-03 "Zzqx Press" misattribution fix, whose invariant was "a line with its own leading name must never merge into a different exercise" — the digit-free form slips through (`parserFuzz.test.js:147` pins only the set-bearing form).

**Fix sketch:** before accepting a digit-free `missing_sets` line as a header, re-parse the line with `activeExercise: null`; if the name is not derivable from the line itself, push to `unresolved` and reset `carryExercise = null` so following bare set lines dead-end to an ask.

### PARSE-3 · `[trust-critical]` · CONFIRMED (empirical) — space-separated multi-set `{w} {r} {rir}` logs produce garbage rows

`services/workoutTextParser.js:1247-1254` — the whole-text anchor protects a single `225 5 2`, but two such sets fall into the bare-pair branch, which pairs the RIR token with the next weight.

Reproduced: `bench 225 5 2 185 8 2` → `[[225,5,null],[2,185,null],[8,2,null]]` — a 2 lb × 185-rep phantom row, both RIRs lost. `squat 315 5 1 275 8` → `[[315,5,null],[1,275,null]]`.

**Fix sketch:** in the bare-pair branch, refuse the pair (dead-end to `needs_clarification`) when the candidate weight is implausibly small relative to the reps token (e.g. weight ≤ reps, or weight < 20) — keeps the warm-up-climb case (`140 15`) working while rejecting an orphaned RIR token as a "weight".

### PARSE-4 · `[correctness]` · CONFIRMED (empirical) — mixed-notation input silently drops the set groups the winning sub-parser didn't consume

`services/workoutTextParser.js:947-954` — `parseSetGroups` is first-parser-wins over the whole rest text.

Reproduced: `bench 185 5/2 3x8@165` → only the 3×8@165; **the frozen-contract slash set is silently discarded**. Also `bench 3x8@165 then 175 for 5` (drops the 175×5) and `incline db press 60s 10/3 55s x8 @2` (drops the second group). Violates "the trust path must not silently discard user intent"; the fuzz suite's never-silent invariant only asserts *some* output exists, so partial drops pass.

**Fix sketch:** after a sub-parser returns, scan the cleaned text for set-shaped tokens it did not consume (`\d+/\d+`, `\d+s \d+/`, `x\d+\s*@`, `\d+ for \d+`); if any remain, return `needs_clarification` rather than a partial set list.

### PARSE-5 · `[correctness]` · CONFIRMED (empirical) — `@N` is weight in `parseSetsFirst` but RIR in the dumbbell grammar; `bench 3x10 @2` logs a 2 lb bench

`services/workoutTextParser.js:1121` — reproduced: `bench 3x10 @2` → 3 sets of weight 2, reps 10, rir null. The dumbbell form `55s x10 @3` reads `@3` as RIR; the barbell form `Bench 3x5 @205` pins `@` as weight. A small `@` value is always a lifter's RIR, never a 2 lb barbell.

**Fix sketch:** in `parseSetsFirst`, when the `@` value is ≤ 10, dead-end to a clarification ("@2 — weight or RIR?") instead of emitting weight 2. (The @-weight grammar itself is owner-pinned; only the small-value collision changes.)

### PARSE-6 · `[polish]` · CONFIRMED (empirical) — `AMBIGUOUS_ALIASES` fires only at start-of-text

`services/workoutTextParser.js:137-141` — `then rows 95 10/2` logs literal exercise "Rows" (flagged `unknown_exercise`, so not silent) instead of firing the designed "which row?" ask. **Fix sketch:** run the ambiguous-alias check against the `extractUnknownExerciseLead` result too.

### Parser — verified clean

RIR 0 preserved in all three notations (never conflated with missing); kg→lb conversion correct incl. dumbbell `30kgs`; G1 same-line guards hold; xN>10 and setCount>10 refuse rather than explode; continuation lines attach to the correct active exercise.

---

## Server write path — `index.js`, `services/idempotency.js`, `sheets.js`

### WRITE-1 · `[correctness]` · CONFIRMED (code) — `/api/complete-workout` live writes return no `logAppendedRange`, violating W3 and making closeout saves un-undoable

`index.js:3794/3800/3868-3895` — the two `appendRows` results are discarded; `logAppendedRange` exists only in the `/api/log-workout` handler (`index.js:4358/4381`). `verify-range` and `undo-last` both require the exact appended range, so a screenshot/closeout save can never be verified or undone (the client-side symptom is already noted in the ledger: `pendingLastWrite` is null for screenshot/effort-only saves). W3's text is unqualified: *every* successful live write response must include the range.

**Fix sketch:** capture the two append responses (as `/api/log-workout` does) and add `logAppendedRange` / `effortAppendedRange` + real `updatedRows` to the response, including the partial-failure body. Client adoption (undo affordance on closeout cards) is a follow-up.

### WRITE-2 · `[correctness]` · PLAUSIBLE — stale-`in_progress` retry of `/api/complete-workout` can double-write the entire workout when the client omitted `session_id`

`index.js:3648-3650` + `services/idempotency.js:91-105` — crash after append, before `completeWrite`; client retries same `write_id` >5 min later → record downgraded to `failed` → clean attempt. Server re-mints the session id (`2026-07-07-am` is now taken → `-am-2`), the `duplicateSession` hard-stop requires a client-supplied `session_id` so it's bypassed, and every composite dedupe key is "new" under the fresh session id → all log rows + a second Effort row appended as a phantom session. This voids the PR-04 claim that the composite-key dedupe backstops the idempotency store — that guard is inert whenever the session id is server-minted.

**Fix sketch:** stamp the minted session id into the idempotency record's metadata at `beginWrite` and reuse it on retry of the same `write_id`, so the composite dedupe holds; or refuse auto-minting on a `failed`-record retry (400 with guidance).

### WRITE-3 · `[correctness]` · CONFIRMED (code) — stale `in_progress` records are only downgraded at load time; an early-rehydration wedges the write_id for up to 24 h

`services/idempotency.js:91` + `:149-168` — the `in_progress → failed` downgrade runs only in `loadFromDisk`. If the first write after a crash-restart arrives within `STALE_IN_PROGRESS_MS` (5 min), the crashed record rehydrates as `in_progress` verbatim and is never re-evaluated (`loaded` flag; `beginWrite` refuses everything not `failed`). Every retry of that write_id 409s (`skipped_duplicate_in_progress`) until the 24 h TTL. `idempotencyPersistence.test.js:81` only pins the late-rehydration case.

**Fix sketch:** tag disk-loaded records `rehydrated: true`; in `beginWrite`, downgrade a rehydrated `in_progress` older than `STALE_IN_PROGRESS_MS` to `failed` and fall through. Restricting to rehydrated records keeps genuinely in-flight same-process writes safe.

### WRITE-4 · `[housekeeping]` · CONFIRMED — invariant W7 ("≤10 rows") contradicts the shipped undo/verify cap of 200

`docs/INVARIANTS.md:35` vs `index.js:298/4471` — commit `b859abf` (PR-0A) raised the span cap to `MAX_LOG_ROWS = 200` without amending W7. A future agent enforcing W7 as written would "fix" the cap back and re-break multi-set closeout undo — this audit's own briefing repeated the stale contract. **Fix:** owner-approved one-line amendment of W7 citing `b859abf` (invariant amendments are owner-gated).

### WRITE-5 · `[correctness]` · PLAUSIBLE (design challenge) — retrying `values.append` on HTTP 503 can double-write within a single request

`sheets.js:54` — `isTransientAppendError` treats 503 as guaranteed-pre-commit and retries the non-idempotent append; a 503 returned *after* Google committed (edge-timeout) duplicates the rows inside one request, where neither the write_id guard nor the pre-computed composite dedupe can help. Note: this classification is deliberately pinned (`test/unit.test.js:363-367`) — this is a challenge to the assumption, not a regression. **Fix sketch:** drop 503 from the retryable set (treat like 500), or re-read composite keys before each retry attempt.

### WRITE-6 · `[polish]` · CONFIRMED (code) — malformed truthy `test_mode` values silently go LIVE

`index.js:642-644` — `test_mode: 1`, `"yes"`, `"TRUE "` all coerce to live-write. W2 makes *absent* = live explicit, but a present, truthy, malformed value writing live is fail-unsafe. **Fix sketch:** accept only `true`/`'true'`/`false`/`'false'`/absent; 400 otherwise. Touches the critical-behaviours list → owner sign-off required despite being small.

### Server — verified clean

Undo read-back is genuinely live (uncached `getSheetRowsRaw`; TTL cache explicitly excludes it) with correct row math, 409-before-delete, tab restriction, span matching. `/api/log-workout` proof fields and idempotency choreography correct on every branch (incl. partial-effort and post-commit failure paths — `completeWrite` is never followed by `failWrite` after commit). In-process idempotency concurrency safe (fully synchronous store); corrupt-file and persist-failure degradation safe and pinned. `verify-range` clean.

---

## Client trust loop — `src/app/app.js`, `src/app/coach-conversation.js`

### CLIENT-1 · `[trust-critical]` · CONFIRMED (code) — Undo on a stale review card deletes the wrong (newest) write

`src/app/coach-conversation.js:381-389` (every card's Undo → `window.atlasUndoLastWrite()`), `src/app/app.js:6762-6796` (`handleUndoLastWrite` always operates on the global `lastWrite`), `src/app/styles.css:1734-1736` (saved cards permanently show "✓ Saved · Undo").

Scenario: mid-workout save A → keep training → closeout save B. Scroll up, tap Undo on card A → the handler reads `lastWrite` = B → read-back verifies B's session_id (passes — W5 is satisfied, from the server's view this is a legitimate undo of B) → **workout B's rows are deleted** while the UI user believes A was undone; the "Undone" label lands on the newest card via `currentReview`.

**Fix sketch:** bind the write identity to the card — in `markReviewSaved`, capture `{log_appended_range, session_id}` onto the card and have its Undo call a parameterized undo that refuses with a friendly message when the bound identity no longer matches `lastWrite`; or strip `.rv-undo` from all other `.done` cards whenever a new write confirms.

### CLIENT-2 · `[correctness]` · CONFIRMED by auditor (code) — user edits to previewed rows are silently reverted if another set is logged before the next closeout

`src/app/app.js:5245` (`emitSetLogged` unconditionally wipes `setsTableBody`) vs `:5593-5599` (closeout's preserve-edits guard only survives while the table is non-empty). Edits are never synced back into `sessionLog`; the next closeout repopulates from the unedited buffer. Scenario: "done" → Edit → fix 315→325 → log one more exercise → "done" → card shows 315 again; approving writes the row the lifter already corrected. Preview↔write parity holds, but user intent is silently discarded.

**Fix sketch:** in `emitSetLogged`, if the table holds staged closeout rows, rebuild `sessionLog` from current table content before wiping, then append the new set.

### CLIENT-3 · `[correctness]` · PLAUSIBLE — no staleness guard on `pendingWrite`: an out-of-order dry-run response overwrites a newer preview and its review card

`src/app/app.js:6325/6357/6402` (unconditional `pendingWrite = …` after `await`; dry-runs are transport-retried, widening the window) + `coach-conversation.js:1433-1443` (new preview replaces the single unsaved card). Scenario: "done" (slow/retried) → log one more set → "done" (fast, card renders with the extra set) → the stale first response lands last, `pendingWrite` and the card silently lose the last exercise. **Fix sketch:** monotonic flow token (`++previewFlowSeq` at submit; bail before assignment/render if stale). *If not fixed before PR-11, this becomes a required test in the PR-11 store migration.*

### CLIENT-4 · `[correctness]` · PLAUSIBLE — screenshot-with-editor-rows save can write split dates across tabs

`src/app/app.js:6080` (rows stamped with auto-filled today) + `:6315-6316` (top-level date blank → server resolves screenshot date) + `index.js:3628-3634` (row-level `date_clean` wins for Log rows; resolved date feeds Effort). Result: Log rows dated today, Effort row dated the screenshot date, one session — permanent cross-tab inconsistency. The closeout and compiled paths are already protected; only this direct path is not. **Fix sketch:** blank `date_clean` in the non-closeout screenshot branch when the owner didn't enter a date, mirroring `compileDate = ''`.

### CLIENT-5 · `[housekeeping]` · CONFIRMED — the documented stale-effort-card neutralization registry is dead code

`src/app/app.js:3683-3696` — `registerEffortCardCleanup` has zero callers; `runEffortCardCleanups()` is always a no-op; actual protection is solely the `#approve-btn` disabled-state mirror (which holds). Delete the scaffold or wire the review card's Save into it.

### Client — verified clean

Approve double-submit (in-flight flag + synchronous disable + server write_id); write_id reuse semantics on retry; proof-field validation fail-closed on both dry-run and live (pinned by `trustLoopProof.test.js`); preview invalidation on any form input; undo/verify payload contract matches the server post-`b859abf`; screenshot upload always advances to preview (approve stays gated); displayBlockNormalizer fails closed; review-card grouping can't hide a row (server guarantees non-empty lift_code); flightRecorder is passive on write paths.

---

## Session state / coach flow — `src/app/*`, `services/sessionPlanExecutor.js`, `services/sessionCloseout.js`

### SESS-1 · `[correctness]` · CONFIRMED by auditor (code) — `handleSetLogged` announces from an emit-time snapshot after up to ~9 s of awaits; concurrent handlers interleave

`src/app/coach-conversation.js:1344-1414` (+ detail built at `src/app/app.js:5216-5239`). Two quick logs: the slow first handler resumes after the fast second and announces a stale "next up: B" *after* B was logged (and can reset the composer placeholder to B, or land a stale next-up after closeout). **Fix sketch:** before announcing/setting the placeholder, re-derive from live state (reject `nextEx` already in `getSessionCompleted()`), or carry an emit sequence number and bail when a newer event has dispatched.

### SESS-2 · `[correctness]` · CONFIRMED (code) — resume-after-reload restores the advanced cursor but drops `pendingSubstitution`, stranding a declared swap

`src/app/app.js:4638-4645` — snapshot payload is `{sessionLog, sessionCompleted, activePlannedSession, sessionId}`; the two-part swap state (cursor advanced now + deferred slot replacement in `pendingSubstitution`) loses its second half on reload. Scenario: "leg press is taken" → suggestion accepted → phone locks → resume → log "hack squat 180 10/2" → becomes an off-plan insert; Leg Press stays pending forever; coach answers "1 still on your list: Leg Press"; closeout never fires. **Fix sketch:** include `pendingSubstitution` in the snapshot and restore it defensively.

### SESS-3 · `[correctness]` · CONFIRMED (code) — `closeoutAnnounced` stays latched when the plan is re-opened mid-session; the second completion never gets the session-close prompt

`src/app/coach-conversation.js:1141-1145` (reset only on `atlas:session-reset`; set at 1379); plan re-opened without reset by `applyProposedPlanEdit` `add_exercises`/`replace_plan` (`src/app/app.js:2650-2679`) and re-engaged Coach's Pick. Scenario: finish plan → closeout fires → "add hammer curls" → log them → the gate swallows the second closeout; no "done to save" nudge. **Fix sketch:** reset the flag in the `atlas:plan-mutated` listener when pending work exists again, and in `typeSuggestedWorkout` beside the `lastAnnouncedNextUp` reset.

### SESS-4 · `[correctness]` · CONFIRMED by auditor (code) — the declared-swap skip guard exists only in `currentPlannedExercise`; the pin, `firstUnloggedPlannedLift`, and the bare-set attach target still read the swapped-out lift

Guard at `src/app/app.js:5044-5051`; unguarded consumers at `:4980-4988`, `:4960-4962`, parse context at `:4080/4321/4336`; and `emitSetLogged` (`:5175-5180`) clears `pendingSubstitution` even when `applySessionSubstitution` no-ops. Scenario: after "leg press is taken", the pin still shows Leg Press (split-brain), and a bare "180 10/2 x3" attaches to **Leg Press**, consumes the swap as a no-op, and the preview carries the wrong exercise name (visible pre-save, but intent was silently rerouted). **Fix sketch:** make `firstUnloggedPlannedLift()` and the pin skip `pendingSubstitution.prescribed`; only clear `pendingSubstitution` when the substitution actually applied.

### SESS-5 · `[correctness]` · PLAUSIBLE — `resolveCompletedIdentity`'s raw-name tier lacks exact-before-substring ordering and ambiguity refusal

`src/app/app.js:5138-5144` — one `find` pass with bidirectional `includes`: with plan [Incline Bench Press, Bench Press] and no lift codes (chat-created plan, catalog not loaded), logging "bench press 185 5/2" completes **Incline Bench Press**. `activeSession.findMatchIndex` (`src/app/activeSession.js:78-98`) was hardened to refuse exactly this; the completion resolver wasn't. **Fix sketch:** exact-name scan first; substring tier only on a unique match; fall back to raw name on ambiguity.

### SESS-6 · `[polish]` · PLAUSIBLE — `currentPlanForChat`'s fallback ignores the `coachSuggestionEngaged` gate

`src/app/app.js:5866-5878` — freestyle chat can be answered from an unengaged suggested plan (the chat-context twin of the B4 "freestyle must not auto-guide" fix); internally inconsistent with the gated `plan_completed` sibling. Possibly deliberate for pre-engagement "what's the plan today?" — decide, then either gate the fallback or tag it `suggested: true`.

### SESS-7 · `[housekeeping]` — concurrent `handleSetLogged` runs push `chatTurns` out of submission order

`src/app/coach-conversation.js:1177` vs `:1238/1302` — two quick logs record user₁, user₂, atlas₂, atlas₁; the compile fallback and chat context see a scrambled transcript. Reserve the turn slot synchronously.

### Session — verified clean / already filed

Stale `current_exercise` to the substitute endpoint (Step 379) fixed and pinned; repeated closeout announcement fixed (`d48297e`); plan-only snapshot auto-resume fixed (`2a31179`); `sessionSavedLog` snapshot gap and `pendingSubstitution` catalog-coverage gaps already in `BACKLOG.md`.

---

## Infrastructure — CI, service worker, secrets, routes

### INFRA-1 · `[correctness]` · CONFIRMED (empirical) — the CI build-drift guard is blind to untracked and orphaned files in `public/`

`.github/workflows/ci.yml:71` + `vite.config.js:78` (`emptyOutDir:false`) — `git diff --exit-code -- public/` never reports untracked files (probe verified: created `public/__drift_probe.js`, guard exited 0), and the build never deletes stale ones. Scenario: PR adds `src/app/newWidget.js` + rebuilt `index.html` but forgets to commit `public/newWidget.js` → CI green → Render (no build step at deploy) serves committed `public/` → prod 404 breaks the page. Symmetric: a file deleted from `src/app/` is served forever. **Fix sketch:** `test -z "$(git status --porcelain -- public/)"` after the build, plus a file-list parity test of `src/app/` vs `public/`.

### INFRA-2 · `[correctness]` · CONFIRMED (empirical) — `sw.js` SHELL_ASSETS omits `coachVoiceTemplates.js` and `hybridCompare.js`, which `index.html` loads

`src/app/sw.js:13-34` vs `src/app/index.html:595-596`. After a cache-name bump deploy, an offline gym open loads the shell but both scripts 404; `coach-conversation.js:906/1022/1458` calls bare `coachVoiceTemplates.…` → ReferenceError on the set-reaction/fallback render path. **Fix sketch:** add both to `SHELL_ASSETS`, bump `v113→v114` + `ATLAS_SHELL_BUILD`, rebuild; add a test asserting every `<script src>` in `index.html` ⊆ `SHELL_ASSETS`.

### INFRA-3 · `[correctness]` · CONFIRMED (empirical) — the secret-scan CI job false-positives on two committed test files

`scripts/check-changed-files-for-secrets.js` `private-key-block` rule flags the stub `GOOGLE_PRIVATE_KEY` literals in `test/coach-ask-endpoint.test.js:10` and `test/recommendation-preview-endpoint.test.js:12` (verified by executing the scanner). Any PR touching either file goes red on a clean change — training "just override it" habits on the leak guard. **Fix sketch:** build the stubs at runtime via string-join (as `test/secret-scan.test.js` itself does).

### INFRA-4 · `[housekeeping]` — the secret scanner exempts `*.env` files and misses raw OpenAI tokens

`scripts/check-changed-files-for-secrets.js:19` — a force-added committed `.env` with live keys sails through (the `.env.example` allowlist already covers the legitimate file, so the exemption is unnecessary); raw `sk-proj-…` tokens are only caught in the `OPENAI_API_KEY=` assignment form, unlike the Gemini/Anthropic raw-token rules.

### INFRA-5 · `[polish]` — async-route crash safety is convention-only

~67 bare `async (req,res)` handlers, no wrapper, no `process.on('unhandledRejection')`. An await-outside-try scan shows the seam is clean **today** (all 21 such awaits are `.catch()`-guarded or inside guarded helpers) — but one future unguarded `await` in a 4,700-line file kills the process mid-request (Node ≥15), including mid-write. **Fix sketch:** a last-resort `unhandledRejection` logger and/or a tiny `asyncHandler` wrapper routing to the existing error middleware.

### Infra — verified clean (empirical)

Route registry exact-matches reality: 67/67 routes in both directions, methods and writeCapable flags correct; auth is a single unbypassable `app.use('/api', requireApiKey)` with SHA-256 `timingSafeEqual` and boot-refusal without a key; public surface is only `/`, `/health`, `/routes`, `/version`, static `/app`. No real credentials anywhere in git-tracked files. `src/app` ↔ `public` byte-identical today; direct edits to tracked `public/` files are caught. CI runs the full unit suite, lint, build+guard, secret scan on every PR; Playwright path filter covers everything e2e can exercise. Error middleware maps body-parser/multer errors correctly and suppresses 500 detail in production.

---

## Cross-cutting observations

1. **The composite-key dedupe is presented as the write path's second line of defense, but it is keyed on `session_id` — every scenario where the session id differs between attempts (WRITE-2) or the range is unknown (WRITE-1) voids it.** Worth one deliberate design pass on "what guarantees survive a crash at each point in the write sequence" when PR-04's follow-ups are scheduled.
2. **The parser's failure mode asymmetry:** unknown exercises fail safe (ask/flag), but *mis-known* exercises (PARSE-1/2/3/5) fail silent. The single most valuable parser hardening principle: any token the winning grammar didn't consume, and any name-adjacent qualifier it discarded, must downgrade the parse to a clarification.
3. **Several session-state findings (SESS-1/2/4) are one-representation-updated-not-the-other bugs — the exact family Steps 372–379 fixed.** PR-10 (single state store) is the structural cure; these findings should become its acceptance tests if not fixed earlier.
4. Statute check on the audit doc itself: this file is **generated evidence, reference-only** — it does not become an execution queue. The queue lives in `BACKLOG.md` (updated in this PR).
