# QA Campaign - 2026-06-26 Live Gym

**Status:** Campaign controller. This document plans the follow-up QA/fix sequence from the 2026-06-26 live gym and composer session. It does not implement any fix.

**Source:** [`docs/UX_PLAYTEST_2026-06-26_LIVE_GYM_AND_COMPOSER_SESSION.md`](./UX_PLAYTEST_2026-06-26_LIVE_GYM_AND_COMPOSER_SESSION.md). That source record contains the B1-B10 findings, live gym notes, and composer-first session observations. Do not run this campaign from memory if the source record is missing or stubbed.

**Frame:** Live app trust/UX triage from a real gym session. This is not MVP work.

---

## Mission

Run a focused live-app trust and UX repair campaign from the 2026-06-26 real gym session.

Rules:

- One PR per concern.
- No broad composer refactor.
- No Bug_Reports work unless a later PR is explicitly scoped to Bug_Reports.
- No manual Google Sheet writes.
- No app code, tests, workflows, schemas, or production data changes in this planning PR.
- Future implementation PRs must start from current repo evidence and prove the current failure path before editing.

Campaign principles:

- Protect logged history first. Corrupted rows poison every downstream trust surface.
- Keep user-led logging separate from guided-session behavior.
- Keep exercise save and optional effort metadata isolated.
- Let canonical active session state drive all visible surfaces.
- Treat the gym as an interruption-heavy environment: app switching, lock screen, Photos, Apple Watch, flaky network, and refresh are normal.

---

## Findings Map

| ID | Finding | Priority | Trust risk | Likely affected modules/files | Tests expected | Owner live testing required | Autonomous-safe |
|---|---|---:|---|---|---|---|---|
| B1 | Duplicate workout rows / impossible totals | P0 | Corrupts `Log_Cleaned`, session totals, progression, fatigue, PRs, deloads, recommendations, and owner trust. | `index.js`, `sheets.js`, `public/app.js`, session/write-id helpers, save/approve flow, write proof handling. | Idempotent save regression covering double-tap/retry/refresh/resume/failed-effort adjacency; post-save totals match rows; no duplicate append under one session ID. | Yes | No |
| B2 | Active session state drift | P0/P1 | UI, coach, preview, and save can disagree; success and failure surfaces can both fire for the same lift. | `public/app.js`, `public/coach-conversation.js`, active session helpers, preview builders, session compile path, plan card/placeholder readers. | Canonical session-state tests proving parser, confirmation card, coach context, preview, save payload, plan card, and placeholder derive from the same rows/state. | Yes | No |
| B3 | Failed effort import poisoning save | P0/P1 | Optional effort metadata can block exercise save and produce vague failure copy. | `public/app.js`, `/api/parse-workout-image`, `/api/complete-workout`, `/api/log-workout`, pending preview/write state, effort import UI. | Failed screenshot import does not block exercise save; manual effort replaces failed screenshot state; failure copy is specific; no exercise rows are lost. | Yes | No |
| B4 | Freestyle auto-guide / unwanted next-up behavior | P1 | User-led logging can silently become guided-session steering. | `public/coach-conversation.js`, `public/app.js`, session intent routing, next-exercise rendering, placeholder ownership. | Freestyle logging confirms/coaches/stops; "next up" appears only after explicit guided-session start, accepted plan, or user ask. | Yes | Yes |
| B5 | Apple Watch screenshot wrong date | P1 | Historical effort backfill can be saved under the wrong date/session identity and duplicate detection can target the wrong day. | `services/vision.js`, `/api/parse-workout-image`, `/api/complete-workout`, effort preview UI, duplicate detection/session identity logic. | Screenshot date extraction/display; ambiguous-date confirmation; historical dates persist correctly; duplicate detection uses intended final date. | Yes | No |
| B6 | Coach's Pick / Blind Spot wrong history | P1 | Recommendations and rationale contradict actual logged history, causing wrong workout prescriptions. | `services/analytics.js`, `services/underCoverage.js`, recommendation/blind-spot builders, exercise identity/enrichment, coach context/rationale. | HNR01/KR01 count as Core; recent Back Squat blocks inappropriate heavy squat; last-trained dates match `Log_Cleaned`; priority stack is enforced. | Yes | No |
| B7 | Active session resilience across app switching/refresh/lock | P1 | Normal gym interruptions lose state or risk duplicate writes on restore. | `public/app.js`, `public/coach-conversation.js`, storage/session restore helpers, service worker/cache interaction, pending preview/write state. | Restore active session, composer draft, pending input, confirmations, active plan, pending preview/write, failed optional effort; no duplicate write on restore. | Yes | No |
| B8 | Stale plan cards/placeholders | P2 | UI can suggest completed work or stale planned state, weakening trust in the session surface. | `public/app.js`, `public/coach-conversation.js`, `public/nav.js`, plan-card rendering, placeholder ownership. | Plan card and placeholder follow canonical session state; completed exercise is never suggested; placeholder clears after save. | Yes | Yes |
| B9 | Busy Next Exercise UI | P2 | Intrusive UI competes with the composer during user-led logging. | `public/app.js`, `public/coach-conversation.js`, CSS/UI rendering for next-exercise overlay/card. | Visual/behavioral regression covering quieter logging-mode presentation and no dominant overlay during freestyle. | Yes | Yes |
| B10 | Generic accessory/core coaching | P2 | Low-specificity coaching feels generic and can overstate confidence for accessory/core work. | `services/coach.js`, deterministic coach templates, `public/coach-conversation.js`, accessory/core facts from analytics. | Accessory/core coach copy is grounded in specific facts or stays quiet; no invented numbers or generic filler. | Yes | Yes |

