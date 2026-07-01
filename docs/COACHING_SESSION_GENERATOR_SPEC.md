# Atlas Coaching Engine — Session Generator Spec (Keystone #2)

> **Status:** Narrow spec doc. Defines the Brian-native replacement for `analytics.js::scoreIntents` — the engine that builds a full workout.
> **Scope:** the `session_generator` capability.
> **Status update (2026-07-01): the pure engine is SHIPPED & wired.** `services/sessionGenerator.js` (`buildSession`) is built, tested (`test/sessionGenerator.test.js`), and wired as a runner (manifest `session_generator` is now `partial`, not `missing`). **Still owner-gated:** replacing the live "Today's Pick" surface (`analytics.js::scoreIntents`) with this engine is a coach-surface/product-scope change and remains owner-reserved — the shipped module runs on the shadow/`brian` path, not as the live default.
> **Sequence:** One-Brain build — keystone #2 (`BACKLOG.md` → "One-Brain Coaching Engine").
> **Related session-building docs — which is canonical:** this spec is the **canonical Brain-native session engine** (shipped). [`SESSION_PLANNING_ENGINE.md`](./SESSION_PLANNING_ENGINE.md) is a *future, owner-gated* profile-aware **objective-selection** layer (*which* objective to train today) that would feed constraints into this generator — not a competing generator. [`SESSION_DESIGN.md`](../SESSION_DESIGN.md) is the older design of the current/legacy session-building logic, predating this engine. When they differ on how a session is assembled, this spec wins for the One-Brain path.

---

## Why this exists

The Orchestrator can answer *"what weight on this lift"* (via `scenario_classifier` → `progression`, shipped). It can now also assemble *"what's my workout today"* — the `session_generator` capability that builds a full session **has shipped** (`services/sessionGenerator.js`, wired as a runner), so the Brain can produce a `workout` `CoachingDecision` on the shadow/`brian` path. This was the second keystone; the remaining step — making it the **live** "Today's Pick" surface in place of `analytics.js::scoreIntents` — is owner-gated (see Status above).

Today the equivalent lives in `analytics.js::scoreIntents` (~950 lines), fused with analytics. The Session Generator is its **pure, Brain-native form**: it composes the already-shipped modules and emits a validated `workout` payload — inventing no numbers.

**Pure.** No I/O, no LLM, no Sheets, no write. It consumes the injected State Assembly snapshot; every number traces to an engine module.

---

## Signature

```
buildSession(state, constraints) → workoutPayloadResult | null

state       — the StateSnapshot (log_history, profile{profile_goal,training_level},
              deload_state, memory_snapshot, ...) from State Assembly
constraints — from the IntentEnvelope: focus, duration_minutes, equipment,
              injury, intent_tag, exclude_exercises

workoutPayloadResult = {
  payload:            <workout payload, see below>,
  explanation_inputs: { blocks: [ { target_weight, reps, target_rir }, ... ] , ... },
  why_today:          [ machine facts ],       // duplicated into payload.why_today
  substitutions_applied: [ ... ],
  notes:              [ diagnostics — capped patterns, dropped-for-equipment, etc. ]
}
```

Returns `null` when it cannot assemble a session (no usable history *and* no cold-start hints available) — the Orchestrator then degrades to clarification.

### The `workout` payload (per `decision.contract.json`)

```
payload = {
  session_label,            // e.g. "Upper Power"
  focus,                    // echoed from constraint.focus (or derived default)
  target_duration_min,      // echoed from constraint.duration_minutes (or default)
  blocks: [ {
    exercise, lift_code, pattern,
    sets, reps, target_weight, target_rir,   // prescribed numbers (engine-owned)
    scenario_id,             // from scenario_classifier, per lift
    source: 'brian',
    warmup: false,
  } ],
  why_today: [ machine facts ],
  substitutions_applied: [ { from, to, reason } ],
}
```

Block required fields (contract): `exercise, lift_code, sets, reps, target_weight, target_rir`.

---

## Composition — how it uses existing modules

The Session Generator is a **coordinator over shipped modules**; it holds selection/ordering policy, not new coaching math (the math is in the modules it calls).

1. **Movement-pattern set** — map `constraint.focus` → the patterns to cover:
   - `full_body` → squat/hinge + horizontal_push/pull (+ optional vertical_push, core)
   - `upper_body` → horizontal_push/pull + vertical_push (+ isolation)
   - `lower_body` → squat + hinge (+ accessory)
   - `push`/`pull`/`hinge`/`squat`/`core` → that pattern family
   Pattern vocabulary aligns with `onboardingSessionPlan` (`squat, horizontal_push, horizontal_pull, hinge, vertical_push, isolation`).

2. **Exercise selection per pattern** — pick one lift per pattern from the exercise ontology, filtered by:
   - **equipment** (`constraint.equipment` / `equipment_profile`) — drop patterns whose available variants need absent equipment (record in `notes`);
   - **exclusions** (`constraint.exclude_exercises`) via `entityResolutionModule`;
   - **program templates** (`goalTemplateModule.selectPrograms(goal, {trainingLevel})`) to bias structure toward the goal/level.

