# Atlas LLM Architecture

> **Governance layer:** Architecture reference — see [`docs/GOVERNANCE.md`](GOVERNANCE.md) for the full hierarchy. Read this document before modifying any LLM provider, coach service, or routing logic in Atlas.

---

## Why This Document Exists

The Gemini free-tier quota was exhausted in a single testing session in June 2026. This produced two simultaneous failures:

1. The coach voice went robotic — every Gemini call returned 429 → deterministic-template fallback.
2. Screenshot saves failed — `/api/complete-workout` also calls Gemini for vision parsing → 429 → 500.

The root cause was **not** "Gemini is bad." It was two architecture defects the quota event merely exposed:

1. **The coach voice was load-bearing.** A provider failure reached surfaces where it could block or corrupt the user flow — the screenshot save 500 being the clearest example.
2. **No error boundary.** Raw provider JSON reached the user because nothing sat between the provider SDK and the response surface.

The immediate hotfix (graceful-degrade for `/api/complete-workout`, shipped) addressed the most visible symptom. This document captures the durable architectural fix and the reasoning behind it, so future work is grounded in principle, not just in reaction to the last outage.

---

## Core Architectural Principles

These are permanent. They do not change when providers change pricing, when new models launch, or when a multi-provider router is added.

### P1 — The deterministic engine is authoritative

Parsing, logging, preview, save, undo, exercise identity, substitution classification, plate math, next-up calculation, and session mutation are all deterministic. None of these paths call an LLM. If behavior can be made deterministic, it must be. Cost optimization is achieved first by removing LLM calls from paths that do not need them, not by switching to cheaper models.

> **The product rule, stated concretely:** The deterministic core runs to completion on every turn. The coach reply is the *last, optional* step. If it fails, the turn still logged, saved, and produced next-up — the user sees: "Coach is busy right now. I'll keep logging your workout and retry coaching in a moment."

### P2 — LLMs are an optional coaching layer, never the source of truth

The LLM only ever *words* facts the deterministic engine already emits and *answers questions* grounded in the engine's output. It never writes, never invents numbers, never makes decisions about workout state. A provider failure degrades to silence or a friendly message — never to incorrect data or a blocked save.

### P3 — A provider outage must never interrupt workout logging, preview, save, or session mutation

A 429, 500, timeout, or auth error from any LLM provider must be caught at the provider adapter boundary. The boundary:

- Never returns raw provider JSON to the client.
- Maps every failure mode to a fixed, friendly user message.
- Logs the raw provider error **server-side only** (provider, status, request ID, latency, error class).
- Preserves all workout state — nothing in the session, preview, or save flow depends on the LLM response.

### P4 — Provider-specific code lives behind a provider interface

Each vendor (OpenAI, Gemini, Groq) is isolated in its own adapter module. Application code calls the `LLMProvider` interface, not the vendor SDK directly. This means:
- Adding a new provider requires only a new adapter file.
- Fallback logic lives at the provider-router layer, not scattered through `services/coach.js` or `services/vision.js`.
- Per-provider 429/auth/timeout classification is encapsulated in each adapter.

### P5 — Cost optimization is primarily achieved by making behavior deterministic

Every path the deterministic engine can own is removed from the LLM budget entirely — the coach voice only runs after the engine has computed all numbers, verdicts, and state. Routing to a cheaper model is a secondary optimization; eliminating unnecessary LLM calls is the primary one.

### P6 — Multi-provider routing is a future capability, after workout reliability reaches production quality

Do not build the multi-provider router, circuit breaker, or fallback chain while the P0 workout flow (save/preview/session-state) is still being stabilized. Shipping resilience infrastructure on top of an unstable workout flow conflates two problems. The sequencing rule: P0 workout reliability first → error boundary → provider abstraction → fallback chain → cost-routing.

---

## Routing Tiers

| Tier | What runs here | LLM required? |
|---|---|---|
| **Tier 0 — Deterministic (authoritative)** | Parsing, logging, preview, save, undo, identity, substitution, next-up, session mutation, plate math | **Never** |
| **Tier 1 — Cheap/fast coach voice** | Set reactions, acknowledgements, encouragement, grounded session questions | Primary + fallback |
| **Tier 2 — Capable model** | Program design, high-context reasoning, mesocycle planning, multi-week prescription narratives | On-demand only |

The router that selects Tier 1 vs Tier 2 is itself deterministic (request-type classification by input shape and complexity heuristics), never an LLM call.

---

## Provider Candidate Scoring (June 2026)

> **Pricing note:** These numbers reflect June 2026 market pricing. Verify current pricing before making routing decisions — provider costs shift frequently. Sources verified June 2026: OpenAI pricing page, Groq developer console, Google AI Studio pricing, OpenRouter pricing.

