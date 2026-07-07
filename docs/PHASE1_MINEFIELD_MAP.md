# Phase 1 Minefield Map — app.js Behavior Contract (PR-09 → PR-11)

> **Status:** Frozen contract. Produced 2026-07-07 from a full read of the repo at HEAD
> (post PR-07 `3964825`, post PR-08 `e6ccf7e`).
> **Audience:** the agent executing PR-09, PR-10, and PR-11, and the reviewer gating them.
> **Rule:** every item in this document is observed behavior at HEAD. During Phase 1 it may be
> **relocated but not changed**. Anything here that a PR alters intentionally must be called out
> in the PR body by name, with the owner's sign-off, before merge.

---

## 0. Why this document exists

PR-09 is labeled "mechanical extraction," but mechanical extractions fail on wiring nobody wrote
down: load-order assumptions, event payload fields a listener quietly depends on, state that gets
persisted as a unit, and PWA cache behavior. This map writes that wiring down so PR-09/10/11 can
be verified against it instead of against vibes.

---

## 1. Load-order contract (the most fragile thing in the frontend)

Observed at HEAD (`public/index.html` lines 594–595, `src/app/atlasEntry.js`, bottom of
`src/app/app.js`):

1. **`app.js` is still a classic (non-module) script**, loaded synchronously. Its init runs at
   **top level at the bottom of the file** — not in a `DOMContentLoaded` handler. In order:
   `log-date` input listener → `setDefaultDate()` → `checkConnection()` →
   `restoreSessionSnapshot()` → `loadDashboard()` → `loadCoachPlan()` → `loadWeeklyCoach()` →
   `loadExerciseDatalist()` → drawer backdrop/close listeners → service-worker registration.
2. **`atlasEntry.js` is the single `type="module"` entry.** Being a module it is deferred: it runs
   **after** app.js's top-level code has executed, and **before** user interaction. It imports (in
   order, for side effects): `flightRecorder.js`, `legacyBridge.js`, `nav.js`, `drawer.js`,
   `chat.js`, `coach-conversation.js`.
3. **Consequence A:** the bridge globals (`window.activeSession`, `window.hybridCompare`,
   `window.planMutationIntent`, `window.identityCorrection`, `window.displayBlockNormalizer`) do
   **not exist yet** while app.js's top-level init runs. Any app.js code that touches them must be
   (and currently is) inside functions invoked after module load. **PR-09 must not move any
   bridge-global access into code that executes at classic-script parse time.** Specifically
   verify `restoreSessionSnapshot()` and everything it calls remain bridge-free, or convert the
   whole load story in one deliberate step — not by accident.
4. **Consequence B:** the reverse dependency also has a timing window. app.js assigns
   `window.atlasRefreshSessions` and `window.atlasUndoLastWrite`; satellites use them
   (nav/coach-conversation, 5 uses total). Today this is safe because app.js (classic, earlier)
   assigns before modules run. If PR-09 turns app.js pieces into modules, these two globals must
   be assigned by a module that is imported **before** any consumer in `atlasEntry.js`'s graph —
   or replaced by direct imports in the same PR, with the replacement named in the PR body.
5. **Consequence C (PWA cache):** `sw.js` precaches `SHELL_ASSETS` by URL and serves
   cache-first. PR-09 creates new files → new URLs. Every extracted module's URL must be added to
   `SHELL_ASSETS` **and `CACHE_NAME` must be bumped** in the same PR, or the live phone keeps
   serving a stale app.js that references modules the old cache doesn't have — a mid-gym white
   screen. This is the highest real-world-blast-radius item in Phase 1. Add an e2e or unit
   assertion that every file in the built `public/` JS set appears in `SHELL_ASSETS`.

---

## 2. Top-level mutable state inventory (31 variables) and slice assignment

All `let` declarations at module scope in `app.js` at HEAD, with the store slice the remediation
plan assigns them to. **Nineteen of the thirty-one are not named by PR-10 or PR-11.** They must be
explicitly dispositioned (migrated, left as module-local in an extracted module, or deferred with
a note) — "not mentioned" is not a disposition.

