# PR-10 Regression Addendum

> Status: Owner-captured live session evidence, 2026-07-07.  
> Purpose: This addendum sharpens `docs/REMEDIATION_PLAN_V2.md` PR-10 before the one-state-store migration begins.

## Why this exists

A live v116 gym-session test was materially better than prior sessions: Atlas planned, adapted to user constraints, logged several lifts, saved, verified, and undo succeeded.

However, the same session exposed the exact state bugs PR-10 is meant to eliminate: restored-session pin drift, skipped/substituted exercise drift, wrong correction target, stale remaining-plan recap, and blank coach-message rendering after successful log responses.

PR-10 must treat these as required regression tests, not optional follow-up notes.

## Required PR-10 regression cases

### 1. Restored-session discard clears restored pin

Given the app opens with a restored-session pin, when the user taps **Discard restored session**, the restored-session pin must disappear from state and UI.

It must not continue to show a stale restored session such as:

```text
Session restored — 3 sets logged (Bench Press)
```

### 2. RDL skip becomes real session state

Given the active plan includes Romanian Deadlift / `RDL01`, when the user says:

```text
My lower back is a bit sore so no RDLs for me today
```

Atlas must mark `RDL01` as skipped in session state.

This cannot be only a coach-language reply.

### 3. Avoid legs/lower back constrains remaining session suggestions

Given the user says:

```text
Let’s stay away from legs and lower back
```

Atlas must avoid suggesting lower-body or lower-back substitutions for the rest of that session unless the user explicitly reverses the constraint.

### 4. Substitute flyes complete the original fly slot

Given Atlas suggests Dumbbell Flyes and the user chooses/logs Incline Dumbbell Flyes, the original Dumbbell Flyes slot must be considered satisfied.

The final recap must not say:

```text
Still on your plan: Dumbbell Flyes
```

### 5. Correction targets the active/latest ambiguous fly item, not Bench Press

Given the user logs bench, then discusses flyes, then says:

```text
I meant incline dumbbell flyes
```

Atlas must target the active/latest ambiguous fly item.

It must never produce or persist a correction equivalent to:

```text
Got it — relabeled Bench Press to Incline Dumbbell Fly.
```

This is trust-critical because it can corrupt a completed major lift.

### 6. Final recap reconciles logged + skipped + substituted exercises

For the live-session shape:

```text
Plan: OHP, RDL, Bench, Seated Row, Face Pull, Curls / accessory slot
User:
- logs Overhead Press
- skips RDL due to lower-back constraint
- avoids legs/lower back
- adds Incline Dumbbell Flyes
- logs Bench
- logs Incline Dumbbell Flyes
- logs Seated Rows
- logs Face Pulls
- taps Done
- taps Save
```

The save/review recap must include the logged work, the skipped RDL, and the applied fly substitution accurately.

It must not show completed/substituted exercises as still remaining.

### 7. Coach message must not render blank after successful log responses

After successful log responses where `/api/coach/message` returns `200`, the UI must not render:

```json
{"coach_message":""}
```

If the coach-message endpoint returns a usable message, the app must display it or intentionally preserve the last valid coach message.

## PR-10 acceptance addition

PR-10 is not complete until these live-session regressions are covered by tests or explicitly dispositioned in the PR body with owner approval.

These tests belong in PR-10 because they are state-store/session-state issues, not parser or write-path migration issues.
