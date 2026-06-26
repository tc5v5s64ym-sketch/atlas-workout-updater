# Investigation — coach render-order & completion-flow (owner live session 2026-06-25, second run)

**Status:** read-only investigation. No code changed. Proposes fixes; builds nothing.
**Model:** Opus 4.8. **Scope:** coach-render / composer / done-flow (`public/coach-conversation.js`, `public/app.js`).

> **Live trust verdict (this session):** G1 (no silent merge), G2 (coach addresses both stacked lifts), G4 (no fabricated units) all **PASS** live — warm-ups tagged, no phantom PR, all lbs, stacked entries split into separate cards. The two remaining issues are **render-order (FA)** and **completion-flow (FB)**, plus the carry-over **G3 (FC)**.

---

## TL;DR — root-cause groups

| Finding | Root | Module | Touches save/done path? | Severity |
|---|---|---|---|---|
| **FA — cards batched, not interleaved** | render-loop structure: all readback **cards** are rendered in one pass, coaching in another | `coach-conversation.js` `handleSetLogged` | **No** (in-workout narration; never writes) | **UX-only, low risk** |
| **FB — screenshot upload doesn't count as "done"** | screenshot ingest is a **separate handler** that stages effort and returns, prompting for "done" | `public/app.js` submit handler | **Yes** — it's the completion trigger | **Higher risk — flag** |
| **FC (= G3)** wrong "Next" / premature "done" | next-up/closeout gating (already filed) | `handleSetLogged` | partial (closeout gating) | (cross-ref only) |

**FA and FB are independent** (different modules, different concerns) — proof below. **FC/G3 does not share a code root with either** — it's the next-up/closeout *gating* logic, distinct from FA's render order and FB's screenshot trigger; cross-referenced, not re-filed.

---

## FA — coach output grouped, not interleaved

**Root cause (render-loop structure, code-proven):** in `handleSetLogged` (`public/coach-conversation.js`):
1. **All readback cards first** — line **1020–1022**: `for (const ex of exercises) { bubble.insertBefore(buildReadback(...), body); }` inserts every lift's card *before* `body`, so they cluster at the top: `[card A][card B]`.
2. **Then the primary lift's coaching** — line **1024+**: `const primary = exercises[0]` → `getInWorkoutNote` → typed into `body`, then its effort line (1082–1087) and next-prescription (1089–1091).
3. **Then the additional lifts' coaching** — line **1101+**: `for (const ex of exercises.slice(1))` appends each additional lift's note + next-prescription *after* `body` (the G2 loop).

So the DOM order is **`[all cards] → [all coaching]`**, not card+coaching+next paired per exercise. This is a **render-loop structure** (cards looped in one pass, coaching in another), **not** a data-shaping issue — `exercises` already carries each lift's sets in order; nothing about the data prevents interleaving.

**Exact change needed:** render per exercise in sequence — for each lift, emit its readback card, then its coaching note, then its "Next" — instead of the cards-first loop + separate coaching passes. Concretely: replace the 1020–1022 cards loop + the primary/slice(1) split with a **single ordered loop over all `exercises`** that, per lift, appends `buildReadback` → `getInWorkoutNote` prose → `buildNextPrescription`; keep the session-level handoff/closeout (1114+) running **once** after the loop. (The substitution handling currently keyed to the primary would need to move into the per-lift step or stay primary-only — a wording detail, not a structural blocker.)

**Pure render-order, NO data/write-path impact — confirmed.** `handleSetLogged` is the **in-workout narration** path; the file header states it does "NO Save/preview/approve — the only Save is the end-of-session review card." Every call it makes is read-only: `buildReadback`/`buildNextPrescription` (DOM), `getInWorkoutNote` → `POST /api/coach/message` (`writeCapable:false`, `config/routes.js`), `fetchReaction` (read). No `beginWrite`/`write_id`/Sheets write anywhere in this path. **FA is render/UX only.**

---

## FB — screenshot upload should count as "done"

**Root cause (separate handler that stages, then returns — code-proven):** the closeout prompt (emitted in `handleSetLogged`, `coach-conversation.js:1168–1169`) says *"Say 'done' or take a screenshot to save."* But in `public/app.js` the two are **separate handlers**:

- **"done" detection:** `looksLikeLogIt` (`app.js:1650`) → matched in the submit handler (`app.js:4254`) → `handleLogIt` (`3905`) → `runCloseout` (`3916`), which builds the rows from `sessionLog`, sets `sessionCompiledAwaitingPreview`, and dispatches the form submit that drives **preview → approve → write**.
- **screenshot ingest:** in the submit handler, when a file is attached during closeout (`app.js:4298–4309`, gated on `isPlanCloseoutAwaitingSave()`), it **stashes** the file (`closeoutScreenshotFile = file`), reads effort into `closeoutScreenshotEffort` via `parseWorkoutImage`, sets status **"Effort read from screenshot. Say done to preview…"** (`4304`), and **`return`s** — it does **not** trigger the closeout.

