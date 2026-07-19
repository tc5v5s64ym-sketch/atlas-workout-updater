> **Reference input — the executable truth is the campaign embedded in the execution plan.**
>
> This file preserves the owner-provided Atlas Recovery Campaign specification verbatim as
> source material. It does **not** select or sequence work. The single active, executable
> campaign lives inside [`docs/ATLAS_V1_EXECUTION_PLAN.md`](../ATLAS_V1_EXECUTION_PLAN.md); if
> this reference and the plan ever diverge, the plan governs. Recorded 2026-07-19.

---

# CAMPAIGN SPECIFICATION — ATLAS RECOVERY CAMPAIGN

Purpose: implement the 23 verified findings of the Complete System Health Report through convergence — one session, one decision, one packet, one trace — without a rewrite. If anything in this specification ever conflicts with CLAUDE.md safety rules or the preview→approve→write trust loop, the safety rule wins and the agent stops to ask.

## THE FIVE RULES

1. Green checks merge themselves. No owner merge approvals, ever. Owner involvement is gates only.
2. The freeze holds. Phases 2–7 do not start until the Phase 1 owner gate passes.
3. One authority. This spec is reference input; the executable truth is the campaign inside `docs/ATLAS_V1_EXECUTION_PLAN.md`. No second roadmap may ever be created.
4. The trust loop is untouchable. Preview→approve→write, no silent writes, owner gates for anything touching live data.
5. Drift guards are grow-only. A guard, once added, is never removed or weakened without an owner instruction recorded in the plan.

## THE GOLDEN SESSION (defined once, used three times)

One scripted two-exercise workout: plan from history → accept → log normally → human reply or deliberate silence → ask why → fatigue or substitution → revise → close out once → seal → reload → review. It is the Phase 1 gate (does it feel like a coach?), the Phase 4 gate (does it run through one packet and one trace?), and a permanent Phase 7 regression test.

## CAMPAIGN STATE TRACKER (lives in the execution plan; updated in every campaign PR)

`CAMPAIGN STATE: Phase <n> — <name>. Next step: <step>. Gates passed: <list>. Streak: <k>/5.`

---

## PHASE 1 — SOUL RECOVERY (Issue #1073, exactly as written)

GOAL: the workout conversation feels like a knowledgeable, history-aware human coach; the receipt dies.
WORK: (1) the required recovery audit — map every live workout voice path from user input to rendered output (plan/acceptance, set and exercise logging, routine reaction, deviation/PR/fatigue/substitution/pain/safety, in-session question and correction, next-exercise handoff, closeout), recording for each the facts assembled, whether the model is called, which persona/prompt is used, any deterministic prose that can override it, available conversation history, and the production output; publish it. (2) The first implementation slice exactly as the issue defines: remove "On plan — logged." from the normal path; a routine block gets either a brief, fact-grounded, model-authored reply or deliberate silence chosen from session state; bounded context; honest outage degradation; templates outage-only. (3) Deterministic and contract tests; the ten golden conversation transcripts scored on behavior, not wording; define the Golden Session as a reusable scripted scenario.
OWNER GATE — gate script: "Ready for a Soul gate workout: two exercises, normal session. Afterward tell me: pass or not yet; the moments that felt like a coach; the moments that broke character (quote the reply, then what a real coach would have said, or whether silence was right)." On "not yet," fix the named misses, rerun the transcripts, and offer another gate. On "pass," mark the gate, then begin Phase 2.
DONE WHEN: the owner says pass after live sessions.
CLOSES: H-02; first bite of H-16.

## PHASE 2 — INVENTORY, CONTRACTS, AND CLEAN PAPER (no behavior changes)

WORK: (1) Extend `scripts/check-wired-modules.js` from file reachability to semantic reachability (does output affect a user-visible decision?) and publish one ownership/connectivity inventory covering every route, service, client module, flag, Sheet tab, and planning document, with a keep/adapt/retire column. (2) Ratify eight canonical contracts as versioned schemas with docs: WorkoutSession, AthleteContext, ExerciseIdentity, CoachingDecision, CoachTurnPacket, SafetyDecision, CloseoutTransaction, InteractionTrace. (3) Replace the capability manifest's single status with completion-ladder fields: built, unit-tested, runner-wired, inputs-available, route-consumed, user-visible, validator-covered, live-proven, owner-accepted. (4) Paper hygiene: shipped items from BACKLOG.md to the archive; an open-P0/P1 index at the top; current-as-of dates and historical banners on active docs; adopt the app.js freeze rule (no new session-state logic in app.js); label closeout reconstruction "recovery-only — verify every row." (5) Build Drift Guards 1, 2, 3, 4, and 6 (below).
OWNER GATE: none.
DONE WHEN: contracts merged, inventory published, backlog index exists, manifest speaks ladder, guards red/green in CI.
CLOSES: H-05, H-15, H-22; advances H-07, H-17, H-20, H-21.

