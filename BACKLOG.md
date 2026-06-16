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

- **Coach intelligence build (COACH_PLAN.md).** Phased build: muscle-coverage data → coverage-aware stalls → proactive suggestions → goal- & coverage-aware workout selection.
  - ✅ **PR 1.1** — `services/muscleCoverage.js`: `musclesFor` / `liftsForMuscle`, 17-muscle taxonomy, pattern-based, pure data (31 tests).
  - **PR 1.2** — `services/muscleVolume.js`: weekly volume per muscle (rolling window, direct 1.0 + indirect 0.5 credit). _(next)_
  - **PR 1.3** — `services/movementPattern.js`: movement-pattern map. _(optional — owner's call)_
  - ⏸ **Hold Point 1** — owner reviews coverage map + per-muscle volumes against real log before behavior changes. _(Sonnet → Opus 4.8 after hold)_
  - **PR 2.1** — Coverage-aware stall/deload: downgrade (not erase) accessory stalls whose muscle is covered.
  - **PR 3.1** — Under-coverage signal engine (read-only).
  - **PR 3.2** — Surface under-coverage via coaching voice.
  - **PR 4.x** — Goal- & coverage-aware workout selection (Coach's Pick + deck redesign).

## Housekeeping

- **Close obsolete PR [#288](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/288)** (superseded by [#290](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/290)). ✅ Already closed 2026-06-16.
- **Reconcile [`FIX_PLAN.md`](./FIX_PLAN.md)** — mark shipped items done (e.g. Phase 1: write-path integrity, deload spec + module, ME-7/HI-8 analytics correctness), or fold the remaining ones into this backlog.