---

## Execution Order

Use this order unless current repo evidence proves a dependency should change:

1. B1 duplicate writes / idempotent save
2. B2 canonical active session state
3. B3 failed effort import isolation
4. B4 freestyle should not auto-guide
5. B5 Apple Watch source date handling
6. B6 Coach's Pick / Blind Spot history correctness
7. B7 session restore/resilience
8. B8 stale plan card/placeholders
9. B9 Next Exercise UI simplification
10. B10 accessory/core coaching quality

---

## Dependency Map

- B1 comes first because corrupted rows poison progression, fatigue, PRs, recommendations, and trust.
- B2 likely affects B4 and B8 because UI surfaces derive from active session state.
- B3 should be isolated before screenshot/date polish.
- B7 restore work must not reintroduce duplicate writes.
- B9 and B10 are polish and should wait until trust-critical flows are stable.

---

## PR Sequence

### PR 1 - B1 duplicate workout rows / idempotent save

**PR title:** Fix duplicate workout writes and make save idempotent

**Scope:** Prevent duplicate `Log_Cleaned` rows under the same logical save across repeated taps, retries, refreshes, reconnects, failed previews, and resumed sessions. Ensure post-save totals match rows actually written.

**Out of scope:** Active session refactor, effort import behavior, screenshot date handling, recommendation logic, UI polish, schema changes, manual Sheet cleanup.

**Tests required:** Write-path regression with stubbed Sheets proving one logical save writes once; retry/double-submit does not append duplicates; duplicate-risk response fails closed; summary totals match written row count and volume.

**Owner live-test script:** In the app, log the June 26 style workout, trigger save once, try a repeated tap or reconnect/retry if safe, confirm one session ID and one copy of each row in the Sheet, and confirm totals are plausible.

**Merge criteria:** Tests pass; no schema change; no manual Sheet write; duplicate write risk fails closed; merge card marks owner live validation as post-merge required.

**Stop condition:** Any proposed fix requires changing the sheet schema, manually editing Sheets, or broad rewrite of save/session architecture.

### PR 2 - B2 canonical active session state

**PR title:** Align active session state across parser, UI, coach, preview, and save

**Scope:** Make confirmation cards, coach context, preview, save payload, plan card, and placeholder derive from one canonical active-session representation.

**Out of scope:** Idempotent write mechanics, effort import, screenshot OCR/date extraction, recommendation engine changes, broad composer redesign.

**Tests required:** Simulated session where Bench/Curls-style inputs cannot produce both success and "didn't catch" for the same input; preview/save payload matches visible confirmed rows; debug/session state matches UI.

**Owner live-test script:** Freestyle-log Bench, Rows, Dips, Curls, and Hanging Knee Raises; verify every acknowledged lift appears in preview/save and no contradictory warning appears for a confirmed lift.

**Merge criteria:** Canonical state is authoritative; no write-path/schema behavior change beyond reading the canonical state; tests cover visible UI plus underlying state.

**Stop condition:** The fix expands into a broad composer rewrite or requires changing the preview-approve-write trust contract.

### PR 3 - B3 failed effort import isolation

**PR title:** Isolate failed effort import from workout save

