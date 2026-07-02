# Atlas Design Review — Conversation-First Coach (Governance Only)

> **ADOPTION ADDENDUM (2026-07-02):** the owner approved the composer-first surface migration ("I like it, build it") after a full planning session. The adopted design and phase sequence live in [`COMPOSER_FIRST_MIGRATION.md`](./COMPOSER_FIRST_MIGRATION.md): Phase 0 (engine) + Phase A (coach-speaks-first additions) are active; Phases B/C/D are adopted in principle with the owner triggering each phase start; the **input-LLM provider/model decision remains owner-gated** (Phase C blocker). This review's verdict, three keeps (buttons-as-shortcuts, glance affordance, always-present `✅ logged`), and trust-loop guardrails carry into that plan unchanged.
> **Status:** Product-philosophy & architecture review. **No code. No UI changes. No runtime changes. No architecture rewrites.**
> **Governance layer:** Input to **Vision** (`docs/ATLAS_PRODUCT_VISION.md`) and **Constitution** (`docs/CONSTITUTION.md`). This review **does not modify** either — it is filed per the GOVERNANCE curator rule so the direction does not live only in chat.
> **Decision class:** Owner-reserved — a change to product vision / coaching philosophy (CLAUDE.md decision routing category 2; `docs/OWNER_CHECKIN_RULES.md` Escalation Policy v3). The direction is captured here for a future owner decision; nothing is implemented.
> **Trigger:** Owner brief — determine whether Atlas should intentionally return to being *an AI coach with capabilities* rather than continuing to drift into *a fitness app with AI layered on top*.
> **Mandate:** answer the review questions and **challenge the proposal honestly** — do not simply agree.

---

## TL;DR verdict

**Atlas should be "an AI coach with capabilities," not "a fitness app with AI" — because that is what Atlas already told itself to be. This is not a pivot; it is a course-correction back to the written vision, sequenced behind the engine that makes it trustworthy.**

Grounding the claim in Atlas's own documents, not generic product philosophy:

- **Constitution** already defines Atlas as *"a chat-first workout logger"* with a session-level heartbeat — *"no per-set save prompts; coaching during, one save at the end."*
- **Vision → "What Good Feels Like"** already lists *"Conversational"* and *"more like a coach who remembers everything than a spreadsheet,"* and *"the owner should not feel like they are filling out a form forever."*
- **Dream → Tenet 3:** *"Intelligence over surface — the training engine is the product; apps, platforms, wearables, and APIs are skins on the engine. A step that adds surface without deepening the engine serves the app, not the dream."*
- **One-Brain blueprint** (`docs/COACHING_ENGINE_ARCHITECTURE.md`) already specifies the exact architecture the owner describes: *Intent Router → Coach Orchestrator → Atlas Brain → LLM Explanation,* under the principle *"the UI never determines the response; the UI only expresses intent."*

