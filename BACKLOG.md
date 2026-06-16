# Atlas — Backlog

**Single source of truth for open and deferred work.** Priority-ordered. One line per item with a link to its issue/PR where one exists.

Seeded from the open GitHub issues, the not-yet-done items in [`FIX_PLAN.md`](./FIX_PLAN.md), and owner decisions. See the "Backlog discipline" section in [`CLAUDE.md`](./CLAUDE.md) for how to keep this current.

---

## Near-term

- **[#291](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/291) — Deload prescription consolidation (one model).** **BUMPED** — it's on the Coach's Pick surface the user starts from, not a secondary screen. Anchor on `computePrescription` as the single prescription source; point **both** the next-set card **and** the Coach's Pick / insights overview at it; retire the volume-first `suggestDeloads` path.
- **NEW — Deload trigger nuance: don't trigger a deload off accessory or deprioritized lifts.** Live example: it flagged Dumbbell Curl as stalled while its e1RM was progressing 40 → 53, and flagged Shrugs, which the user barely trains directly. The trigger should weigh what actually counts, not flag every flat lift.
- **[#289](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/289) — Frontend deload lifecycle wiring.** State machine is built but dark — the client never calls `/api/deload/begin|advance|resolve`, so saving a workout doesn't advance the machine.

## Then

- **Phase 2 hardening (from [`FIX_PLAN.md`](./FIX_PLAN.md)):** service-worker cache bug (HI-5), CSP / inline styles (HI-2), parser set-count cap (HI-3), friendly errors + no contradictory panels (ME-1/2/3), weekly-report row shape (ME-8).
- **Triage the older open issues:** lift-code fallback collision (`generateLiftCode` in `services/exerciseEnrichment.js` — no collision check/increment), and the flaky e2e ([#262](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/262)).

## Future epic

- **Coach context & nuance (north-star).** The coach should reason about the whole training picture, not per-lift stalls:
  1. classify lifts as **primary vs accessory**;
  2. understand **muscle/movement overlap** (e.g. traps from deadlifts/rows, biceps from pulls) so a flat isolation lift isn't treated as a gap when the muscle is already covered;
  3. tune **how far back it looks** and how holistic its view is;
  4. surface **"I want to bring X to the forefront"** via coaching conversation, not mechanical triggers.

  **First slice when this starts:** primary-vs-accessory classification.

## Housekeeping

- **Close obsolete PR [#288](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/288)** (superseded by [#290](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/290)). ✅ Already closed 2026-06-16.
- **Reconcile [`FIX_PLAN.md`](./FIX_PLAN.md)** — mark shipped items done (e.g. Phase 1: write-path integrity, deload spec + module, ME-7/HI-8 analytics correctness), or fold the remaining ones into this backlog.
