# Atlas V1 Execution Plan

> **Status:** CANONICAL EXECUTION AUTHORITY
> **Owner adopted:** 2026-07-15
> **Current active milestone:** ATLAS RECOVERY CAMPAIGN — Phase 4 (The canonical proof). Phase 3 (Shadow the packet and the trace) COMPLETE 2026-07-23 — closed on production evidence from Flight Recorder session FR-20260723120852-hw56ws9y; final divergence summary at `docs/verification/PHASE_3_DIVERGENCE_SUMMARY_2026-07-23.md`. Phase 2 (Inventory, contracts, and clean paper) COMPLETE 2026-07-21. Phase 1 (Soul Recovery, Issue #1073) CLOSED 2026-07-20 — the owner Soul gate PASSED, so the Phases 2–7 freeze is lifted; the recovery campaign remains the active work through Phase 7 (see the "Active campaign: Atlas Recovery Campaign" section below).
> **Rule:** Atlas has one execution plan. This document selects and sequences work until V1 is declared and the stabilization period ends. An owner instruction governs only once it is recorded here; the Atlas Recovery Campaign lives INSIDE this plan and is not a second roadmap.

## 1. Purpose

This document replaces the former active-roadmap, Soul, Soul-readiness, Post-Soul, remediation, and historical product-plan queues as execution authority.

Atlas is no longer choosing among overlapping plans. The governed path is:

> **Close Soul → harden trust seams → prove the whole product → complete five clean live sessions → declare V1 → stabilize → simplify the UI from observed use.**

The repository, not a Claude conversation, remembers campaign state. A fresh implementation session reads this file, selects the first eligible unfinished card, verifies current state, and continues from current `main`.

## 2. Authority and document roles

Read in this order for routine work:

1. `CLAUDE.md` — operating, safety, branch, review, and merge rules.
2. `docs/ATLAS_V1_EXECUTION_PLAN.md` — the sole work-selection and sequencing authority.
3. `docs/DECISION_KERNEL.md` — durable product and trust principles.
4. `BACKLOG.md` — intake/deferred ledger and supporting finding detail; **not a competing queue** while this plan has eligible work.
5. Relevant specs, invariants, tests, and evidence ledgers.

The following remain separate because they are not execution plans:

- `docs/ATLAS_PRODUCT_VISION.md` — product north star.
- `docs/CONSTITUTION.md` and `docs/INVARIANTS.md` — non-negotiable rules.
- `docs/ARCHITECTURE.md` — current system boundaries.
- `docs/TEST_QUEUE.md` — owner/live evidence ledger.
- `docs/ONE_BRAIN_PROMOTION_CRITERIA.md` — reusable evidence standard for Brain promotion.
- `docs/BUG_TRIAGE_LEDGER.md` — Bug_Reports done/open record.
- Narrow design/spec/research docs — consulted only when the active card touches their surface.

If another document appears to select or sequence work, this plan wins and the conflicting document must be corrected in the same focused governance PR.

## 3. Execution contract

Claude works this plan as a durable campaign controller.

For every implementation card:

1. Refresh and verify current `main` and deployed version where applicable.
2. Run the Current-State Verification Gate and record exactly one verdict:
   `STILL BROKEN`, `ALREADY FIXED`, `PARTIALLY FIXED`, `FIXED BUT UNTESTED`, `STALE / SUPERSEDED`, or `NEEDS OWNER APP-TEST`.
3. If already fixed, do not manufacture code. Add the missing proof/status only.
4. Create one fresh `claude/<concern>` or `agent/<concern>` branch from current `main`.
5. Implement one concern only, with the smallest safe diff and live-path or closest-integration tests.
6. Run deterministic GitHub hard gates; address Codex advisory findings that are real and in scope.
7. Merge the exact passing head under Claude's standing authority unless a genuine owner-reserved data-safety category is involved.
8. Update this card's status and merged PR/commit as part of the card's PR when practical; otherwise make the smallest immediate status-only follow-up.
9. Refresh `main` and select the next eligible unfinished card.

### Stop conditions

Stop only for:

- a real production write requiring explicit authorization;
- schema, migration, deletion, credentials, or security-sensitive infrastructure;
- a Constitution/Invariant amendment;
- genuine owner-only gym/device evidence;
- the explicit One-Brain promotion decision;
- a truly non-derivable product conflict.

Do **not** stop merely because a PR is merge-ready, a session is getting long, or the next card is in a different milestone. Repository state is the handoff.

## 4. Campaign status

| Milestone | Goal | Status | Exit condition |
|---|---|---|---|
| **M0** | Consolidate execution authority | ✅ COMPLETE in the installation PR | One canonical plan; old plan bodies retired; governance points here |
| **M1** | Close Soul honestly | ✅ COMPLETE (2026-07-16) | LT-010 required Part 1 PASS with profanity OFF; S5 and Soul recorded complete |
| **M2** | Close remaining silent-correctness risks | ⏸ SUPERSEDED by Recovery Campaign | Superseded by the Atlas Recovery Campaign (Issue #1073); the Phase 1 gate passed 2026-07-20 so the freeze is lifted, but the campaign phases (now Phase 2) take priority over resuming M2/F10E. Exit condition unchanged: F02–F10 **plus the owner-directed 2026-07-16 stabilization insertion (F09A–F09J, F10A–F10E)** complete, and no open P0/P1 silent-trust finding in these seams |
| **M3** | Prove cross-seam behavior automatically | QUEUED | F11 proving packs green in deterministic CI |
| **M4** | Prove Atlas in real use | BLOCKED on M3 | Five consecutive clean live sessions recorded |
| **M5** | Declare and stabilize V1 | BLOCKED on M4 | V1 declaration merged; minimum two-week defect-only period completed |
| **P-A** | One-Brain promotion evidence | PARALLEL / OWNER-RESERVED | Criteria met, human review complete, explicit owner decision recorded |
| **M6** | UI simplification from evidence | FUTURE / BLOCKED on M5 | Separate owner-approved plan based on observed usage, not speculation |

## ▶ Active campaign: Atlas Recovery Campaign (owner insertion, Issue #1073)

**Adopted:** 2026-07-19 · **Controlling owner insertion** · **Status: ACTIVE — Phase 4** (Phase 3 — Shadow the packet and the trace — COMPLETE 2026-07-23, closed on production evidence FR-20260723120852-hw56ws9y; Phase 2 — Inventory, contracts, and clean paper — COMPLETE 2026-07-21; Phase 1 — Soul Recovery — CLOSED 2026-07-20, owner Soul gate PASSED).

This is the single active, executable campaign. It is embedded here — not beside this plan — so the execution plan stays the sole work-selection authority. The verbatim owner specification is preserved as reference input at [`docs/reference/ATLAS_RECOVERY_CAMPAIGN_SPEC.md`](reference/ATLAS_RECOVERY_CAMPAIGN_SPEC.md); if that reference and this embedded campaign ever diverge, **this plan governs**.

**Controlling insertion (Issue #1073 — Soul Recovery).** This campaign supersedes feature progression and remains the active work through Phase 7. The Phase 1 owner gate **PASSED 2026-07-20**, so the earlier freeze on M2/F10E and unrelated work is **LIFTED** — but the recovery campaign (now in Phase 4), not the old feature progression, is what continues; the campaign phases take priority. `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0` until Phase 4 explicitly requires it, and is set only at the Phase 4 owner gate.

**Safety wins.** If anything in this campaign ever conflicts with `CLAUDE.md` safety rules or the preview→approve→write trust loop, the safety rule wins and the agent stops to ask. The trust loop is untouchable: preview→approve→write, no silent writes, owner gates for anything touching live data.

**Purpose.** Implement the 23 verified findings of the Complete System Health Report through convergence — one session, one decision, one packet, one trace — without a rewrite.

### CAMPAIGN STATE

**Current #1165 status (slice 2; supersedes the older inline `REMAINING ON #1165` / `BLOCKED` notes in the historical campaign ledger below).** Slice 2 is complete in this change: the client now creates a bounded initiation nonce before every preview, associates the server's canonical `turn_id` and pairing capability with that initiation, explicitly retires superseded initiations, and retains only the newest-initiated preview independent of response completion order. The additive `correlation` envelope is carried through manual/slash, screenshot, effort-only, modality, bodyweight, and closeout/seal-retry approvals. Missing, malformed, forged, stale, superseded, payload-mismatched, and cross-session claims fail closed in the evidence seam while the underlying write remains unchanged. The documented seal retry still mints a fresh `write_id` and may remove only the already-written `effort_row`. Pairing capabilities and payload fingerprints remain excluded from response bodies, logs, traces, and artifacts. Phase 4 remains **NOT YET**; no owner gate is authorized, `SESSION_PLAN_SETS_WRITE_ENABLED` remains `0`, and Phase 5 has not begun.

**Next eligible #1165 work — slice 3 only (recorded, not implemented by slice 2).** Build the reviewable artifact that joins `[interaction-trace]` and `[turn-write-proof]` on the existing canonical `turn_id`, including closeout/seal evidence. The consumer must treat `seal_proof_mismatch` honestly: `sheet_written:true` may coexist with `sealed_ok:false`, and that state must never be presented as a successfully sealed write. Projected evidence that was present but failed validation is currently withheld, while genuinely absent evidence is absent; if the artifact consumer needs to distinguish them, add an explicit bounded withheld marker in slice 3 rather than weakening projection validation.

`CAMPAIGN STATE: Phase 4 — The canonical proof. FIRST CONCERN ✅ LANDED 2026-07-23 (substitution lane): one authoritative current-message decision (`services/turnPrecedence.js`) now owns whether a turn requests a substitution, retiring the substitution lane's route-local `intent || isConstraintMessage` interpretation that let a malfunction complaint ("Are you broken?" → `/\bbroken\b/`) invoke substitution and contradict the active plan (Phase-3 divergence D5/D6; FR-20260723120852-hw56ws9y turn 4). FIRST-CONCERN HARDENING ✅ LANDED 2026-07-23 (ambiguous pronoun-only malfunction): the substitution decision now requires AUTHORITATIVE REFERENT EVIDENCE — an ambiguous pronoun-only malfunction ("it's broken", "is it broken?", "it is broken") no longer authorizes a swap, because its only referent is a bare pronoun that could mean Atlas OR the equipment (particularly right after an incorrect answer). The prior disambiguator vetoed only a SECOND-PERSON address ("are YOU broken?") and let the impersonal "it" through to the constraint path, producing a plan-changing swap on a guess. `decideTurnPrecedence` now treats a constraint as a substitution ONLY when a referent is authoritative — the parser recognizes a named lift/equipment (`messageNamesALift` — "the bench is broken", "the squat rack is broken") OR the subject is a concrete noun matching none of the ambiguous-pronoun tokens ("the cable machine is not working", "the rack is not working") — otherwise it fails closed to the aside lane; a genuine explicit `intent:'substitute'` still substitutes. This also CORRECTS the retired "introduces no new phrase regex" claim: the module owns ONE narrow, accurately-documented disambiguator (`AMBIGUOUS_PRONOUN_REFERENT_RE`), gated on the parser's authoritative named-lift evidence. Under-call, never fabricate — superseded when `discussion_referent` becomes a canonical CoachTurnPacket field (D10 punch list). Evidence: `test/turnPrecedence.test.js` (ambiguous-pronoun fail-closed regression + named-referent still-substitutes split) and `test/api-smoke.test.js` (real `/api/suggest-substitute` regressions — flag ON ⇒ no substitution / `turn_precedence.lane:'aside'`; flag OFF ⇒ byte-identical prior substitution and no `turn_precedence` envelope; zero Sheet writes both ways). Consumed by `/api/suggest-substitute` behind the `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ byte-identical; the owner enables it at the Phase-4 gate). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0` and no new production writes until the explicit Phase 4 owner gate. CHAT-LANE SCOPING (D3) ✅ LANDED 2026-07-23 (prescription question → active exercise only): a BARE, no-lift-named COMPOUND prescription question ("What weight and how many reps?") is now answered deterministically, SCOPED to the single active exercise from session state, before the LLM — retiring the "all-six prescription dump" (FR-20260723120852-hw56ws9y turn 1, where the same message reached Gemini with the whole `current_plan` and the model enumerated every exercise). This is the compound shape the tight `isBareSessionShorthand` gate deliberately excludes; a new `answerCurrentExercisePrescription` / `isCurrentExercisePrescriptionQuestion` (`services/sessionQuestionAnswer.js`) reuses the EXISTING `currentLiftFromContext` resolver + `targetFromContext`/engine-fill, requires ≥2 attributes or an explicit current-lift scope (so the education-ambiguous bare "what is RIR?" is never hijacked), is fully anchored to attribute tokens (so an off-topic "how much protein and how many reps?" cannot match), and defers on a named lift / history / advice framing. Consumed by `/api/coach/chat` behind the SAME `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ byte-identical, the LLM owns the turn exactly as before; the owner enables it at the Phase-4 gate). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/sessionQuestionAnswer.test.js` (scoped single-exercise answer; compound/scoped recognition; education/named-lift/history/advice deferral; ambiguous→clarify; engine-fill parity) and `test/api-smoke.test.js` (real `/api/coach/chat` regressions — flag ON ⇒ scoped answer / `source:'engine'` naming only the active lift, LLM bypassed; flag OFF ⇒ the LLM owns the turn; zero Sheet writes). CHAT-LANE RECOGNITION (D4) ✅ LANDED 2026-07-23 (warm-up question → not a set-count restatement): a WARM-UP question ("No warm up sets for bench?") named a lift and matched the "sets" attribute, so the deterministic named-lift lane (`answerPlannedLiftQuestion`) restated the WORKING-set count — "Bench Press today: 3 sets." — instead of recognizing it as a warm-up question (FR-20260723120852-hw56ws9y turn 3). A new `isWarmupQuestion` (`services/sessionQuestionAnswer.js`) recognizes the warm-up phrase (mirroring `warmupTag.WARMUP_NOTE_RE`'s core `warm[\s-]?up` token, WITHOUT its prose-unsafe log-note alternations `\bwu\b`/`(w)`); the `/api/coach/chat` route, when the flag is on, SKIPS the deterministic set-count/prescription lanes for a warm-up question so it reaches the coach. This is RECOGNITION/ROUTING only — the substantive warm-up ramp (what the warm-up should be) is a Phase-6 knowledge capability (D4b), explicitly out of scope. Consumed behind the SAME `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ byte-identical, the set-count lane answers exactly as before; the deterministic lane itself is UNCHANGED, so the gate is the only behavior surface). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/sessionQuestionAnswer.test.js` (warm-up recognition in all spellings vs ordinary prose; the set-count lane unchanged) and `test/api-smoke.test.js` (real `/api/coach/chat` regressions — flag ON ⇒ the warm-up question reaches the coach, never "…3 sets."; flag OFF ⇒ the set-count lane answers as before; zero Sheet writes). CHAT-LANE PRECEDENCE (D7) ✅ LANDED 2026-07-23 (a clarification cannot replay a stale diagnostic): a CLARIFICATION ("Whoa, I was just asking for bench") matches NEITHER the recommendation-explanation NOR the plan-grounded narrowing lane, so the all-lift memory diagnostics + `coach_mode:'challenge'` reached the model unchanged and a standing benchmark-underperformance critique REPLAYED onto it (FR-20260723120852-hw56ws9y turn 5). A new `isClarificationTurn` + `narrowContextForClarification` (`services/coachExplanationGrounding.js`) recognizes the clarification as a coherent metacommunicative-correction category (broad-session review EXCLUDED — it keeps the full picture) and, when the flag is on, DROPS the broad memory diagnostics (memory_patterns/stalls emptied, muscle_gaps dropped) and recomputes `coach_mode` off "challenge" (an explicit discouragement still floors to reassure), reusing the SAME demote pattern `narrowContextForRecommendationExplanation` already applies — so active-session truth outranks the broad memory diagnostic. Wired at the `/api/coach/chat` llmContext fork behind the SAME `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ byte-identical, the challenge still reaches the model exactly as before). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/coachRecommendationExplanation.test.js` (unit: clarification recognized, broad review excluded, demote empties diagnostics + floors coach_mode, reassure preserved; live route: flag ON ⇒ `coach_mode` demoted / no `consistent_underperformance` / no benchmark critique; flag OFF ⇒ `coach_mode:'challenge'` reaches the model and the critique replays). PACKET/SESSION CONSUMPTION — FIRST INCREMENT (D2/D9) ✅ LANDED 2026-07-23 (a state-answerable "what's next?" answers from session truth): the Phase-4 WORK requires "deterministic fallbacks so every state-answerable question (e.g. 'what's next?') answers from the WorkoutSession even with the model down." Today the sibling "are we done?" answers deterministically model-down (`buildSessionCloseAnswer`) but "what's next?" DEAD-ENDS to "coach unavailable". A new `buildNextUpAnswer(planState)` (`services/sessionPlanExecutor.js`) consumes the WorkoutSession's remaining slots (`plan_state.remaining[0]`, the client selector's authoritative verdict) to name the next exercise (or confirm completion), model-INDEPENDENT. Wired into the `/api/coach/chat` model-down `deterministicAnswer` closure behind the SAME `ATLAS_TURN_PRECEDENCE` flag, next to `buildSessionCloseAnswer` and gated on `coachResponseGrounding.isNextUpQuestion`. Scoped to the MODEL-DOWN path only — when the coach is up it still answers richly (no model-up regression), which is why this is the smallest safe first consumption step; making session truth the pre-LLM default precedence (divergence N1) is a subsequent increment. Off ⇒ byte-identical (the next-up question dead-ends exactly as before). No new staged module (both modules are already semantically reachable — the wiring/allowlist guards are untouched), the shadow packet assembly is NOT modified (all packet/shadow tests stay green). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/sessionPlanExecutor.test.js` (`buildNextUpAnswer` names the next slot / confirms completion / defers with no plan) and `test/api-smoke.test.js` (real `/api/coach/chat`: flag ON + model DOWN ⇒ "Next up: Back Squat." from `plan_state`; flag OFF + model DOWN ⇒ dead-ends unchanged; flag ON + model UP ⇒ the coach still answers). D10 PUNCH-LIST FOUNDATION ✅ LANDED 2026-07-23 (`discussion_referent` as a canonical WorkoutSession field): the disputed-lift referent (which lift a bare correction like "that isn't what you planned" resolves to) is today recovered heuristically from an in-memory, freshness-bounded store (`services/coachDiscussionReferent.js`) + a bounded history scan (`coachResponseGrounding.resolveDisputedLiftEntry` tiers 2–3). D10 promotes it to a first-class field set at answer time so the resolver collapses to ONE state read and the store + scan retire. FIRST INCREMENT (contract-additive foundation, no behavior change): `services/workoutSession.js` + `config/coaching/contracts/workout-session.contract.json` gain an OPTIONAL, nullable `discussion_referent` (the canonical key of the lift under discussion, or null) — builder defaults it to null, the validator accepts null-or-non-empty-string when present and NEVER requires it (so a session literal that predates the field still validates), and the `fromActiveSession` boundary adapter carries it through. The Phase-3 shadow's `coachTurnPacketShadow._packetReferent` ALREADY reads `session.discussion_referent` defensively, so the divergence comparison lights up automatically once a session carries it; nothing populates it yet, so the shadow stays null and its "null until Phase 4" assertion still passes. No new staged module, no live route change, no flag needed (purely additive contract plumbing, inert by construction). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/workoutSession.test.js` (builder defaults / carries; validates null-or-key when present; OPTIONAL — a session omitting it still validates; rejects a non-string non-null referent; `fromActiveSession` carries it) with `test/coachTurnPacketShadow.test.js` / `test/contracts-integrity.test.js` still green. Next step: continue D10 — populate `discussion_referent` at answer time (shadow first, then flag-gated resolver preference over the store), then retire the store + history scan; and continue packet/session consumption — the live route reads the authoritative `WorkoutSession`/`CoachTurnPacket` more broadly (remaining D1/D2/D9). PACKET/SESSION CONSUMPTION — H-08A ✅ LANDED 2026-07-23 (the canonical client WorkoutSession crosses the coach boundary into the shadow packet; no visible behavior change): the Phase-3 shadow hardcoded `packet.session = null` because the server saw only log history, never the client's ordered session slots (H-08). H-08A carries the AUTHORITATIVE client active session across the `/api/coach/chat` boundary and assembles it into the CoachTurnPacket shadow — the first deliberately narrow H-08 sub-PR (the session SEAM only). The chat request now forwards the EXISTING canonical client model (`src/app/app.js routeMessageToCoach` → additive `context.active_session = { exercises: [{ name, liftCode, status, source }] }`, sourced from the SAME `getCanonicalSession()` the save payload / confirmation card / bug report already derive from — bounded to the four contract fields, no set details / prose / ids / secrets; old clients omit it and keep working). One pure boundary helper (`services/coachSessionSnapshot.js` `buildCanonicalSessionSnapshot`) converts it ONCE via `services/workoutSession.js` `fromActiveSession` + `validateWorkoutSession` and FAILS CLOSED to null when the field is absent / malformed — never reverse-engineering slot identity / duplicate-occurrence / source / status from the lossy `current_plan` / `plan_state` name arrays, and never partially repairing. `coachTurnPacketShadow.assembleShadowPacket` now embeds the session as `packet.session` ONLY when it genuinely validates (`exercises` / `decision` / `safety` / `closeout` stay honestly empty — H-11 / H-03 / H-12, their own phases); the trace records `session_snapshot` as genuinely present when a session was assembled (NOT `engine_decision` — session state alone never claims the decision spine). Consumed at the `services/coachQaShadow.js` boundary behind the SAME `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ `packet.session` stays null and the trace is byte-identical to before). VISIBLE COACH RESPONSE UNCHANGED in both flag states (the request carries the snapshot regardless of the flag; the route never reads `active_session` for its answer); Gemini inputs, deterministic answer selection, and the preview→approve→write loop are all untouched; no plan mutation, no Sheet write, `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. `discussion_referent` stays null this PR (D10 punch list). No new staged module (the helper is semantically reachable via the shadow — wiring / allowlist guards untouched). NEXT H-08 sub-PR: make one deterministic state-answer lane consume `WorkoutSession.currentSlot()` / `remainingSlots()` instead of route-local `plan_state`, still behind the Phase-4 flag. Evidence: `test/coachSessionSnapshot.test.js` (boundary adapter — slot order / duplicate slots / only-the-correct-occurrence-completed / substituted+inserted source / liftCode all preserved; optional session id stays null; fails closed on malformed status/source/blank-name; NEVER guesses from `current_plan`/`plan_state`), `test/coachTurnPacketShadow.test.js` (a valid session ⇒ `packet.session !== null`, packet stays schema-valid, other embedded facts empty; absent/invalid ⇒ `packet.session === null`; `embedded.session:true` recorded), and `test/coachSessionSnapshotRoute.test.js` (real `/api/coach/chat`: flag ON + valid `active_session` ⇒ packet carries the canonical session, `session_snapshot` present, packet + Coach_Response share one turn id, reply byte-identical, zero training-Sheet appends; flag OFF ⇒ session null / `session_snapshot` missing / byte-identical; old client without the field ⇒ no crash, no fabricated session; malformed snapshot ⇒ fails closed, reply unchanged, shadow never blocks or leaks an error). H-08A BOUNDARY FIX ✅ LANDED 2026-07-24 (an un-coded client session no longer sinks to null): the live client active-session model carries `liftCode` as a STRING and uses `''` for "no lift code" (`createActiveSession`→`toEntry` normalizes an absent code to `''`), but the canonical WorkoutSession contract requires `lift_code` to be `null` or a NON-EMPTY string. `fromActiveSession` passed `''` straight through, so a real session with even one un-coded exercise (the common case — most planned lifts carry no code) failed `validateWorkoutSession` and `buildCanonicalSessionSnapshot` returned null — meaning H-08A's `packet.session` would almost never populate in production. `services/workoutSession.js::fromActiveSession` now bridges the two representations faithfully (`_canonicalLiftCode`: trim a STRING, coerce empty/whitespace → null; prefer `liftCode` then `lift_code`), so an un-coded session VALIDATES and the H-08A shadow packet.session populates for real sessions. The empty→null coercion is deliberately STRING-ONLY — a present non-string code (a number/object) is a malformed snapshot left UNCHANGED so `validateWorkoutSession` still rejects it (fail closed; Codex #1146 P2). Pure contract-adapter fix; no flag, no route change, no behavior change beyond the boundary now validating what it should. Evidence: `test/workoutSession.test.js` (empty/whitespace liftCode → null and the session validates; a real code survives trimmed; a genuinely-absent liftCode falls back to lift_code; a non-string liftCode fails closed) and `test/coachSessionSnapshot.test.js` (a real un-coded `liftCode:''` session is no longer dropped to null; a non-string liftCode fails closed). PACKET/SESSION CONSUMPTION — H-08B ✅ LANDED 2026-07-24 (the first LIVE answer lane reads the canonical WorkoutSession, not plan_state): the "what's next?" deterministic lane (model-down path in `/api/coach/chat`) previously answered from the lossy route-local `plan_state` name array (`buildNextUpAnswer(planStateFromContext)`). H-08B makes it the FIRST live answer lane to CONSUME the canonical `WorkoutSession` selectors — when the client forwards the authoritative active-session snapshot (`context.active_session`, H-08A), the lane builds the canonical session via `buildCanonicalSessionSnapshot` and names the next-up exercise from `remainingSlots(session)[0]` / `isComplete(session)` (`services/sessionPlanExecutor.js::buildNextUpAnswerFromSession`, sharing the SINGLE `_wordNextUp` prose home with the plan_state path so the two can never word next-up differently) — real, ordered, duplicate-aware slot identity instead of a lossy name array. Old clients that omit `active_session` fall back to the `plan_state` path unchanged. Consumed behind the SAME `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ the branch is skipped and the turn dead-ends byte-identically as before). Scoped to the model-DOWN path only (no model-up regression — the coach still answers richly when up). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module (both modules already semantically reachable; wiring/allowlist guards untouched). Evidence: `test/sessionPlanExecutor.test.js` (`buildNextUpAnswerFromSession` names the first remaining slot / points at the first PENDING occurrence with duplicate slots / confirms completion / defers on an empty session / words IDENTICALLY to the plan_state path) and `test/api-smoke.test.js` (real `/api/coach/chat` with a DISCRIMINATING context where `active_session` and `plan_state` name DIFFERENT next-ups: flag ON + model DOWN ⇒ answers "Next up: Back Squat." from the canonical session, NOT the plan_state "Overhead Press."; an old client with no `active_session` falls back to plan_state; flag OFF ⇒ the additive field is inert and the turn dead-ends). NEXT: continue packet/session consumption (more state-answerable lanes read the WorkoutSession) and populate the D10 `discussion_referent` at answer time. D10 REFERENT — SHADOW-FIRST ✅ LANDED 2026-07-24 (the answer-time discussion referent is carried on the packet session): the route resolves the disputed-/discussed-lift referent (which lift a bare correction resolves to) AT ANSWER TIME (`turnReferentKey`, stashed on `res.locals.coachTurnReferent`), but it lived only in the route-local in-memory store (`services/coachDiscussionReferent.js`), so the Phase-3 divergence report flagged `route-local referent` on every referent turn. D10's shadow-first increment SETS it on the canonical session at answer time: `services/coachSessionSnapshot.js::buildCanonicalSessionSnapshot` now accepts a `discussion_referent` option and `services/coachQaShadow.js` passes the route's pick, so `packet.session.discussion_referent` carries the referent and the shadow's `_packetReferent` reads it — clearing the `route-local referent` divergence signal (referent.packet == referent.route) as clients forward the active session. SHADOW-ONLY: the live dispute resolver still uses the store in this increment (the flag-gated resolver preference over the store, then retiring the store + history scan, are the subsequent D10 steps); the visible answer is UNCHANGED. Gated by the same `ATLAS_TURN_PRECEDENCE` flag (the canonical session is only built when it's on) plus `ATLAS_INTERACTION_TRACE=shadow`. Empty/non-string referent → null (never a fabricated referent). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module (wiring/allowlist guards untouched). Evidence: `test/coachSessionSnapshot.test.js` (the referent option sets `session.discussion_referent` and validates; empty/non-string → null), `test/coachTurnPacketShadow.test.js` (a session carrying the referent makes `referent.packet == route`, route-local cleared), and `test/coachSessionSnapshotRoute.test.js` (real `/api/coach/chat`: a "why …" turn naming a planned lift resolves a referent AND the packet session carries it — `referent.packet == referent.route`). NEXT: flag-gated resolver preference for the packet referent over the store, then retire the store + history scan. PACKET/SESSION CONSUMPTION — H-08C ✅ LANDED 2026-07-24 (the "are we done?" lane also reads the canonical WorkoutSession): completing the deterministic state-answer pair (H-08B did "what's next?"), the model-down "are we done?" lane now consumes the canonical session's OWN slots (`isComplete(session)` + `remainingSlots(session)`) when the client forwards the authoritative active-session snapshot — real, ordered, duplicate-aware slot identity, INCLUDING off-plan inserts in the total — instead of the lossy route-local `plan_state` name array (which counts planned-only). A new `services/sessionPlanExecutor.js::buildSessionCloseAnswerFromSession` shares the SINGLE `_wordSessionClose` prose home with the plan_state path (`buildSessionCloseAnswer` refactored onto it) so the two can never word "are we done?" differently. The canonical session is built ONCE at the top of the model-down `deterministicAnswer` closure and reused by both the close and next-up lanes. Old clients that omit `active_session` fall back to the plan_state path unchanged. Behind the same `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ both lanes use plan_state, byte-identical). Model-DOWN path only. Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module (wiring/allowlist guards untouched). Evidence: `test/sessionPlanExecutor.test.js` (`buildSessionCloseAnswerFromSession`: outstanding lifts / completion count / counts an off-plan insert / defers on non-close or empty / words IDENTICALLY to the plan_state path) and `test/api-smoke.test.js` (real `/api/coach/chat` with a DISCRIMINATING context where the session includes a completed off-plan finisher: flag ON + model DOWN ⇒ "3 exercises complete" from session truth, NOT the plan_state "2"; flag OFF ⇒ "2 exercises complete" unchanged). With H-08B this completes Phase-4 WORK item 2 (every state-answerable question — "what's next?"/"are we done?" — answers from the WorkoutSession model-down) for the two deterministic state-answer lanes. NEXT: continue Phase-4 staging — the session-priority collision-phrase pack, Drift Guard 5, and Golden Session live-run prep. DRIFT GUARD 5 — FIRST INCREMENT ✅ LANDED 2026-07-24 (packet & trace honesty tripwire): built the first increment of Drift Guard 5 (`scripts/check-packet-trace.js`, `npm run check:packet-trace`; wired into `.github/workflows/ci.yml` and CLAUDE.md's guard registry) — the permanent CI tripwire for the campaign's central H-05/H-15 disease (understating is safe; overstating is the failure). It runs the REAL `assembleShadowPacket` over a fixed input matrix and fails when (a) an `assembled.valid:true` disagrees with `validateCoachTurnPacket` (a silently-invalid packet reported valid), (b) any embedded-presence flag OVERCLAIMS — `embedded.<fact>` present while `packet.<fact>` does not validate under its own canonical contract, or `embedded.exercises` exceeds the genuinely-valid ExerciseIdentity count (an UNDERclaim is never flagged), or (c) a representative InteractionTrace fails to validate or its `missing`-stage list is dishonest. `_embeddedFields` is exported from `services/coachTurnPacketShadow.js` so the guard checks the shadow's OWN presence computation, not a re-derivation. As Phases 4–5 populate the embedded facts (session→H-08 done, decision→H-03, safety→H-12, exercises→H-11), each is forced to be claimed present only when canonical. The fuller Guard-5 remit (every full-session test asserts the visible reply came from a schema-valid packet with one turn ID spanning input→write proof) lands as the live route consumes the packet (Phases 4–5). Read-only, deterministic, offline; NO runtime behavior change; no flag. Self-test `test/packetTraceGuard.test.js` proves the guard bites on a synthetic overclaim and does NOT flag an underclaim. H-03 DECISION CANONICALIZATION — SHADOW-FIRST FIRST INCREMENT ✅ LANDED 2026-07-24 (the route's explain-recommendation decision is canonicalized into the packet): the divergence report's headline is `null decision` — the engine's coaching decision is computed route-locally in a non-canonical shape (H-03). This narrowest shadow-first seam canonicalizes ONE route-local decision — the read-only "explain the displayed recommendation" turn (`coachExplanationGrounding` already stashes the trusted snapshot on `res.locals.coachRecommendationGrounding`, and the shadow already records the `engine_decision` trace stage for it) — into a `progress_readout` CoachingDecision (the decision_type the manifest maps the `explain_recommendation` intent to — read-only, carries NO prescription). A new pure boundary adapter `services/coachDecisionSnapshot.js::buildCoachingDecisionFromExplanation` builds it and validates via `validateCoachingDecision`; `coachTurnPacketShadow.assembleShadowPacket` now embeds it as `packet.decision` ONLY when it validates (Guard 5 additionally refuses an invalid decision), so the divergence report's `null decision` signal clears for explain-recommendation turns. FAITHFUL, not fabricated: it canonicalizes the route's real decision ENVELOPE, does NOT re-run the Brain (`provenance.modules_run` empty), and its confidence is CONSERVATIVE — derived from the same grounding signal the route's own honesty logic uses (engine label / real history ⇒ moderate/act; a bare outage snapshot ⇒ low/act_with_caveat + `insufficient_history`), never claiming high confidence the engine did not compute. safety is green/non-blocking (the route safety verdict is still route-local — H-12/Phase 5d). SHADOW-ONLY, behind the same `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ `packet.decision` stays null, byte-identical shadow); the live route is UNCHANGED (no visible coaching change); `exercises`/`safety`/`closeout` stay empty (H-11/H-12). Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/coachDecisionSnapshot.test.js` (a valid progress_readout decision; conservative confidence derivation; no prescription; fails closed on non-explain/absent), `test/coachTurnPacketShadow.test.js` (a valid decision ⇒ `packet.decision !== null`, packet stays schema-valid; an invalid decision ⇒ null), and `test/coachSessionSnapshotRoute.test.js` (real `/api/coach/chat`: flag ON + a "why …" turn ⇒ `embedded.decision:true` and `engine_decision` stage present; flag OFF ⇒ `packet.decision` null). NEXT H-03 increments: enrich the decision (populate `explanation_inputs` with the readout facts), canonicalize further decision types (recovery/substitution), then — behind the flag — make the live route CONSUME the packet decision, retiring route-local recomputation. H-03 SECOND INCREMENT ✅ LANDED 2026-07-24 (the canonical decision now carries the readout facts): the first increment canonicalized the explain-recommendation decision ENVELOPE with an empty `explanation_inputs`; this enriches it so the `progress_readout` decision carries the DISPLAYED readout facts the output-LLM may word — `target_name`/`target_weight`/`target_reps`/`target_sets`/`target_rir` + `recommendation_label`/`focus`, taken from the grounding snapshot (`services/coachDecisionSnapshot.js::_explanationInputsFrom`). Only NON-NULL facts are included (an outage snapshot with no numbers ⇒ empty `explanation_inputs`, honest — nothing to word). These are the EXISTING displayed recommendation being explained, NOT a new prescription: the `payload` stays empty (progress_readout carries no prescription, rule 6) and the trust contract (which governs prescribed PAYLOAD numbers, of which progress_readout has none) is unaffected — the decision stays contract-valid. This makes the canonical decision faithful and readies it for live consumption (the LLM-may-word-only-`explanation_inputs` contract). Still SHADOW-ONLY, same `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT); no route change, no visible coaching change, no new module. Read-only; no write; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/coachDecisionSnapshot.test.js` (explanation_inputs carries the readout facts and the decision stays valid; an outage snapshot yields empty explanation_inputs; payload stays empty). NEXT: canonicalize another decision type (recovery routing, needs a small res.locals stash), then the live-consumption seam (build the packet inline during the request and read `packet.decision`, byte-identical when the flag is off). H-03 THIRD INCREMENT ✅ LANDED 2026-07-24 (a SECOND decision type canonicalized — recovery routing): the shadow now carries a canonical `recovery` CoachingDecision for a tiredness/recovery-routing turn, broadening the cleared `null decision` divergence signal beyond explain-recommendation. `services/coachDecisionSnapshot.js::buildRecoveryDecision` builds a `recovery` decision (intent `readiness_checkin`, source `chat`, no prescription, green/non-blocking safety) with CONSERVATIVE confidence derived from a real signal — engine-grounded (the configured path computes `fatigueStatus` + days-since) ⇒ moderate/act; the outage path (client readiness only) ⇒ low/act_with_caveat + `limited_readiness_inputs`. The `/api/coach/chat` route stashes `res.locals.coachRecoveryDecision = { engine_grounded }` on BOTH recovery-routing early returns (the unconfigured outage path and the configured engine-grounded path) — a shadow-only signal read solely by the `res.on('finish')` hook (mirrors `coachRecommendationGrounding`/`coachTurnReferent`), inert to the reply; `coachQaShadow` builds the decision from it and records the `engine_decision` trace stage for recovery turns (a recovery turn genuinely made a coaching decision). A turn is EITHER explain OR recovery (a tired turn returns before the explanation lane), so the two are mutually exclusive. Shadow-only, same `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ `packet.decision` null); no visible coaching change (the recovery reply is byte-identical — only a res.locals stash was added), no new module. Read-only; no write; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/coachDecisionSnapshot.test.js` (`buildRecoveryDecision`: valid recovery decision; conservative confidence from engine-grounding; tolerates a malformed signal) and `test/coachSessionSnapshotRoute.test.js` (real `/api/coach/chat`: flag ON + a tired turn ⇒ `embedded.decision:true` + `engine_decision` stage present, reply still `source:'engine'`). NEXT: the live-consumption seam — build the packet inline during the request and read `packet.decision`, byte-identical when the flag is off. H-03 FOURTH INCREMENT ✅ LANDED 2026-07-24 (the canonical decision's `explanation_inputs` now carries the target-history facts the route words): the second increment enriched `explanation_inputs` with the DISPLAYED prescription + label/focus but NOT the target lift's most-recent logged session — yet the route's own deterministic explanation (`services/coachExplanationGrounding.js::buildDeterministicRecommendationExplanation`) words exactly that ("Your last logged <lift> was <date> at <top set>"). This increment adds `target_last_date`/`target_last_top` to `services/coachDecisionSnapshot.js::_explanationInputsFrom`, taken from the grounding snapshot's `history.last_date`/`history.last_top` (`last_top` is the pre-formatted top-set string built by `coachExplanationGrounding.buildTargetHistory`, e.g. "185 for 5 at 2 RIR"). Only NON-NULL facts are included (a date with no top set ⇒ the `target_last_top` key is ABSENT, never null/empty; an outage snapshot with no history ⇒ neither key). This COMPLETES the readout fact set so the canonical `progress_readout` decision fully captures what the route SAYS — the precondition for a byte-identical live consumption of `packet.decision` (the contract is the LLM may word only `explanation_inputs`). The `payload` stays empty (progress_readout carries no prescription, rule 6) and the trust contract (which governs prescribed PAYLOAD numbers, of which progress_readout has none) is unaffected — the decision stays contract-valid. Still SHADOW-ONLY, same `ATLAS_TURN_PRECEDENCE` flag (DEFAULT INERT — off ⇒ `packet.decision` null); no route change, no visible coaching change, no new module. Read-only; no write; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. Evidence: `test/coachDecisionSnapshot.test.js` (`explanation_inputs` carries `target_last_date`/`target_last_top` and the decision stays valid; a date-only history omits `target_last_top`; an outage snapshot yields empty `explanation_inputs`). NEXT: the live-consumption seam — refactor `buildDeterministicRecommendationExplanation` onto a shared worder + facts extractor so the route, behind the flag, words the explanation from `packet.decision.explanation_inputs` (byte-identical when off; proven byte-identical when on). H-03 FIFTH INCREMENT ✅ LANDED 2026-07-24 (the byte-identical worder + decision bridge, the isolated groundwork for live consumption): the deterministic recommendation explanation is the FIRST engine decision the live route will read from `packet.decision` (the fallback/model-down reply IS this text), so before touching that visible path this increment builds — and PROVES — the byte-identical bridge in isolation, with NO route or behavior change. `services/coachExplanationGrounding.js` now funnels the explanation through ONE private worder `_wordRecommendationExplanation(facts)` (a faithful extraction of the prior inline logic — same label-reason/outage/history wording, same null-on-no-weight guard); `buildDeterministicRecommendationExplanation(snapshot)` extracts the readout facts from the route-local grounding snapshot and words them through it (EXISTING behavior, unchanged); and a new `buildDeterministicRecommendationExplanationFromDecision(decision)` reads the SAME facts from a canonical CoachTurnPacket decision's `explanation_inputs` (key names mirror `coachDecisionSnapshot._explanationInputsFrom`) and words them through the SAME worder — so for a decision built from a snapshot the two produce a BYTE-IDENTICAL string. This is purely additive: the new bridge is not yet called by any route (the flag-gated route wiring is the next increment), so there is zero behavior change and no flag surface in this PR. Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module (the export lives in the already-wired `coachExplanationGrounding.js`; wiring/allowlist guards untouched). Evidence: `test/coachExplanationWorder.test.js` (across a matrix of the realistic snapshot shapes the route produces — grounded/outage/date-only-history/missing-attributes/no-weight — `buildDeterministicRecommendationExplanationFromDecision(buildCoachingDecisionFromExplanation(snapshot))` equals `buildDeterministicRecommendationExplanation(snapshot)` byte-for-byte, including through the REAL `buildRecommendationSnapshot`; plus the bridge's fail-closed edges). NEXT: the flag-gated route wiring — at the two `/api/coach/chat` deterministic-explanation sites (the unconfigured-outage path and the model-down path), when `ATLAS_TURN_PRECEDENCE` is on, build the canonical decision inline and word the reply from `packet.decision` via the bridge (byte-identical to the snapshot path, now proven); flag off ⇒ the snapshot path is used verbatim (byte-identical). H-03 SIXTH INCREMENT ✅ LANDED 2026-07-24 (the live route CONSUMES the canonical decision — the first engine decision read from packet.decision): the fifth increment proved the byte-identical bridge in isolation; this wires it into the live `/api/coach/chat` route. At the two deterministic-recommendation-explanation reply sites — the unconfigured/offline path and the configured/model-down path — the route now words the reply through a single `wordRecommendationExplanation(snapshot)` helper (`routes/coachOps.js`): when `ATLAS_TURN_PRECEDENCE` is on it builds the canonical decision inline (`buildCoachingDecisionFromExplanation` → `packet.decision`) and words the reply from it via `buildDeterministicRecommendationExplanationFromDecision`, the FIRST live consumption of a canonical engine decision — beginning to retire the route-local recomputation the divergence report headlines (`null decision`, H-03). PROVEN byte-identical: the same worder over the same facts (the decision's `explanation_inputs` are built from this very snapshot), so flag ON reads packet.decision and flag OFF (DEFAULT INERT) uses the snapshot path verbatim, producing an identical reply; a snapshot that yields no valid decision also falls back to the snapshot path, so the reply is never lost. The completion ladder is NOT advanced to `route_consumed` yet — consumption is flag-gated and default-off, so under the ladder's "assign the lower rung when ambiguous" rule (H-05/H-15) the capability stays honest until the owner enables the flag at the Phase-4 gate (live_proven). VISIBLE COACH RESPONSE UNCHANGED in both flag states; Gemini inputs, deterministic answer selection, and the preview→approve→write loop are untouched; read-only, no write, no plan mutation; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module (both helpers live in already-wired modules; wiring/allowlist guards untouched). Evidence: `test/api-smoke.test.js` (real `/api/coach/chat` at BOTH sites — configured+model-down and unconfigured — flag ON ⇒ the reply is the deterministic recommendation explanation sourced from the canonical decision and BYTE-IDENTICAL to flag OFF; `source:'engine'`; zero Sheet appends in either state) atop the isolated bridge proof (`test/coachExplanationWorder.test.js`). NEXT: broaden live consumption — the recovery-routing decision (buildRecoveryDecision) has no worded reply to consume yet, so the next canonical-decision consumption targets the substitution decision or a session-state answer lane reading packet.session/packet.decision more broadly; continue clearing the divergence report's route-local recomputation behind the flag toward the Phase-4 owner gate. H-03 RECOMMENDATION-EXPLANATION ARC — RETROSPECTIVE REVIEW ✅ RECORDED 2026-07-24 (the missed advisory-review loop for #1154–#1156 closed on current main; one real finding fixed): an independent adversarial review of the merged recommendation-explanation arc (canonical `explanation_inputs` #1154, shared worder + `…FromDecision` bridge #1155, live consumption at both reply sites #1156) verified explanation_inputs completeness, canonical-decision validation (always valid-or-null), both reply sites, flag-off verbatim / flag-on canonical, packet/trace honesty, zero Sheet appends, no mutation surface, and no completion-ladder overclaim — all HOLD. ONE genuine finding (P2, LATENT — the flag is default-off so there is no production impact today): the byte-identical flag-on↔flag-off invariant was over-claimed. `buildRecommendationSnapshot` leaves `target.name` RAW (it trims label/focus/history), but `coachDecisionSnapshot._explanationInputsFrom` trimmed `target_name` via `_strOrNull` — so a client `current_plan` lift name with surrounding whitespace produced a DIFFERENT reply flag-on (trimmed) vs flag-off (raw), and a whitespace-only name LOST the reply (decision path → null → generic engine fallback). FIX (preserve byte-identical flag-off per the operating rule — never alter the flag-off reply; make flag-on reproduce it, NOT trim the display at source): `_explanationInputsFrom` now carries the RAW `target_name` (`_presentStr`, present-iff-truthy, un-trimmed) so the decision path reproduces the flag-off raw-name reply exactly; `wordRecommendationExplanation` (routes/coachOps.js) now FAILS CLOSED to the snapshot path when the decision words to null (the prior `if (decision) return …` left that fallback dead — Finding 2, P3 defense-in-depth, a no-op under the fidelity fix). Shadow-only/flag-gated surface unchanged; byte-identical with the flag off. Evidence: `test/coachExplanationWorder.test.js` (padded-name + whitespace-only-name equivalence rows added; the over-claim header comment corrected) and `test/api-smoke.test.js` (real /api/coach/chat: flag ON words the RAW padded name, byte-identical to flag OFF, zero Sheet appends). Full suite 6427 green; all drift guards green. The merged PR pages #1154–#1156 are NOT retroactively annotated (merged history is immutable). H-03 RECOVERY-ROUTING ARC — PR 1 ✅ LANDED 2026-07-24 (the canonical recovery decision now carries the recovery-reason facts): broadening H-03 decision consumption toward live recovery-routing consumption, the shadow `recovery` CoachingDecision's `explanation_inputs` now carries the EXACT authoritative facts `buildTirednessRecoveryAnswer` is grounded in — `fatigue_status` (the engine's status verbatim), `days_since_last_session` (normalized with the reply's own `Number()`/finite guard), and `fatigued_patterns` (the FULL flagged-fatigued readiness list — the reply words `slice(0,2)` for names but keys singular/plural off the full length). One shared pure extractor `services/recoveryRouting.js::recoveryReasonFacts(signals)` — the single fact home both the reply worder (PR 2) and the canonical decision read — includes ONLY genuinely-present facts (an outage/limited signal with client readiness only yields at most `fatigued_patterns`; a bare/malformed signal yields `{}`), never null-padded, never trimmed (avoiding the exact byte-identity trap #1157 fixed). `buildRecoveryDecision(signal)` (`services/coachDecisionSnapshot.js`) populates `explanation_inputs` from it; the engine-grounded vs limited/outage distinction is preserved by the existing conservative confidence (`limited_readiness_inputs` caveat when not grounded). The `/api/coach/chat` route hoists the recovery signals it ALREADY computes (`computeFatigueStatus`/`assessLayoff`/`context.readiness`) once and stashes them on `res.locals.coachRecoveryDecision` at BOTH recovery reply sites (the unconfigured-outage path — readiness only — and the configured engine-grounded path), read solely by the shadow's `res.on('finish')` hook. SHADOW-ONLY, same `ATLAS_TURN_PRECEDENCE` + `ATLAS_INTERACTION_TRACE=shadow` gating (DEFAULT INERT); the visible recovery reply is BYTE-IDENTICAL (the signals object is the same one the reply already consumed — proven at the route). recovery carries no prescribed PAYLOAD numbers, so the facts (incl. the `fatigued_patterns` array value) never trip the trust contract and the decision stays valid; Drift Guard 5 green. Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module. Evidence: `test/recoveryRouting.test.js` (`recoveryReasonFacts` per-branch matrix — elevated/back-to-back/patterns/recovered/outage/bare/malformed, `days===0` kept, numeric-string coercion, full pattern list), `test/coachDecisionSnapshot.test.js` (the enriched `explanation_inputs` per branch, valid, outage⇒limited caveat, array value never trips the trust contract) and `test/coachSessionSnapshotRoute.test.js` (real /api/coach/chat: the recovery reply is byte-identical shadow-off vs shadow-on, the enriched decision still embedded, no training write). NEXT (PR 2): refactor `buildTirednessRecoveryAnswer` onto one shared branching worder + the `recoveryReasonFacts` extractor + a `…FromDecision` bridge, proving byte-identical output between the route-input path and the canonical-decision path over the full branch matrix (no live route change). H-03 RECOVERY-ROUTING ARC — PR 2 ✅ LANDED 2026-07-24 (the byte-identical recovery worder + decision bridge, isolated groundwork for live consumption): before touching the visible recovery path (PR 3), this refactors `buildTirednessRecoveryAnswer` onto ONE shared prose home and PROVES the byte-identical bridge in isolation, with NO route or behavior change. `services/recoveryRouting.js` now funnels the recovery reply through one private worder `_wordRecovery(facts)` (a faithful extraction of the prior inline logic — same reason order elevated→back-to-back→patterns, same `reasons.slice(0,2)` because-clause, same recovered/fallback branches); `buildTirednessRecoveryAnswer(signals)` extracts the reason facts via the shared `recoveryReasonFacts` (PR 1) and words them through it (EXISTING behavior, unchanged); and a new `buildTirednessRecoveryAnswerFromDecision(decision)` reads the SAME facts from a canonical CoachTurnPacket recovery decision's `explanation_inputs` (`_recoveryFactsFromDecision`, key names mirroring `recoveryReasonFacts`) and words them through the SAME worder — so for a decision built from signals the two produce a BYTE-IDENTICAL string. Purely additive: the bridge is not yet called by any route (the flag-gated wiring is PR 3), so ZERO behavior change and no flag surface in this PR. ONE prose home; not two implementations that merely pass the current fixtures. Read-only; no write, no plan mutation; preview→approve→write UNCHANGED; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module. Evidence: `test/recoveryWorder.test.js` (across the COMPLETE recovery branch matrix — elevated / back-to-back today vs yesterday / one-vs-two-vs-three fatigued patterns / all-three-reasons patterns-dropped / recovered branch + `d===3` boundary / outage-limited / bare / numeric-string day / elevated-outranks-recovered — `buildTirednessRecoveryAnswerFromDecision(buildRecoveryDecision(signals))` equals `buildTirednessRecoveryAnswer(signals)` byte-for-byte; plus the bridge's fail-closed edges — an absent/malformed decision and malformed fact types degrade to the safe no-numbers routing, never null, never a fabrication). NEXT (PR 3): the flag-gated live wiring — at both `/api/coach/chat` recovery reply sites, when `ATLAS_TURN_PRECEDENCE` is on, build the canonical recovery decision inline and word the reply from `packet.decision` via the proven bridge (byte-identical to the signals path); flag off ⇒ the signals path verbatim; fail closed to the signals path when no valid decision can be built. H-03 RECOVERY-ROUTING ARC — PR 3 ✅ LANDED 2026-07-24 (the live route CONSUMES the canonical recovery decision — the SECOND engine decision read from packet.decision): the byte-identical bridge proven in PR 2 is now wired into the live `/api/coach/chat` route. At BOTH recovery reply sites — the unconfigured/offline path and the configured/engine-grounded path — the route words the tired lifter's reply through a single `wordRecoveryReply(signal)` helper (`routes/coachOps.js`): when `ATLAS_TURN_PRECEDENCE` is on it builds the canonical recovery decision inline (`buildRecoveryDecision` → `packet.decision`) and words the reply from it via `buildTirednessRecoveryAnswerFromDecision` — the SECOND live consumption of a canonical engine decision (after the recommendation explanation), continuing to retire the route-local recomputation the divergence report headlines (D1/H-03). The SAME object is both the shadow signal on `res.locals.coachRecoveryDecision` AND the helper's input, so shadow and reply can never disagree. PROVEN byte-identical: the decision's `explanation_inputs` are `recoveryReasonFacts(signal)` and both paths word them through the SAME worder, so flag ON reads `packet.decision` and flag OFF (DEFAULT INERT) uses the signals path verbatim, producing an identical reply; a signal that yields no valid decision falls back to the signals path (fail closed), so the recovery reply — always non-empty — is never lost or changed. The completion ladder is NOT advanced to `route_consumed` (consumption is flag-gated and default-off, so under the ladder's "assign the lower rung when ambiguous" rule the capability stays honest until the owner enables the flag at the Phase-4 gate). VISIBLE RECOVERY REPLY UNCHANGED in both flag states; deterministic answer selection and preview→approve→write are untouched; read-only, no write, no plan mutation; `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`. No new staged module (both helpers live in already-wired modules; wiring/allowlist guards untouched). Evidence: `test/api-smoke.test.js` (real `/api/coach/chat` at BOTH sites — configured/engine-grounded and unconfigured/offline incl. the outage fatigued-patterns branch — flag ON ⇒ the recovery reply is sourced from the canonical decision and BYTE-IDENTICAL to flag OFF; `source:'engine'`; never hypes; zero Sheet appends) atop the isolated bridge proof (`test/recoveryWorder.test.js`). With the recommendation-explanation arc, TWO canonical engine decisions are now live-consumed behind the flag. NEXT: continue clearing the divergence report's route-local recomputation — canonicalize + consume the substitution decision (`services/turnPrecedence.js` → a `substitution` CoachingDecision) or broaden session-state answer lanes reading `packet.session`/`packet.decision`; and the D10 discussion-referent resolver preference over the store, then store + history-scan retirement. DRIFT GUARD 5 — DECISION-EMBED COVERAGE ✅ LANDED 2026-07-24 (Step 3 — the guard now exercises a non-null `packet.decision`, closing a concrete hole opened by H-03 live consumption): the anti-overclaim checker already refused an `embedded.decision` present while `packet.decision` fails its contract, but the guard's REAL input matrix (`scripts/check-packet-trace.js`) only ever passed `session` params — so `assembleShadowPacket` was never run with a decision and the decision-embed path was untested. Now that the live route consumes `packet.decision` (explain-recommendation + recovery), the matrix adds three decision cases: a genuinely-valid recovery decision (must embed AND validate — no overclaim), a malformed decision (must drop to null — an honest underclaim, never an overclaim, and a tripwire if a shadow bug ever embedded an invalid decision), and a valid session + valid decision together (8 assemblies checked, up from 5). The self-test (`test/packetTraceGuard.test.js`) gains a decision-overclaim BITES case (a route-local decision shape claimed present while it fails `validateCoachingDecision` is flagged) and a valid-decision no-overclaim case — proving the checker bites on decisions, not only sessions. Read-only, offline, deterministic; NO runtime behavior change; grow-only guard coverage tied to the landed H-03 consumption seams (not generic churn). Full suite 6467 green; all drift guards green. STEP 2 SEAM SURVEY (recorded 2026-07-24): with the two clean read-only, deterministically-worded decision types consumed (explain_recommendation→progress_readout and readiness_checkin→recovery), the remaining `intent-capabilities` decision types are NOT byte-identical-derivable server-only seams — `workout`/`progression`/`substitution`/`onboarding`/`nutrition` are non-read-only (they change the plan / write), `progress_query`→progress_readout is LLM-owned (no deterministic reply to consume), a factual-dispute→decision_type mapping is a manifest/product judgment, the current-lift state lanes (`answerCurrentExercisePrescription`/`answerPlannedLiftQuestion`) resolve via `currentLiftFromContext` (preview + `plan_completed` inputs the canonical WorkoutSession snapshot does not carry, so migrating to `currentSlot` would change which lift resolves — not byte-identical), and D10 store retirement needs cross-turn referent persistence (a client-protocol change), not a small server seam. Those are genuine stop conditions (byte-identity/product-judgment), so Phase-4's technically-derivable read/decision-consumption work is complete; NEXT is Step 4 — prepare (not cross) the Phase-4 owner gate (Golden Session fixture + dry-run harness + write-guard verification + owner handoff). PHASE-4 OWNER-GATE PREP ✅ COMPLETE 2026-07-24 (Step 4 — prepared, gate NOT crossed): the technically-derivable Phase-4 read/decision-consumption work is complete (two canonical engine decisions — recommendation-explanation `progress_readout` + recovery — are live-consumed behind `ATLAS_TURN_PRECEDENCE`, default-off, PROVEN byte-identical; the remaining seams are byte-identity / product-judgment stop conditions per the Step-2 survey above). The write guards are verified fail-closed (`SESSION_PLAN_SETS_WRITE_ENABLED=0` ⇒ every planned-set checkpoint/seal returns the W1–W3 dry-run proof — `sheet_written:false`/`no_write_confirmed:true`/`dry_run:true`/`reason:'write_disabled'`, `test/sessionPlanSetsStore.test.js`) and the Golden Session fixture/harness is healthy (`test/soulGoldenTranscripts.test.js`, `test/closeoutSealIntegration.test.js`). The owner-gate readiness handoff is published at [`docs/verification/PHASE_4_OWNER_GATE_HANDOFF.md`](verification/PHASE_4_OWNER_GATE_HANDOFF.md) — exact merged SHA, PR list, findings + dispositions, route-consumed vs shadow-only, remaining divergence, the exact Render flag changes (`ATLAS_TURN_PRECEDENCE=1` + `SESSION_PLAN_SETS_WRITE_ENABLED=1`), the live-validation Golden Session sequence, rollback (pure env toggles), and the evidence that would advance Phase 4. THIS IS THE PHASE-4 OWNER GATE — a genuine owner-reserved stop: no flag was enabled, no Render change made, no live write performed, no capability promoted to `live_proven`, `SESSION_PLAN_SETS_WRITE_ENABLED` stayed `0`, and the gate is NOT crossed. Next: the OWNER runs gate script (a) then (b). Gates passed: install, Phase 1 Soul gate (2026-07-20 PASS), Phase 2 (2026-07-21), Phase 3 (2026-07-23). Streak: 0/5. PHASE 3 ✅ COMPLETE 2026-07-23 — closed on production evidence from Flight Recorder session FR-20260723120852-hw56ws9y (deployed SHA 749e136619ee22f2b4d558abc5dc1b282c530585). The owner set ATLAS_INTERACTION_TRACE=shadow on Render and trained; `npm run atlas:divergence` was run over the collected `[coach-turn-shadow]` records and the FINAL divergence summary published at docs/verification/PHASE_3_DIVERGENCE_SUMMARY_2026-07-23.md (raw Render logs stay owner-side — workout data, not committed; the committed output is the deterministic tool run over a redacted reconstruction of the documented Coach_Shadow record shape, booleans/counts/stage-names only, plus the direct FR-session observations — both agree, and the report can only report bypass, never a false green). DONE-WHEN met: the packet assembles (schema-valid) for EVERY shadowed turn and the divergence list is STABLE AND UNDERSTOOD — every reported contradiction reconciled to an owner: Phase 4 first concern (decision/session computed route-locally — H-03/H-08; the all-six prescription dump; a warm-up question misread as a set-count restatement; a malfunction complaint invoking substitution; a substitution contradicting active-plan truth — "No Bench Press today" while Bench was active first; a clarification replaying a stale diagnostic; the 2–5-lane route cascade with no single owner; the session_snapshot/engine_decision spine gap on ordinary follow-ups routed outside the one shadowed route), Phase 4 punch list (route-local discussion referent → promote discussion_referent to a CoachTurnPacket/WorkoutSession field), Phase 5b (no canonical ExerciseIdentity — H-11), Phase 5d (route-local safety verdict — H-12), Phase 6 (knowledge_retrieval not wired + substantive warm-up-protocol content — H-06), or a documented NON-ISSUE (the deterministic recovery on turn 2 = positive evidence the authoritative answer already exists in session state; the atomic gated replacement, PR #1134, = the final narrow Phase-3 stabilization PASS: one proposal, RDL kept before approval, five unrelated exercises unchanged, no Log_Cleaned/Session_Plans/Session_Plan_Sets writes). The corpus baseline is UNCHANGED at this transition (it reruns + appends at the CLOSE of Phases 4, 6, and 7 — not here). Closes H-14; sets up H-03. OWNER SIDE-INSTRUMENT INSERTION ✅ RECORDED 2026-07-22 (governance concern A — NO PHASE RESEQUENCING; Phase 3 status unchanged): the owner provided the Atlas Soul Corpus V2 — fifteen annotated sessions + a synthesis — committed as reference input under docs/reference/ (ATLAS_SOUL_CORPUS_V2_SESSIONS.md, ATLAS_SOUL_CORPUS_V2_SYNTHESIS.md) and directed a CORPUS BASELINE RUNNER as a phase-boundary INSTRUMENT (not a new phase, not a second roadmap — rule 3 holds): replay all fifteen sessions turn-by-turn against the real read-only coach code with synthetic athlete profiles injected in test mode (never a live write; every turn tagged corpus-synthetic; fully segregated from real shadow/divergence data — the ATLAS_INTERACTION_TRACE=shadow stream is untouched), scored behaviorally against the synthesis's 35-capability matrix (behavior, not wording), published as a scoreboard, and RERUN + APPENDED at the CLOSE of Phases 4, 6, and 7. This concern-A PR also reconciles the synthesis's Section F against the campaign — every gap mapped to its existing phase (the reason-packet emitter IS the CoachTurnPacket already built in the Phase 3 shadow), the seven genuinely-new items filed as BACKLOG intake (no new roadmap), and the synthesis's stale ACTIVE_ROADMAP reference noted — in docs/reference/ATLAS_SOUL_CORPUS_V2_SECTION_F_RECONCILIATION.md. The runner + baseline scoreboard land in concern B (the runner PR). Paper-weight cap raised 1263→1273 (recorded justification) for the seven intake bullets. THE PHASE 3 SHADOW BUILD IS COMPLETE (concerns 1–4 merged). Next step — INFORMATIONAL OWNER STOP (no blocking gate): the owner sets ATLAS_INTERACTION_TRACE=shadow on Render and trains normally ~a week; then run `npm run atlas:divergence -- <logfile>` over the collected `[coach-turn-shadow]` logs to publish the divergence summary. Phase 3's DONE-WHEN (the packet assembles for essentially every turn across several real sessions and the divergence list is stable and understood) awaits that real-session data; Phase 4 (make the live route consume the packet, retiring route-local recomputation as the divergence list clears) begins on the owner's go-ahead. PHASE 3 CONCERN 4 ✅ DONE 2026-07-21: built the nightly divergence report — services/coachTurnDivergence.js (pure parse/analyze/format) + scripts/atlas-divergence.js (`npm run atlas:divergence -- <logfile>`, or read the log stream from stdin; add --json). It parses the deployment's `[coach-turn-shadow]` records and lists every place production contradicted or bypassed packet truth: null embedded facts (decision/session/safety/exercises — the H-03/H-08/H-12/H-11 route-local recomputation, the report's headline), bypassed non-structural spine stages (knowledge_retrieval — H-06/Phase 6; parser/write_proof are structural on the read-only route and excluded), invalid packets, core-stage spine gaps, and the visible-reply-vs-null-decision contradiction — framed as the Phase-4 TODO. Read-only, deterministic, never a false green (0 records ⇒ 0 turns). Tests: test/coachTurnDivergence.test.js (parse robustness incl. Render log prefixes/malformed lines; aggregate analysis; CLI file + --json). Discoverable in CLAUDE.md's Operational-status section. Full suite green; all drift guards green. PHASE 3 CONCERN 3 ✅ DONE 2026-07-21: assembled the full CoachTurnPacket in shadow for every real /api/coach/message turn (keyed by the same minted turn_id) and logged packet vs visible response SIDE BY SIDE — services/coachTurnPacketShadow.js (assembleShadowPacket + observe), wired into routes/coachOps.js's response-finished hook via a shadow-only res.json capture wrapper (best-effort, log-only, response byte-identical). The packet is deliberately sparse — it populates only what the read-only route produces canonically today (athlete.profile_goal, already normalized to the canonical goal vocabulary) and leaves session/exercises/decision/safety/closeout null/[] (H-08/H-11/H-03/H-12), which is the bypass the divergence report surfaces and Phase 4/5 retires (understating is safe — H-05/H-15). This graduated services/coachTurnPacket.js AND its five embedded contracts (athleteContext, workoutSession, exerciseIdentity, safetyDecision, closeoutTransaction) from the staged wiring-allowlist (semantically reachable via the shadow; ceiling ratcheted 14→8). Proven through the live seam: test/coachTurnPacketShadowRoute.test.js (inert with flag off; valid packet + zero behavior change with flag on; packet id == trace id; no Sheet write) + unit test/coachTurnPacketShadow.test.js; full suite 6064 green; all drift guards green. PHASE 3 CONCERN 2 ✅ DONE 2026-07-21: threaded the ONE minted turn_id through the remaining coach-handler stages — services/interactionTraceShadow.js now assembles the full spanning InteractionTrace (intent → session_snapshot → engine_decision → coaching_strategy → model_response → validator_result → rendered_output; parser/knowledge_retrieval/write_proof legitimately absent on the read-only route → surfaced as `missing`, the raw material for the divergence report) for every real /api/coach/message turn, keyed by the single turn_id, and logs it as one structured `[interaction-trace]` line when the response finishes (res.on('finish'), best-effort, log-only, response byte-identical). `beginTurn()` replaced the intent-only `observeTurnStart`. Proven through the live seam: test/interactionTraceShadowRoute.test.js (inert with flag off; full spine + zero behavior change with flag on) + extended unit test/interactionTraceShadow.test.js; full suite 6048 green. PHASE 3 CONCERN 1 ✅ DONE 2026-07-21: minted ONE turn_id at the first trusted boundary (POST /api/coach/message) and opened the InteractionTrace in shadow — services/interactionTraceShadow.js (flag ATLAS_INTERACTION_TRACE=shadow, default inert; log-only, no Sheet write; never affects the response), wired into routes/coachOps.js; this graduated services/interactionTrace.js from the staged wiring-allowlist (ceiling ratcheted 15→14). Phase 3's owner stop is INFORMATIONAL only (no blocking gate): "shadow is live and invisible; train ~a week; I'll publish the divergence summary." PHASE 2 ✅ COMPLETE 2026-07-21 — all Work items done and every Phase-2 drift guard red/green in CI: (WI-1) 1a semantic wiring guard + 1b ownership/connectivity inventory; (WI-2) all EIGHT canonical contracts ratified read-only (charter docs/CANONICAL_CONTRACTS.md; contracts staged in wiring-allowlist until Phase 3/4/5b/5d/5e/5g); (WI-3) the completion-ladder manifest — the single complete/partial/missing status retired, every capability in config/coaching/manifests/capabilities.json now carrying the nine-rung `ladder` (built, unit_tested, runner_wired, inputs_available, route_consumed, user_visible, validator_covered, live_proven, owner_accepted), assessed against the Work-item-1b inventory + real code (6 reach inputs_available, 10 unit_tested, 3 not-built; ZERO reach route_consumed — the One-Brain orchestrator is shadow/flag-gated, route-consumption is Phase 4), validateManifest enforcing shape+monotonicity+name-the-consumer, owner_accepted owner-gate-only, published table docs/CAPABILITY_COMPLETION_LADDER.md; (WI-4) paper hygiene — app.js freeze rule, closeout label, BACKLOG dating, the reconciled open-P0/P1 index at the top of BACKLOG, and the whole-item BACKLOG archive reconciliation; (WI-5) Drift Guards 1 authority / 2 banned-pattern / 3 wiring-hardened / 4 completion-ladder (scripts/check-completion-ladder.js, npm run check:ladder — no route_consumed/live_proven without a linked test/trace id; self-test proves it bites) / 6 paper-weight (size cap + staleness + auto-archive). PHASE 4 OWNER GATE — RUN 1 EXECUTED 2026-07-25, VERDICT **NOT YET**. Phase 4 REMAINS OPEN; Phase 5 does NOT begin. A **mock** Golden Session ran with ATLAS_TURN_PRECEDENCE=1 and SESSION_PLAN_SETS_WRITE_ENABLED=1; its temporary Log_Cleaned rows were removed through the verified undo, and SESSION_PLAN_SETS_WRITE_ENABLED is back to 0 (owner-confirmed 2026-07-25). **OWNER INSTRUCTION, RECORDED HERE TO GOVERN (2026-07-25): `ATLAS_TURN_PRECEDENCE=1` MAY REMAIN ENABLED in production after the gate run.** This is the standing authorization for that flag state, recorded in this plan because an owner instruction governs only once it lands here (CLAUDE.md) — an evidence document cannot supply it. It is an AUTHORIZATION, not a validation claim: byte-identity between flag states is proven only for the two H-03 decision-consumption seams, while the other paths the same flag gates (substitution rejection in index.js; warm-up deferral, scoped-prescription, next-up and clarification narrowing in routes/coachOps.js) change behavior BY DESIGN when it is on and are byte-identical only with the flag OFF, each carrying its own validation from the PR that landed it. SESSION_PLAN_SETS_WRITE_ENABLED stays 0 and is untouched by this authorization. Full evidence: docs/verification/PHASE_4_GOLDEN_SESSION_EVIDENCE_2026-07-25.md. DISPOSITIONS: (1) H-03 recommendation-explanation LIVE-PROVEN; (2) H-03 recovery-routing LIVE-PROVEN; (3) H-08A packet.session live-observed and schema-valid in production but NOT route-consumed and NOT live-proven — the live response still does not consume packet.session; (4) D10 REMAINS OPEN — the run proved one-turn route/packet referent alignment ONLY, delivering no cross-turn referent persistence and retiring neither the in-memory store nor the history fallback; (5) H-09 planned-vs-actual PARTIAL — acceptance, outcomes, closeout and sealing proven, but user-endorsed mid-session future-set revision capture FAILED; (6) closeout/seal forward path proven ONCE, undo→re-save/re-seal FAILED and unproven; (7) InteractionTrace gate requirement NOT MET — write_proof is absent BY CURRENT ARCHITECTURE (the coach trace ends on a read-only route, so the write happens on a different request), recorded as a successor issue for cross-route trace/write correlation rather than as missing log evidence. ISSUE #952 RULING: CLOSED as completed — the approved append-only Session_Plans persistence now captures accepted plan identity, substitutions, outcomes and closeout state, the movement-level planned-versus-completed data its original drift contract required; #952 is explicitly NOT superseded by the set-level revision defect, because the plan_deviation detector compares planned movement NAMES against completed movement NAMES and never consumes target loads/reps. LADDER: no capability promoted — the two proven seams are coach-route canonical-decision consumption seams, not manifest capabilities, so config/coaching/manifests/capabilities.json is unchanged and the published table still reads ZERO at route_consumed or higher; owner_accepted stays false everywhere. SUCCESSOR ISSUES OPENED (each its own concern and PR, none started): #1163 explicit user-endorsed future-set revision capture outside substitution; #1164 undo after sealed closeout incl. re-save/re-seal semantics; #1165 end-to-end trace correlation through write_proof; #1166 session recovery/re-save after undo; #1167 incoherent sandbag_persistence evidence (sessions_below:5, sessions_checked:5, sessions_considered:1); #1168 diagnostic append-range concurrency/reporting; #1169 redline safety not embedded in the packet; #1170 duplicate Intent_Shadow and recurring /api/log-modality 422. #1165 IN PROGRESS, SLICED — slice 1 ✅ LANDED 2026-07-24 (PR #1172, `services/turnCorrelation.js`): the server half of the cross-route turn↔write seam, shadow-gated, with a non-authoritative client claim resolved against a bounded issuance registry. It merged with TWO ACCEPTED P1 FINDINGS UNFIXED, recorded as #1173 (a merged PR thread is not where work gets selected from). #1173 ITEM 1 ✅ LANDED 2026-07-25 (preview-established binding): the pairing is now established at the PREVIEW and keyed on a server-minted `pair:` token returned on `x-atlas-turn-pairing`, retiring #1172's first-write-wins — which let the CLIENT choose which write a turn bound to and, worse, LOCKED THE LEGITIMATE WRITE OUT with `write_mismatch` when a turn id landed on the wrong same-session write, making a client bug cost LOST evidence rather than wrong evidence. The prerequisite #1173 flagged was CHECKED, NOT ASSUMED, and does NOT hold: `write_id` is shared between preview and approve on ONE of five write paths (`/api/log-workout`, app.js:6960→7506), is withheld from the dry-run by design on both `/api/complete-workout` paths (app.js:7113), is minted only after the preview on modality and bodyweight (app.js:6133, 7790), and is DELIBERATELY RE-MINTED mid-flow on the documented seal retry even where it is shared (app.js:7563-7568) — so a `write_id` key would have been correct on one route of five and would have re-created the very lockout it was meant to remove. The previewed `write_id` is therefore recorded as CORROBORATION (`previewed_write_id_match`) and never as a gate. A TOKEN ALONE IS ONLY A TURN-LEVEL BINDING, and the first cut of this card claimed a write-level one — Codex refuted that on review (#1174 r3649520130) and was right: a valid token on a DIFFERENT same-session payload was accepted, so the record proved only "this turn previewed something, and this write presented its token". Corrected in the same PR by a SERVER-COMPUTED payload identity: the preview fingerprints the write identity the server itself received (`session_id` + `date` + `log_rows`) and the live payload must reproduce it, depending on nothing the client mints, so it holds on every route rather than one of five; The fingerprint is DEFAULT-DENY over the whole payload; only `test_mode`, `write_id` and `correlation` are outside it, each being a field that provably differs between a preview and its own approve (app.js:7507, 7566). `effort_row` is INSIDE the fingerprint — it is write-affecting (index.js:2930) — and the seal retry's effort REMOVAL is one explicit permitted transition, legal only after this pairing has already accepted an exact-identity write; a CHANGED or newly-ADDED effort row is refused. (An earlier draft of this entry said `effort_row` was excluded outright, describing a superseded round of this same PR; corrected here because the plan is the sole work-selection authority and slice 2 must not implement the obsolete exclusion.) Codex also caught (P2) that superseding the pairing per preview was last-COMPLETION-wins while the client keeps the newest by INITIATION order (`previewRequestSeq`/`submitSeq`, app.js:6416/6881), so an older preview finishing last discarded the token the client kept — replaced by a bounded set of the turn's outstanding pairings. Honest ceiling, stated in the module: this proves "this turn previewed a write of exactly this identity, and this write presented that preview's token"; where no identity is computable the pairing degrades to turn-level and reports `payload_bound:false` rather than an assumed match. Neither form is cryptographic authorization, which no client round-trip can deliver. Evidence: `test/turnCorrelation.test.js` (+`unpaired`/`pairing_mismatch`/`pairing_exhausted`/`payload_mismatch`, overlapping-preview ordering, bounded outstanding pairings, seal-retry-not-locked-out, key-order-insensitive identity, unbound-degrades-honestly, token and fingerprint never logged, `write_mismatch` removal pinned), `test/turnCorrelationIntegration.test.js` (real-route preview→token→approve; unpaired, forged-token, and valid-token-on-a-different-workout live writes correlate NOTHING and still write their rows; seal-retry shape still joins; CORS exposure). #1173 ITEM 2 ✅ LANDED 2026-07-25 (closeout proof projections): the all-rows-duplicate branch correlates when `ledger_seal` or `session_plans_closeout` is present — because with the Session Plan lanes enabled it genuinely appends the closeout event and stamps the seal — but NEITHER envelope was in `PROOF_KEYS` and both are nested objects the scalar-only filter drops, so the record emitted for that branch reported zero rows and NO seal evidence at all: a trigger added without its evidence, unable to prove the very write it was added to capture. `PROOF_PROJECTIONS` now flattens each envelope to `<envelope>_<field>` under a closed per-envelope whitelist, namespaced so a projection can never collide with a top-level proof key, with every value still passing the same scalar-only filter (the whitelist decides WHICH fields, the filter decides WHAT SHAPE). `session_plans_closeout.plan_version` IS projected because it is hashed into `sessionPlanEvents.idempotencyKey` (services/sessionPlanEvents.js:74) and is therefore the closeout event's ROW DISCRIMINATOR — without it a session with more than one accepted plan version leaves the record unable to say WHICH `session_closeout` row was written, and the slice-3 artifact join could not substantiate its own turn→closeout claim; it was excluded in the first draft as "a plan token rather than write proof" and Codex corrected that (being the discriminator is what makes it write proof). It is CLIENT-SUPPLIED — minted client-side as `pv_`+UUID (src/app/planAcceptance.js `mintId`) and accepted by the server as anything matching `/^pv_.+/` straight off the request body (index.js:2842), so an intermediate claim of mine that it was "server-generated" was simply FALSE — and projecting it unvalidated made the record a pass-through for arbitrary client text up to the body limit; it is now gated on the canonical `pv_`+UUID shape, and a generic `MAX_PROJECTED_STRING_LENGTH` bounds EVERY projected string as a structural backstop, since each enumeration proving a field fixed-vocabulary is a property of code that can change. Deliberately NOT projected: the seal's `conflicting_write_ids` (array) and `diagnostics` (object), and — the load-bearing omissions — the seal's `error` and the closeout's `reason`, both of which carry an ARBITRARY exception message (index.js wraps a seal throw as `{ reason:'seal_error', error: String(error.message) }`; `sessionPlanCapture._capture` sets `reason: e.message`) that could carry a Sheet id or other internals into a telemetry line; the seal's own `reason` IS projected because every value it takes in `sessionPlanSetsStore` is a fixed vocabulary literal, and the closeout's fixed vocabulary lives on `status`. Evidence: `test/turnCorrelation.test.js` (seal and closeout projections incl. an honestly-projected FAILED seal; closed-projection proof that diagnostics/ids/error text never survive; nested-value-on-a-whitelisted-field still dropped; non-object envelope projects nothing and never throws; namespacing proven collision-free against `PROOF_KEYS`). Item 2's review ALSO corrected two P2s rather than deferring them: (a) the `buildWriteProofRecord` contract still declared that every proof field is copied verbatim and never renamed, which the projection loop contradicts — now split into the two mechanisms it actually has (top-level = verbatim under `PROOF_KEYS`; envelopes = deliberately renamed projections that ADD namespaced keys and never reshape a W1–W3 field), because a stale invariant is worse than none; (b) the headline unit fixture combined a successful stamp's `sheet_written:true`/`sealed:5` with the all-sealed branch's `reason:'all_sealed'` — a state `sealCloseout` CANNOT return — so every fixture is now an attainable shape copied from `sealCloseout`/`_envelope`, including the distinguishable idempotent all-sealed replay. COVERAGE: item 2 was drafted unit-only with the route proof deferred to item 3; Codex answered the explicit question and it was FOLDED FORWARD — `test/turnCorrelationIntegration.test.js` now drives the REAL all-rows-duplicate branch (duplicate composite key, no Effort row, `closeout_context` present) and asserts the projections against the SERVED body so the record cannot drift from it. Honest limit stated in the test: both lanes are OFF in that harness, so it proves the wiring and projection against a dry-run seal (`dry_run:true`, `status:'disabled'`), NOT a live stamp. #1173 ITEM 3 ✅ LANDED 2026-07-25 (duplicate-closeout branch proven live): the branch's correlation gate had rested on reasoning alone, because exercising it needs the Session Plan lanes enabled and a seal fixture. New `test/turnWriteProofCloseoutIntegration.test.js` (sandbox posture built from `test/closeoutSealIntegration.test.js` — both lanes live against a STUBBED Session_Plan_Sets tab, nothing real reachable since sheets.js is replaced; a separate file so the 400-line owner-directive seal suite is not perturbed by enabling the correlation shadow globally) drives the REAL all-rows-duplicate branch and proves what the lanes-OFF case could not: the gate fires on a genuine SEALED SIDECAR WRITE (`ledger_seal.sheet_written:true`, positive `sealed` count, a real `updateColumnCells`, a real Session_Plans append) while ZERO Log_Cleaned rows are appended, and the projected evidence reports it truthfully — asserted against the SERVED body so the record cannot drift from the response. Two further honesty cases: an idempotent replay that seals nothing new stays DISTINGUISHABLE from a fresh stamp in the record (`sealed_ok:true` + `sheet_written:false` + `sealed:0` + a positive `already_sealed`), so an artifact can never read a replay as a new sealed write; and a CONFLICTING seal fails closed with `sealed_ok:false`/`closeout_fully_verified:false` carried into the record while the foreign closeout's write id — an array the projection does not whitelist — never reaches it. #1173 IS NOW COMPLETE (all three items). REMAINING ON #1165: slice 2 (client round-trip), which the plan records as BLOCKED on retiring the pairing-eviction gap; then slice 3 (the artifact script joining `[interaction-trace]` and `[turn-write-proof]` on `turn_id`, plus the closeout/seal join). SLICE-3 CONSUMER NOTE: a projected field that fails its validator is currently DROPPED, so a consumer cannot distinguish "present but withheld as malformed" from "absent"; if the artifact join needs that distinction, slice 3 is where an explicit withheld marker belongs (deliberately not added inside item 2, which would have changed the reviewed head). SECOND REVIEW ROUND on the same PR produced two more real findings, both fixed or recorded rather than waved off: (a) P1 — the payload fingerprint was a default-ALLOW list (`session_id`+`date`+`log_rows`), but `/api/log-workout` also APPENDS `effort_row` (index.js:2930) and drives the closeout capture and ledger seal from `closeout_context` (index.js:3172, 3320), so a live request could change either and still be reported `payload_bound:true`; the fingerprint is now DEFAULT-DENY (the whole payload minus `test_mode`/`write_id`/`correlation`, each of which provably differs between a preview and its own approve), with the seal retry's effort REMOVAL as ONE explicit permitted transition that still refuses a CHANGED or newly-ADDED effort row. (b) P2 — NOT CLOSED, recorded as a **REQUIREMENT ON SLICE 2**: pairing eviction is still by COMPLETION order, so a finite set cannot GUARANTEE it keeps the pairing the client kept — if more than `MAX_OUTSTANDING_PAIRINGS` previews overlap AND the newest-initiated completes first, its token is evicted first while the client discarded every other response by initiation sequence. Raising the cap (now 8) shrinks the window but cannot remove it; only INITIATION IDENTITY or explicit retirement FROM THE CLIENT can, and inventing that field inside item 1 would design slice 2's contract from the wrong end. **Slice 2 must therefore carry a preview initiation nonce (or explicit retirement) and retire this gap.** The failure mode is bounded and one-directional — a LOST correlation, never a wrong one, and the write proceeds untouched — so no record can overclaim because of it. THIRD REVIEW ROUND produced two more real P1s, both fixed: (a) the effort-removal transition was permitted unconditionally, so the VERY FIRST live request could silently omit the previewed Effort append and still be recorded `payload_bound:true` having never performed the previewed write — it is now gated on the pairing having already accepted an EXACT-identity write (the real retry cannot precede one: app.js deletes `effort_row` only after a committed write returned `closeout_fully_verified:false`, app.js:7563-7567), and the relaxed match is recorded as `effort_transition` so a reviewer can tell an exact binding from a relaxed one; (b) only the TOP-LEVEL session was checked, but `normalizeLogRowObject` resolves each row as `row.session_id || row.sessionId || topLevelSessionId` (index.js:449) — a row-level id WINS — and an array `effort_row` is written verbatim (index.js:541-545), so a request could write rows under session B while the record named session A, i.e. cross-session contamination inside the evidence itself; every EXPLICIT row-level and effort-row session identity must now equal the bound session or the correlation is refused, at preview as well as on the live write. FOURTH REVIEW ROUND found the third path in that same gate (also P1, fixed): `log_rows` also accepts the POSITIONAL Log_Cleaned array form, where `logRowArrayToObject` sets `session_id: row[1]` with NO top-level fallback (index.js:512), so a positional row's session is ALWAYS explicit — including an empty one, which is written as an empty session_id rather than inherited — and skipping non-object rows left it wholly unchecked; the check also failed OPEN on a PRESENT non-string session, because `normalizeLogRowObject` accepts any TRUTHY value while the gate tested for a string. Both shapes are now compared by rendered value (fail-closed), with object-row FALSY values correctly treated as inheriting the already-checked top level and whitespace correctly treated as a real mismatch (truthy, so it wins the `||`). FIFTH REVIEW ROUND found the fourth shape (also P1, fixed): the OBJECT-form `effort_row` has semantics OPPOSITE to an object log row — `normalizeEffortRow` selects aliases by PROPERTY PRESENCE via `effortRowFieldAliases` (`hasOwnProperty`, index.js:548-555), not truthiness — so a FALSY `session_id` is written VERBATIM to the Effort session column rather than inheriting, and reusing the log-row truthiness rule skipped exactly those values; the comparison now uses presence and the SAME alias normalization selects (first present, in the contract's own order, sourced from `config/columns` so a new alias is covered automatically). ENUMERATION AUDITED AND CLOSED for session identity: object log rows, positional log rows, array `effort_row`, object `effort_row` — and `closeout_context` verified as NOT a fifth path, because `recordCloseoutEvent` (index.js:2847) and `sealCloseout` both take the TOP-LEVEL `session_id` explicitly while the context supplies only `plan_version` and `items`. SIXTH AND SEVENTH ROUNDS closed two more (both fixed): a PREVIEW record reported `payload_bound:true` merely because an identity was computable, before any live payload existed to compare — it is now true only after a live comparison actually matched, so a preview-only flow can never publish the write-level claim; and the session gate TRIMMED before comparing, making it MORE PERMISSIVE THAN THE WRITE PATH, which writes row sessions verbatim (`normalizeLogRowObject` keeps the truthy value; positional Log and Effort rows pass straight through) and does not trim the top-level `session_id` either (index.js:2865) — so `'S1 '` matched a bound `'S1'` while the row was appended under `'S1 '`. Padded session values are now REFUSED rather than normalized, at row level and top level alike, because equivalence-by-trim is not a property the write path has. Row-level `date` is deliberately NOT gated: it cannot contaminate the session the record names, and the payload fingerprint already covers it for write-identity purposes. THEN #1165 slice 2 (client round-trip) — BLOCKED UNTIL #1173 item 1 landed, because the binding contract determines what the client must carry; that unblocks now, and until it ships NO LIVE WRITE CORRELATES (previews still do), which is fail-closed and deliberate. THEN slice 3 (artifact script joining `[interaction-trace]` and `[turn-write-proof]` on `turn_id`, plus the closeout/seal join). NOT TOUCHED, OWNER-RESERVED: on the zero-committed-rows partial path the response body reads `sheet_written: true` while nothing was written — pre-existing route behaviour, and W1–W3 proof fields are owner-reserved, so the correlation is gated on committed-row evidence instead of reshaping it. Gates passed: install, Phase 1 Soul gate (2026-07-20 PASS). Streak: 0/5.`

