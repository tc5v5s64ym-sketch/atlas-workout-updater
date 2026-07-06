# Engine Reconciliation Notes — reading shadow divergence correctly

> **Status:** Active reference for the One-Brain observation window.
> **Purpose:** Atlas currently runs two coaching engines side by side (legacy serves; the Brain shadows — see `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`). In two areas the engines use **different accounting models**, so parts of their disagreement are bookkeeping artifacts, not coaching judgments. This note pins which model is canonical today and how to attribute divergence during the observation window, so shadow data is read correctly against the promotion criteria.
> **Scope:** analysis/documentation only. Nothing here changes runtime behavior; reconciling the models in code is future engine work and is deliberately **not** part of the observation window.

---

## 1. Volume accounting — two counters, two credit models

| | Legacy (serves the user) | Brain (shadow path) |
|---|---|---|
| Module | `services/muscleVolume.js` | `services/volumeModule.js` (+ `volumeAssessmentModule.js`) |
| Muscle map | `muscleCoverage` taxonomy | `config/coaching/` volume landmarks + exercise lookup |
| Credit model | **primary 1.0 + secondary 0.5** effective sets (`muscleVolume.js:6`) | **primary-only** (`volumeModule.js:6,54`) |
| Live consumers | `coverageStalls` / `underCoverage` → `analytics.js` → served coverage, stall, and intent surfaces | `userStateModule.js:18` → `liftPrescription.deriveLiftState` → the scenario_classifier / progression / confidence runners (`services/coachRunners.js`) |

**Canonical today: `muscleVolume` (legacy)** — it is the accounting behind everything the user actually sees. `volumeModule` is the **candidate** accounting; it earns canonical status only through the promotion process, never by default.

**Why this matters for the window:** the same training week produces *systematically lower* per-muscle set counts under the Brain's primary-only model (e.g. an incline press set credits chest 1.0 + shoulders/triceps 0.5 each in legacy, but chest only in the Brain). Lower counts can shift a muscle's zone classification (below-MEV vs in-range), which feeds the Brain's user/lift state and can shift a scenario classification — and therefore a prescription.

**Attribution rule:** when a Brain_Shadow divergence traces to volume-zone or user-state differences, classify it as **accounting divergence**, not judgment divergence, before scoring it against the §5 agreement criteria in `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`. Accounting divergences are still recorded and still reviewed — a systematic bias is a real finding — but they answer "which bookkeeping is right?", not "which coach is right?". If accounting divergence turns out to dominate the window, reconciling the credit models becomes a prerequisite for promotion review rather than a follow-up.

## 2. Deload decisions — one state owner, one advisory

Two live modules can each say "recovery/deload is warranted." They are **not** peers:

| | `services/deloadEngine.js` (+ state machine / protocols / persisted `Deload_State`) | `services/recoveryDeloadSelection.js` |
|---|---|---|
| Role | **Canonical owner of deload state.** Decides and persists whether a deload is active, which predefined protocol applies, and the exit criteria (`docs/DELOAD_SPEC.md`). | **Advisory only.** A convergence-signal read (`assessRecoveryDeload`) that may surface a `recovery_advisory` (deload / recovery_reload) in coach facts. |
| Authority | Drives `/api/deload/*`, the recommendation routes' deload application, and the promotion guard: an active deload unconditionally blocks a Brain override (`services/coachEnginePromotion.js:59`). | Explicitly silenced when the engine's deload is already active (`index.js`, set-reaction facts path: the `deloadActive` guard runs first). Never touches state. |

**Precedence is already enforced in code**: engine state first, advisory second, and the advisory never fires while a deload is active. The residual "disagreement" case — the advisory suggests a deload the engine hasn't started — is **by design**: the advisory proposes, the engine (and its owner-approved protocol machinery) decides. That split is the deload spec's "AI decides *if*, engine decides *what*" contract, not a defect.

**Attribution rule:** shadow-window review should treat `deloadEngine`/`Deload_State` as the single source of deload truth. A Brain decision that conflicts with an *active* deload can never serve (the promotion guard refuses it) — if one appears in the shadow record it is evidence about the Brain's deload-awareness gap, already a known limitation of the progression decision type, not an unsafe served event.

## 3. Summary for the promotion review

- Volume: legacy `muscleVolume` is canonical; Brain `volumeModule` is candidate; volume-rooted divergence is accounting until proven otherwise, and must be attributed before it counts against (or for) the agreement rate.
- Deload: `deloadEngine` is canonical and always wins; `recoveryDeloadSelection` is a subordinate advisory with code-enforced precedence; no reconciliation work is needed for the window.
- Neither model pair should be merged, rewritten, or "cleaned up" during the observation window — changing the accounting mid-window would invalidate the comparability of the evidence collected so far.
