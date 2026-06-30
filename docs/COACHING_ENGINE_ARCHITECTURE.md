# Atlas Coaching Engine — One-Brain Architecture

> **Status:** Architecture reference (blueprint). Not an active execution queue.
> **Routing:** Build sequence lives in `BACKLOG.md` → "One-Brain Coaching Engine". Contract details live in `docs/COACHING_CONTRACTS_SPEC.md`.
> **Governs:** the design Atlas's coaching engine converges toward. Does not amend the Constitution or Invariants — it *implements* them (engine owns the numbers, the LLM only words them, the trust loop is untouched).

---

## Prime principle: Atlas has ONE Brain

Not a Coach's Pick engine, not a chat engine, not a workout generator. **One Brain.**

Every interaction — button, typed message, voice, wearable event, calendar, push, API, future desktop app — flows through the exact same coaching intelligence. The UI never determines intelligence; the UI only expresses **intent**. The Brain determines the coaching response.

```
Coach's Pick        → "What's my best workout today?"
"I want upper body" → "Generate today's workout with an upper-body constraint."
"I only have 30 min"→ "Generate today's workout with a 30-minute constraint."
"My shoulder hurts" → "Modify today's recommendation with a shoulder limitation."
```

Same Brain. Different intent. **The user is never placed into a different coaching lane because they pressed a different button.** Only the intent and constraints supplied to the Brain change.

---

## The pipeline

```
        ┌─────────────────────────────────────────────────────────┐
        │  INTENT SOURCES (pull + push)                            │
        │  button · chat · voice · API · Watch · WHOOP · calendar  │
        └───────────────────────────┬─────────────────────────────┘
                                     ↓
   ①    INTENT ROUTER          structured passthrough | LLM extraction (text/voice)
                               → Intent Envelope { type, constraints, source, asOf }
                                     ↓
   ②    COACH ORCHESTRATOR     dataflow only, ZERO coaching rules
                               intent → capability manifest → module DAG → synthesis
                                     ↓                      ↓
   ③    STATE ASSEMBLY         ┃   ④  ATLAS BRAIN
        hydrate read-model once┃      pure capability modules (decisions live here)
        (Sheets → snapshot)    ┃
                                     ↓
   ④    STRUCTURED COACHING DECISION   one canonical envelope (answered | needs_clarification)
                                     ↓
   ⑤    LLM EXPLANATION        words explanation_inputs; never a number the Brain didn't emit
                                     ↓
                 render-agnostic: card · chat bubble · TTS · push · API JSON
```

### Layer responsibilities (hard boundaries)

| Layer | Owns | Must never |
|---|---|---|
| **① Intent Router** | What is being asked; what constraints came in; structured vs NL input | Decide the coaching response; read training history |
| **② Orchestrator** | Which capabilities run, in what order, what feeds what; assembling the envelope | Contain any coaching rule (no "if plateau then…") |
| **③ State Assembly** | All Sheets I/O; building one read-model snapshot | Interpret the data |
| **④ Atlas Brain** | Every coaching decision and number | Read Sheets directly; write; produce prose |
| **⑤ LLM Explanation** | Turning a decision into language | Choose a number, verdict, or action |
| **(side) Trust Loop** | Writes, previews, approvals (existing preview→approve→write) | Be entered by the Brain directly |

---

## Five architectural commitments

These sharpen the naive "UI → Brain → LLM" picture and are load-bearing.

1. **Two LLM boundaries, neither coaches.** Natural-language understanding ("my shoulder hurts" → `{intent: modify_workout, constraints:{injury:shoulder}}`) is an LLM job, but it is *extraction*, not coaching. The LLM appears at the **input** (language → intent) and the **output** (decision → language) and decides nothing in between. The Brain is sandwiched between two dumb translators.

2. **Buttons and sensors skip the LLM.** A button emits a fixed intent; a wearable emits a structured signal intent. Only unstructured input (chat, voice) routes through the input-LLM. The Intent Router has two lanes — **structured passthrough** and **LLM extraction** — converging on one envelope.

3. **Intents are pull *and* push.** Wearables, calendar, and schedules are *events*, not requests. The Intent Router is source-agnostic and bidirectional: a WHOOP recovery drop pushes an intent *in*; a morning nudge pushes a decision *out*. (`actor: system` marks event-initiated intents.)