> Update this exact block in every campaign PR. Format: `CAMPAIGN STATE: Phase <n> — <name>. Next step: <step>. Gates passed: <list>. Streak: <k>/5.` (Phase 0 completed with the install PR.)

### The five rules

1. Green checks merge themselves. No owner merge approvals, ever. Owner involvement is gates only.
2. The freeze holds. Phases 2–7 do not start until the Phase 1 owner gate passes.
3. One authority. The reference spec is input; the executable truth is this embedded campaign. No second roadmap may ever be created.
4. The trust loop is untouchable. Preview→approve→write, no silent writes, owner gates for anything touching live data.
5. Drift guards are grow-only. A guard, once added, is never removed or weakened without an owner instruction recorded in this plan.

### The Golden Session (defined once, used three times)

One scripted two-exercise workout: plan from history → accept → log normally → human reply or deliberate silence → ask why → fatigue or substitution → revise → close out once → seal → reload → review. It is the Phase 1 gate (does it feel like a coach?), the Phase 4 gate (does it run through one packet and one trace?), and a permanent Phase 7 regression test. It is now a reusable fixture — `test/fixtures/goldenSession.js` (the scripted beats + behavioral expectations) — replayed through the real seam by `test/soulGoldenTranscripts.test.js` and available for the Phase 4 live run.

