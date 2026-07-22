> **Reference input — engineering distillation, not an execution authority.**
>
> This file is the owner-provided **Atlas Soul Corpus V2 synthesis** — the capability,
> knowledge, data, strategy, implementation, and gap analysis distilled from the fifteen
> annotated sessions in
> [`ATLAS_SOUL_CORPUS_V2_SESSIONS.md`](./ATLAS_SOUL_CORPUS_V2_SESSIONS.md). It is preserved
> verbatim as source material and **does not select or sequence work**. The sole active,
> executable campaign lives inside
> [`docs/ATLAS_V1_EXECUTION_PLAN.md`](../ATLAS_V1_EXECUTION_PLAN.md), which governs.
>
> **Stale-reference note.** Section 5 and Section F of this document defer sequencing to
> `BACKLOG.md` **and `ACTIVE_ROADMAP.md`**. That `ACTIVE_ROADMAP.md` reference is **stale**:
> the active roadmap was retired to a compatibility pointer, and the single canonical
> work-selection authority is now the execution plan (see `docs/ACTIVE_ROADMAP.md` and
> `docs/DOCS_INDEX.md`). Read every "sequencing belongs to …" line in this file as
> "sequencing belongs to the execution plan; open intake is recorded in `BACKLOG.md`."
>
> **Section F is reconciled, not adopted.** Each Section-F gap is mapped to the campaign
> phase that already owns it — and the genuinely new items are filed as `BACKLOG.md`
> intake, never as a new roadmap — in
> [`ATLAS_SOUL_CORPUS_V2_SECTION_F_RECONCILIATION.md`](./ATLAS_SOUL_CORPUS_V2_SECTION_F_RECONCILIATION.md).
> The synthesis's own note that Section F "is an input to that process, not an override of
> it" holds. Recorded 2026-07-22 (Atlas Recovery Campaign, Phase 3 owner side-instrument).

---

# Atlas Soul Corpus V2 — Synthesis: Capabilities, Knowledge, Data, Strategies, Implementation

**What this document is.** The engineering distillation of the fifteen annotated sessions in `ATLAS_SOUL_CORPUS_V2_SESSIONS.md`. It answers: what capabilities the sessions demonstrate (A), what knowledge Atlas must contain (B), what data must be present at runtime (C), which coaching strategies exist and when each activates (D), where each capability should be implemented across the system's layers (E), and which capabilities the current architecture is missing or only partially provides (F).

**Governance note.** This document maps capabilities and gaps; it does not sequence work. Build order and priority remain governed by `BACKLOG.md` and `ACTIVE_ROADMAP.md`. Section F is an input to that process, not an override of it.

---

## A. Coaching-Capability Matrix

Session references use S1–S15. "Core" = demonstrated in Part I (owner standard); "Extended" = demonstrated or stressed by the Part II athletes.