### 2a. Named in PR-10 (session/plan slice)
| Line | Variable | Notes |
|---|---|---|
| 1982 | `activePlannedSession` | Also persisted in the session snapshot (§4). |
| 1985 | `sessionChromeExpanded` | |
| 1996 | `coachSuggestionEngaged` | |
| 2003 | `pendingSubstitution` | |

### 2b. Named in PR-11 (logging/write slice)
| Line | Variable | Notes |
|---|---|---|
| 3681 | `pendingWrite` | |
| 3697 | `lastParsedWorkoutText` | |
| 3698 | `lastParserStatus` | |
| 3699 | `activeExercise` | |
| 3700 | `lastPrescribed` | |
| 3705 | `lastUnverifiedExercise` | |
| 3708 | `lastIntentData` | |
| 3714 | `sessionCompiledAwaitingPreview` | |

### 2c. NOT named by any PR — the gap (19 variables)

**Group 1 — session state persisted with the snapshot (must move with PR-10, not later):**
| Line | Variable | Why it can't be left behind |
|---|---|---|
| 4584 | `sessionLog` | Serialized into `atlas_session_snapshot_v1` alongside `activePlannedSession`. If PR-10 moves `activePlannedSession` to the store but leaves these as loose `let`s, snapshot save/restore straddles two state worlds and resume-after-kill breaks subtly. |
| 4588 | `sessionCompleted` | Same snapshot; also copied into the `atlas:set-logged` payload (`completed: [...sessionCompleted]`). |
| 4597 | `sessionSavedLog` | Session recap state, reset on `atlas:session-reset` paths. |

