# UX Playtest — 2026-06-26 Live Gym + Composer Session

**Status:** Active record. This is the source-of-truth document for the 2026-06-26 live Atlas testing + brainstorming session (real app, real gym workout). It captures what happened, the bugs discovered, the product/UX direction, and a clean follow-up issue split.

**Type:** Docs / triage only. No code fixes, no composer refactor, and no bug-reporter work are part of this record. Implementation happens in separate, explicitly-requested PRs.

> **Evidence source.** Findings come from the **owner's live testing + brainstorming conversation** while using the actual app. They are **not** derived from sheet/tooling rows. (The in-app bug reporter is a separate tool and is intentionally out of scope here.)

---

## 1. What happened during real app testing

### Freestyle logging
The owner opened Atlas and went straight into the main composer to log a real workout, freestyle — no guided session requested. Slash notation parsed well:
- `Bench 135 12 185 10 225 6/0 4/2 4/2`
- `Seated rows 195 10/2 x3`
- Weighted Dips, Curls, Hanging Knee Raises followed.

Parsing, confirmation cards, and inline coaching were generally good. But after the Bench entry Atlas volunteered **"Moving on — next up: Face Pull,"** and after Seated Rows, **"Moving on — next up: Hammer Curls"** — unprompted guided behavior the owner never asked for. Atlas also (at other points in the session) surfaced **Leg Extension** as a "next" suggestion. The owner was logging, not running a guided plan.

### Coach's Pick / Blind Spot behavior
Coach's Pick recommended **"Fix Blind Spots — Hinge and Core are fresh and overdue / Core 76 days ago"** and prescribed **Deadlift / Back Squat / Overhead Press**. This contradicted the actual training history (see §3 evidence): Core and Back Squat were both trained on 2026-06-24. The recommendation prescribed heavy squats two days after heavy squats, and the rationale ("Core 76 days ago") was factually wrong.

### Apple Watch screenshot import
Historical Apple Watch effort screenshots (from **June 24** and **June 12**) were imported but stamped with **today's date (June 26)**. The preview did not clearly show the *source* workout date, and duplicate-session detection appeared tied to the wrong (today's) date/session identity rather than the screenshot's actual date.

### Manual effort entry
When the screenshot effort import failed, manual effort entry was attempted. It behaved inconsistently: a manual entry eventually produced a preview, but the preview was missing logged exercises and the save then failed.

### Save / preview flow
- On save, the session summary showed **impossible totals (49 sets, 51,390 lb)** — duplicate workout rows were written under a single session ID (`20260626-PM-01`).
- Contradictory surfaces appeared mid-session: an exercise (Bench) was acknowledged/coached but later **missing from the final preview/save**; Curls were recognized and coached but Atlas also showed **"Didn't catch that lift — check the exercise name before saving."**
- A failed Apple Watch effort screenshot (`Preview failed: active_calories is required`) appeared to **poison the workout save** — a subsequent "log it" repeated the effort error instead of saving the exercises, and a later save failed with a vague `Write failed: Load failed`.

### App refresh / interruption behavior
During normal gym multitasking (opening Photos / Apple Watch to grab the effort screenshot), Atlas **refreshed / lost state**. Active workout context was not reliably preserved across the app switch.

### Composer / home-screen observations
The composer is where the real work happened — the owner logged, asked, and reacted there. This reinforced a product direction: the composer should be the primary interface, with tiles as shortcuts rather than separate workflows. Secondary UI friction was noted: the **Next Exercise UI / overlay felt overly busy**, plan cards and composer placeholders went **stale**, and some coaching language for **accessories/core was generic**.

---

## 2. Bugs discovered

