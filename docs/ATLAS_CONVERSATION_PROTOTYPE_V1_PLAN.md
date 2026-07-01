# Atlas Conversation Prototype v1 — Plan (Docs Only)

> **Status:** Planning / sequencing doc. **No code. No runtime change. No UI change.** Captures the smallest safe path toward the conversation-first experience so the direction does not live only in chat.
> **Governance layer:** Roadmap/backlog sequencing input — subordinate to `docs/ACTIVE_ROADMAP.md` and `BACKLOG.md`. Does **not** amend Vision, Constitution, or Invariants, and does **not** open PR-8.
> **Decision class:** The recommended lane (PR-1…PR-4) is **pre-authorized, deterministic-engine-first, read-only, PM-authority** work that never touches the trust loop. Everything that would make Atlas *visibly* conversation-first — the NL Intent Router, collapsing the duplicate recommendation, demoting the Progress dashboard, promoting live surfaces onto the One-Brain engine — is **owner-reserved** (`docs/CONVERSATION_FIRST_DESIGN_REVIEW.md`, Invariant I1).
> **Companions:** `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md` (why the conversation is the product), `docs/CONVERSATION_CONTRACT_V1.md` (how Atlas behaves — the 11 value triggers, always-acknowledge), `docs/COACHING_NOTE_VOICE.md` (note = verdict; engine owns numbers), `docs/COACHING_ENGINE_ARCHITECTURE.md` (One-Brain blueprint).

---

## Why this doc exists

Planning/governance consolidation PR-1 → PR-7 are merged; the conversation-first direction is now discoverable. This doc designs the **smallest safe implementation path** toward the real Atlas experience — one composer as the primary interface, batch logging as the default, set-by-set still supported, coach notes after exercise/workout blocks, cards/plans/charts as conversation artifacts, One-Brain behind the composer — **without touching the trust loop and without adopting any owner-reserved surface change.** It is captured so the next authorized implementation PR (pure `coachNoteTier`, §10) starts from a locked plan rather than re-derivation.

The engine grounding for this plan (composer/chat/logging code map, parser capability, coach-note wiring) was established by reading `public/index.html`, `public/app.js`, `public/coach-conversation.js`, `public/chat.js`, `public/nav.js`, `config/routes.js`, `index.js`, `services/workoutTextParser.js`, and `services/coach.js`.

---

## 1. Current state of the composer / chat / logging flow

Atlas is **already a chat-first logger** at the surface level — the drift is that a parallel dashboard grew beside it, not that the composer is missing.

- **One composer already is the default surface.** `public/index.html` ships a two-way segmented control: `data-surface="coach"` (default) and `data-surface="progress"`. The coach surface is a greeting hero (`#coach-empty`), a message thread (`#thread-messages`), a single composer textarea (`#workout-text`, placeholder *"Log a set or ask anything…"*), and the preview→approve→write panel (`#preview-panel`).
- **Routing today is fragmented, not unified.** A submitted message is classified by `services/workoutTextParser.js` (`intent: log_sets | log_sets_multi | plan_request | finish_session | question | needs_clarification`) plus frontend helpers `public/sessionQuestion.js`, `public/planMutationIntent.js`, and `services/messageIntent.js`. Buttons/chips bypass classification entirely (structured passthrough). There is **no single upstream Intent Router** — exactly the gap the One-Brain blueprint names.
- **The trust loop is intact and load-bearing.** Preview posts `test_mode=true` to `/api/parse-workout-text` (read-only, proof fields `sheet_written:false / no_write_confirmed:true`); `#approve-btn` is disabled until a dry-run succeeds; approval calls `/api/log-workout` with a `write_id` idempotency token; a header-contract guard refuses writes on 12-column drift; `volume_calc` is always server-derived. A `MutationObserver` on `#logger-status` turns a successful write into "✓ Saved + Undo."
- **Coach notes already render inline.** After a logged set, `public/coach-conversation.js` renders a readback card, then fetches `/api/coach/message` (`kind:'set'`) for the note, then a next-prescription card — with a typewriter effect and a deterministic template fallback when Gemini is down.
- **The duplicated recommendation is real.** The same pick renders as **Coach's Pick** (coach thread, via `/api/plan/intent-recommendation`) and **Today's Pick** (Progress dashboard). `#suggestion-chips` is shipped-but-deprecated.
- **The One-Brain engine is built but dark.** Contracts, State Assembly, Orchestrator, Scenario Classifier, and Session Generator are all shipped as pure modules and tested, but only `/api/recommend/next/:liftCode` consults them (and only under `ATLAS_COACH_ENGINE=brian`, default `legacy`). Coach chat/message, today's pick, and set reaction still run `analytics.js`/`scoreIntents`.

