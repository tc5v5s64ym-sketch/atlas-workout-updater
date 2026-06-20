# AUDIT.md Medium/Low Triage — Current-State Verification (2026-06-20)

> **Type:** read-only current-state verification report (side-car lane). **No production code, parser, write-path, schema, or test was changed to produce this.**
>
> **Purpose:** `BACKLOG.md` (AUDIT.md reconciliation section) notes that the 2026-06-14 audit's **Medium ME-5/6/9/10/11/12** and **Low LO-1…LO-11** items have *no tracking record* — fixed-or-open is unknown. This report classifies each against current `main` with a file:line evidence anchor, exactly the "one read-only triage pass" that backlog item calls for.
>
> **Out of scope / already resolved (not re-triaged here):** ME-1/2/3 (tracked: "Phase 2 hardening"), ME-4 (✅ fixed), ME-7 (✅ Step 384), ME-8 (✅ fixed), ME-13 (already tracked in `BACKLOG.md`). All Critical/High items were already folded into `BACKLOG.md`.

## Verdict legend

| Verdict | Meaning |
|---|---|
| **STILL-LIVE** | The audited condition still exists in current `main`. |
| **PARTIAL** | Partially mitigated since the audit; a residual remains. |
| **BY-DESIGN** | Condition exists but is a consciously accepted trade-off for a single-owner app. |
| **NOT RE-VERIFIED** | Broad/cross-cutting; not exhaustively traced in this pass — carry forward as open. |

---

## Summary table

| Item | Verdict | One-line current state | Already tracked elsewhere? |
|---|---|---|---|
| ME-5 | STILL-LIVE | No length cap on `log_rows_json`; multer caps only `fileSize`. | No |
| ME-6 | STILL-LIVE | Rate-limiter `hits` Map never pruned; key still proxy-header-derived. | No |
| ME-9 | STILL-LIVE | `isValidEditSchema` validates shape only; weight/reps/rir unbounded server-side. | No |
| ME-10 | STILL-LIVE | OpenAI vision branch hardcodes `gpt-4.1-mini`; `ATLAS_LLM_MODEL` ignored there. | No |
| ME-11 | STILL-LIVE | No JSON mode and no timeout on either vision provider; OpenAI path doesn't strip fences. | No |
| ME-12 | STILL-LIVE (low) | `dotenv` still a hard `require` at `index.js:1`. | No |
| LO-1 | BY-DESIGN | Undo still uses `dataIndex = r - 2`; math verified correct for current sheet shape. | Partially (`AUDIT_2026-06-12.md`) |
| LO-2 | NOT RE-VERIFIED | Mixed response envelopes; not exhaustively traced this pass. | No |
| LO-3 | STILL-LIVE | Dead `loadTodaysPlan()`; greeting evening-cutoff mismatch (17 vs 18). | Partially (Phase 3) |
| LO-4 | STILL-LIVE | Dead imports in `index.js`; `previewTestRows` hardcodes `/session-2026/`. | Partially (Phase 3) |
| LO-5 | STILL-LIVE (latent) | `getSheetRows` returns head not tail; all callers use default `Infinity`. | No |
| LO-6 | STILL-LIVE (latent) | `createTtlCache` has no size bound. | No |
| LO-7 | STILL-LIVE (cosmetic) | `coach-conversation.js` POSTs `/api/coaching-notes` despite "never writes" header. | No |
| LO-8 | STILL-LIVE | Both manifest icons `"any maskable"`; `chat.js` trims a shared thread. | No |
| LO-9 | PARTIAL | (a) `weight:0` now renders, not rejected; (b)(c)(d) residuals remain. | (d) partially (BACKLOG:109) |
| LO-10 | STILL-LIVE | Redundant `!completed && completed === false`. | Yes (Phase 3) |
| LO-11 | STILL-LIVE | No `timeout-minutes` on any of the 7 workflows. | No |

---

## Medium items