**Scope:** Keep optional effort screenshot/manual effort state independent from exercise save state. Let manual effort replace failed screenshot state and allow exercise save to continue without effort.

**Out of scope:** Date extraction polish, duplicate-write idempotency, active session unification, Effort schema changes.

**Tests required:** Failed screenshot parse with missing `active_calories` leaves exercise rows saveable; "log it" does not repeat the effort error for exercise save; manual effort clears/replaces failed screenshot state; copy is specific.

**Owner live-test script:** Log a normal workout, attach a screenshot likely to fail effort parsing, then continue without effort or enter manual effort; confirm exercises still save.

**Merge criteria:** Exercise save is not blocked by failed optional effort; no real writes in tests; no schema change; failure copy is specific.

**Stop condition:** The fix requires merging effort and exercise transactions or manually editing Sheets.

### PR 4 - B4 freestyle should not auto-guide

**PR title:** Stop next-up guidance during freestyle logging

**Scope:** In user-led logging, parse, confirm, coach, update session, and stop. Show next-up only for explicit guided-session start, accepted plan, user asks, or Coach's Pick.

**Out of scope:** Full composer-first redesign, stale placeholder cleanup beyond what is needed for B4, next overlay visual redesign, recommendation logic.

**Tests required:** Freestyle inputs do not render "next up"; guided-session inputs still can; "what's next?" still answers from active guided state.

**Owner live-test script:** Open composer without starting a plan; log Bench and Rows; confirm Atlas does not volunteer Face Pull/Hammer Curls/Leg Extension. Then ask "what's next?" in a guided session and confirm guidance still works.

**Merge criteria:** Logging intent and guided-session intent are separated; no write-path/schema changes; no broad composer refactor.

**Stop condition:** The fix depends on redesigning all composer flows or changing plan acceptance semantics.

### PR 5 - B5 Apple Watch source date handling

**PR title:** Preserve Apple Watch screenshot source date in effort import

**Scope:** Extract/show the workout date when visible, ask when ambiguous, and run duplicate detection/session identity against the intended final date instead of today.

**Out of scope:** Failed effort isolation already handled by PR 3; idempotent save; exercise save behavior; Effort schema changes.

**Tests required:** June 24/June 12 screenshot fixtures or representative OCR text save/preview under source date; ambiguous date requires confirmation; duplicate detection uses final date.

**Owner live-test script:** Import historical Apple Watch screenshots from June 24 and June 12; confirm preview shows the source date and the saved Effort rows use that date.

**Merge criteria:** Historical effort backfill is date-correct; ambiguous date is not silently guessed; no manual Sheet writes.

**Stop condition:** Reliable date handling requires new schema columns or the source screenshot lacks enough date signal and no confirmation UI is scoped.

### PR 6 - B6 Coach's Pick / Blind Spot history correctness

**PR title:** Correct Coach's Pick blind-spot history and recent-work blocking

**Scope:** Ensure Core and squat history are read correctly; HNR01/KR01 count as Core; recent heavy Back Squat blocks inappropriate squat prescription; blind spots are subordinate to recovery/fatigue, progression, muscle stimulus, and weekly balance.

**Out of scope:** Coach wording polish, generic accessory coaching, active session state, write paths, parser changes.

**Tests required:** Fixture with Core and Back Squat on 2026-06-24 prevents "Core 76 days ago" and blocks inappropriate heavy squat two days later; rationale exposes accurate last-trained evidence.

**Owner live-test script:** Run Coach's Pick after current history includes June 24 Core and Back Squat; confirm it does not claim Core is 76 days stale or prescribe heavy squats as if fresh.

**Merge criteria:** Last-trained facts match logs; recommendation rationale is grounded; no LLM invention; no write/schema changes.

**Stop condition:** Fix requires changing historical sheet data manually or adding new training philosophy beyond the existing priority stack.

### PR 7 - B7 session restore/resilience

**PR title:** Restore active workout safely across app switching and refresh

**Scope:** Preserve/restore active session, composer draft, pending input, confirmations, active plan, pending preview, pending write, failed optional effort, and unsaved rows across app switch, lock/unlock, and refresh. Show a restored-session notice with continue/discard.

**Out of scope:** Duplicate-write mechanics except preserving B1 guarantees; full offline mode; broad service-worker rewrite; manual Sheet writes.

**Tests required:** Storage/restore tests covering active session and pending write state; restore cannot trigger automatic duplicate append; discard clears local pending state only.

