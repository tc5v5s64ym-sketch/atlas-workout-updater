# Phase 4 — Owner-gate readiness handoff (2026-07-24)

**Status:** Phase 4 ("The canonical proof") — all technically-derivable read/decision-consumption work
that can be landed WITHOUT crossing the owner gate is complete and staged. The gate has **not** been
crossed. No production flag was changed; `SESSION_PLAN_SETS_WRITE_ENABLED` remained `0` throughout.

This document is the readiness statement for the Phase-4 owner gate. It is descriptive only — it
enables no flag, runs no live write, and makes no product decision.

## 1. Exact state

- **Merged `main` SHA at handoff:** `fe51334` (`fe51334eba4ebd413ef8e3ac5fafb29cd94239a1`) — the head
  after the run's code PRs (#1157–#1161) merged. This handoff document lands on top of it.
- **Base at run start:** `024a6fe` (origin/main).

## 2. PRs merged during this run (all `auto-safe`, all green on merge)

| PR | Concern | Files (core) |
|---|---|---|
| #1157 | Fix byte-identity of the recommendation-explanation decision path (retrospective review of #1154–#1156) | `coachDecisionSnapshot.js`, `coachOps.js` |
| #1158 | Enrich the canonical **recovery** decision with the recovery-reason facts (arc PR 1) | `recoveryRouting.js`, `coachDecisionSnapshot.js`, `coachOps.js` |
| #1159 | Shared recovery worder + canonical-decision bridge, byte-identical (arc PR 2) | `recoveryRouting.js` |
| #1160 | The live route **consumes** the canonical recovery decision at both reply sites (arc PR 3) | `coachOps.js` |
| #1161 | Drift Guard 5 exercises a non-null `packet.decision` embed (Step 3) | `check-packet-trace.js`, `packetTraceGuard.test.js` |
| this PR | This handoff document | `docs/verification/PHASE_4_OWNER_GATE_HANDOFF.md` |

## 3. Review findings and dispositions

