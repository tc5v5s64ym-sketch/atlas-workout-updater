# Coaching Knowledge Map

A disposition map: where each coaching domain lives now and where it routes in the future. **One entry per domain — this is a map, not a textbook.**

Sources: `02-coaching-knowledge-architecture`, `04-coaching-intelligence-architecture`.

## Disposition legend

| Tag | Meaning |
|---|---|
| **RULE** | Deterministic logic; future module consumes it |
| **CONFIG** | Tunable values; no code change needed to adjust |
| **ONTOLOGY** | Exercise graph fields; classification data |
| **MEMORY** | Per-user derived; computed from history |
| **SAFETY** | Guardrail; override-capable module |
| **LLM** | Explanation material only; engine already owns the numbers |

## Domain table

| # | Domain | Disposition | Lives in (now / future) |
|---|--------|-------------|--------------------------|
| A | Training Science | CONFIG + RULE | `config/coaching/rules`, future templates |
| B | Exercise Science | ONTOLOGY | `config/coaching/exercises`, `config/coaching/movement-patterns` |
| C | Programming | CONFIG + RULE | `config/coaching/rules`, future templates |
| D | Progression Intelligence | RULE | `config/coaching/rules/progression.rules.json` |
| E | Fatigue & Recovery | RULE + MEMORY | `config/coaching/rules/fatigue.rules.json`; per-user recovery → coach memory later |
| F | Personalization | CONFIG + MEMORY | future templates/caps; user life-context → memory |
| G | Behavior Change | MEMORY + LLM | cadence/anti-repetition rules + LLM language |
| H | Communication | LLM (triggers = RULE) | LLM layer later |
| I | Nutrition | CONFIG + SAFETY | future targets/formulas + refer-out guardrails |
| J | Injury & Safety | SAFETY | `config/coaching/rules/safety.rules.json` |
| K | Knowledge Sources | CONFIG | `config/coaching/evidence-tiers.json` |

---

## Domain summaries

**A — Training Science.** The mechanical foundations: dose-response relationships between volume, intensity, and frequency and hypertrophy/strength outcomes; periodization taxonomies (linear, undulating, block); the distinction between training age novice / intermediate / advanced and how that shifts the response curve. These resolve to CONFIG values (default set counts, rep ranges, frequency per muscle group) and RULE logic (when to advance, when to pull back).

**B — Exercise Science.** The exercise ontology: movement-pattern classification (squat, hinge, push, pull, carry, etc.), primary and secondary muscle involvement, implement type, laterality, loading axis, systemic vs. local fatigue ratings, joint stress profiles, and SFR (stimulus-to-fatigue ratio) heuristics. Seeded in `config/coaching/exercises/` and `config/coaching/movement-patterns/`. Four worked examples ship in PR 1; the full catalog is a future PR.

**C — Programming.** How individual sessions and weeks are structured: exercise selection principles (compound before isolation, push/pull balance, axial load limits per session), set and rep scheme selection, session sequencing across the week, and mesocycle shape. Resolves to CONFIG defaults in rule templates; the deterministic planner consumes them later.

**D — Progression Intelligence.** The decision logic for when and how to advance load, reps, or sets. The `progression.rules.json` decision table captures six scenarios (underloaded, on-target, normal variability, likely fatigue, injury signal, candidate plateau) and the lever-order rule (load before reps before sets). A future ProgressionModule reads this to produce the next-target recommendation currently handled by `analytics.recommendNextSet`.

**E — Fatigue & Recovery.** Recovery-rate priors by muscle class (small muscles: 24–48 h; large compound: 48–72 h; heavy eccentric: 72–96 h), readiness inputs (subjective ratings weighted heavily over wearable biomarkers), and deload triggers (planned every 4–6 weeks, or autoregulated when ≥2 of six signals fire). The per-user recovery curve — how quickly this individual actually recovers — is MEMORY, not CONFIG; it diverges from the priors as Atlas accumulates history. `fatigue.rules.json` holds the scaffold.

**F — Personalization.** Constraint handling (injuries, equipment limits, schedule, experience level, preferences), the personal training age modifier to default volume and intensity, and life-context inputs (travel, stress, sleep debt). Personalization is structurally two things: CONFIG caps (e.g. maximum axial load per session given a back constraint) and MEMORY (the user's individual response curve emerging from their own logged data). Neither is yet consumed by a module.

**G — Behavior Change.** The motivational and behavioral layer: check-in cadence, anti-repetition rules for coach language, habit-loop scaffolding, and recognizing when a user is drifting from the plan vs. intentionally deviating. The *triggers* for behavior-change nudges (e.g. missed session detected) are RULE/MEMORY; the *language* of the nudge is LLM. This domain is exclusively consumed by the LLM voice layer — no deterministic output.

**H — Communication.** How Atlas talks: tone calibration, precision vocabulary (say "3 sets at RIR 2" not "train hard"), the rule that Atlas never invents numbers and only words facts the engine already holds, and the anti-hallucination contract. Communication style is LLM material; the *triggers* that determine when to speak are RULE (e.g. when a red-flag symptom is flagged, always stop and route to medical; when readiness is low, offer a modification). The LLM explanation of a deterministic number is SAFE; the LLM generating a new number is NOT.

**I — Nutrition.** Basic energy balance concepts for context only (deficit = recovery pressure, adequate protein = prerequisite for adaptation) and the refer-out rule: Atlas does not prescribe clinical nutrition, sets no calorie/macro targets without explicit owner authorization, and defers all therapeutic nutrition questions to a qualified professional. Resolved to CONFIG (if a target is ever added) and SAFETY (the refer-out guardrail). Out of scope for this phase.

**J — Injury & Safety.** The traffic-light classifier (green / yellow / red), red-flag symptom list, the "confidence inversion" rule (uncertainty about a possible red flag increases caution, never reduces it), PAR-Q style onboarding screening, and the hard rule that Atlas never diagnoses or coaches through red-flag symptoms. These live in `config/coaching/rules/safety.rules.json` and are the one domain where the safety module is architecturally permitted to override all other modules.

**K — Knowledge Sources.** The evidence-tier ranking that governs how much weight any claim carries: consensus statements (tier 1) through practitioner heuristics (tier 5), with an explicit excluded category (anecdote, influencer marketing, supplement claims). Every config entry cites a tier; `contested: true` entries must be surfaced honestly by the LLM rather than asserted as fact. Lives in `config/coaching/evidence-tiers.json`.