| Provider / Model | Cost per 1M tokens (in/out) | Rate limits | Reliability | Latency | Atlas fit |
|---|---|---|---|---|---|
| **OpenAI gpt-4.1-nano** | $0.10 / $0.40 | High on paid tier, org-level | Very high | Good | ★★★★★ — Recommended Tier 1 primary |
| **Groq llama-3.1-8b-instant** | $0.05 / $0.08 | 30 RPM / 1K RPD free; ~10× on paid | High | Fastest (~840 tok/s) | ★★★★☆ — Recommended Tier 1 fallback |
| OpenAI gpt-5.4-mini | $0.75 / $4.50 | High on paid | Very high | Good | ★★★★☆ — Tier 2 |
| Gemini 2.5-flash-lite (paid) | $0.10 / $0.40 | Spend caps enforced since April 2026 | High on **paid**; free tier structurally unreliable | Good | ★★★☆☆ — Optional third, never primary |
| OpenRouter (passthrough) | Passthrough + 5.5% fee | 20 RPM free; none on PAYG | Adds a dependency; no SLA | Varies by route | ★★★☆☆ — Skip as primary spine |

### Rationale for the recommendation

**Primary Tier 1 — `openai/gpt-4.1-nano`:** Atlas already uses OpenAI for Vision screenshot parsing. Zero new vendor onboarding, the best structured-output enforcement of the four candidates, and boringly high reliability. At $0.10/$0.40 it is already near the pricing floor.

**Fallback Tier 1 — `groq/llama-3.1-8b-instant`:** A *different vendor* from the primary, so an OpenAI service event does not simultaneously kill coaching. The fastest option (~840 tok/s). OpenAI-compatible API surface means the same adapter pattern works with a different base URL. This is the resilience play — cross-vendor, not just cross-model.

**Tier 2 — `openai/gpt-5.4-mini`:** Same key as primary, trivial to route to, sufficient for mesocycle redesign and multi-week progression narratives that need a larger context window and stronger reasoning.

**Gemini paid flash-lite:** Keep as a configured-but-optional third provider on the paid tier with the new spend cap as a budget control. The free tier is structurally unreliable as of April 2026 (mandatory spending caps enforced; free-tier rate limits cut; quota-exhaustion incident confirmed).

**Skip OpenRouter as the primary spine:** Its native fallback is real but lives *inside* OpenRouter — if OpenRouter is down, everything is down. It also hides the per-provider 429 headers that per-provider cooldown logic needs. For a two-vendor setup, direct adapters plus a lightweight circuit breaker is more transparent and debuggable, which fits Atlas's "trust demonstrated behavior" operational philosophy. OpenRouter BYOK is the escape hatch if N-model routing is ever needed without writing N adapters.

### Volume and cost at Dale's usage

At one owner's volume (a few sessions per week, a handful of coach turns each): primary nano + Groq fallback + mini for planning stays under ~$1/month. Cost is essentially a rounding error at this volume. Optimize for **reliability + latency + simplicity** first; let determinism do the cost work by removing unnecessary LLM calls.

---

## Error Boundary Specification

Every provider call passes through one adapter that catches all exceptions and classifies them:

| Error class | Classification | Action |
|---|---|---|
| 429 / quota / rate-limit | `QUOTA_EXHAUSTED` | Open per-provider cooldown → route to fallback → surface friendly message |
| 5xx / timeout / network | `PROVIDER_UNAVAILABLE` | One retry with backoff → fallback if configured → friendly message |
| 401/403 auth error | `AUTH_FAILURE` | Log immediately → degrade → no retry (retrying a bad key burns time, never fixes it) |
| 4xx other / malformed response | `PROVIDER_ERROR` | Log → degrade immediately |

**Invariants for the boundary (see also `docs/INVARIANTS.md` L1–L5):**

- Never return raw provider JSON to the client.
- Map every failure to a fixed user message: `"Coach is busy right now. I'll keep logging your workout and retry coaching in a moment."`
- Log the raw provider error server-side only: provider name, status code, request ID, latency, error class.
- Preserve all workout state across every failure — session log, preview rows, save, session mutation are never touched by a provider failure.
- Surface a "retry coaching" affordance after a per-provider cooldown clears.

---

## Provider Interface

```javascript
// services/llmProvider.js (future)
const LLMProvider = {
  name: 'openai',                   // 'openai' | 'groq' | 'gemini'
  model: 'gpt-4.1-nano',

  // Returns the text completion, or throws a classified error (never a raw SDK error)
  complete(prompt, opts),

  // Returns a validated object matching `schema`, or throws on validation failure
  completeStructured(prompt, schema, opts),

  // Maps any SDK exception to one of the four standard error classes
  classifyError(err),               // → 'QUOTA_EXHAUSTED' | 'AUTH_FAILURE' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ERROR'
};
```

