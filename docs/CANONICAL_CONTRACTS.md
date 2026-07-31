# Atlas Canonical Contracts — Ratification Charter

**Current as of:** 2026-07-20 · **Owner:** Atlas Recovery Campaign (Issue #1073), Phase 2 Work item 2 · **Status:** charter + ratification ledger. The per-contract schemas land as follow-up one-concern PRs sequenced below.

Phase 2 Work item 2 ratifies **eight canonical contracts as versioned schemas with docs**: `WorkoutSession`, `AthleteContext`, `ExerciseIdentity`, `CoachingDecision`, `CoachTurnPacket`, `SafetyDecision`, `CloseoutTransaction`, `InteractionTrace`. This charter is the "with docs" backbone: it fixes the ratification *convention*, maps each contract to the shape that exists today, and states the ratification target and the phase that consumes it — so the follow-up schema PRs formalize a known shape rather than invent one.

A **canonical contract** is the single authoritative shape for one concept that crosses a module boundary. Ratifying it means: one versioned schema, one pure builder/validator, one doc, one test — and every producer/consumer agrees on that shape. This is how the campaign reaches "one owner per concept."

This charter does not change runtime behavior, a flag, a schema on disk, or the preview→approve→write trust loop. It is documentation that sequences the work.

---

## 1. The ratification convention

Derived from the already-shipped contracts (`IntentEnvelope`, `CapabilityManifest`, `CoachingDecision`, `StateSnapshot`) so the eight are ratified the same way, not a new style:

1. **Versioned.** Every contract instance carries an integer `schema_version` (starts at `1`, bumped only on a breaking change), exactly as `services/coachingDecision.js` (`SCHEMA_VERSION = 1`) and `config/coaching/contracts/decision.contract.json` (`"schema_version": 1`) do.
2. **Declarative vocabulary in config, logic in services.** Closed enums / key schemas live as frozen JSON under `config/coaching/contracts/` (cross-cutting contracts) or `config/coaching/schemas/` (knowledge-base entry shapes). Pure `build<Contract>()` / `validate<Contract>()` functions live under `services/`. Neither reads Sheets, calls an LLM, nor writes — matching the `config vs service` split in `docs/COACHING_CONTRACTS_SPEC.md`.
3. **Tested, incl. cross-contract integrity.** Each contract gets a `node:test` file; referential integrity across contracts is asserted by `test/contracts-integrity.test.js` (the "one Brain" guard), extended as each new contract lands.
4. **Fail-closed / honest degradation.** A validator rejects an out-of-version or malformed instance; when an input is unavailable the shape degrades to explicit `null`, never a guess (mirrors `services/stateAssembly.js`).
5. **Enums extend by addition only.** Closed enums never repurpose or remove a value without a version bump; drift is caught by the integrity test.
6. **Read-only by default.** Only `CloseoutTransaction` describes a write; it remains behind the existing preview→approve→write trust loop and changes none of its proof fields (Invariants W1–W3).

The **BANNED-PATTERN guard** (Drift Guard 2, built later in Phase 2) will add "route-local recomputation of packet-owned facts" and "session-truth selectors outside WorkoutSession" as each of `CoachTurnPacket` / `WorkoutSession` is ratified.

---

## 2. The eight contracts — ratification ledger

| Contract | Purpose | Status | Shape lives today in | Ratification target | Consumed by · Basis |
|---|---|---|---|---|---|
| **CoachingDecision** | The engine's single decision object (decision_type, payload, caveats, safety, provenance) | **RATIFIED** | `services/coachingDecision.js` + `config/coaching/contracts/decision.contract.json` + `test/contracts-integrity.test.js` (see `docs/COACHING_CONTRACTS_SPEC.md`) | none — already versioned/tested; extend integrity test as peers land | Orchestrator · H-04 |
| **AthleteContext** | Durable athlete profile: goal, training level, population, equipment | **RATIFIED (read-only, unwired)** | `services/athleteContext.js` + `config/coaching/contracts/athlete-context.contract.json` + `test/athleteContext.test.js` (integrity in `test/contracts-integrity.test.js`); staged in `config/wiring-allowlist.json`. Names/versions `StateSnapshot.profile`; `profile_goal` validated against `trainingKnowledge` | Phase 5e plumbs the fields, closes H-07 | Brain modules, planner · H-07 |
| **WorkoutSession** | The one truth of the in-progress session: ordered slots, set tallies, derived cursor | **RATIFIED (read-only, unwired)** | `services/workoutSession.js` + `config/coaching/contracts/workout-session.contract.json` + `test/workoutSession.test.js` (integrity in `test/contracts-integrity.test.js`); staged in `config/wiring-allowlist.json`. Names/versions `src/app/activeSession.js` (with a tested `fromActiveSession` boundary adapter); owns the derived cursor (`currentSlot` = first pending) | Phase 4 route consumes it; session-priority invariant · H-08/H-18 |
| **ExerciseIdentity** | Immutable identity for an exercise; every name/alias a projection | **RATIFIED (read-only, unwired)** | `services/exerciseIdentity.js` + `config/coaching/contracts/exercise-identity.contract.json` + `test/exerciseIdentity.test.js` (integrity in `test/contracts-integrity.test.js`); staged in `config/wiring-allowlist.json` until wired | Phase 5b immutable registry consumes it; other representations become aliases | Identity joins everywhere · H-11 (Phase 5b) |
| **InteractionTrace** | One turn's end-to-end record: turn ID from first boundary through write proof | **RATIFIED (read-only, unwired)** | `services/interactionTrace.js` + `config/coaching/contracts/interaction-trace.contract.json` + `test/interactionTrace.test.js` (integrity in `test/contracts-integrity.test.js`); staged in `config/wiring-allowlist.json`. One `turn_id` across the 10-stage canonical spine; `missingStages()` feeds the divergence report | Phase 3 shadow/divergence · H-14 |
| **SafetyDecision** | The single safety verdict consumed by route and Brain alike; presentation may differ, decision may not | **RATIFIED (read-only, unwired)** | `services/safetyDecision.js` + `config/coaching/contracts/safety-decision.contract.json` + `test/safetyDecision.test.js` (integrity in `test/contracts-integrity.test.js`); staged in `config/wiring-allowlist.json`. One versioned verdict — `state` (green/yellow/red), `blocking`, `confidence`, `signals`, `reason` — and the single owner of the safety-state vocabulary; a `fromClassification` boundary adapter versions the `services/safetyClassifierModule.js` output | Phase 5d wires it as the most-conservative override, retires the duplicate classifiers, closes H-12 · Route + Brain |
| **CloseoutTransaction** | The atomic session-closeout write: sets + effort + plan closeout as one proven transaction | **RATIFIED (read-only, unwired)** | `services/closeoutTransaction.js` + `config/coaching/contracts/closeout-transaction.contract.json` + `test/closeoutTransaction.test.js` (integrity in `test/contracts-integrity.test.js`); staged in `config/wiring-allowlist.json`. Versions the three legs from `services/closeoutSummary.js` (`rows_to_write.{log,effort}` + `rows_to_seal`) plus the proof envelope; encodes Invariants W1-W3 as validator rules and changes none of them; a `fromCloseoutSummary` boundary adapter | Phase 5g wires it over the existing trust loop, closes H-17 · Write path |
| **CoachTurnPacket** | The assembled truth of one coach turn — every fact the reply may use, from one place | **RATIFIED (read-only, unwired)** | `services/coachTurnPacket.js` + `config/coaching/contracts/coach-turn-packet.contract.json` + `test/coachTurnPacket.test.js` (integrity in `test/contracts-integrity.test.js`); staged in `config/wiring-allowlist.json`. Keyed by the InteractionTrace `turn_id`; embeds AthleteContext, WorkoutSession, the ExerciseIdentity list, CoachingDecision, SafetyDecision, and (on a closeout turn) CloseoutTransaction — each validated by its OWN contract's validator, so "one Brain" is a schema invariant; the single safety verdict is enforced consistent across `safety` and `decision` | Phase 3 shadow assembles it, Phase 4 route consumes it, closes H-03 · Live coach route |

Status legend: **RATIFIED** = versioned schema + validator + test exist; **PARTIAL** = a concrete shape exists but is unnamed/unversioned or single-surface; **GREENFIELD** = named in the plan, no implementation yet.

---

## 3. Notes on the partial/greenfield contracts

These are intentionally *maps*, not designs — each contract's own PR fixes its field list under review, grounded in the home above.

- **AthleteContext** already exists as `StateSnapshot.profile`; ratification names and versions it and plumbs `equipment_profile`/readiness from their defined sources (Phase 5e closes H-07). No new read I/O beyond what `stateAssembly` already performs.
- **WorkoutSession** is authoritative on the client (`activeSession.js`); the server sees only `log_history`. Ratification defines the shared shape so "what's next?" answers identically on both, and is the anchor for the session-priority invariant (Phase 4, H-08/H-18).
- **ExerciseIdentity** rides the Phase 5b registry: the ratified contract is the immutable identity; `exercise.schema.json` and the catalog become projections/aliases. Sequenced before the name-keyed join migration.
- **InteractionTrace** unifies today's telemetry islands (Flight Recorder + the two shadows) behind one turn ID — the Phase 3 deliverable; ratifying the shape first lets the shadow log against it.
- **SafetyDecision** is one verdict, not a renderer: the contract is the decision; route and Brain may present it differently but must not each re-derive it (H-12).
- **CloseoutTransaction** describes the *existing* write, not a new one. It stays entirely inside preview→approve→write; ratification adds no write capability and touches no proof field without owner approval.
- **CoachTurnPacket** is ratified **last and most carefully** — it is the object the whole Phase 3–4 arc assembles and consumes, so its shape depends on the six above being named first.

---

## 4. Ratification sequence (one concern per PR)

Ordered low-risk → high-risk so the load-bearing contracts are ratified only after their inputs are named:

1. ✅ **This charter** (convention + ledger; no runtime change).
2. ✅ `ExerciseIdentity` — ratified read-only (`services/exerciseIdentity.js`); unblocks Phase 5b.
3. ✅ `AthleteContext` — ratified read-only (`services/athleteContext.js`), promotes `StateSnapshot.profile`.
4. ✅ `WorkoutSession` — ratified read-only (`services/workoutSession.js`), owns the derived cursor.
5. ✅ `InteractionTrace` — ratified read-only (`services/interactionTrace.js`), one turn ID over the stage spine.
6. ✅ `SafetyDecision` — ratified read-only (`services/safetyDecision.js`), one verdict; single owner of the safety-state vocabulary.
7. ✅ `CloseoutTransaction` — ratified read-only (`services/closeoutTransaction.js`), the existing closeout write over the trust loop (proof invariants W1-W3 unchanged).
8. ✅ `CoachTurnPacket` — ratified read-only (`services/coachTurnPacket.js`), assembled from the other seven; each embedded fact validated by its own contract (one Brain).

`CoachingDecision` is already ratified; each new contract extends `test/contracts-integrity.test.js`.

---

## 5. Relationship to the other Phase 2 guards

- The **wiring guard** (`scripts/check-wired-modules.js`, semantic since Work item 1a) keeps a ratified contract's builder/validator from silently going dead.
- The **system authority map** (`docs/ATLAS_SYSTEM_AUTHORITY.md`, which replaced the Work item 1b ownership/connectivity inventory) is the *authority* map; this charter is the *shape* map. A contract ratified here holds production authority only where that map says so — several contracts ratified below are `CONTRACT ONLY` today.
- The **completion-ladder** (Work item 3) will let a capability claim `route-consumed`/`user-visible` only against a ratified contract with a linked test — this charter is what "ratified" means for that validator.
