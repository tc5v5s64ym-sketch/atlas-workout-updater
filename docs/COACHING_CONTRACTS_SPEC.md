# Atlas Coaching Contracts — Implementation Spec

> **Status:** Narrow spec doc. Implements the three load-bearing interfaces from `docs/COACHING_ENGINE_ARCHITECTURE.md`.
> **Scope:** `IntentEnvelope`, `CapabilityManifest`, `CoachingDecision`. Schemas, enums, validation rules, worked examples, file layout, tests-to-prove.
> **Status update (2026-07-01): SHIPPED.** All three contracts are built and tested (One-Brain build sequence PR-1/2/3 — `services/intentEnvelope.js`, `services/capabilityManifest.js`, `services/coachingDecision.js`, with `test/contracts-integrity.test.js`). This doc is now the reference for the shipped contracts, not a pending build.
> **Conventions (from the repo):** declarative vocabularies under `config/coaching/`; pure builders/validators under `services/`; tests are `node:test` files under `test/`. JSON below is illustrative (design artifact), not implementation.

---

## 0. File layout

```
config/coaching/contracts/
  intent.vocabulary.json        # intent enum, source enum, constraint-key schema
  decision.contract.json        # decision_type enum, payload-type registry, caveat/safety enums
config/coaching/manifests/
  intent-capabilities.json      # intent → [capability ids] + decision_type + read_only
  capabilities.json             # capability descriptors (requires/optional/depends_on/produces/module/status)
services/
  intentEnvelope.js             # buildIntentEnvelope(), validateIntentEnvelope()
  capabilityManifest.js         # load, resolve(intent) → ordered capability DAG
  coachingDecision.js           # buildCoachingDecision(), validateCoachingDecision()
test/
  intentEnvelope.test.js
  capabilityManifest.test.js
  coachingDecision.test.js
  contracts-integrity.test.js   # cross-contract referential integrity ("one Brain" guard)
```

**config vs service split:** vocabularies are data non-engineers may extend → config JSON (lazy-loaded, frozen, matching `goalTemplateModule`/`routes.js`). Validators/builders are pure functions → services. None of these read Sheets, call an LLM, or write.

---

## 1. IntentEnvelope

The single object every input source produces. Produced by the Intent Router; consumed by the Orchestrator.

### 1.1 Schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | integer | ✅ | `1`. Bumped only on breaking change. |
| `type` | string (enum) | ✅ | Canonical intent. §1.2 |
| `constraints` | object | ✅ | May be `{}`. Keys validated against §1.3 |
| `source` | string (enum) | ✅ | `button \| chat \| voice \| api \| wearable \| schedule` |
| `raw_input` | string | ⬜ | Original text/voice transcript, for audit. Omitted for structured sources |
| `extraction` | object | ⬜ | Present only when produced by the input-LLM. `{ confidence:0..1, model, fields_extracted:[] }` |
| `asOf` | string (ISO-8601) | ✅ | Request timestamp; drives all "days since" math downstream |
| `actor` | string (enum) | ✅ | `user \| system`. `system` = push/event-initiated (wearable, schedule) |

### 1.2 `type` enum (closed; extend by addition only)

`best_workout`, `generate_workout`, `modify_workout`, `progression_review`, `explain_recommendation`, `substitute_exercise`, `log_intent`, `progress_query`, `readiness_checkin`, `ingest_signal`, `nutrition_query`, `onboarding_step`, `clarify_intent`.

### 1.3 `constraints` key schema (flat, additive bag)

| Key | Type | Allowed values / shape |
|---|---|---|
| `focus` | string (enum) | `upper_body \| lower_body \| push \| pull \| hinge \| squat \| core \| full_body` |
| `duration_minutes` | integer | `10..180` |
| `equipment` | string[] (enum) | items ∈ `barbell \| dumbbell \| machine \| cable \| bodyweight \| kettlebell \| bands` |
| `injury` | string (enum) | `shoulder \| knee \| lower_back \| elbow \| wrist \| hip \| ankle \| neck` |
| `exclude_exercises` | string[] | exercise names/ids; resolved via entityResolution |
| `target_lift` | string | a single lift code/name |
| `intent_tag` | string (enum) | `strength \| hypertrophy \| recovery \| power` |
| `readiness_inputs` | object | keys ∈ `sleep,soreness,stress,motivation,recent_load,hrv`; each integer `0..10` |
| `signal` | object | wearable payload: `{ kind: recovery\|sleep\|session\|hrv, provider, captured_at, values:{} }` |

