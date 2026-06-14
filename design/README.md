# Atlas — Design Reference

Standalone HTML mockups of the redesigned Atlas, plus the rules for turning them
into the live app. Each mockup is the **visual spec** for one screen: open it,
match it. They are reference only — never wired to the backend.

## How to use with Claude Code
1. Commit this `design/` folder to the repo.
2. For each screen, prompt: *"Rebuild <target> in public/ to match
   design/mockups/<file>, keeping all element IDs and /api/* calls. Visual only."*
3. Always start in **plan mode**; open a small PR; run `npm run lint && npm test`
   and the Playwright e2e suite.

## Global rules (apply to every screen)
- **Do the tokens first** (see Design System below) — it re-skins everything at once.
- **CSP**: `default-src 'self'`, no inline styles. Self-host fonts under
  `public/fonts/` and `@font-face` them; never `<link>` Google Fonts. No `style=""` —
  use utility classes (the `.mt-10` / `.mb-8` pattern from PR #230).
- **Never touch** the preview/approve/write trust loop, `/api/*`, auth, or Sheets.
- **Keep all element IDs** so app.js handlers and the e2e suite still bind.

## Design System (the foundation — implement first)
Palette (dark, primary look):
  bg #0A0B0E · surface #131419 · surface-2 #1B1D23
  border rgba(244,243,239,.09) · border-strong rgba(244,243,239,.16)
  ink #F3F2ED · muted #9A9A93 · faint #63635C
  accent (ember) #E8772E · accent-ink #120A04 · accent-soft rgba(232,119,46,.14)
  ok (green) #34C77B
Type:
  display 'Space Grotesk' — wordmark, headings, big weights
  mono 'JetBrains Mono' — ALL numeric/data (weight, reps, RIR, e1RM, dates, codes)
  body 'Inter' — UI text
Signature: the "load line" — one ember hairline reused (under the wordmark, as the
active-tab indicator, and as progress-to-goal bars).
Rule: render **RIR in the accent color** on every set (prescribed and logged) — it
is the key coaching cue.

## Screen map
- `01-identity.html` — the design system itself (palette, type, signature). Reference.
- `02-coach-home.html` — Coach surface `#tab-logger`. Calm, conversation-first home.
- `03-side-panel.html` — NEW left drawer from `#coach-menu-btn`. Top: readiness ticker
  (from `/api/plan/intent-recommendation` patterns). Then Views (Coach/Today/Trends/
  History/Body) each with a live status sub-line. Then recent sessions. New-session = `+`.
- `04-trends.html` — `#tab-progress`. NEW timeframe selector (Week/Month/YTD/All) that
  recomputes %, sparkline, and the climbing/holding/to-fix counts. Each lift row:
  `weight · e1RM · % since (period)` + sparkline. Keep `.lift-link` deep-links and the
  `#lift-drilldown-card` path.
- `05-history.html` — `#tab-history`. NEW cadence strip + week grouping with per-week
  totals. Drop phantom 0-set rows. Tap a session → set-by-set detail.
- `06-body.html` — `#tab-body`. NEW trend-first: current weight + 30d change + line,
  THEN a compact log button (keep the two-step preview/approve write). MOVE
  "Unrecognised Exercises" out to Settings → Data.
- `07-coaching-thread.html` — in-workout coaching. Prescription renders as a card
  (`.workout-plan` exists), set readback, RIR in ember, adjusted next exercise.
  IMPORTANT: NO per-set save/undo prompts during the workout — coaching only.
- `08-end-of-session-save.html` — the ONE save. Triggered by "done" / Apple Watch
  screenshot / manual effort. Atlas parses the whole conversation → full workout →
  single review + Save + Undo. This is where the existing preview/approve/write loop runs.
- `09-sme-learn.html` — SME layer (PR #230). `#learn-chips` in the hero (quieter than
  the action tiles). Tap → grounded answer in-thread with a **"Based on:" provenance**
  line naming the knowledge cards. Read-only; `/api/coach/ask`; never the write path.

## Note on the logging cadence (conflicts with current CONSTITUTION.md)
The intended flow is **session-level save, not per-set**: coaching during the workout,
one parse + approve + write + undo at the end. `docs/CONSTITUTION.md` currently defines
a per-entry "Logging Heartbeat" — update it to session-level so agents stop re-adding
per-set prompts. The safety law (no blind writes, approve before write) is preserved;
only the cadence moves from per-set to once-per-session.