### Phase 1 — Soul Recovery (Issue #1073, exactly as written)

- **GOAL:** the workout conversation feels like a knowledgeable, history-aware human coach; the receipt dies.
- **WORK:** (1) ✅ the required recovery audit — map every live workout voice path from user input to rendered output (plan/acceptance, set and exercise logging, routine reaction, deviation/PR/fatigue/substitution/pain/safety, in-session question and correction, next-exercise handoff, closeout), recording for each the facts assembled, whether the model is called, which persona/prompt is used, any deterministic prose that can override it, available conversation history, and the production output; publish it. **Published 2026-07-19 at [`docs/SOUL_RECOVERY_AUDIT.md`](SOUL_RECOVERY_AUDIT.md).** (2) ✅ The first implementation slice exactly as the issue defines: remove "On plan — logged." from the normal path; a routine block gets either a brief, fact-grounded, model-authored reply or deliberate silence chosen from session state; bounded context; honest outage degradation; templates outage-only. **Landed in PR #1077 — a routine block is now met with deliberate silence; signal-carrying blocks keep their model-authored line; templates are outage-only.** (3) ✅ Deterministic and contract tests; the ten golden conversation transcripts scored on behavior, not wording; define the Golden Session as a reusable scripted scenario. **Landed: the reusable Golden Session fixture (`test/fixtures/goldenSession.js`) and the ten behavior-scored transcripts driven through the real `/api/coach/message` seam (`test/soulGoldenTranscripts.test.js`).** The remaining Phase 1 step is the OWNER GATE below.
- **OWNER GATE — gate script:** "Ready for a Soul gate workout: two exercises, normal session. Afterward tell me: pass or not yet; the moments that felt like a coach; the moments that broke character (quote the reply, then what a real coach would have said, or whether silence was right)." On "not yet," fix the named misses, rerun the transcripts, and offer another gate. On "pass," mark the gate, then begin Phase 2.
- **DONE WHEN:** the owner says pass after live sessions. ✅ **PASSED 2026-07-20** — after gate 1 ("not yet": silence-on-routine was awkward), the fix (a completed on-plan block speaks a brief data-grounded line, timed to the exercise; intermediate per-set logs stay quiet) earned the owner's pass. Follow-up filed: optionally wire the coach model to author the on-plan line (currently deterministic).
- **CLOSES:** H-02; first bite of H-16.