**Constraint-bag rule:** new capabilities add new *keys*, never new intents. "Upper body" and "30 minutes" are the **same** `generate_workout` intent with different keys. This is the structural guarantee that a button and a sentence cannot create divergent coaching lanes.

### 1.4 Validation rules

1. `schema_version`, `type`, `constraints`, `source`, `asOf`, `actor` present; `type`/`source`/`actor` ∈ their enums.
2. Every key in `constraints` ∈ the §1.3 key set; each value passes its type/enum/range check. **Unknown constraint key → reject.**
3. `asOf` parses as ISO-8601.
4. `extraction` present ⟺ `source ∈ {chat, voice}`. When present, `extraction.confidence ∈ [0,1]`.
5. `actor = system` ⟹ `source ∈ {wearable, schedule}`.
6. `type = ingest_signal` ⟹ `constraints.signal` present.
7. `type = readiness_checkin` ⟹ `constraints.readiness_inputs` present.
8. Validation is total and pure: returns `{ valid, errors[] }`, never throws, never mutates.

### 1.5 Worked examples (the five canonical inputs)

```jsonc
// "Coach's Pick" button
{ "schema_version":1, "type":"best_workout", "constraints":{},
  "source":"button", "asOf":"2026-06-30T14:00:00Z", "actor":"user" }

// "I want upper body" (chat)
{ "schema_version":1, "type":"generate_workout",
  "constraints":{ "focus":"upper_body" },
  "source":"chat", "raw_input":"I want upper body",
  "extraction":{ "confidence":0.96, "model":"input-llm", "fields_extracted":["type","focus"] },
  "asOf":"2026-06-30T14:00:00Z", "actor":"user" }

// "I only have 30 minutes" (chat)
{ "schema_version":1, "type":"generate_workout",
  "constraints":{ "duration_minutes":30 },
  "source":"chat", "raw_input":"I only have 30 minutes",
  "extraction":{ "confidence":0.93, "model":"input-llm", "fields_extracted":["type","duration_minutes"] },
  "asOf":"2026-06-30T14:00:00Z", "actor":"user" }

// "My shoulder hurts" (voice)
{ "schema_version":1, "type":"modify_workout",
  "constraints":{ "injury":"shoulder" },
  "source":"voice", "raw_input":"my shoulder hurts",
  "extraction":{ "confidence":0.89, "model":"input-llm", "fields_extracted":["type","injury"] },
  "asOf":"2026-06-30T14:00:00Z", "actor":"user" }

// "Bench felt easy" → progression review (chat)
{ "schema_version":1, "type":"progression_review",
  "constraints":{ "target_lift":"BENCH" },
  "source":"chat", "raw_input":"bench felt easy today",
  "extraction":{ "confidence":0.91, "model":"input-llm", "fields_extracted":["type","target_lift"] },
  "asOf":"2026-06-30T14:00:00Z", "actor":"user" }
```

### 1.6 Tests to eventually prove

- Each of the 13 intents builds a valid envelope; every `source`/`actor` enum accepted.
- Unknown constraint key, out-of-range `duration_minutes`, bad `readiness_inputs` value → rejected with a field-specific error.
- Cross-field rules 4–7 enforced (e.g. `ingest_signal` without `signal` rejected).
- Structured passthrough (button) and LLM extraction (chat) yield **identical envelope shape** for the same intent — the lane-equivalence property.
- Validator is pure: same input → same `{valid,errors}`, no throw on malformed/partial input.

---

## 2. CapabilityManifest

Two declarative files that let the Orchestrator turn an intent into an ordered module run **without containing a single coaching rule**.

### 2.1 `intent-capabilities.json` — intent → capability set

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | integer | ✅ | `1` |
| `intents` | object | ✅ | keyed by intent `type` |
| `intents[type].capabilities` | string[] | ✅ | the **requested** (top-level) capability ids; the resolver pulls in their `depends_on` closure and topo-sorts |
| `intents[type].decision_type` | string (enum) | required when `brain:true` | the `decision_type` this intent yields (§3.2) |
| `intents[type].read_only` | boolean | ✅ | `true` ⟹ no coaching decision, pure readout |
| `intents[type].brain` | boolean | ⬜ (default `true`) | `false` marks a non-Brain intent routed elsewhere (e.g. `log_intent` → trust loop); carries `routes_to` and no `decision_type` |
| `intents[type].routes_to` | string | required when `brain:false` | where a non-Brain intent is routed (e.g. `trust_loop`) |