| ID | Priority | Title |
|----|----------|-------|
| B1 | **P0** | Workout save duplicated rows under the same session ID (impossible totals 49 sets / 51,390 lb) |
| B2 | **P0/P1** | Active session state drifts between parser, UI, coach, preview, and save payload |
| B3 | **P0/P1** | Failed effort import poisons / blocks the workout save |
| B4 | **P1** | Freestyle logging incorrectly suggests the next exercise (auto-guide) |
| B5 | **P1** | Apple Watch screenshot import uses the wrong (today's) date instead of the source workout date |
| B6 | **P1** | Coach's Pick / Blind Spot engine uses wrong last-trained history |
| B7 | **P1** | Active workout does not survive app switching / refresh / lock screen |
| B8 | **P2** | Stale plan cards / stale composer placeholders |
| B9 | **P2** | Overly busy Next Exercise UI / overlay behavior |
| B10 | **P2** | Generic accessory / core coaching language |

### B1 — Duplicate workout rows (P0)
Save wrote duplicate rows under `20260626-PM-01`; the summary showed 49 sets / 51,390 lb. Duplicate rows corrupt the source of truth — progression, fatigue, volume, PR detection, deload logic, recommendations, and trust. **Expected:** each logical row is written exactly once; save is idempotent across repeated taps, retries, refreshes, reconnects, failed previews, and resumed sessions; if duplicate-write risk is detected, stop and ask rather than append; post-save totals match `Log_Cleaned` exactly.

### B2 — Active session state drift (P0/P1)
Parser, confirmation cards, coach, preview, save payload, plan card, composer placeholder, and validation disagreed. Bench was acknowledged but missing from preview; Curls were confirmed/coached yet also flagged "Didn't catch that lift." **Expected:** one canonical ActiveSession that every surface derives from; a success card and a "didn't catch lift" warning must never both fire for the same input.

### B3 — Failed effort import poisons workout save (P0/P1)
The Apple Watch screenshot failed (`active_calories is required`), and that failed-effort state blocked saving the exercises; "log it" repeated the effort error. **Expected:** exercise save and effort metadata are separate, independently recoverable transactions; a failed/optional effort import never blocks the workout save; manual effort replaces failed-screenshot state; failure copy is specific ("I couldn't read active calories. Add manually or continue without effort."), never a vague "Load failed."

### B4 — Freestyle auto-guide (P1)
In user-led/freestyle logging Atlas volunteered "next up" lifts (Face Pull, Hammer Curls, Leg Extension) without being asked. **Expected:** in logging mode — parse, confirm, coach, update session, **stop**. "Next up" only in an explicit guided session or when the user asks ("what's next?", taps Coach's Pick, accepts a plan, says "start").

### B5 — Screenshot import date (P1)
June 24 and June 12 screenshots were saved as June 26; preview did not show the source date; duplicate detection used today's identity. **Expected:** extract the workout date if visible; show it in preview; confirm if ambiguous; run duplicate detection against the intended final date/session, not today; historical backfill works.

### B6 — Blind Spot history correctness (P1)
Coach's Pick claimed "Core 76 days ago" and prescribed squats despite recent squats. History actually has Core on 2026-06-24 (Hanging Knee Raises → Core, lift_code HNR01) and Back Squat on 2026-06-24. **Expected:** HNR01/KR01 count as Core; recent bodyweight/core work is included; last-trained dates resolve accurately; recent squat work blocks an inappropriate heavy-squat recommendation; blind spots are one input, not the whole objective. Priority stack: recovery/fatigue → progression → muscle-group stimulus → weekly balance → blind spots → novelty.

### B7 — Session resilience (P1)
App switching to Photos/Apple Watch and accidental refresh lost active state. **Expected:** Atlas preserves/restores active session, composer draft, pending input, confirmation state, active plan, pending preview, pending write, failed-optional-effort state, and unsaved rows across lock/unlock, app switch, and refresh; a visible "restored session" notice; continue-or-discard; no duplicate write on restore. The gym is a hostile app environment — interruption is normal.

### B8 — Stale plan cards / placeholders (P2)
The plan card kept showing stale step info after an exercise was completed, and the composer placeholder kept suggesting a completed lift (`Hammer Curls 40 11/2 11/2 11/2`). **Expected:** plan card and placeholder follow canonical session state; placeholder never suggests a completed exercise and clears after save; in user-led logging the placeholder reads like "Log another lift, ask anything, or say done."

### B9 — Overly busy Next Exercise UI / overlay (P2)
The Next Exercise UI / overlay felt cluttered/intrusive during logging. **Expected:** quieter, less intrusive next-exercise presentation, consistent with user-led logging (it should not dominate when the user is just logging).

### B10 — Generic accessory/core coaching language (P2)
Coaching for accessories/core read generically vs the strong, specific coaching seen elsewhere (e.g. the fatigue read on pressing). **Expected:** accessory/core coaching is as specific and grounded as compound coaching, or stays quiet rather than generic.

---

## 3. Evidence (history that contradicts Coach's Pick)

- Spreadsheet: **Atlas MASTER**, ID `1XQaKGJL5uoE3yFw4Z0wiSfAlc-JnufS2Z7psODuDcA0`.
- `Log_Cleaned` has **Core on 2026-06-24** (Hanging Knee Raises, muscle_group Core, lift_code HNR01, 3 sets, session `20260624-PM-01`), plus Core on 2026-06-18 / 06-11 / 06-09 / 06-07.
- `Exercise_Catalog` maps Hanging Knee Raises → Core.
- `Log_Cleaned` has **Back Squat on 2026-06-24**.
- Therefore "Core 76 days ago" and the heavy-squat prescription two days after a heavy squat are both wrong.

### Corrected June 26 session (after manual cleanup)
- **Bench Press — 5 sets:** 135×12, 185×10, 225×6 @ RIR 0, 225×4 @ RIR 2, 225×4 @ RIR 2
- **Seated Rows — 3 sets:** 195×10 @ RIR 2 ×3
- **Weighted Dips — 3 sets:** +60×8 @ RIR 2 ×3
- **Curls — 3 sets:** 35×12 @ RIR 2 ×3
- **Hanging Knee Raises — 3 sets:** 20 reps ×3

---

## 4. Product / UX insights

- **Atlas should become composer-first.** The composer is the product; move the home screen away from tiles as the primary workflow toward one composer (plus button for attachments/manual entry, a send button, optional grey placeholder examples like "Just log my workout…", "What did I lift last time?", "Let's do a chest day…", "Import my Apple Watch workout…").
- **Tiles are shortcuts / hidden prompts, not separate workflows or state machines.** Freestyle = focus the composer (no preloaded workflow); Coach's Pick = a hidden "review my recent history, fatigue, progression, and goals, then recommend today's workout" prompt; Screenshot import = an attachment-led composer flow.
- **One composer, one session engine; intent routing decides behavior.** Do not build a separate state machine per tile.
- **Logging intent must not become guided-session intent.** Logging a lift is not a request to be guided to the next lift.
- **The coach never steals the steering wheel — the user hands it over.**
- **User-led logging: parse, confirm, coach, stop.** No "next up" unless guided.
- **Guided mode only starts when the user explicitly asks or accepts a plan** (Coach's Pick, "start", "what's next?", accepted plan).
- **App switching is normal gym behavior.** Apple Watch / Photos / Music / lock screen / notifications / flaky network / accidental refresh are expected; Atlas must survive them and restore state safely.

### Intent model (target)
1. **Information** — "What did I bench last time?" → answer and stop.
2. **Logging** — "Bench 225 5/2 x3" → parse, confirm, coach, stop.
3. **Planning** — "Give me a chest workout" → propose a plan, do not start.
4. **Guided session** — user explicitly starts/accepts a plan → Atlas may queue and guide.

---

## 5. Suggested issue split (recommendations only — not implemented in this PR)

1. **P0 — Workout save duplicated rows under same session ID.** (B1) Idempotent writes; no duplication on retry/refresh/double-tap/failed-effort/resume; post-save totals match `Log_Cleaned`.
2. **P0/P1 — Active session state drifts between parser, UI, preview, and save payload.** (B2) One canonical ActiveSession; no contradictory success-card + "didn't catch lift."
3. **P1 — Composer should not auto-suggest next exercise during freestyle logging.** (B4 + B8 placeholder) Intent routing; "next up" only when guided or asked; placeholder follows state and clears after save.
4. **P1 — Apple Watch screenshot import should preserve source workout date.** (B5) Extract/show date; confirm if ambiguous; duplicate detection vs intended final date.
5. **P1 — Failed effort import must not block workout save.** (B3) Separate exercise/effort transactions; manual effort replaces failed screenshot; specific failure copy.
6. **P1 — Coach's Pick / Blind Spot engine reports incorrect last-trained history.** (B6) HNR01/KR01 count as Core; accurate last-trained; recovery-aware priority stack.
7. **P1 — Active workout must survive app switching, refresh, and lock screen.** (B7) Preserve/restore session with a visible notice; no duplicate write on restore.
8. **UX — Move Atlas toward one composer-first home screen.** (insights §4; also folds in B9 Next-Exercise overlay and B10 accessory/core coaching polish.) Do after the trust-critical work.

---

## 6. Do not regress (behaviors that worked well)

1. Confirmation cards (when they appear).
2. Green "Workout written to Google Sheets" success card.
3. "Saved to your sheet ✓" feedback.
4. Inline coaching after a lift.
5. Specific fatigue coaching (e.g. "You went to zero and reps dropped after. Pressing is yellow now. Hold the load and clean up reps.").
6. Progression notes ("no progression in 3 sessions — consider a deload").
7. Direct slash-notation parsing for Bench, Seated Rows, Weighted Dips, Curls, Hanging Knee Raises.
8. The post-save card (valuable once the underlying data is accurate).

Do not remove useful coaching/card behavior while fixing the state/idempotency bugs.

---

## 7. Out of scope for this PR

- This is a docs/triage record only — **no code fixes** unless the owner separately requests an implementation PR.
- **No composer refactor.**
- The in-app **bug reporter is out of scope entirely** for this work (separate tool); its sheet/headers are not touched here, and its test rows are not used as evidence.
