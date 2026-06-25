# P0 — Active Workout State Unification: Current-State Diagnosis

> **Status:** Active P0 trust lane (owner-approved 2026-06-24, live-gym test report).
> This is the diagnosis artifact for **PR 1**. Implementation lands in PRs 2–7.

## The trust failure

Atlas can verbally adapt a workout, parse/log individual exercises, and react with reasonable coaching — but it does **not** maintain one authoritative active-workout state after mid-session changes. The coach conversation, next-up router, composer prefill, workout queue, preview/save flow, and session-completion logic drift apart. The user is left asking *"did Atlas actually understand what workout I'm doing?"* — a trust-critical failure.

### Required product invariant

> **There must be exactly one authoritative active workout/session object.** Every consumer derives from it: displayed plan, coach context, current exercise, next-up router, composer prefill, generated warm-ups, working sets, progression targets, inserted/skipped/substituted state, preview/save flow, session recap, and the Google Sheets write rows.

When the user accepts a modification, Atlas must **mutate the active object deterministically** — not merely describe a new plan in chat. The LLM may *explain* the mutation; the app state must *own* it.

## Current reality: there is no single source of truth

Today the "active workout" is spread across **seven independent holders**, mostly in `public/app.js` and `public/coach-conversation.js`, that can disagree on identity, completion, order, and cursor position:

| # | Holder | Where | What it owns | Divergence risk |
|---|---|---|---|---|
| 1 | `activePlannedSession` | `public/app.js:~1209` | live exercise list + cursor `index` | mutated in-memory on swap; **server never sees the mutation**; `plan_exercises` sent without `lift_code` |
| 2 | `sessionCompleted[]` | `public/app.js:~2904` | logged exercise names (via `resolveCompletedIdentity`) | built from parsed/alias names, not plan names; failed resolution leaves a raw name → remainder filter disagrees with the plan |
| 3 | `lastIntentData` | `public/app.js:~2304` | cached server recommendation (no cursor) | static snapshot used as the plan when `activePlannedSession` is null; has no position → can't track deviation |
| 4 | `coachSuggestionEngaged` | `public/app.js:~1220` | whether Coach's Pick was "started" | "Modify Plan" path leaves it false while logging still pulls from `lastIntentData` |
| 5 | `pendingSubstitution` | `public/app.js:~1227` | declared swap `{prescribed}` | **no UI sets it** — effectively dead; swaps are inferred late, by name, at log time |
| 6 | `sessionLog[]` | `public/app.js:~2900` | parsed-but-unenriched set buffer | parsed names; enrichment (canonical/lift_code) only at preview time |
| 7 | server `plan_exercises` / `plan_completed` | `index.js` (`/api/log-workout`) | server's view of plan + done | `plan_exercises` lacks `lift_code`; `plan_completed` may capture the *prescribed* name even after a swap |

### Next-up router
`plannedExerciseEntries()` (`app.js:~2918`) → `remainingPlannedExercises()` (`app.js:~2954`) → `firstUnloggedPlannedLift()`; the coach also calls `getNextExerciseInPlan` (`coach-conversation.js:~921`), which prefers `/api/plan/today` then falls back to the in-memory session. **These can read the original Coach's Pick rather than the mutated plan**, producing "Next up: Deadlift" after Deadlift was replaced by Squat.

### Composer prefill
`typeSuggestedWorkout()` → `buildWorkoutPlaceholder(exercises[0])` → `setWorkoutPlaceholder()` (`coach-conversation.js:~554`). The placeholder is set from the **first suggested exercise** and is **not** updated after a swap or after the cursor advances — so it stays bound to a stale original-plan exercise (e.g. Deadlift).

### Substitution / mutation
`applySessionSubstitution()` (`app.js:~1244`) mutates `activePlannedSession.exercises` in place only when the first swapped set is logged; the server never receives the mutation atomically. The pure server seam **does** model a swap correctly (`services/sessionPlanExecutor.js`: `applySubstitution` + `computePlanState`), but the client doesn't route through a canonical mutation, so the seven holders fall out of sync.

### Identity correction, insert, skip — missing capabilities
- **Correction** ("sorry that was lat pulls"): the coach text can understand it, but `sessionLog[]`/`sessionCompleted[]` keep the original parsed name and the card stays wrong. There is **no** session-state correction operation.
- **Insert** (Hammer Curls, Knee Raises): unplanned logs are buffered/written as-is; they are **not** represented as inserted entries in the active queue.
- **Skip**: no skip operation; an unlogged planned exercise simply lingers in "remaining" forever.

### Preview/save and "no session plan"
The preview/save flow (`/api/log-workout` and `/api/complete-workout`, `index.js`) assembles rows from the divergent client state; a heavily-modified session (swaps + skipped originals + inserted accessories + bodyweight/core) can desync `plan_exercises` vs `plan_completed` and surface **"Preview failed: Failed to complete workout ingestion."** When `plannedExerciseEntries()` returns `[]` (no `activePlannedSession`, suggestion not engaged), the coach can claim there's **no session plan** even though it just coached one.