### 2.2 `capabilities.json` — capability descriptors

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✅ | stable capability id, e.g. `progression`, `scenario_classifier` |
| `module` | object | ✅ | `{ file, export }` — the pure module that implements it |
| `requires` | string[] | ✅ | input keys that MUST be present to run (§2.3). May be `[]` |
| `optional` | string[] | ✅ | enrichers that improve output if present |
| `depends_on` | string[] | ✅ | capability ids whose output this consumes (DAG edges) |
| `produces` | string[] | ✅ | **output keys** this capability contributes to the decision — a separate namespace from input keys; declarative (NOT validated against the §2.3 vocabulary) |
| `status` | string (enum) | ✅ | `complete \| partial \| missing` — mirrors the architecture audit |

### 2.3 Input-key vocabulary (the "known + provided" universe)

State-derived (hydrated by State Assembly): `log_history`, `profile_goal`, `training_level`, `population`, `deload_state`, `memory_snapshot`, `equipment_profile`, `bodyweight_history`.
Intent-derived (from envelope constraints): `constraint.focus`, `constraint.duration_minutes`, `constraint.equipment`, `constraint.injury`, `constraint.target_lift`, `constraint.intent_tag`, `constraint.exclude_exercises`, `readiness_inputs`, `signal`.

A capability's `requires`/`optional` draw only from this vocabulary. `depends_on` references capability ids; a capability consumes another's output via `depends_on`, not by naming a `produces` key in `requires`. `produces` is its own output namespace and is declarative.

### 2.4 Validation rules

1. Every `intents[*].capabilities` id resolves to a descriptor in `capabilities.json`. **Dangling id → reject.**
2. Every `depends_on` id resolves; the dependency graph is **acyclic** (topological sort succeeds).
3. Every key in `requires`/`optional` ∈ the §2.3 input-key vocabulary. (`produces` is a declarative output namespace — not checked against the input vocabulary.)
4. Every `intents[*].decision_type` ∈ the decision-type enum (§3.2) — required when `brain:true`. A `brain:false` intent carries `routes_to` and no `decision_type`.
5. `read_only = true` ⟹ `decision_type ∈ { progress_readout }`.
6. The resolver computes the **transitive `depends_on` closure** of the intent's requested capabilities, so an intent need not hand-list transitive deps. Every `depends_on` id must resolve to a descriptor (rule 1) and the global graph must be acyclic (rule 2); the closure then topo-sorts so a capability always runs after everything it depends on.
7. Resolver output is a **topologically ordered** capability list over the closure; ties are broken by stable (sorted) id order for determinism; `status:missing` capabilities are skipped-with-flag (never silently dropped) and reported in `missing[]`. At runtime the Orchestrator additionally reports `requires`-unmet capabilities (drives clarification) once it knows the hydrated input keys.

### 2.5 Worked manifest fragments

```jsonc
// intent-capabilities.json (excerpt)
{ "schema_version":1, "intents":{
  "best_workout":      { "capabilities":["goals","memory","user_state","scenario_classifier",
                                         "progression","fatigue","volume","safety","equipment",
                                         "program_templates","session_generator","confidence"],
                         "decision_type":"workout", "read_only":false },
  "generate_workout":  { "capabilities":["goals","constraint_resolver","scenario_classifier",
                                         "progression","fatigue","volume","safety","equipment",
                                         "session_generator","confidence"],
                         "decision_type":"workout", "read_only":false },
  "modify_workout":    { "capabilities":["ontology","movement_patterns","safety","equipment",
                                         "constraint_resolver","volume","confidence"],
                         "decision_type":"substitution", "read_only":false },
  "progression_review":{ "capabilities":["intensity","user_state","scenario_classifier",
                                         "progression","expected_performance","confidence"],
                         "decision_type":"progression", "read_only":false },
  "progress_query":    { "capabilities":["user_state","memory"],
                         "decision_type":"progress_readout", "read_only":true }
}}
```

```jsonc
// capabilities.json (excerpt — status mirrors the architecture audit)
{ "id":"scenario_classifier",
  "module":{ "file":"services/scenarioClassifier.js", "export":"classifyScenario" },
  "requires":["log_history","constraint.target_lift"], "optional":["readiness_inputs"],
  "depends_on":["user_state","expected_performance"],
  "produces":["scenario_id"], "status":"missing" },

{ "id":"progression",
  "module":{ "file":"services/progressionModule.js", "export":"recommendProgression" },
  "requires":["log_history"], "optional":[],
  "depends_on":["scenario_classifier"],
  "produces":["target_weight","target_reps","lever","action","rationale"], "status":"partial" },

{ "id":"session_generator",
  "module":{ "file":"services/sessionGenerator.js", "export":"buildSession" },
  "requires":["log_history","profile_goal"],
  "optional":["constraint.focus","constraint.duration_minutes","constraint.equipment"],
  "depends_on":["progression","fatigue","volume","safety","equipment"],
  "produces":["session_blocks","why_today"], "status":"missing" }
```