So a screenshot upload **stages effort and waits for a separate "done"** — exactly FB. The completion signal the owner expects (the screenshot itself) is treated as effort-attachment only.

**Proposed behavior:** after the screenshot effort is staged in that branch, **invoke the existing closeout** (`handleLogIt()`) instead of returning with "say done" — so the upload drives the same preview→approve→write the "done" command would.

**Risk (touches the completion trigger — flagged, NOT cosmetic):**
- It reuses the **existing** closeout path (`handleLogIt` → `runCloseout` → submit → preview → approve → write). **No new save path**, so the write-path idempotency (`write_id`) is not itself modified.
- **Double-save / race must be verified:** today, the staged screenshot effort is consumed by the closeout the user triggers with "done." If the upload auto-triggers closeout, a subsequent manual "done" must be a **no-op** — `runCloseout` already guards this: after a save `lastWrite` is set and `sessionLog` is reset, so a later "done" hits the `if (lastWrite)` branch → *"Nothing new to log"* (`app.js:3935–3938`), and the `write_id` guard backstops the write itself. The auto-trigger must drive **one** closeout (respect the existing `sessionCompiledAwaitingPreview` / `isPlanCloseoutAwaitingSave` guards at `4298`) and not race a second preview. **This is approve-before-write, so the upload would still surface a preview the owner approves — it does not silently write.** Confirm in a live test that (a) upload → preview appears with effort, (b) approving writes once, (c) a stray later "done" doesn't double-write.
- **Open question for Dale:** should the screenshot upload go straight to the **preview** (approve-before-write preserved — recommended, matches the trust loop), or actually **complete the save** in one step? The investigation assumes *preview* (no change to the approval gate). If the owner wants one-tap save with no preview, that is a **trust-loop change** and a separate owner-gated decision.

---

## FA vs FB — independent (proof)

- **FA** lives entirely in `coach-conversation.js` `handleSetLogged` (the per-set narration bubble) and concerns **render order** of read-only elements.
- **FB** lives in `public/app.js` (the submit handler + `runCloseout`) and concerns the **completion trigger / save**.
- Different files, different modules, no shared function. The only thread between them is a **string**: the closeout *prompt* ("Say 'done' or take a screenshot to save") is emitted by `handleSetLogged` (1168–1169) while the screenshot *handling* is in `app.js` — but that is just the prompt text, not shared logic. **Independent.**

## FC (G3) — shared root?

**No shared code root.** G3 (wrong "Next" / premature "say done") is the **next-up/closeout gating** in `handleSetLogged` (`getNextExerciseInPlan` / `detail.nextPlanned` / `planIsComplete`, ~1114–1131) — distinct from FA's render-order loop (same file, different logic) and from FB's screenshot trigger (different file). FB and G3 are both in the **completion-flow family** conceptually (when/whether the session is "done"), but the code paths are separate: G3 = *when the closeout prompt fires*; FB = *what triggers the save*. Cross-referenced to the existing G3 BACKLOG item; **not re-filed**.

---

## Proposed fix order

1. **FA — interleave coach output per exercise.** *Slice:* in `handleSetLogged`, render `card → coaching → next` per lift in one ordered loop; keep the session-level handoff/closeout once after. *Risk:* **render/UX only, no write path** (confirmed). *Size:* **M** (restructures the bubble assembly; must preserve single-lift output and the G2 "every lift coached" behavior). *Model:* **Opus** (it touches the coach-render structure and must not regress G2/single-lift). *Live-test card:* **Yes** (verify per-exercise blocks + single-lift unchanged).
2. **FB — screenshot upload triggers closeout.** *Slice:* in the `app.js:4298` branch, after staging the screenshot effort, call `handleLogIt()` instead of returning with "say done." *Risk:* **higher — touches the completion trigger / save flow** (reuses the existing path; must not double-save or race a later "done"; preview→approve→write preserved). *Size:* **S–M** (small code change, large care). *Model:* **Opus** (completion/save-adjacent correctness). *Live-test card:* **Yes, required** — upload screenshot at closeout → preview appears with effort → approve writes once → a later "done" is a no-op. **Resolve the open question first** (preview vs one-tap save).
3. **FC (G3)** — already filed; no change here.

---

## Open questions for Dale (not derivable from the repo)

1. **FB intent:** should a closeout screenshot go to the **preview** (approve-before-write preserved — recommended) or **complete the save in one step** (a trust-loop change)? This decides FB's scope and risk.
2. **FA substitution wording:** when a substitution is present on a stacked entry, should the sub acknowledgement attach to its specific lift's block (per-exercise) or stay a single line? (A wording choice exposed by interleaving; today it's primary-only.)
