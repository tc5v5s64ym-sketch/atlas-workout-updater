# Atlas Soul Corpus V2 — Section F Gap Reconciliation

> **Reference input — a mapping, not a plan. It selects and sequences nothing.**
>
> This document reconciles **Section F** ("Missing-Capabilities Gap Analysis") of
> [`ATLAS_SOUL_CORPUS_V2_SYNTHESIS.md`](./ATLAS_SOUL_CORPUS_V2_SYNTHESIS.md) against the
> single active campaign in
> [`docs/ATLAS_V1_EXECUTION_PLAN.md`](../ATLAS_V1_EXECUTION_PLAN.md). Each Section-F gap is
> mapped to the campaign **phase that already owns it**; the genuinely new items are filed
> as `BACKLOG.md` intake. **No new roadmap is created and no phase is resequenced.** The
> execution plan remains the sole work-selection authority; if this mapping and the plan
> ever disagree, the plan governs.
>
> Recorded 2026-07-22 (Atlas Recovery Campaign, Phase 3 owner side-instrument insertion).

## Why this exists

The synthesis explicitly says Section F "is an input to that process, not an override of
it," and that "Claude Code should verify each item against the repo before treating it as
missing." This file is that verification: for every Section-F item we name the campaign
phase (and finding, where one exists) that already carries the work, or — for the handful
of capabilities no phase yet scopes — we record a `BACKLOG.md` intake line so the
discovery is not lost. It authorizes nothing.

## Stale-reference note (required by the owner)

Section 5 and the closing line of Section F defer sequencing to "`BACKLOG.md` /
`ACTIVE_ROADMAP.md`." **That `ACTIVE_ROADMAP.md` reference is stale.** The active roadmap
was retired to a compatibility pointer — `docs/ACTIVE_ROADMAP.md` now reads *"Do not select
work from this filename"* — and the single canonical work-selection authority is
`docs/ATLAS_V1_EXECUTION_PLAN.md` (see `docs/DOCS_INDEX.md`). Read every "sequencing belongs
to …" sentence in the synthesis as **"sequencing belongs to the execution plan; open intake
is recorded in `BACKLOG.md`."**

## The owner's load-bearing mapping

Section F item 1 — the **reason-packet emitter** — is described as "not yet a described
component." It is: it is the **CoachTurnPacket**, already built and assembled **in shadow**
in Phase 3 (`services/coachTurnPacket.js` + `services/coachTurnPacketShadow.js`, keyed to
the minted turn id; H-03/H-14). Phase 4 makes the live route **consume** it. The corpus's
"load-bearing mechanism of every annotation" already exists as shadow infrastructure; it is
not missing, it is mid-convergence.

## Reconciliation table

Verdict legend: **COVERED** = an existing phase/finding already owns it (no new intake);
**NEW → BACKLOG** = no phase scopes it, filed as intake this PR; **EXTENSION** = folds into a
covered phase as added scope (noted here, no separate roadmap); **OUT OF SCOPE** = excluded
by the synthesis and by `CLAUDE.md` "What not to build during the V1 campaign."

