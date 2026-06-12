# Today Screen — Implementation Spec

This is the implementation contract for redesigning the **Today** tab (`#tab-dashboard`).
An implementation agent should be able to build the screen from this document alone,
without making product decisions. It is a UI/layout spec only: **no backend changes,
no new endpoints, no new disclosure mechanics.** Every element maps to an endpoint that
already exists today.

Companion read: `CLAUDE.md`, `docs/CONSTITUTION.md` (product laws), and the current
`public/index.html` / `public/app.js` dashboard functions.

---

## 1. Problem this solves

The current Today tab stacks nine cards of roughly equal weight — lifetime totals
(`Training Snapshot`) outrank the actual daily question (`What to train today`), and a
12-card `Current Lift Targets` grid duplicates the intent grid's job. The screen answers
"here is everything" instead of "should I train today, and what?"

The redesign establishes a clear hierarchy: **one glanceable answer above the fold, the
supporting detail folded below it.** It reuses the existing glance-card pattern
(`<details class="card glance-card">` with a one-line `glance-hint`) — do not invent new
disclosure mechanics.

---

## 2. Above-the-fold hierarchy (390px viewport)

In source order, top to bottom. These four elements must all be visible without scrolling
on a 390×844 viewport (iPhone 12/13/14 logical size).

### 2.1 Readiness strip — pattern dots
- **Source:** `GET /api/plan/intent-recommendation` → `data.todays_read.patterns[]`.
  Each pattern: `{ pattern, label, status, daysSince, detail }`.
- **Render:** the existing `renderTodaysRead` dot row (`pattern-dots`) — one dot per
  movement pattern, colored by `status` (`fatigued | recovering | ready | fresh | unknown`),
  with the plain-language label beneath (`FRIENDLY_PATTERN_LABELS`) and the friendly status
  word (`FRIENDLY_STATUS_WORDS`). Keep the existing dot + label + status structure.
- **No heading** above the dots, or a very small one ("Readiness"). The dots are the
  first thing the eye lands on.

### 2.2 Today's pick — recommended intent card
- **Source:** same response. `data.todays_read.recommended_label` and
  `recommended_reason`, plus the recommended intent object from `data.intents[]`
  (`intents.find(i => i.recommended)`).
- **Render:**
  - Headline: `Today: {recommended_label}` (e.g. "Today: Build Strength").
  - Up to **two** `why_today` lines from the recommended intent (`intent.why_today.slice(0, 2)`).
    Plain language; no jargon. If `why_today` is empty, fall back to `recommended_reason`,
    then to `intent.focus`.
  - This card is visually the hero of the screen (largest weight).

### 2.3 Primary action — START SESSION
- **One** primary button, full-width, directly under the pick card.
- **Behavior:** start the recommended intent's first exercise via the existing bridge.
  Reuse `startLift(exercise, liftCode, weight, reps, sets)` with the recommended intent's
  `exercises[0]` (`exercise`, `lift_code`, `next_target.{weight,reps,sets}`), exactly as
  `openIntentDrawer`'s START SESSION button does today. This pre-fills the Coach composer
  and switches to the Coach surface — no write occurs.
- If the recommended intent has no startable exercise (`exercises[0].next_target` missing),
  the button label becomes **"See options"** and tapping it opens the intent drawer for the
  recommended intent (existing `openIntentDrawer`). Never render a dead button.

### 2.4 Consistency line — one line
- **Source:** `GET /api/progress/summary` → `{ current_week_sessions, streak_target_per_week,
  weekly_streak }`.
- **Render:** a single line, e.g.
  - Streak active (`weekly_streak > 0`): `🔥 {weekly_streak}-week streak · {current_week_sessions}/{target} this week`
  - Streak paused: `{current_week_sessions}/{target} sessions this week · {remaining} more to restart your streak`
  - `target = streak_target_per_week || 3`; `remaining = max(0, target - current_week_sessions)`.
- This **replaces** the full Training Snapshot metric grid above the fold. The grid moves to
  a drill-down (§3.1).

---

## 3. Below the fold (folded detail)

All below-fold sections use the existing `glance-card` pattern: a `<details>` with a
`<summary>` carrying a title + one-line `glance-hint` + chevron, and the full content inside.
Default **collapsed**. Order, top to bottom:

### 3.1 This week (consistency drill-down) — `glance-card`
- **Hint:** the same headline as the consistency line, or `Avg {average_sessions_per_week}/week`.
- **Open content:** the existing `renderProgressSnapshot` body — metric tiles
  (`total_sessions`, `average_sessions_per_week`, `total_sets`, `current_week_sessions/target`),
  streak sub-line, and the 12-week `consistency-strip` (`sessions_by_week`).
- **Source:** `GET /api/progress/summary` (already fetched for the consistency line — reuse
  the response, do not fetch twice).

