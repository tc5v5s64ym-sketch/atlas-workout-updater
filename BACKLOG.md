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

- **Coach context & nuance (north-star)** — the coach should reason about the whole training picture, not per-lift stalls. These are **engine intelligences**: the engine decides, the LLM voices them. The ⭐ markers are the keystone spine.

  **Foundation (build first):**
  - ⭐ **Muscle-coverage map** — which muscles each lift trains, directly + indirectly (deadlift → traps/back/legs; row → back/biceps/rear delts).
  - ⭐ **Weekly volume per muscle** — running tally of sets/effort per muscle, to see what's under/over-worked.
  - **Lift role + fatigue cost as catalog data** — move main/secondary/accessory out of the hardcoded `liftRole` heuristic into `Exercise_Catalog`; add a systemic-fatigue cost per lift. (Note: basic role classification already exists in `services/liftRole.js` as a heuristic — this is about moving it to data + enriching it.)
  - **Variant/equipment awareness** — single-leg vs double-leg, machine vs barbell, so weights aren't conflated.

  **Reasoning (uses the foundation):**
  - ⭐ **Coverage-aware stalls** — don't flag/deload a flat accessory whose muscle is already covered by compounds (fixes the shrugs/curls case).
  - **Per-muscle fatigue & freshness** — what's fried vs fresh, days-since-trained per lift.
  - **Plateau diagnosis** — why a lift stalled (fatigue/volume/rep-range/ceiling) → the right fix, not a blanket deload.
  - **Smarter deload trigger** — fire on real systemic fatigue weighted by lift role + training frequency.

  **Coaching layer (engine-driven, user-facing):**
  - **Goal-aware progression** — strength schemes for big lifts, volume schemes for accessories.
  - **Session selection** — "what to train today" from recovery + weekly volume gaps.
  - ⭐ **Proactive suggestions** — engine spots a gap, LLM raises it conversationally ("add face pulls?").
  - **Intent/priority awareness** — which lifts the user cares about vs casual accessories.

  **Spine** = the four ⭐ items in order; they deliver most of the holistic-coach vision. Pattern for all: use the LLM once to generate the knowledge as data, persist it, engine owns the decisions.

## Housekeeping

- **Close obsolete PR [#288](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/288)** (superseded by [#290](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/pull/290)). ✅ Already closed 2026-06-16.
- **Reconcile [`FIX_PLAN.md`](./FIX_PLAN.md)** — mark shipped items done (e.g. Phase 1: write-path integrity, deload spec + module, ME-7/HI-8 analytics correctness), or fold the remaining ones into this backlog.