The conversation-first instinct is therefore **already the codified stance.** What actually happened is **implementation drift**: a parallel Progress dashboard accreted (Today's Pick, readiness strip, intent grid, pattern board, weekly card, deprecated suggestion chips), and the same recommendation now renders in **two homes** — Coach's Pick *and* Today's Pick. The owner is not asking to change the vision. The owner is asking to **finish it and delete the drift.**

**Recommendation:** adopt conversation-first as **consolidation**, not revolution — but **build the engine before deleting the surfaces**, and preserve three things a purist reading would wrongly discard (buttons-as-shortcuts, a glance affordance, and an always-present "✅ logged" acknowledgment). The aggressive counter-case in Q6 is what bounds this recommendation.

---

## Owner refinements (2026-07-01) — the non-negotiable filter, and "orchestrate, don't replace"

Two owner directions sharpen this review and must not be lost:

**1. The non-negotiable filter (now Invariant I1, a forward filter on new work):**

> **The conversation is the product. Every screen exists to support the conversation, not compete with it.**

This is the single most important output of this review. It converts the direction into a per-PR test. Instead of *"should we add another dashboard / settings page?"* the question becomes *"does this make the coach better?"* / *"would a coach ask this naturally?"*. That one filter prevents years of UI drift. It is recorded as **Invariant I1** in `docs/INVARIANTS.md` — binding on *new* work immediately; demoting *existing* surfaces stays owner-gated.

**2. Conversation-first is NOT chatbot-only — it orchestrates capabilities, it does not replace them.**

The trap is swinging too far: "conversation-first" is misheard as "delete every screen and become a chat box." That is not Atlas. A one-tap "log this set" is often *better* UX than typing "log bench 225 for 5" — and pressing the button **is** the conversation expressing intent. The button is a sentence. So everywhere this review says a concept becomes "unnecessary," it means **unnecessary as a forced navigation choice or a rival destination — never that the capability is deleted.** Capabilities stay first-class; the conversation is the front door to them.

```
        Conversation  (the front door)
              │
              ▼
        Intent Router
              │
      ┌───────┼───────┐
      │       │       │
     Log     Plan   Review  …   (capabilities — still fully there)
```

**3. A milestone precedes the Intent Router: the Conversation Contract.**

Before building the Intent Router, define *how Atlas behaves* — when it asks, stays silent, interrupts, challenges, refuses to guess, summarizes, recommends. Those behaviors are Atlas's personality. Build the router first and every capability "talks" differently; build the **contract** first and the router has a consistent personality to serve. Captured as **`docs/CONVERSATION_CONTRACT_V1.md`** (philosophy only) and sequenced ahead of the Intent Router in the One-Brain backlog.

---

## Grounding — what the codebase is today

*(Established by reading the governance docs and the `public/` + `services/` surfaces before writing this review.)*

**The governance already says conversation-first** (quoted above). **But the implementation grew surfaces the vision never asked for:**

- **Coach surface** (`public/index.html`, `data-surface="coach"`) — the conversation-first home: greeting, composer, thread, and the preview→approve→write panel. This part is on-vision.
- **A parallel Progress surface** (`data-surface="progress"`) — a genuine dashboard: **Today's Pick** card, **readiness strip**, an **intent grid** of alternate-intent tiles, a **pattern board**, watchouts, weekly summary, highlights, and Trends/History/Body tabs. Most of this is read-only analytics — but it is framed as *a destination you navigate to.*
- **Duplicated recommendation:** the same intent recommendation renders as **Coach's Pick** (Coach surface) *and* **Today's Pick** (Progress surface). One truth, two homes — the drift symptom in one sentence.
- **Deprecated chrome still shipped:** `#suggestion-chips` is labelled deprecated-but-kept.

**Intent detection is fragmented — there is no single front door:**
- `services/messageIntent.js` — question-vs-log guard (phantom-log suppression).
- `public/planMutationIntent.js` — deterministic swap/skip classifier.
- Implicit flow in `public/app.js` — preview-button vs chat routing.
- **Buttons bypass classification entirely** (structured passthrough). There is **no unified upstream Intent Router.**

**The One-Brain blueprint already specifies the owner's architecture** — Intent Router → Orchestrator → State Assembly → Brain → LLM Explanation — but is **only partially active**: `brian` mode drives one endpoint (`/api/recommend/next/:liftCode`); the **Scenario Classifier, Session Generator, and Constraint Resolver keystones are missing.**

**Key implication:** the owner's vision and the One-Brain north star are the *same idea from two directions.* Conversation-first is the **UX consequence** of One-Brain's "UI only emits intent." Neither is finished, and each is a precondition for the other.

---

## The logging model this review assumes (owner-clarified)

Atlas must support **two equally valid workflows through one coach and one Brain** — the cadence differs, the intelligence does not:

- **Primary — batch logging (owner-preferred).** The user logs an exercise or block naturally:

  ```
  Bench
  135 10/5
  185 10/2
  225 5/2 x3
  ```

  Atlas parses the whole block, logs it, **confirms success**, and gives **one concise coaching note.** The user moves straight to the next exercise. This must feel **extremely fast** — the batch path is the hot path and the primary optimization target.

- **Secondary — live, set-by-set coaching.** Some sessions the user logs each set (`225 5/3` … `225 5/2` … `225 4/0`) and Atlas reacts briefly per set, noticing fatigue as it develops. Same coach, same Brain, different cadence.

Atlas adapts to whichever cadence the athlete uses **without a mode switch** — cadence is inferred, never chosen. This is the concrete logging expression of "the user never chooses the workflow; Atlas determines it from intent."

**Verbosity is earned, but acknowledgment is not throttled.** Routine sets get a short line; the coach spends words only on PRs, sandbagging, unusual fatigue, pain, readiness concerns, milestones, plateaus, and streaks. **But every successful log is always acknowledged** — e.g. `✅ Bench logged.` — even when there is nothing else worth saying (see Q6, risk 6: silence must never be ambiguous with failure).

**Tone is never shaming.** An easy set is *"I think you had more in the tank today — a great problem to have; let's take advantage next session,"* never *"you should have gone heavier."* Honesty must always feel safe, or the trust-first logger loses the honest inputs it depends on.

---

## The review questions

### 1. Is this a stronger long-term direction?

**Yes — and the honest framing is *conversation-first vs. accidental-dashboard*, not vision-A vs. vision-B.** Nobody chose dashboard-first; it accreted PR by PR as read-only cards found homes. Measured against Atlas's own filter:

- **Dream Tenet 3 (intelligence over surface):** conversation-first *is* this tenet applied to the UI — every surface that becomes "something the coach shows you when relevant" instead of "a screen you maintain" removes surface without removing capability. **Strongly favors.**
- **Constitution (chat-first, one save at end):** conversation-first is the literal restatement. **Favors.**
- **Decision Kernel — "Depth before breadth: make the existing path correct before adding surface area":** the dashboard *is* breadth. **Favors.**
- **Decision Kernel — "Trust over cleverness":** the one caution — a single composer is *cleverer*, a labelled button is *more legible*, and trust sometimes wants the boring, unambiguous control (→ Q6).

Net: conversation-first is the stronger **and more Atlas-native** direction. The dashboard was never a vision; it was entropy.

### 2. What existing concepts become unnecessary?

"Unnecessary" means **as a decision the user is forced to make or a destination they must navigate to** — not that the underlying computation is deleted.

- **The Coach's Pick vs. Freestyle mode fork** as an explicit top-of-screen choice. The user should never pick a logging mode; intent decides. *"What are we doing today?"* → recommendation. *"Bench 225 5/2 x3"* → log. Same coach.
- **`#suggestion-chips`** — already deprecated; retire it.
- **"Progress" as a primary navigation destination** (the Coach | Progress segmented control as the core mental model). There is one place — the conversation. Analytics is something the coach *surfaces*, not a room you enter.
- **The duplicate recommendation surface** — Coach's Pick and Today's Pick collapse to one canonical recommendation, delivered in the thread.
- **The intent-grid tile wall** as a standalone screen — these are alternate intents the user asks for (*"give me a hypertrophy day instead"*) or the coach offers inline.

None of this deletes the *engine*. `/api/plan/intent-recommendation`, the readiness computation, the analytics — all survive as **data the conversation renders** (Q3).

### 3. What survives as conversation artifacts?

Load-bearing; **not** deleted — reframed from *destinations* to *things that appear in the thread when asked for or earned*:

| Today (a destination) | Becomes (a conversation artifact) |
|---|---|
| Today's Pick / Coach's Pick card | The coach's answer to *"what are we doing today?"* |
| Trends tab + lift charts | A chart the coach renders when you ask *"how's my bench moving?"* |
| Weekly summary card | An inline check-in, surfaced when earned or on request |
| Readiness strip / pattern board | A line in the coach's reasoning, plus a **deliberate glance affordance** (Q6) |
| History tab | *"Show me last week"* → session list in the thread |
| Preview → approve → write panel | **Already** a conversation artifact — and constitutionally mandated. **Unchanged. The trust loop is not touched.** |
| Bodyweight logging | *"Bodyweight 182"* → same preview→approve→write, inline |

### 4. How does this affect One-Brain?

**It simplifies the target architecture and raises near-term build cost — because it makes the missing keystones load-bearing instead of optional.**

- **Simplifies the model:** One-Brain's core principle is "the UI only emits intent; the Brain decides." Conversation-first is that principle with the training wheels off — essentially one input surface (the composer) emitting intents, plus buttons as **intent shortcuts** (the owner's own framing, and correct). Fewer input shapes → a cleaner `IntentEnvelope` funnel → less UI-specific branching.
- **Raises the bar it must clear:** today the fragmented classifiers and button-passthroughs *hide* the absence of a real Intent Router. Conversation-first removes the buttons that were routing for free, so the currently-missing keystones — **Intent Router / Scenario Classifier / Session Generator / Constraint Resolver** — stop being nice-to-haves and become **preconditions.** You cannot honor *"I only have 30 minutes"* or *"shoulder hurts today"* without the Constraint Resolver and Session Generator that do not exist yet.

