# Atlas Active Roadmap

This is the current execution queue after the June 2026 app test findings.

BACKLOG.md remains the source of truth. This file is the detailed active queue that should be linked or summarized from BACKLOG.md.

## Why priority changed

The performance intelligence layer has mostly been built, but app testing exposed session-execution trust failures:

- impossible lateral raise loading
- poor exercise ordering
- missing confirmation cards
- plan drift during active workouts
- reorder vs substitute confusion
- no clean session closeout

The test changed priority, not direction.

Build order now:

1. Fix session execution and trust failures.
2. Wire existing intelligence into the live coach path.
3. Use intelligence for suggested workouts.
4. Polish coach voice last.

## Global rules

- Tiny PRs.
- One concern per PR.
- Stop after every PR for owner review.
- Deterministic engine first, AI voice second.
- Do not touch write paths unless the PR explicitly says so.
- Do not change Sheet schema unless explicitly approved.
- Tests must prove the previous failure cannot recur.
- Tests must cover the live path or closest integration path, not only new helpers.

## Active queue

### PR 355 - Session Plan Executor

Make the active workout plan authoritative. Track planned, current, completed, remaining, reordered, substituted, skipped, added, and complete states.

Boundary: PR 355 may implement only the minimum deterministic handling required to preserve planned exercises during simple reorders. Full reorder/substitute/skip/add classification belongs in PR 357.

### PR 356 - Confirmation Card Consistency

Every successfully parsed workout log gets the same confirmation/preview card before Atlas advances session state.

### PR 357 - Reorder vs Substitute vs Skip vs Add Intent

Classify in-session plan changes as reorder, substitute, skip, or add. If uncertain, ask clarification rather than changing the plan.

### PR 358 - Session Closeout Flow

When planned work is complete, stop suggesting more work and provide a clean session wrap-up plus next action.

### PR 359 - Exercise Order Guardrails

Prevent bad default exercise order: compounds before accessories, bench before laterals, rows before face pulls.

### PR 360 - Warm-Up / Ramp-Up Logic

Heavy compounds should include ramp-up guidance before top working sets. Warm-ups should not count as working volume.

### PR 361 - Load Sanity Bounds

Block impossible or absurd load suggestions, especially 170 lb lateral raises. If app testing repeats early, this may be promoted immediately after PR 358.

### PR 362 - Live Intelligence Wiring

Wire expected performance, deviation, evidence_context, working_weight, trend, and readiness_signal into the live coach facts.

### PR 363 - Historical Context Reactions

Coach reactions should compare today against history when facts support it. Respect RIR. Do not call 2 RIR failure or edge unless the engine says so.

### PR 364 - Substitution History Builder

Build the missing substitution history source so repeated_substitution memory can fire from real stored events.

### PR 365 - Missed Lift / Planned-vs-Completed Memory

Track planned lifts that were missed, skipped, substituted, reordered, or completed. Feed missed-lift patterns into coach memory.

### PR 366 - Suggested Workout Engine

Use recent sessions, muscle gaps, stalls, benchmarks, deviations, working weight, trends, readiness, memory, constraints, and goals to choose suggested workouts deterministically.

### PR 367 - Workout Recommendation Evidence

Every workout recommendation should expose deterministic reason codes and readable evidence.

### PR 368 - Trend-Aware Recommendations

Use trend direction to adjust recommendation aggressiveness.

### PR 369 - Readiness-Aware Recommendations

Use readiness signals to adjust workout dose.

### PR 370 - Coach Confidence Layer

Expose confidence based on sample size, recency, consistency, benchmark quality, trend quality, deviation history, and exercise familiarity.

### PR 371 - Coach Voice Polish

Presentation-only pass after intelligence is wired and trustworthy. No new engine logic or workout decisions.

## New chat / agent instruction

Read this file before changing roadmap direction. Preserve the roadmap. Execute the next PR only. Stop for owner review.
