# COACH_PLAN.md — Coach Intelligence Build Plan

> **How to use this file:** commit it to the repo root as `COACH_PLAN.md`, then execute **PR 1.1 only** and stop for review. Do not proceed to any later PR without explicit approval. Work top to bottom; honor every hold point and the model switches.

The arc, end to end: **build the knowledge → measure it → let it judge stalls → let it speak → let it choose and shape the workout.** Each layer is pure data before anything consumes it.

-----

## Operating rules (every PR)

- **Tiny, single-concern PRs.** One idea per PR.
- **Verify before changing.** Read the relevant code first. If a premise here is wrong, stop and say so before writing code.
- **Golden fixtures are hand-computed**, never generated from the code under test.
- **Data before behavior.** Build and review data layers before anything consumes them.
- **Update `BACKLOG.md` in the same PR** when something merges or a follow-up is deferred (per `CLAUDE.md`).
- **Don't touch** the write path, persisted deload state, `detectDeloadRecovery`, coach wording, or any user-facing recommendation unless a step explicitly says so. If a step seems to require touching one of these, stop and propose the smallest safe approach first.
- **Coverage is a coaching model, not a biomechanics one.** Prefer stable, useful classifications over anatomical perfection. Don't rabbit-hole on edge-case kinesiology.
- **Catalog note:** there is no canonical exercise catalog in the repo — names live in the Google Sheet, and the code matches by name *pattern* (see `services/liftRole.js`). Stay pattern-based, use the fixture list below for tests, don't hunt for an in-repo catalog, and **don't read the Sheet in tests.**
- **Unknown, non-catalog lifts** return a safe `needsReview` result — never a guess.

### Catalog fixture (tests must cover)

Back Squat · Barbell Row · Bench Press (+ Machine) · Bent Over Row (+ Reverse) · Cable Crossover · Deadlift · Dips (+ Weighted) · Dumbbell Curl · Dumbbell Side Bend · Face Pull · Hammer Curls · Hanging Knee Raises · Incline DB / Dumbbell Press · Lat Pulldown · Lateral Raise(s) · Leg Curl · Leg Extension · Leg Press (+ Linear / Seated / Single-Leg) · Overhead Press · Romanian Deadlift · Seated Row · Shrugs · Single-Leg Leg Curl

*Duplicates collapse to one pattern each (Lateral Raise / Raises; Incline DB / Dumbbell Press; Dips / Weighted Dips). Skip cardio rows.*

-----

## PHASE 1 — Foundation data

**Model: Claude Sonnet 4.6**

### PR 1.1 — Muscle-coverage map ✅

Create `services/muscleCoverage.js`. Pattern-based, in the same spirit as `liftRole.js`.

- `musclesFor(liftName)` → `{ primary: [], secondary: [], needsReview: false, matchPattern? }`
- `liftsForMuscle(muscle, liftList)` → lifts from the supplied list that train that muscle.

**Fixed taxonomy (17 muscles) — nothing outside this set:**
`chest, front_delts, side_delts, rear_delts, traps, lats, upper_back, lower_back, biceps, triceps, forearms, quads, hamstrings, glutes, calves, abs, obliques`

**Primary vs secondary precedence:** primary = the main training target(s) the lift is programmed *for*; secondary = meaningful contributors that get real stimulus but aren't *why* you'd program it.

- Deadlift → primary `glutes, hamstrings, lower_back`; secondary `traps, lats, forearms` — **not** primary traps.

**Rules:**

- Every fixture lift returns ≥1 primary.
- Isolation lifts **may** have empty `secondary` — don't invent fake ones.
- Fill the secondaries that matter: rows → `biceps, rear_delts`; pulldown → `biceps`; bench/press → `triceps, front_delts`; OHP → `triceps, traps`.
- Unknown lift → `{ primary: [], secondary: [], needsReview: true }`.

**This PR is pure data — nothing consumes it yet.**

**Tests:** every fixture lift has a primary; all returned muscles are in-taxonomy; unknown lift returns `needsReview`; spot-checks — Deadlift → traps is *secondary* (not primary), Row → biceps secondary, Shrugs primary = traps, Leg Extension primary = quads / secondary = [], Bench → triceps + front_delts secondary, OHP → triceps secondary, Pulldown → biceps secondary.

### PR 1.2 — Weekly volume per muscle

Create `services/muscleVolume.js`. **Read-only.** Consumes recent log rows + the coverage map over a rolling window (default 7 days).

- Per muscle: `{ directSets, indirectSets, totalEffectiveSets, liftsContributing: [] }`
- Credit: primary **1.0** per set, secondary **0.5** per set.
- **No undertraining decision, no behavior change** — just the numbers.
- Golden fixtures hand-computed from a small fake log.

### PR 1.3 — Movement-pattern map *(was optional → **now required**)*

Create `services/movementPattern.js`. One primary pattern per lift from:
`squat, hinge, horizontal_push, vertical_push, horizontal_pull, vertical_pull, knee_isolation, hip_isolation, arm_isolation, delt_isolation, calf_isolation, trunk, carry, other`

- The session builder's pairing/competition rule (see [`SESSION_DESIGN.md`](./SESSION_DESIGN.md)) depends on patterns to enforce anchor co-anchor rules — this is no longer optional.
- Tests: Bench = horizontal_push, OHP = vertical_push, Row = horizontal_pull, Pulldown = vertical_pull, Back Squat = squat, RDL = hinge.