So "this reinforces One-Brain" is correct with a sharpened reading: it makes One-Brain **necessary, not merely elegant** — a feature, not a cost. It also means **conversation-first cannot ship ahead of the keystones** without regressing the exact reliability the current P0 roadmap ("Active Session Context Integrity") is fighting. **Engine first, surface second** (Dream Tenet 3; Decision Kernel "deterministic logic first").

### 5. What does Atlas look like one year from now?

**Home:** one screen — greeting and a composer. No tabs, no segmented control.

**Every input** flows through a single **Intent Router** into an `IntentEnvelope`, then the Brain, then the LLM words the Brain's decision. Buttons persist as **accelerators** (a "start today's session" chip *is* a typed intent), optional, never the only path, never a separate code lane.

**Logging** adapts to cadence without a mode switch. **Batch is the hot path** — a block logs, confirms, and gives one concise note, fast; set-by-set gives the same coach at higher cadence. The session compiles into **one** preview → owner approves → **one** write. Trust loop untouched.

**Verbosity is earned; acknowledgment is not.** Short line on routine sets, words spent only on the interesting moments — but **`✅ logged` is always present**, so silence is never confused with failure.

**Artifacts render inline** — ask *"how's my bench?"* → a chart bubble; *"what are we doing today?"* → a plan card. Nothing is a destination.

