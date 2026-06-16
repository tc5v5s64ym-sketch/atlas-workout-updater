# CONVERSATION_DESIGN.md — How Atlas handles real input

> The composer is the whole interface. Everything — logging, correcting, asking, pivoting — happens conversationally, in one elastic stream. No tiles, no edit buttons, no modal confirm gates. Partner doc to SESSION_DESIGN.md (what to build) and COACH_PERSONALITY.md (how it reacts). Same architecture rule: the engine parses and owns the data; the coach only words it.

## What it is (plain terms)

Atlas should be elastic. In a real session you log a set, then wonder something, then realize a set three back was wrong, then ask for a stat, then log again — all in natural language, all in the composer. Atlas keeps up without making you stop, tap, or switch modes.

## Core interaction principles

### Repeat-back, not confirm-tiles

Parse boldly and echo what it logged in a natural sentence so you can eyeball it — "Logged bench 225x5, 5, 4." Silence is confirmation. No "tap to confirm," no edit button. If the echo is wrong you say so; if you say nothing, it's right.

> This deliberately evolves the old "approve-before-save" gate into save-and-echo + conversational correction. (Applies to the user logging flow only — it does not relax the separate safeguards on real data writes under the hood.)

### Correction is conversational

Edits and undos are spoken, and may reference something logged several sets or messages back — "that bench a few sets ago was 215, not 225." Atlas locates that entry and fixes it. The edit is the sentence, not a button.

- Carve-out for destructive changes: a delete or overwrite is stated in a sentence so a silent mis-fire can't quietly wipe data — "deleted that last row set, say the word to undo." Still conversational, still no tile.

### Fluid intent-switching

One stream interleaves logging, questions, musings, and corrections. Atlas reads intent per message — is this a set to log, a question to answer, a correction, or a mid-session pivot? — acts on it, and drops back into the logging flow without losing the session thread. A question must never be saved as a set; a set must never be treated as a question.

### The coach stays gated

Per COACH_PERSONALITY: chime in when there's something worth saying, stay quiet otherwise. Don't narrate every action ("wow, two workouts!") unless it's warranted.

## Scenarios it must survive (acceptance cases)

Real gym input is messy and unpredictable. Each is handled conversationally — parse boldly, echo, let the user correct.

1. Non-uniform sets. "Bench 225 for 5, 5, then only 4." "Worked up to a 245 single." "Last set AMRAP, got 12." "Dropped to 185 to failure." -> per-set parse; support failures, AMRAP, top singles, descending loads. Never force into a uniform NxR shape.
1. Batch brain-dump across days. "Tuesday: bench 225x5x3, rows 190x10x3. Thursday: squat 225x5, deads 275x3, some curls." -> split into sessions, infer or ask dates, echo each separately, flag the vague accessory. Never silently merge two days.
1. Log vs ask vs both. "Doing bench, what should I hit?" (question -> give working weight). "Crushed 235x8, should I go up?" (both -> log + answer). -> classify intent; answer from history; save only actual sets.
1. Floor deviations. "Bench was taken, did dips first." "Skipped curls, elbow's cranky." "Gym closed, only got rows." -> the prescription is a suggestion; reconcile to what actually happened; log reality; don't nag skipped work.
1. Load ambiguity. "Dips plus 45." "Curls with the 60s." "Two plates." -> know which lifts are bodyweight+load; treat dumbbells as per-hand; confirm the number in the echo when ambiguous; never poison e1RM with a misread load.
1. Conversational correction / undo. "That bench a few sets ago was 215, not 225." "Delete the last set." "That was last week." -> locate the referenced entry and fix it; state destructive changes out loud.
1. Mid-session stat questions. "What's my squat progression over the last three months?" "Bench improvement year to date?" -> answer inline from analytics, then return to the logging flow. The question is a detour, not a context reset.

Acceptance form: feed each as raw composer text; assert Atlas (a) parses to the right structured result or answers the right question, (b) echoes its read in plain language, (c) keeps the session thread intact across detours, (d) saves only real sets, (e) edits the correct prior entry on a conversational correction.

## Guardrails

- Composer-only: no tiles, buttons, or modal confirm/edit steps in the logging flow.
- Echo every parse; silence confirms; corrections are spoken.
- Parse boldly, but always show your read.
- Never lose the session thread across a question or correction.
- Destructive changes are stated out loud, even though no button is required.
- Engine parses and owns the data; the coach only words it.

## Implementation prerequisite

The "save-and-echo, silence confirms" pattern described here replaces the approve-before-save trust loop listed as a critical behaviour in `CLAUDE.md` and enforced in `public/app.js`. **Implementing this spec requires explicit owner approval before any code changes** — it is not a routine PR and must not be treated as one by any agent or contributor.
