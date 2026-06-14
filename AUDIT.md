# Atlas — Overnight Full Audit (read-only)

**Date:** 2026-06-14
**Branch:** `claude/code-audit-improvements-snpfi2`
**Mode:** Report only. No application code was changed. The only file added is this `AUDIT.md`.

## How this was done

- Five parallel read-only passes over the codebase: (1) core server & write paths, (2) parser & analytics, (3) LLM coach & vision, (4) frontend & PWA, (5) rules, tests, CI & hygiene.
- A **live UI run-through**: the real frontend (`public/`) was served via the existing `tests/e2e/static-server.js`, driven with Playwright across **desktop (1280×900)** and **mobile (iPhone 13, 390×844)**, with every `/api` endpoint mocked with realistic data. 26 full-page screenshots were captured across Coach, Today, Trends, History, Body, and Settings, plus console/page-error and layout-overflow capture. Screenshots are **not committed** (per the `CLAUDE.md` "never commit screenshots" rule) — they were sent to the owner separately.
- The highest-severity code findings were independently re-verified by reading the exact lines; those are marked **✓ verified**.

## Test status

`npm test` → **241 passing**. (In this sandbox, 5 suites that load `index.js` fail only because `dotenv` wasn't installed at the time of that run; under `npm ci` they pass. See **CI-2**.) No test was failing for a real code reason.

## Severity legend

- **Critical** — can cause data loss / duplicate writes / wrong numbers written to the permanent record.
- **High** — real bug or security gap a user/operator would hit; or a broken UI surface.
- **Medium** — correctness/robustness/maintainability issue with limited blast radius.
- **Low** — polish, waste, cosmetics.

> Triage note: this is a single-user app whose source of truth is Google Sheets and whose trust loop (preview → approve → write) is well built. Several "Critical/High" items are latent (they need a retry, a concurrent request, or unusual input to fire). None of them indicate the trust loop is currently bypassable. Recommended fix order is at the bottom.

---

## Critical

### CR-1 — `failWrite` deletes the idempotency record, so a post-append exception lets a retry double-write ✓ verified
`services/idempotency.js:82-91`, `index.js:1926-1937` (complete-workout), `index.js` log-workout path.
`completeWrite` runs only **after** the full response body is built. If anything between the successful `appendRows(...)` and `completeWrite(...)` throws (quality-score computation, etc.), the outer `catch` calls `failWrite`, which **deletes** the record (`writeRecords.delete`, line 89). The rows are already on the sheet, but the idempotency key is now gone, so a client retry with the same `write_id` writes them **again**.
**Fix:** on `failWrite`, mark the record `status:'failed'` instead of deleting, and have `beginWrite` treat `failed` as retryable; and/or record the write as completed the instant `appendRows` resolves, before any further logic can throw.

### CR-2 — Effort tab has no duplicate guard on the live append ✓ verified
`index.js:1868-1889` (dedup) vs `index.js:1930` (append).
The composite-key duplicate guard (`getLogCompositeKeys`) only covers `Log_Cleaned`. The `Effort` append at line 1930 runs **unconditionally**. The only protection is `write_id` idempotency — which is optional (see HI-1) and discardable (CR-1). A retry without `write_id`, or a retry after CR-1's record loss, appends a **second effort row** for the same `session_id`. Auto-generated session IDs increment, so the `duplicateSession` pre-check (1822-1827) doesn't catch it.
**Fix:** guard the Effort append against an existing `session_id` in the Effort tab (mirror the Log dedup), or require `write_id` on this endpoint.

---

## High

### HI-1 — `write_id` is optional on most write paths, silently disabling idempotency ✓ verified
`services/idempotency.js:20-23` (`beginWrite(undefined)` → `{enabled:false}`), used by `/api/log-workout`, `/api/complete-workout`, `/api/bodyweight`, `/api/log-workout/undo-last`.
`CLAUDE.md` states every write path is "`write_id`-idempotent," but that only holds when the client sends one. A retry without `write_id` writes twice. Notably `/api/coaching-notes` (`index.js:1091`) **does** require it — so the contract is already inconsistent.
**Fix:** require `write_id` (400 if absent) on all write endpoints, matching the coaching-notes contract.

### HI-2 — CSP blocks all inline styles → hidden scaffolding becomes visible & dynamic widths break ✓ verified (live)
`public/index.html:5` (`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; connect-src 'self'">`).
There is no `style-src 'unsafe-inline'`, so the browser **blocks every inline `style=` attribute** — both JS-applied (`el(..., { style })` → `setAttribute('style', …)`) and static ones in the HTML. Observed live (console: *"Applying inline style violates… default-src 'self'… The action has been blocked"*, ×N on every page):
- **`index.html:284`** `<div style="display:none">` wrapping the legacy progress/detail forms is un-hidden → **two empty boxes render at the top of the Trends screen.** (Seen in the mobile + desktop Trends screenshots.)
- **`public/app.js:839`** recovery bars use `style="width:${pct}%"` → the "Recovery by movement" fill widths never apply.
- **`app.js:529, 900, 961, 1274, 1596, 1709`** inline `font-size`/`margin`/`white-space:pre-wrap` are dropped (e.g. the weekly-report `<pre>` loses its wrapping).
SVG charts are unaffected (they use presentation attributes, not `style`), which is why the Body bodyweight chart renders correctly.
**Fix (pick one):** (a) add `style-src 'self' 'unsafe-inline'` to the CSP meta — quickest, but loosens CSP; or (b, preferred) move the handful of inline styles to CSS classes (`.hidden { display:none }`, a `--pct` custom property or width utility for the recovery fill) and keep CSP strict. Either way, re-verify the recovery bars and the hidden legacy forms after the change.

### HI-3 — `parseWeightRepsSets` has no set-count cap (unbounded allocation) ✓ verified
`services/workoutTextParser.js:494-501`.
Sibling parsers cap at `> 10` (e.g. line 488), but `parseWeightRepsSets` (`"225 x 5 x N"`) does `Array.from({ length: setCount })` with no bound. Input like `225 x 5 x 100000` allocates 100k set objects.
**Fix:** add the same `if (setCount > 10) return null;` guard the sibling parsers use.

### HI-4 — Numeric/Excel-serial dates produce garbage (the Excel branch is unreachable) ✓ verified
`services/validation.js:39-51`. Confirmed: `new Date("45000")` returns a **year-45000** date (not `NaN`), so the generic `new Date(text)` fallback at line 39 always wins and the Excel-epoch conversion at line 44 is dead. A numeric serial date silently becomes a wrong ISO date.
**Fix:** check `typeof value === 'number'` (Excel-serial branch) **before** the generic `new Date(text)` fallback.

### HI-5 — Service worker precache uses absolute `/app/...` paths; one 404 voids the whole offline cache
`public/sw.js:12-24`, registered at `public/app.js:3723`.
`cache.addAll(SHELL_ASSETS)` rejects the entire install if any single URL 404s, and the registration `.catch(() => {})` swallows the failure silently. Combined with the cache name only bumping on `CACHE_NAME` change (`'atlas-shell-v2'`), a stale or half-updated shell can persist offline.
**Fix:** bump `CACHE_NAME` on every asset-affecting deploy (ideally a build hash); switch precache to per-asset `cache.add` in a loop so one missing icon doesn't void the shell; surface install failures somewhere visible.

### HI-6 — Secret scanner exists but never runs in CI or a hook ✓ verified
`scripts/check-changed-files-for-secrets.js`, `package.json:13` (`scan:secrets`), `.github/workflows/*.yml`.
There is a full secret scanner and a unit test for it, but **no workflow step and no git hook invokes it** (grep of both workflows + absence of husky confirms). The "Security — hard stops" intent in `CLAUDE.md` is therefore unenforced by automation.
**Fix:** add a `Secret scan` step to `ci.yml` on `pull_request` (`npm run scan:secrets`), and/or a pre-commit hook.

### HI-7 — `lint` script hand-maintains a file list missing ~17 live source files ✓ verified
`package.json:9`.
The `lint` script `node --check`s a hardcoded list that omits the entire recommendation pipeline and more: `services/recommendationPolicy.js`, `recommendationPipeline.js`, `recommendationConstraints.js`, `recommendationHistoryAdapter.js`, `autoregulation.js`, `coachBrain.js`, `coachExplanationPolicy.js`, `liftRole.js`, `sessionId.js`, `trainingGoalClassifier.js`, `trainingKnowledge.js`, `trainingKnowledgeCards.js`, `trainingQuestionClassifier.js`, `trainingSME.js`, `workoutDisplayFormatter.js`, `config/routes.js`, `config/columns.js`. A syntax error in any of these passes CI lint silently.
**Fix:** replace the manual list with a glob (e.g. find all `*.js` outside `node_modules`) or adopt ESLint so new files are covered automatically.

### HI-8 — `recommendNextSet` "stable reps over two sessions" actually compares two sets ✓ verified
`services/analytics.js:449-455`.
The progression trigger uses `priorSet = lastSets[length-2]` (the second-to-last **set**, usually the same session) but the reasoning string claims "stable reps over two **sessions**." A single session with two equal-rep sets at RIR ≥ 2 triggers a "high confidence" weight increase recommendation.
**Fix:** compare best sets across the last two **distinct `session_id`s**, not adjacent sets.

---

## Medium

### ME-1 — Frontend surfaces raw developer error strings to the user ✓ verified (live)
History screen rendered literally **`(exercises || []).filter is not a function`** when the data shape was unexpected. Root cause is the `err.message`-into-DOM pattern across many handlers (`public/app.js:387, 1306, 1352, 1378, 1398, 1423, 1450, 1497, 1530, 1567, 1729, 1783, 1837, 1875`; `public/chat.js:220, 277, 297, 319`). These are `innerHTML`/text sinks fed `json.message || json.error`.
**Fix:** wrap section renderers so failures show friendly copy ("Couldn't load recent sessions — pull to retry"), guard array shapes before `.filter`, and route through the existing safe `el()`/`setStatus()` text-node helpers instead of `innerHTML`.

### ME-2 — Tables render the literal string "undefined" for missing fields ✓ verified (live)
The Today → **Watchouts** table printed `undefined` in the LAST BEST WEIGHT and SINCE columns. The generic `renderTable` (`app.js:39-45`) correctly coalesces null/undefined to `''`, but this table is built by hand without that guard.
**Fix:** coalesce missing cell values to `'—'` in the bespoke table builders (search for table construction outside `renderTable`).

### ME-3 — Sections fail independently and can display contradictory states ✓ verified (live)
On Today, the empty-state coaching copy *"Log a few sessions and Atlas can start suggesting what to train"* rendered **alongside** "48 TOTAL SESSIONS," because the pick/readiness endpoint returned empty while the summary endpoint populated. Each glance-card fetches independently with no coordinated empty/loaded state.
**Fix:** derive the top-of-screen empty-state from the same signal the populated cards use (e.g. total sessions), so the page doesn't tell the user they have no history while showing 48 sessions.

### ME-4 — Inline `volume_calc` from the client is trusted when present
`index.js:226-231` (`normalizeLogRowObject`).
`volume_calc`/`volume` is recomputed only when empty; a client-supplied value is written verbatim, so column 12 can disagree with `weight × reps` and corrupt the analytics that read it.
**Fix:** always recompute `volume_calc = weight * reps` server-side; never trust a client-supplied volume.

### ME-5 — Unbounded request body on `/api/complete-workout` ✓ verified
`index.js:1755-1772`. `log_rows_json` is `JSON.parse`d with no length/element cap (multer's `fileSize` only caps the image, not text fields). A multi-megabyte array would be enriched/mapped row-by-row.
**Fix:** reject `parsedLogRows.length` over a sane cap (e.g. 200) and set multer `limits.fieldSize`.

### ME-6 — In-memory rate limiter never prunes; key is spoofable
`middleware.js:65-99`, `index.js:108` (`trust proxy: 1`).
The `hits` Map grows one entry per `name:ip` and is only overwritten on a repeat hit — a slow unbounded leak. With `trust proxy:1`, the limiter key comes from `X-Forwarded-For`; if the app is ever reachable without exactly one trusted proxy hop, a client rotates the header to bypass all limits (including the vision-upload limiter that guards paid LLM calls).
**Fix:** periodically prune entries whose `resetAt < now` (or use a bounded LRU); confirm the deploy always has exactly one proxy hop.

### ME-7 — `detectStalls` flags rep/volume progress as a stall, driving deloads
`services/analytics.js:570-585`.
Stall detection uses only `best_weight` per session, so adding reps at the same weight (legitimate progression) reads as "stalled" and feeds `suggestDeloads` (−10%).
**Fix:** incorporate reps/volume or estimated-1RM trend, not weight alone.

### ME-8 — `buildWeeklyReport` zeroes out when given object-shaped rows
`services/analytics.js:1599-1664`.
It indexes rows positionally (`row[7]`, `row[8]`, …) after normalizing only the date field. If passed the object rows used elsewhere in the module, volume/top-exercises/PRs silently become 0/empty.
**Fix:** normalize rows up front like the other builders, or branch all field access on array vs object.

### ME-9 — LLM `propose_edit` numbers reach the preview with structure-only validation
`services/coach.js:280-287, 426-427`; consumed by the chat route.
`isValidEditSchema` checks only `action` + integer `index ≥ 0`; the `weight`/`reps`/`rir` in an `add_set`/`update_set` proposal are whatever the model emitted, with no finite/bounds check server-side (the comment defers bounds to the client). It's the one place a model can inject numbers into a mutation proposal (still gated by user approval + re-parse on write).
**Fix:** validate `weight`/`reps`/`rir`, when present, are finite and within the rule-engine bounds before returning `propose_edit`.

### ME-10 — Vision `ATLAS_LLM_MODEL` is ignored on the default (OpenAI) provider
`services/vision.js:39-66, 99`.
`getProviderConfig` reads `ATLAS_LLM_MODEL` only for Gemini; the OpenAI branch hardcodes `model: 'gpt-4.1-mini'`. An operator who sets `ATLAS_LLM_MODEL` expecting it to apply is silently ignored, and the call breaks if that model id is ever retired.
**Fix:** honor `ATLAS_LLM_MODEL` in the OpenAI branch with a documented default; pass `config.model` into the call.

### ME-11 — Vision provider calls don't request JSON mode and have no timeout
`services/vision.js:98-150`.
Neither provider sets structured/JSON output (`response_format`/`responseMimeType`), relying entirely on prompt text + `JSON.parse`; the OpenAI path doesn't even strip code fences (Gemini does). And unlike the coach path (8s `AbortController`), vision calls have no timeout, so a hung provider blocks the request.
**Fix:** enable JSON mode (ideally a schema) on both providers, strip fences defensively, and add an abort timeout to both vision calls.

### ME-12 — `dotenv` is a hard `require` at module load, coupling tests to it
`index.js:1`. Five suites can't load the app if `dotenv` is absent though it's only a local-`.env` convenience (Render injects env directly).
**Fix:** `try { require('dotenv').config(); } catch {}`.

### ME-13 — Two safety/validation rules are tested but never wired into production
`rules/safetyRules.js:102` (`rirDrift`), `rules/validationRules.js:69` (`checkE1rmJump`).
`evaluateSessionSafety` (the only orchestrator `index.js` calls) runs `rirCaution`/`junkRepGuard`/`painFlag` but **not** `rirDrift`; `checkE1rmJump` (the >15% typo-guard) is never called from `index.js`. Both pass their unit tests, giving false confidence that the warnings ship.
**Fix:** wire them into the log-workout preview (they need history rows), or delete them so coverage reflects reality.

---

## Low (selected; full list available on request)

- **LO-1 — Undo read-back indexes the whole tab by arithmetic** (`index.js:2337-2365`): `dataIndex = r - 2` assumes a single header row and no inserts/deletes above the target; session-ownership is checked but not row identity. Prefer reading the exact A1 range (as verify-range does).
- **LO-2 — Inconsistent response envelope / error leakage** (`index.js:659, 759, 1497, 1758, …`): several handlers bypass `standardSuccess`/`standardError` (no `requestId`/`duration_ms`, `{error}` vs `{message,details}`), and most 500s pass `error.message` as `details` without the production gate that only `/api/log-workout` applies. Route all responses through `response.js`; gate internal error text on `NODE_ENV` uniformly.
- **LO-3 — Dead frontend code:** `loadTodaysPlan()` (`app.js:1267-1308`) targets a non-existent `#todays-plan`; a full client-side fallback parser (`app.js:2086-2152`) duplicates the "sacred" backend parser and could drift on `225 5/2`; duplicated greeting logic in `coach-conversation.js:542` vs `nav.js:443` (disagree on the evening cutoff, 17 vs 18).
- **LO-4 — Dead imports/heuristics:** `index.js` imports `buildProgressSummary`/`buildExerciseDetail`/`buildMuscleGroupReadiness`/`buildWeeklyReport` but delegates to `trainingStore`; `analytics.js:654` `previewTestRows` hardcodes `/session-2026/` (breaks in 2027); `coach.js` has three near-identical proposal/back-scan parsers.
- **LO-5 — `getSheetRows(tab, maxRows)` returns the head, not the tail** (`sheets.js:117` `slice(0, maxRows)`), unlike `getRecentRows`. Latent footgun (all current callers use the default `Infinity`).
- **LO-6 — `createTtlCache` has no size bound** (`services/cache.js`): entries written once and never re-read are never evicted. Tiny for one user, unbounded in principle.
- **LO-7 — `coach-conversation.js` writes via `/api/coaching-notes`** (`coach-conversation.js:671`), contradicting the file's "never writes" header/`CLAUDE.md`. It's user-approved + idempotent, so safe — but either the doc should carve this out or the note-save should move to `app.js`.
- **LO-8 — PWA polish:** `manifest.json:15,22` mark both icons `"any maskable"` (maskable crop risk); desktop wastes the wide canvas (acceptable for a phone-first PWA); `chat.js` MAX_BUBBLES trims a shared thread and can detach a live button reference (`chat.js:21,35`).
- **LO-9 — Misc parser/format edges:** `formatSetLine` rejects bodyweight when passed `weight:0` vs `null` (`workoutDisplayFormatter.js:23`); `normalizeDurationString` accepts `mm:ss` with minutes > 59 inconsistently (`duration.js:23-30`); `parseEffortCapture` only captures location when `peak hr` is present (`workoutTextParser.js:287`); `generateLiftCode` initialisms can collide and merge two lifts' analytics (`exerciseEnrichment.js:45-49`).
- **LO-10 — `redundant condition`** `services/recommendationPolicy.js:143`: `if (!previousPerformance.completed && previousPerformance.completed === false)` — the first clause is noise.
- **LO-11 — No `timeout-minutes` on the monitoring/smoke CI jobs** (`.github/workflows/monitoring.yml`): a hung fetch can run to GitHub's 6h default.

---

## Verified strengths (no action needed)

- **Trust loop is solid.** Every preview sends `test_mode=true`; the approve button is gated on a server-proven `previewProof` and re-validated on click; `writeInFlight` guards double-submit; narration layers (`coach-conversation.js`, `chat.js`) never call a workout-write path — they only `.click()` the gated approve button or hit read-only `/api/coach/*`.
- **Auth** uses a constant-time SHA-256 compare with no key logging (`middleware.js:23-28`).
- **Dry-run/live proof fields** (`sheet_written:false`/`no_write_confirmed:true` vs `sheet_write:'success'`/`log_rows_written>0`) are present on all branches; `test_mode` absent = live write holds (`isTestModeEnabled` only matches the string `'true'`).
- **LLM guarantees hold:** the model never writes and never invents the deterministic numbers; `getProviderConfig` throws (no silent fallback) when `gemini` has no key; `sanitizeFacts`/`sanitizeChatContext`/`sanitizePlanFacts` whitelist fields; `average_hr` and `peak_hr` are kept distinct end-to-end (the vision prompt forbids copying one into the other, and `index.js:477-499` validates them separately).
- **Idempotency `beginWrite`** deep-copies nested `response`/`metadata` before returning, preventing store corruption by callers.
- **`.gitignore`** is thorough (`.env*` with `!.env.example`, `*.key`, `*.pem`, `credentials*.json`, `backups/`, `.claude/`); the backup script uses a **read-only** Sheets scope.
- **UI craft:** the Coach empty-state hero, the Body bodyweight SVG chart, Settings, and the card/glance system are clean, consistent, and genuinely stylish on both mobile and desktop. The dry-run safety note is clear and ever-present.

---

## Recommended fix order

1. **HI-2 (CSP inline styles)** — visible breakage today (leaked forms, dead recovery bars); cheap, high-visibility fix.
2. **CR-1 + CR-2 + HI-1** — close the Effort-tab double-write window: make `write_id` mandatory, stop deleting the record on failure, guard the Effort append. One small, focused PR.
3. **HI-6 + HI-7** — wire `scan:secrets` into CI and replace the hand-maintained lint list (security + silent-coverage gaps).
4. **HI-3, HI-4, HI-8, ME-7/ME-8** — parser/analytics correctness (wrong numbers / false deloads).
5. **ME-1, ME-2, ME-3** — frontend robustness so imperfect/partial data degrades to friendly copy, never raw errors or "undefined".
6. Sweep the Low list opportunistically (dead code, envelope consistency, PWA polish).

> Keep each as a tiny, single-concern PR per Invariant PR1. Nothing here should be batched into a "cleanup" mega-change.