**A glance affordance survives as a deliberate exception** — a lightweight, always-available status pull (streak, readiness, what's stalling) the user can glance at without composing a question. Passive awareness is real value a pure chat loses; it is preserved on purpose.

**Under the hood the Brain is surface-blind.** The consumer app is one skin; a future wearable or gym integration emits the same intents (the Dream). Conversation is a skin, not the engine — which is exactly what keeps the Dream reachable.

### 6. Challenge the vision aggressively

*(Real risks, each with a concrete Atlas consequence. Grouped by the categories the brief named.)*

**Discoverability risk.** A blank composer hides every capability. A new user — or the owner three months later — faces "a coach you've never met": you don't know what you're allowed to ask. Buttons *advertise*; a blank box *tests your memory*. Mitigations (proactive suggestions, example prompts) quietly re-introduce chips — the very surfaces this vision deletes. **Consequence:** capability that is never invoked is capability that doesn't exist; conversation-first must budget for an ambient capability-hint layer or it will feel emptier than the dashboard it replaced.

**Intent-routing risk (the sharpest one).** In a button world, *"Today's Plan"* is unambiguous. In free text, *"what about squats"* is a log, a swap, a plan request, or a question — and Atlas's **current top-priority roadmap item is literally "Active Session Context Integrity"** because chat *already* misroutes active-session questions to generic knowledge. Conversation-first raises the stakes on the exact failure mode that is currently P0. **A misroute here is not a papercut — it is a phantom log or a silently discarded intent, both trust-fatal.** The Intent Router must be *more* reliable than the buttons it replaces, or the vision regresses trust.

**Trust-loop risk.** The vision must **not** be allowed to erode the preview→approve→write contract, the proof fields, or `test_mode` semantics — those are Constitution law regardless of interface. Two specific hazards: (a) "extremely fast batch logging" could tempt a shortcut that writes before an explicit approval — **forbidden**; the one-preview-one-write barrier stays. (b) An inline, conversational write artifact must remain as unmistakably an *approval gate* as today's panel — conversational styling must never blur the moment the user authorizes a real write.

**Interaction-cost risk.** `225 5/2` shorthand is fast; *"rebuild my session around 30 minutes"* is a sentence to thumb-type with chalky hands and a rest timer running. The 95% case (log the next block) wants a tap or a few characters; the 5% case (interesting coaching) wants conversation. A pure composer optimizes the rare case and taxes the common one — which is exactly why **batch logging is primary and buttons-as-shortcuts are required**, not a compromise.

**Accessibility risk.** Screen-reader and motor-impaired users often navigate *structured controls* more reliably than a free-text field whose surrounding content re-renders unpredictably. A thread that injects cards and animates typewriter text is an ARIA live-region hazard, and voice input — the natural escape hatch — is on the *"what not to build"* list. **Consequence:** inline artifacts must be properly-labelled, focus-managed components, or conversation-first excludes users the dashboard included.

**Reliability / degradation risk.** Atlas's safety model is that the deterministic engine works LLM-free (Invariant L2: provider failure must not block workout flow). But if "the conversation *is* the product," an LLM outage makes the product *feel* dead even though logging still works. The deterministic fallback voice must read as *"the coach being terse,"* not *"an error"* — conversation-first raises the bar on graceful degradation.

**Ambiguous-silence risk.** *"Nothing interesting to say"* and *"it didn't hear me / the write failed"* look identical when Atlas stays quiet — corrosive in a trust-first logger. **Resolution to codify:** verbosity throttling applies to *coaching commentary only*; the deterministic readback / `✅ logged` confirmation is **never** throttled. The Constitution's Magic Moment ("reacts instantly — a readback") already requires this.

**Loss-of-glance risk.** Dashboards let you *know without asking* — am I on a streak, is my bench stalling, is anything overdue. Conversation is ephemeral. "The coach earns the right to interrupt" protects the user from noise, but the inverse right — **the user's right to glance without composing a question** — is real, and a pure chat loses it. Hence the glance affordance is deliberate, not a hedge.

**Verbosity is an unbuilt classifier.** "Normal → short; interesting → longer" is a deterministic classification problem (PR? sandbag? plateau? readiness flag?) that does not exist yet and is non-trivial. Mis-tuned high → chatty and annoying; low → feels disengaged. **Consequence:** verbosity is an engine capability to build, tune, and test like any Brain module — not a copy decision.

**Scalability / Dream-tension risk.** The Dream is Atlas-as-*engine* powering *other people's* surfaces. If Atlas's identity fuses to "the chat app," there's a pull to bake conversation assumptions into the Brain — betraying Tenet 3. **Resolution:** keep the Brain surface-blind; the `IntentEnvelope` abstraction already protects this (a wearable emits intents too). Handled well, conversation-first is an *argument for* One-Brain rigor, not against it — provided the Brain never learns it is "talking to a chat."

---

## Where this lands

**Pursue conversation-first — as consolidation, sequenced behind the engine.**

1. **Reframe, don't rewrite.** This completes the Constitution's chat-first mandate and deletes dashboard drift. Any Vision/Constitution edits (owner-gated, not done here) would *sharpen* existing language, not reverse it.
2. **Engine before surface (non-negotiable — Dream Tenet 3 + Decision Kernel).** Build the missing One-Brain keystones — Intent Router, Scenario Classifier, Session Generator, Constraint Resolver — *before* removing the buttons that currently hide their absence. Shipped ahead of a reliable router, conversation-first regresses the current P0 trust work.
3. **Demote surfaces to artifacts incrementally** — one tiny PR each, behind the existing preview→approve→write and readback guarantees. Collapse the duplicate recommendation first (one canonical pick).
4. **Keep three things a purist reading would wrongly delete:** (a) **buttons as intent shortcuts** — required for gym ergonomics and the primary batch path; (b) a **glance affordance** for passive state; (c) an **always-present `✅ logged`** acknowledgment independent of coaching verbosity.
5. **Never touch the trust loop, proof fields, or `test_mode` semantics** in service of this — owner-gated Constitution law regardless of interface.

**Conclusion:** Atlas should be *"an AI coach with capabilities," not "a fitness app with AI" — because that is what it already told itself to be.* The task is not to choose the direction; it is to stop drifting from it, and to build the engine that makes a single conversation trustworthy enough to be the only surface.

---

## Governance disposition

- **Owner-reserved** (Vision / coaching-philosophy — CLAUDE.md routing cat. 2; Escalation Policy v3). This review **amends neither** `docs/ATLAS_PRODUCT_VISION.md` nor `docs/CONSTITUTION.md`, and **changes no code.** Those edits await explicit owner approval of the direction.
- **Curator rule satisfied:** the direction is filed here and captured as an owner hold-point in `BACKLOG.md` ("Strategic direction — deferred brainstorms").
- **If the owner approves,** the next step is **not UI code** — it is the One-Brain keystone sequence already architecture-locked in `BACKLOG.md` ("One-Brain Coaching Engine"), because conversation-first depends on it. Surfaces demote to artifacts only after the engine can route intent reliably.

---

## gstack

Commands considered:
* /plan-eng-review
* /review

Commands used:
* None

Why each command was or was not used:
/plan-eng-review — architecture-lock-in tool for a concrete new service/route/data-model. This review writes **no code and locks no architecture**; it ends in an owner decision. The keystone build sequence it feeds into is already architecture-locked in `BACKLOG.md`.
/review — pre-landing trust-boundary / scope-drift review. Docs-only change; no implementation, write-path, trust-loop, proof-field, schema, or parser touch — nothing for it to guard.
