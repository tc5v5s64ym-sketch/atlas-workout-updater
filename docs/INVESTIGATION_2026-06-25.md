# Investigation — P0 coach-trust surface (owner live session 2026-06-25)

**Status:** read-only investigation. No code changed. Proposes fixes; builds nothing.
**Model:** Opus 4.8. **Scope:** parser, multi-exercise composer, coach-voice renderer, analytics/progression.

> **Data caveat (read this first).** The workout log lives in Google Sheets, not the
> repo, and this session has no live Sheets access. So I could **not** read the
> actual rows written for the Dips + Side Bend bubble. Where the real logged data is
> needed to confirm, I trace the **code path** and infer what the parser *would*
> produce from the stated input, and flag the unverified row as a **question for
> Dale** (see "Open questions"). I do not guess what was logged.

---

## TL;DR — root-cause groups

| Group | Findings | Root | Severity |
|---|---|---|---|
| **G1 — Parser exercise-boundary is alias-gated** | **F3, F5** | A stacked second exercise whose name is **not in `EXERCISE_ALIASES`** is not recognized as a boundary, so its sets merge into the first lift → fabricated PR off merged data | **P0 — data integrity + fabricated coaching** |
| **G2 — Coach note under-iterates** | **F1** | After a multi-exercise log the coach **reaction** is built from `exercises[0]` only, though a readback/card renders per exercise | **P1 — trust/UX (no data corruption)** |
| **G3 — Next-up / completion state** | **F2** | "Next" and the "say done" invite derive from plan-order/advisory/recap state that disagreed with the real queue | **P1 — trust/UX (needs live state to pin)** |
| **G4 — Coach voice fabricates a unit** | **F4** | The LLM emitted "kg" although the prompt says lbs / no units; no kg exists in the engine | **P1 — trust (mislabels real numbers)** |
| **G5 — Card line wrapping** | **F6** | Pure CSS/display | **P3 — cosmetic** |

**The load-bearing call (F1 vs F3): they are DIFFERENT roots, proven below.** F1's split
**succeeded** (two cards, two readbacks) and the *coach prose* under-iterated; F3's split
**failed** at the parser (one card) and merged sets. One is a coach-loop bug, the other a
parser bug. → **two fixes, not one.**

---

## Findings with evidence

### F3 + F5 — same root (G1): alias-gated boundary merges a stacked unrecognized exercise

**Mechanism (code-proven):**

1. The parser splits a multi-exercise bubble only when **two distinct *recognized*
   exercises** are present. `hasMultipleExerciseMentions` (`services/workoutTextParser.js:166`)
   counts distinct canonicals from `findExerciseMentions` (`:136`), which matches **only
   names in `EXERCISE_ALIASES`** (`:11`).
2. `splitMultiExerciseSegments` (`:184`) likewise builds boundaries from those alias
   mentions (`firstIdxByCanon`, `:188`); if fewer than two distinct canonicals, it returns
   `null` (`:194`).
3. **"Dumbbell Side Bend" is NOT in `EXERCISE_ALIASES`.** It exists only in muscle/cost
   classification regexes — `services/liftCost.js:141`, `services/loadSanity.js:21`,
   `services/movementPattern.js:152` — never in the parser's recognition list. "Dips
   (Weighted)" **is** recognized (`services/workoutTextParser.js:36`,
   `['Dips (Weighted)', ['weighted dips','dips','dip','wd']]`).
4. Therefore, for a stacked bubble like
   `Weighted Dip 50 11/1 ×3 / Dumbbell Side Bend 70 15/1 ×3`, only **one** canonical
   ("Dips (Weighted)") is recognized → `hasMultipleExerciseMentions` is **false** →
   `parseLogSets` (`:474`) skips the multi-split branch and goes to the single-exercise
   path (`findExerciseInText`, `:508`). The trailing `70 15/1 ×3` — after the unrecognized
   words "dumbbell side bend" — is parsed as **more Dips sets**.

**Result:** Dips logs `50×11 …` then `70×15 …`; the `70` becomes a new max for Dips and the
progression/PR logic reports a personal record — **a fabricated PR off merged data**
(F5). The second exercise never becomes its own logged lift (F3). F5 is the coaching
*consequence* of the F3 parse failure: **same root.**

> **Two intake paths diverge — this matters for reconciling the live data.** There are
> two boundary mechanisms:
> - **Backend parser** (above): alias-gated → Side Bend is invisible → **merge**.
> - **Client display-block normalizer** (`public/displayBlockNormalizer.js`): boundaries
>   are **structural**, not alias-gated — a header line vs set lines (`isHeaderLine`,
>   `:94`; `normalizeDisplayBlocks`, `:157`). A *multi-line* paste with "Dumbbell Side
>   Bend" on its own line **would** split it into its own block (it is not prose per
>   `PROSE_WORD_RE`, `:106`, and ≤4 words). But for a **single inline line** (the format
>   above) the normalizer bails (`isDisplayBlock:false`) because the line starts with a
>   name, not a set, and no set lines follow a header → it hands off to the alias-gated
>   backend parser, which merges.
>
> So the outcome **depends on the exact input format Dale used.** F5's note that a later
> "Today's Workout" card shows Dumbbell Side Bend as a separate row is consistent with a
> *multi-line* paste being split by the normalizer on a different bubble/moment — but I
> cannot confirm which path ran for the merged Dips card without the real input text and
> the logged rows. **→ Open question 1 & 2.**