4. **The Brain is pure and read-only.** Every Brain module is a pure function over a state snapshot. The Brain *recommends*; it never writes to Sheets. Logging, approvals, and the preview→approve→write trust loop stay **outside** the Brain, untouched. A Brain decision may *propose* a write; execution still flows through the existing trust loop. This protects the Invariants and keeps the Brain testable.

5. **State Assembly is a real layer.** Pure modules need a hydrated read-model (logs, profile, constraints, memory, deload state). One layer reads Sheets once and hands the same snapshot to every module. All I/O is quarantined here; the Brain stays pure.

---

## The three contracts (see `docs/COACHING_CONTRACTS_SPEC.md`)

The architecture holds together on three source/sink-agnostic seams:

- **IntentEnvelope** — every source, pull or push, collapses to one validated shape. The Orchestrator cannot tell a button from a sentence → *no per-button coaching lane.*
- **CapabilityManifest** — intents are decoupled from modules by declarative config. Adding an intent or capability never edits the Orchestrator → *intelligence stays in the Brain; routing stays declarative.*
- **CoachingDecision** — every decision (including "I need to ask you something") is one render-agnostic envelope whose numeric content is whitelisted → *one source of coaching truth; the LLM explains it everywhere, decides nowhere.*

---

## Atlas Brain — capability audit (as of 2026-06-30)

Existing modules regrouped by **capability**, with the complete/partial/missing verdict from the analytics-vs-Brian deep audit. This is recorded here so it is never re-derived.

### Complete (ready)
| Capability | Modules |
|---|---|
| Intensity math (e1RM ↔ target weight) | `intensityModule` |
| Volume vs MEV/MAV/MRV landmarks | `volumeModule`, `volumeAssessmentModule` |
| Plateau / expected-performance | `expectedPerformanceModule` |
| Deload execution (**already live**) | `deloadProtocols`, `deloadStateMachine`, `deloadState` |
| Confidence (ask vs act) — *unproven on live data* | `confidenceModule` |
| Memory / trend / patterns / entity resolution | `memoryModule`, `entityResolutionModule` |
| Goal & population policy | `goalTemplateModule`, `populationCapsModule` |
| Program templates (LP / 5-3-1 / block / DUP) | `starterProgramModule`, `intermediateProgramModule`, `periodizationModule` |
| Onboarding (engine complete, unwired) | `onboardingState`, `onboardingSessionPlan`, `onboardingRouter` |

### Partial (exists, gapped)
| Capability | Module | Gap |
|---|---|---|
| User state / facts | `userStateModule` | Trend algorithm **differs** from analytics (split-window 2% vs last-vs-first); PR sweep partial |
| Progression decision | `progressionModule`, `progressionRulesModule`, `autoregulationModule` | Executes a scenario but **needs a scenario handed in**; autoregulation is load-only (no bodyweight, no in-workout anchor) |
| Fatigue / readiness | `fatigueAssessmentModule` | `scoreReadiness` returns **null without check-in data** — cannot infer readiness from logs; recovery model coarser than analytics' continuous HR-weighted curve |
| Safety | `safetyRulesModule`, `safetyClassifierModule` | Substring matcher; **`confidence_inversion` not implemented** (filed in BACKLOG); not coach-wired |