| # | Capability | What it looks like in practice | Sessions |
|---|---|---|---|
| 1 | Context-aware session planning | Plan reflects split position, last session, schedule, time budget | S1, S3, S6, S9, S15 |
| 2 | Plan-purpose framing | The session's "why" stated before the first set (test, re-entry, restart, match-week) | S1, S2, S11, S15 |
| 3 | Readiness-adjusted prescription | Reported sleep/run/stiffness/shift trims volume or load before work begins | S5, S8, S9, S10, S15 |
| 4 | Layoff detection & re-entry logic | Gap length changes loads, session type, and how results are judged | S2 (14 days), S11 (10 weeks) |
| 5 | Progression verdicts (double progression) | Bumps earned via repeat thresholds at target reps/RIR; counters tracked and cited | S1, S6, S7, S10, S14, S15 |
| 6 | Increment sizing | Big lifts small %, small lifts smallest hardware step with rep resets | S1 (hammers), S10 (32.5s), S14 (85s) |
| 7 | e1RM computation & trend reporting | Reps+RIR method, comparable-set selection, "about" softening, % change | S1 |
| 8 | Intra-exercise fatigue-drift reading | Rep/RIR decay patterns detected and interpreted mid-session | S1, S3, S5, S14 |
| 9 | Live plan adaptation | Downstream sets trimmed/reordered off the drift evidence | S1, S3, S5, S10 |
| 10 | Fresh-vs-fatigued baseline protection | Fatigued-slot numbers never downgrade an exercise | S1, S3, S5 |
| 11 | Cross-lift evidence reasoning | One lift's result used to bound conclusions about another | S2 (OHP→bench), S8 (bench vs rows) |
| 12 | Limiter analysis | Falling reps at stable RIR → local limiter hypothesis + a designed test | S8 (grip/straps) |
| 13 | Substitution compatibility | Pattern + primary-muscle matching; emphasis shifts named | S4, S10, S13 |
| 14 | Working-weight finder | Ascend to criterion rep/RIR; overshoot policed; baseline stored | S4, S11 |
| 15 | Equipment non-equivalence handling | No cross-machine or barbell↔machine conversions; fresh scoreboards | S4, S11 |
| 16 | Equipment-ceiling progression | Reps/tempo become the axes when load caps out | S13 |
| 17 | Duplicate-stimulus prevention | Completed slots close; late equipment availability doesn't reopen them | S4, S5 |
| 18 | Conversational log correction | Surgical edits; interpretation re-derived; changed vs. held conclusions named | S5, S6 |
| 19 | Log-discrepancy verification | Plan-vs-log deltas trigger a neutral question, not a guess | S6 |
| 20 | Batch-log and truncation handling | Late logs get full reads; interrupted ≠ skipped in adherence accounting | S9 |
| 21 | Weekly volume accounting | Hard sets per muscle vs. target band; skips categorized; surplus redirected | S1, S14 |
| 22 | Exercise-order reasoning | Priority lifts first; accessory reads contextualized; reorder requests answered with principle | S3 |
| 23 | Better-than-expected management | Extra reserve banked (small adjustment now, scheduled test later), not spent | S6, S14 |
| 24 | Evidence-threshold declarations | Regression/plateau verdicts gated on pre-stated future evidence | S2, S11 |
| 25 | Conditional forecasting | Projections exposed as rule + condition, never promises | S11, S14, S15 |
| 26 | Uncertainty communication | "About," "maybe," "we don't have enough evidence," counterfactual honesty | S1, S2, S5, S8, S11 |
| 27 | Emotional recognition & data-grounded response | Frustration/doubt/fury/excitement validated, then answered with the athlete's own numbers | S1, S7, S11, S12, S13, S14 |
| 28 | Adherence-first coaching | Friction-lowering options, flexible commitments, shame-free returns | S12, S9 |
| 29 | Pain/symptom-informed modification | Stop rules, green-list selection, non-diagnostic language, professional-referral flags | S13, S10, S9 |
| 30 | Education moments | RIR teaching, failure-proximity evidence, concurrent-training, order principles — at the athlete's level | S7, S8, S14, S3 |
| 31 | Praise economy | Celebration only when itemizable from the log; decisions praised, not just outcomes | S1, S7, S12, S14 |
| 32 | Deliberate brevity / silence | Card-plus-one-line when the readback nearly suffices; register matching | S4, S6, S9, S12 |
| 33 | Narrative closeouts | Session's story ranked, verdict stated, next step armed | all fifteen |
| 34 | Per-athlete voice modulation | Same spine, different register (terse, warm, light, teaching) | S6 vs S7 vs S12 |
| 35 | Persistent athlete memory | Preferences, sensitivities, standing constraints, armed flags carried forward | S2, S8, S9, S11, S12, S13 |

---

## B. Required-Knowledge Inventory

What Atlas must *know*, organized as the in-repo knowledge documents the LLM retrieves. Docs 1–6 were specified in the "Making Atlas Smarter" research report; docs 7–12 are new requirements surfaced by the Part II athletes. Sources follow the report's tier ranking: Tier 1 = meta-analyses and position stands (Schoenfeld 2016/2017, Grgic 2018, Refalo 2022, Robinson 2024, Zourdos 2016, Helms 2016/2018, ACSM progression stand, 1RM-formula literature); Tier 2 = evidence-based practitioner syntheses (Stronger By Science, MASS, Helms' Pyramids, RP volume frameworks); Tier 3 = not used as authority.