### ME-5 — Unbounded request body on `/api/complete-workout` — **STILL-LIVE**
`index.js:113-122` — multer `limits` sets only `fileSize: 10 * 1024 * 1024` (image); no `fieldSize`. `index.js:2261` `JSON.parse(formFields.log_rows_json)` with the only length guard being `parsedLogRows.length === 0` (`index.js:2272`); there is no upper cap. A large array is still enriched/mapped row-by-row. Matches the audit exactly.
**Recommendation:** reject `parsedLogRows.length` over a sane cap (e.g. 200) and set multer `limits.fieldSize`. Touches `index.js` (write-path-adjacent route — name in scope before editing).

### ME-6 — Rate limiter never prunes; key is spoofable — **STILL-LIVE**
`middleware.js:75-88` — `hits.get/set` with a per-key `resetAt`, but no `setInterval`/prune/LRU eviction anywhere (grep for `prune|LRU|setInterval` → none). The Map grows one entry per `name:ip` indefinitely. Key derivation still depends on the single-proxy-hop assumption (`trust proxy` config in `index.js`).
**Recommendation:** prune entries where `resetAt < now` (or bounded LRU); confirm the deploy always has exactly one trusted proxy hop. `middleware.js` is not a restricted file.

### ME-9 — `propose_edit` numbers reach preview with structure-only validation — **STILL-LIVE**
`services/coach.js:543-552` — `isValidEditSchema` checks only `action` and `Number.isInteger(index) && index >= 0`; `add_set` returns `true` unconditionally. The `weight`/`reps`/`rir` an `add_set`/`update_set` carries are never finiteness-/bounds-checked server-side; the comment (543-544) explicitly defers bounds to the client. Still gated downstream by user approval + write-path re-parse, so this is a defense-in-depth gap, not an open write hole.
**Recommendation:** validate `weight`/`reps`/`rir` (when present) are finite and within rule-engine bounds before returning `propose_edit`. **Trust-sensitive** (numbers into a mutation proposal) — owner-gated; `coach.js` change.

### ME-10 — Vision `ATLAS_LLM_MODEL` ignored on OpenAI provider — **STILL-LIVE**
`services/vision.js:99` hardcodes `model: 'gpt-4.1-mini'` in the OpenAI call; `ATLAS_LLM_MODEL` is read only into the Gemini `config.model` (`vision.js:51`, used at `:130`). An operator setting `ATLAS_LLM_MODEL` for OpenAI is silently ignored.
**Recommendation:** honor `ATLAS_LLM_MODEL` in the OpenAI branch with a documented default. Owner-gated (provider/model selection per `CLAUDE.md`).

