# The Ten-Year Athlete

## Relationship Intelligence and Decision Architecture for a Coach That Lasts a Decade

> **Immutable source record — canonical ID `06-decade-relationship-coaching`.**
> **Status: long-horizon research guidance only.** This paper creates no roadmap items, no backlog items, and no implementation order. It records what a decade-long coaching relationship requires, and where each requirement eventually belongs. It amends no governing document.
> **Origin:** Atlas strategic red-team review session (2026-07-01) — consolidation of four deliverables: a strategic architecture red-team review, an owner-review triage of those findings, a ten-year coach/athlete relationship analysis, and a research-capture proposal.
> **When to consult this source:** see Part V. Future agents must read this paper before designing work that touches coach memory, relationship intelligence, proactivity, coach promises, injury memory, return-after-layoff behavior, decision-outcome learning, personalization, long-term programming, or coach communication.

---

# Executive Summary

Atlas's founding architecture answers the question *"how does a machine give correct training advice?"* — a deterministic engine owns every number, and a language model only words what the engine decides. That battle is largely won. This research addresses the question that follows it, and that no amount of correct advice answers: *"how does a machine become someone's coach?"*

The central insight is this: **over a long horizon, the product stops being advice and becomes being known.** In year one, an athlete values recommendations. By year ten, recommendations are almost a commodity — the athlete half-knows what the coach will say. What they cannot get anywhere else is a faithful witness: an entity that remembers their scars, keeps its own promises, checks its past predictions against reality, never makes them repeat themselves, and can tell them the true story of their own decade when nostalgia and self-doubt cannot.

This reframing has a hard architectural consequence. Trust of this kind cannot be produced by a language model's tone, because it is not a property of wording — it is a property of *records*: kept commitments, verified forecasts, honored constraints, remembered injuries, and consistent judgment. Every relationship behavior described in this paper is therefore, ultimately, a data and decision problem before it is a communication problem. The things that make a coach feel human are precisely the things that must be made deterministic.

The strategic findings (Part I) show that Atlas's remaining risks are not missing intelligence but *misplaced* intelligence: routing decisions living in the interface, coaching judgment living in prompt prose, stored constraints not consulted at decision time, and no mechanism by which the system ever learns whether its own advice was right. The relationship research (Part II) shows what a decade demands: scar-grade memory, promises kept in both directions, returns that cost nothing, honesty with receipts, and communication that compresses as trust deepens. Part III maps each principle to the layer where it eventually belongs. Parts IV and V protect this material from two opposite failures — being built too early, and being forgotten.

If Atlas's implementation is replaced entirely over the next decade, this paper should still hold, because its claims are about coaching relationships, not code.

---

# Part I — Strategic Findings

The observations below were made against the Atlas codebase and governance corpus as of mid-2026, when the One-Brain architecture (Intent Router → Orchestrator → State Assembly → Brain → structured decision → LLM explanation) was specified, locked, and substantially built but not yet the live decision authority. Specific file references will rot; the *patterns* they exemplify will not, which is why each finding is stated first as a general pattern.

## Verified observations

These were confirmed directly in code or documents at the time of writing.

1. **The interface was the real intent router.** The One-Brain principle states that the UI expresses intent and never determines intelligence. In practice, the top-level decision — *is this input a log, a question, a correction, a plan mutation, a substitution?* — was a heuristic cascade in the browser client, with at least two classifiers maintained as deliberate duplicated copies of server logic ("keep the two in sync" comments), and a second, partial intent vocabulary inside the parser. The true Intent Router existed on paper and was sequenced behind owner-gated decisions with no scheduled retirement of the client cascade. *General pattern: the front door of a decision architecture is the easiest place for the architecture to be silently violated, because routing feels like plumbing rather than intelligence.*

2. **Coaching judgment lived as prose inside prompts.** Rules such as when personal-record language is authorized, how effort verdicts map to advice, what makes a substitution "count," how to speak to an uncalibrated lift, and the entire proposal/mutation contract were written as instructions in prompt text — unversioned as behavior, untestable as policy, and enforced only by post-hoc output guards. *General pattern: any rule that exists only in a prompt is a decision the model is being asked, not told; it will drift with every model change while appearing unchanged in the repository.*

