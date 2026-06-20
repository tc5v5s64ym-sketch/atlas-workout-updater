# Coach Interaction Trust — Investigation (P0 / P1)

> **Governance layer:** active investigation / diagnosis doc. Feeds the **Trust-Critical Coach Interaction Layer** workstream in [`ACTIVE_ROADMAP.md`](./ACTIVE_ROADMAP.md) and the matching top-priority entry in [`../BACKLOG.md`](../BACKLOG.md).
>
> **Status:** diagnosis only. **No code changes have been made.** Per owner instruction (2026-06-20), implementation is held until these findings are reviewed.

This doc captures the root-cause analysis for two live-testing trust failures, the affected pathways, and a proposed fix plan for each. It does **not** implement anything.

---

## Origin

Live testing (2026-06-20) surfaced a higher-priority trust issue than the in-flight extra-work signal (PR #440, now held). Two findings:

1. **P0 — Active-session questions answered with generic education.** When the lifter is clearly asking about the *active workout* ("What am I doing next?", "Weight? Reps? RIR?", "How much am I lifting, how many reps, how many sets?"), Atlas sometimes answers with a generic explanation of RIR / rep ranges / set volume instead of the current session's prescription. Expected: answer from the active session prescription. Actual: generic fitness lecture. This is a trust issue — the coach appears to "forget" the workout in progress.

2. **P1 — Substitution-quality signal not visible.** Prescribed deadlift → lifter substituted RDL → workflow completed → the expected substitution-quality coach signal did not visibly appear during testing.

---

## P0 — Active Session Context Integrity

### Root cause (confirmed)

Chat replies are routed **SME-first**. In `public/coach-conversation.js`, `getChatReply(message, history, context)` (≈lines 1121–1154) calls the deterministic training-knowledge SME endpoint **`POST /api/coach/ask` first**, and only falls through to the session-aware Gemini coach (`POST /api/coach/chat`) when the SME returns no usable card (depth `log_only` or no `answer`):

```
getChatReply()
  └─ POST /api/coach/ask  { message }        ← SME, generic education, NO session context
        ├─ data.depth !== 'log_only' && data.answer  → RETURN the SME answer  (short-circuit)
        └─ otherwise                                   → fall through ↓
  └─ POST /api/coach/chat { message, history, context }  ← session-aware coach (plan_state, recent_sessions, …)
```

The SME layer has **zero awareness of the active session or plan**. It matches the message text against static educational cards (`services/trainingKnowledgeCards.js`) and returns a lecture. So any session-scoped question that *happens to contain a training-concept keyword* is intercepted before it can reach the coach that actually knows the current prescription.

**Confirmed keyword interceptions** (traced through `services/trainingQuestionClassifier.js::selectResponseDepth` + `services/trainingSME.js::findTrainingKnowledgeCards`):

| Live question | Depth | Matched card | Result |
|---|---|---|---|
| `RIR?` | `coach_brief` (has `?`) | `rir_rpe` (matchTerm `rir`, whole-word) | generic RIR/RPE explanation |
| `how many reps?` | `coach_brief` | `rep_ranges` (matchTerm `how many reps`) | generic rep-range lecture |
| `how many sets?` | `coach_brief` | `training_volume` (matchTerm `how many sets`) | generic weekly-volume lecture |
| `How much am I lifting, how many reps, how many sets?` | `coach_brief` | `rep_ranges` / `training_volume` | generic lecture (not the prescription) |

Note that some session questions already fall through correctly because no card matches:

| Live question | Why it reaches the coach |
|---|---|
| `What am I doing next?` | no card matches `what doing next` → SME returns null → falls through to `/api/coach/chat` |
| `Weight?` | no card matches `weight` (no `add weight` phrase hit) → falls through |

So the failure is **not** total — it is the subset of session questions whose wording collides with an SME card's match terms. That is exactly why it looks intermittent in live testing.

### Why the session-aware coach would have answered correctly

`services/coach.js::buildChatSystemPrompt` already carries the rules to answer these from session state — the **WHAT'S-LEFT RULE** (answer "what's left / next" from `plan_state.remaining`) and the **HISTORY RULE** (answer past-workout questions from `recent_sessions[*].lift_sets`). `index.js::buildChatContext` assembles `plan_state`, `current_plan`, `current_preview`, `recommended_label`, `recent_sessions`, etc. The coach is equipped; it is simply **never reached** for the intercepted questions.

There is also a secondary contributor inside the coach prompt: a line that *permits* generic education ("General training, form, and programming advice is fine, but tie any specifics back to the snapshot") and **no explicit rule** that a prescription-shaped question about the current exercise ("how much / how many reps / what RIR for *this* lift") must be answered from `current_plan` / `current_preview` first. So even on the fall-through path, a prescription question is not strongly steered to the session prescription. The primary cause is the routing short-circuit; this is the reinforcing gap behind it.

### Affected pathways

- `public/coach-conversation.js::getChatReply` — the SME-first routing decision (primary).
- `index.js` `POST /api/coach/ask` (≈line 1222) — deterministic SME, no session context by design.
- `services/trainingSME.js` / `services/trainingKnowledgeCards.js` / `services/trainingQuestionClassifier.js` — the card matcher that fires on `rir` / `how many reps` / `how many sets`.
- `services/coach.js::buildChatSystemPrompt` — the session-aware coach that is bypassed; also the missing "answer current-exercise prescription from session state first" rule.
- `index.js::buildChatContext` — already supplies the session facts the coach needs.

### Proposed fix plan (no code yet — for review)

**Principle:** active session/plan context must take priority over generic fitness knowledge. The SME is a fallback for genuine education, not a front door that can swallow session questions.

Two candidate approaches (decision belongs in the build PR, after this review):

1. **Session-context gate before SME (preferred).** In `getChatReply`, when there is an active session/plan/preview in `context` (e.g. `plan_state`/`current_plan`/`current_preview` present) **and** the message is session-shaped (asks about "this/current/next" exercise, or asks weight/reps/RIR/sets in a session frame), route to `/api/coach/chat` **first** and only fall back to the SME when the coach declines. This keeps the SME for true education ("what is RIR?") while session questions go to the coach that knows the prescription. Frontend-only routing change; no engine/number change.

2. **Reinforce the coach prompt** (complementary, not sufficient alone): add an explicit PRESCRIPTION RULE to `buildChatSystemPrompt` — a question about how much / how many reps / what RIR for the *current or next* exercise is answered from `current_plan` / `current_preview` / `plan_state` first, never from generic ranges. This only helps once the question actually reaches the coach, so it pairs with (1).

**Constraints:** read-only coach path (`writeCapable:false`), engine owns all numbers, LLM only words session facts the engine already emits. No write-path, schema, or trust-loop change. `public/coach-conversation.js` is a coach-routing file (not the `public/app.js` trust loop), but routing changes still get a tiny, focused PR with tests.

**Success criteria (from owner):**
- Active-workout questions always use session context first.
- Prescription requests never route into generic education.
- "What next" always references the current workout state.
- Session state has higher priority than general chat intent.

---

## P1 — Coach Signal Visibility Audit (substitution quality)

### What was expected

Prescribed deadlift → lifter logs RDL → the substitution-quality signal (`services/substitutionQuality.js::scoreSubstitutionQuality`, wired into the coach voice in PR #439) should produce a visible coach reaction wording the swap.

### Findings (confirmed by code trace)

The substitution-quality signal can only fire when a **prescribed-vs-logged pair reaches the engine**. Tracing the path:

- Server side, `index.js::buildSubstitutionPreviews` (≈line 2631) classifies a swap and attaches `sub.quality` **only for entries in `prescribedList`**. With no `prescribedList`, it returns `[]` — no substitution object, no quality, nothing for the coach to word.
- `prescribedList` is built client-side from `lastPrescribed` (`public/app.js`), which is populated from **`parsed.prescribed`** — i.e. the parser detecting an explicit swap in the typed text (e.g. "deadlift skipped — platform busy, did RDL"), or from the `pendingSubstitution` flow, or from `inferPrescribedPairs` against `plan_exercises` when the client attaches the active plan.
- Passive logging of "RDL 225 8/2" with a prescribed-deadlift plan active, but **without explicit swap phrasing and without the plan being matched at log time**, yields no `prescribed` pair → `buildSubstitutionPreviews` has nothing to compare → **no substitution detected → no quality signal**.

So the most likely cause is the **same active-session-context gap as P0**: the substitution detector is driven by parser-detected swap phrasing / explicitly-attached plan pairs, not by silently comparing each logged lift against the active planned session. If the swap wasn't phrased as a swap (and plan inference didn't pair it), the engine never sees a substitution.

**Second, partly by-design contributor:** RDL-for-deadlift is a *good* swap (same hinge / posterior-chain pattern → `preserved` / `excellent`). Per the owner-approved proactive rule (`docs/COACH_VOICE_VALIDATION.md`), **good/acceptable swaps are intentionally brief/quiet** — Atlas volunteers *poor* swaps and anything that changes today's prescription/recovery/muscle trained, but keeps good swaps short ("Good call — intent preserved"). So even when the signal *does* fire for RDL-for-deadlift, it is deliberately understated and easy to miss in testing. That part may be working as designed.

**This needs one live reproduction to disambiguate** between:
- (a) signal never fired — no `prescribed` pair reached the engine (the context-gap hypothesis), vs.
- (b) signal fired but was intentionally quiet (good-swap brevity, working as designed), vs.
- (c) a routing conflict where another response was selected over the substitution note.

The code trace points hardest at (a). Confirmation requires reproducing the exact live flow (was the deadlift→RDL phrased as a swap? was `plan_exercises` attached? did `data.substitutions` come back non-empty in the preview?).

### Affected pathways

- `index.js::buildSubstitutionPreviews` (≈line 2631) — only classifies entries in `prescribedList`.
- `public/app.js` — `lastPrescribed` ← `parsed.prescribed`; builds `prescribed` / `logged_exercise` / `plan_exercises` for the dry-run payload (≈lines 3468, 3553).
- `services/planMatcher.js::inferPrescribedPairs` — infers pairs from the active plan when no explicit skip sentence (depends on the client attaching `plan_exercises`).
- `public/coach-conversation.js` — `getInWorkoutNote` → `/api/coach/message` set-reaction with `facts.substitution`; quiet/brief good-swap wording.
- `services/coach.js::buildVerdictReactionSystemPrompt` / `sanitizeSubstitution` — words the `quality` tier (PR #439), brevity rules for good swaps.

### Proposed next step (no code yet — for review)

Before any code change, **reproduce the live flow** to confirm which of (a)/(b)/(c) occurred — capture whether `data.substitutions` is non-empty in the dry-run preview for a deadlift→RDL log, and whether the swap was phrased/attached as a substitution. If it is (a), the fix aligns with P0: ensure the active planned session is matched against logged lifts at log time so a swap is detected even without explicit swap phrasing (likely via `inferPrescribedPairs` / `plan_exercises` always being attached and correctly paired). If it is (b), no code change — document that good swaps are intentionally quiet and decide (with the owner) whether good swaps deserve a slightly more visible acknowledgement.

---

## Priority order (Trust-Critical Coach Interaction Layer)

| Priority | Item | State |
|---|---|---|
| **P0** | Active Session Context Integrity — session questions must never route into generic education | diagnosed (this doc); **implementation held** |
| **P1** | Coach Signal Visibility Audit — confirm why the substitution-quality signal wasn't visible (deadlift→RDL) | diagnosed (needs one live repro to disambiguate); **implementation held** |
| **P2** | Extra Work Coach Signal (PR #440) | built + reviewed; **HOLD merge** pending P0/P1 |
| **P3** | Coach Brevity Pass — Conclusion first, Reason second, Details only when asked | not started |
| **P4** | Session-State Stress Testing — messy human inputs ("rack busy", "I'll do RDL instead", "skip that", "legs are toast", "what now", "how much", "what am I doing next") | not started |

**Owner constraints (2026-06-20):** stop after updating roadmap/backlog and producing this investigation plan. Do **not** merge PR #440. Do **not** begin implementation. Diagnosis first.
