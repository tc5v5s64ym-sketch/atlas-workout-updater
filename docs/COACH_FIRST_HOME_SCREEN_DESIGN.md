# Coach-First Home Screen — Design Proposal

> **Status:** PROPOSAL for owner decision. **Not adopted. No code. No UI change. Planning only.**
> **Decision class:** Owner-reserved — coaching philosophy (CLAUDE.md routing category 2; `docs/OWNER_CHECKIN_RULES.md` Escalation Policy v3). This document proposes a direction and surfaces the reserved forks; it amends no governing doc and changes no runtime.
> **Trigger:** Owner brief (2026-07-03): "The Composer-First migration removed the tile home screen, but in doing so we accidentally removed the *feeling* of having a coach. The home screen now feels like a dashboard. Atlas should not greet the user with data — it should greet like a coach who already knows me, making a coaching decision about my day, not showing me a report."
> **Revision (owner, 2026-07-03):** v1 tightened to a **deterministic-only** opener; six governance guardrails made hard v1 constraints (see §2). LLM wording removed from v1 scope.
> **Governance grounding:** `docs/CONVERSATION_CONTRACT_V1.md`, `docs/COACHING_ENGINE_ARCHITECTURE.md` (One-Brain), `docs/research/coaching-intelligence/source-archive/07-the-feel-of-atlas.md`, `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md`, `docs/COMPOSER_FIRST_MIGRATION.md`.
> **Method note:** produced from a fan-out design investigation (6 grounded readers over the engine/signal/voice surface → 4 competing designs → 3 governance judges → synthesis → adversarial Codex-style critique), then revised to the owner's guardrails. The critique's fixes and the owner's constraints are baked in; unresolved forks are the "Owner decisions required" section.

---

## 1. The one-line finding

**This is not a new feature. It is a course-correction back to Atlas's own written philosophy — and the engine already emits the decision *and* its reasoning; the home screen just displays them as a dashboard instead of speaking them as a decision.**

Two facts make this low-risk:

1. **The philosophy already says this.** Doc 07 ("The Feel of Atlas"): the opening should feel like *"a hand on the shoulder, not a briefing… one line of plan, one line of why,"* opening Atlas is *"resuming, not launching,"* and Atlas must *"open with context… never with the void of 'How can I help?'"* The current home screen violates its own north star.
2. **The engine already emits the raw material — as sentences.** `GET /api/plan/intent-recommendation` returns `todays_read.recommended_label` **and** `intents[recommended].why_today[]` (full human sentences, e.g. *"Lower body is still recovering — keeping it to one movement today"*). A deterministic renderer can *arrange* those Brain-emitted facts into a decision + reason + invitation **without any LLM.** The engine already made the decision; the surface just isn't speaking it.

So the home screen has the ingredients of a coach and is serving them as a status page.

---

## 2. v1 scope and hard guardrails

**v1 = Today's deterministic decision + an engine-grounded reason + a conversational invitation. Nothing else.**

Six guardrails are **hard v1 constraints**, not preferences:

1. **No invented future schedule.** No "legs this weekend" / "back to squats Friday" unless the Brain emits that exact next-session signal (it does not today — `scoreIntents` is single-session). Until it does, the opener stops at *today*.
2. **No "rest is the plan"** unless the Brain emits a real rest recommendation (it does not — `scoreIntents` always returns a training pick, and `readinessSignal` is inert today). No rest-day posture ships in v1.
3. **No label-leading copy.** Never "Push day —". Lead with the *reason* or the *decision*, never the announced metric ("Today's read:" is the sin being removed).
4. **No false whitelist claim.** v1 is deterministic, so it does **not** route through the `CoachingDecision.explanation_inputs` whitelist and this doc never claims it does. v1 arranges facts the Brain already emitted (`why_today`, `recommended_label`, numbers) — it words nothing net-new and invents nothing.
5. **No LLM wording in v1.** The coach *voice* (`generatePlanMessage`) is **explicitly out of v1 scope.** Introducing it would supersede the owner's 2026-07-03 "one text box, LLM-free home" directive, which is an owner decision (§10), not a default.
6. **No persistent days-since guilt counter in the glance row.** Days-since may appear *only* as reasoning inside a spoken decision when it earns a place ("You've had five days off, so…"), never as a standing counter on the wall (guilt mechanics are banned — Principle 87).