### F1 — different root (G2): the coach reaction iterates one lift

**Mechanism (code-proven):** `handleSetLogged` (`public/coach-conversation.js:1010`):
- `for (const ex of exercises)` builds a **readback per exercise** (`:1020–1022`) — this is
  why both Deadlift and Bench rendered.
- but `const primary = exercises[0]` (`:1024`) and the coach note (`getInWorkoutNote`,
  `:1055`) is built from `primary` only — `liftCode`, `exerciseName: primary.exercise`,
  `todaySets: primary.sets`, `rec` (first lift). **The coaching prose reacts to the first
  lift only.**

Both **Deadlift and Bench Press ARE in `EXERCISE_ALIASES`** (`:13`, `:15`), so the multi-split
**succeeds** — `parseLogSets` returns `log_sets_multi` with two exercises, and
`handleSetLogged` receives both (two readbacks/cards). The split is not the problem; the
**coach loop is.** A parallel single-lift assumption exists on the preview surfaces:
`renderLogWorkoutPreview` loops per code for the per-exercise cards (`public/app.js:4772`),
but the "Atlas suggestion" reaction keys off `completeLiftCodes[0]` (`public/app.js:4824`).

**Proof of distinct roots:** F1 = split succeeded (N exercises in `exercises`) + coach prose
on `exercises[0]`. F3 = split failed (1 exercise; the second never reached `exercises`).
Different files, different mechanisms: G2 is `coach-conversation.js`/`app.js` iteration;
G1 is `workoutTextParser.js` recognition. **Not the same defect.**

### F2 — independent session-state (G3), with a possible G1 interaction

Two "next" notions exist, neither sourced from the parse of a given bubble:
- **Literal plan order:** `getNextExerciseInPlan` (`public/coach-conversation.js:925`) walks
  the ordered plan map by index after the just-logged name (fuzzy fallback at `:934` can
  mis-resolve a shorthand).
- **Engine recommendation:** `next_move_advisory` (`:773`), an engine-computed *recommended*
  next move that **need not equal queue order** — surfacing this as "Next" would explain
  "Face Pull" appearing when the queued lift was Weighted Dips.

The "say done to save" invite vs. still-queued Single-Leg Curl: the recap/"remaining"
derives from the canonical session (`canonicalSessionRecap`, `public/app.js`; remaining
listed at `coach-conversation.js:1193`). A premature "done" means the completion gate /
cursor disagreed with the real remaining queue.