1. **`persona_voice.md`** — the voice contract: reads not receipts, earned praise, restraint, banned phrases, register-flex rules per athlete profile. (Existing spec; extend with the Part II register examples.)
2. **`why_it_means.md`** — the explanation bank keyed by reason code: what a clean repeat proves, why e1RM rose, why fatigued accessories read low, why a trim was right, what a finder result means, what a return after a gap means. Every Part II session adds entries (bank-don't-spend, limiter-vs-strength, dormant-not-gone, returns-are-the-training, information-not-a-verdict).
3. **`progression_rules_plain.md`** — human-readable mirror of engine rules: double progression thresholds, hold-then-bump counts, increment tables (barbell 5–10 lb; dumbbell smallest step + rep reset; machine one pin), restart-ramp rules, equipment-ceiling axes (reps/tempo).
4. **`fatigue_and_failure.md`** — proximity-to-failure evidence (trivial hypertrophy edge, real recovery cost), RIR-decay reading, same-muscle carryover, the bounded failure allowance, junk-volume framing.
5. **`volume_and_frequency.md`** — hard sets/muscle/week as the unit, dose-response with diminishing returns, ~10–20 set working band framed as a range, 2x/week frequency, deliberate-skip vs. missed accounting, surplus-redirection logic.
6. **`evidence_and_uncertainty.md`** — the tier hierarchy, hold-loosely list (exact volume landmarks, wearable readiness, RIR-chart precision, failure-proximity effect size), and the linguistic toolkit: "about," conditional forecasts, evidence thresholds, counterfactual concessions.
7. **`detraining_and_retraining.md`** *(new — S2, S11)* — short-gap vs. long-layoff distinction; re-entry load reductions (~5% at 2 weeks, ~15–25% at 8–12 weeks as rule-of-thumb bands); retraining outpaces original training; early-return soreness ≠ fitness cost; evidence quarantine for re-entry sessions.
8. **`concurrent_training.md`** *(new — S8, S15)* — interference as a scheduling problem; same-day hard-cardio + heavy-legs stacking; strength work's durability/economy case for endurance athletes; taper hierarchy (volume before frequency); the 48–72 h heavy-work echo before competition; no novelty near matches.
9. **`athlete_context_modifiers.md`** *(new — S9, S10, S15)* — programming modifiers by context: older athletes (longer warmups, smallest increments, quality-guarded progression — same rules, gentler dials), shift/2-a-day athletes (session-role separation, interruptible design, front-loaded priorities, sleep-debt constraints), in-season athletes (maintenance dosing, match-week trims, post-match test placement).
10. **`pain_and_safety_rules.md`** *(new — S13, S10, S9, S7)* — the non-negotiables: never diagnose; athlete-reported symptoms are constraints, not puzzles to solve; stop rules pre-agreed; modification hierarchy (end movement → range-limited/pattern-adjacent substitute with clean personal history → end category, day still counts); symptom log entries; recurrence → professional-referral flag; technical breakdown as a legitimate set-ending criterion for novices.
11. **`behavior_change_and_adherence.md`** *(new — S12, S9)* — autonomy-supportive choices (full vs. short sessions), friction minimization after lapses, flexible commitment design (penciled + fallback windows), metric selection the athlete can't zero (sessions/week), shame-free language, the athlete's own return history as evidence, truncated-vs-skipped categorization.
12. **`beginner_teaching.md`** *(new — S7)* — RIR taught as a felt question; expected estimate roughness and the re-teach cadence; small-step progression; form-based set termination praised as skill; early progress framing (self-comparison only); watch-note etiquette for recurring form flags.

---

## C. Runtime-Data Inventory

What must be assembled and available at response time. Grouped by lifecycle.

**Athlete profile (stable, injected every session):** goal and its framing; experience level; split/template and schedule pattern; equipment list with increment granularity (dumbbell steps, machine pins, ceilings); standing constraints (reported pain patterns and their green/red movement lists, occupational realities); communication register (terse/chatty/teaching); motivation profile (praise economy calibration, commitment style); sport calendar if any (matches, races, shifts).

**Athlete memory (accumulating):** preference notes ("no hard commitments," "pre-state reasoning on conservative loads," "cite her own deltas"); sensitivity flags (compares to March, reads fatigue as weakness, tests for flattery); armed items (top-single test next week, straps experiment, 255 armed, Monday deadlift test, form watch-notes); symptom log entries with recurrence counters.

**Training history (queried):** per-exercise session history with load/reps/RIR; comparable-session selector output (nearest sets in a similar rep/RIR band, same context class fresh/fatigued); repeat counters per progression rule; per-machine/per-gym baselines as distinct lifts; personal bests with dates; post-gap return outcomes (for S12-style evidence).

**Session state (live):** today's plan with per-exercise targets and their purpose tags (test/re-entry/trim/finder); completed sets parsed; drift metrics (rep decay, RIR compression, decay rate vs. history); revisions made and why; contingencies armed pre-session and whether their conditions fired; time budget consumed; skips categorized (deliberate/time/truncated); unplanned additions.

**Readiness inputs (as reported or scheduled):** sleep report; prior/same-day cardio or sport load; days since last session per lift and per region; shift/match proximity; athlete's own percent-feel statements (stored as self-reports, cross-checkable against observed effort).

**Accounting ledgers:** weekly hard sets per muscle vs. target band; adherence ledger with category-aware counting (sessions/week metric where active); gap length tracker; quiet-streak counters for symptom patterns.

**Rule tables (engine-owned reference data):** progression thresholds per lift class; increment table; substitution-compatibility table (movement pattern × primary muscle × emphasis notes); e1RM lookup (reps+RIR → %1RM) with comparison-validity guards; re-entry/restart reduction bands; match/shift proximity rules; finder protocol parameters.

**Reason packet (the bridge, per response):** reason code(s); the specific computed facts (numbers, counts, comparisons, thresholds crossed); verdicts; state changes written. The conversational layer may claim nothing quantitative that is not in the packet.

---

## D. Coaching-Strategy Library with Activation Conditions

Each strategy: what it is, when it activates, and where the corpus demonstrates it. Strategies are selected by the conversational layer but *triggered* by engine-detectable conditions wherever possible.

1. **Expectation setting / session reframing.** Rename the session's purpose before effort begins. *Activates:* session type ≠ normal (re-entry, restart, readiness-limited, match-week). — S2, S5, S11, S15
2. **Declared contingency (pre-commitment).** Announce the adjustment rule before it's needed so mid-session changes land as strategy. *Activates:* plan contains a known risk point (heavy hinge before squat, low sleep, interruptible shift window). — S3, S9
3. **Validation-then-evidence.** Acknowledge the feeling fully, then answer it with the athlete's own data — never argue with the emotion, never skip it. *Activates:* emotional content detected (frustration, doubt, sting, fury) alongside data that bounds it. — S1, S7, S11, S13
4. **Reassurance through epistemics.** Decline to answer what the data can't answer; state the evidence threshold that would answer it. *Activates:* loaded question ("did I lose strength?") + insufficient evidence. — S2, S11
5. **Bank-don't-spend.** Better-than-expected readiness earns a small scheduled adjustment plus a booked future test, not an impromptu max. *Activates:* observed effort meaningfully easier than planned. — S6, S14 (inverted: the itch redirected)
6. **Redirect-the-impulse.** Convert a declined request into a sanctioned alternative that scratches the same itch. *Activates:* athlete proposes work that violates accounting/timing rules (add-on volume, max before a match, RDLs on deadlift day). — S5, S14, S15
7. **Concede-and-hold.** Grant the counterfactual ("maybe you could have"), keep the decision. *Activates:* athlete relitigates a conservative call after the fact. — S2
8. **Neutral verification.** Ask, don't assume, when the log contradicts the plan. *Activates:* plan-vs-log discrepancy above increment noise. — S6
9. **Trust repair via visible re-evaluation.** After any correction, restate which conclusions changed and which held. *Activates:* log edit accepted. — S5, S6
10. **Protective interpretation.** Pre-empt a false story (regression, "baby weights," wasted day) before it writes itself. *Activates:* fatigued-slot underperformance, novice doubt, substitution days, truncated sessions. — S1, S3, S4, S7, S9
11. **Autonomy-supportive choice design.** Offer real options with the low-friction one de-stigmatized; restructure commitments to be miss-tolerant. *Activates:* adherence-risk athlete at a re-entry or commitment moment. — S12
12. **Stop-rule enforcement with dignity.** Frame invoked pain rules as discipline; substitute from the athlete's clean history; size the event honestly. *Activates:* symptom report mid-session. — S13
13. **Education at the moment of relevance.** Teach the principle exactly when the athlete's own set just demonstrated it, or when they cite outside claims. *Activates:* direct question, misconception, or a live example in the log. — S3, S7, S8, S14
14. **Earned, itemized celebration.** Praise only what the log can itemize; praise decisions as much as outcomes. *Activates:* verified PR, threshold crossed, good judgment call. — S1, S7, S10, S14
15. **Deliberate brevity / register matching.** Card-plus-one-line when the readback suffices; telegraphic with terse athletes; light when the athlete asks for light. *Activates:* athlete register profile + nothing requiring influence. — S4, S6, S9, S12
16. **Narrative closeout.** Rank the session's story, state the verdict Atlas is accountable to, arm the next step. *Activates:* session end, always. — all fifteen

---

## E. Implementation Map

Where each capability family lives. Layers: **ENG** = deterministic engine (One-Brain: rules, math, verdicts, state), **KNOW** = retrieved knowledge docs (Section B), **MEM** = athlete memory store, **ASM** = session-state assembly (context injection at prompt time), **LLM** = conversational model (voice, strategy execution, register), **VAL** = post-response validation.

| Capability family (A-refs) | ENG | KNOW | MEM | ASM | LLM | VAL |
|---|---|---|---|---|---|---|
| Session planning & purpose framing (1–2) | plan generation, type tagging | why the structure | preferences, calendar | inject plan + purpose | voice the why | — |
| Readiness & context adjustment (3, 4) | trim rules, gap detection, quarantine flags | detraining, context modifiers | constraint history | inject readiness inputs | acknowledge + frame | — |
| Progression & increments (5, 6) | thresholds, counters, increment tables | progression_rules_plain, why_it_means | — | inject counters + verdicts | explain the earn | numbers match packet |
| e1RM & history comparison (7, 11) | lookup math, comparable-set selector, validity guards | evidence_and_uncertainty | — | inject computed trend | soften appropriately ("about") | no un-computed figures |
| Fatigue reading & live adaptation (8–10, 22) | drift detection, decay-rate comparison, revision rules | fatigue_and_failure | — | inject drift metrics + revision | decisive, cause-named | causal claims trace to packet |
| Limiter & cross-lift reasoning (11–12) | pattern detectors (reps↓ RIR→), experiment scheduler | why_it_means | experiment flags | inject the pattern | design the test aloud | — |
| Substitution & finder (13–17) | compatibility table, finder protocol, baseline store, slot-closure | progression rules, context modifiers | per-equipment baselines | inject finder state | protocol in plain words | — |
| Corrections & log integrity (18–20) | surgical edit path, re-derivation, discrepancy detector, category-aware adherence | — | — | inject changed/held conclusions | narrate the re-check | re-derived facts only |
| Volume accounting (21) | weekly ledger, band checks, redirect candidates | volume_and_frequency | — | inject ledger snapshot | show the ledger when relevant | set counts match ledger |
| Forecasts & thresholds (23–25) | rule+condition emitters, armed tests | evidence_and_uncertainty | armed items | inject conditions | state the condition, never promise | forecast must carry its condition |
| Uncertainty language (26) | packet marks fact/inference/unknown | evidence_and_uncertainty | — | — | apply the toolkit | hedges present where packet says unknown |
| Emotion & adherence (27, 28) | signal flags (gap length, sentiment cues surfaced, truncation cause) | behavior_change, pain rules | sensitivities, commitment style | inject flags + relevant history | strategy selection + register | no shame language; no invented psychology |
| Pain & safety (29) | stop-rule state machine, symptom log, recurrence counter, referral flag | pain_and_safety_rules | green/red lists | inject symptom state | dignity + non-diagnosis | no diagnostic or causal medical claims |
| Education & praise (30, 31) | trigger detection (question, misconception, verified PR) | all knowledge docs; beginner_teaching | teaching history | inject the live example | teach at level; itemize praise | claims trace to Tier-1/2 content |
| Brevity, voice, closeouts (32–34) | closeout data package | persona_voice | register profile | inject register + session story | the craft itself | length/register sanity check |
| Memory (35) | state-change writer | — | the store itself | inject relevant slices | speak memories naturally | writes match packet's state-change list |

**The validator (VAL) in one rule:** *no packet fact, no claim.* Every number, count, comparison, threshold, forecast condition, and causal attribution in the response must trace to the reason packet or a knowledge doc; emotional and stylistic content is free, quantitative and causal content is not. Failed validation regenerates with the packet re-emphasized; repeated failure falls back to the card plus a minimal templated read (templates are outage fallbacks, per the owner standard).

---

## F. Missing-Capabilities Gap Analysis

Measured against the Atlas architecture as currently documented: Node/Express on Render, Google Sheets Master Log, deterministic One-Brain engine owning numbers and verdicts, LLM owning voice, conversation-first logging with confirmation cards, single production athlete (the owner). **Claude Code should verify each item against the repo before treating it as missing** — this analysis is drawn from the architecture documents and mock corpus, not a code audit.

**Likely missing or unbuilt (corpus requires, architecture doesn't yet describe):**
1. **Reason-packet emitter.** The engine computes verdicts but the structured code+facts+state bridge to the LLM — the load-bearing mechanism of every annotation — is not yet a described component.
2. **Comparable-session selector.** History exists in Sheets; the selector that picks valid comparison sets (similar rep/RIR band, same context class) with validity guards does not.
3. **e1RM standardization.** The reps+RIR lookup must be the single engine method; Part I's correction of the old rep-only figures (253→270 became 271→286) is the cautionary example of two methods coexisting.
4. **Athlete profile & memory injection.** Preferences, sensitivities, armed flags, green/red lists — the corpus leans on these constantly; a persistent store plus prompt-time assembly is required (single-athlete today makes this small but not optional).
5. **Readiness intake.** A lightweight check-in path (reported sleep, prior cardio, shift/match proximity) feeding the trim rules; currently conversational only, not captured or ruled.
6. **Weekly volume ledger.** Hard sets per muscle with category-aware skip accounting and target bands; required by S1, S14 and the redirect strategy.
7. **Substitution-compatibility and increment tables.** Referenced by the engine rules throughout; need to exist as data, including per-gym equipment granularity and ceilings.
8. **Working-weight-finder mode.** A session sub-state (criterion, overshoot policing, baseline write) — demonstrated twice, engine support undescribed.
9. **Session-state repair / conversational correction.** Partially covered by the planned POST flow; the corpus additionally requires re-derivation plus changed-vs-held narration.
10. **Post-response validator.** The "no packet fact, no claim" check with regenerate-then-fallback behavior; nothing in the current stack enforces it.
11. **Signal flags for emotion/adherence moments.** Gap length, truncation cause, sentiment cues, sensitivity matches — engine-side detection so strategy selection isn't left to model improvisation.
12. **Evidence quarantine & armed-item scheduler.** Readiness-limited exclusions, watch flags with thresholds, booked future tests (top single, straps, Monday deadlift) that resurface on schedule.

**Present but needing extension:**
13. **Progression rules** exist in engine form; need counter transparency (the "2 of 3" the coach cites) and restart/re-entry variants.
14. **Confirmation cards** exist; need the finder, correction, truncation, and revised-remainder card variants the corpus uses.
15. **Knowledge docs**: persona/voice material exists in spec form; the twelve-document inventory in Section B — especially `why_it_means.md` and the six new docs — is mostly unwritten.
16. **Persona testing**: the existing four-persona harness concept extends naturally to the ten Part II athlete cards as regression fixtures for voice, strategy activation, and validator behavior.

**Deliberately out of scope for now:** multi-athlete accounts (the corpus's register-flexing is testable single-athlete via the harness); wearable-driven prescription (trend-context only, per the research pool); any medical reasoning (excluded by design, permanently).

*Sequencing of all of the above belongs to `BACKLOG.md` / `ACTIVE_ROADMAP.md`.*