## Target design: one canonical `ActiveSession`

Introduce a **pure, deterministic, unit-testable** canonical session model (`public/activeSession.js`, UMD so both the browser IIFEs and Node tests use the *same* logic — the pattern already used by `public/coachVoiceTemplates.js`). Every client holder and the write-row assembly derive from it; the LLM never owns mutation.

Proposed shape (contract pinned by PR 1's tests):

```
createActiveSession({ exercises }) → session
  session.exercises: [{ name, liftCode, status, source }]
    status: 'pending' | 'completed' | 'skipped'
    source: 'planned' | 'substituted' | 'inserted'
  session.cursor: index of the current (next-to-do) exercise

Pure operations (each returns a NEW session, never mutates input):
  replaceExercise(session, targetName, { name, liftCode })  // swap/replace in place, order preserved
  skipExercise(session, name)                               // mark skipped, advance past it
  insertExercise(session, { name, liftCode }, { after })    // insert into the live queue
  correctIdentity(session, { from, to })                    // relabel a logged/active entry
  markCompleted(session, nameOrCode)                        // mark done (name/liftCode/alias), advance cursor

Pure selectors (every consumer derives from these — no parallel state):
  currentExercise(session)   // composer prefill + coach "current exercise"
  nextUp(session)            // next-up router (the mutated queue, never the original)
  remaining(session)         // pending exercises
  completedExercises(session)// for recap + write rows
```

The existing `services/sessionPlanExecutor.js` (`applySubstitution`, `computePlanState`, `nextExerciseFromPlan`) is the server-side seam this consolidates around; `public/activeSession.js` becomes the single client-and-server-shared mutation/selection model.

## Acceptance criteria → PR mapping

| AC | Behavior | PR |
|---|---|---|
| 1 | Coach's Pick produces an active workout state | 2 |
| 2 | "skip deadlifts, do squats" → Deadlift replaced, Back Squat active | 2 |
| 3 | Squat replacement regenerates full prescription incl. warm-up/ramp | 3 |
| 4 | Composer immediately updates to Back Squat after pivot | 2 |
| 5 | After logging Back Squat, next-up is OHP (not Deadlift) | 2 |
| 6 | After logging OHP, next-up follows the mutated queue | 2 |
| 7 | "sorry that was lat pulls" relabels the card to Lat Pulldown | 4 |
| 8 | Inserted Hammer Curls represented as inserted/completed | 5 |
| 9 | Knee Raises logged/reacted as inserted core finisher | 5 |
| 10 | Final preview/save works for the fully-modified session | 5 (+7 e2e) |
| 11 | Coach never claims "no session plan" while one is active | 2 |
| 12 | Barbell prescriptions round to loadable plate increments | 6 |

## Slice plan (one concern per PR, fresh branch each, tests required)

1. **(this PR)** Diagnosis + failing repro tests (the stale composer/next-up after Deadlift→Squat, plus the canonical-`ActiveSession` contract as `todo` specs).
2. Canonical `public/activeSession.js` mutation/selection for swap/replace/skip; wire next-up + composer to derive from it (AC 1,2,4,5,6,11).
3. Regenerate full replacement prescription incl. warm-up/ramp on substitution (AC 3).
4. Exercise-identity correction so card/log/session agree (AC 7).
5. Insert/finisher handling for unplanned accessories + recap/save (AC 8,9,10).
6. Barbell loadability guard against the owner's plate inventory (AC 12).
7. End-to-end regression: Coach's Pick → replace DL→Squat → log Squat → OHP → corrected Lat Pulldown → insert Hammer Curl → insert Knee Raises → preview/save succeeds (AC 10).

## Deferred notes (from PR-565 review — address in the slices below)

- **`replaceExercise` can re-open a completed/skipped slot.** It matches by `findMatchIndex(..., pendingOnly=false)`, so replacing an already-`completed`/`skipped` exercise flips it back to `pending`. Harmless pre-wiring, but the **frontend wiring PR** (which lets live coach/user text drive replacement) must add a guard/test so a swap can't silently re-open finished work.
- **`isComplete` returns `true` for an all-`skipped` session.** Consistent with the "nothing pending remains" definition, but **PR 5 (recap/save)** must treat "all skipped, nothing logged" deliberately (not a normal completed session) when assembling the recap/write rows.

## Notes / constraints

- **No schema change planned.** The canonical session is in-memory + request context; write rows are unchanged 12-column `Log_Cleaned`. If any slice turns out to *require* a schema/storage change, stop and report the smallest proposal (owner-gated).
- Approve-before-write and no-blind-writes are preserved throughout (the canonical session feeds the preview; the owner still approves).
- The failing tests in PR 1 are `node:test` `todo` specs (a todo failure does not break CI); each subsequent PR removes the `todo` marker for the criteria it satisfies.
