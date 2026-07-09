# Atlas — Road to Personality, Voice & Soul
## A PR-level game plan (owner planning doc, 2026-07-08)

> **Status:** Owner planning document, drafted from a full repo review at commit `2539d23` (PR #930).
> **Scope:** (1) an honest snapshot of where Atlas is today, (2) Part A — the PR queue that gets us to the point where personality/voice/soul work *makes sense*, (3) Part B — the personality/voice/soul build itself, at PR level.
> **Model convention:** per `CLAUDE.md` owner standing instruction, the builder runs **Opus 4.8 for all work**. Risk tags (`[trust-critical]` etc.) are retained as review-intensity hints. Every build PR still gets a fresh Claude Code session and a hold point where the agent states its model and waits.

---

## 0. Where Atlas actually is (holistic snapshot)

**Plain English:** the foundation work is done. The house has been rewired, re-plumbed, and inspected. What's left before decorating is: (a) let the new brain prove itself against real gym traffic, (b) make three or four owner decisions, and (c) consolidate the voice layer, which is quietly re-fragmenting with every live bug fix.

### What's finished (verified in-repo, not from memory)

- **Remediation v2 is closed.** Phase -1 (live bugs), Phase 0 (safety net), Phase 0.9 (all four P0 data-integrity bugs — stale-Undo CLIENT-1 and parser bugs PARSE-1/2/3 — fixed with golden pins), Phase 1 (Vite + ES modules + app.js breakup 09a/09b), Phase 3 (exercise truth), PR-13, PR-16/17, PR-21 (governance diet), PR-22 (frontend de-dup), PR-23 (Flight-Recorder replay harness), PR-24 (state-store completion, all three slices).
- **app.js is down from 7,342 to 6,664 lines**, with six leaf modules extracted and session/plan/write state store-owned. PR-09c (the coupled triad split) was correctly skipped by owner decision — the store migration did the decoupling instead.
- **The Composer-First Migration fully shipped** (Phases A, B, C1–C2, D). Home is one Atlas text box; the conversation is the surface.
- **The One-Brain engine is built and instrumented.** Contracts (IntentEnvelope, CapabilityManifest, CoachingDecision), State Assembly, the rule-free Orchestrator, Scenario Classifier, Session Generator, Constraint Resolver, runners — all shipped with tests. Shadow observability (`brainShadow` ring + opt-in durable `Brain_Shadow` tab) is wired at all three coach-engine gates. The promotion evidence standard is codified in `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`.
- **~4,700 tests green across 207 test files.** The write path remains the best-engineered code in the repo (independent review: production-quality).

### What's genuinely open (the real blockers)

1. **The One-Brain promotion has not started collecting evidence.** `ATLAS_COACH_ENGINE` still defaults to `legacy` on Render. GATE A requires **50+ real, varied recommendation events** observed in hybrid shadow mode. That's calendar time in the gym, not code — and the clock hasn't started.
2. **Two coaching systems still run in production.** Until GATE A → PR-12A → burn-in → PR-12B, the legacy `analytics.js`/`scoreIntents` lanes drive most user-facing surfaces. The Coach Moments Engine spec (§9) explicitly sequences itself after PR-12A.
3. **The voice layer is re-fragmenting in real time.** The 2026-07-08 live-retest sweep (#923–#930) fixed real coach-trust bugs — but each fix added another inline prompt RULE (SESSION-TALLY RULE, SESSION-IDENTITY RULE, capture-vocabulary rules) to `services/coach.js`, now **104 KB**. The "prompt rules too large/brittle" failure mode flagged in the coach-voice architecture review is not a future risk; it is actively happening, and it gets more expensive to consolidate every week.
4. **Two personas still coexist in code** (verified live at `services/coach.js:48` vs `:1258`). Users hear the generic "sharp, encouraging coach"; the governance docs specify the not-easily-impressed logbook keeper, which sits unwired.
5. **The athlete's own story never reaches the voice.** `detectRecentPrs`/`buildProgressSummary` feed read endpoints and the recommendation adapter, but no coach prompt receives tenure, dated PR history, or streaks.
6. **AC8 (phantom-set suppression) is 2/3 done.** Rule (a) — questions never log — is wired and tested. Rule (b) — refuse unresolved lifts — is built but unwired, **blocked on one owner decision** (refuse-and-ask vs keep-flag-and-log). Rule (c) — never celebrate an unlogged set — was substantially delivered by #925's plan_state praise gate, but the lock-in guard test filed in BACKLOG is still open.
7. **A handful of owner decisions are queued:** AC8(b); Moments Engine §10 forks F1–F4; the tone/profanity calibration; GATE A itself; the recap-vs-next-up "remaining" derivation unification (PR-24 slice-3 divergence note).

### What does NOT block soul work (deliberately parked)

PR-18 (write-path router move — deferred, gate met but unscheduled), PR-19 (SQLite — dormant, trigger-gated), PR-20/Preact island (cut, evidence-gated), the write-path client `let`s (owner-gated trust-loop half), and the intent-router C3 routing promotion (parallel lane, independent of voice).

---

## The core insight driving this plan

**The binding constraint is calendar time, not build time.** GATE A needs 2–4 weeks of real training traffic in hybrid mode, and PR-12A then needs a ≥2-week burn-in. Every PR in Part A below is deliberately chosen to be *safe to build during those windows*, so the evidence clock and the build queue run in parallel instead of in sequence. Flip the flags **today**, build the voice-layer consolidation **while you train**, and GATE A arrives with the foundations already laid.

---

# PART A — Getting to "soul-ready"

**Definition of done for Part A:** one Brain drives production (or the owner has consciously decided the per-surface promotion schedule), the credibility floor (AC8) is complete, one persona exists in one place, the coach can see the athlete's history, and every prompt surface shares one rulebook. At that point, register/personality work is wiring + wording on solid state — not hope.

### A-0 — Flip the evidence switches *(owner action, ~10 minutes, not a PR — do this first)*

- On Render: set `ATLAS_COACH_ENGINE=hybrid` and `ATLAS_INTENT_ROUTER=shadow`.
- Optional but recommended (owner-gated, default-OFF): `ATLAS_BRAIN_SHADOW_PERSIST=1` so the `Brain_Shadow` tab keeps a durable record across deploys.
- Then just train normally. Every session feeds GATE A. Variety matters more than count (multiple lifts, upper+lower, in-workout traffic, a deload if one occurs naturally).
- **Also do the PR-04 infra follow-up while you're in the dashboard:** attach a persistent disk and point `ATLAS_IDEMPOTENCY_FILE` at it — the restart-safe idempotency shield is inert until this is done.

### PR-A1 — File the coach-voice architecture review *(docs-only)* · `[housekeeping]`

The already-drafted review lane (`claude/coach-voice-architecture-review-rq20i4`): commit `docs/COACH_VOICE_ARCHITECTURE_REVIEW_2026-07-09.md` + the five BACKLOG entries (persona-core extraction, persona doc↔code drift, athlete-identity facts object, engine-triggered challenge/reassure, verdict-voice disposition). No code. This puts the findings under governance so nothing below is built from chat memory.

### PR-A2 — Persona Core extraction · `[correctness]`

**One file, one persona.** New `services/coachPersonaCore.js`: identity line (the logbook-keeper — reconciled to `COACH_PERSONALITY.md` / `CONVERSATION_CONTRACT_V1.md` / the owner-ratified `COACH_VOICE_VALIDATION.md` corpus), the IRON RULE on numbers, conclusion-first, the anti-pattern list (pet names, attendance praise, hype vocabulary, emoji), the thin-history filler ban, plain-text-only, never-writes. All five prompt builders in `services/coach.js` import and prepend it; per-voice signal rules stay put.

- **Tests first:** each built prompt contains the core exactly once; shared-rule assertions migrate from `coachPromptRules.test.js` to run against the core; the filler/anti-pattern bans now hold across *all* voices (chat and plan get them for free).
- **Non-goals:** no sanitizer, gate, or engine changes; no new signals; verdict-reaction voice stays unwired (that's PR-A6).
- **Owner touch:** a five-minute read of the final persona wording before merge — this decides which coach every user hears. (Authority note: Tier-1 derivable per `DECISION_KERNEL.md`, but the persona *is* coaching philosophy, so eyeball it.)
- **Why now:** kills the two-persona split (a live credibility bug) and gives the retest-sweep RULE blocks a single home, stopping the 104 KB file's linear sprawl before Part B multiplies prompt surfaces.

### PR-A3 — AC8 rule (b): unresolved-lift refusal *(owner decision, then wiring)* · `[correctness]`

**Decision first (batch it with the Part B calibration session):** when a non-question message carries set tokens but an unrecognizable lift name (`"zercher thrust 95 8/2"`), does Atlas **refuse-and-ask** ("didn't catch that lift — which one?") or **keep today's flag-and-log** (catalog-review flow)? The engine classifier (`services/messageIntent.js`, `reason:'unresolved_lift'`) already exists; this PR is pure wiring of whichever behavior you pick. Refuse-and-ask matches the AC8 spec but can drop a set the user meant to record — that trade-off is exactly why it's owner-gated.

### PR-A4 — AC8 rule (c) lock-in: never celebrate an unlogged set · `[polish→trust]`

#925 already gates "I'm done" praise on `plan_state`. This PR closes the loop: a guard test sweep asserting **no celebration path fires on any non-`log_sets` / suppressed / conversation-only result** (server voice paths + `coach-conversation.js` client copy), fixing any gap found. Small, mostly tests — but it's the credibility floor for every celebratory sentence Part B will ever write.

### GATE A — One-Brain promotion review *(owner decision, not a PR)*

When the shadow window hits the `ONE_BRAIN_PROMOTION_CRITERIA.md` floor (50+ real varied events): run the checklist — zero unsafe, zero orchestrator errors, ≥90% agreement on comparable decisions within tolerance, explainable declines. Decide **per decision type** (progression first; `workout`/Coach's Pick stays behind the serve rail until its block-level divergence metric exists — see the filed follow-up). Outcomes: promote (→ PR-A5), extend the window, or send the Brain back for fixes.

### PR-A5 (= remediation PR-12A) — Promote One-Brain with a one-switch rollback · `[trust-critical]`

Flip serve-eligible decision types to Brian-driven with the legacy lanes intact and a single env-var rollback. No deletions. Then **burn-in: ≥2 weeks / ≥4 real sessions** with the checklist clean, recorded in BACKLOG.

### PR-A6 — Verdict-reaction voice disposition · `[correctness]`

The standing decision point from the review: the unwired logbook-keeper voice at `coach.js:1248`. With the Persona Core live, the likely right answer is **fold its gate logic (`shouldReactToVerdict`) into the set voice and retire the duplicate prompt** — one set-reaction path, one persona. Alternative: wire it as-is. Either way, one PR, ends the "the documented voice is the one nobody hears" era.

### PR-A7 — Athlete Identity Facts object · `[correctness]` — **the bridge PR into Part B**

Pure `services/athleteIdentity.js` computed from `Log_Cleaned`: training tenure, per-lift **dated** PR history ("185 in March"), session streaks/consistency, longest gap, days since last session, recent milestones. Sanitizer follows the frozen-enum whitelist pattern; forwarded to **both** the set-reaction and chat prompts through the existing plumbing.

- **Tests first:** computation fixtures; sanitizer whitelist + injection-stripping (mirroring `coach.test.js`); a prompt-rule test that history may be **cited but never invented** (the rule lives in the Persona Core — which is why A2 precedes this).
- **Why it's the bridge:** this is the single missing ingredient users *feel* — the difference between "strong set" and "strong set — up from the 185 you started at in March." Everything in Part B words facts; this PR is most of the new facts.

### PR-12B — Delete the superseded legacy lanes *(after burn-in)* · `[trust-critical]`

Runs on its own clock after A5's burn-in. **It does not block Part B** — Moments §9 requires PR-12A, not 12B. Also unlocks the `analytics.js` retirement endgame (`scoreIntents`/`recommendNextSet` consumers).

**Part A dependency picture (plain English):** A-0 today → A1→A2 immediately (docs, then persona) → A3/A4 as soon as the AC8(b) decision lands → train for 2–4 weeks → GATE A → A5 + burn-in → A6, A7 during burn-in → 12B whenever burn-in clears. A6 and A7 need only A2, so if the gym schedule slips, the build queue never idles.

---

# PART B — Building the personality, voice & soul

**The governing formula (from the owner-ratified buddy-coach brief):** the engine picks the *moment* and sets the *volume knob*; one Persona Core fixes *who's talking*; the LLM only picks the *words*. Nothing below loosens what the model may say — everything widens what the engine knows and permits. "Fuck yes, 225" is safe because `new_ground` proved it, never because the model felt excited.

### B-0 — Owner calibration session *(one sitting, not a PR — batch like the eleven-decision session)*

Everything the PM can't derive, settled at once so the build lane never stalls:

1. **Profanity ceiling** — allowed at all? Top-rung-only contexts confirmed (engine-certified rare events; never safety/pain/correction/uncertainty)? Weekly scarcity cap?
2. **Default register calibration** — how buddy-like: "Goddamn. 315." vs "That's new ground — 315."? Warmth/challenge/humor defaults.
3. **Moments Engine §10 forks** — F1 goal-proximity unprompted, F2 frequency dial, F3 teaching default, F4 cross-lift narrative.
4. **AC8(b)** if not already settled (refuse-and-ask vs flag-and-log).
5. **Golden-corpus ratification method** — confirm the Set A/B pattern extends: PM drafts buddy-register examples, owner approves/edits the corpus, corpus becomes the regression standard.

Output: decisions recorded in BACKLOG + the calibration values that PR-B2 encodes as data.

### PR-B1 — Coaching-mode enum (deterministic mode emitter) · `[correctness]`

Pure `services/coachMode.js`: one engine-owned enum — `silent | nod | note | praise | celebrate | correct | challenge | reassure | educate | refuse | safety` — with `selectCoachMode(facts)` mapping the triggers that already exist (`coachNoteTier`, `note_trigger: form_safety | pr_milestone`, effort/progression verdict levels, `memory_patterns.consistent_underperformance`, rule_decisions, layoff state) onto it deterministically. Unwired this PR. Tests: every mode reachable from real fact shapes; precedence pinned (safety > refuse > correct > celebrate > …); a clean met set maps to `silent` (protecting the crown jewel).

*Plain English: today "when does the coach speak, and in what spirit" is implicit across several modules. This names it in one place so everything after can hang off it.*

### PR-B2 — Register permissions (the volume knob) · `[correctness]`

Pure `services/registerPermissions.js`: `grantRegister({ mode, scarcity, ownerPrefs })` → `{ intensity: routine|elevated|max, casual_ok, profanity_ok }`. Owner calibration from B-0 lives here **as data** (a small config JSON), not prose in a prompt. Hard invariants as tests: `profanity_ok` only at `max`; `max` only for engine-certified rare events with scarcity clear; pain/safety/uncertainty force `routine` + `casual_ok:false` for humor-adjacent surfaces; the model never receives a knob it can turn — only the granted values.

### PR-B3 — Scarcity, derived not stored · `[correctness]`

Pure `services/celebrationScarcity.js`: compute when Atlas last earned a `celebrate` from the log's own `new_ground` history (no new persistence, no schema change). Feeds B2 so big reactions stay rare by construction. Tests: back-to-back new-ground days downgrade the second to `praise`; a drought clears the cap.

### PR-B4 — Wire mode + permissions into the voice paths · `[trust-critical]` — **the big wiring PR**

The behavior-changing step, kept as one concern: the server voice paths (set reaction, chat, closeout) call `selectCoachMode` → `grantRegister`, and the sanitized fact payload gains two whitelisted fields: `coach_mode` and `register`. The Persona Core (A2) gains the register-interpretation block: what each intensity sounds like, what `casual_ok` licenses, the profanity rules verbatim from B-0. `finalizeCoachVoice` suppression extends to register violations (prose that outruns its granted intensity gets the deterministic fallback, same ladder as today).

- Tests: mode/permission fields survive the sanitizer whitelist; a `max` grant never appears without the gates; prompt carries the register block once; suppression fires on a seeded violation.
- **Live validation:** run the TEST_QUEUE at the next real session before B5+ builds on top.

### PR-B5a — Engine-triggered challenge (drift signal) · `[correctness]`

The "brave enough to challenge when drifting" north star currently has no chat trigger beyond stalls/memory_patterns. Deterministic drift detector (skipped-pattern streaks, chronic plan deviation, sandbag persistence beyond the existing pattern) → emits `challenge` mode with the evidencing facts. The don't-cave-on-pushback rule finally reaches chat with an engine rule behind it. The Motivational-Interviewing shape (ask, don't lecture) lives in the Persona Core's challenge block.

### PR-B5b — Engine-triggered reassurance (discouragement seed) · `[correctness]`

Extend the `isTirednessExpression` pattern: a conservative deterministic discouragement classifier (explicit frustration phrases + stall context) → `reassure` mode carrying the zoom-out facts (per-lift trends, streaks, identity object). Not the 16-state research model — the smallest honest seed. The frustrated-lifter scenario stops being model improvisation.

### PR-B6 (multi-PR lane) — Coach Moments Engine, Phase 1 per spec · `[correctness→trust]`

`docs/COACH_MOMENTS_ENGINE.md` is already the governing spec — this plan defers to its own internal phasing rather than restating it. With B-0's §10 forks decided and PR-12A live (§9 gate), the lane opens: the seven-moment catalog (PR, progression callback, quality streak, stall broken, goal proximity, teaching, comeback), praise-economy budget, anti-repetition ledger, honesty contract — **shadow-first**, exactly like the Brain earned its promotion. Moments consume the identity object (A7), modes (B1), and register grants (B2) — which is why they're built in that order. Note: the goal-proximity moment (M-class) needs PR-B8 first.

### PR-B7 — Golden corpus + voice regression harness · `[housekeeping→correctness]`

Extend the owner-approved `COACH_VOICE_VALIDATION.md` Sets A/B with the ratified buddy-register corpus (B-0 item 5), then make it executable: deterministic tests assert **mode and permission selection** for each scenario (extending the tier/gate test pattern — behavior assertions, not prompt-text pins); every prompt surface carries the Persona Core; an advisory manual script scores sampled live LLM output against the rubric. This also begins retiring the brittle prompt-text-pinned tests the review flagged.

### PR-B8 — Structured goals + tone dial · `[correctness]` *(two small PRs, order flexible)*

- **Goals:** the smallest structured long-term-goal object (e.g. 215 on Bench and Squat, with dates) — the one identity fact not derivable from the log. Unlocks the goal-proximity moment and "chasing 215" callbacks. Storage decision (Constraints-tab row vs new tab) is a light owner nod (schema).
- **Tone dial:** the backlogged owner-facing preference (chattiness, celebration sensitivity, register ceiling) surfaced in Settings, feeding B2's `ownerPrefs` input. For a single-user app this is optional polish — but it makes the calibration adjustable without a PR.

### Part B sequencing at a glance

B-0 (one sitting, can happen **this week**) → B1/B2/B3 are pure modules, safe to build during the GATE A window or PR-12A burn-in → B4 waits for A2+A7 and ideally lands post-promotion → B5a/b anytime after B4 → B6 opens once PR-12A is live and §10 forks are decided → B7 ratchets alongside → B8 fills the last data gaps.

---

## The two clocks (how it all runs in parallel)

**Clock 1 — evidence (calendar time):** flip flags today → 2–4 weeks of training → GATE A → PR-12A → 2-week burn-in → PR-12B.
**Clock 2 — build (session time):** A1 → A2 → A3/A4 → A6 → A7 → B1 → B2 → B3 → (post-promotion) B4 → B5 → B6-lane → B7 → B8.

Owner touchpoints, in total: the flag flips (A-0), the AC8(b) call, a five-minute persona read (A2), GATE A, the B-0 calibration sitting, the §10 forks (inside B-0), promotion of `workout` decision-type when its divergence metric matures, and the B8 schema nod. Everything else is PM-authority build work under existing governance.

**The finish line:** an engine that knows the athlete's whole story, decides every moment and every decibel deterministically, and hands a single, owner-ratified persona exactly the facts and permissions it may word — a coach who can say "fuck man, that was strong" precisely because a gate proved it was.