The two `status:"missing"` rows are the architecture keystones (Scenario Classifier, Session Generator). The manifest makes their absence *machine-visible*: an intent requiring a missing capability resolves to degraded/`clarification_needed` rather than a wrong answer.

### 2.6 Tests to eventually prove

- Referential integrity: every capability id, every `depends_on`, every input key resolves; no cycles (topo-sort terminates).
- Resolver returns capabilities in dependency order (e.g. `scenario_classifier` before `progression` before `session_generator`).
- `read_only` intents map only to `progress_readout`.
- A `requires`-unmet capability surfaces as a missing-input report, not a crash.
- A `status:missing` capability is skipped-with-flag and recorded in `provenance.modules_run` as not-run.
- Resolver computes the transitive closure (an intent listing `scenario_classifier` auto-pulls `user_state`, `expected_performance`, `intensity`) and is deterministic across calls.
- **Orchestrator-is-rule-free guard:** the routing layer imports no Brain decision module — only `node:` builtins + the JSON manifests. Pinned now against `services/capabilityManifest.js` (the manifest reader); extended to the Orchestrator module itself when it lands (PR-5).

---

## 3. CoachingDecision

The single object the Brain emits for every intent. Stable envelope + typed payload. Consumed by the output-LLM and every render target.

### 3.1 Envelope schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | integer | ✅ | `1` |
| `intent` | object | ✅ | echoed `{ type, constraints, source }` from the envelope |
| `decision_type` | string (enum) | ✅ | discriminator. §3.2 |
| `status` | string (enum) | ✅ | `answered \| needs_clarification` |
| `confidence` | object | ✅ | `{ score:0..100, tier, action, caveats[] }` — always present |
| `safety` | object | ✅ | `{ level, flags[], blocking:boolean }` — always present |
| `payload` | object | ✅ | shape determined by `decision_type`. §3.3 |
| `missing_info` | array | ✅ | `[]` when `answered`; non-empty when `needs_clarification` |
| `explanation_inputs` | object | ✅ | **whitelist** — the only values the LLM may speak |
| `provenance` | object | ✅ | `{ modules_run[], skipped[], state_asOf, engine_version }` |

### 3.2 Enums

- `decision_type`: `workout`, `progression`, `substitution`, `recovery`, `onboarding`, `nutrition`, `progress_readout`, `clarification_needed`.
- `confidence.tier`: `high`, `moderate`, `low`. `confidence.action`: `act`, `act_with_caveat`, `ask`.
- `confidence.caveats[]` ∈ the **exact lowercase values `confidenceModule` emits** (the producer; a contracts-integrity test guards this): `insufficient_history`, `stale_data`, `low_trend_confidence`, `limited_readiness_inputs`, `exercise_unresolved`, `safety_flag_present`.
- `safety.level`: `green`, `yellow`, `red`.
- `missing_info[].field` ∈ the §2.3 input-key vocabulary. `missing_info[].information_gain` ∈ `[0,1]`.

### 3.3 Payload registry (discriminated by `decision_type`)

```jsonc
// workout
{ "session_label","focus","target_duration_min",
  "blocks":[ { "exercise","lift_code","pattern","sets","reps",
               "target_weight","target_rir","scenario_id","source":"brian","warmup":bool } ],
  "why_today":[/* machine facts */], "substitutions_applied":[] }

// progression
{ "lift_code","scenario_id","action","lever","target_weight","target_reps",
  "e1rm","trend","expected_reps","plateau": null }

// substitution
{ "original_lift_code","candidates":[ { "exercise","reason","equipment","pattern_match" } ] }

// clarification_needed
{ "reason":"insufficient_data" | "ambiguous_constraint" }   // questions live in missing_info

// progress_readout (read_only)
{ "lift_code","prs":{},"trend","sessions_analyzed" }         // no prescription

// nutrition — RESERVED; capability owner-gated/unbuilt; type registered so the contract never changes later
```

### 3.4 Validation rules