Each adapter:
- Owns vendor SDK import, auth, and retry-within-class (retry only for transient classes; never retry `AUTH_FAILURE`).
- Implements `classifyError` to map SDK exceptions to the four standard classes.
- Never throws a vendor-specific exception type out of the adapter boundary.
- Is instantiated once at startup with provider config from environment variables.

---

## Structured Output Hardening

When an LLM call returns structured output (JSON for a composer command, a parsed intent, a substitution classification):

1. The provider adapter requests native JSON mode (OpenAI: `response_format: {type:'json_object'}`; Gemini: `config: {responseMimeType:'application/json'}`).
2. The adapter strips code fences defensively before parse (`ME-11` pattern already shipped for vision calls).
3. The parsed output is validated server-side against a fixed schema before it reaches application logic.
4. A validation failure falls back to the deterministic intent-matching path — it never corrupts workout state and never reaches the write path.

---

## Implementation PR Sequence

Ordered so the error boundary ships first — it closes the incident root cause without requiring the full provider abstraction.

| # | Concern | Risk | Notes |
|---|---|---|---|
| **1** | **Error boundary + friendly degradation** | High | Wrap all LLM calls; kill the raw-JSON leak; guarantee coach failure cannot block log/preview/save/next-up/mutation; server-side-only raw logging. **This alone closes the actual incident.** |
| **2** | **Provider interface + OpenAI adapter** | Medium | Define `LLMProvider`; route existing calls through it; behavior-preserving refactor. Reuses `ATLAS_LLM_PROVIDER` / `ATLAS_LLM_MODEL`. |
| **3** | **Fallback provider + Groq adapter** | Medium | Add `ATLAS_LLM_FALLBACK_PROVIDER` / `_MODEL`; on classified primary failure, route to fallback once. |
| **4** | **Cost-aware tier router** | Medium | Deterministic Tier 1 vs Tier 2 selection; `ATLAS_LLM_MODEL_FAST` / `_SMART`. |
| **5** | **Determinism guard** | Low | A test/invariant that fails if any LLM call is reachable from parse/log/save/substitution/identity/plate-math paths. |
| **6** | **Circuit breaker + cooldown** | Medium | Per-provider breaker: open on repeated 429s, half-open retry after cooldown. |
| **7** | **Structured-output hardening** | Medium | Native schema mode + server-side validation + deterministic fallback for composer commands. |
| **8** | **Observability / cost counters** | Low | Structured server logs: provider, model, latency, token counts, error class. |

PRs 1–3 close the immediate incident risk. PRs 4–8 add cost-routing, observability, and long-term robustness. None of these are active roadmap work yet — see sequencing rule below.

---

## Sequencing Rule

**Do not start PR 1 (error boundary) until the P0 Active Workout State Unification workstream is stable in live use.**

The right order:

1. **P0 workout state / save reliability (active roadmap)** — active-session authority, save path trust, closeout reliability, screenshot graceful-degrade (partially shipped).
2. **PR 1 — error boundary** — the minimum required fix after P0 is stable. Closes the incident root cause without any provider switching.
3. **PR 2 — provider interface** — makes the codebase extensible without changing behavior.
4. **PR 3 — fallback + Groq adapter** — the actual cross-vendor resilience capability.
5. **PRs 4–8** — cost-routing, circuit breaker, structured-output hardening, observability — build in order as needed.

See `BACKLOG.md` → "Operational resilience" → the #586 entry for queue placement and the formal trigger condition.

---

## Environment Variables

| Variable | Purpose | Status |
|---|---|---|
| `ATLAS_LLM_PROVIDER` | Primary provider (`openai` / `gemini`) | Existing |
| `ATLAS_LLM_MODEL` | Primary model override | Existing |
| `GEMINI_COACH_MODEL` | Gemini coach model | Existing (`gemini-2.5-flash-lite`) |
| `GEMINI_API_KEY` | Gemini API key | Existing |
| `OPENAI_API_KEY` | OpenAI API key | Existing |
| `ATLAS_LLM_FALLBACK_PROVIDER` | Fallback provider (e.g. `groq`) | Future — PR 3 |
| `ATLAS_LLM_FALLBACK_MODEL` | Fallback model (e.g. `llama-3.1-8b-instant`) | Future — PR 3 |
| `ATLAS_LLM_MODEL_FAST` | Tier 1 model override | Future — PR 4 |
| `ATLAS_LLM_MODEL_SMART` | Tier 2 model override | Future — PR 4 |

The `ATLAS_LLM_FALLBACK_*` and `ATLAS_LLM_MODEL_FAST/SMART` variables do not exist in the current codebase. They are defined here so the naming is settled before the adapters are written.
