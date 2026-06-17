# Atlas Substitution / Intent Classification Specification

> **Status: PROPOSED (PR 1 — spec only, awaiting owner approval).** Single source of truth for what a substitution *is* in Atlas and how it is judged. Code follows this spec; if behavior is ever wrong, change this spec first, then the code. No classifier code ships until this spec is approved.

## GOAL

Atlas must not guess whether a substituted exercise was a good idea.

When a lifter logs a different exercise than the one prescribed, Atlas must classify that substitution deterministically — from movement pattern and muscle coverage — and decide whether the substitute **preserved the session's intent** or **abandoned it**.

The classifier's job is to determine *what kind* of substitution happened.

The voice layer's job is only to *word* that decision.

The system must be predictable, testable, explainable, and auditable.

A user should always be able to understand:

* What they were prescribed
* What they logged instead
* Whether the substitute kept the intended training stimulus
* Why Atlas approved the pivot or warned that the objective was abandoned

---

## CORE PRINCIPLE

A substitution is a change of *tool*, not necessarily a change of *intent*.

The question is never "did the work get done?" — it is "did the *stimulus the session was for* happen?"

A substitution preserves intent when it keeps the same movement pattern and trains the same primary muscles, or when a real constraint (pain, equipment) justifies a defensible redirect.

A substitution abandons intent when the logged work trains a different stimulus and nothing justified the change.

Atlas must distinguish between:

1. A preserved substitution (same intent, different tool)
2. A changed substitution (related region, wrong muscle emphasis)
3. An abandoned substitution (different stimulus, no justification)
4. A baseline situation (no history to judge against)

Do not treat "another machine for the same body part" as automatically preserved. Matching the muscle matters, not just the room.

---

## SCOPE & PERSISTENCE (v1)

These boundaries are part of the spec, not implementation detail.

* **Ephemeral computed fact only.** The substitution verdict is computed at preview / set-reaction time and emitted read-only, exactly like the expectation verdict (`computeExpectationVerdict`). It is **not persisted**.
* **No schema migration.** No new column on the 12-column `Log_Cleaned` row contract.
* **No new sheet tab.** No `Substitutions` tab, no audit trail. (If an audit trail is ever wanted, it is a separate, owner-approved, append-only-tab change — out of scope here.)
* **No write-path changes.** The verdict never routes through the preview → approve → write trust loop, carries no `write_id`, and never touches `Log_Cleaned`, `Effort`, or any other tab.
* **Existing preview-time signals only.** v1 judges the logged lift against the **in-memory prescribed lift** (the recommendation already shown for the session) using engine modules that already exist. It does **not** introduce a forward-looking pre-session pain / fatigue / constraint intake — that is a separate backlog item and is explicitly out of scope for v1.

---

## INPUT SIGNALS

The classifier is a pure function of signals the engine already produces. It invents none of them.

* **Prescribed lift** — name + lift code (from the session recommendation, available at preview time).
* **Logged lift** — name + lift code (from the parsed and enriched preview rows).
* **Movement pattern** — for both prescribed and logged lift.
* **Muscle coverage** — primary muscles for both, and their overlap.
* **Active constraints** — the existing `Constraints` tab (`kind ∈ injury | equipment | preference`, `rule ∈ avoid | limit | substitute`).
* **Pain signal** — the existing post-hoc pain flag scanned from set notes.
* **Systemic cost and lift role** of the prescribed lift — how much it matters that it was dropped.

---

## CLASSIFICATION TAXONOMY

Atlas must select exactly one classification and exactly one decision.

```
classification ∈ preserved | changed | abandoned | baseline
decision       ∈ approve | warn
```

| Classification | Meaning | Decision |
|---|---|---|
| `preserved` | Same intent, different tool. Same pattern + muscle, or a constraint-justified redirect. | `approve` |
| `changed` | Related region but wrong muscle emphasis. The prescribed muscle was skipped, not substituted. | `warn` |
| `abandoned` | Different stimulus entirely, no justification. The session's objective went untrained. | `warn` |
| `baseline` | No prior history to judge against — calibration. | `approve` |