### Phase 2 — Inventory, contracts, and clean paper (no behavior changes) — ✅ COMPLETE 2026-07-21

- **WORK:** (1) Extend `scripts/check-wired-modules.js` from file reachability to semantic reachability (does output affect a user-visible decision?) and publish one ownership/connectivity inventory covering every route, service, client module, flag, Sheet tab, and planning document, with a keep/adapt/retire column. (2) Ratify eight canonical contracts as versioned schemas with docs: WorkoutSession, AthleteContext, ExerciseIdentity, CoachingDecision, CoachTurnPacket, SafetyDecision, CloseoutTransaction, InteractionTrace. (3) Replace the capability manifest's single status with completion-ladder fields: built, unit-tested, runner-wired, inputs-available, route-consumed, user-visible, validator-covered, live-proven, owner-accepted. (4) Paper hygiene: shipped items from BACKLOG.md to the archive; an open-P0/P1 index at the top; current-as-of dates and historical banners on active docs; adopt the app.js freeze rule (no new session-state logic in app.js); label closeout reconstruction "recovery-only — verify every row." (5) Build Drift Guards 1, 2, 3, 4, and 6 (below).
- **OWNER GATE:** none.
- **DONE WHEN:** contracts merged, inventory published, backlog index exists, manifest speaks ladder, guards red/green in CI. ✅ **All met 2026-07-21** — eight contracts ratified; `docs/ATLAS_OWNERSHIP_CONNECTIVITY_INVENTORY.md` published; open-P0/P1 index atop `BACKLOG.md`; the manifest speaks the nine-rung ladder (`docs/CAPABILITY_COMPLETION_LADDER.md`); Drift Guards 1/2/3/4/6 all red/green in CI.
- **CLOSES:** H-05, H-15, H-22; advances H-07, H-17, H-20, H-21.
- **OWNER RULINGS (2026-07-20, recorded here to govern — Work item 2 is now decomposed and sequenced by the owner):**
  1. **Sequencing.** All eight canonical contracts are ratified. Do the *rest* of Work item 2 in two batches: **first** paper hygiene (item 4) and Drift Guards **1, 2, 3, and 6** — quick, and they protect the repo while the harder work happens; **then** the completion-ladder manifest (item 3) plus Drift Guard **4** (the completion-ladder validator) as **its own fresh session**.
  2. **Ladder rung rule (item 3, applies in the fresh session).** When a capability is genuinely ambiguous between two completion rungs, assign the **lower** one — understating is safe; overstating is the disease being cured (H-05/H-15).
  3. **Ladder `owner-accepted` rule.** Only an explicit **owner gate** may ever set `owner-accepted` = true. No agent may self-assign it under any circumstance.
  4. **Guard 2 "receipt template" definition.** A *receipt template* means a **contentless acknowledgement** (e.g. "On plan — logged."). A brief, data-grounded, fact-carrying wrap line — the Phase 1 Soul-gate fix's `templatedOnPlanWrapLine` (`src/app/coachVoiceTemplates.js`) — is **not** a receipt template and stays legal. Guard 2 must be written to that definition.
  5. **Publish the ladder table.** When item 3 lands, publish the completion-ladder table (one row per capability, its rungs) so the owner can skim it.

### Phase 3 — Shadow the packet and the trace (zero behavior change) — ✅ COMPLETE 2026-07-23