- **Retrospective review of #1154–#1156 (the H-03 recommendation-explanation arc)** — an independent
  adversarial review closing the missed advisory loop. Verified: `explanation_inputs` completeness,
  canonical-decision validation (always valid-or-null), both reply sites, flag-off verbatim / flag-on
  canonical, packet/trace honesty, zero Sheet appends, no mutation surface, no completion-ladder overclaim —
  **all hold**.
  - **P2 (real, fixed in #1157):** the byte-identical flag-on↔flag-off invariant was over-claimed —
    `buildRecommendationSnapshot` leaves `target.name` raw while `_explanationInputsFrom` trimmed it, so a
    `current_plan` lift name with surrounding whitespace diverged (or lost the reply for a whitespace-only
    name). Fixed by carrying the raw `target_name` (preserving flag-off byte-for-byte) + failing the helper
    closed to the snapshot path. Latent only (flag default-off), so no production impact.
  - **P3 (fixed in #1157):** the helper's fail-closed fallback was dead for a valid-but-unwordable decision.
- **Codex #1161 P2 (real, fixed in #1161 @ `9d10d1a`):** the new valid-decision guard case never asserted the
  decision actually embedded — an underclaim-safe blind spot. Fixed with an `expect.decision` embed/drop
  expectation on the controlled matrix inputs + a direct assembler self-test.

## 4. Test and guard totals (at handoff)

- Full suite: **6468 tests, 0 fail** (`npm test`).
- Drift guards 1–6 all green: authority, banned-pattern, wiring-allowlist ratchet (8/8), completion-ladder,
  packet-trace (8 assemblies, now with decision embed/drop assertions), paper-weight.
- Secret scan clean; syntax check clean.

## 5. What is genuinely route-consumed vs shadow-only

**Live-consumed behind `ATLAS_TURN_PRECEDENCE` (default OFF — inert in production today):**
- The **recommendation-explanation** reply (`progress_readout` decision) — both reply sites.
- The **recovery-routing** reply (`recovery` decision) — both reply sites.
- Both are PROVEN byte-identical to their pre-existing (flag-off) path; flag-off is verbatim.

**Shadow-only (assembled in the `[coach-turn-shadow]` stream, not yet read by the live reply):**
- The full CoachTurnPacket / InteractionTrace (Phase 3).
- `packet.session` (H-08A) and the answer-time `discussion_referent` on the packet session (D10 shadow-first).
- The canonical decision on turns other than the two consumed above.

**Completion ladder:** NO capability is promoted to `route_consumed` or `live_proven`. Because the two live
consumptions are flag-gated and default-off, the ladder stays at the lower rung (the "assign the lower rung
when ambiguous" rule). Promotion to `live_proven` requires real owner/live evidence at the gate — not done.

## 6. Remaining divergence items (from the Phase-3 report), by owner

- **D2 / D9 (session / spine):** the deterministic state-answer pair ("what's next?", "are we done?") consumes
  the canonical `WorkoutSession` (H-08B/C). Broader session consumption of the *current-lift* lanes
  (`answerCurrentExercisePrescription` / `answerPlannedLiftQuestion`) is **byte-identity-blocked**:
  `currentLiftFromContext` resolves from `current_preview` + `plan_completed`, inputs the canonical session
  snapshot does not carry, so migrating to `currentSlot` would change which lift resolves. Deferred (would
  need a product decision to change that resolution).
- **D10 (discussion referent):** the answer-time referent is carried on the packet session (shadow). Retiring
  the in-memory store + history scan needs **cross-turn** referent persistence (a client-protocol round-trip),
  not a small server-only change. Deferred.
- **Other decision types** (`workout` / `progression` / `substitution` / `onboarding` / `nutrition`): NOT
  read-only (they change the plan / write); `progress_query`→`progress_readout` is LLM-owned (no deterministic
  reply to consume); a factual-dispute→`decision_type` mapping is a manifest/product judgment. These are
  genuine stop conditions (byte-identity / product-judgment), not derivable server-only seams.
- **D11 / D12 / D13:** ExerciseIdentity (Phase 5b), SafetyDecision (Phase 5d), knowledge_retrieval (Phase 6).

## 7. Production safety at handoff

- Production behavior is **unchanged with flags off** — every consumption seam is flag-gated
  (`ATLAS_TURN_PRECEDENCE`) and default-inert, and byte-identical to the prior path when on (proven by tests).
- `SESSION_PLAN_SETS_WRITE_ENABLED` is **`0`** (code default; never changed this run). Every planned-set
  checkpoint / seal is a dry-run returning the W1–W3 proof (`sheet_written:false`, `no_write_confirmed:true`,
  `dry_run:true`, `reason:'write_disabled'`) — verified by `test/sessionPlanSetsStore.test.js`.
- No new production write path, no proof-field change, no schema change, no `preview→approve→write` change.

## 8. The Phase-4 owner gate — exact action required next (OWNER-RESERVED; not performed here)

The gate is owner-reserved. The plan's gate script, in two steps:

- **(a)** *"Everything is staged. Set `SESSION_PLAN_SETS_WRITE_ENABLED=1` on Render, then say go."*
- **(b)** after the gate workout: *"Tell me: pass or not yet; what held up or didn't in the transcript and
  trace; and your Issue #952 ruling — close, supersede, or rewrite."*

**Exact Render environment changes the owner would make at the gate:**
- `ATLAS_TURN_PRECEDENCE=1` — turns on the staged live packet-consumption (the canonical proof: the route
  reads `packet.decision` for the recommendation-explanation and recovery replies; byte-identical to today).
- `SESSION_PLAN_SETS_WRITE_ENABLED=1` — enables planned-set capture end-to-end (the Golden Session write).
- `ATLAS_INTERACTION_TRACE=shadow` should remain set (from Phase 3) so the packet/trace is logged for review.

## 9. Exact live-validation sequence (the Golden Session)

Reusable fixture: `test/fixtures/goldenSession.js` (scripted two-exercise workout). Beats:
plan-from-history → accept → log ex1 routine (×2, silence) → ask "why?" → log ex2 opening set (silence) →
redline top set (safety surfaces) → fatigue substitution (acknowledged) → revise → close out once → seal →
reload → review. The owner runs this as a normal session and reports pass / not-yet per gate script (b).

**Done-when:** the Golden Session passes with the owner satisfied, and one reviewable trace spans first word
to sealed write.

## 10. Exact rollback

- Set `ATLAS_TURN_PRECEDENCE` back to unset/`0` → the live route reverts to the byte-identical signals/snapshot
  path (no code change needed; the flag is the only surface).
- Set `SESSION_PLAN_SETS_WRITE_ENABLED=0` → every planned-set checkpoint/seal returns to dry-run (no write).
- Both are pure environment toggles; no deploy or revert is required to roll back.

## 11. What evidence would permit Phase 4 to advance

- The owner's **pass** on a live Golden Session (gate script b), and
- one reviewable end-to-end **trace** spanning first word → sealed write (packet + trace share one turn id),
- confirming planned-vs-actual capture (H-09) and no silent write.

Only that real owner/live evidence promotes the two consumed capabilities toward `live_proven` and closes
H-03/H-08/H-09/H-16/H-18. Until then the ladder stays honest and the flags stay off.