---

## DECISION RULES

Evaluated deterministically, in order.

### baseline

If there is no usable history for the prescribed/logged lift, classify `baseline` → `approve` (`no_history_calibration`). Do not pretend to judge intent without data.

### preserved → approve

Classify `preserved` when **either**:

* **Pattern + muscle match.** Same movement pattern AND primary-muscle overlap at or above the match threshold. (Equipment swap within the same intent.)
* **Constraint-justified redirect.** A present pain signal or matching equipment constraint justified the pivot, AND the substitute keeps a defensible portion of the intended muscle/pattern within what the constraint allows.

### changed → warn

Classify `changed` when the substitute shares a broad region with the prescription but trains the **wrong muscle emphasis** — primary-muscle overlap below the match threshold while some related region remains. The prescribed muscle was skipped, not substituted (`wrong_muscle`).

### abandoned → warn

Classify `abandoned` when the substitute trains a **different stimulus entirely** (different pattern, primary-muscle overlap at or near zero), no pain or equipment constraint justified the change, and the prescribed lift carried real training weight (medium/high systemic cost or a main role). The objective went untrained (`pattern_abandoned`).

---

## OVERRIDE ORDERING

The pain / constraint signal interacts with the pattern/muscle decision in one direction only.

* A **present and matching** pain or equipment constraint may only ever **upgrade** a borderline result toward `preserved · approve`. A defensible redirect away from a painful or unavailable movement is a preserved pivot, not an abandonment.
* A pain or constraint signal must **never downgrade** a genuine pattern + muscle match.
* The absence of a constraint **never upgrades** anything. An unjustified abandon stays `warn` even when the lifter felt good and the work was hard — feeling good is not a license to change the objective.

In short: constraints can rescue a swap; they can never condemn one, and their absence can never excuse one.

---

## CORE EXAMPLES

These are the spec made concrete. The classifier's golden fixtures must reproduce them.

| Prescribed → Logged | Pattern | Muscle | Constraint / Pain | Classification | Decision |
|---|---|---|---|---|---|
| Squat → Leg Press | both lower | quads/glutes overlap | rack busy | `preserved` | `approve` |
| Bench → Incline Dumbbell Bench | push = push | chest/delts overlap | station full | `preserved` | `approve` |
| Hamstring Curl → Leg Extension | knee flexion → knee extension | **opposite muscle** | none | `changed` | `warn` |
| Squat → Treadmill + Curls | lower → conditioning/isolation | **≈ zero overlap** | none (excuse, not constraint) | `abandoned` | `warn` |
| (Shoulder pain) Pressing → non-shoulder pivot | push → lower / non-shoulder | shoulder deloaded by design | pain redirect | `preserved` | `approve` |
| Brand-new user, no history | n/a | n/a | n/a | `baseline` | `approve` |

---

## USER COMMUNICATION

The voice layer may only word the engine's substitution decision. It may not decide `preserved` / `changed` / `abandoned` itself, and it may not contradict or relabel the decision the engine emitted.

When wording a substitution, Atlas may:

* Name the prescribed lift and the logged lift.
* Restate the engine's reason in natural language.
* Give the forward recommendation (e.g. "get a real leg session in this week").
* Add a "watch" note when the decision carries one.

Atlas must not:

* Invent a movement-pattern or muscle claim the engine did not provide.
* Call an `approve` a mistake, or wave a `warn` through as fine.
* Name a different reason than the one the engine chose.

When the language model is unavailable, the decision still surfaces through a templated line keyed off the classification — because the decision is engine data, not voice.

---

## IMPORTANT RULE

The classifier decides WHAT kind of substitution happened and WHETHER it preserved the intent.

The voice layer only WORDS that decision.

Atlas must not infer substitution quality in the voice layer, must not invent the verdict, and must not let any client-supplied value override the engine's classification.