### Missing (no module — must be built), ranked by how much they block One-Brain
1. **Scenario Classifier** *(keystone)* — facts → progression scenario id. Without it `progressionModule` cannot be driven by real data. Belongs in the Brain.
2. **Workout / Session Generator** *(keystone)* — assemble a full session from constraints + state. Today this is `scoreIntents` (~950 lines) **fused inside `analytics.js`**, not a Brain module. This is the real "Coach's Pick" and has no Brain form.
3. **Constraint Resolver** — apply `focus / duration / equipment / injury / exclude` to filter and shape a session. Pieces scattered (substitution, populationCaps, equipment-awareness); no unifier.
4. **Readiness-from-logs** — infer readiness when the user never checks in (analytics does this; Brian's fatigue module cannot).
5. **Equipment model** — first-class capability; today implicit inside substitution/onboarding.
6. **In-workout anchor & lifecycle decisions** — just-logged-set anchoring, post-deload return, staleness/layoff guards. Live in `analytics.js`; no Brain home.
7. **Nutrition** — explicitly unbuilt (roadmap PR 20), **owner-gated** by `CLAUDE.md`. The decision contract reserves space without building it.
8. **Decision Synthesizer** — composes module outputs into the one canonical decision (orchestrator/Brain seam).

**Headline:** the Brain is a strong *substrate* with two keystone holes — **Scenario Classifier** and **Session Generator**. Until those exist, the Brain answers "what weight on this lift" but not "what's my workout today." `analytics.js` still owns the second question.

---

## Relationship to `analytics.js`

`analytics.js` is not a numbers engine — it is a numbers engine *fused to an orchestration engine*. The Brain modules already replace the numbers; nobody has replaced the orchestration (scenario classification, the 5-path `recommendNextSet` decision tree, the `scoreIntents` session builder, the lifecycle guards).

The migration is therefore **not** "Brian as a second opinion behind analytics." It is: the Orchestrator is always the single decider; it sources some decisions from `analytics.js` only until they are rewritten as Brain/orchestrator logic. Each migration step moves one decision out of `analytics.js` and deletes that call. When the delegation set is empty, `analytics.js` dies.

There is never a point where two engines race to answer.

---

## Feature-flag strategy

Use a **three-state engine selector**, not a boolean:

```
ATLAS_COACH_ENGINE = legacy | hybrid | brian      (default: legacy)
```

- `legacy` — `analytics.js` only. Today's behavior, byte-for-byte.
- `hybrid` — Orchestrator runs and **attaches** its structured decision, but does **not** change output. Shadow/compare state: validates the Brain against `analytics.js` on live data before it drives anything.
- `brian` — the Orchestrator's structured decision drives the response; `analytics.js` is called only for un-migrated delegations.

A boolean (`ATLAS_BRIAN_ENABLED`) cannot express the `hybrid` shadow state — the single most important de-risking step. The enum is one switch, a clear ladder, and extensible.

---

## Build order (the architecture's required sequence)

Sequenced in `BACKLOG.md`. Summary:

1. **Lock the three contracts** (IntentEnvelope, CapabilityManifest, CoachingDecision) — pure, deterministic, fully derivable. The load-bearing interfaces.
2. **Stand up the seams empty** — Orchestrator (manifest executor) + State Assembly, running the *existing* substrate modules, emitting the envelope in `hybrid` shadow. No behavior change.
3. **Build keystone #1 — Scenario Classifier** — the smallest piece that lets the Brain *decide* rather than report. Unlocks single-lift progression end-to-end.
4. **Build keystone #2 — Session Generator** — the Brain-native replacement for `scoreIntents`. The real "Coach's Pick"; its own initiative.
5. **Migrate lifecycle guards** out of `analytics.js` one at a time, each deleting its call, until the fused file is dead.

---

## Long-term: every surface hits the same Brain

| Surface | Attaches as | Verdict |
|---|---|---|
| Coach's Pick / daily reco | button → `best_workout` (structured passthrough) | ✅ |
| Chat / voice | text → input-LLM extraction → intent (voice = chat + TTS) | ✅ |
| Watch / Garmin / WHOOP / Fitbit | sensor event → `ingest_signal` / `readiness_checkin` (push intent) | ✅ |
| Calendar | availability → `duration_minutes` constraint, or scheduled `best_workout` push | ✅ |
| Push notifications | **output** of a proactive decision, rendered as a notification | ✅ |
| API access | intent in, `CoachingDecision` JSON out (output-LLM optional) | ✅ |
| Desktop app | another render target for the same decision | ✅ |

## Owner-gated before build (reserved scope)

Two items are genuinely owner-reserved and are **not** decided by this blueprint:

1. **Input-LLM provider/model** — a second LLM touchpoint (language → intent) is new runtime model spend and a runtime-model selection (owner-gated per `CLAUDE.md` / `docs/OWNER_CHECKIN_RULES.md`).
2. **Proactivity policy** — whether/when Atlas may *initiate* (wearable/notification-driven coaching) is coaching-philosophy + interrupt scope (reserved). The architecture reserves the seam (proactive decisions exist); the policy is deferred.

Neither is required to build and test the three contracts, the Orchestrator, or State Assembly — those are pure and deterministic.