## 2. What blocks a chat-first Atlas today

1. **No unified Intent Router.** Free text is disambiguated by several independent classifiers; the natural-language → intent extraction boundary needs the **input-LLM provider — owner-gated** (new runtime model spend, `docs/COACHING_ENGINE_ARCHITECTURE.md` reserved scope). Structured/button/passthrough intents do *not* need it; NL extraction does.
2. **The verbosity tier is unbuilt.** "Routine → short, interesting → longer" is a deterministic classification problem (which of the 11 Conversation-Contract triggers fired?) that does not exist as a module. Today note length is decided ad hoc in the voice layer. The design review explicitly flags this as *"an unbuilt classifier … an engine capability to build, tune, and test."*
3. **Batch has no per-block coach note.** The **parser already handles batch** (see §4), but `/api/coach/message` is wired per-*set* (`kind:'set'`). A per-exercise/per-block note after a batch has no dedicated engine fact source or attach point yet.
4. **Two homes for one recommendation, and a rival navigation surface.** Collapsing Coach's Pick / Today's Pick and demoting the Progress dashboard to artifacts is **owner-reserved** (I1 forbids *new* rival surfaces immediately but does not authorize *removing* existing ones).
5. **Surface still runs on `analytics.js`.** Until per-surface promotion PRs land, the composer's answers don't come from the One-Brain engine, so conversation-first would inherit the legacy split-brain rather than the unified Brain.

## 3. Smallest safe PR sequence to prototype conversation-first (no trust-loop touch)

Ordered deterministic-engine-first, each a tiny one-concern PR, none touching preview→approve→write, `test_mode`/proof fields, the slash-notation contract, undo, or any owner-reserved surface removal. **Only PR-1 is recommended for authorization now** (§10); the rest are the *shape* of the lane, not a promotion request.

- **PR-1 — Coach-note tier classifier (pure engine).** `classifyNoteTier(facts)` → `{ tier, trigger, reason_code }`. Deterministic, no I/O, no LLM, no route. Implements §6's routine/interesting split. *(Detailed in §10.)*
- **PR-2 — Batch coaching-note fact assembler (pure engine).** A pure function that folds a logged *block* (multiple sets of one exercise) into the single fact payload a per-exercise note needs (top set, effort/progression verdict, tier from PR-1). No route, no write, no wording.
- **PR-3 — Wire the batch note into the existing coach path (read-only).** Have the batch-log render call `/api/coach/message` once per exercise with the PR-2 facts + PR-1 tier. Reuses the existing read-only endpoint and the existing degrade-gracefully fallback. No new write path; the `✅ logged` acknowledgment stays deterministic and un-throttled.
- **PR-4 — Deterministic "always-acknowledge + tier-aware brevity" in the note voice.** Apply the PR-1 tier to the deterministic template layer (`public/coachVoiceTemplates.js`) so routine=one line, interesting=fuller — LLM-independent. Pure voice/presentation-order change (PM authority, like the shipped conclusion-first pass).
- **PR-5+ (owner-gated, not proposed here).** Intent Router / NL extraction (needs the owner-gated input-LLM), collapsing the duplicate recommendation, demoting the Progress dashboard to artifacts, promoting coach surfaces onto the One-Brain engine. All owner-reserved per I1 / `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md`.

This keeps the whole prototype **inside the engine and the existing read-only coach endpoint** until the owner opens the reserved scope.

## 4. How batch logging should work — "Bench 135 10/5 185 10/2 225 5/2 x3"

**The parser already does this.** `services/workoutTextParser.js` handles both the single-line form and the multi-line block:

```
Bench            Bench 135 10/5 185 10/2 225 5/2 x3   ← same result
135 10/5
185 10/2
225 5/2 x3
```