**Verdict:** G3 is **independent of the parse cluster** in its primary mechanism (it reads
plan/cursor/advisory state, not a bubble's parse). **But** there is a plausible interaction:
an exercise merged/unlogged by G1 (F3) never advances/clears its own slot, which can leave
the cursor and "remaining" out of sync. I **cannot** determine from code alone whether F2
was caused by the advisory-vs-queue confusion, a stale cursor, or a G1 side-effect — that
needs the actual plan + cursor/session state at that moment. **→ Open question 3.**

### F4 — independent (G4): the LLM fabricated a unit

The coach voice is told weights are lbs and to print **no units**:
`services/coach.js:966` — `"weight is in lbs (numbers only, no units in output)"`. There is
**no kg literal and no kg↔lb conversion anywhere in the coach path** (`services/coach.js`,
`services/coachVoiceRenderer.js`, `public/coach-conversation.js` — the only display unit is
`lbs` at `coach-conversation.js:336`). So "70kg / previous best of 50kg" is the **LLM
adding a unit word it was instructed not to emit** — a grounding/instruction-adherence
failure, **not** a deterministic conversion bug. The numbers (70, 50) are the real lb
values; only the "kg" suffix is fabricated. Independent of G1/G2/G3. (This is the
deferred kg→lb concern surfacing as an **output** problem, not an input one.)

### F6 — cosmetic (G5)

Deadlift/Bench wrapping across ~4 lines in the final "Today's Workout" card is pure
display/CSS layout of the card rows. No data implication — the underlying rows are
unaffected. Confirmed display-only.

---

## Severity re-rank (data-integrity / fabricated-coaching first)

1. **G1 (F3+F5) — P0, data-integrity + fabricated coaching.** A real second exercise's sets
   merge into the first lift and drive a **false PR**. This corrupts the logged training
   history *and* makes the coach assert something untrue. Highest priority — it violates the
   trust contract (valid gym input silently mis-logged; coaching fabricated off merged data).
2. **G4 (F4) — P1, trust.** Mislabels real loads with a wrong unit in the coach's own voice.
   No data corruption (numbers are right; the log is unaffected), but it reads as Atlas not
   knowing the lifter's units.
3. **G2 (F1) — P1, trust/UX.** A logged lift gets no coaching. No data corruption; the set is
   logged and carded. Erodes the "Atlas saw everything" feel.
4. **G3 (F2) — P1, trust/UX.** Wrong "Next" and premature "done" undercut session-state
   trust; needs live state to pin the exact cause before a fix.
5. **G5 (F6) — P3, cosmetic.**

---

## Proposed fix order (propose only — nothing built here)

> Each is the smallest safe slice. The high-risk files (`services/workoutTextParser.js`,
> `public/app.js`, `index.js` write path) are touched only where the slice names them, with
> tests proving the prior failure cannot recur. Several are **owner/P0-gated** because they
> sit on the parser/trust path.

1. **Fix G1 first — parser boundary must not depend solely on the alias catalog.**
   *Slice:* let `findExerciseMentions`/`splitMultiExerciseSegments` recognize a structural
   exercise boundary even when the second name is out-of-catalog (e.g. a "name followed by
   set tokens" boundary), **or** at minimum detect the merge-risk and **refuse to merge** —
   fall back to the clarification ask rather than silently absorbing the trailing sets into
   the first lift. Must never mis-log. *Risk:* **trust-critical** (slash-notation parser).
   *Size:* **M–L.** *Model:* **Opus.** *Live-test card:* **Yes** (stacked recognized+unrecognized
   bubble → both split, or an honest ask; never a merged false PR). **Owner-gated** (parser).
   - *Adjacent:* add "Dumbbell Side Bend" (+ obvious siblings) to `EXERCISE_ALIASES` is a
     cheap **mechanical/Sonnet** mitigation that fixes *this* lift, but it does **not** close
     the general defect (the next out-of-catalog lift merges again). Do the structural fix;
     the alias add is a stopgap, not the cure.
2. **Fix G4 — never emit a unit the engine didn't give.**
   *Slice:* deterministically strip/forbid unit tokens (kg/lb) from coach prose
   post-generation (the prompt rule already exists but the model violated it), so the voice
   can't fabricate a unit. *Risk:* **correctness** (coach voice; PM authority). *Size:* **S.**
   *Model:* **Opus** (grounding guard) or **Sonnet** (pure string strip). *Live-test card:*
   optional (a unit-token guard is unit-testable headless).
3. **Fix G2 — coach reaction iterates every logged lift.**
   *Slice:* in `handleSetLogged`, build a coach note per logged exercise (or one combined
   note addressing all), not `exercises[0]` only; mirror on the `app.js:4824`
   single-`[0]` reaction. *Risk:* **correctness** (coach loop; read-only). *Size:* **S–M.**
   *Model:* **Opus.** *Live-test card:* **Yes** (stacked Deadlift+Bench → both coached).
4. **Investigate/fix G3 — next-up vs queue + "done" gating.** *Blocked on live data first*
   (Open question 3). Likely slice: disambiguate "recommended next move" from "next in
   queue" in the displayed "Next", and gate the "say done" invite on `remaining.length === 0`
   from the canonical session. *Risk:* **trust-critical** (session state). *Size:* **M.**
   *Model:* **Opus.** *Live-test card:* **Yes.**
5. **Fix G5 (F6) — card line wrap.** *Slice:* CSS one-line-per-lift. *Risk:* **mechanical.**
   *Size:* **S.** *Model:* **Sonnet.** *Live-test card:* No.

---

## Open questions for Dale (not derivable from the repo)

1. **Exact input text** for the Dips + Side Bend bubble — was "Dumbbell Side Bend" on its
   **own line** (multi-line display block) or **inline** on the same line as the Dips sets?
   This decides which intake path ran (normalizer split vs backend merge).
2. **The actual logged rows** for that bubble (from Google Sheets): did `70×15` write under
   **Dips (Weighted)** (merge confirmed), under **Dumbbell Side Bend** (normalizer split), or
   **both** (duplicate)? The later "Today's Workout" card showing Side Bend separately is
   ambiguous — confirm against the sheet, not the card.
3. **The plan + session state when "Next: Face Pull" appeared:** the ordered plan for that
   session, which lift was current/cursor, and whether Single-Leg Curl was still pending in
   the canonical session at the "say done" moment. This decides whether F2 is the
   advisory-vs-queue confusion, a stale cursor, or a G1 side-effect.
4. **Was the coach LLM (Gemini) up** during this session, or degraded to templates? F4 (kg)
   implies the LLM voice was live (templates can't fabricate "kg"); confirm so the G4 fix
   targets the right layer.