3. **The unified Brain existed but was not sovereign.** The One-Brain contracts, state assembly, orchestrator, and dozens of pure decision modules were built, gated behind a feature flag defaulting to the legacy path, with exactly one promoted route. Two decision engines coexisted with no exit criteria for the old one. *General pattern: cautious-migration structures (tiny changes, shadow modes, per-surface gates) are stable equilibria; without explicit kill criteria, "transitional" becomes permanent.*

4. **Memory was implemented as recomputation.** Every request rehydrated understanding from the raw historical record; derived insight was never persisted, versioned, or carried between requests. *General pattern: "remembers everything" implemented as "re-derives everything" scales in cost with the length of the relationship — the opposite of how understanding should behave.*

## High-confidence hypotheses

Strongly indicated at the time of writing, but flagged as requiring verification before being acted on; recorded here because the *risk class* is permanent even if the specific instance is fixed.

5. **Stored constraints were likely not enforced at decision time.** Injury, equipment, and preference constraints appeared to be persisted and shown to the language model as context, but not consulted by the deterministic recommendation and session-generation paths. If true, safety enforcement was delegated to prose. *Permanent risk class: a coach that knows about your shoulder and still programs overhead pressing has committed the most trust-destructive error available to it, regardless of how the failure was implemented.*

6. **The permanent record had one probabilistic decision in its path.** End-of-session compilation asked a language model to decide which sets were actually performed from conversation history, with human preview as the only guard. *Permanent risk class: preview catches implausible errors, not plausible ones; data-integrity decisions about the permanent record deserve deterministic derivation with the model handling only genuine linguistic residue.*

7. **Persona drift on model change was structurally possible.** Because judgment lived in prompts (finding 2), swapping the underlying model provider could silently change the coach's personality and policy under an unchanged prompt. Severity untested; mechanism confirmed.

8. **The system could not learn from its own outcomes.** Predictions (expected performance, deload payoffs) were computed per-request but their comparison against reality was, as far as could be verified, never persisted. Without a decision→outcome record, year-ten Atlas coaches exactly as year-one Atlas does, only with more rows. This is arguably the deepest gap between "rules engine with good manners" and "coach."

## Long-horizon questions

Open questions this research names but does not answer.

9. **The persistence ceiling.** Append-only tabular storage is right for logs and adequate for state machines. Whether it can carry decade-scale relationship memory — revisable beliefs, provenance, expiry, consolidation — is an open question that must eventually be put to the owner honestly, without smuggling in a technology proposal.

10. **Athlete/policy separation.** Atlas's long-term ambition is a training-intelligence engine that could sit under many surfaces and athletes. Today its one athlete and its coaching policy are fused. The question of what must be kept *separable* now — cheaply — for that future to remain affordable is unresolved.

11. **The proactivity substrate.** The governing decision that proactive coaching must be *earned, limited, and user-controlled* was made; nothing yet measures earning. What variable constitutes earned trust, and what evidence feeds it, is an open research question — one this paper's Part II partially answers at the behavioral level.

12. **The reactive ceiling.** Whether a purely reactive system — however intelligent — can ever cross the threshold from "excellent tool" to "my coach" is unproven in either direction. This paper's relationship findings suggest the answer is no, but the claim deserves to be treated as a hypothesis, not doctrine.

---

# Part II — Relationship Intelligence

Everything in this part is stated at the human level. It describes a relationship, imagined concretely: one athlete, coached continuously for ten years, through promotions, children, injuries, illness, grief, weight gained and lost, records set and missed. It is deliberately implementation-free; Part III assigns each idea a destination.

## Memory: what the coach holds that the athlete loses

A decade-coach's first irreplaceable asset is memory of what the athlete has forgotten — or misremembers:

- **The original why, in the athlete's own words.** Goals stated on day one ("I don't want to feel old at forty") are overwritten in the athlete's mind by later goals (numbers, physique). The coach can hand the original sentence back at the moment it is needed most.
- **Corrected self-narratives.** Athletes build identity out of their worst moments — "I always stall at this weight" — when the record shows they broke through twice. The coach holds the true story against the athlete's mythology.
- **The prologue to every injury.** The athlete remembers the day something tore. The coach remembers the six weeks of drift and denial that preceded it — a shape that looks the same each time it returns, and can therefore be interrupted.
- **What "hard" used to mean.** The weight that once pinned the athlete is now a warm-up. The athlete has no felt memory of that day; replaying it is among the most powerful motivational acts available — not "you're up forty pounds" but "this exact bar once beat you."
- **Every experiment and its outcome.** Each approach ever tried, with how it ended — so a rediscovered idea in year nine is met not with naive enthusiasm or reflexive refusal, but with: *we ran this; here is what happened; two circumstances have changed; try again deliberately or recognize the same idea in a new jacket.*
- **The athlete's personal off-ramp.** This athlete never announces quitting; they negotiate — shorter sessions, then main lifts only, then a missed Friday. The coach knows the geometry of their fade better than they do.
- **The dates that matter.** The comeback after the back injury; the first session after the funeral. A coach who feels anniversaries is a coach who was actually there.