- Slash notation `5/2` = 5 reps @ RIR 2 (RIR optional); `x3` repeats the previous set 3× (capped at 10); multi-exercise in one message → `log_sets_multi` with an `exercises[]` array. So the example parses to Bench: `135×10 @5`, `185×10 @2`, then `225×5 @2` **three times** = 5 sets.

So batch logging is **not a parser build** — it's a *flow* build:

1. Whole block → **one** dry-run preview (`test_mode=true`) → **one** owner approval → **one** `/api/log-workout` write. The one-preview-one-write barrier is unchanged and non-negotiable.
2. After the write confirms, emit the deterministic **`✅ Bench logged`** acknowledgment (never throttled).
3. Then **one** concise per-exercise coach note (PR-2/PR-3), its length set by PR-1's tier.
4. Hand off to the next exercise (placeholder/nudge), fast.

The only genuine gaps vs. today are the per-block note assembler (PR-2) and its attach point (PR-3) — both additive, read-only.

## 5. How set-by-set logging should still work

Unchanged and preserved — it's the same coach and same Brain at higher cadence, inferred, never a mode switch:

- Each `225 5/2` still parses to one set, still previews→approves→writes (or the existing single-set fast path), still renders a readback + `/api/coach/message` (`kind:'set'`) note.
- The **same PR-1 tier classifier** governs per-set verbosity: routine set → acknowledgment + one line; a redline/PR/fatigue set → a fuller note. Cadence is detected from input shape (block vs single set), not chosen by the user.
- Existing per-set signals (`services/setEffortSignals.js` redline / rep-drop / pressing-yellow) keep priority over generic prose, exactly as today.

## 6. How coach notes should be generated — routine short, interesting longer, always confirm logged

Grounded in `docs/COACHING_NOTE_VOICE.md` (note = *verdict*, conclusion-first, ≤120 words, engine owns every number) and `docs/CONVERSATION_CONTRACT_V1.md` (the 11 value triggers; always-acknowledge; silence ≠ failed write).

**Three-tier deterministic output from PR-1's `classifyNoteTier(facts)`:**