### 3.2 Other ways to train — intent grid → drawer
- **Source:** `data.intents[]` from `intent-recommendation` (already fetched).
- **Render:** the existing `renderIntentGrid` tiles, **excluding** the recommended intent
  (it's already the hero in §2.2) — or include all and visually de-emphasize the recommended
  one. Tapping a tile opens the existing `openIntentDrawer` (unchanged). Keep the "Tap any
  tile to see the coaching brief and start a session" helper line.
- The intent drawer is where per-exercise **targets** live now (it already lists
  `intent.exercises[].next_target`). This is why the standalone `Current Lift Targets` grid
  is removed (§4).

### 3.3 Watchouts — `glance-card`
- **Source:** `GET /api/stalls?minSessions=3` → `data.stalls[]`.
- **Hint:** `{n} lift{s} could use a change` or `All clear ✓`.
- **Open content:** the existing `loadStalls` table (lift, sessions stalled, last best weight,
  since). Lift codes remain `.lift-link` deep links into Progress.

### 3.4 This week's training — merged weekly card — `glance-card`
- **Merge** today's separate "This week" (`weekly-summary`) and "Coach's notes" (`coaching`)
  into **one** card.
- **Sources:** `GET /api/summary/weekly` → `{ highlights[], muscleGroupBreakdown }` and
  `GET /api/coaching/insights` → `{ fatigue, deload_suggestions[] }`.
- **Hint:** the first weekly highlight, or `fatigue.status === 'high' ? 'Ease off this week' : 'On track ✓'`.
- **Open content:** highlights list + the muscle-group volume bar chart (`svgBarChart`), then
  the fatigue read (`fatigue.status`, `fatigue.ratio`, `fatigue.guidance`) and any deload
  suggestions. Reuse the existing `loadWeeklySummary` + `loadCoaching` render bodies, stacked
  inside the one card.

### 3.5 Highlights — `glance-card`
- **Source:** `GET /api/prs/recent` → `data.prs[]`.
- **Hint:** `{n} personal best{s} 🎉` or `Your bests will land here`.
- **Open content:** the existing `loadRecentPrs` table (lift, best weight, best reps, best est. 1RM).

### 3.6 Recent sessions — `glance-card`
- **Source:** `GET /api/history/recent?limit=10` → `data.recent_sets[]`.
- **Hint:** `Last: {exercise} · {date}` or `Nothing logged yet`.
- **Open content:** the existing `loadRecentHistory` table.

---

## 4. What is removed / demoted

| Element today | Disposition |
|---|---|
| `Training Snapshot` metric grid (top of page) | **Demoted** to the consistency line (§2.4) + the "This week" drill-down (§3.1). Not above the fold as a grid. |
| `Current Lift Targets` (`#todays-plan`, up to 12 plan cards) | **Removed from Today.** Targets live in the intent drawer (`intent.exercises[].next_target`). `/api/plan/today` is no longer called by the Today tab. |
| Separate "This week" + "Coach's notes" glance cards | **Merged** into one weekly card (§3.4). |

> `/api/plan/today` may still be used elsewhere (e.g. PR-12 Progress lift list). This spec only
> stops the **Today tab** from rendering the lift-targets grid; it does not remove the endpoint.

---

## 5. Loading order & empty states

### Load order
On Today-tab activation (`loadDashboard`):
1. Fire `intent-recommendation` and `progress/summary` first — they feed the entire
   above-the-fold region. Render §2.1–§2.4 as soon as both resolve.
2. Fire the below-fold sources (`stalls`, `summary/weekly`, `coaching`, `prs/recent`,
   `history/recent`) in parallel; each fills its own glance card independently.
3. Each glance card shows its own `loading…` placeholder until its source resolves; a
   failed source shows `Could not load: {message}` inside that card only — never blanks the
   whole screen.

### No API key
If `getApiKey()` is empty: above-the-fold region shows a single prompt card —
"Set your API key in Settings to see today's plan." — and the glance cards show the existing
"Set your API key in Settings to load data." muted text. (Matches current `loadDashboard`
no-key behavior.)

### No data (new user)
- Readiness dots: if `patterns` is empty, hide the strip (don't render empty dots).
- Today's pick: if no recommended intent / no `recommended_label`, show "Log a few sessions
  and Atlas can start suggesting what to train." in place of the pick card, and hide
  START SESSION.
- Consistency line: `0/{target} this week — log your first session.`
- Glance cards: each keeps its existing empty-state copy (e.g. "No PRs recorded yet.",
  "No stalled lifts — keep it up.").

---

## 6. Stable element IDs (keep for tests)

Implementation may restructure markup, but these IDs/classes must remain addressable so the
Playwright suite can assert the above-the-fold region:

| ID / selector | Purpose |
|---|---|
| `#tab-dashboard` | the Today tab section |
| `#todays-read` (or `.pattern-dots`) | readiness strip container |
| `#todays-pick` | recommended-intent hero card (new; add this id) |
| `#start-session-btn` | the single primary action button (new; add this id) |
| `#consistency-line` | the one-line consistency summary (new; add this id) |
| `.glance-card` | every below-fold folded card |
| `#intent-grid` | the other-intents grid container |
| `#intent-drawer` | the existing drawer (unchanged) |

New IDs (`#todays-pick`, `#start-session-btn`, `#consistency-line`) are introduced by the
implementation PR; the rest already exist in `public/index.html`.

---

## 7. Explicit non-goals

- No backend changes, no new endpoints, no response-shape changes.
- No new charting; reuse `svgLineChart` / `svgBarChart`.
- Do not weaken or touch the Coach trust loop (preview/approve/write).
- Do not remove `/api/plan/today` or any endpoint — this is a Today-tab rendering change only.
- Do not restyle the global header, segmented control, or sub-nav.
- One streak signal only; no badges, counters, or gamification beyond the existing 🔥 streak.