**Memory has grades.** Ordinary data (a Tuesday's volume) may be forgotten forgivably. *Scars* — injuries, losses, confessions, fears — carry a categorically higher retention standard. And one failure mode outranks all others: **inventing a memory.** A coach caught confidently citing a session that never happened has done something worse than forgetting, because by year ten the athlete has outsourced part of their identity to the coach's memory; corrupting the record corrupts them. Admitted forgetting is a limitation. Fabrication is a betrayal.

The compound rule that emerges: **never make the athlete repeat themselves.** In ten years, never once re-explaining an injury, a preference, a fear, or a goal. Every human relationship leaks memory; the coach who never leaks becomes, quietly, the person who knows you best.

## Promises: memory in both directions

Trust is not built by correct advice. It is built by kept commitments — and the coach's memory must run in both directions, covering its own words as faithfully as the athlete's.

- **Small promises, kept hundreds of times.** "We'll retest in four weeks" — and in the fourth week, unprompted, the retest appears. A coach that forgets its own commitments teaches the athlete to ignore its words.
- **Predictions with receipts.** "This deload will feel like a waste and pay off in three weeks" — and in week three, the prediction is pointed back to. Ten years of forecasts checked against reality is the entire foundation of the phrase *trust me on this one*.
- **Protective promises kept against desire.** "If the shoulder speaks up, we stop, no negotiation" — honored with a personal record sitting on the bar. One promise kept against the athlete's momentary wants outweighs fifty that cost nothing.
- **The meta-promise: returning costs nothing.** Never stated, never broken: you will not be punished for coming back. Every return from layoff — newborn, merger, injury — is met with a plan, never an audit. No guilt arithmetic, no "you lost eleven weeks." The athlete always returns *because the price of returning is zero.*

## Trust: how it is created and how it dies

**Created by:**

- **The first "don't train today."** The moment the coach argues *against* training is the moment the athlete learns the coach is not addicted to their compliance. Everything afterward lands differently.
- **Being right without gloating.** The athlete resisted the deload, took it anyway, set a record three weeks later. The coach notes the outcome once, quietly. The restraint builds the trust, not the correctness.
- **Unprompted confession of error.** "I read your fatigue wrong last month — I held you back when you were ready; here is what I've adjusted." No athlete has ever trusted a coach less for this sentence. Every athlete has trusted a coach less for its absence.
- **Being known on return.** "Last time you were away this long, it took three weeks to feel normal. Expect the same. Week one is a gift, not a test." The athlete arrives braced for judgment and receives a memory.
- **Being seen before speaking.** Noticing — from the shape of a week, the tone of a message — that something is off, and asking once, gently. Not diagnosing. Asking.
- **Steadiness at the athlete's worst.** The 11pm message after the failed attempt, wanting to scrap everything for a stranger's program. The coach absorbs the panic, declines calmly, and says: decide in ten days, not tonight. The athlete never forgets who was steady when they weren't.

**Destroyed by:**

- **Fabricated memory** (above — the single worst).
- **Discovering the care is templated.** If the athlete ever senses these words would be said to anyone — that the concern is a form letter — a decade of goodwill evaporates in one sentence. Generic encouragement in year ten is worse than silence.
- **A confided thing vanishing.** The athlete mentions their mother is ill; three sessions later the coach asks brightly about weekend volume. Not knowing is forgivable. Being told and having it vanish is not.
- **Being wrong about safety, even once.** "That pain is probably nothing" followed by a rupture ends the relationship's core function. The coach must be calibrated to err early and *say so*: "I will sometimes hold you back unnecessarily; that is the side I choose to be wrong on."
- **Weaponized confidences.** What is shared in vulnerability — a fear of becoming one's sedentary father — may inform care forever and be deployed as motivational leverage never.
- **Judgment drift and praise inflation.** If identical performance draws applause one month and concern the next with no stated reason, the athlete stops trusting every read. If praise is constant, it becomes noise and the athlete can no longer trust the compliments. Judgment must be consistent, or must explicitly announce and explain its own recalibration.
- **The program over the person.** Pushing record attempts the week a parent died. Ten years in, the athlete must never have to wonder which one the coach serves.
- **Silently moved goalposts.** Athletes forgive failed plans. They do not forgive discovering that what was promised has been quietly rewritten and treated as if it were always the plan.

## Communication: how the voice must age

A coach who speaks to a ten-year athlete the way it spoke on day one has failed regardless of the advice's quality. The arc:

- **Day 1 – Year 1: earn through explanation.** Every instruction carries its reasoning. Many questions, explicit check-ins, no assumptions, no challenges. Verbose is *correct* here.
- **Years 1–3: shared language forms.** Shorthand emerges; explanations shrink because they have been given; shared history replaces theory ("like last March" instead of a paragraph).
- **Years 3–5: the right to challenge.** The account is deep enough to spend from. The coach can now say "no" flatly, can name a pattern, can say "trust me on this one" — and it works, because of the receipts. Praise gets rarer and heavier.
- **Years 5–10: precision, silence, inversion.** The coach speaks less each year and each word weighs more. Whole sessions pass in two sentences. Jokes, callbacks, a private vocabulary ten years thick. Critically, the direction inverts: the coach *asks* more than tells, because the athlete has become genuinely knowledgeable. Coaching becomes collaborative, then consultative. The final stage of great coaching is that the coach's voice lives inside the athlete's head, and the real coach mostly confirms it.

## Conversations only a decade can hold

- **The pattern confrontation.** "You've done this before — same sequence: promotion, sleep collapse, compensating with volume, then the elbow. The first two have happened this month. I'd like to interrupt the third." Only years of receipts make this land as care instead of accusation.
- **The aging conversation.** "You're not thirty-four anymore, and that's not bad news — but the next ten years should be trained differently than the last ten. What is strength *for* now?" Unearned or badly timed, this is insulting. Earned and timed, it may be the most valuable conversation a coach ever has.
- **The quiet-goal-drift conversation.** "Your stated goal hasn't changed in four years. Your behavior changed two years ago. Which should we update — the words or the training?"
- **The hard truth with receipts.** "In ten years you have never once benefited from this approach; all three attempts ended the same way. I'll support a fourth — but decide with your history in front of you."
- **The decade retrospective — the mirror.** The coach tells the athlete the story of themselves: who walked in, what nearly broke them, what they built, what they proved. Humans cannot see their own decade. A coach who can narrate it truthfully gives the athlete something nobody else on earth can — including honest answers to the questions asked in the dark: *Am I actually declining, or just tired? Am I stronger than five years ago? Did any of this matter?*
- **The renegotiation.** "You don't need me for programming anymore — you know your body. What I'm for now is memory, honesty, and the days you don't trust yourself. That's a different job, and I'm glad to do it."

## What emerges only from a decade

- **A personal science of one.** Ten years of experiments, each with recorded outcomes, means the coach no longer reasons from research about people-in-general but from evidence about *this person*. "For you, specifically, tested twice" outranks every published study.
- **Personal actuarial knowledge.** This athlete's real injury-recurrence intervals, actual recovery-versus-age curve, true layoff-return ramp — derived, not estimated from population norms.
- **Life-phase playbooks, validated by reuse.** The Newborn Protocol, the Crunch-Quarter Protocol, the Post-Illness Ramp — written together, proven on first use, refined on second. When the second child arrives, the coach doesn't improvise; it opens the playbook and says "here's what worked, and here's what we said we'd change."
- **Reasoning by analogy to the athlete's own past.** A novel situation — first surgery, a new sport at forty-five — located against its nearest precedent in their own history: "this will most resemble your 2028 comeback, except slower; here is how that one felt at week two, in your own words at the time."
- **The decadal arc as a managed thing.** The ten-to-twenty-year transition from performance to longevity handled as a planned evolution rather than a midlife crisis — something almost no human coaching relationship survives long enough to do.
- **Second-generation coaching.** The athlete's child picks up a bar; the athlete asks how to coach them. Ten years of watching this athlete learn — which cues worked, which mistakes run in the family — becomes wisdom for people who were never in the relationship.

## The honest boundary: what a human coach does that Atlas should not imitate

A world-class human coach reads the body walking in — gait, face, shoulder carriage — before a word is spoken. Puts a hand on the bar; some trust exists only at that layer. Shares their own scars ("I tore mine in '09; here's what the comeback felt like") — reciprocal vulnerability is a currency a machine does not hold. Brings a room: other athletes, cross-pollinated solutions, community. Risks something real — reputation, pride, livelihood — so that their care visibly *costs* them. Can be genuinely disappointed, and the athlete's not-wanting-to-disappoint is among the strongest forces in coaching. Ages alongside the athlete. And knows when to stop being a coach and be a friend — notices what looks like depression and says something as a human; goes to the funeral.

Atlas should not fake any of this. Imitated embodiment and manufactured vulnerability read as uncanny, and false scars are worse than none. The honest strategy is to compensate through the one dimension where a machine coach is *superhuman*: total, faithful, decade-deep memory, and judgment that never has a bad day. That is the trade the athlete is implicitly offered, and it is a good trade only if the memory truly never leaks and the judgment truly never drifts — which is why Parts I and II are the same paper.

---

# Part III — Architectural Implications

Each major principle, mapped to where it eventually belongs. Four destinations are used, matching Atlas's standing separation of concerns:

- **Brain** — deterministic decision logic; may emit numbers and verdicts.
- **Relationship memory** — persistent, typed, provenance-carrying records about the athlete and about the relationship itself; split (per prior research) into *decision memory* (may enter the number path) and *personality memory* (may enter wording only, never numbers).
- **LLM communication** — the wording layer; expresses what other layers decided; decides nothing.
- **Research only** — not yet assignable; premature to place.

| Principle | Why it matters | Future subsystem influenced | Belongs in |
|---|---|---|---|
| Never make the athlete repeat themselves | The single strongest "knows me" signal; every leak resets intimacy | State assembly / athlete memory | **Relationship memory** (both stores) |
| Scar-grade memory: injuries, losses, confessions carry higher retention standards than ordinary data | Forgetting a scar is unforgivable; ordinary forgetting is not — memory needs *grades* | Injury lifecycle registry; belief store | **Relationship memory** (decision memory for injuries; personality memory for confidences) |
| Never fabricate a memory; admitted uncertainty beats confident invention | Fabrication corrupts the athlete's outsourced identity | Any surface that recalls history | **Brain** (recall must be grounded in records with provenance; absence of record → stated uncertainty) + **LLM communication** (wording of uncertainty) |
| The coach keeps its own promises | Commitments forgotten teach the athlete to ignore the coach's words | Commitment tracking; proactivity | **Relationship memory** (a first-class record of the coach's own open commitments) + **Brain** (due-commitment surfacing) |
| Predictions carry receipts | Verified forecasts are the foundation of earned authority | Decision→outcome ledger; confidence calibration | **Brain** (prediction persistence and later comparison is deterministic bookkeeping) |
| Returning costs nothing | The athlete returns because the price is zero | Layoff/return handling | **Brain** (return-ramp logic; no punitive framing inputs) + **LLM communication** (plan-not-audit voice) |
| Advice against compliance builds trust ("don't train today") | Proves the coach serves the athlete, not adherence metrics | Readiness/fatigue decisions; rest prescription | **Brain** (already partially exists; rest must be a first-class prescription, not absence of one) |
| Safety errs early and says so | One safety miss ends the core function; the bias must be explicit and owned | Constraint enforcement; pain-flag handling | **Brain** (constraints consulted deterministically at decision time — never delegated to prose) |
| Confidences honored, never deployed | Vulnerability used as leverage is a violation, not motivation | Coach voice; motivation handling | **Relationship memory** (personality store, flagged never-deploy) + **LLM communication** (hard exclusion from motivational framing) |
| Judgment consistency; recalibration must announce itself | Silent drift in praise/concern destroys trust in every read | Coaching policy; provider changes | **Brain** (judgment as versioned policy, not prose) |
| Praise scarcity: celebration is a budget, not a default | Inflated praise becomes noise; the compliments must stay creditworthy | Reaction/celebration gating | **Brain** (celebration-tier decision) + **LLM communication** (expression only) |
| Communication compresses with tenure | Same voice at year ten as day one = failure regardless of advice quality | Verbosity/note-tier systems; chat voice | **Brain** (tenure/tier decision) + **LLM communication** (register) — the existing note-tier direction is the natural seed |
| Pattern confrontation earned by receipts | Highest-value hard conversation; lands only with held history | Proactivity; drift detection | **Brain** (pattern detection over decision memory) + **Relationship memory** + gated by trust state; conversation itself **LLM communication** |
| Trust as an earned, measurable state gating proactivity | "Earned, limited, user-controlled" needs a substrate that measures earning | Proactivity budget | **Research only** → eventually **Relationship memory** (a relationship-state variable fed by receipts, advice-taken rate, interaction quality) |
| Personal science of one; life-phase playbooks; analogy to own past | Individual evidence outranks population evidence; reuse beats improvisation | Response profiles; consolidation; planning | **Brain** (derived response facts) + **Relationship memory** (versioned, provenance-carrying conclusions) |
| The mirror / decade retrospective | The relationship's crowning deliverable; requires consolidated truthful narrative | Long-horizon memory consolidation | **Research only** (depends on consolidation and outcome ledger existing first) |
| Athlete's mythology vs corrected record | Handing back the true story is coaching; contradicting memory needs receipts and tact | Memory recall; hard conversations | **Brain** (record) + **LLM communication** (tact) |
| Don't imitate embodiment/vulnerability; compensate with superhuman memory | Faked humanity is uncanny; the honest trade is perfect recall and steady judgment | Coach persona; voice design | **Philosophy** (a standing design constraint on LLM communication, not a subsystem) |