| Tier | When | Output |
|---|---|---|
| `ack_only` | Routine set/block, matches expectation, no trigger | Deterministic `✅ Bench logged.` — never throttled, survives LLM outage |
| `short` | Mild signal (in-pocket verdict, minor drift) | Acknowledgment + one verdict line |
| `extended` | A value trigger fired (PR, regression, pain/safety, plan change, sandbag, low confidence, **unexpected excellence #11**, etc.) | Acknowledgment + fuller verdict, still conclusion-first, still ≤120 words |

- **The engine decides the tier; the LLM only words the tier's facts** — it never invents the number or the verdict, and if a fact is absent the note drops that beat rather than fabricating (IRON RULE).
- **Acknowledgment is separate from commentary.** `✅ logged` is deterministic and independent of tier — so silence is never confused with a failed write (Contract voice invariants 4/5). Verbosity throttles *coaching*, never the *receipt*.
- **Tone never shames** (Contract rule 5 / voice invariant 3): an easy set is *"more in the tank — a great problem to have,"* never *"you should've gone heavier."*

## 7. What should remain hidden / debug / developer-only

- **`ATLAS_COACH_ENGINE` stays `legacy` by default.** `hybrid`/`brian` remain opt-in; nothing in this lane flips it.
- **Hybrid Coach Compare card** (Settings → Debug) stays dev-only; the `brian` promotion for `/api/recommend/next/:liftCode` stays gated and is not surfaced.
- **Debug endpoints/panel** — `/api/debug/config`, `/api/debug/exercise-match`, "Show version/session-state," "Test coach connection," "Test Brian BEN01," bug-report — stay behind the Settings Debug panel, not on the coach surface.
- **The One-Brain pure modules** (orchestrator, sessionGenerator, scenario classifier) stay engine-internal; no user-facing wiring in this lane.

## 8. What should NOT be changed yet

- **The trust loop** — preview→approve→write, `test_mode` semantics, the `sheet_written/no_write_confirmed/sheet_write/log_rows_written` proof fields, `write_id` idempotency, the 12-column contract, and undo. Owner-gated Constitution law regardless of interface.
- **The slash-notation parser contract** (`225 5/2` = 225×5 @ RIR 2).
- **Surface removals** — do **not** delete/demote the Progress dashboard, collapse Today's/Coach's Pick, or retire `#suggestion-chips`. I1 blocks *new* rival surfaces now but *removing existing* ones is owner-reserved.
- **`scoreIntents` / Today's Pick replacement** by the Session Generator — building the pure engine is derivable; swapping the live surface is owner-gated.
- **Vision / Constitution / Invariants** — no amendments (explicitly out of scope for this brief). PR-8 is not opened.
- **Owner-reserved prerequisites** — the input-LLM provider/model (NL Intent Router) and the proactivity *mechanism*. Philosophy is decided; implementation is a future owner-gated PR.

## 9. Which existing routes / modules to reuse

- **`services/workoutTextParser.js`** — already parses batch, multi-line, `x3`, multi-exercise, dumbbell/bodyweight. Reuse as-is; do not extend grammar.
- **`/api/parse-workout-text`** (read-only dry-run) and **`/api/log-workout`** (the one write path, with its proof fields) — reuse unchanged.
- **`/api/coach/message`** (`kind:'set'` and `kind:'plan'`, read-only) — the attach point for both per-set and the new per-block note. **`/api/coach/chat`** for Q&A. **`/api/coach/ask`** for deterministic SME.
- **`services/coach.js`** voices + `public/coachVoiceTemplates.js` deterministic fallback — reuse the degrade-gracefully path; extend with the tier, don't replace.
- **`services/setEffortSignals.js`, `expectedPerformanceModule`, `effortVerdict`/`progression_verdict`** — the fact sources PR-1 consumes; no new engine numbers invented.
- **`public/coach-conversation.js` / `public/chat.js`** — reuse readback, bubble, typewriter, and the `#logger-status` observer.
- **One-Brain pure modules** (`sessionGenerator`, `coachOrchestrator`, `scenarioClassifier`, `liftPrescription`) — reserved for the later, owner-gated promotion PRs; not wired here.

## 10. Recommended PR-1 (only) — pure `coachNoteTier`

**PR-1 — `coachNoteTier`: deterministic coach-note verbosity classifier (pure engine).**

- **What:** a new pure module `services/coachNoteTier.js` exporting `classifyNoteTier(facts)` → `{ tier: 'ack_only' | 'short' | 'extended', trigger: <one of the 11 contract triggers | null>, reason_code }`. It reads facts the engine already emits (effort verdict, progression verdict, PR/new-ground flag, redline/rep-drop signals, plateau/regression, low-confidence, deload state, **unexpected-excellence** = positive deviation from the lifter's own pattern) and returns *which tier and why*. It emits **no wording and no numbers** — the LLM/template layer words it later.
- **Why PR-1:** it is the deterministic engine both cadences (§4 batch, §5 set-by-set) depend on for §6; the design review and Conversation Contract both name the verbosity classifier as the missing, buildable engine capability; and it is the lowest-risk possible start.
- **Why it's safe:** pure function — no I/O, no LLM, no route, no `index.js`/`public/app.js` edit, no write path, no `test_mode`/proof-field/trust-loop touch, no schema change, and it **removes no surface** (I1-clean). It is squarely PM-authority, deterministic-engine-first work.
- **Tests:** golden fixtures pinning each mapping — routine in-pocket set → `ack_only`/`short`; PR/new-ground → `extended` (trigger `pr_milestone`); sandbag (easy vs. plan) → `extended` (trigger `challenge/sandbag`); pain flag → `extended` (`pain_injury`); regression → `extended`; **unexpected excellence** (usually 225×5 @2, today 225×8 @2) → `extended` (trigger `unexpected_excellence`); missing facts → safe `ack_only` (never fabricate).
- **Not in PR-1:** no route wiring (that's PR-3), no batch assembler (PR-2), no template change (PR-4), no surface change.

---

## Governance disposition

- This doc is **planning only** — no code, no runtime change, no Vision/Constitution edit, PR-8 not opened.
- The recommended lane (PR-1 → PR-4) is pre-authorized deterministic-engine-first / read-only / PM-authority work that never touches the trust loop; each ships as its own tiny one-concern PR under normal review.
- Everything owner-reserved (NL Intent Router / input-LLM, collapsing the duplicate pick, demoting the dashboard, promoting live surfaces onto the One-Brain engine) stays parked behind PR-4 and is not authorized by this doc.
- **Next authorized step (owner-gated go):** implement PR-1 (pure `coachNoteTier`) only, after this planning doc merges.