Everything below is scoped to these.

---

## 3. Why it currently feels like software (the diagnosis)

The home hero renders four stacked artifacts:

```
Good afternoon, Dale.                              ← time-of-day pleasantry (state-blind)
Thursday. Today's read: Push day.                  ← a labeled metric  (#coach-opening)
12-day streak · Freshest: Chest (5d), Back (6d)    ← a stacked facts wall (#coach-facts)
Ask "what are we doing today?" for my pick…        ← a static tutorial (#coach-guide)
```

`public/app.js emitGlanceReady()` builds this deliberately LLM-free, reading only `todays_read.recommended_label` for a headline and appending consistency + a freshest-pattern briefing. **It never reads `why_today`, never takes a position.** The engine's reasoning is discarded at the surface.

The three "dashboard tells," each a documented failure mode:

- **The labeled read.** "Today's read: Push day" *announces a metric.* Doc 07 Principle 47: *respond to the state, never announce it.*
- **The stacked facts wall.** Streak + freshest-pattern as bare numbers is the "metrics wall" doc 07 calls a death mode (07:553). The design review kept a *glance affordance* — but as **one tappable row**, not a headline stack.
- **The static tutorial.** Instructional copy is the tell of software that doesn't know you. Doc 07: *the first workout is the tutorial.*

None of this is a coach making a decision. It is a status page with a greeting bolted on.

---

## 4. Design philosophy — the opening answers the question you haven't asked yet

The home screen has one job: **when you open Atlas, the conversation has already started, and the first thing you read is Atlas having already decided what today is and why — then holding the door open.**

Three principles, all from Atlas's own docs:

1. **Resuming, not launching (07).** You walked back to a coach who was already thinking about today. Calm expectation, not a welcome ritual.
2. **A decision, not a report (Contract + One-Brain).** Every engine fact becomes the *reasoning inside a spoken decision*, never a labeled metric. "Chest and back are recovered" is not a stat to display — it is *why* we press today.
3. **Warmth is earned by being known, not by cheerleading (07).** The warm clause ties to a real situation (a real gap, a fresh pattern), never a state-blind pleasantry, never hype.

The composer then *continues* the conversation — it never *starts* it.

**The canonical target shape (owner example):**

> Good afternoon, Dale.
>
> You've had five days off, so I'd restart clean today instead of chasing blind spots. I'd keep the session controlled and upper-body focused.
>
> Want that, or do you want to change the plan?

Decision made · reason given · door held open · no dashboard. (See §8 for which clauses of this exact example are engine-grounded today vs need a small engine signal.)

---

## 5. The eight questions, answered (v1 = deterministic)