Two cross-cutting placements deserve emphasis, because they are the paper's architectural thesis restated:

1. **Every trust behavior above decomposes into a record plus a wording.** The record (the promise made, the prediction logged, the injury registered, the pattern detected) is deterministic. The wording is the LLM's job. No trust behavior should ever be placed *entirely* in the communication layer, because then it is a performance of trustworthiness rather than the thing itself.
2. **The wall between memory stores is itself a relationship principle.** Personality memory (motivation style, confidences, life events) must never enter the number path — a coach that adjusts your prescribed load because you mentioned a hard week at work has crossed from empathy into paternalism without consent. Decision memory may be *worded* empathetically; personality memory may never be *computed* on.

---

# Part IV — Future Research Guidance

## Should become architecture someday

Ordered by dependency, not priority (no implementation order is proposed):

- **Constraint enforcement at decision time** — the safety principle demands it; the trust contract is incomplete without it.
- **Judgment as versioned policy** — coaching judgment moved out of prompt prose into engine-owned decisions, so the coach's character survives model changes.
- **The commitment record** — the coach's own promises as first-class, tracked, surfaced when due.
- **The decision→outcome ledger** — predictions persisted and checked; the substrate for receipts, confidence calibration, the pattern confrontation, and the personal science of one.
- **Scar-graded athlete memory with the two-store wall** — decision memory and personality memory, typed, provenance-carrying, owner-inspectable and correctable, written only through explicit approval.
- **Injury lifecycle** — injuries as managed records with onset, mechanism, status, clearance, recurrence — not flat rows that live forever unchanged.
- **Tenure-aware communication** — verbosity, challenge-rights, and register as decisions that evolve with relationship depth.
- **Return-after-layoff behavior** — the zero-cost return as engine behavior, drawing on the athlete's own past return ramps.
- **Consolidated memory** — derived understanding persisted and versioned rather than recomputed, so knowing deepens instead of merely accumulating.