### ME-11 — Vision calls: no JSON mode, no timeout — **STILL-LIVE**
`services/vision.js:98-109` (OpenAI) and `:129-135` (Gemini) — neither sets a structured/JSON output flag (`response_format` / `responseMimeType`), and neither wraps the call in an `AbortController`/timeout (contrast the coach path's 8s abort). The OpenAI path `JSON.parse`s `textOutput` directly (`:118`) without fence-stripping; only Gemini calls `stripJsonFences` (`:137`).
**Recommendation:** enable JSON mode on both, strip fences defensively on the OpenAI path, add an abort timeout to both. Owner-gated (vision provider behavior).

### ME-12 — `dotenv` hard `require` at module load — **STILL-LIVE (low)**
`index.js:1-2` — `const dotenv = require('dotenv'); dotenv.config();` with no `try/catch`. The full suite currently passes (deps installed), so this bites only when `dotenv` is absent.
**Recommendation:** `try { require('dotenv').config(); } catch {}`. Tiny `index.js` edit (line 1) — name in scope before editing.

---

## Low items

### LO-1 — Undo read-back indexes by arithmetic — **BY-DESIGN (accepted)**
`index.js:3077-3078` — `const dataIndex = r - 2; const row = allRows[dataIndex];` still present. **However** `docs/AUDIT_2026-06-12.md:33` independently verified the index math correct for the current single-header / append-only sheet shape, and undo reads via the uncached `getSheetRowsRaw`. The residual is robustness to manual inserts/deletes above the target row — a latent edge, not a live defect. Undo is a **critical behaviour** (owner-gated); no change recommended without owner direction.

### LO-2 — Inconsistent response envelope / error leakage — **NOT RE-VERIFIED**
The audit cited many handlers (`index.js:659, 759, 1497, 1758, …`) bypassing `standardSuccess`/`standardError`. This is a broad cross-cutting sweep that was **not exhaustively traced** in this pass. Carry forward as open; recommend a dedicated envelope-consistency audit before any fix.

### LO-3 — Dead frontend code + greeting mismatch — **STILL-LIVE** (partly tracked)
- `loadTodaysPlan()` is dead (`#todays-plan` removed from Today per `docs/TODAY_SCREEN_SPEC.md:135`) — **already tracked** under "Phase 3 dead-code cleanup" (`BACKLOG.md:195`, references `public/app.js:1341`).
- **Greeting cutoff mismatch CONFIRMED:** `public/nav.js:564` uses `h < 18 ? 'Afternoon' : 'Evening'` (evening starts 18:00) while `public/coach-conversation.js:1043` uses `h < 17 ? 'afternoon' : 'evening'` (evening starts 17:00). They disagree by one hour — **not** currently tracked.
- The client-side fallback parser the audit flagged (`app.js:2086-2152`) was not re-located precisely (line refs have shifted); flag for confirmation.
**Recommendation:** fold the greeting mismatch into `BACKLOG.md` as a `[polish]` one-liner (pick one cutoff). Frontend-only.

### LO-4 — Dead imports / dated heuristic — **STILL-LIVE** (partly tracked)
- `index.js:36-40` still imports `buildWeeklyReport`/`buildProgressSummary`/`buildExerciseDetail`/`buildMuscleGroupReadiness`; those names appear **only** on the import lines in `index.js` (no other usage) — dead imports. **Already tracked** as "stale imports in `index.js`" under Phase 3 (`BACKLOG.md:195`).
- `services/analytics.js:1007,1011` — `previewTestRows` hardcodes `/session-2026/i` in its test-row filter; this silently stops matching in 2027. **Not** currently tracked.
**Recommendation:** fold the `/session-2026/` date-fragility into `BACKLOG.md` (`[housekeeping]`); generalize to a `session-20\d\d` pattern or a `test`-marker-only filter.

### LO-5 — `getSheetRows` returns head, not tail — **STILL-LIVE (latent)**
`services/sheets.js:185` — `return Number.isFinite(maxRows) ? dataRows.slice(0, maxRows) : dataRows;` with `maxRows = Infinity` default (`:172`). Every current caller uses the default, so no live impact; the footgun is any future caller passing a finite `maxRows` expecting the most-recent rows.
**Recommendation:** document the head-vs-tail semantics at the function, or `slice(-maxRows)` if tail is the intended contract. Low priority.

### LO-6 — `createTtlCache` has no size bound — **STILL-LIVE (latent)**
`services/cache.js` — no `maxSize`/`maxEntries` bound exists (grep → none). Write-once-never-read entries are evicted only by TTL. Negligible for one user; unbounded in principle.
**Recommendation:** add an optional max-entries bound. Low priority.

### LO-7 — `coach-conversation.js` writes via `/api/coaching-notes` — **STILL-LIVE (cosmetic)**
`public/coach-conversation.js:7` header asserts the file "only narrates… never writes," yet `:1195` issues `api('/api/coaching-notes', { … })` (a POST). The write is user-approved + idempotent (so trust-safe), but the header/`CLAUDE.md` framing and the code disagree.
**Recommendation:** either carve out the note-save in the file header/`CLAUDE.md`, or relocate the save to `app.js`. Doc/architecture nit; no behavior change needed.

### LO-8 — PWA polish — **STILL-LIVE**
`public/manifest.json:16,22` — both icons declared `"purpose": "any maskable"` (maskable crop risk on the non-maskable asset). `public/chat.js:21` `MAX_BUBBLES = 12` and `:35` `while (thread.children.length > MAX_BUBBLES) thread.removeChild(thread.firstChild)` — trims the shared thread and can detach a live button reference, as audited.
**Recommendation:** provide a dedicated maskable icon (or split `any` vs `maskable`); guard the bubble-trim against removing a node holding a live handler. Low priority; frontend-only.

### LO-9 — Misc parser/format edges — **PARTIAL**
- **(a) `formatSetLine` bodyweight — CHANGED:** `services/workoutDisplayFormatter.js:23` now guards `if (weight == null)`, so `weight: 0` is **no longer rejected** — but it renders literally as `"0lbs …"`, which is an odd bodyweight display rather than a thrown error. Residual is cosmetic, not a rejection.
- **(b) `normalizeDurationString` mm:ss — STILL-LIVE:** `services/duration.js:28` (the `mm:ss` branch) validates `sec > 59` but does **not** cap minutes (`m < 0` only), while the `hh:mm:ss` branch (`:38`) caps `m > 59`. So `"75:30"` is accepted inconsistently.
- **(c) `parseEffortCapture` location — STILL-LIVE:** `services/workoutTextParser.js:354` anchors the location regex to `\bpeak\s*hr\s*\d+…\s+(.+)$`, so `location` is captured **only** when "peak hr" precedes it.
- **(d) `generateLiftCode` collision — PARTIAL:** within-batch collisions are now handled by `makeLiftCodeRegistry` suffixing (`services/exerciseEnrichment.js:29-39`; noted ✅ in `BACKLOG.md:109`), but the pure `generateLiftCode` (`:60`) initialism collision across sessions is unchanged — the same cross-session identity-merge risk already tracked as the SESSION_DESIGN AC5a "liftCode history-merge" item.
**Recommendation:** (b) cap minutes in the `mm:ss` branch; (c) capture location independently of `peak hr`; (a) optionally render bodyweight without `"0lbs"`. Each is a tiny, isolated service edit with a golden test.

### LO-10 — Redundant condition — **STILL-LIVE (already tracked)**
`services/recommendationPolicy.js:143` — `if (!previousPerformance.completed && previousPerformance.completed === false)`; the first clause is dead noise. **Already tracked** under "Phase 3 dead-code cleanup" (`BACKLOG.md:195`).

### LO-11 — No `timeout-minutes` on CI jobs — **STILL-LIVE (broader than audited)**
Grep for `timeout-minutes` across `.github/workflows/` → **no matches** in any of the 7 workflows (`ci.yml`, `claude-code-review.yml`, `codex-decision-desk.yml`, `labeler.yml`, `merge-card-check.yml`, `monitoring.yml`, plus `labels.yml`). A hung fetch in `monitoring.yml` (and any other job) can run to GitHub's 6h default.
**Recommendation:** add a `timeout-minutes` to each job (monitoring/smoke especially). CI-config only.

---

## Recommended backlog folding (deferred — locked files)

`BACKLOG.md` is currently being edited by open PRs **#440** and **#441**, and `docs/DOCS_INDEX.md` by **#441**, so this side-car lane did **not** edit them (collision avoidance). Once those merge, the owner / a follow-up PR should fold the **not-yet-tracked** verdicts into `BACKLOG.md`:

- ME-5, ME-6, ME-9, ME-10, ME-11, ME-12 (each with its risk tag).
- LO-3 greeting cutoff mismatch `[polish]`.
- LO-4 `/session-2026/` date fragility `[housekeeping]`.
- LO-5, LO-6, LO-7, LO-8, LO-9(b/c), LO-11 `[housekeeping]`/`[polish]`.
- LO-1 / LO-9(d): already covered by existing tracked items (undo critical-behaviour; AC5a liftCode merge) — no new entry needed.
- LO-2: open a dedicated "response-envelope consistency audit" item (not re-verified here).

This doc should also be registered in `docs/DOCS_INDEX.md` (Audit/baseline section) once `#441` releases that file.

## Method note

Verdicts are from direct reads/greps of current `main` at the time of writing (HEAD `eadc3ee`). LO-2 was explicitly **not** exhaustively traced and is marked accordingly. No code, test, parser, write-path, or schema was modified to produce this report.
