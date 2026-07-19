# Soul Recovery Audit — live workout voice paths (Phase 1, Work item 1)

> **Status:** Recovery audit v1 · **Current as of:** 2026-07-19 · **Read-only.** This document
> maps what the code does today; it changes no behavior. It is the required audit for
> **Phase 1 — Soul Recovery (Issue #1073)** of the Atlas Recovery Campaign
> ([`docs/ATLAS_V1_EXECUTION_PLAN.md`](ATLAS_V1_EXECUTION_PLAN.md)). It is evidence/reference,
> not an execution queue.
>
> **Method note (honest scope).** The campaign asks that every live workout voice path be
> mapped "from user input to rendered output." This v1 was produced by direct reading of the
> core voice seams after a fleet of five parallel deep-dive auditors was cut short by a shared
> usage limit. Every claim below carries a `file:line` anchor and quotes the real output string.
> Where a branch was traced only at the route level, it is marked **`PARTIAL`** so the
> implementation slice extends it rather than trusting a false-complete map. Nothing here is
> asserted without a code anchor.

## 1. What the audit is looking for

For every voice path, the campaign asks for seven facts: **facts assembled**, **model called?**,
**persona/prompt**, **deterministic prose that can override the model**, **conversation history
available**, **production output**, and (added here) **Soul-risk notes**. Sections 3–9 record
these per path; Section 2 is the shared spine they all ride on; Section 10 is the cross-cutting
finding set that the Phase 1 implementation slice acts on.

## 2. Shared infrastructure (the spine every voice rides)

- **Provider / model.** The only application LLM on these paths is Google Gemini via
  `https://generativelanguage.googleapis.com/v1beta/models` (`services/coach.js:39`), model
  `process.env.GEMINI_COACH_MODEL || DEFAULT_MODEL` (`services/coach.js:43-45`), request timeout
  `DEFAULT_TIMEOUT_MS = 8000` (`services/coach.js:41`). The coach is "configured" **iff**
  `GEMINI_API_KEY` is set (`services/coach.js:47-49`).
- **Persona.** One shared persona is prepended to every server prompt builder:
  `PERSONA_CORE` in `services/coachPersonaCore.js:40-79`, returned by `buildPersonaCore()` and
  prepended at the top of each system prompt (`services/coach.js:14`, used in
  `buildCoachSystemPrompt` at `services/coach.js:52`). Its identity line already encodes the Soul
  intent: *"you are Atlas — you keep the logbook and you are not easily impressed. You speak only
  when there is something worth saying … you stay quiet when a set is routine"*
  (`services/coachPersonaCore.js:41`). Iron rules: engine owns every number; no empty filler; no
  hype; history/goal claims must be cited from the facts, never invented
  (`services/coachPersonaCore.js:43-51`). Tone volume is engine-granted via `register`
  (`services/coachPersonaCore.js:56-79`); profanity is OFF unless the engine grants
  `register.profanity_ok` (`:74-79`), which additionally requires engine-confirmed new ground
  (`routes/coachOps.js:750-753`).
- **The client ↔ server contract for a logged set.** The browser assembles the visible note in
  `src/app/coach-conversation.js` and asks the server for prose via
  `POST /api/coach/message` (`src/app/coach-conversation.js:1102-1115`,
  handler `routes/coachOps.js:475`). The server returns a data object carrying `message` (LLM
  prose or null), `note_tier`, `voice` (a deterministic renderer read), and engine advisories;
  the client decides what to show.
- **Authority model — the engine can override the model, and often speaks instead of it.**
  Three mechanisms matter for Soul:
  1. **The routine short-circuit.** A routine block returns `note_tier: 'ack_only'` and the server
     returns `message: null` and **does not call Gemini at all** (`routes/coachOps.js:778-815`,
     esp. the comment at `:778-781` "return NO coaching prose and DO NOT call Gemini" and the
     early return at `:813-814`). The client then renders a fixed template (Section 4).
  2. **Prose suppression.** When Gemini *is* called, `finalizeCoachVoice(message, voiceBase, …)`
     can null the model's prose when it contradicts a non-neutral deterministic set-effort signal
     or outruns its granted register (`routes/coachOps.js:831`; client mirror at
     `src/app/coach-conversation.js:1072-1084`, `voice.suppress_generic_prose` "render its
     primary_line and NEVER the generic/LLM prose").
  3. **Deterministic fallbacks that read like the coach.** On outage / not-configured / suppression
     the client words the engine itself: `coachOpener` + `VERDICT_VARIANTS`
     (`src/app/coach-conversation.js:1121-1191`) and the templates in
     `src/app/coachVoiceTemplates.js`.
- **Fact integrity boundary.** Client-supplied trust-bearing fields are recomputed/overwritten
  server-side before they can reach the prompt or the deterministic voice: `effort_verdict` is
  recomputed from the just-logged set (`routes/coachOps.js:499-540`), and `stimulus_grade`,
  `next_move_advisory`, `recovery_advisory`, `layoff`, PR/progression are always overwritten with
  engine values (`routes/coachOps.js:606-658`, `:726`). Coaching mode + register are chosen by
  `selectCoachMode` / `grantRegister` from engine inputs only (`routes/coachOps.js:728-753`).
- **Live-session safety.** On the set path, `evaluateSessionSafety` (from `rules/safetyRules`)
  runs over the just-logged set + history and feeds `selectCoachMode`
  (`routes/coachOps.js:688,703,731`); a `safety` mode outranks recovery and is force-surfaced even
  on an otherwise-routine block (`routes/coachOps.js:791-799`). A *separate*
  `services/safetyClassifierModule.js` (`classifyTrafficLight`) is imported by
  `services/coachRunners.js:18`; whether that second classifier reaches the live surface is an
  inventory question for Phase 2/5 (findings H-06 / H-12) and is **not** resolved here.

## 3. Plan / acceptance

| Field | Finding (anchor) |
|---|---|
| Trigger / entrypoint | Client requests a plan via `POST /api/coach/message` with `kind:'plan'` (`routes/coachOps.js:475`, `:481`); client render in `appendWorkoutPlan` / `getSuggestedWorkoutMessage` / `getLlmPlanMessage` (`src/app/coach-conversation.js:557,697,872`). Acceptance is an explicit **"Start this plan"** button, `appendStartThisPlanButton` (`src/app/coach-conversation.js:622-666`), delegating to `window.atlasAcceptPlan`. |
| Facts assembled | Server derives the return-from-layoff signal from `Log_Cleaned` (`assessLayoff` + `scoreIntents`) and overwrites `facts.layoff` so the client can't inject it (`routes/coachOps.js:614-637`). |
| Model called? | Yes for plan prose: `coach.generatePlanMessage(facts)` (`routes/coachOps.js:825-826`, `services/coach.js:929`). Skipped when not configured / on error → templated fallback (`routes/coachOps.js:816-822,833-841`). |
| Persona / prompt | `PERSONA_CORE` + a plan-specific builder in `services/coach.js` (`generatePlanMessage`, `:929`). Plan voice carries no register grant; a conservative suppressor floor still strips ungranted profanity (`routes/coachOps.js:768-776`). |
| Deterministic override | Client has deterministic plan prose lines (`suggestedWorkoutProseLines`, `composeLlmPlanMessage`, `patternReadinessLine`, `dataPointLines`) at `src/app/coach-conversation.js:667,898,907,920`. **`PARTIAL`** — exact precedence between LLM plan prose and these deterministic lines not fully traced in v1. |
| Conversation history | Session/plan state + log-derived layoff/intents; no chat transcript on this path (`routes/coachOps.js:614-637`). |
| Production output | The rendered plan card + a "why today" prose line; acceptance button text e.g. `result.message || 'Plan started.'` (`src/app/coach-conversation.js:647`). The button "never claims the plan was remembered/captured unless the result says so" (`:619-621`). |
| Soul-risk notes | The acceptance boundary is honest (button, no silent capture) — good. `PARTIAL`: whether the plan "why today" is model-authored vs. templated in the common case needs the deeper coach.js trace in the implementation slice. |

## 4. Set & exercise logging — the routine reaction (THE RECEIPT)

This is the core finding — the "receipt" the campaign kills.

| Field | Finding (anchor) |
|---|---|
| Trigger / entrypoint | Every logged in-session block: `getInWorkoutNote(facts)` → `getLlmCoachingMessage` → `POST /api/coach/message` with `kind:'block'` (`src/app/coach-conversation.js:1026,1102-1115`). |
| Facts assembled | Server computes deterministic set-effort extras (`computeSetEffortExtras`), tiers the block via `assembleBatchNoteFacts` → `coachNoteTier`, and selects mode/register from engine inputs (`routes/coachOps.js:561-591,728-757`). |
| Model called? | **No, for the routine case.** `assembleBatchNoteFacts` yields no tier → `note_tier` defaults to `'ack_only'` (`routes/coachOps.js:569-570`); the handler returns `message:null` and does **not** call Gemini (`routes/coachOps.js:778-815`, return at `:813-814`). |
| Persona / prompt | None exercised on the routine path — the model is never invoked. (When a block *is* signal-carrying it is bumped off `ack_only` and does run `generateCoachMessage`; see Section 5.) |
| Deterministic override | The client renders a fixed template regardless of persona: `getInWorkoutNote` returns `coachVoiceTemplates.templatedAckLine(facts.exerciseName)` when `data.note_tier === 'ack_only'` (`src/app/coach-conversation.js:1036-1037`). |
| Conversation history | Session sets + engine history are assembled server-side, but none of it words the routine line — the output is constant. |
| Production output | **`"On plan — logged."`** — literally `templatedAckLine()` returns this constant, ignoring its argument (`src/app/coachVoiceTemplates.js:172-174`). Server-side companion message string: `'Routine block — acknowledgment only'` (`routes/coachOps.js:800`). |
| Soul-risk notes | **H-02, the target of the Phase 1 slice.** The persona says "stay quiet when a set is routine" (`services/coachPersonaCore.js:41`), but the realized behavior is neither silence nor a fact-grounded model line — it is a fixed receipt. The comment at `src/app/coachVoiceTemplates.js:162-171` still cites the retired design ("✅ Bench logged.") and asserts "never silence." The slice replaces this with **a brief, fact-grounded, model-authored reply OR deliberate silence chosen from session state.** |

## 5. Notable reactions — deviation / PR / fatigue / substitution / pain / safety

When a block is *not* routine, the engine bumps it off `ack_only` and the model (or a deterministic
renderer) words the specific signal.

| Field | Finding (anchor) |
|---|---|
| Trigger / entrypoint | A block whose selected `coach_mode ∈ {correct, challenge, safety, refuse}` is force-surfaced off `ack_only` (`routes/coachOps.js:791-799`); an on-target streak bumps to `short` (`:586-590`). Then `coach.generateCoachMessage(facts)` runs (`:824-827`). |
| Facts assembled | Deterministic engine reads: effort verdict, stimulus-governor `set_grade`, fatigue-router `next_move_advisory`, recovery/deload `recovery_advisory`, substitution voice, memory patterns, layoff, safety rule decisions (`routes/coachOps.js:561-604,639-724`). |
| Model called? | Yes when configured — `generateCoachMessage` (`routes/coachOps.js:827`). Its prose is then vetted by `finalizeCoachVoice` and can be **nulled** if it contradicts the deterministic voice or outruns register (`:831`). |
| Persona / prompt | `PERSONA_CORE` + `buildCoachSystemPrompt` ("A note is a VERDICT, not a description …", `services/coach.js:52+`). The model only *words* engine verdicts; the iron rules forbid inventing numbers/PRs (`services/coach.js:65`, `services/coachPersonaCore.js:44`). |
| Deterministic override | On outage/suppression the client words the engine directly: `templatedSubstitutionLine` / `formatSubstituteCoachLine` (`src/app/coachVoiceTemplates.js:19-56`), `templatedNextMoveAdvisoryLine` (`:65-79`), `templatedRecoveryAdvisoryLine` (`:97-112`), `templatedGovernorHoldLine` (`:139-149`), and `coachOpener`/`VERDICT_VARIANTS` (`src/app/coach-conversation.js:1121-1191`). A recovery/back-off read overrides a progression-invite opener (`:1080-1092`) — safety-class prose is never silenced by a brevity tier (`:1053-1055`). |
| Conversation history | Per-lift memory patterns (`detectPatterns`) and substitution history are assembled server-side (`routes/coachOps.js:707-717`); not the free-text chat transcript. |
| Production output | Model prose when it survives `finalizeCoachVoice`; else the deterministic lines above (e.g. `"Good pivot — … Log it."`, `src/app/coachVoiceTemplates.js:30`; verdict lines `src/app/coach-conversation.js:1121-1146`). |
| Soul-risk notes | The engine's *decision* is trustworthy and safety-first, but the **voice on the common notable case is still frequently a rotated canned line** (`VERDICT_VARIANTS`), and the engine can override live model prose — so "does it sound like a history-aware human?" depends on how often the model actually gets to speak. The two safety classifiers (`rules/safetyRules` live vs. `safetyClassifierModule`) are a Phase 2/5 consolidation (H-12). |

## 6. In-session question & correction

| Field | Finding (anchor) |
|---|---|
| Trigger / entrypoint | Free-text chat → `POST /api/coach/chat` (`routes/coachOps.js:1039`); a distinct read-only Q&A route `POST /api/coach/ask` (`routes/coachOps.js:1288`); client `getChatReply` / `handleChatMessage` (`src/app/coach-conversation.js:2091,2321`). |
| Facts assembled | `buildChatContext` assembles a bounded read-only snapshot: recent sessions, pattern readiness, stalls, under-coverage gaps, memory patterns, live plan/extra-work/failure signals (`routes/coachOps.js:849-919`), bounded again by `coach.sanitizeChatContext`. |
| Model called? | Yes — `generateChatReply({message, context, history})` (`services/coach.js:1514`), **but only after deterministic lanes.** Factual "what's my RIR/reps/total" questions are answered deterministically *before* the LLM; an explicit-discouragement message bypasses those lanes to reach the reassure voice; a tiredness message is routed to recovery first (`routes/coachOps.js:1055-1075`). |
| Persona / prompt | `PERSONA_CORE` + a chat builder in `services/coach.js` (`generateChatReply`, `:1514`); a typed "that was a PR" claim is treated as a session result, never persisted or granted PR language (`services/coach.js:1015`, `:1600-1609`). |
| Deterministic override | Deterministic lift-answer lanes and reassure/recovery routing precede the model (`routes/coachOps.js:1055-1075`); client outage fallback `chatFallback` (Section 8). |
| Conversation history | The chat transcript **is** passed here: `history = req.body.history` (`routes/coachOps.js:1044`) forwarded into `generateChatReply` — the one path that receives prior turns. Correction of a *logged value* is handled by re-entry into the deterministic preview flow (see `chatFallback`, `src/app/coach-conversation.js:2298-2300`; edit helpers `validateProposedEdit`/`applyProposedEdit`, `:2026,2046`). |
| Production output | Model reply for conversational turns; deterministic value answers for factual ones. **`PARTIAL`** — exact `ask`/`chat` model output wording traced at route level only in v1. |
| Soul-risk notes | This is the richest path (real history in scope) but also where deterministic lanes can pre-empt the model on anything that "looks factual" — a Phase 4 collision-phrase concern (session vs. education, H-16). |

## 7. Next-exercise handoff

| Field | Finding (anchor) |
|---|---|
| Trigger / entrypoint | After a block logs, the client resolves the next planned move: `getNextExerciseInPlan(exerciseName)` (`src/app/coach-conversation.js:1221`) and renders a next-up placeholder (`formatNextPlaceholder` `:1269`, `nextUpPlaceholderFromPlan` `:1309`). |
| Facts assembled | Plan order + lift-code catalog lookup client-side (`liftCodeForExercise` `:1197`, `buildNextPrescription` `:184`, `planStepFor` `:170`). |
| Model called? | No — deterministic placeholder/prescription rendering. The engine's cross-pattern *heads-up* about the next move rides in `next_move_advisory` from the set response and is worded by `templatedNextMoveAdvisoryLine` on the deterministic path (`src/app/coachVoiceTemplates.js:65-79`). |
| Persona / prompt | None on the handoff line itself. |
| Deterministic override | Entirely deterministic. |
| Conversation history | Session plan state; no chat transcript. |
| Production output | A next-up prescription placeholder + optional `"Heads up — …"` advisory line (`src/app/coachVoiceTemplates.js:71-76`). |
| Soul-risk notes | Handoff is fact-correct but voiceless — a candidate for the "sounds like a coach" work once the packet exists (Phase 3–4). Prior F10S work already forbids announcing the in-progress slot. |

## 8. Outage / degradation

| Field | Finding (anchor) |
|---|---|
| Trigger / entrypoint | Any path when `!coach.isConfigured()`, the Gemini call throws, or the client `COACH_LLM_TIMEOUT_MS` race resolves null (`routes/coachOps.js:816-822,833-841`; `src/app/coach-conversation.js:1103-1114`). |
| Model called? | Attempted then abandoned; the server explicitly tells the client to "use templated fallback" (`routes/coachOps.js:819,838`). |
| Deterministic override | Set voice → `finalizeCoachVoice(null, voiceBase, …)` (`routes/coachOps.js:817,836`) + client `coachOpener`. Chat → `chatFallback` (`src/app/coach-conversation.js:2288-2320`). |
| Production output | Set path degrades to the engine's deterministic effort line. Chat path returns regex-keyed nudges, e.g. `"Noted — keep logging …"`, `"You're putting in the work. …"`, catch-all `"Got it — keep logging your sets …"` (`src/app/coach-conversation.js:2303,2315,2320`). |
| Soul-risk notes | **Honesty concern.** `chatFallback`'s own comment states the reply is "never a hint the LLM is down" (`src/app/coach-conversation.js:2317-2318`). The campaign wants **honest outage degradation** with templates **outage-only**. Today the templates are also the *routine* voice (Section 4) — so "templates outage-only" is not yet true, and the outage is deliberately masked. This is Phase 1 (templates outage-only) + Phase 4 (honest degradation) work. |

## 9. Closeout & completed-session pin

| Field | Finding (anchor) |
|---|---|
| Trigger / entrypoint | Client `buildCloseoutConfirm(s)` renders the session review card at closeout (`src/app/coach-conversation.js:1651-1713`). |
| Facts assembled | Planned-vs-actual per item, substitutions/skips/revisions, unplanned lifts, row counts to write, plan-ledger rows to seal (`src/app/coach-conversation.js:1680-1710`). |
| Model called? | **No.** The closeout voice is fully deterministic — there is no LLM call on this path. |
| Persona / prompt | None. |
| Deterministic override | Entirely deterministic string building; honest ledger warnings on read failure / malformed history (`src/app/coach-conversation.js:1666-1667`). |
| Conversation history | Session ledger/plan state only. |
| Production output | `"Session review — <date>"` header; per-item `"<name>: target → did …"` lines; footer `"Approving writes N set row(s) … Rejecting writes nothing."` (`src/app/coach-conversation.js:1655,1707-1710`). |
| Soul-risk notes | Closeout has **no coach voice at all** — it is a correct but affectless summary card. The completed-session pin / "recovery-only" reconstruction lane are explicitly Phase 5 hygiene (H-17, H-19) and were not the subject of a live coach-voice moment in v1. |

## 10. Cross-cutting findings → what Phase 1 acts on

1. **The receipt is real and precisely located.** Routine blocks never call the model
   (`routes/coachOps.js:778-815`) and the client renders the constant `"On plan — logged."`
   (`src/app/coachVoiceTemplates.js:172-174`). This is **H-02** and the first implementation slice's
   direct target.
2. **The persona already wants the right thing.** `PERSONA_CORE` says "stay quiet when a set is
   routine" and forbids empty filler/hype (`services/coachPersonaCore.js:41,44-45`). The gap is not
   the prompt — it is that the routine path bypasses the model and emits a fixed line instead of a
   brief, fact-grounded reply **or** deliberate silence chosen from session state.
3. **Templates are not yet outage-only.** The same deterministic templates serve the routine voice
   *and* the outage voice (Sections 4, 8). The slice must move the receipt-class templates to
   outage-only and choose reply-vs-silence from session state.
4. **The engine can override the live model, and often speaks instead of it.** `finalizeCoachVoice`
   suppression (`routes/coachOps.js:831`) and the client `voice.suppress_generic_prose` /
   `VERDICT_VARIANTS` paths (`src/app/coach-conversation.js:1072-1084,1121-1191`) mean the "coach"
   the lifter hears on notable sets is frequently deterministic prose, not history-aware model
   language. Whether that reads as "a knowledgeable human coach" is exactly the Phase 1 gate
   question; the packet/trace work (Phases 3–4) makes it measurable.
5. **Outage honesty.** `chatFallback` deliberately hides the outage
   (`src/app/coach-conversation.js:2317-2318`); reconcile with "honest degradation" (Phase 4).
6. **Closeout is voiceless** (Section 9) — noted for later; not in the Phase 1 slice.

## 11. Scope, confidence, and what remains

- **Traced with high confidence:** the routine receipt condition (both server skip and client
  render), the persona/provider/model spine, the set-reaction authority model, the outage
  fallbacks, the closeout card.
- **Marked `PARTIAL` (extend in the implementation-slice PR):** the exact precedence between LLM
  plan prose and deterministic plan lines (Section 3); the exact model output wording of
  `/api/coach/ask` and `/api/coach/chat` (Section 6); the second safety classifier's live wiring
  status (Section 2, deferred to the Phase 2 inventory, H-06/H-12).
- **Not covered (out of this concern):** the completed-session pin and closeout reconstruction lane
  internals (Phase 5, H-17/H-19); the CoachTurnPacket/trace (Phases 3–4, do not yet exist).

This audit satisfies Phase 1 Work item 1 and unblocks Work item 2 (retire `"On plan — logged."`
from the normal path; a routine block gets a brief, fact-grounded, model-authored reply or
deliberate silence chosen from session state; bounded context; honest outage degradation; templates
outage-only) and Work item 3 (the ten golden transcripts + the Golden Session scenario).