**Group 2 — write-path state (belongs with PR-11's slice):**
| Line | Variable | Notes |
|---|---|---|
| 3720 | `lastWrite` | Undo depends on it (`handleUndoLastWrite`, `window.atlasUndoLastWrite`). |
| 3724 | `writeInFlight` | Double-submit guard on the trust loop. |
| 7046 | `pendingBwWrite` | Bodyweight write's own pending state — same preview→approve pattern. |
| 4601 | `closeoutScreenshotFile` | Closeout/screenshot trio; cleared on save and on reset. |
| 4602 | `closeoutScreenshotEffort` | |
| 4606 | `closeoutScreenshotDateSource` | Feeds the RC2 date-precedence rule (§6.3). |
| 4610 | `logDateManuallyEntered` | RC2: set only by a genuine `input` event on `log-date`; programmatic date sets must never trip it. |

**Group 3 — caches and view-local state (acceptable as module-locals in extracted modules, but
must be declared as such in the PR-09 body):**
| Line | Variable | Notes |
|---|---|---|
| 35 | `atlasLastError` | Diagnostics. |
| 36 | `atlasServerVersion` | Diagnostics. |
| 638 | `historyLoaded` | Lazy-load flag. |
| 867 | `hybridCompareState` | Hybrid-compare UI state. |
| 1714 | `lastGlanceData` | Feeds `atlas:glance-ready`. |
| 3180 | `liftListCache` | Cache. |
| 3184 | `trendsLiftData` | Trends view. |
| 3185 | `trendsFrame` | Trends view. |
| 3731 | `planTodayByNameCache` | Cache; invalidation points must move with it. |

---

## 3. Custom event contract (10 event types)

All `atlas:*` traffic at HEAD. Payloads are **behavior-frozen**: fields may not be renamed,
removed, retyped, or reordered in meaning. Additive fields require a PR-body callout.

| Event | Dispatched from | Listened in | Payload (observed) |
|---|---|---|---|
| `atlas:glance-ready` | app.js:1421 | coach-conversation:1592 | `{ opener, compressed, signature, ... }` (from `buildCoachOpener` / `lastGlanceData`) |
| `atlas:plan-mutated` | app.js:2226 | coach-conversation:1620 | `{ summary: string, current: string\|null }` |
| `atlas:identity-corrected` | app.js:2475 | coach-conversation:1632 | `{ from: string, to: string }` |
| `atlas:plan-edit-proposed` | coach-conversation:1984 | app.js:2706 | `{ edit, result }` — app.js **mutates** `e.detail.result.applied` in the listener (two-way handshake; preserve exactly) |
| `atlas:plan-edit-applied` | app.js:2717 | (diagnostic) | `{ applied, edit }` |
| `atlas:preview-ready` | app.js:4539 | coach-conversation:1599 | `{ rows: [], liftCodes: [], effortOnly: bool, effort, substitutions: [], dateInfo: {date, source}\|null, recap: canonicalSessionRecap()\|null }` |
| `atlas:session-reset` | app.js:4672, 5549, 6959 | app.js:4492/4495, coach-conversation:1145, nav:422 | no detail. Three distinct dispatch sites = three distinct semantics (restore-clear, deliberate reset, post-save clear). All three must survive extraction. |
| `atlas:set-logged` | app.js:5216 | app.js:4491, coach-conversation:1615, nav:415 | `{ exercises: byExercise, text, planIsComplete, nextPlanned, completed: [...sessionCompleted], plannedOrder, plannedQueue?, substitutions?, ... }` — the next-up/handoff logic depends on `completed` and `plannedOrder` rejecting off-plan fallbacks (this encodes the G3-family fixes; regressing it re-opens closed live bugs). |
| `atlas:substitute-suggested` | app.js:5327 | coach-conversation:1616 | `{ prescribed, ...rec }` |
| `atlas:chat-message` | app.js:5899 | coach-conversation:2024 | `{ text, context }` — dispatched inside `setTimeout(0)` **deliberately** so the user bubble renders before the "Thinking…" bubble. The deferral is behavior, not style. Keep it. |
| `atlas:placeholder-owned` | coach-conversation:718 | nav:421 | (ownership handoff) |

**Test requirement (PR-10/PR-11 acceptance):** payload snapshots asserted byte-for-byte for
`atlas:preview-ready` and `atlas:set-logged`, and dispatch-count/ordering tests for the three
`atlas:session-reset` sites.

---

## 4. Persistence contract (localStorage + service worker cache)

| Key | Owner | Shape / rule |
|---|---|---|
| `atlas_api_key` | app.js (§api auth) **and** flightRecorder.js (independent read) | Plain string. Two readers — moving the setter must not orphan flightRecorder's reads. |
| `atlas_session_snapshot_v1` | app.js | `{ v: 1, ts, sessionLog, sessionCompleted, activePlannedSession, sessionId? }`. Written on session activity, cleared at all three `session-reset` semantics **and** on successful save. Restore path: `restoreSessionSnapshot()` at app.js top-level init. **The `v: 1` version field exists — if the store migration changes the shape, bump `v` and keep a v1 reader for one release** (a phone can hold a pre-migration snapshot mid-gym-week). |
| `atlas_opener_ledger_v1` | coach-conversation.js | Opener-signature ledger (prevents re-briefing). Best-effort; JSON-guarded. |
| `atlas_flight_device` | flightRecorder.js | Device id. |
| (hybrid-compare feedback entries) | hybridCompare.js via `saveComparisonEntry(localStorage, entry)` | Key defined inside hybridCompare; app.js passes `localStorage` in. Keep the injected-storage pattern (it's what makes it testable). |

Service worker: see §1.5. `SHELL_ASSETS` + `CACHE_NAME` are part of every Phase-1 PR's diff
review, not an afterthought.

---

## 5. Global API surface (the bridge, both directions)

**Modules → app.js (via `legacyBridge.js`, PR-08):** `window.activeSession` (5 uses in app.js),
`window.hybridCompare` (5), `window.planMutationIntent` (1), `window.identityCorrection` (1),
`window.displayBlockNormalizer` (**0 uses found in app.js** — before PR-09, confirm its real
consumer or flag it to the owner as possibly bridge-dead; do not silently delete). Bridge objects
are spread (`{...module}`) deliberately to preserve the mutable-bag shape of the old UMD globals —
do not "simplify" to frozen namespace objects until app.js is fully modular.

**app.js → modules:** `window.atlasRefreshSessions`, `window.atlasUndoLastWrite` (see §1.4).
PR-11 acceptance already says the legacy bridge ends as "`window.atlas*` public hooks only" —
these two are that list.

**Backend surface:** all ~41 endpoints route through the single `api(path, options)` wrapper
(app.js:114), which injects auth from `atlas_api_key`. Extraction keeps exactly one wrapper; no
module grows its own fetch with its own auth handling.

---

## 6. Frozen behaviors that are easy to break silently

1. **Preview → approve → write.** Screenshot upload must advance to preview, **never** one-tap
   save (owner-confirmed constraint, PR-0C scoping). `test_mode` handling and `write_id`
   generation are untouchable in Phase 1.
2. **Undo path.** `lastWrite` → `handleUndoLastWrite` → `window.atlasUndoLastWrite` → the
   post-save "Undo last write" button rendered after the `session-reset` dispatch at app.js:6959.
   That ordering (reset first, undo button after, from `pendingLastWrite` captured before reset)
   is deliberate.
3. **RC2 date precedence.** Manual keystroke on `log-date` sets `logDateManuallyEntered = true`
   via a real `input` event only; programmatic `setDefaultDate()` never trips it; a closeout
   screenshot's date must not override a manual entry. Three interacting rules — test all three.
4. **`atlas:chat-message` setTimeout(0)** — see §3. Bubble ordering is user-visible behavior.
5. **`atlas:plan-edit-proposed` two-way mutation** — the dispatcher reads back
   `detail.result.applied` after the listener runs. Synchronous dispatch is load-bearing.
6. **Session-snapshot resume.** `restoreSessionSnapshot()` runs during top-level init, before
   modules exist (§1.3). Resume-after-app-kill is a headline reliability feature; it gets a
   manual smoke test at the next real gym session after each Phase-1 PR (already in PR-10's
   acceptance — extend to PR-09).

---

## 7. Acceptance checklist additions (paste into PR bodies)

**PR-09:**
- [ ] Every §2c Group-1/2 variable has an explicit disposition stated in the PR body.
- [ ] No bridge-global (`window.activeSession` etc.) access moved into parse-time code (§1.3).
- [ ] `window.atlasRefreshSessions` / `atlasUndoLastWrite` assignment ordering preserved (§1.4).
- [ ] `SHELL_ASSETS` updated + `CACHE_NAME` bumped; asset-coverage assertion added (§1.5).
- [ ] All 13 dispatch sites and 15 listeners still present (grep-proven table matching §3).
- [ ] `window.displayBlockNormalizer` consumer identified or flagged (§5).

**PR-10:**
- [ ] `sessionLog`, `sessionCompleted`, `sessionSavedLog` migrate **with** `activePlannedSession`
      (§2c Group 1) or the owner explicitly accepts the split in writing.
- [ ] Snapshot shape unchanged, or `v` bumped with a v1 reader (§4).
- [ ] Byte-for-byte payload snapshot tests for `atlas:set-logged` (§3).

**PR-11:**
- [ ] `lastWrite`, `writeInFlight`, `pendingBwWrite`, closeout trio, `logDateManuallyEntered`
      dispositioned with the write slice (§2c Group 2).
- [ ] Byte-for-byte payload snapshot tests for `atlas:preview-ready` (§3).
- [ ] §6.1–6.3 behaviors asserted in tests, not just eyeballed.

---

*Produced from full-repo static analysis at HEAD. If code has moved since 2026-07-07, re-verify
line numbers before relying on them; the contracts themselves (payload shapes, ordering rules,
storage keys) are the durable part of this document.*