| Section-F item | Campaign owner (phase · finding) | Verdict |
|---|---|---|
| **1. Reason-packet emitter** | Phase 3 built the CoachTurnPacket in shadow; Phase 4 consumes it · H-03/H-14 | **COVERED** |
| **2. Comparable-session selector** | Nearest owners: Phase 4 (WorkoutSession/history in the packet) + Phase 6 (validity guards). The selector itself (nearest rep/RIR band, same fresh/fatigued context class) is unscoped | **NEW → BACKLOG** |
| **3. e1RM standardization** (single engine method) | "Engine owns numbers" (Decision Kernel); Phase 4 packet-owned numbers. Single-method e1RM as an engine-correctness rule is unscoped | **NEW → BACKLOG** |
| **4. Athlete profile & memory injection** | Profile/context: Phase 2 (AthleteContext ratified) + Phase 4 (packet embeds athlete) + Phase 5e (plumb level/equipment/readiness) · H-07. The **durable memory store** (armed flags, sensitivities, preference notes carried across sessions) is broader than H-07 context plumbing and unscoped | **COVERED** (profile) + **NEW → BACKLOG** (memory store) |
| **5. Readiness intake** | Phase 5e: "plumb … readiness from their defined sources; close Issue #914" | **COVERED** |
| **6. Weekly volume ledger** | A `volume` module is manifested (inputs not yet available); the weekly hard-sets-per-muscle ledger with category-aware skips + target bands + surplus redirect is unscoped as a coaching capability | **NEW → BACKLOG** |
| **7. Substitution-compatibility & increment tables** | Substitution exists (`docs/SUBSTITUTION_SPEC.md`, route surfaces swaps); identity registry is Phase 5b · H-11. The **increment + per-gym equipment-granularity tables as engine data** are partly unscoped | **COVERED** (substitution) + **EXTENSION** of Phase 5b (increment tables noted) |
| **8. Working-weight-finder mode** | Onboarding finder exists (`docs/ONBOARDING_WORKING_WEIGHT_SPEC.md`). The **in-session finder sub-state** (criterion, overshoot policing, mid-session baseline write) is unscoped | **NEW → BACKLOG** |
| **9. Session-state repair / conversational correction** | Shipping: disputed-lift correction routing (`services/coachResponseGrounding.js`, `coachDiscussionReferent.js`, PR #1128); Phase 4 promotes the discussion referent to a packet field (plan PUNCH LIST). Re-derivation + changed-vs-held narration folds into Phase 4 | **COVERED** |
| **10. Post-response validator** | InteractionTrace has a `validator_result` stage (Phase 3 shadow); Phase 4 enforces the session-priority invariant; Phase 6 validator gates science-bearing claims. "No packet fact, no claim" is the Phase 4 + Phase 6 validator | **COVERED** |
| **11. Signal flags for emotion/adherence** | Engine-side detection of gap length, truncation cause, sentiment cues, sensitivity matches (so strategy selection isn't model improvisation) is unscoped by any phase | **NEW → BACKLOG** |
| **12. Evidence quarantine & armed-item scheduler** | Phase 4 lists "armed items" in the packet, but the **quarantine** (readiness-limited exclusion from progression evidence) + the **armed-item scheduler** (booked tests resurfacing on schedule) as engine state is unscoped | **NEW → BACKLOG** |
| **13. Progression rules — counter transparency + restart/re-entry variants** | Phase 4 embeds progression counters/verdicts in the packet (the "2 of 3" transparency); restart/re-entry ramp variants extend the existing progression engine | **EXTENSION** of Phase 4 |
| **14. Confirmation-card variants** (finder/correction/truncation/revised-remainder) | Cards exist; new variants are client/UX scope under Phase 5g (hygiene) + Phase 7 (prove the product) | **EXTENSION** of Phase 5g/7 |
| **15. Knowledge docs (12-doc inventory)** | Phase 6: "convert `docs/research/coaching-intelligence` into versioned knowledge records" — the whole Section-B inventory | **COVERED** |
| **16. Persona testing (10 Part II cards as fixtures)** | Phase 7: "all Soul corpus sessions as meaning-based acceptance tests; varied synthetic athletes." The **Corpus Baseline Runner** (this side-instrument) is the first concrete step | **COVERED** |
| **Out of scope:** multi-athlete accounts; wearable-driven prescription; any medical reasoning | Matches `CLAUDE.md` "What not to build during the V1 campaign" | **OUT OF SCOPE** |

## Genuinely new items filed as BACKLOG intake (this PR)

No phase scopes these; each is recorded as a one-line `BACKLOG.md` intake item under a
2026-07-22 "Soul Corpus V2 — Section F reconciliation" cluster, cross-referencing this file.
They are **intake, not a queue** — the execution plan still decides if and when any is built.

1. **Comparable-session selector** — nearest rep/RIR band + same fresh/fatigued context class, with validity guards `[correctness]`.
2. **e1RM single-method standardization** — one engine method (reps+RIR → %1RM), retire any coexisting rep-only figure `[trust-critical]`.
3. **Durable athlete-memory store** — armed flags, sensitivities, preference notes carried across sessions (beyond H-07 context plumbing) `[correctness]`.
4. **Weekly volume ledger** — hard sets/muscle/week vs. target band, category-aware skip accounting, surplus redirect `[correctness]`.
5. **In-session working-weight-finder sub-state** — criterion, overshoot policing, mid-session baseline write `[correctness]`.
6. **Emotion/adherence signal flags** — engine-side detection (gap length, truncation cause, sentiment cues, sensitivity matches) `[correctness]`.
7. **Evidence quarantine + armed-item scheduler** — readiness-limited exclusion from progression evidence; booked future tests resurfacing on schedule `[correctness]`.

The behavioral baseline for all of the above — how much the *current* read-only code already
does before those items land — is measured by the **Corpus Baseline Runner** and published in
[`docs/verification/CORPUS_BASELINE_SCOREBOARD.md`](../verification/CORPUS_BASELINE_SCOREBOARD.md),
which re-scores at the close of Phases 4, 6, and 7.