3. **Per-lift prescription** — for each selected lift:
   - **with history:** `scenario_classifier.classifyScenario` → `progressionModule.recommendProgression` → `target_weight`/`target_reps`/`scenario_id` (exactly the shipped progression path, per lift);
   - **cold-start lift (no history):** a conservative **start hint** from `buildWorkingWeightProtocol` (never an invented number); if the whole session is cold-start, defer to `onboardingSessionPlan` (that remains its own surface — see scope guard).

4. **Volume shaping** — `volumeAssessmentModule.assessWeeklyVolume(...)`: do not push a muscle **above MRV**; trim/added accessory sets move toward **MAV**. Volume decisions cap `sets`, they do not invent loads.

5. **Duration fitting** — `constraint.duration_minutes` → a deterministic time budget (per-block estimate); trim blocks/sets (accessories first) to fit. Record dropped items in `notes`.

6. **Safety veto** — `safetyClassifierModule`: a **red** flag makes the decision `blocking:true` (the Orchestrator/confidence escalate away from `act`); a **yellow** flag caps or swaps the affected pattern (recorded in `substitutions_applied`). Safety is the most conservative layer and can veto.

7. **Deload** — if `deload_state` is active, apply the protocol via `deloadProtocols.computePrescription` (already live): cut load by `load_multiplier`, show the protocol `target_rir`, scale sets by `set_multiplier`. Deload numbers come from the engine.

8. **`why_today`** — machine facts only (`bench_trend:improving`, `push_recovery:ready`, `volume:below_mav`). The coach-voice layer words them later; the Session Generator never phrases prose.

---

## Trust contract (KEY-AWARE) — how it stays valid

The emitted `payload` + `explanation_inputs` must pass `validateCoachingDecision` for `decision_type:'workout'`:

- **Discriminator:** `session_label` + `blocks` present; each block carries the required fields.
- **Key-aware trust contract (§3.4 rule 4):** `explanation_inputs.blocks[i][field] === payload.blocks[i][field]` for each prescribed number (`target_weight`, `reps`, `target_rir`), **order-aligned per block**. The Session Generator builds `explanation_inputs.blocks` in lockstep with `payload.blocks` — every prescribed number echoed under its own key. No number reaches the LLM that the engine didn't emit.
- **Provenance:** the Orchestrator records `session_generator` (and the per-lift `scenario_classifier`/`progression`) in `modules_run`.

---

## Scope guard — what it does NOT do

- **No LLM wording.** `why_today` is machine facts; the coach voice words them downstream. The engine never phrases prose.
- **No write.** Recommendation only; the preview→approve→write trust loop executes writes, outside the Brain.
- **No cold-start calibration plan.** A brand-new user with no history is `onboardingSessionPlan`'s job (shipped). The Session Generator handles the has-history case and defers individual cold lifts to a start hint.
- **No live-UI replacement of `scoreIntents`.** Building the pure engine is derivable and in scope. *Swapping the live "Today's Pick" surface from `scoreIntents` to this module* is a separate, **owner-gated** step (coach surface / product scope) — not covered here.

---

## Test strategy

Pure, stub-state tests (no live Sheets):

- **Payload shape + validity:** a built session passes `validateCoachingDecision` (`workout` discriminator + key-aware trust contract).
- **Pattern coverage:** `focus` → the expected pattern set; each covered pattern yields one block.
- **Equipment filtering:** an absent-equipment pattern is dropped (and noted), not emitted with an impossible exercise.
- **Injury veto:** a red flag → `blocking`; a yellow flag → swap recorded in `substitutions_applied`.
- **Duration fitting:** a 30-minute constraint trims to fewer blocks than a 60-minute one.
- **Volume ceiling:** a muscle already at MRV gets no added accessory sets.
- **Deload:** an active `deload_state` cuts load / RIR per the protocol.
- **Trust contract:** every block's prescribed numbers appear in `explanation_inputs.blocks[i]` under matching keys; a deliberately un-echoed number fails validation.
- **Golden fixtures:** 60-min upper-body; 30-min constraint; shoulder-injury modification; deload-active session.

---

## What this unblocks + follow-ups

Once the module ships:
- Flip `capabilities.json` `session_generator` `status: missing → partial` **in the same PR** (required — the contracts-integrity guard demands a non-`missing` status once the file exists, exactly as with `scenario_classifier`).
- **Follow-up:** the `session_generator` runner adapter (wire it so `best_workout`/`generate_workout` produce answered `workout` decisions on the shadow path — the first full Brian workout).
- After both keystones + adapters: the `analytics.js` migration can begin (move lifecycle decisions out one at a time until `scoreIntents`/`recommendNextSet` are retired).

**Owner-gated reminder:** the pure engine is derivable and not owner-gated. Enabling it on a live surface (replacing `scoreIntents` in the app, or turning `hybrid`→`brian`) is owner-reserved (coach surface / product scope), as is the input-LLM provider and any proactivity policy.
