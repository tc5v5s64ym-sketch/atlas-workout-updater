# Atlas Remediation Plan v2 — PR Execution Queue
**Source:** Independent code review, 2026-07-05 (score 6.5/10), revised per owner feedback · **Owner:** Dale · **Builder:** Claude Code
**Changes in v2:** Added **Phase -1** (three live test-session bug fixes that run BEFORE any architecture work) and split the One-Brain promotion into **PR-12A** (promote, with rollback switch) and **PR-12B** (delete legacy lanes only after burn-in).

**How to use this doc:** Work top to bottom. Copy one **PROMPT** block into Claude Code, let it run to a merged PR under your normal automation rules (Codex gate, tests green, backlog updated in-PR), then take the next one. Every prompt begins with your standard **model hold point**. One concern per PR — if Claude Code discovers adjacent work, it files it in BACKLOG.md and stays in scope.

**Model note:** Tags follow the convention — **Sonnet 4.6** for mechanical/pure-data PRs, **Opus 4.8** for anything behavior-changing or correctness-critical. If your standing "Opus for everything" rule is still in force, just confirm Opus at every hold point; the Sonnet tags are then simply "low-risk" hints.

**The map (7 phases, 25 PRs, 1 owner decision gate):**
- **Phase -1 — Live bug fixes first** (PR-0A → PR-0C): the three real bugs from your test sessions. Nothing gets buried under architecture work.
- **Phase 0 — Safety net & fast wins** (PR-01 → PR-06): cheap protection before touching anything big.
- **Phase 1 — Frontend plumbing** (PR-07 → PR-11): modules, build step, one state store. The foundation everything else stands on.
- **Phase 2 — One Brain resolution** (GATE A, PR-12A, PR-12B, PR-13): finish the switchover or kill it; clear the graveyard.
- **Phase 3 — One source of exercise truth** (PR-14 → PR-15).
- **Phase 4 — Backend split** (PR-16 → PR-18): mechanical, do these whenever you want a low-stress week.
- **Phase 5 — Later / evidence-gated** (PR-19 → PR-21): SQLite read cache, Preact island #1, governance diet.

Rules that hold for **every** PR below (Claude Code already knows these from CLAUDE.md, restated for safety): trust loop untouched (preview → approve → write, proof fields, undo, slash notation per INVARIANTS P1–P3/W1–W7); no real Sheets writes; BACKLOG.md updated in the same PR; tests green before merge.

---

## PHASE -1 — LIVE BUG FIXES (run these first, in this order)

> **✅ PHASE -1 COMPLETE (2026-07-06, owner-confirmed).** All three live-session bugs were already resolved in prior work: PR-0A by `b859abf` (verify/undo 400 — row-span cap mismatch), PR-0B by `5531680` / #863 (already-saved exercises now shown in the confirm/review card), PR-0C by `8c95892` / #864 (coach message layer no longer renders the stale idle greeting). Next up: Phase 0 (PR-01→PR-06 shipped; **PR-07** is next).

These three are real bugs observed in live test sessions. Each prompt follows your standard bug loop: **reproduce → root cause → smallest safe fix → regression test → PR.** All three are Opus — they touch the write path or in-session behavior. Claude Code should mine `/api/flight/recent`, the Bug_Reports tab entries, and `docs/BUG_TRIAGE_LEDGER.md` for the captured evidence before touching code.

### ✅ DONE — PR-0A — Fix: verify/undo request rejected with a malformed 400 · **Opus 4.8** · `[trust-critical]`
**Status:** Shipped in `b859abf` ("Fix verify/undo 400 on multi-set logs — row-span cap mismatch"). Owner-confirmed 2026-07-06.
**Why (plain terms):** When you try to check or undo a just-saved workout, the server sometimes rejects the request as "badly formed" — meaning either the app is building the request wrong, or the server's checks are stricter than the app expects. Undo is a safety feature; it has to work every time.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (undo/write path, trust-critical). State which model you are currently on and wait for owner confirmation before doing anything else.
>
> Bug: A live test session hit a **400 (malformed request)** on the verify/undo flow — `GET /api/log-workout/verify-range` and/or `POST /api/log-workout/undo-last`. Follow the standard bug loop, one concern only. (1) **Reproduce**: pull the failing request from the Flight Recorder log / bug-report entries / server logs; if none captured, reconstruct from the client code path in `public/` that builds the verify/undo payload (A1 range, `rows_to_delete`, `session_id`) after a write, and write a failing test that reproduces the 400 at the endpoint level. (2) **Root cause**: determine which side is wrong — the client constructing a payload that violates the endpoint contract (range span vs `rows_to_delete` mismatch, wrong tab, stale `logAppendedRange` shape), or server validation rejecting a legitimately-shaped request. (3) **Smallest safe fix on the side that is actually wrong.** Hard constraints: INVARIANTS W4 (Log_Cleaned only), W5 (read-back before delete, 409 on mismatch), W7 (≤10 rows, span must match) are behavior-frozen — the fix must make valid requests succeed, never loosen those guards. (4) Regression tests: the exact failing payload now succeeds end-to-end in a dry-run-safe test, plus negative tests proving W4/W5/W7 still reject what they should. Acceptance: failing repro test now green, full suite green, PR body states the root cause in two sentences and which side (client/server) was fixed and why.

