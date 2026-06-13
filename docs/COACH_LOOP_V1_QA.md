# Coach Loop v1 — QA & Consolidation Review

A user-experience review of the Coach surface and the workout logging flow after
Coach Loop v1 shipped across PRs #157, #158, #159, #160, #161, #162.

- **Scope:** review only. No feature work, no new cards, no new endpoints.
- **Date:** 2026-06-13
- **Checks run:** `npm test` → **412 passing, 0 failing**. `npm run lint` → **passing**.

---

## What shipped (recap)

| Moment in the flow | Surface | PR |
|---|---|---|
| Before — what to train today | Today's Plan card (`#coach-plan-card`) | #157 |
| Before — week so far | Weekly Coach Check-in card (`#weekly-coach-card`) | #162 |
| While editing a set | Live "Next:" hint under each set row | #160 |
| At preview (review-before-save) | Per-exercise "Last / Hint" cards | #159, #161 |
| After save | Coach verdict (PR → stall → trend → next → fallback) | #158 |

All five draw on existing read-only endpoints (`/api/plan/*`, `/api/recommend/next/:liftCode`,
`/api/exercises/last-session`, `/api/report/weekly`, `/api/coaching/insights`, `/api/prs/recent`,
`/api/stalls`). All degrade quietly on failure and never touch the write/approve/undo path.

---

## Per-area review

**1. Coach surface layout & order.** On the Coach surface the vertical order is:
greeting → subtitle → read-strip (`#coach-read-strip`) → Today's Plan card → Weekly
Check-in card → suggestion chips → conversation thread → sticky composer. The arc reads
sensibly (today → this week → act). The composer is `position: sticky; bottom`, so it stays
reachable no matter how tall the cards get — good.

**2. Today's Plan card.** Clear and well-shaped: Focus + reason, the lift to pick back up,
last working set, next target, and a plain-English suggestion. Hides cleanly without an API
key or data.

**3. Weekly Coach Check-in card.** Reads well as a single glanceable line plus one nudge.
The volume-trend clause is honestly sourced (fatigue ratio vs recent average, rendered as a
%). Zero-session weeks get a quiet, still-useful fallback.

**4. Live next-set hint while editing.** Strong "during the workout" touch. The `Last:` +
`Next:` lines appear under the set-row exercise input, sourced from a once-per-session
cached `/api/plan/today` lookup with a stale-result guard. Cheap and fast.

**5. Review-before-save coaching hints.** Per-exercise `Last:` + `Hint:` cards render below
the DRY-RUN proof, one `/api/recommend/next/:liftCode` call per unique lift, best-effort.
Safe DOM throughout.

**6. Post-save coach verdict.** Deterministic, prioritized (PR in the saved session → stall
→ trend → next → fallback). Sits below the unchanged undo button and read-back proof.

**7. Mobile / small-screen readability.** Cards reuse `.card` / `.coach-plan-card` and
stack vertically — fine. Caveat: read-strip + Today's Plan card + Weekly card is up to three
coaching blocks above the chips, so on a short screen the composer and chips sit well below
the first fold (mitigated by the sticky composer). `.last-time-hint` was relaxed to wrap two
lines (max-width 240px), which is correct for the new `Next:` line.

**8. Failure states.** Solid. Every coach surface uses `Promise.allSettled` or a
try/catch that hides the card or drops the affected piece. A failed coaching fetch cannot
block logging, preview, or save. Verified by reading each loader's guard clauses.

**9. Duplication / noisy copy.** A few small overlaps — see below.

**10. Does logging still feel fast?** Yes. The composer is always reachable; coaching is
appended asynchronously and never gates input. Server-side `sheetRowsCache` (TTL, invalidated
on write) means the several overlapping reads on load mostly hit cache. The redundancy is in
extra HTTP round-trips and recompute, not in Sheets reads.

---

## What feels good

- The before → during → preview → after arc genuinely makes Atlas feel like a coach, not a logger.
- Consistent, safe rendering (`el()` / `textContent`), consistent "hide when empty" behavior.
- Recommendation logic is shared (`recommendNextSet`), so the same lift's advice is consistent
  across the plan card, live hint, preview hint, and verdict.
- Trust loop is untouched: coaching always renders *around* the DRY-RUN proof / approval /
  undo, never inside it.

## What feels noisy or duplicated

- **Today's focus shows twice.** The read-strip renders `Today: <label>` (from
  `renderCoachReadStrip`) directly above the Today's Plan card's `Focus: <label>` line — the
  same recommended label, stacked.
- **Stale preview section header.** The preview coaching block is titled
  **"Last time vs today"**, but #161 removed the per-card "Today" line — cards now show only
  `Last:` and `Hint:`. The header now over-promises a comparison the cards no longer display.
- **Three stacked cards on first load.** read-strip + Today's Plan + Weekly is a lot of
  read-only content before the chips/composer on the primary (logging) surface.
- **Overlapping init fetches.** On load, `loadDashboard()`, `loadCoachPlan()`, and
  `loadWeeklyCoach()` independently call `/api/plan/intent-recommendation` (×2) and
  `/api/coaching/insights` (×2). Harmless (cache-cushioned) but redundant.

## Bugs or risks

- **(Copy) "Last time vs today" header is inaccurate** after #161 — low severity, visible.
- **(Staleness) Live-hint cache not invalidated after a write.** `planTodayByNameCache` (and
  `lastTimeCache`) persist for the session, so the `Next:`/`Last:` hint can show pre-write
  numbers right after you log that lift. Low severity (the post-save verdict covers the
  "after" moment), but it can momentarily contradict what was just saved.
- **(Density) Above-the-fold weight on small screens** — no functional bug; the sticky
  composer mitigates it, but it slightly dilutes the "fast logger" feel.
- No correctness, write-safety, or data risks found. Failure handling is consistent and safe.

## Recommended tiny follow-up PRs (max 5)

1. **Fix the preview header copy.** Rename "Last time vs today" → e.g. "Coaching" or
   "Last vs recommended" so it matches the `Last:` / `Hint:` cards. (Copy-only, ~1 line.)
2. **De-duplicate today's focus.** On the Coach surface, drop the `Today: <label>` text from
   the read-strip (keep the pattern dots) *or* drop the Plan card's `Focus:` line — keep one.
3. **Invalidate the live-hint caches on successful write.** Clear `planTodayByNameCache` and
   `lastTimeCache` in the post-save path so the next set row reflects what was just logged.
4. **Dedupe overlapping init fetches.** Share one `intent-recommendation` and one
   `coaching/insights` result across `loadDashboard` / `loadCoachPlan` / `loadWeeklyCoach`
   (small client-side memo), trimming redundant round-trips on the Coach surface.
5. **Tighten mobile density.** Make the Weekly Check-in card collapsible (or render it only on
   the Today tab) so the Coach surface leads with one card + composer on short screens.

### Which follow-up should be first

**#1 (preview header copy).** It is the only item that is an outright inaccuracy, it is the
smallest possible change, and it is zero-risk. **#2 (duplicate today's focus)** is the natural
close second — it is the most visible source of noise on the primary surface.

---

## Confirmation

**No application code was changed in this review.** The only file added is this document
(`docs/COACH_LOOP_V1_QA.md`). No changes were made to the parser, write path, dry-run /
`test_mode` semantics, approval-before-save, undo / read-back behavior, the row schema,
secrets, or Render environment variables. `npm test` (412 passing) and `npm run lint`
(passing) were run against the unchanged code.