- **WORK:** mint one turn ID at the first trusted boundary and carry it through parser result, intent, session snapshot, engine decision, knowledge retrieval, coaching strategy, model response, validator result, rendered output, and write proof. Assemble the full CoachTurnPacket for every real turn in shadow; log packet and visible response side by side; produce a nightly divergence report listing every place production contradicted or bypassed packet truth.
- **OWNER GATE — gate script:** "Shadow is live and invisible. Train normally for about a week; I'll publish the divergence summary when the data is stable." (Informational stop only; resume on any owner go-ahead.) ✅ **Owner ran `ATLAS_INTERACTION_TRACE=shadow` and trained; go-ahead given.**
- **DONE WHEN:** the packet assembles for essentially every turn across several real sessions and the divergence list is stable and understood. ✅ **MET 2026-07-23** — closed on production evidence from Flight Recorder session `FR-20260723120852-hw56ws9y` (deployed SHA `749e136619ee22f2b4d558abc5dc1b282c530585`). `npm run atlas:divergence` was run over the collected `[coach-turn-shadow]` records; the final divergence summary is published at [`docs/verification/PHASE_3_DIVERGENCE_SUMMARY_2026-07-23.md`](verification/PHASE_3_DIVERGENCE_SUMMARY_2026-07-23.md). The packet assembles (schema-valid) for every shadowed turn, and the divergence list is stable and understood — every reported contradiction reconciled to Phase 4 (H-03/H-08 decision/session route-local; the all-six prescription dump; a warm-up question misread as a set-count restatement; a malfunction complaint invoking substitution; a substitution contradicting active-plan truth; a stale diagnostic replay; the route cascade; the spine gap on ordinary follow-ups), the Phase 4 punch list (route-local discussion referent → `discussion_referent` packet field), Phase 5b (ExerciseIdentity — H-11), Phase 5d (SafetyDecision — H-12), Phase 6 (knowledge_retrieval / warm-up-protocol content — H-06), or a documented non-issue (the deterministic recovery on turn 2 = positive evidence; the atomic gated replacement, PR #1134, = the final narrow Phase-3 stabilization PASS: one proposal, RDL kept before approval, five unrelated exercises unchanged, no writes).
- **CLOSES:** H-14; sets up H-03.

### Phase 4 — The canonical proof

- **WORK:** behind a flag, make the live coach route consume the CoachTurnPacket, retiring route-local recomputation as the divergence list clears. Deterministic fallbacks so every state-answerable question (e.g. "what's next?") answers from the WorkoutSession even with the model down. Enforce the session-priority invariant with the collision-phrase pack: exact historical phrases, paraphrases, model up and down. Build Drift Guard 5. Prepare the Golden Session live run with planned-set capture end to end.
- **PUNCH LIST — discussion referent as a packet field:** promote the disputed-lift referent (which lift a bare correction like "that isn't what you planned" resolves to) to a first-class field. Today the coach route records the last-discussed lift in an in-memory, freshness-bounded store (`services/coachDiscussionReferent.js`) and the dispute resolver recovers it heuristically (`services/coachResponseGrounding.resolveDisputedLiftEntry` tiers 2–3: the server-recorded referent, then a bounded scan of the recent athlete turns). Phase 4 sets `discussion_referent` on the CoachTurnPacket / WorkoutSession at answer time, so the resolver collapses to a single state read and both the store and the history scan retire. The Phase-3 shadow already surfaces the gap: `npm run atlas:divergence` reports **route-local referent** (the route picked a referent the packet does not carry) and, once the field exists, **referent MISMATCH** — those clear as this lands.
- **OWNER GATE — gate script, in two steps:** (a) "Everything is staged. Set SESSION_PLAN_SETS_WRITE_ENABLED=1 on Render, then say go." (b) after the gate workout: "Tell me: pass or not yet; what held up or didn't in the transcript and trace; and your Issue #952 ruling — close, supersede, or rewrite." On "not yet," fix, rerun in test, offer another gate; suggest returning the flag to 0 if unneeded meanwhile.
- **GATE RUN 1 — 2026-07-25, verdict NOT YET (phase stays open).** A mock Golden Session exercised the staged seams live. Proven: both H-03 canonical-decision consumption seams (recommendation-explanation, recovery-routing). Not proven: `packet.session` is observed and schema-valid but still unconsumed by the live response; D10 showed one-turn referent alignment only; H-09 is partial (the endorsed set-level revision was not captured); the closeout seal holds forward but not through an undo; and the first-word→sealed-write trace cannot exist yet because `write_proof` is absent by architecture — the coach trace ends on a read-only route. Issue #952 closed as completed on the movement-level planned-versus-completed data; eight successor issues opened (#1163–#1170). Full evidence: [`docs/verification/PHASE_4_GOLDEN_SESSION_EVIDENCE_2026-07-25.md`](verification/PHASE_4_GOLDEN_SESSION_EVIDENCE_2026-07-25.md).
- **DONE WHEN:** the Golden Session passes with the owner satisfied, and one reviewable trace spans first word to sealed write.
- **CLOSES:** H-03, H-08, H-09, H-16, H-18.

### Phase 5 — Consolidate and delete (parallel tracks a–g)

- **a. MODULE DECISION DAY.** Prepare a one-card pack for each of the eight allowlisted modules in `config/wiring-allowlist.json`: what it does, what now duplicates or supersedes it, recommendation (wire / merge / reclassify as test tooling / delete) with reasoning. **OWNER GATE — gate script:** "Module Decision Pack is ready — reply with a ruling per module and 'proceed'." Execute rulings one PR per module until the allowlist is empty.
- **b. IDENTITY RULING DAY.** Prepare the pack of all 32 residual identity divergences from `docs/EXERCISE_NAME_UNIFICATION_MIGRATION_PLAN.md`, each with a proposed answer and one line of reasoning. **OWNER GATE — gate script:** "Identity Pack is ready — confirm my proposals or override by number, then 'proceed'." Then implement the immutable ExerciseIdentity registry; every other representation becomes an alias or projection; migrate name-keyed joins; remove duplicate naming authority.
- **c. DELOAD:** consolidate to the load-cut model with one DeloadLifecycle governing selection through return-to-normal; wire or delete the begin/advance/resolve endpoints; close Issues #289 and #291.
- **d. SAFETY:** one SafetyDecision contract consumed by the live route and the Brain alike; retire duplicate classifiers. Presentation may differ; the decision may not.
- **e. LAYERED CONTEXT:** session-scoped constraints with expiry ("avoid legs today") layered over durable rules; plumb training level, equipment profile, and readiness from their defined sources; close Issue #914. Finishes H-07.
- **f. ONE BRAIN:** publish the live decision-ownership map; per promoted decision type, delete its legacy analytics delegation. No permanent shadow or legacy lanes.
- **g. HYGIENE:** remove the closeout reconstruction lane once buffer capture is proven; render the completed-session pin as session state ("Session complete — 9 sets"); rename engine mode "brian" to "brain" with a dual-accept window — **OWNER GATE — gate script:** "Dual-accept is live. Change ATLAS_COACH_ENGINE from brian to brain on Render and say done," then retire the old string; finish the app.js extraction; land remaining doc banners.
- **DONE WHEN:** the ownership map shows one owner per concept and the staged-module allowlist is empty.
- **CLOSES:** H-04, H-06, H-07, H-10, H-11, H-12, H-13, H-17, H-19, H-21, H-23; finishes H-20.

### Phase 6 — Wire in the research

- **WORK:** convert `docs/research/coaching-intelligence` into versioned knowledge records; map reason codes and question types to records; retrieve two to six high-signal records per turn into the CoachTurnPacket; record knowledge IDs and applicability in the InteractionTrace; validator checks every science-bearing claim against retrieved records; deprecate static duplicate cards; same system for planning, live interpretation, and Q&A.
- **OWNER GATE:** none formal — invite the owner to ask hard "why" questions in real sessions and report anything generic or wrong.
- **DONE WHEN:** answers cite retrievable records in the trace and the validator gates the claims.

### Phase 7 — Prove the whole product

- **WORK:** full-session behavioral tests; all Soul corpus sessions as meaning-based acceptance tests; varied synthetic athletes; outage, retry, and reload tests; correction and trust-repair tests; the Golden Session as permanent regression. Open the five-session owner streak in the plan.
- **OWNER GATE — after each owner session, gate script:** "Session verdict? 'Session N of 5: clean' or 'miss: <what happened>'." A clean session advances the streak; a miss resets it to zero and its cause becomes the next card.
- **DONE WHEN:** the streak reaches five. Mark Atlas healthy in the execution plan and check every definition-of-healthy gate: one owner per concept; one route for intelligence; no silent capability claims; templates outage-only; complete traceability; cross-surface agreement; owner acceptance.

### Drift guards

Each is a CI check that fails the build; a rule that lives only in a document is not a guard; the list is grow-only and published in `CLAUDE.md`.

1. **AUTHORITY CONSISTENCY** (build in Phase 2): one declared active-campaign line must match exactly across `CLAUDE.md`, the execution plan, and the docs index; every open issue labeled `owner-instruction` must be referenced in the plan; otherwise CI fails.
2. **BANNED-PATTERN GUARD** (Phase 2; grow-only list): forbidden in production paths — normal-path receipt templates (**"receipt template" = a contentless acknowledgement per the 2026-07-20 owner ruling; a brief data-grounded wrap line such as `templatedOnPlanWrapLine` is not a receipt and stays legal**); route-local recomputation of packet-owned facts; legacy analytics imports for promoted decision types; duplicate safety classifiers; session-truth selectors outside WorkoutSession. Add each pattern as its finding is retired.
3. **WIRING GUARD HARDENED** (Phase 2, enforced fully after Phase 5): the allowlist becomes shrink-only; new entries require an owner-gate note; expiries fail red — never auto-extend.
4. **COMPLETION-LADDER VALIDATOR** (Phase 2, ✅ BUILT 2026-07-21 — `scripts/check-completion-ladder.js`, `npm run check:ladder`): no capability may claim route-consumed or live-proven without a linked test or trace ID; it also fails a structurally invalid ladder (nine boolean rungs, monotonic, a named consumer at route-consumed or higher). A synthetic-violation self-test (`test/completionLadderGuard.test.js`) proves the guard actually fails on an unsubstantiated claim.
5. **PACKET AND TRACE CONTRACT TESTS** (Phases 4–5): every full-session test asserts the visible reply was produced from a schema-valid CoachTurnPacket and that one turn ID spans input through write proof. ✅ **FIRST INCREMENT BUILT 2026-07-24** (`scripts/check-packet-trace.js`, `npm run check:packet-trace`): the shadow anti-overclaim honesty guard — `assembleShadowPacket` may never report a packet valid that isn't, nor claim an embedded fact (session/decision/safety/closeout/exercises) present that does not validate under its own canonical contract (an underclaim is safe), nor emit a trace whose `missing`-stage list is dishonest; synthetic-violation self-test `test/packetTraceGuard.test.js`. The fuller remit — every full-session test asserting the visible reply came from a schema-valid packet with one turn ID spanning input→write proof — lands as the live route consumes the packet (Phases 4–5).
6. **PAPER-WEIGHT GUARD** (Phase 2): CI fails when BACKLOG.md exceeds its size cap or contains shipped items older than seven days; an auto-archive job keeps it clean.

### The heartbeat (recurring cards, created at install)

- Monthly, and after any batch of coaching-path PRs: one owner verdict workout using the gate-verdict script. The owner's session is the one detector no agent can fake.
- Quarterly: re-run the whole-system health audit read-only and report deltas against the 23 findings. New findings enter the backlog; they never spawn a new roadmap.

### Findings reference (the 23; full detail in the Complete Health Report)

H-01 conflicting execution authority (closed by this install) · H-02 routine coaching receipt bypass (P1 phase 1) · H-03 no Coach Turn Packet (3–4) · H-04 One Brain not one owner (5) · H-05 manifest overstates capability (2) · H-06 eight dark modules (5) · H-07 athlete context incomplete (2+5) · H-08 multiple current-workout truths (4) · H-09 planned-vs-actual unproven (4) · H-10 deload split (5) · H-11 five exercise identities (5) · H-12 safety multiple owners (5) · H-13 no session-only constraints (5) · H-14 telemetry islands (3) · H-15 "complete" ambiguity (2) · H-16 education outranks session (4) · H-17 closeout reconstruction lane (2+5) · H-18 outage forgets state (4) · H-19 pin mixes concepts (5) · H-20 mixed-era docs (0+2) · H-21 7,827-line app shell (2+5) · H-22 paperwork outgrew operators (2) · H-23 "brian" spelling (5).

## 5. Current-state summary

At plan installation:

- The core Atlas experience exists: conversation-first logging, preview-before-write, Google Sheets as the permanent record, session state, recommendations, coaching voice, Flight Recorder, and shadow telemetry.
- Soul criteria S1, S2, S3, S4, S6, and S7 are complete.
- The remaining Soul gate is **S5 / LT-010 required Part 1**: production evidence that routine activity stays routine and genuine engine-confirmed new ground earns elevated/max voice, with `ATLAS_COACH_PROFANITY` OFF.
- PR #1007 added bounded server-owned `decision_summary_json` to Flight Recorder for `/api/coach/message`.
- PR #1011 fixed the visible set/block response so signal-carrying engine modes are not collapsed into the generic acknowledgment.
- Therefore M1 begins as an **evidence/closeout task, not another Soul build**, unless the live re-validation proves a remaining defect.
- One-Brain GATE A remains a parallel evidence clock and never promotes automatically.
- Atlas stays Sheets-primary for V1. No Supabase/Postgres migration is part of this campaign.

## 6. Milestone M1 — Close Soul

### F01 — LT-010 production re-validation and Soul closeout

**Status:** ✅ COMPLETE (2026-07-16)

**Objective**

Prove the final required Soul behavior on deployed current `main`, record the evidence, and close Soul without adding more personality work.

**Current-state verification**

1. Confirm `main` contains PR #1007 and PR #1011.
2. Confirm the deployed `/version` matches current `main` or a commit containing both fixes.
3. Confirm `ATLAS_COACH_PROFANITY` is OFF.
4. Inspect `docs/TEST_QUEUE.md` LT-010 before running anything.

**Required evidence — LT-010 Part 1 only**

- **Routine case:** log an ordinary on-target set/block. Visible reply stays brief and matter-of-fact. Flight Recorder records routine/silent-or-neutral mode and routine register.
- **Earned case:** during genuine owner training, log a real engine-confirmed new-ground set. Visible reply reflects the earned mode; Flight Recorder records the corresponding celebrate/elevated-or-max decision and bounded facts.
- **Forgery/control:** a typed claim or client-shaped fake PR does not manufacture new-ground telemetry or elevated voice.
- **Profanity:** remains OFF. The optional profanity experiment is not required and must not be run without a separate explicit owner decision.

**Allowed implementation**

None unless the production evidence fails. If it fails, file the exact mismatch, reproduce through the closest deterministic route test, and fix only that seam.

**Acceptance criteria**

- Required LT-010 Part 1 is marked PASS in `docs/TEST_QUEUE.md` with deployed commit, Flight Recorder session/reference, routine evidence, earned evidence, and owner verdict.
- This plan records F01 complete and M1 complete.
- No optional profanity activation, tone-dial work, drift challenge, Moments work, or new Soul feature is bundled.

**Owner gate**

The genuine new-ground event must come from real owner training. Claude may perform read-only deploy/recorder checks and analyze evidence, but must not fabricate the qualifying workout. **Owner override (2026-07-16):** Dale explicitly authorized a controlled production test for LT-010 — a synthetic recent baseline (written and undone via the trusted path) to clear the layoff condition, followed by the routine/false-PR/real-PR probes — overriding the "genuine owner workout only" restriction for this gate only.

**Completion record**

- PR: this PR (Soul closeout — records LT-010 Part 1 PASS)
- Commit: validated on deployed `cc8f42d` (current `main`; contains #1007 + #1011)
- Evidence: `docs/TEST_QUEUE.md` LT-010 Owner result — routine on-target set→`silent`; forged new-ground→stripped (`silent`); genuine new-ground→`celebrate`/`register.intensity:max`, `profanity_ok:false`; drawn from Flight_Recorder `decision_summary_json`. Synthetic baseline + test sessions written via the trusted path, verified, and fully undone (no leftover rows). The earlier "`celebrate` never fired" observation was confirmed to be the ratified mode-ladder gates (layoff/safety/challenge/scarcity) out-ranking `celebrate`, not a wiring defect. (Raw set values and production sheet ranges omitted per CLAUDE.md data-safety.)

## 7. Milestone M2 — Trust-seam hardening

Run F02 through F10 in order. Each card is one PR unless the Current-State Verification Gate proves the concern already shipped or must be split for safety.

### F02 — Closeout write-proof parity

**Status:** ✅ COMPLETE (2026-07-16)

**Finding:** `WRITE-1`

**Objective**

Make `/api/complete-workout` return and verify the same exact append proof expected from Atlas's trusted write paths instead of discarding Sheets append responses.

**Likely surfaces**

`index.js` complete-workout route, Sheets append helpers, write-proof tests, Effort/Log closeout integration tests.

**Acceptance criteria**

- Every successful closeout write reports exact authoritative appended ranges/counts for each affected tab.
- A success response cannot be emitted when proof is absent or inconsistent.
- Dry-run proof semantics remain unchanged.
- No schema change.

**Required tests**

Red-first route/integration coverage for exact proof, partial append failure, empty/malformed append response, and dry-run non-write behavior.

**Owner gate**

Code/tests are autonomous. Any real production canary write requires explicit authorization.

**Completion record:** PR — this PR · Commit — `/api/complete-workout` now captures the `appendRows` response for both `Log_Cleaned` and `Effort`, reports the authoritative `logAppendedRange`/`effortAppendedRange` + `log_rows_written`/`effort_rows_written` (from `updates.updatedRange`/`updatedRows`, matching `/api/log-workout`), and a fail-closed gate returns an explicit `sheet_write:'unverified'` (never `success`) when a range is missing or a count disagrees with what was sent. Dry-run proof unchanged; no schema change. Red-first route/integration tests in `test/api-smoke.test.js` (exact-proof, inconsistent-proof fail-closed, dry-run no-proof); full suite green (5456).

### F03 — Interrupted-closeout idempotency

**Status:** ✅ COMPLETE (2026-07-16)

**Findings:** `WRITE-2`, `WRITE-3`

**Objective**

A closeout interrupted before the client receives success must be safe to retry: no duplicate write and no 24-hour wedge caused by a stale in-progress reservation.

**Likely surfaces**

Idempotency/reservation services, complete-workout orchestration, restart/retry integration tests.

**Acceptance criteria**

- Replay after a confirmed completed write returns the original result without appending again.
- A stale/incomplete reservation is recoverable through deterministic reconciliation.
- Concurrent retries produce at most one real append.
- Failure states are explicit; no false save claim.

**Required tests**

Interrupted request, process-restart rehydration, concurrent retry, stale reservation, and completed replay.

**Owner gate**

No production write without authorization.

**Completion record:** PR — this PR · Commit — **WRITE-3:** `services/idempotency.js` tags in_progress records rehydrated from disk and `beginWrite` now downgrades a stale (`>5min`) rehydrated reservation to retryable — not only at load — closing the ≤24h post-crash wedge. **WRITE-2:** the closeout route reuses the server-minted `session_id` stamped in the prior idempotency record (new read-only `peekWrite`) instead of re-minting on retry, and the duplicate-session hard-stop now also covers a reused minted id, so the composite-key (Log) + duplicate-session (Effort) dedupes catch the replay (no full-workout double write). Red-first tests: beginWrite downgrade of an early-rehydrated stale reservation, `peekWrite` recovery, and a route-level reused-minted-id retry that refuses (409) and never re-appends. Full suite green (5460). No schema change.

### F04 — Ambiguous Google Sheets append recovery

**Status:** ✅ COMPLETE (2026-07-16)

**Finding:** `WRITE-5`

**Objective**

Prevent a retry after an ambiguous Sheets `values.append` failure (for example a 503 after the remote append may have succeeded) from duplicating rows.

**Likely surfaces**

`services/sheets.js`, idempotent write orchestration, append-response/read-back helpers, unit/integration fixtures.

**Acceptance criteria**

- Ambiguous append outcomes enter reconciliation, not blind retry.
- Reconciliation can prove already-written vs not-written using deterministic identity/proof.
- At-most-once behavior is pinned by tests.
- Normal unambiguous failures remain retryable where safe.

**Required tests**

503-before-write, 503-after-write, timeout/unknown outcome, matching read-back, non-matching read-back.

**Owner gate**

No production fault injection or write canary without authorization.

**Completion record:** PR — this PR · Commit — `sheets.js` `isTransientAppendError` no longer retries an **ambiguous 503** on `values.append` (the append may have committed before the backend failed to respond), matching its existing treatment of 500 / post-send timeout. Only unambiguous **pre-write rejections** (429 rate-limit, 403 quota) are retried in-request. Recovery for an ambiguous 503 defers to the upstream reconciliation: the `write_id` idempotency guard + composite-key (Log) / duplicate-session (Effort) dedupes — hardened for at-most-once by F02/F03 — so the client's retry re-appends only what is genuinely not yet written. Red-first tests pin 503-non-retryable + at-most-once (one attempt) and 429-still-retryable; the prior 503-retryable pin was flipped. No schema change. Full suite green (5462).

_Note: the card's read-back-reconciliation framing is satisfied by the existing route-level composite-key/effort-session dedupe (the deterministic identity that proves already-written vs not-written); the smallest safe fix is to stop the in-request blind retry that bypassed it, rather than duplicate that reconciliation inside `appendRows`._

### Owner-directed insertion (F04A–F04C)

Dale inserted three narrow owner-directed concerns between F04 and F05 (2026-07-16). One focused PR each; existing cards are **not** renumbered; the canonical plan stays the sole queue (no competing plan). Resume F05 after F04C merges.

### F04A — Retire the cold-review compatibility mechanism

**Status:** ✅ COMPLETE (2026-07-16)

**Objective**

Delete the retired cold-review gate now that `cold-review/exact-head` is off `main`'s required checks.

**Acceptance criteria**

- `.github/workflows/cold-review-gate.yml`, `scripts/cold-review-gate.js`, `test/cold-review-gate.test.js`, `docs/COLD_REVIEW_GATE.md` deleted; no code can publish `cold-review/exact-head`.
- No active document tells an agent to post a compatibility marker; all stale references removed/corrected.
- Policy preserved: deterministic CI checks are hard gates; Codex review is advisory; no paid reviewer, reviewer account, marker, or replacement identity gate; the deleted workflow is not replaced by another review-status workflow.
- Full deterministic suite passes.

**Completion record:** PR — this PR · Commit — deleted the 4 files; corrected references in `.github/PULL_REQUEST_TEMPLATE.md`, `docs/OWNER_CHECKIN_RULES.md`, `docs/DOCS_INDEX.md`, `BACKLOG.md`, and rewrote the governance test's cold-review assertions into an anti-revival guard (files absent + no marker language in active docs).

### F04B — Atlas Control Tower / agent operations contract

**Status:** ✅ COMPLETE (2026-07-16)

**Objective**

One canonical, agent-first status contract so any agent (Claude/Codex/ChatGPT/fresh) can answer "check Atlas / where are we / did the write+undo happen / is prod healthy" without Dale supplying spreadsheets, tabs, commands, session IDs, or doc paths.

**Acceptance criteria**

- Public **redacted** `GET /.well-known/atlas-status.json` — no Atlas browser API key required; bounded safe fields only (schema_version, generated_at, overall_status, deployed_commit, app_version, active_milestone/card, llm/sheets_connected, flight_recorder_enabled, latest_test/write/undo verdicts + freshness, synthetic_rows_remaining, owner_action_required/codes, source_freshness/unavailable_sources, status_reason_codes). Never exposes secrets, sheet IDs/ranges, workout/health data, Flight Recorder transcripts, emails, raw GitHub comments, or stack traces. Never fabricates health (missing/stale ⇒ unknown/degraded, never false green). Read-only (no write behavior).
- `npm run atlas:status` and `-- --json` from repo root; combines existing readers (local/main commit, deployed `/version`, plan active card, health endpoints, Flight Recorder + `scripts/flight-review.js`, governed Sheet config, latest trusted test + write/verify/undo, leftover-synthetic detection). Human form short/decisive; JSON form is the authoritative machine schema, same as the endpoint where practical.
- Discoverability wired into CLAUDE.md, AGENTS.md, `docs/AGENT_LIVE_TESTING.md`, `docs/FLIGHT_RECORDER_VALIDATION.md`, `docs/DOCS_INDEX.md`, README quick-start; one canonical `docs/ATLAS_OPERATIONS_CONTRACT.md` (schema/sources/freshness/redaction/fallback — not a work-selection plan).
- Anti-forgetting tests: command exists; CLAUDE.md/AGENTS.md point to it; schema leaks no disallowed/private keys; stale/missing ⇒ not-healthy; human and JSON agree; source failures not swallowed; endpoint never gains write; endpoint needs no browser key; newest-test selection; completed vs merely-attempted write/undo not confused; clean-checkout acceptance proving a fresh agent following AGENTS.md finds the command without being told the Sheet ID / tab names.
- No large dashboard, no Supabase/new DB/duplicate telemetry/second results ledger (a tiny optional Settings "Atlas Health" link only if essentially free).

**Owner gate:** Autonomous — no production write, schema, or credential change.

**Completion record:** PR — this PR · Commit — new `services/atlasStatus.js` (bounded/redacted assembler + pure plan/test parsers, closed-whitelist `ALLOWED_KEYS`, honest overall-status logic), `scripts/atlas-status.js` (`npm run atlas:status [-- --json]`, deployed-fetch with offline local fallback), public read-only `GET /.well-known/atlas-status.json` in `index.js` (+ `config/routes.js` entry), canonical `docs/ATLAS_OPERATIONS_CONTRACT.md`, discoverability wired into CLAUDE.md/AGENTS.md/AGENT_LIVE_TESTING.md/FLIGHT_RECORDER_VALIDATION.md/DOCS_INDEX.md/README, and anti-forgetting + clean-checkout acceptance tests (`test/atlasStatus.test.js` + endpoint case in `test/api-smoke.test.js`). Synthetic-row count is reported `null`+unavailable rather than run as a live authenticated scan on the public endpoint; the existing `POST /api/admin/preview-test-rows` remains the path for a real count. Full suite 5465 pass.

### F04C — Durable owner session (remove repeated key entry)

**Status:** ✅ COMPLETE (2026-07-16, live-validated on shell v137). Three live failures traced to one root cause: **client-side auth-state guessing.** (1) reload/reopen showed "Set your API key" because four modules gated on `getApiKey()` (empty after cookie migration) — patched to `isConnected()`. (2) v134/v135 then showed **split-brain**: Settings said "Atlas connected on this device" while Coach immediately said "Set your API key." The deployed cookie path is correct (login returns `Set-Cookie: atlas_session=…; HttpOnly; SameSite=Lax; Secure` and `/api/session/status` with the cookie returns `authenticated:true`, verified live via curl), but the client kept **two independent truths** — a Settings claim from the login POST and a synchronous `isConnected()` (`sessionActive`/persistent flag/key) that reset on reload. A persistent `atlas_connected` localStorage flag was a client-side *guess* about an HttpOnly cookie and was **rejected by the owner**. This redesign makes the client **server-authoritative**: the `atlas_connected` flag is removed entirely; a single `serverAuthState` (`unknown`/`authenticated`/`unauthenticated`) is written ONLY by real server responses (a protected `api()` 2xx or login → authenticated; a `api()` 401 / a sessions-enabled `/api/session/status` `authenticated:false` / logout → unauthenticated; a timeout/abort/transport failure changes nothing). `isConnected()` is optimistic (false only on a server-confirmed negative), so a cookie-only owner is never pre-blocked on a synchronous flag; protected reads are attempted and the SERVER's 401 (not a client flag) drives "Connect Atlas in Settings"; a network/cold-start failure shows a connection message, never a key prompt; Settings reflects the same `serverAuthState` so it can never disagree with Coach. Shell bumped v136→v137. Red-first browser tests in `tests/e2e/session-auth.spec.js` (cookie-only reload, delayed status, status-timeout-then-success, genuine 401, "Settings and Coach never disagree") fail on the old flag model and pass on the redesign. **Live-validated 2026-07-16 on shell v137:** authentication holds across normal refresh and close/reopen; the earlier apparent failures were from clearing Safari history/website data, which correctly clears the session (expected behavior, not a defect). No further authentication changes.

**Objective**

Replace `atlas_api_key` in `localStorage` + per-call `x-atlas-api-key` with a long-lived server-managed owner session so Dale authenticates once per device and app-shell/service-worker refreshes don't erase it — without exposing workout APIs publicly.

**Acceptance criteria**

- Authenticate once per device via the existing owner credential → server issues a signed **HttpOnly, Secure, SameSite** session cookie (≈90–180 day lifetime, honest rotation/expiry); browser calls authenticate via the cookie; JS cannot read the session secret; raw credential removed from `localStorage` after migration.
- Bounded legacy `x-atlas-api-key` acceptance during migration; a separate machine-auth route preserved for trusted local scripts (agents never scrape Dale's browser cookie); the public redacted Control Tower endpoint stays login-free; all workout reads/writes stay protected.
- Settings shows "Atlas connected" (no permanent raw-key field); logout/reconnect under Advanced.
- Tests: CSRF, origin, expiry, replay, cookie flags, logout, legacy migration, unauthorized-write.
- No secret (OpenAI/owner credential) in Sheets, frontend bundles, repo files, status output, logs, Flight Recorder, or fixtures.

**Owner gate:** A **new server-side session-signing secret** (Render env var) is owner-only. If required, stop and give Dale the exact variable name + steps — never a value. All other code/tests are autonomous.

**Owner activation step (non-blocking):** The code merges safely with **no** behavior change — durable sessions stay OFF until the secret is provisioned, and auth falls back to the `x-atlas-api-key` header until then. To activate, set one Render env var on the Atlas service: **`ATLAS_SESSION_SECRET`** = a fresh 32-byte random hex value (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`; never a value in the repo/PR/logs), then redeploy. Rotating it is the global-logout lever. Full runbook: `docs/OWNER_SESSION.md`.

**Completion record:** PR — this PR · Commit — `services/session.js` (HMAC-signed cookie sign/verify, expiry, rotation, CSRF `isAllowedOrigin`, cookie flags; secret read dynamically so absence = disabled); `middleware.js` (auth accepts the key header OR a valid session cookie, CSRF origin check on cookie-auth writes, publicPaths matched against the full URL); `index.js` (`POST /api/session/login|logout`, `GET /api/session/status`, dedicated login rate-limiter, publicPaths) + `config/routes.js`; client migration in `src/app/api.js` (`credentials`, conditional key header, `isConnected`/`sessionLogin`/`sessionLogout`/`refreshSessionStatus`), `src/app/app.js` (connect→login, disconnect→logout, one-time key→cookie migration bootstrap, all connection gates use `isConnected()`), `src/app/flightRecorder.js`, `src/app/index.html` (Connect/Disconnect); `.env.example` + `docs/OWNER_SESSION.md`. Tests: `test/session.test.js` (16 unit — sign/verify/tamper/expiry/wrong-secret/cookie-flags/origin/renew), the F04C integration block in `test/api-smoke.test.js` (login→cookie-auth→CSRF-refused→forged-cookie→legacy-header→unauthenticated→logout→disabled-503), and `test/sessionClientMigration.test.js`. Full suite 5499 pass; E2E unaffected (every spec mocks `/api/session/status` via its `**/api/**` fallback, so no migration fires under test). **Live-validation follow-ups:** PR #1025 (client gates → `isConnected()`), PR #1027/#1028 (durable-flag attempts, superseded), and the final **server-authoritative redesign PR #1029** — removed the `atlas_connected` flag, introduced a single server-written `serverAuthState`, made reads optimistic (401-driven "Connect Atlas", network-message on transport failure), reconciled Settings from the same state, bumped shell v137, and added red-first `tests/e2e/session-auth.spec.js`. Full suite 5519 pass; live-validated on shell v137.

### F05 — Parser full-consumption and `@N` ambiguity guard

**Status:** ✅ COMPLETE (2026-07-16)

**Findings:** `PARSE-4`, `PARSE-5`

**Objective**

Atlas asks instead of silently accepting a partially consumed set expression or guessing whether `@N` means weight or RIR in the ambiguous low-number range.

**Implementation direction**

Use the route-orchestration refusal/clarification pattern established by `services/unresolvedLiftGate.js`. Do not add an over-broad parser-level refusal that rejects Exercise-KB-known lifts, and do not rewrite stable parser goldens unnecessarily.

**Acceptance criteria**

- Set-shaped tokens left unconsumed cause a bounded clarification response; no preview/write is produced.
- Ambiguous `@N` inputs in the unsafe range ask for clarification.
- Unambiguous weight, reps/RIR, and established slash notation remain unchanged.
- `225 5/2` semantics remain fixed.

**Required tests**

Route-level ambiguity fixtures plus regression coverage for valid terse notation, aliases, multiple sets, and no invented rows.

**Owner gate**

Autonomous within the existing parser/trust contract. Any grammar-contract change beyond ambiguity refusal is owner-reserved.

**Completion record:** PR — this PR · Commit — new route-level `services/fullConsumptionGate.js` (`applyFullConsumptionGate(parsed, rawText)`), wired in `index.js` immediately after the unresolved-lift gate on `POST /api/parse-workout-text`. It downgrades a `log_sets` parse to `needs_clarification` when the raw text (a) mixes 2+ distinct set-notation families — slash `\d+/\d+`, `x\d+@`, `\d+ for \d+` — the exact shape where first-sub-parser-wins silently drops a group (PARSE-4), or (b) uses the barbell `NxM@W` form with `W ≤ 10` and the parser actually emitted that tiny weight (PARSE-5). **No parser grammar touched** — `services/workoutTextParser.js` and every parser golden are byte-identical; the `225 5/2` slash contract and repeated-slash / `@>10` / dumbbell-`@RIR` inputs are proven to still parse. Tests: `test/fullConsumptionGate.test.js` (9 unit — both downgrades, @10/@11 boundary, precision guard, no-over-rejection, no-op robustness) + a live-path F05 block in `test/api-smoke.test.js` (real parser+gate via the route: the three PARSE-4 inputs and the PARSE-5 input ask with zero rows and no write; five valid inputs still parse to exact sets). Full suite 5511 pass.

### F06 — Preserve user-edited preview rows

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first E2E; shell v138). Reproduced the CLIENT-2 defect through the real conversational flow: sets log into the `sessionLog` buffer, each closeout rebuilds the editable preview table from that buffer (`buildRowsFromSessionLog`), and logging another set reparses via `rowsFromWorkoutInput` → `populateSetRows`, which wiped the edited table while the buffer still held the original value — so the next closeout silently reverted the correction (edited 230 → parser 225, confirmed red). Fix folds hand-edits back into the buffer BEFORE any rebuild: fields are flagged `data-user-edited` on input, and `reconcileSessionLogFromTable()` maps each table row to its buffer entry by exercise + per-exercise occurrence (the same numbering `buildRowsFromSessionLog` uses) and overwrites only edited fields. The preview→approve→write trust loop is untouched (the write still reads the DOM via `collectLogRows`, and the DOM now rebuilds from the corrected buffer, so Save writes exactly the final preview).

**Finding:** `CLIENT-2`

**Objective**

A user correction made in the preview remains authoritative when another set/message updates the pending workout before Save.

**Likely surfaces**

`src/app/app.js`, preview/pending-write state, row-identity helpers, frontend integration/E2E tests.

**Acceptance criteria**

- Edited row fields survive an incremental reparse/append of additional sets.
- New engine rows are merged without overwriting user-owned edits.
- Conflicting identity is handled explicitly rather than by position-only replacement.
- Save writes exactly what the final preview displays.

**Required tests**

Edit-then-add-set, edit-then-remove, duplicate/similar exercise names, reload-safe state if applicable, final payload equality.

**Owner gate**

No owner gate unless the preview→approve→write authority model must change. Preserve the existing trust loop.

**Completion record:** PR — this PR · Commit — client-only change in `src/app/app.js` (new `reconcileSessionLogFromTable()` folds hand-edits into `sessionLog` before a rebuild — called at the top of `rowsFromWorkoutInput` before the reparse wipe and in `emitSetLogged` before its wipe; `addSetRow` flags fields `data-user-edited` on input; defensive so the eval/source harnesses stay green) and `src/app/coach-conversation.js` (a coach-accepted `update_set` marks the changed fields user-edited too). Shell bumped v137→v138 (SW cache + `ATLAS_SHELL_BUILD` + wiring/unit version pins). Tests: red-first `tests/e2e/preview-edit-preserve.spec.js` drives the real flow (log → done → edit → log → done) and proves the edited weight/reps survive and reach the write (edit 230 vs parser 225 — fails before, passes after), plus a middle-row/duplicate-name identity case. Full node suite 5519 pass; full E2E suite 65 pass; lint 0 errors. The preview→approve→write trust loop and write payload source (`collectLogRows`) are unchanged. **Follow-up (this PR, shell v138→v139):** a Codex review on the merged PR #1031 flagged that reconciliation keyed the buffer lookup on the row's CURRENT `.set-exercise` value, so renaming the exercise dropped the row's entire edit (name + numbers) — the unknown-lift "check the name" flow. Fixed: `addSetRow` stamps the row's original name (`data-origin-exercise`) and marks `.set-exercise` edits too; `reconcileSessionLogFromTable` matches on the stamped original name and preserves the exercise field. Red-first exercise-rename E2E case added (fails before, passes after).

### F07 — Ignore stale dry-run/preview responses

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first E2E; shell v140). The preview path set `pendingWrite` unconditionally after each dry-run `await` (and `populateSetRows` after each parse) with no request identity, so a slow OLDER response could overwrite a NEWER request's preview/pending write and Approve would write the stale rows. Fix adds a monotonic `previewRequestSeq` bumped at each submit start (`submitSeq`); the parse (`rowsFromWorkoutInput`) and every dry-run branch (manual / effort-only / screenshot) drop their response when their captured seq no longer matches the latest. Approval already binds to `pendingWrite`, which now stays the latest — approval semantics unchanged (autonomous per the owner gate).

**Finding:** `CLIENT-3`

**Objective**

An older slow preview response must never overwrite a newer user request or newer pending write.

**Likely surfaces**

`src/app/app.js`, request/version identity, pending-write reducer/state, E2E race tests.

**Acceptance criteria**

- Every preview request has a monotonic/request identity.
- Only the latest eligible response may update pending preview state.
- Older success or error responses are ignored safely.
- Approval binds to the currently visible preview identity.

**Required tests**

Out-of-order success/success, success/error, error/success, approve-after-race, and cancellation/reload where applicable.

**Owner gate**

Autonomous if approval semantics remain unchanged.

**Completion record:** PR — this PR · Commit — client-only change in `src/app/app.js`: new module-level `previewRequestSeq`; the logger-form submit handler captures `submitSeq = ++previewRequestSeq` at start; guards `if (submitSeq !== previewRequestSeq) return;` sit at the top of the dry-run try and before each `pendingWrite` assignment (manual / effort-only / screenshot), and `rowsFromWorkoutInput` captures `parseSeq` and drops a superseded parse before it can overwrite the table. Shell bumped v139→v140 (SW cache + `ATLAS_SHELL_BUILD` + wiring/unit version pins; the `rowsFromWorkoutInput` source-slice window widened to 3000 for the grown function). Red-first `tests/e2e/preview-stale-response.spec.js`: two closeout dry-runs overlap and resolve out of order (newer first, stale older last); each submit mints its own `write_id`, and the test asserts the live write carries the NEWER preview's `write_id` — fails before the guard (the stale response wins), passes after. Full node suite 5519 pass; E2E green (the lone `undo-stale-card.spec.js:162` failure is a pre-existing timing flake on the undo path, unrelated to this change and covered by CI retries); lint 0 errors. Approval semantics and the write payload source (`pendingWrite`) are unchanged.

### F08 — Canonical screenshot session date

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first api-smoke integration tests on the real `/api/complete-workout` route). On the closeout path the Effort row always used the resolved canonical `dateValue`, but the Log rows honoured a client per-row `date_clean` first (`normalizeLogRowObject` precedence), so a prior-day screenshot (or a backdated manual entry) dated the Effort row on the screenshot date while the Log rows kept today's auto-fill. Fix: a pure `withCanonicalSessionDate(row, dateValue)` stamps the resolved session date onto every Log row before enrichment at the complete-workout call site — applied to the dry-run preview AND the live write, so the preview shows exactly what Approve writes. Only the rows being written now are stamped (no historical rewrite); date resolution/validation, the screenshot plausibility guard (out-of-window → today-fallback + `screenshot_date_rejected` asks for correction), the effort builder, the dedup keys, and the preview→approve→write trust loop are all unchanged. Server-only (`index.js` + tests; no `src/app` change → no SW/shell bump).

**Finding:** `CLIENT-4`

**Objective**

A screenshot-imported closeout uses one canonical session date across Log and Effort rather than mixing today's date with the screenshot's date.

**Likely surfaces**

Screenshot parse/preview state, complete-workout payload construction, date validation, closeout integration tests.

**Acceptance criteria**

- One reviewed canonical session date is shown before approval.
- Log and Effort rows use that same date.
- Calendar-invalid or ambiguous dates ask for correction.
- Ordinary same-day manual logging is unchanged.

**Required tests**

Prior-day screenshot, month/year boundary, timezone edge, invalid date, manual non-screenshot closeout.

**Owner gate**

Autonomous within existing date semantics; no historical rewrite.

**Completion record:** PR — this PR · Commit — server-only change in `index.js`: new pure `withCanonicalSessionDate(row, sessionDate)` (handles the client object shape and the Log_Cleaned array shape, date at index 0), applied at the `/api/complete-workout` enrich call so `parsedLogRows` are stamped with the resolved `dateValue` before `enrichAndFormatLogRows`. The Effort row already used `dateValue`; both now share one canonical date on preview and write. Tests: red-first `test/api-smoke.test.js` F08 block (7 real-route cases — prior-day screenshot, month boundary, prior-year Dec 31, timezone-edge local-today fallback, invalid/implausible screenshot rejected→today-fallback asks-for-correction, same-day + backdated manual closeout, and a LIVE-write case asserting the appended Log_Cleaned + Effort rows carry the same date); the 4 divergence cases fail before the fix (Effort = screenshot date, Log = today) and pass after. Full node suite 5526 pass; lint 0 errors. `BACKLOG.md` CLIENT-4 marked fixed. No shell/SW bump (no client asset changed).

### F09 — Current-state coach narration

**Status:** ✅ COMPLETE (2026-07-16, proven via red-first Playwright E2E on the real coach listeners; shell v140→v141). **SESS-1:** `handleSetLogged` (`src/app/coach-conversation.js`) announced next-up/closeout from the emit-time `detail` snapshot, computed before up to two ~9s coach-LLM awaits — so a concurrent set-logged handler could leave it announcing an already-logged "next up" or a superseded closeout. Fix: re-derive next-up, plan order, completed set, and plan-completeness from the LIVE bridged selectors (`remainingPlannedExercises`/`plannedExerciseOrder`/`getSessionCompleted`) right before the announce block, with the snapshot as a typeof-guarded fallback (source/eval harnesses). **SESS-3:** the one-shot `closeoutAnnounced` guard reset only on `atlas:session-reset`, so adding exercises after a plan closed out (reopen) suppressed the second session-close prompt for the rest of the session. Fix: the `atlas:plan-mutated` listener re-arms `closeoutAnnounced` + `lastAnnouncedNextUp` when a closed-out plan has live remaining work again. Client-only (coach render layer); the write path, proof fields, and preview→approve→write trust loop are untouched.

**Findings:** `SESS-1`, `SESS-3`

**Objective**

Coach narration always describes the current store-owned session after plan edits/reopen, and closeout narration can fire correctly after a session is reopened.

**Likely surfaces**

`src/app/coach-conversation.js`, store selectors, closeout announcement state, session-reopen tests.

**Acceptance criteria**

- Announced next/remaining work is derived from the canonical current store, not stale local reconstruction.
- Reopening or mutating a completed plan resets the closeout-announced guard appropriately.
- Coach text, pin, recap, and visible plan agree after reorder/skip/substitute/add/reopen.

**Required tests**

Plan mutation followed by narration, closeout→reopen→closeout, reload/resume, and no duplicate announcement without a state change.

**Owner gate**

Autonomous because the behavior is derivable from current-state truth.

**Completion record:** PR — this PR · Commit — client-only change in `src/app/coach-conversation.js`: `handleSetLogged` re-derives `currentNextPlanned`/`currentPlannedOrder`/`currentCompleted`/`currentPlanIsComplete` from the live bridged selectors before the handoff/closeout (snapshot fallback via `typeof`), and the `atlas:plan-mutated` listener re-arms `closeoutAnnounced`/`lastAnnouncedNextUp` when a closed-out plan is reopened. Shell v140→v141 (`ATLAS_SHELL_BUILD` + `sw.js` `CACHE_NAME` + 6 version pins). Tests: red-first `tests/e2e/coach-current-state.spec.js` (SESS-3 closeout→reopen→closeout renders two closeouts; SESS-1 a stale out-of-order set-logged snapshot never re-announces an already-logged next-up) — both fail before the fix, pass after; updated the source-introspection lock-in tests (`celebrationLockIn`, `freestyleNextUp`, `sessionPlanExecutor`, `unit.test.js` handoff/closeout/P0-2a) to the live-re-derive shape + a new SESS-3 guard-reset assertion. Full node suite 5527 pass; full E2E 70 pass; lint 0 errors. `BACKLOG.md` SESS-1/SESS-3 marked fixed.

### Owner-directed insertion — live-session stabilization (F09A–F09J, then F10, then F10A–F10E)

**Authority:** Explicit owner-approved change to the canonical campaign sequence (Dale, 2026-07-17). Dale paused normal V1 progression at the clean boundary after F09 to repair defects demonstrated during the 2026-07-16 owner gym session. This is **not** a second roadmap, fix-it document, or competing plan — it is inserted into this canonical plan. Completed cards F01–F09 are **not** renumbered or erased; existing F10 and F11 keep their numbers. **Execution order:** F09A → F09B → … → F09J → **existing F10** → F10A → F10B → … → F10E → F11.

**Goal:** not to polish Atlas — to make the normal workout loop trustworthy end to end:

> executable plan → conversational execution and pivots → accurate confirmation → approved write → truthful planned-versus-actual history → replayable test evidence.

**Evidence base:** the 2026-07-16 owner live session (real upper-body workout through the production app; shell v141; backend changed mid-session from `029d508…` to `cefc34c…` — a split-build caveat, do not attribute every observation to one build). Bounded evidence recorded in `docs/TEST_QUEUE.md` **LT-012** (owner verdict FAIL overall; trust-boundary PASS because the owner rejected the final preview so no bad workout row entered permanent history). Do **not** copy private production workout details, Sheet IDs, ranges, screenshots, credentials, or raw transcripts into commits or PRs — use synthetic equivalents in automated tests.

**Product decision — living coach-plan ledger (owner-approved):** Atlas maintains **two separate truths**: (1) Atlas's **evolving recommendation ledger** — what Atlas independently recommended at each point; and (2) **actual execution** — what the athlete performed. **Never copy actual performance backward and label it Atlas's plan.** Semantics:

- A user-selected load does not automatically become "Atlas's plan." It becomes the plan only when Atlas explicitly recommends or endorses it.
- On a pivot, Atlas computes what it *would* recommend for the new exercise using history and pre-work session context; that recommendation becomes the active plan for the pivot. Performed sets remain actuals whether or not they match.
- If Atlas revises its recommendation after seeing a set, the revision applies **only to future sets** — it must not retroactively change the target for a completed set.
- When the athlete begins an exercise without requesting a target, Atlas derives the recommendation from pre-exercise information, **excluding the new result it is about to evaluate**.
- When evidence is insufficient, record **no reliable target available**; do not invent or copy the result.
- Replaced/skipped exercises are plan changes, not automatically failures.
- Original and revised plans both remain in history; assessment uses the recommendation effective when each set occurred.
- No mid-session production Sheet writes are required — maintain the evolving ledger in trusted pending-session state and include it in the final reviewed closeout, which the owner approves once.

A production Sheet schema change still follows the explicit schema safety gate (owner-reserved). Per-card rules: refresh `main`; run the Current-State Verification Gate and record one verdict; write the failing test/replay first; one fresh branch and one PR per concern; smallest safe fix; focused live-path + full deterministic + applicable Playwright/E2E + lint + secret-scan + wiring/trust checks; address real in-scope Codex findings (advisory; deterministic CI is the hard gate); merge the exact passing head; update the card and supporting evidence; refresh `main` and continue. If a card proves to contain multiple independent root causes, split it into smaller lettered cards.

### F09A — Install the stabilization campaign and record the owner test

**Status:** ✅ COMPLETE (2026-07-17) — docs-only.

**Objective**

Install this owner-directed insertion into this canonical plan (no second document), record the 2026-07-16 owner live session as the next owner live-test entry in `docs/TEST_QUEUE.md`, and file narrow `BACKLOG.md` findings for the observed defects without turning the backlog into a competing queue.

**Acceptance criteria**

- This insertion added to `docs/ATLAS_V1_EXECUTION_PLAN.md` before F11; F01–F09 not renumbered/erased; existing F10 executed at the stated point; F10A–F10E follow.
- `docs/TEST_QUEUE.md` LT-012 records: shell/app version (v141), split-build caveat (`029d508…`→`cefc34c…`), tested workflow, trust-boundary PASS (rejected preview ⇒ no permanent bad write), the bounded findings, and the required retest after fixes. Owner verdict: **FAIL overall.**
- Narrow BACKLOG findings added/updated for the new observations (F09B–F09J tags), not a competing queue.
- No other campaign document created.

**Completion record:** PR — this PR · Commit — inserted F09A–F09J + F10A–F10E into this plan (F10 unchanged at its stated point), added `docs/TEST_QUEUE.md` LT-012 (bounded, no private data), filed narrow BACKLOG findings `FR-REPLAY-1`, `REVIEW-LIVE-1`, `AUTH-DURABLE-1`, `PLAN-EXEC-1`, `PLAN-COACH-SPLIT-1`, `CONVO-LOG-1`, `PR-CLAIM-1`, `SIDECAR-DATE-1`, `UNDER-TARGET-1`, `PLAN-LEDGER-1`. Docs-only; no code, test, or schema change.

### F09B — Restore full Flight Recorder replay

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `FR-REPLAY-1`

**Objective**

Reproduce why production v141 recorded only server `api_response` rows and restore the useful **client** replay so a reviewer can see what the athlete typed, what Atlas showed, and what pending state existed at each step.

**Required behavior**

- One stable `flight_session_id` per app observation session; monotonic `seq` ordering; device linkage where available.
- Client `user_input` and `user_action` events; visible card/tile/confirmation snapshots; coach-message snapshots; pending-session and active-plan state snapshots; linked server API responses.
- Pagehide/background flush that does not lose the final closeout sequence.
- Existing redaction, truncation, feature flag, best-effort behavior, and trust-path isolation intact. Recorder failure never blocks workout logging or saving; it never touches preview→approve→write, `test_mode`, proof fields, or the parser.

**Required tests**

Red-first browser test drives an owner-like flow — session-plan card; several conversational logs; a coaching response; a correction/pivot; Done; final confirmation card; reject or approve — and proves the replay captures the athlete input, what Atlas showed, and the pending state at each step. Do not redesign the UI or modify preview/write semantics.

**Owner gate:** Autonomous (telemetry only; default-OFF flag; no write/schema/trust-loop change).

**Resolution:** **Root cause (single):** `src/app/flightRecorder.js` `initBrowser()` gated activation on the raw `localStorage['atlas_api_key']`, which the **F04C cookie migration removes** — so for a cookie-authenticated owner (the production v141 state) the client recorder was fully INERT: it captured no `user_input`/`user_action`/card/coach/session-state events and, because `requestHeaders()` returns `{}` while inactive, the server's `api_response` rows had no `flight_session_id`/`seq`/`device` linkage. **Fix (smallest):** authenticate the enabled-check + flush via the same-origin session cookie (the legacy key header still rides along pre-migration); the server's auth on `/api/flight/recent` is the real gate (unauthenticated → 401 → inert; default-OFF flag unchanged). Also enriched `snapshotSessionState()` to capture a bounded view of the pending session (active-plan order/remaining/completed + captured-not-saved log) from the client store, so the replay shows *what pending state existed at each step*. Client-only (`src/app/flightRecorder.js`); shell v142→v143. Trust loop / `test_mode` / proof fields / parser untouched.

**Completion record:** PR — this PR · Commit — `src/app/flightRecorder.js` (cookie-auth activation + bounded pending-session snapshot); shell bump v142→v143 (`sw.js` `CACHE_NAME`, `app.js` `ATLAS_SHELL_BUILD`, 6 wiring-test pins). Red-first browser proof `tests/e2e/flight-recorder-replay.spec.js` (cookie-only owner + flag ON → client replay captured with real session linkage; flag OFF → inert) — RED before the fix (recorder never activates → no ingest, no linkage header), GREEN after; deterministic guards in `test/flightRecorderClient.test.js` (no raw-key gate; pending-state snapshot fields; keepalive byte-budget trim). **Codex P2 addressed:** the unload keepalive flush now bounds the batch to the newest events under a ~55KB budget (the closeout is newest, so trimming the oldest preserves it) and caps per-event `pending_sets` at 20 (true count kept as `pending_set_count`), so an oversized tail batch can't be silently dropped by the browser and lose the closeout this fix preserves. Also fixed `playwright.config.js` to apply the pre-installed-browser `executablePath` via `launchOptions` (the top-level `use.executablePath` was silently ignored on @playwright/test 1.60, so every e2e spec failed at launch in the remote container; CI never sets `PLAYWRIGHT_BROWSERS_PATH` so it's a no-op there). Full node suite 5527 pass; full E2E 150 pass; lint 0 errors. `docs/FLIGHT_RECORDER_SPEC.md` + `BACKLOG.md` `FR-REPLAY-1` updated.

### F09C — One-command latest live-test review

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `REVIEW-LIVE-1`

**Objective**

Create the missing agent workflow for "Review my latest live app test." One obvious canonical command (name per existing conventions, e.g. `npm run atlas:review-live`).

**Required behavior**

- Uses local `.env`, known Sheet configuration, and `config/sheetContract.js`; never asks Dale for Sheet IDs, tab names, session IDs, or row ranges already available.
- Automatically identifies the newest genuine owner/app session; prefers `flight_session_id`; bounded timestamp/build/device fallback when older evidence lacks linkage.
- Joins the relevant Flight Recorder, Intent Shadow, Brain Shadow, Session Plans, Log, and Effort evidence; detects a deployment/build change during a session.
- Reconstructs user inputs, actions, visible cards, coach replies, plan state, API errors, preview, approval/rejection, and verified writes.
- Outputs PASS / FAIL / UNKNOWN per trust criterion; clearly distinguishes **missing evidence** from **passing behavior**; never reports a false green.
- Redacts secrets; does not commit generated private reports; read-only; no new database or dashboard.

**Docs:** update `docs/AGENT_LIVE_TESTING.md`, `CLAUDE.md`, and the operations documentation so a fresh agent knows `atlas:status` answers general health/campaign status and `atlas:review-live` reviews the newest real app session.

**Required tests:** deterministic fixture tests, including the v141-shaped failure where only server rows exist.

**Owner gate:** Autonomous (read-only; no write/schema/credential change).

**Resolution:** New `npm run atlas:review-live` (`scripts/atlas-review-live.js`) builds on `scripts/flight-review.js` (session grouping, correlation, anomaly detection — reused, not duplicated) and adds: newest-session selection that compares LINKED sessions and UNLINKED (server-only) clusters on the **same time axis** — so the newest broken v141-shape session (only unlinked server rows) is reviewed even when older linked sessions sit in the same cumulative tab, never silently skipped in favor of an old green (Codex P1); Session_Plans + Effort joins; build-change detection; and a **PASS/FAIL/UNKNOWN per-trust-criterion** verdict where UNKNOWN = missing evidence (never a false green). Read-only (`spreadsheets.readonly`); reads local `.env` + `config/sheetContract.js`; supports `--json`, `--session=<id>`, `--from-dir=<backup>` (offline); prints to stdout only (no committed private report).

**Completion record:** PR — this PR · Commit — `scripts/atlas-review-live.js` (pure `reviewCorpora` core + IO shell), `npm run atlas:review-live` in `package.json`, deterministic fixtures `test/atlasReviewLive.test.js` (healthy → all PASS; **v141-shaped only-server-rows → client_replay/session_linkage FAIL, overall FAIL**; coaching-notes 503 → FAIL; rejected preview → write_verified UNKNOWN not FAIL; missing/target-less Session_Plans → plan_captured UNKNOWN; newest-session + `--session` selection; build-change detection; TOTAL empty corpora; no raw-content leak). Discoverability wired into `docs/AGENT_LIVE_TESTING.md`, `CLAUDE.md`, `docs/ATLAS_OPERATIONS_CONTRACT.md` (`atlas:status` = general health; `atlas:review-live` = newest app session). `BACKLOG.md` `REVIEW-LIVE-1` marked fixed. Full node suite green; lint 0 errors.

### F09D — Durable owner-session verification

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `AUTH-DURABLE-1` (treated as **unverified** — F04C previously passed live on v137)

**Objective**

Determine whether the repeated-credential-entry observation was a real persistence regression or expected loss of site data, before changing any auth.

**Required behavior**

Test normal owner-device behavior **without** clearing browser history or website data: authenticate; refresh; close and reopen; receive a service-worker/shell update; encounter a temporary session-status timeout; return later within the configured cookie lifetime. Expected: no repeated API-key entry; Settings and Coach never disagree; a transport failure never becomes a key prompt; only a **server-confirmed** unauthenticated response asks to reconnect.

- If current behavior passes, **close this card proof-only** with no production-code change.
- If it fails, make the smallest F04C follow-up. Do **not** restore raw keys to `localStorage`, add a second client truth, add a new authentication system, weaken protected routes, or expose secrets.

**Owner gate:** Autonomous unless a new server-side secret is required (owner-reserved — name + steps, never a value).

**Resolution:** **ALREADY FIXED (proof-only close, no production-code change).** Verification: the LT-012 "required the credential again" observation was traced (by **F04C, live-validated on shell v137**) to expected loss of site data — clearing Safari history/website data correctly clears the session — **not a persistence regression.** The session is durable and server-authoritative: `services/session.js` issues a **120-day** (`DEFAULT_TTL_MS`) HttpOnly + Secure + SameSite=Lax signed cookie that **renews after 60 days** (`RENEW_AFTER_MS`), so it survives refresh, close/reopen, service-worker/shell updates, and a return later within the window; a transport failure never becomes a key prompt and only a **server-confirmed** unauthenticated response asks to reconnect (`tests/e2e/session-auth.spec.js`: cookie-only reload, delayed status, status-timeout-then-success, genuine 401, Settings/Coach agreement). None of the forbidden changes were made (no raw keys to `localStorage`, no second client truth, no new auth system, no weakened routes, no exposed secrets).

**Completion record:** PR — this PR · Commit — no production code changed. Added durable-lifetime regression pins in `test/session.test.js` (TTL ≥ ~90 days and renews before expiry; a cookie stays valid across an 80-day gap and expires only after the TTL; a durable Set-Cookie carries HttpOnly + Secure + SameSite=Lax + a long Max-Age) so a future change that shortens the lifetime — re-prompting the owner sooner — is caught. `BACKLOG.md` `AUTH-DURABLE-1` resolved. Full node suite green.

### F09E — Generate complete executable session plans

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `PLAN-EXEC-1`

**Objective**

Every planned exercise must carry an **executable prescription**: explicit set count; target weight or bodyweight; reps; target RIR when applicable; warm-up vs work-set distinction; unambiguous formatting. The accepted plan must preserve the same structured set information in session state — it cannot exist only as prose.

**Formatting rules**

- Repeated identical work sets may use `×3`.
- Different set targets appear as separate lines.
- Bodyweight knee raises read like `BW — 15 reps ×3`, **not** `15/3`.
- Slash notation continues to mean reps/RIR, never set count.
- Low-confidence or unsupported targets ask for clarification rather than displaying a misleading isolated number.

**Required tests:** red-first planner/rendering test matching the failed upper-body-plan shape. Do not add general program generation, templates, or UI redesign.

**Owner gate:** Autonomous within existing plan/parser contracts (slash `225 5/2` semantics unchanged).

**Resolution (render-layer completeness).** The failure mode was in the plan card render (`src/app/coach-conversation.js` `formatPlanSetLine` / `appendWorkoutPlan` / `suggestedExercisesBlock`), not the engine — the deterministic engine already emits `target_sets`/`target_reps`/`target_rir` and the accepted plan already retains them in session state (`normalizePlanExercise` → `activePlannedSession`, so the prescription is not prose-only). Two concrete defects fixed: (1) a **bodyweight** lift (the engine emits `weight: 0`) rendered a meaningless `0lbs 15/?` because `Number.isFinite(0)` is truthy — now it renders **`BW — 15 reps ×3`** (grouped, explicit set count, RIR only when applicable), distinguished from a load-**omitted** accessory (`weight: null`, e.g. Face Pull) which keeps `15 reps/2`; (2) an exercise with **no confident rep target** (`reps == null`, the "isolated targets" case) rendered a **bare name** — now it shows a clarify prompt ("confirm reps and sets — I don't have a target for this yet") instead of a misleading isolated number. Weighted complete-target rendering (`225lbs 5/2`) and the `225 5/2` slash contract are unchanged.

**Completion record:** PR — this PR · Commit — `src/app/coach-conversation.js` (bodyweight `BW —` grouped line via a new `isBodyweightTarget` = `weight === 0` signal; `reps == null` → `.workout-plan-clarify` prompt; text-fallback `suggestedExercisesBlock` mirrors it), `src/app/styles.css` (`.workout-plan-clarify`), shell v143→v144 (`sw.js`/`app.js`/6 wiring pins). Red-first deterministic tests in `test/workoutPresentationConsistency.test.js` (BW → `BW — 15 reps ×3`, never `0lbs`/`15/3`; `reps==null` → clarify not a bare name; weighted + load-omitted regression unchanged) — RED before, GREEN after. Full node suite 5552 pass; plan-render e2e (app-smoke Suggested Workout) green; lint 0 errors. `BACKLOG.md` `PLAN-EXEC-1` marked fixed.

### F09F — Make the visible plan and live coach share one current target

**Status:** COMPLETE

**Finding:** `PLAN-COACH-SPLIT-1`

**Objective**

Reproduce synthetically (accepted plan target A; athlete performs target B; the live coach/recommendation engine treats B as though it were the original plan) and create one authoritative **current-plan selector/state** used by the visible plan card, next-up guidance, per-lift recommendation, coach response, recap, and closeout.

**Required semantics**

- The pre-set target remains authoritative for the completed set.
- A post-set recommendation change is an explicit revision applying only to future sets; the coach must say when it is revising the plan.
- It must not silently rewrite history; displayed plan and coach facts must agree; actual performance never becomes plan merely because it was logged.
- Deterministic-engine ownership of every number preserved.

**Required tests:** the reproduced case above plus cross-surface parity (plan card / next-up / per-lift rec / coach / recap / closeout agree). If F09F and F10 (completion identity) turn out to be the same selector, sequence F10 before the ledger cards as planned.

**Owner gate:** Autonomous (derivable from current-state truth).

**Resolution.** A read-layer map (six surfaces) established that the "actual silently becomes plan" behavior is **not** a stored write-back — no code ever overwrites `activePlannedSession.exercises[i].{weight,reps,rir}` with a performed value. It is a **read-time provenance gap** in the deterministic coach-answer layer (`services/sessionQuestionAnswer.js`), in two seams: (1) `targetFromContext` sourced a "target" from `current_preview` (performed rows) when the accepted plan lacked the lift — echoing a performed value as a prescription; (2) the engine fallback (`recommendNextSet`, recomputed from the just-performed set) was merged into the answer and worded identically to a frozen-plan value. The visible plan card, next-up, `currentPlanForChat`, recap, and closeout already read the frozen accepted plan (or carry no targets at all), so the divergence was concentrated in the coach's spoken facts. The fix makes every deterministic answer's target **explicitly one of**: the accepted plan (worded as today's plan), a **revised next-set recommendation** (live engine, labeled "no planned target — recommended for your next set: …", never merged into plan wording), or **"no reliable target available."** `targetFromContext` is now accepted-plan-only (tagged `source:'plan'`); preview still resolves lift identity but never prescribes numbers; the engine may fill genuinely-missing guidance for a real plan lift (e.g. a missing set count) still worded as the plan; context still outranks the engine where a real accepted-plan target exists. The pre-Gemini lanes defer (null) when they can't ground an answer so the LLM/education path is preserved; "no reliable target available" is the honest floor only in the LLM-down lane. Scope stayed inside the answer layer — no F10 ledger, schema, recap/closeout, or slot-completion-identity work (F09F ≠ F10: the target-value selector is distinct from F10's `plan_item_id` completion-identity selector).

**Completion record:** PR — this PR (F09F) · Commit — `services/sessionQuestionAnswer.js` (provenance: `targetFromContext` plan-only + `source`, `resolveAnswerTarget`, provenance-aware `formatAnswer`, `buildSessionQuestionAnswer`/`answerBareShorthand` rewired, honest "no reliable target available" floor). Red-first tests in `test/sessionQuestionAnswer.test.js` (the six required cases: plan-A-over-performed-B, preview-not-echoed, labeled next-set recommendation, no-reliable-target floor, next-set-scoped revision, missing-set-count stays green) + updated the two integration pins in `test/api-smoke.test.js` (#452 unplanned-lift engine answer now labeled a recommendation) and `test/sessionStateStress.test.js` (P4 preview resolves identity but no longer prescribes). Full node suite 5567 pass; lint 0 errors; secret scan clean.

### F09G — Repair conversational logging and final confirmation exactness

**Status:** COMPLETE — delivered as two focused PRs (parser slice + conversation-state slice)

**Finding:** `CONVO-LOG-1`

**Objective**

Make conversational multi-message logging exact through Done and the final confirmation card.

**Required proof (red-first E2E replay of synthetic equivalents of the observed flow — normal compound-lift entry; a repeated multi-set accessory where the weight is stated once; a second clarification/rephrasing of that accessory; "Just log it"; a bodyweight exercise expressed as several bare rep counts; Done; final confirmation):**

- No duplicate exercise created from a clarification; no completed set dropped; no set silently invented.
- Weight inheritance occurs only under an existing supported grammar rule; ambiguous input asks one bounded question.
- "Just log it" resolves the pending clarification rather than becoming a fabricated set.
- Bodyweight sets retain all rep counts and correct set numbering; Done does not mutate captured sets.
- The final confirmation card exactly equals the authoritative pending-session buffer; approval would write exactly the displayed rows; rejection writes nothing.

If parser behavior and conversation-state behavior are separate root causes, split this card into focused PRs. Do not loosen the parser into guessing.

**Owner gate:** Autonomous within the parser/trust contract (grammar changes beyond ambiguity handling are owner-reserved).

**Root-cause split (from a six-surface pipeline map).** The failure is BOTH parser and conversation-state, and they are independent:
- **Parser (`services/workoutTextParser.js`):** the bare-rep bodyweight (knee raise) clarification message was HARDCODED `"20, 15, 15"` regardless of the actual reps, so the lifter was asked back a set they never entered. The detected reps were already correct in `partial.sets`; only the human-facing question string drifted. (Auto-logging bare bodyweight reps without the ask, and cross-message weight inheritance, are **grammar changes beyond ambiguity handling → owner-reserved**; the card itself wants ambiguous input to "ask one bounded question", so the parser is otherwise correct — no grammar change made.)
- **Conversation-state (`src/app/app.js` + `coach-conversation.js`):** on a `needs_clarification` throw the parser's `partial.sets` are discarded (only `recognizedExercise` is kept), so clarified sets never reach the `getSessionLog()` buffer; "Just log it" is not a recognized closeout/resolution token; and the Done→confirmation closeout falls back to a Gemini re-parse of chat history whenever the buffer is empty, so the "card == buffer" invariant does not hold in that branch. **This is the follow-up PR.**

**Completion record (parser slice):** PR #1047 · Commit — `services/workoutTextParser.js`: the knee-raise bodyweight clarification now echoes the reps ACTUALLY detected (`Knee raises: do you mean bodyweight reps ${repCounts.join(', ')}?`) instead of a hardcoded `"20, 15, 15"`. Red-first `test/parser-golden.test.js` ("Knee raises 15 12 10" → the question echoes `15, 12, 10`, never `20, 15, 15`). Full node suite 5568 pass; lint 0 errors.

**Completion record (conversation-state slice):** PR — this PR (F09G conversation-state slice) · A new focused module `src/app/pendingClarification.js` (peer of `drawer.js`/`workoutSheet.js`) HOLDS a `needs_clarification` that already carries detected reps and commits **exactly** those sets on a short affirmation:
- `rowsFromBackendParsedWorkout` now carries `err.partialSets` instead of discarding the parser's `partial.sets`.
- The composer resolves a held clarification on a tight affirmation ("Just log it" / "yes" / "log it") **before** the closeout / "log it" routing, committing the held sets through the same `emitSetLogged` buffer path — so the reps reach the authoritative `getSessionLog()` buffer, retain all rep counts and set numbering, and land as bodyweight sets (weight `0`). "Done" is deliberately not an affirmation, so it still closes out.
- A sets-carrying `needs_clarification` is held and its bounded question surfaced (not leaked to the coach); a real set log or a superseding clarification clears the hold.
- **Result:** no clarified set is dropped, "Just log it" resolves the pending clarification instead of becoming a fabricated set or a session close, and because confirmed sets reach the buffer, the Done→confirmation card is the buffer (the empty-buffer Gemini recompile only fires when nothing was ever confirmed to the buffer, and remains a preview→approve-gated last resort — never a silent write; filed for optional further hardening).
- **Tests:** red-first `test/pendingClarification.test.js` (11 module unit tests for the state machine + shapes, 4 app.js-wiring source-slice guards) and a browser replay `tests/e2e/pending-clarification-resolve.spec.js` ("Knee raises 15 12 10" → held + coach not called + buffer empty → "Just log it" → exactly reps 15/12/10 as bodyweight sets). SW cache `atlas-shell-v144`→`v145` + `ATLAS_SHELL_BUILD` matched; new module precached in `SHELL_ASSETS`. Full node suite 5583 pass; lint 0 errors; e2e green (both viewports).

### F09H — Route PR claims correctly

**Status:** COMPLETE

**Finding:** `PR-CLAIM-1`

**Objective**

A "that was a PR" statement must not be parsed as workout-set input, must not open coaching-note consent, and must not write `Coaching_Notes`.

**Required behavior (red-first cases: "That was a PR!"; "I think that was a PR"; "That felt like a PR"; a false typed claim; a genuine PR in pending unsaved sets; a genuine PR after verified save):**

- Before verified workout save, Atlas may say it *appears* to be a candidate based on captured sets, but must not claim permanent history.
- After verified save, PR status is calculated from actual approved rows and historical data.
- A typed claim cannot manufacture a PR. A note-service failure cannot interrupt workout logging or closeout. PR state belongs to workout/progress records, not durable free-form memory.

**Owner gate:** Autonomous (no write/schema change; a failed note write must never 503-block logging).

**Resolution (from a four-surface map).** Two of the four surfaces were already correct and needed no change: the **parser** never parses a PR claim as a set ("pr" resolves to no alias; `parseWorkoutText` returns `needs_clarification`, never `log_sets` — verified against the alias table), and the **note-service is already isolated** — `POST /api/coaching-notes` returns an ordinary 503/500 that is swallowed by the client `showSaveNotePrompt` try/catch, and no logging/closeout path (`emitSetLogged`, `runCloseout`, `handleLogIt`) ever calls the note endpoint, so a note failure cannot interrupt logging (the 503 in the incident was a benign side-effect of the mis-proposed note). The **primary root cause** was that a self-reported PR claim could become a coaching-note: the note-proposing prompt had no exclusion for it and the server passed `propose_note` through untouched. Fixed deterministically:
- New pure classifier `looksLikePrClaim(message)` (`services/coach.js`, exported) detects a self-reported PR / personal-best CLAIM (or question) about a set just performed, but NOT a training GOAL that mentions a PR (a goal is a durable, note-worthy fact).
- The coach route (`routes/coachOps.js`) drops BOTH `propose_note` and `propose_constraint` when the message is a PR claim — so no "Save note?" consent opens and nothing reaches `Coaching_Notes` — while the grounded prose reply still stands.
- The chat prompt's note-proposing guidance now explicitly excludes a self-reported PR claim and states PR status is engine-owned (from logged rows), never a typed claim (defense in depth). The existing set-reaction IRON RULE + register suppressor already prevent the coach's prose from claiming a permanent PR without `progression_verdict.level === 'new_ground'`, and PR status is computed from actual rows (`progressionVerdict` / `athlete_identity.lift_prs`), so a typed claim cannot manufacture a PR.

**Completion record:** PR — this PR (F09H) · Commit — `services/coach.js` (`looksLikePrClaim` + prompt exclusion), `routes/coachOps.js` (drop note/constraint for a PR claim). Red-first `test/prClaimGuard.test.js` (claim vs goal vs ordinary), integration `test/api-smoke.test.js` (a "That was a PR!" claim yields `propose_note: null` + `propose_constraint: null` + a prose reply + no sheet write; a genuine injury note still proposes), prompt-content pin in `test/coachPromptRules.test.js`. Full node suite 5589 pass; lint 0 errors. The OPTIONAL deterministic client "appears-to-be-a-candidate" grounded lane is filed as an enhancement (not required; the LLM prose is already grounded by the IRON RULE).

### F09I — Use one canonical local session date for sidecar writes

**Status:** ✅ COMPLETE (2026-07-17)

**Finding:** `SIDECAR-DATE-1`

**Objective**

Replace UTC-day derivation such as `new Date().toISOString().slice(0,10)` on owner-facing sidecar records with one canonical Atlas date utility and the configured owner timezone (**America/Vancouver**).

**Required coverage:** evening Pacific time; UTC midnight crossover; month/year boundary; daylight-saving transitions; Coaching Notes; Constraints; any adjacent owner-session sidecar using the same broken pattern. Do not rewrite historical rows. Verify the production timezone setting before the eventual live retest.

**Owner gate:** Autonomous within existing date semantics (no historical rewrite). Setting `ATLAS_TIMEZONE` in production is an owner env action if not already set.

**Resolution.** The canonical Atlas date utility already existed — `localTodayIso(now, tz = ATLAS_TIMEZONE)` in `services/analytics.js` (IANA-zone `en-CA` → `YYYY-MM-DD`; UTC fallback when unset). The two owner-facing sidecar write routes (`POST /api/coaching-notes`, `POST /api/constraints` in `index.js`) and the adjacent `Deload_State` `deload_start_date` (`services/deloadEngine.js`) each derived the date with a raw `new Date().toISOString().slice(0,10)` (UTC), so an evening-Pacific write was stamped tomorrow. All three now call `localTodayIso()`. No historical rows rewritten; behavior is unchanged until `ATLAS_TIMEZONE` is set (owner env action, `America/Vancouver`, verified at the final gate).

**Completion record:** PR — this PR · Commit — `index.js` (import `localTodayIso`; coaching-notes + constraints use it), `services/deloadEngine.js` (`deload_start_date` uses it). Red-first route tests in `test/api-smoke.test.js` (F09I: with `ATLAS_TIMEZONE=America/Vancouver` the coaching-note and constraint dates equal the Vancouver local day, not the raw UTC slice) — deterministically RED before / GREEN after (verified during the evening-Pacific window where UTC day ≠ Vancouver day). Added `localTodayIso` unit coverage for month/year boundary + daylight-saving transitions (`test/unit.test.js`). Full node suite 5556 pass; lint 0 errors. `BACKLOG.md` `SIDECAR-DATE-1` marked fixed.

### F09J — Stop calling benchmark comparisons "under target"

**Status:** COMPLETE

**Finding:** `UNDER-TARGET-1`

**Objective**

Preserve the current benchmark detector only where it is analytically valid, but correct its **claims**. Without a stored historical prescription, allowed language: "below your recent benchmark"; "below your established performance range"; a factual trend using actual numbers. Without a stored plan, Atlas must **not** say "missed target", "under target", "failed the plan", or "beat expectations".

**Required tests:** deliberately lighter sessions, alternate rep prescriptions, and recovery sessions are not described as plan failures merely because estimated performance is below a benchmark. This card fixes truthfulness now; full plan-aware assessment arrives in F10E.

**Owner gate:** Autonomous (wording/claim truthfulness; no number or write change).

**Resolution:** The `consistent_underperformance` challenge lives ONLY in the chat coach's CHALLENGE MODE prompt block (`services/coach.js` `buildChatSystemPrompt`) — there is no deterministic string that stamped "under target" onto a benchmark trend; the detector already forwards only `sessions_below of sessions_checked`. The fix rewords that prompt block: it now frames the signal explicitly as a `BENCHMARK/TREND comparison` against the lift's own established performance, `NOT a missed plan` (no per-session prescription was stored), forbids `"under target"`, `"missed target"`, `"failed the plan"`, and `"beat expectations"`, and supplies the honest replacement wording ("below your recent benchmark" / "below your established range"), including the worked example. Deterministic tests in `test/coachPromptRules.test.js` pin the benchmark framing, the plan-failure-vocabulary prohibition, and the replacement wording. The valid prescribed-RIR `effort_verdict` "way under target" path (a real per-set target comparison) is untouched.

**Completion record:** PR — this PR (F09J) · Commit — reword the chat CHALLENGE MODE prompt block to benchmark/trend framing (`services/coach.js`), add `test/coachPromptRules.test.js` F09J assertions, sync the LT-011 narration comment.

### F10 — Authoritative planned-slot completion identity

**Status:** COMPLETE — executed after F09J per the 2026-07-16 owner insertion. Its canonical `plan_item_id` and ambiguity-safe slot completion semantics are prerequisites for the F10A–F10E evolving-plan ledger.

**Findings:** PR-24 slice-3 divergence, `SESS-4`, `SESS-5`, Workout Sheet duplicate-name identity

**Binding owner decision**

A recognized substituted exercise or variant satisfies the original planned slot everywhere: recap, next-up, pin, handoff, closeout, and Workout Sheet. Do not re-ask this product decision.

**Objective**

Create one canonical, ambiguity-safe planned-slot completion selector and route every consuming surface through it.

**Likely surfaces**

Canonical session selectors/store, completion identity resolution, substitution outcome folding, recap/remaining helpers, `src/app/workoutSheet.js`, closeout/handoff tests.

**Acceptance criteria**

- One logged substituted/recognized variant completes exactly the intended original `plan_item_id`.
- Duplicate exercise names remain slot-distinct; one log cannot complete every same-named slot.
- Exact identity outranks substring; ambiguous substring matches refuse/leave unresolved rather than guessing.
- Recap, next-up, pin, handoff, closeout, and Workout Sheet return the same status from the same selector.
- Existing Session_Plans `plan_item_id` semantics remain authoritative.

**Required tests**

Substituted variant, alias, duplicate planned names, substring collision, out-of-order completion, skip then log, reload/fold, and cross-surface parity.

**Owner gate**

The semantics are already owner-approved. Implementation is autonomous unless it requires a schema migration, which is not expected and must not be introduced casually.

**Current-state architecture map + exact stopping point (captured 2026-07-17, pause handoff — NOT yet implemented; from a read-only surface trace).**

*Authoritative spine to build on (already `plan_item_id`-keyed):* `src/app/planAcceptance.js:61-81` `buildAcceptedItems` mints one immutable crypto-only `pi_`-prefixed id per slot (fail-closed, never timestamp/random), building `items[]` = `{plan_item_id, planned_order, planned_lift_code, movement_pattern, outcome:'planned', performed_lift_code}`; `:147` tags the execution list 1:1 so `activePlannedSession.exercises[i]` (names/targets, read by every visible surface) carries its slot's `plan_item_id`. `src/app/planOutcome.js:30-35` `resolveItemForOutcome` resolves by `plan_item_id` ONLY, fail-closed; `src/app/planCompletion.js:35-56` `mostRecentCompletablePlanItem` (the "Done with X" lane) is the closest existing model — name used only as logged-evidence, target completed by id. Server side already folds by `(session_id + plan_version + plan_item_id)` (`services/sessionPlanReader.js:14-15,60-133`); `config/columns.js:76-84` already persists `plan_item_id`/`planned_lift_code`/`performed_lift_code`.

*The NAME-keyed completion to replace (the duplicate-name bug):* `services/sessionPlanExecutor.js:67-94` `computePlanState` builds `doneNames`/`doneCodes` Sets and filters `remaining` by name/liftCode membership — so two same-named slots both drop out on one logged set (no `plan_item_id` anywhere). Client twins: `src/app/app.js:4544-4550` `remainingPlannedExercises` (name-Set), `:4951-4952` the `sessionCompleted[]` fold (`resolveCompletedIdentity` → a NAME string array), `:4865-4918` `resolveCompletedIdentity` (tier-3 substring, no ambiguity refusal — `SESS-5`), `src/app/workoutSheet.js:83-103` `buildSheetCards` (status by normalized-NAME set membership).

*Only the explicit-outcome lane is slot-safe today* (`planOutcome.js` `runOutcome`, `completePlanItemById`, `app.js:2334-2342`). **Every visible surface decides by NAME:** recap `canonicalSessionRecap` (`app.js:4269-4283`), pin/next-up `renderSessionPin`/`currentPlannedExercise`/`firstUnloggedPlannedLift` (`app.js:4645-4742`), handoff `getNextExerciseInPlan` (`coach-conversation.js:1221-1254`, bidirectional substring), chat `currentPlanForChat`/`plan_completed` (`app.js:5625-5673`), closeout `planStateFromContext`/`computeCloseout` (`sessionPlanExecutor.js:260-274`, `services/sessionCloseout.js:28-37`, `routes/coachOps.js:887,1143`), Workout Sheet `buildSheetCards`.

*Substitution → original slot:* `applySessionSubstitution` (`app.js:1625-1678`) finds the slot by name but **retains the original `plan_item_id`** (`:1669`) and emits the `substituted` outcome by id — so the id spine is preserved, but downstream completion is still name-decided via `sessionCompleted[]` and `reconcileSubstitutedRemaining` (`activeSession.js:361-373`, name-only). `SESS-4`: `emitSetLogged` clears `pendingSubstitution` even on a no-op apply (`app.js:4932-4937`).

*Hazards (exact-match code):* `computePlanState:74`, `remainingPlannedExercises:4545-4548`, `buildSheetCards:85,97-99`, `resolveCompletedIdentity:4895-4901` (substring-first), `matchesPlanEditName:2475-2480` (the strong `planEditNameEquals:2484-2488` + `exactByName` guard at `:2565` is the pattern to generalize), `getNextExerciseInPlan:1230,1246-1250`, `entryMatches:63-64` (mitigated by `findMatchIndex`'s unique-only rule `activeSession.js:78-98`).

*Canonical selector to introduce:* a pure, DI, `plan_item_id`-keyed per-slot resolver — the generalization of `mostRecentCompletablePlanItem` + `resolveItemForOutcome`, e.g. `planSlotStatuses(activePlan, sessionCompleted) → [{plan_item_id, name, liftCode, status}]` with derived `remainingSlots`/`firstUnloggedSlot`/`isSlotComplete`/`isPlanComplete`. Keys on `plan_item_id`; uses name/liftCode ONLY as logged-evidence to attribute a log to a slot, with **exact-outranks-substring + ambiguity refusal** (reuse `findMatchIndex`'s unique-only rule); a substituted slot resolves via its retained `plan_item_id`. Route through it: `remainingPlannedExercises`, `firstUnloggedPlannedLift`, `renderSessionPin`, `currentPlannedExercise`, `canonicalSessionRecap`, the `sessionCompleted[]` fold, `isPlanCloseoutAwaitingSave`, `buildSheetCards`, `computePlanState` (+ `planStateFromContext`/`computeCloseout`/`coachOps`), `getNextExerciseInPlan`, and `reconcileSubstitutedRemaining`.

*Hard cases (only a NAME at the decision point):* (a) the **server coach-chat / closeout** path receives `current_plan`/`plan_completed` as NAMES over the wire (`routes/coachOps.js`) — routing it through the selector needs the client to additionally send `plan_item_id` on the chat context (an additive payload field, **not** a `Session_Plans` schema change), or the server stays name-keyed while the client surfaces become authoritative; (b) `sessionCompleted[]` is name-sourced (the log has no slot id), so the log→slot attribution is unavoidably a name match — the selector must do it ONCE, safely, then key everything downstream by id; (c) an **engaged-but-unaccepted** Coach's Pick has no `plan_item_id` (`plan.accepted !== true`) → id-keyed selectors fail-closed to a hardened name path there.

*Schema migration:* **NONE required.** `plan_item_id` is minted at acceptance, rides on every store slot, and is already persisted + folded server-side. F10 is a read-layer/selector consolidation over existing data (consistent with the card's owner gate).

*Exact stopping point (historical, now resolved):* the pause handoff captured F10 as not-started; it is now implemented per the map below.

**Resolution.** Introduced `src/app/planSlotStatuses.js` — one pure/DI, `plan_item_id`-keyed per-slot completion selector (`planSlotStatuses` + `remainingSlotNames`/`firstUnloggedSlot`/`isSlotComplete`/`isPlanComplete`). It seeds each slot from the authoritative id-keyed explicit-outcome lane (`items[].outcome`) then attributes each logged completion to AT MOST ONE slot, keyed by slot position, with exact-identity-outranks-substring and ambiguity refusal (a duplicate name stays slot-distinct; an ambiguous substring resolves none; a directional abbreviation and the qualifier-gated variant rule handle aliases/variants, so "Romanian Deadlift" never completes a bare "Deadlift" slot while "Incline Dumbbell Flyes" satisfies "Dumbbell Flyes"). A substituted slot retains its `plan_item_id`, so logging the substitute completes the original slot. Routed every consumer through it: `remainingPlannedExercises` (hence the pin, next-up, `firstUnloggedPlannedLift`, `isPlanCloseoutAwaitingSave`, and `emitSetLogged`'s nextPlanned/plannedQueue), `canonicalSessionRecap`'s remaining, and `workoutSheet.buildSheetCards` (now status-by-slot, not name-set membership). Hardened `resolveCompletedIdentity` (exact-outranks-substring + unique-only refusal + qualifier-gated reverse) and the coach handoff `getNextExerciseInPlan` (unique-only substring). Made server `computePlanState` duplicate-distinct (greedy per-slot attribution). The equipment/angle variant rule is single-homed in `activeSession.js` (`variantSatisfies`, consumed by both `reconcileSubstitutedRemaining` and the F10 selector). **No `Session_Plans` schema migration** — `plan_item_id` was already minted/persisted/folded; F10 is a read-layer consolidation.

**Completion record:** PR — this PR (F10) · Commit — new `src/app/planSlotStatuses.js` selector + routing in `src/app/app.js` (`remainingPlannedExercises`, `canonicalSessionRecap`, `resolveCompletedIdentity`, `plannedExerciseEntries` carries `plan_item_id`), `src/app/workoutSheet.js` (`buildSheetCards` by slot status), `src/app/coach-conversation.js` (ambiguity-safe handoff), `src/app/activeSession.js` (single-home `variantSatisfies`), `services/sessionPlanExecutor.js` (greedy `computePlanState`), `src/app/sw.js` (precache the new module). Red-first repro `test/planSlotCompletionIdentity.test.js` (executor duplicate broadcast) — RED before / GREEN after; selector contract `test/planSlotStatuses.test.js` (duplicate names, substring collision, variant/substitution, alias, plural, out-of-order, skip, reload); cross-surface parity `test/planSlotSurfaceParity.test.js` (recap = next-up = closeout = Workout Sheet from one selector); Workout Sheet duplicate-name case in `test/workoutSheet.test.js`; slice-harness + lock-in tests updated to the single-source shape. Full node suite 5609 pass; lint 0 errors; syntax/wiring/secret-scan clean.

### F10A — Define the set-level recommendation ledger and storage contract

**Status:** COMPLETE (executed after F10)

**Resolution.** Registered the append-only companion tab: `config/columns.js` `sessionPlanSetsColumns` (the owner-approved 16-column schema, `docs/SESSION_PLANS_LEDGER_DESIGN.md` §2) + `Session_Plan_Sets` in `config/sheetContract.js` `optionalSheetTabs` (503/no-op until the owner creates it). Added the pure contract module `services/sessionPlanLedger.js` (mirrors `services/sessionPlanEvents.js`): frozen `RECOMMENDATION_SOURCES`/`REVISION_SOURCES`/`CONFIDENCE`; a deterministic `idempotencyKey` over `(session_id, plan_version, plan_item_id, set_index)` only (never targets/timestamp); `buildAcceptedRows` (ledger v1 — one row per set, `supersedes_key` empty, blank targets when `no_reliable_target`, bodyweight `0` preserved); `buildRevisionRow` (an EXPLICIT future-set revision — rejects any non-`live_revision`/`user_endorsed` source so a performed value can never revise, amendment 1); and the chain-validating `effectiveRecommendation`/`effectivePlan`/`planHistory` that fold to the highest version but **fail closed to `no_reliable_target` + diagnostics** on duplicate versions, forks, missing/dangling/non-immediate `supersedes_key`, cross-session/item/set references, and non-contiguous versions (amendment 3) — never a silently-selected max-version row. Added the idempotent creation-time checkpoint path `services/sessionPlanSetsStore.js` (amendment 2), **dry-run by default**: gated behind `SESSION_PLAN_SETS_WRITE_ENABLED` (off), every checkpoint returns the W1–W3 proof (`sheet_written:false`/`no_write_confirmed:true`) and touches no sheet; the live path (append-only, idempotent-retry, revision-collision-fail-closed, tab-missing 503) is proven under an env-override + stubbed sheets so F10D only flips the flag. Both new services are staged in `config/wiring-allowlist.json` (F10B wires them). No production tab, no live write, no `Session_Plans`/`Log_Cleaned`/`Effort` migration.

**Completion record:** PR — this PR (F10A) · Commit — `config/columns.js` (`sessionPlanSetsColumns`), `config/sheetContract.js` (optional tab), new `services/sessionPlanLedger.js` + `services/sessionPlanSetsStore.js`, `config/wiring-allowlist.json` (staged entries), tests `test/sessionPlanLedger.test.js` (schema, idempotency, accepted/revision builders, the July 16 dips fixture, and every malformed-chain fail-closed shape) + `test/sessionPlanSetsStore.test.js` (dry-run no-write proof + live idempotent/collision/tab-missing). Full node suite 5636 pass; lint 0 errors; syntax/wiring/secret-scan clean.

**Objective**

Implement the smallest append-only model capable of preserving: session identity; plan version; plan item identity; target set identity or set count; target weight; target reps; target RIR; recommendation source; effective event/set boundary; replacement/supersession; confidence / no-reliable-target status; original and revised plan history; final effective plan; closeout/write identity.

**Direction & trust requirements**

- Prefer a narrowly scoped extension of the existing `Session_Plans` system or a companion `Session_Plan_Sets` tab. **Do not introduce another database.**
- No historical rewrite; no actual-result-to-plan copying; no mid-session production Sheet write requirement; deterministic IDs and idempotency; reload/resume safe; bounded JSON only where justified; exact schema contract and tests; migration forward-only.
- The owner approves the **product model**, but **applying a production Sheet schema migration remains an explicit owner-reserved action.** Build and merge code, contracts, fixtures, and dry-run behavior; continue through downstream cards using test/sandbox contracts. Stop only before the actual production schema change if it cannot be applied safely without owner authorization — do **not** halt all development at this point.

**Completion record:** PR — · Commit —

### F10B — Capture accepted plans and explicit live revisions

**Objective**

When Atlas proposes and the athlete accepts a session, create ledger **version 1** including every planned set, preserving ordering and `plan_item_id`.

**During the workout**

- Explicit substitution/pivot generates a new recommendation **before** the substitute's work is evaluated.
- Skipping or replacing an exercise records the plan outcome.
- A user-requested change becomes Atlas's recommendation **only** when Atlas explicitly endorses or revises it.
- Post-set adjustments apply only to future sets; completed-set targets remain immutable.
- All revisions are visible in current plan state; reload/resume retains them.

**Durability model (superseded by owner amendment A2, `docs/SESSION_PLANS_LEDGER_DESIGN.md` §10):** the original "keep the pending ledger in session state until closeout" model was **rejected as insufficiently durable**. Each accepted plan (v1) and each explicit revision is durably + idempotently **checkpointed at creation** via a non-blocking sidecar (dry-run until F10D enables live writes); session state is a **cache reconstructed from the durable ledger** on reload/resume.

**Status:** COMPLETE — slice 1 (acceptance capture + revision infrastructure) and slice 2 (`F10B-REVISION-WIRING-1`: mid-session explicit-revision **triggers** + reload reconstruction) shipped.

**Resolution (slice 1).** Built the ledger creation-time checkpoint lane end-to-end, dry-run: `services/sessionPlanSetsCapture.js` (the failure-isolated envelope + exact-16-col-header validation over the F10A store, mirroring `services/sessionPlanCapture.js`); two authenticated `writeCapable` sidecar routes `POST /api/session-plan-sets/accept` (ledger v1) and `POST /api/session-plan-sets/revision` (one explicit future-set revision — the route rejects any non-`live_revision`/`user_endorsed` source, `plan_version < 2`, or missing `supersedes_key`, so a performed value can never revise, amendment 1), declared in `config/routes.js`. Client: `src/app/planAcceptance.js` `buildLedgerAcceptedItems` (pure — joins the immutable accepted items with the displayed prescription; an item with no set count is NOT invented into the ledger, an item with a set count but no load/reps is an honest `no_reliable_target`, bodyweight `0` preserved) + `runAcceptance` now posts the v1 checkpoint via an additive non-blocking `postLedgerCheckpoint` dep (injected in `src/app/app.js` — never the preview→approve→write path; a sidecar failure never unwinds the accepted snapshot). The three F10A ledger services left the wiring allowlist (now production-reachable). All dry-run: `captured:false`/no sheet touched until F10D.

**Resolution (slice 2, `F10B-REVISION-WIRING-1`).** Wired the mid-session explicit-revision TRIGGER end-to-end, still dry-run. New pure client ledger `src/app/sessionLedger.js`: `performedSetCount` (the frozen floor — a revision may target only set indexes above the count already logged, plural/singular-tolerant, mirrors the executor's normalization); `buildFutureRevisions` (one revision per FUTURE set only — performed sets stay frozen; returns `[]` unless an EXACT `target_weight` AND `target_reps` are present so a revision is never fabricated, bodyweight `0` preserved; idempotent — a re-fired identical substitution adds no redundant version, a genuinely-different target appends the next linear version); `appendRevisions` (append-only — an existing `(item, set, version)` is a no-op, prior rows never mutated). `src/app/app.js` `emitFutureSetRevision` builds the future revisions, appends them to the store, persists the reload snapshot, and posts each to `POST /api/session-plan-sets/revision` non-blocking; it is called from exactly one site — the explicit `applySessionSubstitution` replace path — so a logged set (`emitSetLogged`) can never create a revision (proven structurally). The future-set bound is the slot's **accepted (v1) set count**, captured before the in-place swap overwrites it — never the substitute's own prescribed set count — so every revised set keeps a v1 predecessor (an over-count can't dangle the chain, an under-count can't strand a stale v1 row). Revisions live in a new `_sessionRevisions` store signal persisted in the reload snapshot (shape v2→v3, back-compatible hydrate) and reconstructed on resume; cleared at every session-reset point. Server `POST /api/session-plan-sets/revision` no longer requires the client to send `supersedes_key` — it is derived server-side from version N-1 via `services/sessionPlanLedger.js` `supersedesKeyFor` (revision chains are linear), closing the client/route contract.

**Completion record:** PR (slice 1) — F10B · PR (slice 2) — this PR · Commits — slice 1: `services/sessionPlanSetsCapture.js`, `routes/sessionPlans.js` + `config/routes.js` (accept/revision routes), `src/app/planAcceptance.js` + `src/app/app.js` (`postLedgerCheckpoint`), `config/wiring-allowlist.json`; slice 2: new `src/app/sessionLedger.js`, `src/app/app.js` (`emitFutureSetRevision` + reset wiring), `src/app/store.js` (`_sessionRevisions` signal + snapshot v3), `services/sessionPlanLedger.js` (`supersedesKeyFor`), `routes/sessionPlans.js` (server-derived `supersedes_key`), `src/app/sw.js` (precache). Tests: `test/sessionLedger.test.js`, `test/sessionRevisionWiring.test.js` (new — incl. the accepted-set-count bound), `test/sessionPlanLedger.test.js`, `test/sessionPlanSetsRoutes.test.js`, `test/store.test.js` (additions). Full suite 5669 pass; lint 0 errors. Codex P2 (set-count-change corrupts effective ledger) fixed by the accepted-set-count bound; Codex P2 (checkpoint suggested substitutions before the log) dispositioned non-issue — a declared swap is checkpointed at application (still before any future set is performed), matching the existing `emitPlanItemOutcome` timing; checkpointing an un-adopted suggestion would create phantom revisions.

### F10C — Generate an independent recommendation for an unannounced exercise

**Status:** COMPLETE — slice 1 (the leakage-safe derivation + `implicit_unplanned` ledger-row builder, pure) and slice 2 (`F10C-IMPLICIT-WIRING-1`: the dry-run derive+checkpoint route + the client trigger on an unplanned log + reload reconstruction) shipped.

**Owner contract:** the 7-point decision (Dale, 2026-07-18) is written verbatim into `docs/SESSION_PLANS_LEDGER_DESIGN.md` §4A (amendment A4) — one next set only; no rep/RIR range collapsed to a scalar; an `implicit_unplanned` row only when exact weight+reps+rir derive from pre-session history; current session excluded (the leakage guarantee); absent/ambiguous/range-only → `no_reliable_target`, no row; a performed value never becomes the recommendation.

**Resolution (slice 1).** `services/implicitRecommendation.js` `deriveImplicitRecommendation(...)` — PURE and deterministic. It excludes the current session from `logRows` first (rule 4/6 — the leakage guarantee), then derives an EXACT target: `target_weight` = the engine's pinned `recommendedWeight` (undefined on a cold start → `no_reliable_target`), `target_reps`/`target_rir` = the exact most-recent prior WORKING SET's reps/rir (the engine emits rep/RIR only as `{min,max}` RANGES, which rule 2 forbids collapsing — so a blank prior reps/rir reads strict-null, never a fabricated 0). Any of the three not exactly derivable → `no_reliable_target` (`target_set_count 1`, no row). `services/sessionPlanLedger.js` `buildImplicitRows` builds the standalone v1 `implicit_unplanned` row (`set_index 1`, `target_set_count 1`, `supersedes_key ''`, bodyweight `0` preserved) for a reliable target, and appends **no** row for a `no_reliable_target` item (§4A rule 5 — an unannounced exercise with no confident target has no recommendation to record). Red-first `test/implicitRecommendation.test.js` (the required leakage proof — a wild vs a light just-submitted set derive the identical target — plus exclusion, cold-start, blank-rir-not-0, one-set) + `test/sessionPlanLedger.test.js` (`buildImplicitRows`). `services/implicitRecommendation.js` is staged in `config/wiring-allowlist.json` (slice 2 wires it). No route/app/write change; no production tab.

**Resolution (slice 2, `F10C-IMPLICIT-WIRING-1`).** Wired the derivation end-to-end, still dry-run. Server: `POST /api/session-plan-sets/implicit` (`routes/sessionPlans.js`, now given `{getSheetRows, logSheetName, effortSheetName}` in `index.js`) DERIVES server-side over the full Log_Cleaned history with the current session excluded (the leakage guarantee — the just-logged set is never sent and its session is excluded regardless), then checkpoints a reliable target via `captureImplicit`/`checkpointImplicit` (`services/sessionPlanSetsCapture.js` / `sessionPlanSetsStore.js`, mirroring accept/revision, dry-run) — a `no_reliable_target` derivation routes through the same builder that appends **no** row. Client (`src/app/app.js`): `emitSetLogged` detects an off-plan logged exercise via `isOffPlanLoggedExercise` (the F10 `planSlotStatuses` selector in isolation — no divergence) and calls `emitImplicitRecommendation`, which POSTs to `/implicit` under a DETERMINISTIC per-(session,lift) `plan_item_id` (idempotent re-log) and stores only a reliable result in a new `_sessionImplicitRecs` store signal (snapshot shape v3→v4) for reload reconstruction; scoped to accepted-plan sessions, never a planned slot or a substitute, never the performed value (only prior evidence is read server-side). Red-first `test/implicitRecommendationWiring.test.js` + `test/sessionPlanSetsRoutes.test.js` (`/implicit`) + `test/store.test.js` (v4 round-trip). `services/implicitRecommendation.js` left the wiring allowlist (now production-reachable).

**Objective**

When the athlete simply logs an exercise that was not requested or planned:

1. snapshot history and current-session context **before** incorporating that exercise result;
2. call the deterministic recommendation engine as though the athlete had asked for the target;
3. record that recommendation as an implicit plan addition;
4. record the submitted sets separately as actual execution;
5. compare them without moving the goalposts.

The just-submitted result must be **excluded** from the evidence used to derive its own target. When there is insufficient history: record **no reliable target available**; preserve the actual; do not invent a target; do not call the actual result the plan.

**Required tests:** leakage tests proving that changing the submitted result does not change the recommendation derived from the same pre-exercise evidence. ✅ delivered in `test/implicitRecommendation.test.js` (slice 1).

**Completion record:** PR (slice 1) — #1056 · PR (slice 2) — this PR · Commits — slice 1: new `services/implicitRecommendation.js`, `services/sessionPlanLedger.js` (`buildImplicitRows`), `docs/SESSION_PLANS_LEDGER_DESIGN.md` §4A/A4, `test/implicitRecommendation.test.js`; slice 2: `routes/sessionPlans.js` + `config/routes.js` (`/implicit` route) + `index.js` (DI), `services/sessionPlanSetsStore.js`/`sessionPlanSetsCapture.js` (`checkpointImplicit`/`captureImplicit`), `src/app/app.js` (`emitImplicitRecommendation` + off-plan trigger) + `src/app/store.js` (`_sessionImplicitRecs`, snapshot v4), `config/wiring-allowlist.json` (implicitRecommendation now wired), tests `test/implicitRecommendationWiring.test.js`, `test/sessionPlanSetsRoutes.test.js`, `test/store.test.js`. Full suite 5689 pass; lint 0 errors.

### Post-F10 stabilization insertion — F10S1–F10S6 + F10S-GATE (owner-directed, 2026-07-18)

**Authority:** Explicit owner instruction (Dale, 2026-07-18). The July 18 owner Work-mode smoke test is treated as a **failed stabilization gate**: it demonstrated that F10's completion identity is not yet authoritative on every surface, plus two older parser/intent failures. **F10D is paused** — no F10D implementation, no production `Session_Plan_Sets` tab, no production-write enablement, and no live ledger write until every F10S card is complete and the F10S-GATE rerun passes. This is an insertion into this canonical plan, not a second roadmap. **Execution order: F10S1 → F10S2 → F10S3 → F10S4 → F10S5 → F10S6 → F10S-GATE → F10D.**

Rules for the insertion (owner-set): work red-first; one focused PR per card **unless two cards are proven to share one root cause** (record the shared-root-cause evidence in the merge card); route every UI and coach surface through the canonical completion selector (`src/app/planSlotStatuses.js`) rather than patching wording locally. Run the Current-State Verification Gate per card — a card may resolve as root-caused by another card (e.g. F10S2's entry path may prove to be F10S6c), and that verdict must be recorded, not assumed. Positive finding preserved from the smoke test: closeout kept actuals separate and did not overwrite the original plan — the two-truths foundation is sound; the broken part is **progression and binding across surfaces**.

### F10S1 — Planned-slot completion multiplicity

**Status:** COMPLETE

One performed set must not complete an entire multi-set planned slot. Completion status must account for the required set count per `plan_item_id`, not merely whether any performed row matches the item. **Reproduce:** accepted RDL target has 3 working sets; perform one RDL set; the slot remains **in progress**, not complete; rail, pin, next-up, recap, handoff, and closeout agree. (The smoke failure: one RDL set completed the whole RDL slot.)

**Resolution.** `src/app/planSlotStatuses.js` is now set-count aware: `buildSlots` reads the slot's prescribed `sets` as `requiredSets`, and `planSlotStatuses(activePlan, completedNames, sessionLog)` takes the per-set log — attribution (unchanged tiers) claims a slot, but COMPLETION additionally requires the performed-set count to reach `requiredSets` (below it the slot stays PENDING and exposes `performedSets`/`requiredSets`/`attributedName`). The explicit id-outcome lane (Done/skip) stays authoritative; a slot with no known count and legacy no-log callers keep the old rule; over-logging never blocks. Set counting matches rows by the attributed identity OR slot name, floored at 1 when attributed — and `emitSetLogged` now stamps each buffer row with its resolved identity (`canonical`) so alias-form rows ("RDL") count toward their planned lift (`sessionLedger.performedSetCount` honors it too, tightening the F10B frozen floor). Consumers routed: `plannedExerciseEntries` carries `sets`; `remainingPlannedExercises`/`firstUnloggedPlannedLift`/handoff/`isPlanCloseoutAwaitingSave` pass the log; the TODAY rail (`workoutSheet.js renderCards`) passes the log; `getCanonicalSession` replays completions THROUGH the selector (an in-progress slot is not marked done in the AS model and not inserted off-plan — recap/banner/current agree), with `canonicalSessionRecap`'s logged-work gate widened to the raw session log; `isOffPlanLoggedExercise` (F10C) now tests ATTRIBUTION, not completion, so an in-progress planned lift never triggers an implicit recommendation.

**Completion record:** PR — this PR · Commit — `src/app/planSlotStatuses.js`, `src/app/app.js`, `src/app/workoutSheet.js`, `src/app/sessionLedger.js`; red-first `test/planSlotMultiplicity.test.js` (10 cases incl. the smoke reproduce) + `test/planSlotSurfaceParity.test.js` (real-app.js surface agreement on the 1-of-3 case) + harness/pin updates (`activeSessionE2E`, `insertFinisherWiring`, `activeSessionPlanCard`, `postLogIdentity` owner-repro now proves hold-then-advance at 3/3, `identityCorrectionWiring`, `unit.test.js`). Full suite 5703 pass; lint 0 errors.

### F10S2 — Substitution binding

**Status:** COMPLETE

A recognized Front Squat substitution for Back Squat must satisfy the original Back Squat `plan_item_id` everywhere. **Reproduce:** plan Back Squat; perform "Front Squat … instead of Back Squat"; the substitution outcome binds to the original slot; Back Squat does not remain current; next-up advances consistently; the performed exercise remains Front Squat in actuals. (Verify first: the binding layer (`applySessionSubstitution` retains the original `plan_item_id`) may already be sound, with the failed entry path being the one-turn parser — F10S6c. If proven, record the shared root cause and fix at the true layer.)

**Verification verdict (as the card predicted):** the binding layer was sound; the smoke failure's root cause was the ENTRY — the one-turn phrase never parsed (F10S6c, fixed in the parser-grammar PR). This card's fix is the client wiring that carries the parsed directive into the existing binding lane.

**Resolution.** The parse consumer holds `parsed.substitution.for` one-shot (`lastParseSubstitution` — reset at every new parse), and the chat-lane log commit arms the EXISTING deferred-swap lane (Step 373b) with it: `setPendingSubstitution({ prescribed: <original>, prescription: null })` immediately before `emitSetLogged`, so this turn's first logged exercise replaces the named planned slot via `applySessionSubstitution` — original `plan_item_id` retained, `substituted` outcome emitted, F10B revision semantics unchanged (no explicit target → no fabricated revision), completion identity follows the substitute. A directive with no active plan drops harmlessly; one-shot either way, so it can never mis-bind a later log. Multiplicity correctness rides along (F10S1): with no substitute prescription the replacement slot **inherits the original's set count**, so one substitute set can never complete a multi-set slot (an explicit recommender prescription still wins). Proven through the REAL lanes in `test/substitutionBindingWiring.test.js` (real `applySessionSubstitution` + real `emitSetLogged` composed): binds (id retained), Back Squat not current, next-up = the in-progress substitute at 1/3 and advances at 3/3, actuals keep Front Squat, outcome bound to `pi_bsq`, plus structural one-shot wiring pins.

**Completion record:** PR — this PR (entry: the F10S6(b+c) parser PR) · Commit — `src/app/app.js` (`lastParseSubstitution` carrier + chat-commit arming + set-count inheritance in `applySessionSubstitution`); tests `test/substitutionBindingWiring.test.js` (new), `test/pendingClarification.test.js` (window widened, contract unchanged). Full suite 5725 pass; lint 0 errors.

### F10S3 — Single completion-state source

**Status:** COMPLETE

Fix the disagreement where chat says Overhead Press is next while the TODAY rail still shows Back Squat. Every completion/remaining consumer must read the same canonical selector result — no parallel completion state, no locally-derived "next".

**Root cause (verified):** typed session-state questions ("what's next?", "are we done?") were answered by the SERVER's parallel name-matcher (`services/sessionPlanExecutor.js` `computePlanState` via `planStateFromContext`) — which lacks the client selector's variant/ambiguity tiers and (post-F10S1) its multiplicity awareness. One Back Squat set on a 3-set slot: the name-matcher marked it done → chat said Overhead Press; the rail's selector said in-progress → Back Squat. Two engines, two answers.

**Resolution.** The canonical selector's VERDICT now travels with the question: `routeMessageToCoach` sends `context.plan_state` (`planned`/`completed`/`remaining` from the ONE multiplicity-aware selector the rail/pin/recap read) whenever a plan exists, and `planStateFromContext` PREFERS it — validated and bounded (strings only, trimmed, capped at 50) with `isComplete` recomputed server-side (the client flag is never trusted). Every consumer inherits it (the LLM chat context's `plan_state` and the deterministic Step-377 session-close answers read the same struct). A malformed or absent `plan_state` falls back to the legacy name-matcher unchanged (old clients identical). The pre-LLM bare-shorthand lane ("RIR?", "How much?" — `services/sessionQuestionAnswer.js` `currentLiftFromContext`) reads the same verdict: `plan_state.remaining[0]` decides the current lift, so a mid-set question answers for the in-progress lift the athlete is standing at instead of skipping past it (Codex P2). Red-first `test/sessionPlanExecutor.test.js` + `test/sessionQuestionAnswer.test.js`: the smoke reproduces (client verdict outranks the name-matcher; the close answer names the still-remaining lift; mid-set "RIR?" answers the in-progress lift), isComplete recompute, malformed/empty fallback, bounding/cleaning, and the client-wiring pin.

**Completion record:** PR — this PR · Commit — `services/sessionPlanExecutor.js` (`planStateFromContext` preference lane), `src/app/app.js` (`routeMessageToCoach` sends `plan_state`); tests `test/sessionPlanExecutor.test.js` (F10S3 block). Full suite 5731 pass; lint 0 errors.

### F10S4 — Session pin set attribution

**Status:** COMPLETE

The pin must show sets completed for the **current planned item only**, not total session sets. **Reproduce:** the bad state "Back Squat · 4 sets in" after one RDL set plus three Front Squat sets.

**Resolution.** `renderSessionPin` derived its count from `getSessionLog().length` (the whole session) while its current lift came from the selector — the mismatch. Now the pin's identity AND count come from the same selector verdict every other surface reads: `firstUnloggedSlot(activePlanForSlots(), completed, log)` supplies the current slot with `performedSets`/`requiredSets`, rendered as "N of M sets" (or "N sets in" when the slot has no known count — still the item's own count, never the session total). Freestyle (no plan) keeps the session-total behavior unchanged — there is no planned item to attribute to; the plan-complete fallback keeps the total too. Red-first `test/sessionPinAttribution.test.js` (real `renderSessionPin` sliced from the bundle, real selector, DOM-faithful fake pin): the smoke reproduce (1 RDL + 3 off-plan sets → "Romanian Deadlift · 1 of 3 sets", never 4), advancing 2/3 → next slot at 3/3, freestyle unchanged, a no-count slot shows its own 0 — never the off-plan total.

**Completion record:** PR — this PR · Commit — `src/app/app.js` (`renderSessionPin` + `firstUnloggedSlot` import); tests `test/sessionPinAttribution.test.js` (new). Full suite 5737 pass; lint 0 errors; workout-sheet E2E green locally.

### F10S5 — Closeout commentary deduplication

**Status:** COMPLETE

The same substitution/coaching note must appear once, not once per performed set or source path. (The smoke failure: closeout duplicated substitution commentary three times.)

**Root cause (verified):** `/api/log-workout` re-detects the same prescribed→logged substitution on EVERY subsequent set of the substitute, and `handleSetLogged` rendered/forwarded the note each time — three sets, three copies stacking into the closeout view.

**Resolution.** `src/app/coach-conversation.js`: a session-scoped `acknowledgedSubs` set keyed by the case-insensitive `prescribed|logged` pair; `dedupeSubstitutions` gates the incoming substitutions at the top of `handleSetLogged` — the first mention renders (LLM facts + inline extras included, since both read the filtered list), repeats drop, a different pair still renders, an unkeyable entry (missing names) passes through untouched (never over-suppressed), and a session reset clears the set (a fresh session may legitimately repeat the note). Red-first `test/coachConversation.test.js`: structural pins (the gate runs before any rendering; reset clears) + the behavioral smoke reproduce via the sliced real `dedupeSubstitutions` (same pair ×3 → once; new pair renders; case-insensitive identity; unkeyable passthrough).

**Completion record:** PR — this PR · Commit — `src/app/coach-conversation.js`; tests `test/coachConversation.test.js` (F10S5 block). Full suite 5739 pass; lint 0 errors.

### F10S6 — Natural-language intent/parser regressions

**Status:** COMPLETE — (b) and (c) via the parser-grammar pair (one PR — shared root cause: NL grammar gaps in `services/workoutTextParser.js`); (a) via the composer routing PR.

**Resolution (a).** The failing layer was client intent routing, exactly as the card predicted — not the parser. The composer's deterministic planning lane (`looksLikeSessionRequest`, which routes to the ONE canonical in-thread Coach's Pick) recognized "what should I train" / "what are we doing" but not the "what should I do today" family, so the phrase fell through to generic chat, whose no-digit catch-all is the "keep logging" reply the smoke saw. Fix: one additive alternation — `what (should|do) (i|we) do today` — in the pick route. The bare "what should I do" (no "today") deliberately stays OFF the route: during an active session `sessionQuestion.js` answers it from the live prescription (next-up), and claiming it would steal that lane. Digits still rule a phrase out, so workout shorthand can never be swallowed. `services/workoutTextParser.js` untouched — the composer claims the phrase before any parse, and the protected parser contract was not required by this fix.

**Resolution (b, c).** Two tiny additive grammar changes, red-first (`test/parserSmokeGrammar.test.js`): **(b)** `parseWeightRepsAtRir` — `WEIGHT x REPS [@ RIR]` (one set). The surface syntax collides with the existing sets-first claim (`3 x 8 @ 135` = 3 sets of 8 @ 135 lb), so the new reading engages only where sets-first rejects (first number > 10 → a load) and only for a plausible RIR (≤ 6); an implausible pair or a trailing `x3` compound still refuses to a clarification — never a guess, never a silent truncation. The `slp 70 x 12 @2` golden was updated to the owner-superseded truth (its two catastrophic-misparse protections retained). **(c)** a one-turn `<substitute log> instead of <original>` strips the trailing clause, parses the log normally, and carries `substitution: { for: <original> }` on the `log_sets` result — the F10S2 entry path; an unparseable remainder keeps the original full-text clarification (never a half-applied substitution). `225 5/2` byte-for-byte unchanged (golden + new guard).

Reproduce and fix, red-first:

1. "What should I do today?" must invoke **planning**, not the "keep logging" fallback.
2. "Romanian Deadlift 245 x 6 @3" must log correctly (compact slash notation worked; this natural form did not).
3. "Front Squat 185 7/2 x3 instead of Back Squat" must log **and** bind the substitution in one turn.

`services/workoutTextParser.js` is a protected contract: tiny focused grammar additions with live-path tests; the `225 5/2` semantics are untouched. (b) and (c) may share a parser root cause; (a) is intent routing and stays a separate concern unless proven otherwise.

**Completion record:** PR — (b)+(c) the parser-grammar PR (#1061, entry wiring #1062); (a) this PR · Commit — (a) `src/app/app.js` (`looksLikeSessionRequest` + the bare-phrase constraint note); red-first tests in `test/coachConversation.test.js` (smoke reproduce + lane-guard). Full suite 5741 pass / 0 fail; lint 0 errors.

### F10S-GATE — Smoke-test rerun (exit gate for the insertion)

**Status:** RERUN PASSED (2026-07-18) — every exit criterion green; evidence returned to the owner. F10D authorization remains owner-reserved.

After the fixes merge, rerun the **exact same non-destructive** July 18 Work-mode smoke test. Do **not** proceed to F10D until all of:

- one-of-three sets shows **in progress**;
- the substitution completes the **original** slot;
- chat, rail, pin, and closeout **agree**;
- natural-language inputs work;
- closeout commentary is deduplicated.

Return the rerun transcript and screenshots to the owner **before requesting F10D authorization**.

**Completion record:** rerun — `tests/e2e/gate/f10s-gate.spec.js` driving the REAL app end-to-end (real built client + real `index.js` server via `tests/e2e/gate/gate-server.js`, Sheets stubbed in-process/in-memory, no LLM key → deterministic voice, Playwright-marked synthetic traffic). All five criteria asserted HARD and green on desktop **and** mobile projects: 1-of-3 RDL set → slot in progress everywhere (rail current/not-done, pin `1 of 3 sets`, no handoff/closeout); slot completes only at 3/3; one-turn `Front Squat 185 7/2 x3 instead of Back Squat` logs 3 sets **and** satisfies the original slot (accepted `plan_item_id` retained, 3-set grain inherited, next-up advances, actuals 3× Front Squat / 0× Back Squat); chat (`how much?` — the deterministic `plan_state` lane) names Overhead Press agreeing with pin+rail; closeout renders once and the substitution ack appears exactly once across every Atlas bubble; **zero** sheet appends and **zero** tab creations end-to-end (the write phase stays F10D-gated). Runs in the standard E2E suite (154/154 with it). Transcript + 9 screenshots + thread + write-evidence returned to the owner 2026-07-18 (artifacts regenerate under `test-results/f10s-gate/` on every run) · Full suite 5741 pass / lint 0 errors.

### F10D — Confirm and write planned versus actual together

**Status:** COMPLETE (build + proof, 2026-07-18) — **the production gate remains explicitly CLOSED and owner-reserved**: no production `Session_Plan_Sets` tab exists, `SESSION_PLAN_SETS_WRITE_ENABLED` is unset, and zero production ledger writes have occurred. Tab creation, the flag, and the first live write/seal happen only on Dale's explicit authorization per `docs/F10D_PRODUCTION_READINESS.md` §4–§5.

**Owner-expanded contract (2026-07-18).** The single confirmation additionally shows the ORIGINAL accepted plan and the exact rows to be written AND sealed. Closeout SEALS the already-durable ledger rows with the SHARED `closeout_write_id` (never their first persistence); one approval governs Log + Effort + Session_Plans + Session_Plan_Sets with exact proof each; rejection writes nothing; retries idempotent; partial failure fails closed; a ledger failure never claims a fully verified closeout; no retroactive plan mutation. Thirteen proving items (rejected confirmation; approved closeout; plan-to-ledger parity; actual-to-Log parity; substitutions/skips; revised targets; unannounced reliable + no_reliable_target; effort write; idempotent retry; partial append failure; reload/resume; malformed chain fails closed; zero production writes). Before production authorization, return: the PR(s), CI/Codex status, dry-run transcript + screenshots, exact proof payload + failure behavior, exact production tab headers in order, the smallest bounded first-live-write procedure, and the rollback/containment procedure.

**Slice record — F10D-5 (acceptance-boundary corrective, this PR — owner production-canary finding, 2026-07-19).** The first production canary trained FROM a displayed recommendation without pressing "Start this plan": the workout saved to Log_Cleaned but no acceptance rows and no ledger checkpoint existed, and nothing said the plan was not formally active. Corrections, all through the ONE existing acceptance boundary: **(1)** the acceptance gate — a set logged from an unaccepted plan surface (an engaged pick, a materialized-but-unaccepted session, or a merely-displayed pick whose own exercise is being logged, name- or catalog-code-matched) HOLDS at the commit (client state only) and renders one blocking card, "Start this plan to track planned versus actual.", whose single action calls the same `window.atlasAcceptPlan` as the plan card's button; on started (or an honest non-blocking-sidecar degrade) the held message resumes through the one submit path via the REAL submit gesture; a superseded stash is dropped, never replayed (CLIENT-3 seq guard — an in-flight newer message self-commits after acceptance, so replay would duplicate a set); freeform sets unrelated to the displayed plan never gate; an accepted session (including reload-restored) never re-asks; deload keeps its owner-gated flow. **(2)** The intent drawer's "Start Session" now invokes `acceptDisplayedPlan` — the last unaccepted start path is gone. **(3)** A cross-day screenshot closeout no longer forks the session identity: the FB lane keeps the ACCEPTED session id (screenshot date sets the workout DATE only; date-derived ids remain the no-identity fallback) — pre-existing, exposed when the proving stub's date rolled past midnight: the seal targeted a ledger-less date-derived id, honestly-unverified and unrecoverable by retry. Proof: `tests/e2e/gate/f10d-acceptance-boundary.spec.js` (AB-1 blocked + one-acceptance-on-repeated-taps + resume; AB-2 gated acceptance → closeout with Log/Effort/Session_Plans/Session_Plan_Sets on one identity and one seal; AB-3 freeform untouched; AB-4 reload-restored acceptance never re-asks, no duplicate rows) + `test/acceptanceBoundaryWiring.test.js` (9: structural one-path/resume/seq-guard pins + a behavioral gate harness) + truth-updated RC2/e2e fixtures (app-smoke and undo-stale-card mocks de-overlapped — their freeform mechanics scenarios were the canary's own anti-pattern; PR6 engages through the real boundary). Suite 5817 · full E2E 176 (one known pre-existing undo flake, CI-retry-absorbed) · lint 0 errors. Production flag stayed OFF throughout; zero production writes.

**Slice record — F10D-4 (readiness close, #1072, merged `f139b5b` — owner directive 2026-07-18 after bundle review).** The two accepted-with-blockers gaps are closed. **(1) Screenshot-with-rows runs through the ONE closeout:** the upload converts client-side into the standard `/api/log-workout` closeout payload — vision parse (`/api/parse-workout-image`), screenshot-date authority (RC2: a typed date still wins), rows re-stamped under the resolved session identity so Log and Effort can never disagree, `effort_row` + `closeout_context` folded in — inheriting the single confirmation, seal, server-recorded finalized event, `closeout_fully_verified`, and the reachable idempotent retry; the plan-complete upload already routed via the FB lane, and this closes the freestyle / incomplete-plan / typed-rows shapes that previously staged an unconfirmed `/api/complete-workout` write (that lane remains only for effort-only uploads, which are not session closeouts; a converted upload can never fall into the mid-session set-note lane). Proven by three new gate scenarios with a deterministic in-harness vision stub (the real module's camelCase metrics contract): `F10D-SS-R` rejected-writes-nothing (checkpoint durable + unsealed, vision-parse evidence recorded), `F10D-SS-A` approved parity (screenshot-dated rows = visible actuals; the PARSED effort — 00:48:22 · 389/512 cal · 131/168 HR — rides the one approval; one seal id; finalized event), `F10D-SS-RT` seal-outage heal through the review card's own Save (zero duplicate rows/effort/events). **(2) `npm run atlas:review-live` verifies the seal:** new `ledger_sealed` criterion — expected rows exist; every applicable row carries the SAME nonblank `closeout_write_id`; sealed count = correlated count; no mixed/conflicting/partially-sealed/malformed state (chain-validated via the same fail-closed `sessionPlanLedger` selectors the seal uses); Log/Effort/Session_Plans/Session_Plan_Sets agree on session identity and closeout; PASS/FAIL/UNKNOWN with exact evidence ranges and concise reasons; an absent/unreadable tab is UNKNOWN (never inferred — the documented pre-enablement state), and the fully-healthy overall-PASS shape now REQUIRES the seal. Tests: 10 new seal-criterion fixtures in `test/atlasReviewLive.test.js` (sealed-PASS with evidence range, unreadable/absent, readable-empty, pre-closeout-unsealed, finalized-but-unsealed, partial, conflicting ids, sealed-without-finalized, malformed chain, mixed session ids). `docs/F10D_PRODUCTION_READINESS.md` §6 records both gaps closed; §4's verification step is now automatic. Full suite 5806 pass · gate specs 14/14 ×2 + F10S 2/2 · lint 0 errors.

**Slice record — F10D-3 (proving pack + owner return bundle, #1071, merged `f35548f`).** The four contract items needing the live UI path are proven end-to-end in `tests/e2e/gate/f10d-closeout.spec.js` against the real app in the gate harness's new LEDGER SANDBOX posture (`ATLAS_GATE_LEDGER_SANDBOX=1` in `tests/e2e/gate/gate-server.js`: both dry-run flags ON, a stubbed in-memory `Session_Plan_Sets` tab, seal stamps materialized, a one-shot seal-outage control; the default posture is byte-identical to the F10S zero-write baseline and now also proves ZERO column updates): **F10D-R** a rejected (abandoned) confirmation writes nothing while the accept-time checkpoint stays durable and UNSEALED; **F10D-A** one approval writes Log+Effort+finalized event and seals all rows under one `closeout_write_id` with exact visible-actual↔Log parity and immutable original plan codes; **F10D-RL** reload/resume mid-session then closeout seals the SAME pre-reload checkpoint rows; **F10D-RT** a seal outage reports honest-partial and the review card's own Save performs the reachable idempotent retry (zero duplicate rows, event folded, sealed, verified). The pack immediately caught three real confirmation defects, fixed red-first in-slice: `closeoutContextItems` now walks the ACCEPTED IDENTITY SPINE (`session.items`) instead of the mutable working view — an explicitly declined slot previously sent NO context item at all (its card line degraded to a bare ledger code) and the raw slot objects are used so the `plannedExerciseEntries` projection can't erase the substituted outcome; a one-turn substitution that renamed a slot before enrichment assigned its code sent an empty `performed_lift_code`, so the substitute's real sets landed in "unplanned" and the slot showed "not performed" — the client now resolves the code from the catalog and `buildCloseoutSummary` adds a name-grain claim fallback plus a `codeToName` display map (the confirmation never shows a bare code) with the substitution tag naming the original lift ("in for Back Squat"). Coverage map for all 13 proving items + the owner bundle's items 4–7 (exact proof payload and failure behavior; exact 16-column headers; smallest bounded first-live-write procedure; rollback/containment) recorded in `docs/F10D_PRODUCTION_READINESS.md`. The campaign STOPS at the production gate: no tab, no flag, no live write without Dale.

**Slice record — F10D-2 (client confirmation + approval-scoped verification, #1069, merged `8242da5`).** The compiled session closeout attaches `closeout_context` (bounded items from the accepted slots — a substituted slot sends its `performed_lift_code`; the original code stays with the ledger) to the ONE payload, so the dry-run returns the summary and the SAME approved payload seals the ledger; the in-thread review card renders the single confirmation ABOVE the sets card (`buildCloseoutConfirm`: both truths, per-set target→actual facts, substitution/skip/revised tags, unplanned work with no targets, unreadable-ledger + inconsistent-history warnings, and "Approving writes N set row(s) [+ effort][; M ledger row(s) sealed]. Rejecting writes nothing."); the approve handler reads `closeout_fully_verified` and reports an unverified seal honestly ("your sets are safe; tap Save again to retry the seal — no rows will duplicate") instead of a clean success; and the `finalized` closeout event moved INSIDE the approval (the Finish button only opens the confirmation; a rejected confirmation writes nothing — including the event; the typed-"done" lane, which never emitted it, now records finalized on approval too). Five Codex findings (2 P1, 3 P2) all CONFIRMED and fixed red-first in-PR: **(P1)** typed manual effort with buffered rows — the submit's other end trigger — now marks the closeout too (previously it skipped the confirmation/seal path entirely; a screenshot-with-rows saves via `/api/complete-workout` and its confirmation is a filed follow-up, not silently claimed); **(P1)** the `finalized` Session_Plans event moved SERVER-SIDE into the one approved write (`recordCloseoutEvent` → `captureCloseout` with the capture proof envelope; the client's accepted-plan `pv_` token rides `closeout_context.plan_version`; `closeout_fully_verified` now also requires the event captured or genuinely inapplicable; the heal lane re-attempts it idempotently; NO client fire-and-forget remains on the save path — only the non-save End-session affordance still emits at click); **(P2)** the promised seal retry is REACHABLE: the unverified branch keeps the staged write alive with a fresh `write_id`, drops the already-written effort row (never a duplicate-session 409), re-enables Save, and returns before teardown — and a fresh-id retry on an ALREADY-sealed closeout fails closed (`conflicting_seal`, never re-seal); **(P2)** a re-preview removes the stale `.closeout-confirm` before appending the rebuilt one; **(P2)** the card renders absent load as loadless reps ("15 reps@2") and only true bodyweight (0) as "BW×12@2" — never conflated. Tests: `test/closeoutConfirmWiring.test.js` (12), integration additions (event-captured approval, freestyle no-event, failed-seal heal re-attempting BOTH lanes, already-sealed fail-closed). Full suite 5794 pass / e2e 154/154 / lint 0 errors.

**Slice record — F10D-1 (server seal + confirmation summary, #1068, merged `5f55fd2`).** `sheets.updateColumnCells` (the one bounded single-column update primitive — the seal stamp); `sessionPlanSetsStore.sealCloseout` (dry-run proof by default; live: idempotent same-id replay, conflicting-seal fails closed, chain-validates first — no partial seal, exact updated-cell proof or `seal_proof_mismatch`) + `readLedgerRows` (null on read failure — never "no stored plan" on an unreadable ledger); `services/closeoutSummary.js` (pure: two truths, per-set target-vs-actual deltas against the set's OWN effective version, substitutes join the original item via `performed_lift_code`, unplanned actuals carry NO target fields, malformed history surfaced with diagnostics); `/api/log-workout` extension presence-gated on `closeout_context` (per-message previews byte-identical): dry-run returns `closeout_summary` + `ledger_seal_preview`; the live write seals under the SAME `write_id` and reports `ledger_seal` + `closeout_fully_verified` (a seal failure after committed appends is honest-partial, never a false verification); the all-duplicate lane re-attempts the seal so a fresh-write_id retry HEALS an unsealed closeout without re-appending. Tests: seal block in `test/sessionPlanSetsStore.test.js`, `test/closeoutSummary.test.js`, F10D block in `test/api-smoke.test.js` (prod-today posture), `test/closeoutSealIntegration.test.js` (sandbox posture, flag on: parity, same-write_id replay, seal-failure honesty, heal, partial append fail-closed, malformed chain). Two Codex P1s CONFIRMED and fixed red-first in-PR: an UNREADABLE ledger (metadata or row read outage) now fails the seal closed as `ledger_read_failed` — never a verified `no_ledger` no-op (`_probeTab` distinguishes confirmed-absent from unreadable; `readLedgerRows` returns null on outage); and `closeout_fully_verified` treats a PLANNED closeout with zero ledger rows as NOT verified (a lost checkpoint or missing tab never masquerades as success; a freestyle no-item session stays verified-empty). Full suite 5778 pass / lint 0 errors.

**Objective**

Extend the **existing** closeout flow — do not create a second save workflow. When the athlete says Done or uploads the effort screenshot, the existing confirmation must show: final effective Atlas plan; actual performed sets; substitutions/pivots; skipped/replaced work; target-vs-actual differences; any no-reliable-target items; session date and effort information. The owner approves the whole closeout **once**.

**Required trust behavior**

- Rejected confirmation writes nothing; approved actual rows equal the visible actual rows; approved plan-ledger rows equal the visible effective plan/history.
- Original recommendations remain append-only history; final effective plan is clearly distinguished from the original plan.
- Log, Effort, and plan-ledger writes return exact proof; partial append failure never produces a false success; retries are idempotent; a plan-ledger failure does not silently leave Atlas claiming a fully verified closeout; no retroactive plan mutation during closeout.

Use dry-run and sandbox/integration coverage. A production schema application or real write remains owner-gated.

**Completion record:** PRs #1068 (`5f55fd2`, server seal + summary) · #1069 (`8242da5`, client single confirmation + approval-scoped verification) · #1071 (`f35548f`, proving pack + owner bundle) · the F10D-4 readiness-close PR (this PR — screenshot-with-rows through the one closeout; `atlas:review-live` seal criterion; squash commit recorded in the owner return). Build + proof complete in dry-run/stub/sandbox only; **production enablement (tab, flag, first live write/seal) remains owner-reserved and has NOT occurred.**

### F10E — Plan-aware historical assessment

**Status:** QUEUED

**Objective**

Build deterministic planned-versus-actual assessment using stored effective prescriptions. Allowed outcomes when a valid target exists: met plan; exceeded reps; used more/less load; worked closer to / farther from failure; completed fewer/more sets; met revised plan; self-selected work versus Atlas recommendation.

**Rules**

- Compare each actual set only to the recommendation effective for that set; a revision after set 1 cannot change set 1's target.
- Replaced/skipped items follow plan-outcome semantics; PRs derive from actual execution only.
- Historical sessions without stored plans receive benchmark/trend descriptions only; never fabricate a plan for legacy history; do not backfill old sessions from today's recommendation.
- Update challenge/reassure/progress wording to use plan-aware results when available and honest benchmark wording otherwise. (This completes the truthfulness fix begun in F09J.)

**Completion record:** PR — · Commit —

## 8. Milestone M3 — Cross-seam proving packs

### F11 — Deterministic V1 proving packs

**Status:** QUEUED

**Objective**

Prove the repaired seams together using the existing simulation, Flight Recorder replay, and Playwright infrastructure. Do not create a fourth test framework.

**Required packs**

- **SIM-DALE:** normal owner-like three-day training language, substitutions, edits, closeout, and proof.
- **TERSE:** compact gym notation and fragmented updates.
- **RAMBLER:** long dictation, corrections, multiple intents, and late clarification.
- **CHAOS extension:** every repaired F02–F10 historical failure replayed across its nearest real seam.

**Owner-directed expansion (2026-07-16 stabilization).** The proving packs must additionally include: normal owner-like plan and logging; a complete set-structured plan; explicit substitution; unannounced exercise; post-set plan revision; actual differing from plan; repeated accessory-set notation; bodyweight bare-rep entry; a PR claim; rejected confirmation; approved planned-versus-actual closeout; reload/resume; stale-response race; Flight Recorder full replay; automatic latest-live-test review; a legacy session with no historical plan; and all prior F02–F10 (and F09A–F10E) failures. Keep deterministic checks blocking and model-wording evaluation advisory. Do not create another test framework.

**Acceptance criteria**

- Tier-1 deterministic packs run in normal CI and are blocking.
- LLM wording scans remain advisory/report-only; no nondeterministic model judge becomes a hard gate.
- Every F02–F10 and F09A–F10E fix has at least one cross-seam fixture in addition to its focused regression.
- Failures identify the exact stage and preserve replay artifacts without secrets or production data.

**Likely surfaces**

`scripts/sim/`, `test/fixtures/replays/`, Playwright suites, CI workflow/config only as necessary.

**Owner gate**

None for synthetic/dry-run packs. Real production writes remain prohibited without authorization.

**Completion record:** PR — · Commit —

## 9. Milestone M4 — Five-session V1 proving run

Begins only after F11 is deployed. Feature development pauses. The run uses five owner-live cards created in `docs/TEST_QUEUE.md` when the run starts.

### Stabilization retest gate (owner-directed 2026-07-16)

After all F09A–F10E cards and the expanded F11 are green, and before M4's five-session count may begin:

1. Verify the exact deployed commit.
2. Verify Flight Recorder client **and** server capture are enabled.
3. Verify `ATLAS_TIMEZONE=America/Vancouver`.
4. Report whether a production Sheet schema action remains, and the exact smallest owner action if schema activation is required.
5. Create one bounded owner live-retest card (in `docs/TEST_QUEUE.md`) covering: plan generation; conversational logging; one pivot; one unannounced exercise; final planned-versus-actual confirmation; screenshot effort; approval and exact write proof; and automatic `atlas:review-live` review.

**The failed 2026-07-16 session does not count toward the five-session proving run. The five-consecutive-session M4 count does not begin until this stabilization retest passes.**

### Clean-session definition

A clean session has:

- no fabricated, dropped, or misinterpreted set;
- correct lift identity, weight, reps, RIR, units, and date;
- no false save claim, duplicate write, or missing exact proof;
- no stale preview or stale coach narration;
- correct remaining/completed session state;
- factual, calibrated naturally occurring coach reactions;
- no white screen or broken transition;
- owner review within 24 hours.

A material defect resets the consecutive-clean count to zero. Evidence → replay → fix → deploy → restart. Three resets trigger a focused root-cause review before another attempt.

### Session A — Normal workout + write proof

Planned workout; edit at least one preview row; add more work; save; verify exact ranges/counts and bound Undo identity.

### Session B — Screenshot closeout

Import a screenshot with a real session date; verify Log and Effort date equality; save; verify proof; exercise safe Undo/resave if desired.

### Session C — Substitution + plan mutation

Substitute one exercise, reorder or skip another, add an off-plan exercise; verify recap/next-up/pin/handoff/closeout/Workout Sheet agree.

### Session D — Interrupted + resumed

Reload/resume; exercise retry-safe closeout state; intentionally race dry-run/preview responses; verify an older response cannot overwrite the latest.

### Session E — Ambiguous + natural language

Use terse notation, long dictation, and one intentionally ambiguous set format; Atlas must ask instead of guess, then complete normally.

### Evidence per session

Date/session ID · app version/deployed commit · scenario coverage · Flight Recorder reference · writes and exact proof ranges · observed coach behavior · defects · owner verdict · current clean count.

## 10. Milestone M5 — V1 declaration and stabilization

### F12 — Declare Atlas V1

**Status:** BLOCKED on five clean sessions

**Acceptance criteria**

- F01–F11 complete.
- No open P0/P1 finding can silently damage logging, preview approval, session truth, or write verification.
- Full automated suite and proving packs green.
- Five consecutive clean sessions recorded.
- Release record captures deployed commit, evidence links, known non-blocking limitations, rollback point, and the owner declaration.

**Completion record:** PR — · Commit —

### Two-week defect-only stabilization

For at least two weeks after F12:

- use Atlas normally;
- fix only demonstrated defects with a reproduction;
- no new capability roadmap;
- no database/storage migration;
- no frontend-framework rewrite;
- no public/multi-user expansion;
- no voice re-ratification from one awkward sentence;
- no speculative cleanup PRs.

Exit review:

- Did Atlas remain trustworthy?
- Which surfaces were actually used or ignored?
- What defects recurred?
- Is the next work UI simplification, deeper personal coaching, or a separately authorized public-product phase?

## 11. Parallel lane P-A — One-Brain promotion

This lane accumulates evidence while M1–M5 proceed. It does not block Soul closeout, trust hardening, proving packs, or the V1 proving run unless a specific card explicitly depends on promotion.

The authoritative evidence standard remains `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`.

Required before any promotion:

- varied genuine athlete activity across multiple sessions/days/lifts;
- production scorecard;
- zero unsafe recommendations and zero unresolved orchestrator errors;
- human safety/quality review of representative and divergent cases;
- explicit owner decision per decision type.

Crossing a numerical threshold never flips a flag automatically. Promotion, burn-in, and eventual legacy-lane deletion remain separate owner-governed work.

## 12. Explicitly outside this campaign

Do not add these while this plan is active unless Dale explicitly changes direction:

- Supabase/Postgres/SQLite or any second permanent store;
- multi-user/public-product architecture;
- nutrition tracking;
- broad wearable-vendor expansion;
- native mobile app;
- frontend-framework rewrite;
- another agent/orchestrator platform;
- new coaching-intelligence roadmap;
- profanity activation;
- speculative UI redesign;
- broad cleanup unrelated to a demonstrated trust/product problem.

**Owner deferral decision (2026-07-21) — Knowledge Foundation owner-reserved P0 items.** Following the Atlas Knowledge Foundation reconciliation ([`research/knowledge-foundation/README.md`](research/knowledge-foundation/README.md)), the owner has **intentionally deferred** (not forgotten) the following until after V1 stabilization:

1. The four nutrition/supplement regression fixture families — protein targets; pre/post-workout nutrition; hydration and electrolytes; supplement efficacy, product and interaction cases.
2. Clinical population-gate expansion and professionally-reviewed symptom-routing work **beyond the existing V1 `SafetyDecision` scope** (Phase 5d).

Nutrition and supplements stay outside the V1 build scope; clinical populations and professional review require a separately governed expansion. These items **do not block V1 stabilization or the current Recovery Campaign**, and this decision **reorders nothing** — campaign phase ordering is unchanged. They **may be reconsidered only after V1 stabilization and another explicit owner decision**. **No implementation is authorized** by this decision, and existing conservative safety/referral behavior must not be weakened. The completed knowledge foundation remains the canonical reference for this future work.

## 13. UI work after stabilization

The current UI is allowed to be imperfect during finishing. After M5, run a separate evidence-based simplification review using actual owner behavior:

- what Dale uses every session;
- what he never opens;
- where the workout flow creates friction;
- which controls belong in conversation, the Workout Sheet, or the drawer;
- what can be removed rather than redesigned.

No UI plan is pre-written here. The point is to finish and observe before decorating.

## 14. Fresh-session launcher

A new Claude Code session can begin with:

> Read `CLAUDE.md` and `docs/ATLAS_V1_EXECUTION_PLAN.md`. Execute the first eligible unfinished card. Run the Current-State Verification Gate before editing, use one concern per PR, merge the exact passing head under standing authority, update the card's completion record, refresh `main`, and continue. Stop only for an explicit owner-reserved gate.

Before implementation, report only:

1. active milestone;
2. next eligible card;
3. current-state verdict;
4. whether code is actually required;
5. any genuine owner gate.

## 15. Plan maintenance

- This file is updated only for real campaign state, a proven stale premise, or a necessary split of one card into safer one-concern PRs.
- Do not add a second roadmap, phase plan, campaign controller, fix-it document, or session-specific master prompt.
- Narrow specs may be added when a card genuinely requires design, but the card remains the sequencing authority.
- New discoveries go to `BACKLOG.md`; they enter this plan only through an explicit owner-approved campaign change.
- Git history is the archive. Completed-plan prose does not need to remain in the live documentation tree.

> **Finish. Prove. Declare. Then make it pretty.**