### ⏸ HOLD POINT 1 — switch **Sonnet 4.6 → Opus 4.8**

Owner reviews the coverage map + per-muscle volumes against the real training log before any behavior changes.

-----

## PHASE 2 — Coverage-aware stalls

**Model: Claude Opus 4.8**

### PR 2.1 — Coverage-aware stall / deload

First **locate and read** the current `detectStalls` / deload-trigger flow. Verify behavior before changing.

- **Goal:** a flat accessory whose primary muscle already has adequate recent volume *from other lifts* shouldn't feed whole-program deload triggering.
- **Downgrade, don't erase** — mark such an event `ignored_for_deload` with a reason; keep it visible. If the architecture can't express that cleanly, **stop and propose the smallest safe design first.**
- **Don't suppress real stalls:** a flat lift whose muscle is *not* covered still flags; main-lift stalls still flag; existing stall/deload tests stay intact; **don't touch `detectDeloadRecovery`** (stop first if it seems required).

**Golden fixtures:**

1. Shrugs flat + traps covered by other lifts → not a deload-feeding stall.
1. Shrugs flat + traps **not** covered → still flags.
1. Main lift flat, no coverage → still flags.
1. Existing stall/deload tests still pass.

### ⏸ HOLD POINT 2 — real-world test on the live app before Phase 3.

-----

## PHASE 3 — Proactive suggestions

### PR 3.1 — Under-coverage signal (engine)

**Model: Claude Opus 4.8.** Deterministically compute genuinely under-trained muscles from volume + training frequency + thresholds. **Read-only — nothing surfaces it yet.**

- Returns `{ muscle, currentEffectiveSets, targetRange, status, reason }`.
- Golden fixtures required.

### PR 3.2 — Surface via coaching

**Model: Claude Sonnet 4.6.** Wire the signal into `coach.js` (e.g. *"rear delts are light this week — want to add face pulls?"*).

- **Engine owns the gap decision; the LLM only words it.**
- Small, isolated change.
- Provide **2–3 example outputs to approve before merge.**

### ⏸ HOLD POINT 3 — coach-voice review.

-----

## PHASE 4 — Goal- & coverage-aware workout selection *(capstone)*

**Model: Claude Opus 4.8**

Wires the foundation into **Coach's Pick** *and* the **"Other training options"** menu. The current option tiles are **placeholders — free to redesign.** Verify the existing scorer/builders first; **enrich, don't replace.**

> Context: `resolveTrainingGoal` already layers **explicit goal → today's chat text → stored profile goal → default**, and a goal classifier already knows `strength, hypertrophy, recovery, power, conditioning_fat_loss, muscular_endurance, mixed, general_health`. But nothing currently stores or sends a profile goal, and the session scorer barely reads one.

### PR 4.0 — Give the engine a goal to read

- Add a stored `profileGoal` (one of the existing goal vocabulary) and a minimal way to set it (a config/setting value is fine to start — UI later).
- Pass it through the recommendation pipeline that already accepts `userProfileGoal`.
- **No ranking change yet** — just make the goal *available*.
- **Tests:** stored goal flows through; a goal stated in chat still overrides it for the day; absent goal falls back exactly as today.

### PR 4.1 — Goal- + coverage-aware ranking (Coach's Pick + menu order)

Read the existing scorer in `analytics.js`. Feed in: the resolved goal (4.0) + per-muscle volume / coverage gaps (Phase 1) + under-coverage signal (Phase 3), alongside existing fatigue / recency.

- **Frequency-aware:** the user trains **1–3×/week** — bias toward broad, high-leverage sessions; don't fragment a rare session.
- Enrich the scorer; don't rip it out.
- **Golden fixtures:** strength goal + legs fresh → heavy-lower outranks pump; hypertrophy goal + rear delts under-volumed → an upper-pull / delt session ranks up.

### PR 4.2 — Session builder (capstone, rewritten per SESSION_DESIGN.md)

See [`SESSION_DESIGN.md`](./SESSION_DESIGN.md) for the full spec. Build order: anchor → support → balance, consuming `muscleCoverage` + `muscleVolume` + under-coverage signal + balance signal + `movementPattern` + cost tier + the pairing/competition check.

- **Anchor:** freshest compound by pattern rotation + goal + recovery; two anchors at low frequency (~2×/week).
- **Support:** accessories matching the anchor's primaries/secondaries, capped at weekly muscle targets.
- **Balance:** always reserve ≥1 slot for the biggest current gap (from under-coverage + balance signal). Never dropped.
- **Pairing rule** (Rule A): blocked co-anchor pairs must be golden-fixture tested (e.g. never outputs Deadlift + RDL).
- Read the existing builders first; enrich, don't replace.
- Every offered option must build a coherent, pairing-legal, balanced session for today, or be de-emphasized.

### ⏸ HOLD POINT 4 — live test

Do Coach's Pick *and* the menu now reflect the user's **goal, gaps, recovery, and training frequency**?

-----

## On completion

When all phases are merged, mark the **four ⭐ keystone items** and the **Phase 4 coverage-aware workout-selection capstone** done in `BACKLOG.md` (add the capstone as a backlog line if it isn't there yet).

-----

## ▶ Execution

**Start with PR 1.1 only. Build it, then stop for review.**