### ✅ DONE — PR-0B — Fix: session confirm/review screen missing logged workouts · **Opus 4.8** · `[trust-critical]`
**Status:** Shipped in `5531680` / #863 ("Show already-saved exercises in the confirm/review card"). Owner-confirmed 2026-07-06.
**Why:** At the end-of-session review, some exercises you actually logged aren't showing up in the confirm list. The review screen is where you decide what gets written to the permanent record — it must show everything, every time.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (preview/confirm surface of the trust loop). State your current model and wait for owner confirmation.
>
> Bug: During a live session, the **confirm/review step did not display all logged workouts** — at least one exercise the lifter had entered was missing from the review list (and therefore at risk of being silently excluded from, or mismatched with, the approved write). Follow the standard bug loop. (1) **Reproduce**: recover the exact input sequence from Flight Recorder client events (`user_action` / `screen_rendered` / `card_rendered`), bug reports, or the session's parse payloads; build a failing test at the layer where the row goes missing — candidate seams, in order: `workoutTextParser` multi-exercise/stacked parse output → preview assembly in the `/api/log-workout` or `/api/complete-workout` dry-run → client `pendingWrite`/preview state → `displayBlockNormalizer` / render grouping. This is adjacent to the previously-fixed G1/G2/FA parse-merge and interleave family — check those regression tests first and extend, don't duplicate. (2) **Root cause** at exactly one seam. (3) **Smallest safe fix**, with the invariant stated in the PR: *every row present in the dry-run response rows must be visible in the review UI, and the approved write must contain exactly the reviewed rows — no more, no fewer.* (4) Regression tests pin the failing sequence plus a property-style test: N parsed exercises in → N rendered review blocks out, across stacked/interleaved/substituted variants. Acceptance: repro test green, G1/G2/FA suites still green, full suite + e2e green.

### ✅ DONE — PR-0C — Fix: coach goes idle mid-session and doesn't advance to the next lift · **Opus 4.8** · `[correctness]`
**Status:** Shipped in `8c95892` / #864 ("Fix Flight Recorder reporting the stale idle greeting as the coach message" — the coach message layer no longer surfaces the stale idle turn). Owner-confirmed 2026-07-06.
**Why:** Mid-workout, the coach sometimes just sits there — a stuck or idle message, no "next up" — so you're left prompting it instead of it leading you. The coach's whole job in-session is to always know what's next.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (in-session flow correctness). State your current model and wait for owner confirmation.
>
> Bug: In a live session the coach surface got **stuck on an idle/stale message and failed to advance** to the next planned lift after a set/exercise was logged. This is the same family as the previously-scoped G3 (wrong next-up / premature session-end prompts) — read that scoping and the completion-flow constraint (screenshot upload must advance to preview, never one-tap save) before starting. Follow the standard bug loop. (1) **Reproduce** from Flight Recorder (`session_state_changed`, `coach_message_rendered` ordering) or by scripting the state sequence against `public/activeSession.js` + `services/sessionPlanExecutor.js` + the coach-conversation advance logic; produce a failing test showing the state machine (or its renderer) not emitting/consuming the advance after a logged set. (2) **Root cause** exactly one of: the state machine not transitioning, the transition event not fired/heard (`atlas:set-logged` / `atlas:preview-ready` choreography), or the coach message layer rendering a stale turn. (3) **Smallest safe fix** at that seam only — do not redesign the session flow (that's Phase 1's job). (4) Regression tests: log-set → next-up advance across mid-plan, last-exercise (session-close question fires exactly once, never early), substitution-then-advance, and screenshot-upload paths. Acceptance: repro test green, G3-family and completion-flow tests green, full suite + e2e green, PR body names the seam in one sentence.

---

## PHASE 0 — SAFETY NET & FAST WINS