**Q1 — How should a world-class coach greet the athlete?**
With a decision already made, not with data. Structure: **one clause of earned, situation-specific warmth → the call for today → one line of why (the engine's read *as reasoning*) → an open door ("Want that, or want to change the plan?").** Never "how can I help?"; never a metrics wall.

**Q2 — What belongs in the opener vs hidden elsewhere?**
- **OPENER (the only thing that speaks):** decision + one line of why + open door. At most two short lines.
- **GLANCE (one muted, tappable row):** today's focus + a readiness dot. Tap → the Today artifact. This is the "right to glance without composing a question" the design review kept — held to one row, by rule. **The streak may live here as neutral, un-shamed data; days-since may NOT (guardrail 6).**
- **ON-REQUEST ARTIFACT (behind the tap / Progress):** the full readiness board, trends, PR history, the exercise list. The exercise list is app-rendered, never inside the paragraph.
- **HIDDEN entirely:** scenario tags, reason codes, confidence tiers, provenance, plumbing words, and the static tutorial.
- **Governing rule:** a fact earns a place in the opener *only as the reason inside a decision.* As a bare number it belongs in the glance or stays hidden. **Facts never stack under the opener — that stacking IS the dashboard.**

**Q3 — How often should the opener change?**
**When the state changes — never on a clock, never rotated for novelty.** The opener is a pure function of real logged history, recomputed each open, so it differs across days because the situation differs. A same-day reopen with unchanged state does not re-brief; it drops to a compressed continuation line, floored so the hero is never blank. Manner is constant; only content tracks reality.

**Q4 — Recommend or ask?**
**Recommend by default; the open door is an invitation to override, not an interrogation.** Ask exactly one smallest question *only* when the answer genuinely forks the next action and the engine can't resolve it — and even then, state the provisional recommendation *first*. Never open with a question. When confidence is low, say *less* (a terse focus line), not more.

**Q5 — What if the user ignores the recommendation?**
**Nothing punitive, nothing repeated.** The opener is read-only and the log is authoritative: if the athlete logs something else, the next open recomputes from what was *actually* logged. The ignored pick is never re-served louder, never annotated with an "I told you so." Advice ignored twice recedes from the opener to the glance (Principle 40). A gap is met with a plan, never an audit.

**Q6 — How to avoid repetitive greetings?**
Two honest layers: **(1) Structural** — the opener is a pure function of real state, so consecutive opens differ because the facts differ (no phrase-rotation, no novelty engine — templated care is its own death mode, 06:111). **(2) A tiny no-database ledger** (localStorage ring buffer, modeled on the existing session-snapshot precedent) records the last few opener signatures; on a same-state match Atlas either compresses to a continuation line or selects a *different true angle* the engine already emits (a per-lift trend, a fresh pattern). It **never fabricates** an angle the engine didn't emit; when nothing new is true, the safe degrade is the short plain line. Even the deterministic floor varies via the existing seeded `pick()` so identical situations stay consistent.

**Q7 — Proactive without becoming annoying?**
**Opening the app IS the invitation** — so the opener is *on-request* (doc 07 Principle 83), which cleanly exempts it from the owner-gated notification/proactivity budget. **This proposal ships zero push notifications.** It stays un-annoying by structural rules: no guilt mechanics (no streak-shaming, no days-since counter, no "we missed you," no rest-day badge — a gap is data and a plan, never debt, Principle 87); advice ignored twice is withdrawn; the same opener is never re-served louder; and quiet-when-normal — a routine day is a single terse line (no elaboration to earn).

**Q8 — How does this leverage One-Brain?**
The Brain owns the decision, the pick, the reason, and every number; **the surface only arranges Brain-emitted facts into a sentence.** Flow, all read-only and LLM-free:
1. `scoreIntents` (already live behind `/api/plan/intent-recommendation`) produces the decision (`recommended_label`, `focus`, the exercise list) and its reasoning (`why_today[]` sentences, `reason_codes`, `data_points`).
2. A deterministic **opener renderer** composes: warm clause (from a real situation fact) + the call (`recommended_label`/`focus`) + one reason line (drawn from `why_today[]`) + the open door.
3. It **invents no number, verdict, or schedule**, and never says "engine"/"algorithm". `writeCapable:false`, touches no Sheets write, carries no `write_id` — the trust loop is never entered.

Because v1 has **no LLM**, there is no whitelist to bypass and no fabrication surface — the renderer can only speak facts the Brain already emitted. The fully Brain-envelope-native path (a pure `openerPosture` classifier over the `assembleState` snapshot, packaging a validated `CoachingDecision` whose `explanation_inputs` carries a **Brain-native wordable reason** field) is the **North-Star**, filed to backlog — it is where the `explanation_inputs` whitelist would become load-bearing, and it is owner-gated (§10).

---

## 6. The recommended opening model (layer by layer, all deterministic in v1)

- **Layer 0 — Decision line (synchronous, deterministic, always):** the hero speaks the Brain's decision + reason + open door, composed from the two fetches the home screen already makes. It never blanks, never blocks on the network, never depends on an LLM. **This is the whole of v1's spoken surface.**
- **Layer 1 — Optional continuity clause (one clause, richer situations only):** e.g. "Last time out was pull." Reconstructed deterministically from recall primitives; **degrades to nothing** on sparse history — never to a fuzzy memory.
- **Layer 2 — Glance row (ambient, one muted tappable line):** today's focus + a readiness dot. Tap → the Today artifact. Streak may live here as neutral data; **no days-since counter.**
- **Layer 3 — Composer:** placeholder continues the thread ("Log a set, or tell me to change the plan"), never "How can I help?".

**Killed:** the standalone "Good afternoon, Dale" pleasantry (folds into the warm clause), the "Today's read:" announcement, the stacked `#coach-facts` strip, the streak *headline*, and the static tutorial.

---

## 7. Example openers (deterministic, engine-grounded only)

> These are illustrative of the *shape*, not a copy deck — every fact is composed from an engine field, and the specific phrasings are owner-approvable copy fragments selected by a real signal branch (like the Contract's "examples are illustrative, not templates" convention). Because v1 is deterministic, each opener IS the line whether or not any LLM is up — **outage-proof by construction.** ⚠ = depends on a signal the engine does not emit today (see §8).

| Situation (engine signal) | Deterministic opener |
|---|---|
| **Normal on-plan** (`scoreIntents` top = push; chest/back status = fresh) | "Chest and back came in fresh, so today we press and pull. Ready when you are — or tell me to change it." |
| **Returning — real layoff** (`assessLayoff` days=9, severity=mild) | "Nine days out — today we rebuild, we don't chase. Upper body, clean reps I can read. Want that, or change the plan?" |
| **Mid-deload** (`readCurrentDeloadState` = active, sessions remaining) | "Still inside the back-off week — today's light on purpose. Move well, stop early, nothing to prove." |
| **First week / new athlete** (`total_sessions < 4`, trends insufficient) | "Good to have you here — these first sessions just set your baseline. Tell me the first thing you're training and I'll take it from there." |
| **Same-day reopen, unchanged** (ledger match; compressed, floored) | "Still here — push is ready whenever you are." |
| **Ignored pick carryover** (yesterday's upper skipped for legs; no re-push, no guilt) | "You went with legs yesterday — logged and settled. Upper's the open slot now, when you're ready." |
| ⚠ **The owner's flagship 5-day example** (see §8 — reason grounding) | "You've had five days off, so I'd keep today controlled and upper-body focused. Want that, or want to change the plan?" |

**Note on copy:** every opener leads with the *reason* or the *decision*, never a bare label. None promises a future session. None states a rest recommendation. None uses effort/RIR prescription language.

---

## 8. Where the owner's own example outruns the engine (honest callout)

The owner's flagship example is exactly the right feel — and parts of it point at signals the engine does not emit today. Surfacing this *is* the discipline the owner asked for: the coach may only say what the Brain knows.

1. **"You've had five days off"** — honest. `days_since_last_session` is a real computed number. v1 needs only to *expose* it on an endpoint the home screen reads (it is currently only forwarded inside the layoff object, which is dropped below the 7-day threshold). Trivial, deterministic, no LLM.
2. **"restart clean instead of chasing blind spots" / "keep it controlled"** — **not engine-grounded today.** At a 5-day gap `assessLayoff` reports severity `none`, so the engine recommends the *normal* best session, not a controlled reentry. For the coach to say "restart clean / keep it controlled" truthfully, the Brain must emit a **short-gap restart posture** (a 3–6 day gap → bias toward a controlled reentry). That is a small, owner-gated *coaching-logic* addition. Until it exists, v1 words the reason from the engine's actual `why_today` (e.g. "chest and back are freshest, so we press and pull") and states only the honest gap fact.
3. **"upper-body focused"** — honest *iff* `scoreIntents` actually picks an upper-body session (i.e. upper patterns are freshest). v1 words the engine's real pick; it does not assert "upper body" independent of it.
4. **No forward schedule, no rest verdict** — per guardrails 1 and 2, v1 never says "legs this weekend" or "rest is the plan" because no module emits them.

**Recommendation:** ship the deterministic *today-only* opener first (guardrail-clean), then add the short-gap restart posture and a severity-independent days-since fact as small, separately-owner-approved engine additions that let the coach earn the flagship wording honestly.

---

## 9. Phasing (tiny PRs — engine before surface, trust loop untouched)

- **PR-0 (docs only):** file this proposal; add backlog items for (a) a severity-independent `days_since_last_session` fact on the home endpoint, (b) a short-gap restart posture, (c) the North-Star Brain-native wordable-reason field, (d) an optional next-session-due forecast. *No code.*
- **PR-1 (the deterministic coach-first opener — the whole of v1):** compose the hero as **decision + engine-grounded reason + open door**, LLM-free, from the data the home screen already fetches (`recommended_label` + `why_today[]`). Demote the stacked facts to the single glance row (focus + readiness dot, **no days-since**); remove the static tutorial and the "Today's read:" label. Replaces the dashboard feel with a decision, outage-proof, using only shipped data.
- **PR-2 (anti-repetition ledger):** the localStorage ring buffer for same-state compression and advice-ignored-twice-withdrawn; the compress decision is server-owned (pass the last signature to the endpoint) so no coaching logic leaks to the frontend.
- **PR-3 (short-gap restart posture) — owner-gated coaching logic:** add the deterministic 3–6 day reentry posture + the days-since fact, so the flagship "restart clean / controlled" wording becomes engine-true.
- **Future / owner-gated (NOT v1):** the LLM coach voice at the hero (§10 decision 1); the North-Star `openerPosture` classifier + `CoachingDecision` envelope + Brain-native wordable reason; a next-session-due forecast for a truthful forward-look.

Throughout: **no touch** to preview→approve→write, proof fields, `test_mode`, slash-notation, or undo. Every new surface is read-only with no `write_id`.

---

## 10. Owner decisions required (the reserved forks)

This is a coaching-philosophy change, so these are the owner's call, not PM authority:

1. **LLM voice at the hero — explicitly out of v1.** v1 is deterministic and honors the 2026-07-03 "one text box, LLM-free home" directive. Reintroducing the coach voice (`generatePlanMessage`, with the deterministic line as a floor) would supersede that directive. **Approve superseding it, or keep the hero deterministic-only?** (Recommendation: ship deterministic v1 now; treat the voice as a separate, later, opt-in decision.)
2. **Posture set and verbosity calibration** — what counts as a "richer" opener vs a one-line one, and how quiet the default is. Encodes how much Atlas speaks. Confirm before build.
3. **Short-gap restart posture (PR-3)** — approve adding a 3–6 day reentry posture (and a severity-independent days-since fact) so the coach can honestly say "restart clean / keep it controlled" at a sub-week gap, *without* lowering the 7/14/28 layoff thresholds (which retune make-up-volume behavior and are separately owner-gated)?
4. **Situation-priority order** — the explicit rank for co-occurring situations (e.g. returning-after-layoff *and* deload-active), with "bias to safe/quiet on conflict" as the tie-break.
5. **Proactivity boundary** — confirm zero push notifications and the "opening is on-request, not proactivity" reading.
6. **Next-session-due forecast (future)** — approve building a deterministic "next pattern due" signal so a truthful forward-look ("legs back this weekend") becomes possible? Until then, no forward schedule ships.

---

## 11. What this explicitly does NOT change

- The preview → approve → write trust loop, proof fields, and `test_mode` semantics.
- The slash-notation parser (`225 5/2`) and the undo-last read-back flow.
- The engine's ownership of every number — the surface arranges facts, invents none.
- Google Sheets as the only store; no database; no nutrition/voice/autonomous-agent scope.
- The 2026-07-03 "LLM-free home" directive — **honored** by v1 (deterministic), not superseded.

---

## 12. Alternatives considered

Four competing designs were generated and judged; the recommendation grafts the best of each:
- **A — Minimal coaching decision:** contributed the single-decision opener and the position-first framing. *Adopted as v1's spine, deterministic.*
- **B — State-driven posture machine:** contributed the situation taxonomy and priority ordering.
- **C — Resuming conversation:** contributed the continuity tail and "resuming, not launching."
- **D — Restraint-first / anti-annoyance:** contributed the quiet-when-normal discipline and the no-guilt rules. *Won the longevity lens; adopted as the governing discipline.*

The synthesis: **"the quiet coach that resumes the thread"** — D's restraint as the spine (floored above silence so the hero is never a void), C's continuity tail, B's situation priority, A's single deterministic decision line. The originally-proposed LLM voice was removed from v1 per the owner's guardrails; it survives only as an explicitly owner-gated future option.

---

## gstack

Commands considered: `/plan-eng-review`, `/review`.
Commands used: None (skills unavailable in this cloud session; the methodology — grounded reads → competing designs → governance judging → adversarial critique → owner-guardrail revision — was run manually via a fan-out design workflow).
Why: this is a docs-only design proposal ending in an owner decision; it locks no architecture and changes no code. `/plan-eng-review` belongs to the PR-1 build if the owner approves the direction.