1. All envelope fields present; enums valid.
2. **Discriminator integrity:** `payload` conforms to the registered shape for `decision_type`.
3. **Ask/answer integrity:** `status = needs_clarification` ⟺ `decision_type = clarification_needed` ⟺ `missing_info` non-empty ⟺ `confidence.action = ask`. All four move together or the decision is invalid.
4. **Trust-contract integrity (critical) — KEY-AWARE:** every numeric value in `payload` that represents a prescribed quantity (`target_weight`, `reps`, `target_rir`, `e1rm`, …) must be **echoed under its corresponding key** in `explanation_inputs`. The LLM may speak **only** `explanation_inputs`; this guarantees it can speak every prescribed number — under that number's own key — and *no number absent from the Brain's output*. Representation: for single-value payloads (progression/nutrition), `explanation_inputs[field] === payload[field]`; for `workout`, `explanation_inputs.blocks[i][field] === payload.blocks[i][field]` (order-aligned, per block). A right value echoed under the *wrong* key, or an incidental match, no longer satisfies the contract.
5. **Safety escalation:** `safety.blocking = true` ⟹ `confidence.action ≠ act` (forced to `act_with_caveat` or `ask`) and `safety_flag_present ∈ caveats`.
6. `read_only` intents ⟹ `decision_type = progress_readout`, `payload` carries no prescription fields, `explanation_inputs` carries only descriptive facts.
7. **Provenance accounting.** `modules_run` and `skipped` are disjoint string arrays, and their union ⊆ the manifest's resolved capability set for the intent (no out-of-plan module ran). The stronger "union *equals* the resolved set" (full accounting, nothing silently dropped) is an Orchestrator-output property enforced by the Orchestrator's own test when it lands (PR-5) — the standalone decision validator checks ⊆, since a decision object alone need not enumerate the entire closure.
8. `missing_info` is sorted by `information_gain` descending, truncated to the **minimum set whose resolution would flip `action` to `act`** (minimality — "ask only what's needed").
9. Validator is pure: `{ valid, errors[] }`, no throw, no mutation.

### 3.5 Worked examples (decisions)

```jsonc
// best_workout → answered (high confidence, no questions)
{ "schema_version":1,
  "intent":{ "type":"best_workout","constraints":{},"source":"button" },
  "decision_type":"workout","status":"answered",
  "confidence":{ "score":82,"tier":"high","action":"act","caveats":[] },
  "safety":{ "level":"green","flags":[],"blocking":false },
  "payload":{ "session_label":"Upper Power","focus":"upper_body","target_duration_min":60,
    "blocks":[ { "exercise":"Bench Press","lift_code":"BENCH","pattern":"horizontal_push",
                 "sets":3,"reps":5,"target_weight":185,"target_rir":2,
                 "scenario_id":"consistent_progress","source":"brian","warmup":false } ],
    "why_today":["bench_trend:improving","push_recovery:ready"],"substitutions_applied":[] },
  "missing_info":[],
  "explanation_inputs":{ "blocks":[{ "target_weight":185,"reps":5,"target_rir":2 }],
    "trend":"improving","recovery":"ready" },
  "provenance":{ "modules_run":["goals","user_state","scenario_classifier","progression",
                 "fatigue","volume","safety","session_generator","confidence"],
                 "skipped":[],"state_asOf":"2026-06-30T14:00:00Z","engine_version":"1.0.0" } }

// "my shoulder hurts" → answered modification (safety yellow, non-blocking)
{ "schema_version":1,
  "intent":{ "type":"modify_workout","constraints":{"injury":"shoulder"},"source":"voice" },
  "decision_type":"substitution","status":"answered",
  "confidence":{ "score":71,"tier":"moderate","action":"act_with_caveat",
                 "caveats":["safety_flag_present"] },
  "safety":{ "level":"yellow","flags":["shoulder"],"blocking":false },
  "payload":{ "original_lift_code":"OHP",
    "candidates":[ { "exercise":"Landmine Press","reason":"reduced overhead shoulder load",
                     "equipment":"barbell","pattern_match":"vertical_push_partial" } ] },
  "missing_info":[],
  "explanation_inputs":{ "swapped_from":"Overhead Press","swapped_to":"Landmine Press",
    "reason":"reduced overhead shoulder load" },
  "provenance":{ "modules_run":["ontology","movement_patterns","safety","equipment",
                 "constraint_resolver","confidence"],"skipped":[],
                 "state_asOf":"2026-06-30T14:00:00Z","engine_version":"1.0.0" } }

// progression_review with thin history → needs_clarification (minimum one question)
{ "schema_version":1,
  "intent":{ "type":"progression_review","constraints":{"target_lift":"BENCH"},"source":"chat" },
  "decision_type":"clarification_needed","status":"needs_clarification",
  "confidence":{ "score":38,"tier":"low","action":"ask",
                 "caveats":["insufficient_history","limited_readiness_inputs"] },
  "safety":{ "level":"green","flags":[],"blocking":false },
  "payload":{ "reason":"insufficient_data" },
  "missing_info":[
    { "field":"readiness_inputs","required":true,
      "question":"How did that set feel — close to failure or comfortable?",
      "information_gain":0.74 } ],
  "explanation_inputs":{ "sessions_analyzed":1 },
  "provenance":{ "modules_run":["intensity","user_state","scenario_classifier",
                 "expected_performance","confidence"],"skipped":["progression"],
                 "state_asOf":"2026-06-30T14:00:00Z","engine_version":"1.0.0" } }
```