### PR-01 — Real static analysis (ESLint) · **Sonnet 4.6** · `[housekeeping]`
**Why (plain terms):** Right now "lint" only checks that files aren't gibberish. ESLint is a robot proofreader that catches whole classes of AI-written bugs before tests ever run.
**PROMPT:**
> STOP — model hold point. This PR requires **Sonnet 4.6**. State which model you are currently on and wait for owner confirmation before doing anything else.
>
> Task: Introduce ESLint (flat config) to the repo. Scope: (1) add `eslint` as a devDependency with a minimal, high-signal ruleset — `no-undef`, `no-unused-vars` (args: none), `eqeqeq` (warn), `no-implicit-globals`, `no-var` — with environments configured for Node (backend/services/tests) and browser+Node dual (public/*, which use the UMD-style export pattern); (2) run `eslint --fix` for safe autofixes only; (3) for remaining **errors**, fix only trivial ones (genuinely unused variables, `var`→`let/const`); anything ambiguous gets an inline `eslint-disable-next-line` with a one-line reason and a BACKLOG entry; (4) rename scripts: `lint` = eslint, keep the old syntax pass as `check:syntax`; (5) wire `lint` into the CI unit-test job as blocking on errors, warnings non-blocking. Out of scope: any behavior change, any refactor, stylistic rules (quotes/semicolons/indent). Acceptance: `npm run lint` exits 0, `npm test` fully green, CI green, zero diffs in runtime behavior.

### PR-02 — Kill the 17 unsafe `innerHTML` error messages · **Sonnet 4.6** · `[correctness]`
**Why:** In 17 places the app pastes raw error text straight into the page. It's a one-hour fix using a safe helper the code already has.
**PROMPT:**
> STOP — model hold point. This PR requires **Sonnet 4.6**. State your current model and wait for owner confirmation.
>
> Task: In `public/app.js` (and any other `public/*.js` file with the same pattern), replace every case of interpolating dynamic values — especially `err.message` — into `innerHTML` template literals (e.g. `` box.innerHTML = `<span class="muted">Could not load: ${err.message}</span> `` ) with safe DOM construction: clear the container, then append a span built via the existing `el()` helper or `textContent`. Grep for `innerHTML = \`` to enumerate; there are ~17 sites. Preserve exact visible wording and CSS classes. Out of scope: static `innerHTML` assignments with no interpolation; any other refactoring. Acceptance: no remaining `innerHTML` assignment containing `${` with dynamic data anywhere in `public/`; all tests + Playwright e2e green; error states render visually identical.

### PR-03 — package.json honesty + repo metadata · **Sonnet 4.6** · `[housekeeping]`
**PROMPT:**
> STOP — model hold point. This PR requires **Sonnet 4.6**. State your current model and wait for owner confirmation.
>
> Task: Update `package.json`: (1) description → accurate one-liner ("AI-assisted workout logging and coaching app: NL parsing, deterministic coaching engine, approve-before-write Google Sheets record"); (2) add `"private": true`; (3) verify `engines` and script names still match reality after PR-01. Update README's first paragraph only if it contradicts the new description. Out of scope: dependency upgrades, any code. Acceptance: `npm install` and full test suite green.

### PR-04 — Idempotency survives restarts · **Opus 4.8** · `[trust-critical]`
**Why:** The duplicate-write shield currently lives in the server's short-term memory — a Render restart mid-session wipes it. This gives it a tiny durable notebook so a retried save can't double-write across a redeploy.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (write-path, trust-critical). State your current model and wait for owner confirmation.
>
> Task: Make `services/idempotency.js` durable across process restarts with the smallest possible footprint. Approach: write-through persistence of the `writeRecords` map to a single JSON file on local disk (path from env `ATLAS_IDEMPOTENCY_FILE`, default `/tmp/atlas-idempotency.json` locally and a persistent-disk path on Render), loaded lazily on first use, pruned by the existing 24h TTL on load and on write. Requirements: (1) persistence failures must NEVER fail a workout write — fall back to in-memory with one structured warn log; (2) file writes atomic (tmp file + rename); (3) public API of the module unchanged; (4) `resetIdempotencyStore()` also clears the file; (5) unit tests: restart simulation (fresh module load replays a `completed` record; `in_progress` older than a staleness window is treated as `failed`), corrupt-file recovery, TTL prune on load. Explicitly preserve INVARIANTS W1–W3 and the existing composite-key sheet dedupe as the second line of defense. Out of scope: SQLite, any other in-memory store (caches, shadow rings, pendingExercisesMemory), any endpoint change. Acceptance: all existing idempotency + log-workout tests green plus the new restart tests; a dry-run `test_mode=true` flow is byte-identical in response shape.

### PR-05 — Exercise-truth disagreement detector (report-only) · **Sonnet 4.6** · `[housekeeping]`
**Why:** Exercise names live in four places. Before merging them, we need a robot that lists every spot where they already disagree.
**PROMPT:**
> STOP — model hold point. This PR requires **Sonnet 4.6**. State your current model and wait for owner confirmation.
>
> Task: Add a consistency audit across the four exercise-knowledge sources: (a) `EXERCISE_ALIASES` + `CONTEXTUAL_ALIASES` in `services/workoutTextParser.js`; (b) `data/exercise_catalog.v1.json` + `data/exercise_aliases.v1.json`; (c) `config/coaching/exercises/*.json` (+ `_index.json`); (d) the `Exercise_Catalog` sheet contract columns as encoded in `services/exerciseEnrichment.js` fixtures/tests (no live sheet read). Build `test/exerciseTruthAudit.test.js` + a small pure module `services/exerciseTruthAudit.js` that: normalizes names, maps every alias→canonical per source, and reports (1) aliases resolving to different canonicals across sources, (2) canonicals present in one source but missing in another, (3) case/punctuation-only mismatches. The test PASSES but prints the full disagreement inventory to the test log and writes it to `docs/verification/EXERCISE_TRUTH_AUDIT.md` (generated file, committed). Out of scope: changing ANY data or parser behavior. Acceptance: audit doc generated and committed; all tests green; zero runtime imports of the new module.

### ✅ DONE — PR-06 — Reconcile disagreements, make the detector blocking · **Opus 4.8** · `[trust-critical]`
**Status:** Shipped. Reconciled all 67 catalog↔coaching (B↔C) Type-1 conflicts to zero by editing JSON data only (no parser/write-path change); `test/exerciseTruthAudit.test.js` now blocks on any B↔C Type-1. **Owner decision (Option 1):** the frozen parser (A) and the live write-path enrichment module (D) are themselves conflict participants (e.g. the RDL family — parser `RDL` vs history `Romanian Deadlift`), so reaching "zero across all four sources" is out of scope; the 32 parser/enrichment-anchored residuals are grandfathered in `docs/verification/EXERCISE_TRUTH_ALLOWLIST.json` and deferred to PR-14 (parser↔catalog) / PR-15 (sheet/enrichment↔catalog).
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (touches parser-adjacent data; INVARIANTS P1–P3 apply). State your current model and wait for owner confirmation.
>
> Task: Using `docs/verification/EXERCISE_TRUTH_AUDIT.md` from PR-05, reconcile every disagreement by editing the **data sources only** (JSON files and, where the parser table conflicts with the catalog, adjust JSON to match the parser's user-facing canonical names — the parser's names are what Dale's history already uses, so history wins). Where a decision is genuinely ambiguous (two defensible canonicals), pick the one matching `Log_Cleaned` history conventions and record the decision in the audit doc. Then flip the audit test from report-only to **failing** on any disagreement of type (1) alias→different canonicals. Expand parser golden tests for any alias whose resolution surface changed (INVARIANT P2). Out of scope: deleting any source yet; changing parser code; sheet writes. Acceptance: audit doc shows zero type-(1) disagreements; parser golden tests green and expanded; full suite green.

---

## PHASE 1 — FRONTEND PLUMBING (do in order; each ships alone)

### PR-07 — Introduce Vite (wrapper stage, zero behavior change) · **Opus 4.8** · `[correctness]`
**Why:** This adds a proper "assembly line" for the frontend without changing what comes off it. Everything after depends on this.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (touches app shell + service worker surface). State your current model and wait for owner confirmation.
>
> Task: Add Vite as the frontend build. Stage-1 wrapper only: (1) `public/` sources move to `src/app/` unchanged; Vite builds to `public/` (or a `dist/` that Express serves at `/app` — pick whichever keeps `express.static` and `sw.js` paths stable, and document the choice); (2) output must remain **multiple plain script files with the same URLs** the SW's `SHELL_ASSETS` list expects — no bundling/renaming yet, no hashing yet; (3) `npm run dev` serves with Vite proxying `/api` to the local server; `npm run build` is added to CI and to the Render build; (4) `sw.js` untouched except a cache-name bump if any URL changed; (5) Playwright e2e must run against the **built** output. Hard constraints: `/api` never touched; index.html script order preserved; no ES-module conversion in this PR. Acceptance: built app is behaviorally identical (all e2e specs green against build output), unit suite green, `docs/ARCHITECTURE.md` gains a short "frontend build" section.

### PR-08 — Convert the 12 satellite scripts to ES modules · **Opus 4.8** · `[correctness]`
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8**. State your current model and wait for owner confirmation.
>
> Task: Convert every `public/`-origin script **except** `app.js` and `sw.js` (`nav.js`, `drawer.js`, `chat.js`, `activeSession.js`, `planMutationIntent.js`, `identityCorrection.js`, `displayBlockNormalizer.js`, `sessionQuestion.js`, `coach-conversation.js`, `coachVoiceTemplates.js`, `hybridCompare.js`, `flightRecorder.js`) to ES modules with explicit `export`/`import`. Replace the UMD `typeof module !== 'undefined'` dual-export blocks with standard exports; update the Node unit tests that `require('../public/activeSession')` etc. to import the same modules (use the project's existing test runner — adjust to `import` or a small compat shim, whichever keeps the suite green with least churn). Where these files currently reach for `window.activeSession`-style globals, import instead; where **app.js** consumes them, attach a temporary explicit bridge in ONE place (`src/app/legacyBridge.js` assigning the needed modules onto `window`) so app.js keeps working untouched. Delete every `(window.X) || (typeof X !== 'undefined' ? X : null)` defensive fallback made obsolete. index.html loads one `type="module"` entry that imports the satellites + bridge, then app.js as before. Acceptance: unit + e2e green; grep shows zero remaining dual-export UMD blocks in converted files; SW cache list updated; visible behavior identical.

### PR-09 — Break app.js into modules (mechanical extraction) · **Opus 4.8** · `[correctness]`
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (large blast radius; mechanical intent). State your current model and wait for owner confirmation.
>
> Task: Split `app.js` (7,169 lines) into ES modules along its existing section comments, moving code verbatim: suggested slices — `api.js` (fetch helper, key handling, error transport), `dom.js` (`el`, tables, status, charts), `bugReport.js`, `dashboard.js`, `historyView.js`, `progressView.js`, `logger.js` (parse/preview/approve/undo UI), `sessionFlow.js`, `settingsHealth.js`, plus `main.js` composing them. Rules: (1) NO logic edits, renames-for-taste, or "improvements" — pure moves + import wiring; (2) module-level `let` state moves with its owning slice; cross-slice state that has no clear owner goes to a temporary `sharedState.js` with a `// TODO(PR-10)` marker — do not redesign it here; (3) the legacy bridge from PR-08 shrinks to only what non-module callers still need; (4) keep one built entry so SW/asset list barely changes. Acceptance: suite + e2e green; every extracted module ≤ ~900 lines; `main.js` < 200 lines; a `docs/verification/` note maps old app.js line ranges → new files for reviewability.

### PR-10 — One state store (signals) + migrate session/plan state · **Opus 4.8** · `[trust-critical]`
**Why:** Today the app's memory of "what session am I in, what's planned, what's pending" is scattered across loose variables. This gives it one brain cell that everything reads from — and that we can finally test directly.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (session-state correctness; gym-day behavior). State your current model and wait for owner confirmation.
>
> Task: Add `@preact/signals-core` (~2 KB, framework-free) and create `src/app/store.js`: signals + computed values owning **session/plan** state only — `activePlannedSession`, active-lift/current-exercise selection, `sessionChromeExpanded`, `coachSuggestionEngaged`, `pendingSubstitution`, plus their derived values — with a small documented API (`getState` snapshots for non-reactive callers, actions for every mutation; no direct signal writes outside the store). Migrate all reads/writes of those variables across the Phase-1 modules to the store; `activeSession.js` remains the pure state-machine and the store composes it. localStorage persistence for whatever subset currently persists moves into the store behind one `persist()` seam. Write a thorough unit-test file for the store: start/replace/skip/complete flows, substitution pending→applied, resume-after-reload, and every custom-event emission preserved byte-for-byte (`atlas:*` events still fire with identical payloads — other files depend on them). Out of scope: `pendingWrite`/preview/parser state (PR-11); any UI redesign; Preact components. Acceptance: zero remaining top-level `let` for the migrated names (grep-proven); new store tests + full suite + e2e green; a manual smoke checklist in the PR body for your next gym session (start plan → sub a lift → log a set → resume after app kill).

### PR-11 — Migrate write-path client state into the store · **Opus 4.8** · `[trust-critical]`
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (touches the client half of the trust loop). State your current model and wait for owner confirmation.
>
> Task: Extend `store.js` with the **logging/write** slice: `pendingWrite`, `lastParsedWorkoutText`, `lastParserStatus`, `activeExercise`, `lastPrescribed`, `lastUnverifiedExercise`, `lastIntentData`, `sessionCompiledAwaitingPreview`, and preview payload state. Migrate `logger.js`/`sessionFlow.js` (and coach-conversation's read-only mirrors) to the store. Absolute constraints: the preview→approve→write sequence, `test_mode` handling, `write_id` generation, and the `atlas:preview-ready` / `atlas:set-logged` contracts are behavior-frozen — assert them in tests, including "screenshot upload advances to preview, never one-tap save." Empty the PR-09 `sharedState.js` and delete it. Acceptance: store tests cover preview/approve/undo state transitions; full suite + e2e green; grep shows zero write-path top-level `let` state remaining in view modules; legacy bridge deleted or reduced to `window.atlas*` public hooks only.

---

## PHASE 2 — ONE BRAIN: FINISH IT OR KILL IT

### GATE A — Owner decision (not a PR)
**What you do (30–60 min, no coding):** Set `ATLAS_INTENT_ROUTER=shadow` and `ATLAS_COACH_ENGINE=hybrid` on Render if not already, live with it for **2–3 weeks of real sessions**, then have Claude (chat, not Code) summarize `/api/debug/brain-shadow` + `/api/debug/intent-shadow` against `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`. Decide: **FLIP** (Brian owns decisions), **HOLD** (name the exact missing evidence + a date), or **KILL** (delete the shadow lane). Write the decision in BACKLOG.md. Everything below assumes FLIP; if KILL, PR-12A becomes "delete the shadow/orchestrator lane" instead — same prompt shape, inverted target — and PR-12B is skipped.

### PR-12A — Promote One-Brain, with a one-switch rollback (no deletions) · **Opus 4.8** · `[trust-critical]`
**Why:** This flips who makes coaching decisions — the new engine takes the wheel — but the old system stays fully intact behind a single switch, so if anything feels off at the gym, you flip one setting and you're back.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (coaching decision ownership changes). State your current model and wait for owner confirmation.
>
> Context: Owner decision GATE A = FLIP, recorded in BACKLOG.md on [date]. Task — **promotion only, zero deletions**: (1) make the One-Brain path (`ATLAS_COACH_ENGINE=brian` per `services/coachEnginePromotion.js` and `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`) the default decision owner for exactly the surfaces the promotion criteria cover; (2) the legacy path remains fully intact and reachable behind `ATLAS_COACH_ENGINE=legacy` — rollback is one env var, and this is verified by a test that runs the same scenario suite under both modes; (3) swap the shadow observability roles: the ring now records what the LEGACY engine *would have said* while Brian answers live, same fields, so burn-in divergence stays reviewable; (4) response-shape contracts byte-identical (`source`, `configured`, `model` fields); (5) update `docs/CANARY.md` proving log per your five-clean-PR protocol and add a **burn-in checklist** to the PR body: what to watch across the next 2 weeks / ≥4 real sessions (zero engine crashes in shadow counters, zero target-number divergences you disagree with, no dead-end replies). Out of scope: deleting or editing ANY legacy lane in `/api/coach/chat` — that is PR-12B, gated on burn-in. Acceptance: full suite + simulation harness green under `brian` AND under `legacy`; flip and rollback each demonstrated in the PR body.

### PR-12B — After burn-in: delete the superseded legacy lanes · **Opus 4.8** · `[trust-critical]` · *Gate: PR-12A live ≥2 weeks / ≥4 real sessions with the burn-in checklist clean, recorded in BACKLOG.md.*
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8**. State your current model and wait for owner confirmation. Additionally: confirm the PR-12A burn-in record exists in BACKLOG.md (date + "checklist clean") before writing any code; if it does not, stop and report.
>
> Task: With Brian promoted and burn-in clean, remove the superseded hand-ordered lanes from `/api/coach/chat` — the plan-answer/shorthand lanes that duplicate engine capabilities per the manifest. Preserve: the deterministic no-LLM fallback (outage safety), tiredness/recovery routing if not yet a manifest capability, and every response-shape contract. Rules: (1) **no test, no delete** — every removed lane's behavior must be pinned by an existing or new test that the engine path passes; (2) delete each lane's now-dead helpers and their orphaned tests in the same commit; (3) keep `ATLAS_COACH_ENGINE=legacy` operable for whatever legacy remains, or — if this PR makes legacy non-viable — say so explicitly and get the owner's confirmation at the hold point before proceeding, since that converts the rollback switch into a git-revert-only rollback. Acceptance: full suite + simulation scenarios green; a table in the PR body listing each removed lane → the test proving parity; `/api/coach/chat` handler length reduced and the routing order comment updated to match reality; CANARY proving log updated.

### PR-13 — Orphan-module triage + "wired-or-deleted" CI guard · **Sonnet 4.6** · `[housekeeping]`
**PROMPT:**
> STOP — model hold point. This PR requires **Sonnet 4.6** (deletions of provably-unwired code + CI tooling). State your current model and wait for owner confirmation.
>
> Task: (1) Add `scripts/check-wired-modules.js`: builds the production import graph from entrypoints (`index.js`, `sheets.js`, `middleware.js`, `scripts/*`, `config/*`, and the frontend entry) and fails listing any `services/*.js` unreachable from production, with an allowlist file `config/wiring-allowlist.json` where every entry REQUIRES an expiry date and a roadmap link; expired entries fail CI. Wire into CI. (2) Triage today's ~16 unwired modules: **delete** the superseded near-duplicates (e.g. `autoregulation.js` where `autoregulationModule.js` is the roadmap version — verify direction per `docs/COACH_INTELLIGENCE_ROADMAP.md`, then remove the loser AND its test); **allowlist with expiry** the genuinely-staged CIL modules the active roadmap wires within its next 3 PRs; anything neither → delete (git history preserves it). (3) BACKLOG entries for each allowlisted module's wiring PR. Constraints: deleting a module requires proof of zero production imports (the new script's report, committed to the PR body); never delete anything the orchestrator manifest references. Acceptance: CI green including the new guard; allowlist ≤ 8 entries, all dated; suite green.

---

## PHASE 3 — ONE SOURCE OF EXERCISE TRUTH

### PR-14 — Parser aliases generated from the catalog · **Opus 4.8** · `[trust-critical]`
**Why:** The parser keeps its own private list of exercise names. This makes it read from the one shared catalog instead — so adding a lift in one place adds it everywhere.
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (parser; INVARIANTS P1–P3; golden tests mandatory). State your current model and wait for owner confirmation.
>
> Task: Make `data/exercise_catalog.v1.json` + `data/exercise_aliases.v1.json` the single alias source for `workoutTextParser.js`. Steps: (1) extend the aliases schema with the parser's special semantics as data — `ambiguous` prompts ("Which press…?") and `contextual` aliases with their anchor exercise — migrating today's `AMBIGUOUS_ALIASES`/`CONTEXTUAL_ALIASES` content; (2) parser builds its lookup tables from the JSON at load (preserve longest-match-first and every documented precedence rule — encode precedence in the loader, not scattered); (3) the hardcoded `EXERCISE_ALIASES` table is deleted only after a **shadow parity test** proves the generated table resolves every alias in the golden corpus identically — that parity test is committed and stays; (4) expand golden tests for the migrated ambiguous/contextual behaviors (P2). Constraints: user-facing canonical names unchanged (reconciled in PR-06); slash notation untouched; zero behavior diffs in the golden corpus. Acceptance: golden + parity + full suite green; parser file no longer contains any exercise name literal except in tests.

### PR-15 — Sheet catalog becomes a synced export · **Opus 4.8** · `[correctness]`
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8** (touches enrichment on the write path's preview). State your current model and wait for owner confirmation.
>
> Task: Invert the `Exercise_Catalog` relationship: JSON is source, sheet is a synced view. (1) `services/exerciseEnrichment.js` resolves canonical name / lift_code / muscle_group from the JSON catalog first; the sheet tab remains a fallback+overlay for sheet-only fields, with a warning (not a failure) logged on any JSON↔sheet mismatch; (2) extend `scripts/catalog-maintenance.js` with a `--sync-sheet` dry-run mode that prints the row diff needed to bring `Exercise_Catalog` in line with JSON — it NEVER writes; actual sync is an owner-run action documented in the script header and `docs/SHEET_CONTRACT.md`; (3) the "add it to Exercise_Catalog to lock it" pending-exercise flow now points at the JSON + maintenance script. Constraints: no live sheet write in code or CI; preview warnings text preserved where behavior unchanged. Acceptance: enrichment tests green with sheet fixture removed/minimized; PR-06 audit test still green; dry-run sync output demonstrated in PR body against fixtures.

---

## PHASE 4 — BACKEND SPLIT (mechanical; slot these anywhere after Phase 0)

### PR-16 / PR-17 / PR-18 — Express routers by domain · **Sonnet 4.6** (PR-18: **Opus 4.8**) · `[housekeeping]`
Three identical-shape PRs; run the prompt three times with the bracketed slice swapped:
**PR-16 slice:** read/analytics routes (`/api/history/*`, `/api/exercises/*`, `/api/sessions/*`, `/api/summary|progress|report|prs|stalls|volume|search|catalog`). **PR-17 slice:** coach + deload + debug/flight/bug-report/schema/health routes. **PR-18 slice:** write-path routes (`/api/log-workout*`, `/api/complete-workout`, `/api/parse-workout-*`, `/api/bodyweight*`, `/api/coaching-notes`, `/api/constraints`, `/api/log-modality`) — for PR-18 only, escalate the hold point to **Opus 4.8**.
**PROMPT (template):**
> STOP — model hold point. This PR requires **[Sonnet 4.6 | Opus 4.8 for PR-18]**. State your current model and wait for owner confirmation.
>
> Task: Mechanically extract the [SLICE] routes from `index.js` into `routes/[name].js` as an Express Router, moving handler code **verbatim**; shared helpers used across slices move to `services/httpHelpers.js` (or stay in index.js until their last consumer moves — no duplication). Middleware order, rate-limiter groupings, auth, flight-recorder hook, and route paths are byte-identical; `/routes` and `config/routes.js` stay accurate. No logic edits, no renames. Acceptance: full suite + e2e green; `index.js` shrinks by the moved line count; a route-inventory diff in the PR body proves zero paths added/removed/reordered.

---

## PHASE 5 — LATER / EVIDENCE-GATED

### PR-19 — SQLite read index beside the sheet · **Opus 4.8** · `[correctness]` · *Trigger: dashboard reads feel slow, or Log_Cleaned > ~5k rows, or Google 429s appear in logs.*
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8**. State your current model and wait for owner confirmation.
>
> Task: Add SQLite (better-sqlite3) as a **read cache/index only** — Google Sheets remains the permanent record and sole write target. (1) On boot and after every successful live write/undo, sync `Log_Cleaned` + `Effort` into local tables (full refresh is fine at current scale; keep it simple); (2) route `getSheetRows` reads for those two tabs through SQLite with a staleness stamp + on-demand refresh, replacing the 30 s TTL cache; every other tab and the undo pre-delete read-back stay LIVE sheet reads (preserve that invariant explicitly); (3) a `/api/health/db` endpoint reports row counts + last-sync; (4) failure mode: any SQLite error falls back to direct sheet reads with a warn — the app must run with the DB file deleted. Out of scope: writing workout data to SQLite as source of truth; schema migrations framework. Acceptance: full suite green with a fixture-backed sync test; undo tests prove read-back still hits the sheet live; measured before/after latency for `/api/summary/weekly` in the PR body.

### PR-20 — First Preact island: the coach conversation · **Opus 4.8** · `[correctness]` · *Prereq: PR-07…11 merged and stable through at least two real gym weeks.*
**PROMPT:**
> STOP — model hold point. This PR requires **Opus 4.8**. State your current model and wait for owner confirmation.
>
> Task: Introduce Preact (+ `@preact/signals` bindings) and rebuild the **coach conversation surface** (`coach-conversation.js`, 2,037 lines) as components mounted as an island into its existing container, reading/writing exclusively through the PR-10/11 store. Everything outside the island stays vanilla. Preserve exactly: typewriter behavior incl. reduced-motion, the "Save to Sheets clicks #approve-btn" trust-loop delegation, every `atlas:*` event consumed/produced, chip flows, and interleaved multi-lift rendering (regression tests for the G1/G2/FA bug family must pass). Bundle budget: island adds ≤ 15 KB gzip to the shell; SW list updated. The old file is deleted in the same PR — no dual implementations. Acceptance: unit + e2e + simulation-harness conversation scenarios green; side-by-side screen recording checklist in PR body for owner live-test; rollback = revert commit.

### PR-21 — Governance diet + guardrails · **Sonnet 4.6** · `[housekeeping]`
**PROMPT:**
> STOP — model hold point. This PR requires **Sonnet 4.6**. State your current model and wait for owner confirmation.
>
> Task: (1) Split BACKLOG.md: a new ≤ 30 KB `BACKLOG.md` containing only Active/Now + Next + open trust-critical items; everything else appended to `BACKLOG_ARCHIVE.md` with its section headers intact; CLAUDE.md pointers updated. (2) Add a CI byte-cap check: fail if `BACKLOG.md` > 40 KB or `CLAUDE.md` > 30 KB. (3) `docs/DOCS_INDEX.md`: every doc explicitly Active / Reference / ARCHIVED; CLAUDE.md's required-reading list trimmed to Active only. (4) Add a comment-convention note to CLAUDE.md: comments explain invariants and non-obvious reasoning; PR numbers/dates live in commit messages — then sweep ONLY `index.js` and `services/coach.js` for pure-changelog comments (keep every invariant/why comment). No code-behavior changes anywhere. Acceptance: suite green; CI cap active; archive diff shows zero content lost (moved, not deleted).

---

## SUGGESTED CALENDAR (relaxed, solo pace)
**Week 0:** Phase -1 — PR-0A → PR-0C, one at a time, live-verify each at the next gym session. Also flip the shadow flags on Render so GATE A evidence starts accumulating now. **Weeks 1–2:** PR-01 → PR-06. **Weeks 3–6:** PR-07 → PR-11, one per week-ish, with a real gym session between each. **Week 6–7:** GATE A decision → PR-12A. **Weeks 8–9 (during 12A burn-in):** PR-14, PR-15, and/or PR-16/17/18. **Week 9–10:** burn-in clean → PR-12B, then PR-13. **Anytime slack:** PR-21. **When triggered/ready:** PR-19, PR-20.

---

## QUICK SUMMARY (plain terms)
This v2 queue is 25 paste-ready Claude Code jobs across 7 phases, updated per your feedback: the three real gym-session bugs (undo rejection, missing workouts on review, coach going idle) now come first as Phase -1, and the One-Brain switchover is split into a safe two-step — flip it with a one-switch rollback, live with it for two weeks, and only then delete the old system. Everything else keeps the same shape: cheap safety nets, then frontend plumbing, then one coaching brain and one exercise list, with the big optional items last. Start with PR-0A and flip the shadow flags on Render today.