## PHASE 3 — SHADOW THE PACKET AND THE TRACE (zero behavior change)

WORK: mint one turn ID at the first trusted boundary and carry it through parser result, intent, session snapshot, engine decision, knowledge retrieval, coaching strategy, model response, validator result, rendered output, and write proof. Assemble the full CoachTurnPacket for every real turn in shadow; log packet and visible response side by side; produce a nightly divergence report listing every place production contradicted or bypassed packet truth.
OWNER GATE — gate script: "Shadow is live and invisible. Train normally for about a week; I'll publish the divergence summary when the data is stable." (Informational stop only; resume on any owner go-ahead.)
DONE WHEN: the packet assembles for essentially every turn across several real sessions and the divergence list is stable and understood.
CLOSES: H-14; sets up H-03.

## PHASE 4 — THE CANONICAL PROOF

WORK: behind a flag, make the live coach route consume the CoachTurnPacket, retiring route-local recomputation as the divergence list clears. Deterministic fallbacks so every state-answerable question (e.g. "what's next?") answers from the WorkoutSession even with the model down. Enforce the session-priority invariant with the collision-phrase pack: exact historical phrases, paraphrases, model up and down. Build Drift Guard 5. Prepare the Golden Session live run with planned-set capture end to end.
OWNER GATE — gate script, in two steps: (a) "Everything is staged. Set SESSION_PLAN_SETS_WRITE_ENABLED=1 on Render, then say go." (b) after the gate workout: "Tell me: pass or not yet; what held up or didn't in the transcript and trace; and your Issue #952 ruling — close, supersede, or rewrite." On "not yet," fix, rerun in test, offer another gate; suggest returning the flag to 0 if unneeded meanwhile.
DONE WHEN: the Golden Session passes with the owner satisfied, and one reviewable trace spans first word to sealed write.
CLOSES: H-03, H-08, H-09, H-16, H-18.

## PHASE 5 — CONSOLIDATE AND DELETE (parallel tracks a–g)

- a. MODULE DECISION DAY. Prepare a one-card pack for each of the eight allowlisted modules in `config/wiring-allowlist.json`: what it does, what now duplicates or supersedes it, recommendation (wire / merge / reclassify as test tooling / delete) with reasoning. OWNER GATE — gate script: "Module Decision Pack is ready — reply with a ruling per module and 'proceed'." Execute rulings one PR per module until the allowlist is empty.
- b. IDENTITY RULING DAY. Prepare the pack of all 32 residual identity divergences from `docs/EXERCISE_NAME_UNIFICATION_MIGRATION_PLAN.md`, each with a proposed answer and one line of reasoning. OWNER GATE — gate script: "Identity Pack is ready — confirm my proposals or override by number, then 'proceed'." Then implement the immutable ExerciseIdentity registry; every other representation becomes an alias or projection; migrate name-keyed joins; remove duplicate naming authority.
- c. DELOAD: consolidate to the load-cut model with one DeloadLifecycle governing selection through return-to-normal; wire or delete the begin/advance/resolve endpoints; close Issues #289 and #291.
- d. SAFETY: one SafetyDecision contract consumed by the live route and the Brain alike; retire duplicate classifiers. Presentation may differ; the decision may not.
- e. LAYERED CONTEXT: session-scoped constraints with expiry ("avoid legs today") layered over durable rules; plumb training level, equipment profile, and readiness from their defined sources; close Issue #914. Finishes H-07.
- f. ONE BRAIN: publish the live decision-ownership map; per promoted decision type, delete its legacy analytics delegation. No permanent shadow or legacy lanes.
- g. HYGIENE: remove the closeout reconstruction lane once buffer capture is proven; render the completed-session pin as session state ("Session complete — 9 sets"); rename engine mode "brian" to "brain" with a dual-accept window — OWNER GATE — gate script: "Dual-accept is live. Change ATLAS_COACH_ENGINE from brian to brain on Render and say done," then retire the old string; finish the app.js extraction; land remaining doc banners.
DONE WHEN: the ownership map shows one owner per concept and the staged-module allowlist is empty.
CLOSES: H-04, H-06, H-07, H-10, H-11, H-12, H-13, H-17, H-19, H-21, H-23; finishes H-20.