The clarifying question is a **normal CoachingDecision** with `decision_type:clarification_needed`. It rides the same pipeline to the same output-LLM, which words the `missing_info[].question`. There is no separate "ask path" — asking is a decision type. That is what keeps "one Brain" intact even when the Brain needs more data.

### 3.6 Tests to eventually prove

- Each `decision_type` validates with a conforming payload; a mismatched payload is rejected.
- Ask/answer four-way invariant (rule 3) holds in both directions.
- **Trust-contract test (highest value):** every prescribed number in `payload` is present in `explanation_inputs`; a fixture with a `target_weight` missing from `explanation_inputs` is rejected.
- Safety-escalation invariant (rule 5): `blocking:true` forces `action ≠ act` and injects the caveat.
- `missing_info` minimality + descending `information_gain` ordering (rule 8).
- `provenance` accounts for every resolved capability (run ∪ skipped = resolved set).
- Round-trip: build → validate → serialize → parse → validate, stable.

---

## 4. "Know when it knows enough" — the three-party handshake

The "don't ask unnecessary questions / ask only the minimum" philosophy falls out of the contracts when **asking is a decision type, not a code path**:

1. **Each Brain capability declares its input contract** (`requires`/`optional` in `capabilities.json`).
2. **The Orchestrator computes the gap** — known (State Assembly) + provided (Intent constraints) vs required (manifests). This is bookkeeping, not coaching → stays in the orchestrator.
3. **ConfidenceModule adjudicates act-vs-ask:**
   - `action: act` → answer now; do not ask (assumptions noted in `caveats`).
   - `action: act_with_caveat` → answer, hedge honestly via `explanation_inputs`.
   - `action: ask` → emit `clarification_needed` with **only required-and-missing fields, ranked by `information_gain`, truncated to the minimum** that would flip the action to `act`.

`information_gain` ranking ensures minimality: the Brain asks the *fewest* questions that change what it would do.

---

## 5. How the three contracts deliver "one Brain"

| Surface | Enters as | Why it's the same Brain |
|---|---|---|
| Button (Coach's Pick) | `IntentEnvelope{source:button}` structured passthrough | Same envelope shape as chat; manifest keyed by `type`, blind to source |
| Chat / voice | `IntentEnvelope{source:chat\|voice, extraction}` via input-LLM | LLM only fills `type`+`constraints`; never reaches the manifest or a module |
| Wearable | `IntentEnvelope{source:wearable, actor:system, constraints.signal}` push intent | Event is just another intent source |
| API / desktop | `IntentEnvelope` in, `CoachingDecision` JSON out | The decision envelope *is* the API contract — render-agnostic |
| Future UI | new `source` enum value | One enum entry; zero change to Orchestrator/Brain |

The three seams: **IntentEnvelope** (every source → one shape), **CapabilityManifest** (intents decoupled from modules by config), **CoachingDecision** (one render-agnostic, number-whitelisted envelope). `contracts-integrity.test.js` is the standing guard: every intent has a manifest entry; every manifest capability resolves to a module and a valid `decision_type`; every example fixture validates. If a future change breaks the one-Brain property, that test fails before merge.

---

## 6. Owner-gated before build

Unchanged from the architecture blueprint: the **input-LLM provider/model** (new runtime model spend) and any **proactive-output policy** (wearable/notification-initiated coaching) are owner-reserved. Neither is needed to build and test these three contracts — they are pure and deterministic. The natural next spec is **State Assembly** (the read-model the manifests' input keys are drawn from), the one seam these contracts reference but do not define.
