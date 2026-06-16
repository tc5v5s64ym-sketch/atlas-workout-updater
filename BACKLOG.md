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
  - ✅ **PR 1.2** — `services/muscleVolume.js`: `weeklyMuscleVolume`, rolling-window volume per muscle, direct 1.0 + indirect 0.5 credit (16 tests).
  - **PR 1.3** — `services/movementPattern.js`: movement-pattern map. _(was optional → **now required**: the pairing rule in [`SESSION_DESIGN.md`](./SESSION_DESIGN.md) needs patterns to enforce anchor co-anchor rules)_
  - ✅ **Hold Point 1** — owner reviews coverage map + per-muscle volumes against real log before behavior changes. _(Sonnet → Opus 4.8 after hold)_
  - ✅ **PR 2.1** — Coverage-aware stall/deload: `coverageStalls.annotateStallsForDeload`; accessories downgraded when primary muscles covered by other lifts; `weeklyMuscleVolume` extended with `today`/`excludeLiftCode` options (929 tests).
  - ✅ **Hold Point 2** — live-app test confirmed: Face Pull correctly feeds deload (rear_delts 1.5 eff. sets < 2.0 threshold); OHP main stall feeds independently. Coverage logic verified correct.
  - ✅ **PR 3.1** — `services/underCoverage.js`: `computeUnderCoverage`; per-muscle status (`under`/`adequate`/`optimal`) + reason string vs. MEV-style target ranges (950 tests).
  - ✅ **PR 3.2** — Surface under-coverage in coaching chat: `muscle_gaps` (sorted by severity) wired into `buildChatContext` + `sanitizeChatContext`; LLM nudges 1–2 under-served muscles when asked what to train (952 tests).
  - ⏸ **Hold Point 3** — owner reviews live coach replies: do gap nudges appear naturally when asking what to train? Wording style approved pre-merge; confirm it reads right in real conversations.
  - **PR 3.3 — expectation verdict engine** — extend `analytics.js` / `computePrescription` to emit `{ outcome, why, prescribedRir, actualRir, rirDelta }` per set/session; golden fixtures for beat/met/fell_short/swap. Pure data, nothing surfaces it yet. _(see [`COACH_PERSONALITY.md`](./COACH_PERSONALITY.md))_
  - **PR 3.4 — coach voice reaction** — in `coach.js`, word the PR 3.3 verdict with the personality spec; gated by "gap worth talking about"; default quiet. Celebrate on beat+story, pushback on fell_short, smart-swap acknowledgement. Approve 2–3 example outputs before merge.
  - **PR 3.5 — swap detection + working-weight finder** — detect substitutions, acknowledge as wins, run "find working weight at target RIR" protocol when no clean equivalent load exists.
  - **PR 3.x — systemic-cost tier** — tiny lookup (HIGH/MEDIUM/LOW by name pattern) for the pairing rule; `services/liftCost.js` or addition to `liftRole`. Pure data + tests only. _(feeds PR 4.2 session builder)_
  - **PR 3.x — balance signal** — antagonist volume-ratio engine: horizontal push:pull, vertical push:pull, anterior:posterior, quad:hamstring → `{ pair, ratio, status, reason }`, wide bands, read-only, golden fixtures. Sibling to `underCoverage.js`; nothing surfaces it yet. _(see [`SESSION_DESIGN.md`](./SESSION_DESIGN.md) Rule B)_
  - **PR 4.0** — Give the engine a stored `profileGoal` to read; pass through recommendation pipeline.
  - **PR 4.1** — Goal- + coverage-aware ranking (Coach's Pick + menu order).
  - **PR 4.2 — session builder** — anchor → support → balance + pairing check, consuming `muscleCoverage`, `muscleVolume`, under-coverage, balance signal, `movementPattern`, cost tier. Every offered option builds a coherent, pairing-legal, balanced session or is de-emphasized. See [`SESSION_DESIGN.md`](./SESSION_DESIGN.md) for the full spec.
  - **Open decision:** Squat + Deadlift same day — block by default, allow as opt-in "heavy day" override? Default = separate until owner decides.

## Housekeeping

- **Close obsolete PR [#288](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/288)** (superseded by [#290](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/290)). ✅ Already closed 2026-06-16.
- **Reconcile [`FIX_PLAN.md`](./FIX_PLAN.md)** — mark shipped items done (e.g. Phase 1: write-path integrity, deload spec + module, ME-7/HI-8 analytics correctness), or fold the remaining ones into this backlog.