## PHASE 6 — WIRE IN THE RESEARCH

WORK: convert `docs/research/coaching-intelligence` into versioned knowledge records; map reason codes and question types to records; retrieve two to six high-signal records per turn into the CoachTurnPacket; record knowledge IDs and applicability in the InteractionTrace; validator checks every science-bearing claim against retrieved records; deprecate static duplicate cards; same system for planning, live interpretation, and Q&A.
OWNER GATE: none formal — invite the owner to ask hard "why" questions in real sessions and report anything generic or wrong.
DONE WHEN: answers cite retrievable records in the trace and the validator gates the claims.

## PHASE 7 — PROVE THE WHOLE PRODUCT

WORK: full-session behavioral tests; all Soul corpus sessions as meaning-based acceptance tests; varied synthetic athletes; outage, retry, and reload tests; correction and trust-repair tests; the Golden Session as permanent regression. Open the five-session owner streak in the plan.
OWNER GATE — after each owner session, gate script: "Session verdict? 'Session N of 5: clean' or 'miss: <what happened>'." A clean session advances the streak; a miss resets it to zero and its cause becomes the next card.
DONE WHEN: the streak reaches five. Mark Atlas healthy in the execution plan and check every definition-of-healthy gate: one owner per concept; one route for intelligence; no silent capability claims; templates outage-only; complete traceability; cross-surface agreement; owner acceptance.

---

## DRIFT GUARDS (each is a CI check that fails the build; a rule that lives only in a document is not a guard; the list is grow-only and published in CLAUDE.md)

1. AUTHORITY CONSISTENCY (build in Phase 2): one declared active-campaign line must match exactly across CLAUDE.md, the execution plan, and the docs index; every open issue labeled `owner-instruction` must be referenced in the plan; otherwise CI fails.
2. BANNED-PATTERN GUARD (Phase 2; grow-only list): forbidden in production paths — normal-path receipt templates; route-local recomputation of packet-owned facts; legacy analytics imports for promoted decision types; duplicate safety classifiers; session-truth selectors outside WorkoutSession. Add each pattern as its finding is retired.
3. WIRING GUARD HARDENED (Phase 2, enforced fully after Phase 5): the allowlist becomes shrink-only; new entries require an owner-gate note; expiries fail red — never auto-extend.
4. COMPLETION-LADDER VALIDATOR (Phase 2): no capability may claim route-consumed or live-proven without a linked test or trace ID.
5. PACKET AND TRACE CONTRACT TESTS (Phases 4–5): every full-session test asserts the visible reply was produced from a schema-valid CoachTurnPacket and that one turn ID spans input through write proof.
6. PAPER-WEIGHT GUARD (Phase 2): CI fails when BACKLOG.md exceeds its size cap or contains shipped items older than seven days; an auto-archive job keeps it clean.

## THE HEARTBEAT (recurring cards, created at install)

- Monthly, and after any batch of coaching-path PRs: one owner verdict workout using the gate-verdict script. The owner's session is the one detector no agent can fake.
- Quarterly: re-run the whole-system health audit read-only and report deltas against the 23 findings. New findings enter the backlog; they never spawn a new roadmap.

## FINDINGS REFERENCE (the 23; full detail in the Complete Health Report)

H-01 conflicting execution authority (closed by this install) · H-02 routine coaching receipt bypass (P1 phase 1) · H-03 no Coach Turn Packet (3–4) · H-04 One Brain not one owner (5) · H-05 manifest overstates capability (2) · H-06 eight dark modules (5) · H-07 athlete context incomplete (2+5) · H-08 multiple current-workout truths (4) · H-09 planned-vs-actual unproven (4) · H-10 deload split (5) · H-11 five exercise identities (5) · H-12 safety multiple owners (5) · H-13 no session-only constraints (5) · H-14 telemetry islands (3) · H-15 "complete" ambiguity (2) · H-16 education outranks session (4) · H-17 closeout reconstruction lane (2+5) · H-18 outage forgets state (4) · H-19 pin mixes concepts (5) · H-20 mixed-era docs (0+2) · H-21 7,827-line app shell (2+5) · H-22 paperwork outgrew operators (2) · H-23 "brian" spelling (5).