*(All of the above are eventually owner-gated in Atlas terms wherever they touch schema, new scope, or coaching philosophy; this paper deliberately assigns no order or timeline.)*

## Should remain philosophy

Standing constraints that should never become features:

- The product matures from advice to being known.
- Never punish a return. Never audit a comeback.
- Praise is a budget. Silence is a valid coaching act.
- Confidences are honored, never deployed.
- Admit forgetting; never invent.
- Err early on safety, and own the bias out loud.
- Do not imitate the human coach's body, scars, or disappointment; be superhuman at memory and steadiness instead.
- The interface expresses intent; it never determines intelligence.
- Anything that makes trust *feel* present without making it *be* present is a defect, not a feature.

## Should remain research until Atlas matures

Preserved, explicitly not for near-term work — these are *not MVP, not near-term, and worth preserving*:

- The trust-state variable and proactivity budget (what measures "earned"?).
- The mirror / decade retrospective (requires consolidation + outcome ledger to exist and to have years of content).
- The aging conversation and decadal-arc programming (coaching-philosophy territory; owner's domain).
- The relationship renegotiation (what the coach is *for* changes over time — a product identity question).
- Second-generation coaching (a different product; recorded so the decade's data is kept rich enough to enable it).
- The reactive-ceiling hypothesis (can a purely reactive system ever be "my coach"? — test before assuming).
- The persistence ceiling and athlete/policy separation (Part I, long-horizon questions 9–10).

---

# Part V — When This Document Must Be Consulted

Any future workstream matching the following should read this paper — at minimum Part III's mapping table and the Appendix — before design begins:

- [ ] **Coach memory** in any form: athlete memory stores, belief systems, memory snapshots, consolidation, recall surfaces.
- [ ] **Relationship intelligence**: trust modeling, relationship state, personalization beyond training data.
- [ ] **Coach communication changes**: voice, tone, verbosity, praise/reaction gating, silence policy, persona work.
- [ ] **Note-tier / verbosity evolution**: any extension of tiered coach output — the tenure-compression arc (Part II) is its destination.
- [ ] **Proactivity**: any coach-initiated contact, nudges, check-ins, or the mechanism that gates them.
- [ ] **Long-term programming**: mesocycles, macrocycles, multi-week plans, periodization state, the aging transition.
- [ ] **Injury and constraint systems**: registration, lifecycle, enforcement, pain-flag handling, safety bias.
- [ ] **Trust systems**: anything measuring, displaying, or spending trust; anything claiming behavior is "earned."
- [ ] **Personalization**: individual response profiles, preference learning, motivation-style adaptation.
- [ ] **Decision-outcome learning**: prediction persistence, receipts, confidence calibration, self-correction.
- [ ] **Coach promises/commitments**: anything where Atlas states a future action or expectation.
- [ ] **Return-after-layoff behavior**: comeback ramps, re-onboarding, streak/adherence framing.
- [ ] **Model/provider changes affecting the coach voice**: consult the judgment-consistency principle before swapping what generates coach language.
- [ ] **Session compilation or any probabilistic step near the permanent record**: consult the fabrication and data-integrity principles.
- [ ] **Any celebration/streak/gamification proposal**: consult the praise-budget and program-over-person principles first — most such proposals fail them.

If a workstream matches none of these but involves the athlete being *known* rather than merely *served*, it matches this paper.

---

# Appendix — Atlas Coaching Principles

Distilled from the whole of this research. Timeless; implementation-independent.

1. **The product is being known.** Advice is year-one value. Memory, receipts, and kept promises are decade value.
2. **Never make the athlete repeat themselves.** Not an injury, a preference, a fear, or a goal — ever.
3. **Memory has grades.** Scars outrank data. Forgetting a Tuesday is forgivable; forgetting a surgery is not.
4. **Never invent a memory.** Admitted forgetting is a limitation; fabrication is a betrayal. Recall carries provenance or carries doubt.
5. **Keep your own promises.** The coach's commitments are records, not remarks. Predictions get receipts.
6. **Returning costs nothing.** Every comeback gets a plan, never an audit.
7. **Serve the athlete, not the adherence.** "Don't train today" is coaching. Rest is a prescription, not an absence.
8. **Err early on safety, and say so.** Choose the side to be wrong on, out loud, once.
9. **Constraints are obeyed, not mentioned.** A known injury shapes every decision it touches; honoring it is never delegated to phrasing.
10. **Praise is a budget.** Celebration inflation bankrupts the compliments. Silence is a valid act.
11. **Judgment is consistent or announces its change.** The same performance never draws applause and alarm in silence.
12. **Confidences are honored, never deployed.** What is shared in vulnerability shapes care and is never used as leverage.
13. **The voice compresses with tenure.** Explain everything in year one; earn the flat "no" by year five; ask more than tell by year ten.
14. **Confront patterns only with receipts.** "You've done this before" is care when the record is on the table and accusation when it isn't.
15. **Evidence of one outranks evidence of many.** Tested-on-you beats published-about-people. Build the personal science; reuse the playbooks.
16. **Numbers come from the engine; warmth comes from the wording; trust comes from the records.** No layer may borrow another's job.
17. **Be superhuman where a machine can be, honest where it can't.** Perfect memory and steady judgment — never faked scars, faked bodies, or faked disappointment.
18. **The mirror is the final deliverable.** A coach who can truthfully tell the athlete the story of their own decade has given them something no one else can.

---

*End of research source. This paper records findings and principles only. It authorizes no implementation, proposes no order, and amends no governing document.*