**Owner live-test script:** Begin logging a workout, switch to Photos/Apple Watch/Music, lock/unlock or refresh, return to Atlas, confirm restored state and no duplicate save.

**Merge criteria:** Restore is explicit and safe; no automatic write on restore; duplicate-write guard still passes.

**Stop condition:** Restore approach would bypass approve-before-write or reintroduce duplicate append risk.

### PR 8 - B8 stale plan card/placeholders

**PR title:** Keep plan cards and composer placeholders in sync with active session state

**Scope:** Make plan cards and placeholders follow canonical session state, never suggest completed work, and clear/update after save.

**Out of scope:** Active-session canonicalization if B2 is not complete; next overlay visual redesign; broad composer refactor.

**Tests required:** Completed exercise disappears from placeholder/plan card; post-save placeholder resets; user-led logging placeholder remains neutral.

**Owner live-test script:** Complete a planned lift, save or move forward, and confirm the card/placeholder no longer suggests that completed exercise.

**Merge criteria:** UI reads canonical state; no stale completed-lift prompt; no write/schema changes.

**Stop condition:** B2 has not established a canonical state source and this PR would need to invent one.

### PR 9 - B9 Next Exercise UI simplification

**PR title:** Simplify Next Exercise UI for user-led logging

**Scope:** Make next-exercise presentation quieter and less intrusive, especially in logging mode.

**Out of scope:** Guided-session state changes, recommendation logic, B4 routing, B8 stale-placeholder logic, visual overhaul outside next-exercise UI.

**Tests required:** Browser/visual QA for logging mode and guided mode; no overlay dominance during freestyle; guided flow still exposes next action when expected.

**Owner live-test script:** Log a freestyle workout and run one guided session; confirm the Next Exercise UI does not dominate freestyle but remains usable when guided.

**Merge criteria:** Visual behavior matches logging/guided mode; no code beyond next-exercise UI surface; no write/schema changes.

**Stop condition:** The change requires rebuilding the home screen/composer architecture.

### PR 10 - B10 accessory/core coaching quality

**PR title:** Ground accessory and core coaching or keep it quiet

**Scope:** Improve accessory/core coaching so it is specific and fact-grounded, or suppress generic filler when the engine has no meaningful fact.

**Out of scope:** New training-intelligence model, recommendation priority changes, Coach's Pick history correctness, write paths, parser changes.

**Tests required:** Coach-copy tests proving accessory/core responses include grounded facts when available and avoid generic unsupported advice when not.

**Owner live-test script:** Log Hanging Knee Raises, Curls, and similar accessory/core work; confirm coaching is specific when Atlas has signal and quiet when it does not.

**Merge criteria:** No invented facts; deterministic facts first; LLM only words grounded evidence; no schema/write changes.

**Stop condition:** The fix requires new coaching philosophy, new training model scope, or unscoped recommendation changes.

---

## Tiny Future Prompts

Use these copy/paste prompts for low-token future agent work:

```text
Read CLAUDE.md and docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md. Start PR 1 only: B1 duplicate workout rows / idempotent save. Do not touch B2-B10. Open one focused PR with tests and stop.
```

```text
Read CLAUDE.md and docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md. Start PR 2 only: B2 canonical active session state. Do not touch B1 or B3-B10. Verify current state first, open one focused PR with tests, and stop.
```

```text
Read CLAUDE.md and docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md. Start PR 3 only: B3 failed effort import isolation. Do not change screenshot date handling. Open one focused PR with tests and stop.
```

```text
Read CLAUDE.md and docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md. Start PR 4 only: B4 freestyle should not auto-guide. Do not do composer refactor work. Open one focused PR with tests and stop.
```

```text
Read CLAUDE.md and docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md. Start the next unmerged campaign PR only. Keep one concern per PR, do not touch Bug_Reports, do not manually write Sheets, and stop after opening the PR.
```

---

## Campaign Guardrails

- This document is a controller, not an implementation plan for a single mega-PR.
- Every implementation PR must rerun the current-state verification gate before editing.
- Do not use Bug_Reports evidence unless a later PR explicitly scopes it.
- Do not manually append, edit, delete, or clean Google Sheet rows.
- Do not change Sheet schemas unless the owner explicitly approves a schema migration.
- Do not reframe this campaign as MVP work.
- Do not broaden B9/B10 polish ahead of B1-B7 trust repairs.
