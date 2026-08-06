# Atlas System Authority

**Current as of:** 2026-07-31 · **Basis:** Atlas Recovery Campaign (Issue #1073), Phase 4 · **Status:** current-state authority map, refreshed as authority moves.

This document answers one question per concept: **what actually decides this in production today, and what is intended to decide it.**

It **supersedes and replaces** `docs/ATLAS_OWNERSHIP_CONNECTIVITY_INVENTORY.md`, which was removed in the same change. That inventory listed routes, services, modules, flags, tabs, and documents with keep/adapt/retire dispositions. Its verified evidence is preserved below, rewritten along the axis that matters for Phase 4: authority, not enumeration. There is exactly one ownership document, and this is it.

This map **records** authority. It selects no work and authorizes no change. [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md) remains the sole work-selection and sequencing authority.

## The honesty rule

A concept is promoted only on **current production evidence**. A contract file, an import, a unit test, a passing suite, or a sentence in a document is **not** evidence of production authority.

These levels are distinct and are never collapsed. They are the same rungs the completion ladder uses (`config/coaching/manifests/capabilities.json`, Drift Guard 4):

| Level | What it means |
|---|---|
| **contract defined** | A schema/validator exists. Nothing consumes it. |
| **module imported** | Some file requires it. The importer may itself be dark. |
| **runner wired** | A runner or assembler calls it, off the request path. |
| **production reachable** | A production root can reach it, possibly behind an inert flag. |
| **route consumed** | A live route calls it while serving a real request. |
| **user visible** | Its result reaches the athlete's screen. |
| **live proven** | A recorded live run demonstrates it, with a linked test or trace id. |
| **sole live authority** | It is the only thing deciding the concept in production. |
| **owner accepted** | Dale has accepted it. Owner-gate only. |

**A contract consumed only by the shadow assembler is CONTRACT ONLY, not authority.** A flag-gated path that is inert by default is TRANSITIONAL, not sole.

## Status vocabulary

| Status | Meaning |
|---|---|
| **SOLE LIVE AUTHORITY** | One owner decides it in production. No competing live path. |
| **TRANSITIONAL** | The intended owner exists and is reachable, but is flag-gated, partial, or runs beside the incumbent. |
| **DUPLICATED** | Two or more live paths decide it today. |
| **CONTRACT ONLY** | A canonical contract exists; no production route consumes it. |
| **TEST/OBSERVABILITY ONLY** | Real and useful, but deliberately off the product path. |

---

## Summary

| # | Concept | Current live authority | Intended sole authority | Status |
|---|---|---|---|---|
| 1 | Active workout/session state | route-local assembly + `coachSessionSnapshot` (flag-gated) | `WorkoutSession` | TRANSITIONAL |
| 2 | Planned-slot completion | `planSlotStatuses` / `planCompletion` (client) + `sessionPlanExecutor` (server) | one server-side completion state | DUPLICATED |
| 3 | Set revisions | `setRevisionProposal` + `setRevisionFollowup` (client) | one set-revision state machine | TRANSITIONAL |
| 4 | Exercise identity | name-keyed resolvers + `Exercise_Catalog` joins | immutable `ExerciseIdentity` registry | DUPLICATED |
| 5 | Coaching decision | route-local recomputation; `coachingDecision` partly consumed | `CoachingDecision` | TRANSITIONAL |
| 6 | Visible coach wording | `coachRunners` / renderer chain + deterministic fallbacks | engine decides, LLM words | TRANSITIONAL |
| 7 | Safety | `constraintDetector` **and** `constraintResolver` | `SafetyDecision` | DUPLICATED |
| 8 | Substitution | `turnPrecedence` (flag-gated) + legacy route-local reading | `turnPrecedence` | TRANSITIONAL |
| 8b | Substitution decision + mutation | `pendingReplacement` proposal → `applySessionSubstitution` | same | **SOLE LIVE AUTHORITY** |
| 9 | Preview approval | `/api/log-workout` + client approve path | unchanged — already single | SOLE LIVE AUTHORITY |
| 10 | Turn/write correlation | `turnCorrelation` | `turnCorrelation` | SOLE LIVE AUTHORITY |
| 11 | Durable Sheet write | `sheets.js` | `sheets.js` | SOLE LIVE AUTHORITY |
| 11b | Write verification (did the log rows land) | `services/appendWriteProof.js` over the append receipt | same | **SOLE LIVE AUTHORITY** |
| 12 | Closeout and seal | `/api/complete-workout` + closeout lane + `ledger_seal` | one CloseoutTransaction | TRANSITIONAL |
| 13 | InteractionTrace / turn-write proof | `interactionTraceShadow`, `turnCorrelation` (flag-gated) | same, graduated to live | TEST/OBSERVABILITY ONLY |
| 14 | Deload | `deloadEngine`, `deloadProtocols`, `deloadState`, `deloadStateMachine`, `deloadPolicy` | one `DeloadLifecycle` | DUPLICATED |
| 15 | Frontend coordination | `src/app/app.js` monolith + extracted modules | extracted modules; shell coordinates | TRANSITIONAL |
| 16a | Observational shadows | `coachTurnPacketShadow`, `brainShadow`, `intentShadow`, `driftShadow`, `coachShadowSheet`, `coachResponseSheet` | none — all retire | TEST/OBSERVABILITY ONLY |
| 16b | `legacyBridge` (live browser bridge) | `src/app/legacyBridge.js`, imported on every page load | none — deleted, not promoted | TRANSITIONAL |
| 17 | Athlete context (profile, level, equipment, readiness) | `ATLAS_PROFILE_GOAL` env var only; other fields have no live source | one layered `AthleteContext` | CONTRACT ONLY |

---

## 1. Active workout/session state

- **Current live authority.** Route-local assembly in `routes/coachOps.js`, plus `buildCanonicalSessionSnapshot` (`services/coachSessionSnapshot.js`) at exactly one call site, `routes/coachOps.js:1281`.
- **Intended sole authority.** The canonical `WorkoutSession` contract (`services/workoutSession.js`).
- **Competing authority.** The pre-existing route-local state assembly, which still serves every turn when the flag is off.
- **Status.** TRANSITIONAL.
- **Exact production consumer.** `routes/coachOps.js` — the state-answerable lanes ("what's next?", "are we done?").
- **Compatibility bridge.** `ATLAS_TURN_PRECEDENCE`, **default inert**. Flag off means byte-identical prior behaviour.
- **Sunset condition.** Remove the flag and the route-local assembly once Stage A and Stage B both pass and `buildCanonicalSessionSnapshot` is the only session-state source on the live path.
- **Phase 4 relevance.** Direct — this is criterion 3 of the canonical proof (H-08).
- **Later phase.** Phase 5g finishes the extraction.
- **Evidence.** `services/workoutSession.js` is required by `coachSessionSnapshot`, `coachTurnPacket`, `coachTurnPacketShadow`, `sessionPlanExecutor`. Only `coachSessionSnapshot` reaches a live route.

## 2. Planned-slot completion

- **Current live authority.** Client modules `planSlotStatuses.js` / `planCompletion.js`, alongside server-side `services/sessionPlanExecutor.js`.
- **Intended sole authority.** One server-side completion state that the client renders rather than derives.
- **Competing authority.** The client derivation and the server executor can each answer "is this slot done?".
- **Status.** DUPLICATED.
- **Exact production consumer.** `routes/coachOps.js` (server) and the workout sheet/rail render path (client).
- **Compatibility bridge.** None declared. The duplication is live, not bridged.
- **Sunset condition.** Delete the client-side derivation once the server completion state is route-consumed and the rail, pin, chat, and closeout all read it.
- **Phase 4 relevance.** Indirect — F10S3 already required these to agree; agreement is not single authority.
- **Later phase.** Phase 5g.
- **Evidence.** `sessionPlanExecutor` is required by `routes/coachOps.js` and `services/sessionCloseout.js`; the client modules are listed in `src/app/`.

## 3. Set revisions

- **Current live authority.** `src/app/setRevisionProposal.js` (structured proposal + future-set selector) and `src/app/setRevisionFollowup.js` (language classification only).
- **Intended sole authority.** One set-revision state machine that both the proposal card and natural-language turns route through.
- **Competing authority.** Retired by the 2026-07-29 owner authorization: the typed lane is a router over the existing `approvePendingSetRevision` / `rejectPendingSetRevision` / `explainPendingSetRevision`, and adds no second approval implementation.
- **Status.** TRANSITIONAL — one state machine, still client-side and still dry-run at the ledger.
- **Exact production consumer.** The composer submit path in `src/app/app.js`, and the `#1194` proposal card.
- **Compatibility bridge.** `SESSION_PLAN_SETS_WRITE_ENABLED`, **default `0`** — the ledger write stays dry-run.
- **Sunset condition.** Bridge closes when the owner sets the flag at the Stage B gate and the ledger write is proven.
- **Phase 4 relevance.** Direct (H-09).
- **Evidence.** `services/setRevisionProposal.js` does not exist; both modules are client-side under `src/app/`. `test/setRevisionFollowupRouting.test.js` carries 59 proofs.

## 4. Exercise identity

- **Current live authority.** Name-keyed resolvers and `Exercise_Catalog` joins (`canonicalizeExerciseName` and the catalog read paths).
- **Intended sole authority.** An immutable `ExerciseIdentity` registry; every other representation an alias or projection.
- **Competing authority.** `services/exerciseIdentity.js` exists as a contract but is required **only** by `services/coachTurnPacket.js`.
- **Status.** DUPLICATED — the live joins decide identity; the contract decides nothing.
- **Exact production consumer.** `routes/reads.js` catalog/exercise reads; parser identity resolution.
- **Compatibility bridge.** None. This is unmigrated, not bridged.
- **Sunset condition.** Retire the name-keyed joins once the registry is route-consumed and the 32 residual divergences are ruled on.
- **Phase 4 relevance.** Bounded — Phase 4 must not claim identity is canonical.
- **Later phase.** Phase 5b (Identity Ruling Day), H-11.
- **Evidence.** `grep` for requirers of `services/exerciseIdentity` returns `services/coachTurnPacket.js` only.

## 5. Coaching decision

- **Current live authority.** Route-local recomputation in `routes/coachOps.js`, with `services/coachingDecision.js` consumed at the two seams proven in GATE RUN 1 (recommendation-explanation, recovery-routing).
- **Intended sole authority.** `CoachingDecision`.
- **Competing authority.** The route still recomputes decisions the packet also carries.
- **Status.** TRANSITIONAL.
- **Exact production consumer.** `index.js` requires `services/coachingDecision.js` directly; `routes/coachOps.js` consumes it at the two proven seams.
- **Compatibility bridge.** `ATLAS_TURN_PRECEDENCE`, default inert.
- **Sunset condition.** Remove route-local recomputation as `npm run atlas:divergence` clears; add the recomputation pattern to Drift Guard 2 as each finding retires.
- **Phase 4 relevance.** Direct (H-03).
- **Evidence.** `coachingDecision` is the only canonical contract required from a production root.

## 6. Visible coach wording

- **Current live authority.** The `coachRunners` / persona / renderer / polish chain, plus deterministic fallbacks when the model is unavailable.
- **Intended sole authority.** The engine decides every number and verdict; the LLM only words whitelisted facts.
- **Competing authority.** Multiple renderer/polish modules can shape the same visible line.
- **Status.** TRANSITIONAL.
- **Exact production consumer.** `POST /api/coach/message`, `/api/coach/chat`, `/api/coach/ask`.
- **Write posture — precise.** These routes are **read-only with respect to the training record**: they never append to `Log_Cleaned`, `Effort`, or any tab the preview→approve→write loop owns. They are **not** write-free. When `ATLAS_INTERACTION_TRACE=shadow` is set and the turn is not classified synthetic, `services/coachQaShadow.js` runs after the response finishes and calls `coachTurnPacketShadow.observe(...)` then `coachResponseSheet.persist(...)` (`services/coachQaShadow.js:196-197`), which append **telemetry** rows to `Coach_Shadow` and `Coach_Response`. Those appends are flag-gated, post-response, and provenance-tagged, and they are the same appenders listed under concept 11. Do not describe these routes as "never write Sheets" — that wording hid a real production write from safety and schema review.
- **Compatibility bridge.** The deterministic fallback is permanent by design, not a bridge: an outage must degrade to templated or null behaviour, never a guess.
- **Sunset condition.** Not a removal target. The consolidation target is one renderer chain, in Phase 5f.
- **Phase 4 relevance.** Bounded — Drift Guard 2 already forbids the contentless normal-path receipt (H-02).
- **Evidence.** Voice corpus + `test/soulGoldenTranscripts.test.js` score behaviour, not wording.

## 7. Safety

- **Current live authority.** **Two live classifiers.** `services/constraintDetector.js` is required by `index.js` and `services/turnPrecedence.js`; `services/constraintResolver.js` is required by `services/coachRunners.js`.
- **Intended sole authority.** `SafetyDecision` (`services/safetyDecision.js`).
- **Competing authority.** The two classifiers above.
- **Status.** DUPLICATED. `safetyDecision` is required **only** by `services/coachTurnPacket.js` — it is CONTRACT ONLY and decides nothing live.
- **Exact production consumer.** `index.js` and the coach runner chain.
- **Compatibility bridge.** None.
- **Sunset condition.** Delete the loser once one `SafetyDecision` is consumed by the live route and the Brain alike; add "duplicate safety classifiers" to Drift Guard 2 at that point.
- **Phase 4 relevance.** Bounded — Phase 4 must not claim `packet.safety` is authoritative.
- **Later phase.** Phase 5d, H-12.
- **Evidence.** The requirer lists above are the duplication proof.

## 8. Substitution

- **Current live authority.** `services/turnPrecedence.js` when `ATLAS_TURN_PRECEDENCE` is on; the legacy `intent || isConstraintMessage` reading when off.
- **Intended sole authority.** `turnPrecedence` as the one current-message decision.
- **Competing authority.** The legacy route-local reading, still live by default.
- **Status.** TRANSITIONAL.
- **Exact production consumer.** `POST /api/suggest-substitute`; `turnPrecedence` is required by `index.js`, `routes/coachOps.js`, and `services/coachQaShadow.js`.
- **Compatibility bridge.** `ATLAS_TURN_PRECEDENCE`, default inert — flag off is byte-identical.
- **Sunset condition.** Delete the legacy reading and the flag once Stage A and Stage B pass with the flag on.
- **Phase 4 relevance.** Direct — this was the Phase 4 first concern (divergence D5/D6).
- **Evidence.** `test/turnPrecedence.test.js`; `test/api-smoke.test.js` flag-on/flag-off regressions.

## 8b. Substitution decision and mutation

- **Current live authority.** The ONE pending proposal (`store.pendingReplacement`, built by `src/app/activeReplacement.js`) decides; `applySessionSubstitution` (`src/app/app.js`) is the ONE mutation transition, which retains the original `plan_item_id` and emits the one canonical `Session_Plans` `substituted` `item_outcome`.
- **Intended sole authority.** The same. Resolved by F-SB3 (owner ruling 2026-08-02).
- **Competing authority.** None remaining. The engine lanes' own decision state is gone: `checkAndSuggestSubstitute` and `tryProposeImplicitSubstitution` now stage the same proposal instead of parking a cross-turn `pendingSubstitution` / mutating immediately. Coach prose is no longer a second claim authority either — a substitution turn on the read-only `/api/coach/chat` is answered deterministically (`coachResponseGrounding.buildSubstitutionAnswer`), so the model is never asked.
- **Status.** **SOLE LIVE AUTHORITY.**
- **Exact production consumer.** The composer substitution lanes (`tryProposeReplacement`, `tryProposeImplicitSubstitution`, `checkAndSuggestSubstitute`), the acceptance paths (`approvePendingReplacement`, `bindLoggedSubstituteToProposal`), and `closeoutVerification` (`index.js`) via `detectSubstitutionContradictions`.
- **Compatibility bridge.** `pendingSubstitution` survives ONLY as the one-turn "\<substitute log\> instead of \<original\>" token (F10S2), armed and consumed inside a single log commit. It is no longer persisted to or restored from the session snapshot, so it cannot cross a turn or a reload. Requirement D of the ruling explicitly permits it.
- **Sunset condition.** The token folds into the proposal object when `src/app/app.js` is extracted in Phase 5 (H-21); at that point `pendingSubstitution` is deleted from the store outright.
- **Phase 4 relevance.** Direct — this is the F-SB3 card.
- **Evidence.** `test/substitutionProposalLifecycle.test.js` (A–E lifecycle + negatives, with four mutation bite proofs), `tests/e2e/substitution-truth.spec.js` (the owner's exact flow through the real browser path; fails on `origin/main`), `test/closeoutSealIntegration.test.js` (closeout coherence end to end), `test/coachResponseGrounding.test.js` (the deterministic answer).

## 9. Preview approval

- **Current live authority.** `POST /api/log-workout` with the client approve path; `test_mode` absent means live write.
- **Intended sole authority.** Unchanged. This is already single-owner and is the trust loop.
- **Competing authority.** None.
- **Status.** **SOLE LIVE AUTHORITY.**
- **Exact production consumer.** The composer preview → approve → write path (`#preview-btn` → `#approve-btn`).
- **Compatibility bridge.** None.
- **Sunset condition.** None. This is not a migration target and is never weakened without the owner.
- **Phase 4 relevance.** Untouchable — preview→approve→write is invariant.
- **Evidence.** `test/trustLoopProof.test.js`, `test/idempotency*`, Invariants W1–W3.

## 10. Turn/write correlation

- **Current live authority.** `services/turnCorrelation.js`.
- **Intended sole authority.** The same.
- **Competing authority.** None.
- **Status.** **SOLE LIVE AUTHORITY** for the correlation identity, though its emission is flag-gated (see 13).
- **Exact production consumer.** `index.js` and `routes/coachOps.js`.
- **Compatibility bridge.** None.
- **Sunset condition.** None — this is the one `turn_id` spine.
- **Phase 4 relevance.** Direct — one turn id must span input to write proof.
- **Evidence.** `turnCorrelation` is required by `index.js`, `routes/coachOps.js`, `services/coachQaShadow.js`, `services/turnWriteArtifact.js`.

## 11. Durable Sheet write

- **Current live authority.** `sheets.js` — the only module holding the read-write scope (`appendRows`, `deleteRowsByRange`, `batchUpdate`).
- **Intended sole authority.** The same.
- **Competing authority.** None for the transport. Write *initiation* is multi-site: `index.js`, `routes/coachOps.js`, and the telemetry services `brainShadow`, `coachResponseSheet`, `coachShadowSheet`, `deloadState`, `flightRecorder`, `intentShadow`.
- **Status.** **SOLE LIVE AUTHORITY** (transport).
- **Exact production consumer.** Every write route plus the shadow/telemetry appenders.
- **Compatibility bridge.** None.
- **Sunset condition.** None for `sheets.js`. The shadow appenders retire with concept 16.
- **Phase 4 relevance.** Untouchable — no schema change without a migration and the owner.
- **Evidence.** The structural guarantee is that read-only tools build their own `spreadsheets.readonly` client and never import these helpers.

## 11b. Write verification (did the log rows land)

- **Current live authority.** `services/appendWriteProof.js`, adjudicating the `updates`
  envelope that `spreadsheets.values.append` returns, published by `POST /api/log-workout`
  as `log_write_verification`.
- **Intended sole authority.** The same.
- **Competing authority.** `GET /api/log-workout/verify-range` — a separate, later read of
  the appended range, checking the row count and the session_id column. It decided the same
  concept and cost one metered Sheets read per successful Save, spent at closeout: the exact
  moment the 2026-08-05 qualifying session exhausted its 60-read minute. The receipt wins
  because it is produced by the operation that performed the write, contemporaneously with
  it, and it establishes the same two facts plus the exact range at no quota cost.
- **Status.** **SOLE LIVE AUTHORITY** on the normal Save path; the read-back survives only
  as the named fallback below.
- **Exact production consumer.** `src/app/app.js`, the approve handler: it reads
  `log_write_verification` and renders the verification note from it. The branches are
  exclusive — the fallback is unreachable when a verdict is present, including when the
  verdict is `verified: false`, so a negative answer from the authority can never be
  laundered by re-asking the weaker source.
- **Compatibility bridge.** `GET /api/log-workout/verify-range` and the client's `else`
  branch, reached ONLY when the server returned no verdict at all — a deployment older than
  this field. The route itself is unchanged and still enforces its Log_Cleaned-only,
  row-span and session-ownership checks.
- **Sunset condition.** Delete the route, `verifyWrittenRange`, and the client's fallback
  branch once no deployment reachable by this client omits `log_write_verification` —
  concretely, when `POST /api/log-workout` has published it for a full campaign phase and no
  qualifying session's evidence records a fallback invocation.
- **Phase 4 relevance.** Indirect: it is a read-budget corrective, not a trust-contract
  change. Preview → approve → write is untouched, `test_mode` semantics are untouched, and
  the W1–W3 proof fields are untouched — `log_write_verification` is added beside them and
  replaces nothing they assert.
- **Evidence.** `test/appendWriteProof.test.js` (the adjudicator's every insufficiency, and
  a real Save whose verdict is compared against what the append reported at the googleapis
  boundary); `tests/e2e/write-verification-authority.spec.js` (the browser makes exactly one
  verification request per Save, and with a verdict present that number is zero).

## 12. Closeout and seal

- **Current live authority.** `POST /api/complete-workout`, the closeout lane, `POST /api/session-plans/closeout`, and the `ledger_seal` stamp.
- **Intended sole authority.** One `CloseoutTransaction`.
- **Competing authority.** The closeout reconstruction lane still exists beside buffer capture.
- **Status.** TRANSITIONAL. `services/closeoutTransaction.js` is required **only** by `services/coachTurnPacket.js` — CONTRACT ONLY today.
- **Exact production consumer.** `index.js` closeout handlers; `routes/sessionPlans.js`.
- **Compatibility bridge.** The reconstruction lane, retained until buffer capture is proven.
- **Sunset condition.** Remove the reconstruction lane once buffer capture is proven end to end (Phase 5g).
- **Phase 4 relevance.** Direct — GATE RUN 1 recorded the seal holding forward but **not** through an undo.
- **Evidence.** `sealed_ok` handling in `index.js:2943`, `3288`, `3433`; honest seal presentation in `services/turnWriteArtifact.js`.

## 13. InteractionTrace and turn-write proof

- **Current live authority.** `services/interactionTraceShadow.js` (`[interaction-trace]`) and `services/turnCorrelation.js` (`[turn-write-proof]`), both gated by `ATLAS_INTERACTION_TRACE=shadow`, **default off**.
- **Intended sole authority.** The same modules, graduated from shadow to live.
- **Competing authority.** None.
- **Status.** **TEST/OBSERVABILITY ONLY** — off by default, log-only, no product surface.
- **Exact production consumer.** None while the flag is off. Consumed offline by `npm run atlas:turn-write-artifact` and `npm run atlas:divergence`.
- **Compatibility bridge.** The flag itself.
- **Sunset condition.** The flag graduates to always-on when the trace becomes a product requirement, or is deleted if it does not. That decision belongs to Phase 5f, not to this map.
- **Phase 4 relevance.** Direct — the reviewable first-word-to-sealed-write trace is a Phase 4 DONE-WHEN input.
- **Evidence.** `interactionTraceShadow.js:55` reads the flag per request; `turnCorrelation.js:958` emits under the same gate. Drift Guard 5 (`npm run check:packet-trace`) enforces that the shadow never overclaims.

## 14. Deload

- **Current live authority.** Five live owners: `deloadEngine` (from `index.js`, `routes/coachOps.js`), `deloadProtocols` (from `index.js`, `routes/coachOps.js`, and two services), `deloadState` (from `routes/coachOps.js` and three services), `deloadStateMachine` (from three services), `deloadPolicy` (from `services/analytics.js`).
- **Intended sole authority.** One `DeloadLifecycle` governing selection through return-to-normal.
- **Competing authority.** All five above.
- **Status.** DUPLICATED.
- **Exact production consumer.** `GET /api/deload/status` plus `POST /api/deload/{begin,advance,resolve}`.
- **Compatibility bridge.** None.
- **Sunset condition.** Wire or delete the begin/advance/resolve endpoints under one lifecycle; close Issues #289 and #291.
- **Phase 4 relevance.** None. Deload is not on the Phase 4 path.
- **Later phase.** Phase 5c, H-10.
- **Evidence.** The requirer lists above.

## 15. Frontend coordination

- **Current live authority.** `src/app/app.js` — the monolith — beside the extracted modules (`activeSession`, `sessionLedger`, `sessionTally`, `planAcceptance`, `planOutcome`, `planCloseout`, and the rest).
- **Intended sole authority.** The extracted modules own session truth; the shell only coordinates.
- **Competing authority.** `app.js` still holds logic the modules also model.
- **Status.** TRANSITIONAL.
- **Exact production consumer.** The browser client, entry `src/app/atlasEntry.js`.
- **Compatibility bridge.** `src/app/legacyBridge.js` — an explicitly temporary Phase-1 bridge.
- **Sunset condition.** Delete `legacyBridge.js` when the last consumer of its exports is extracted; the app.js session-state freeze holds until then (`.claude/rules/high-risk-files.md`).
- **Phase 4 relevance.** Bounded — the freeze forbids new session-state logic in `app.js`.
- **Later phase.** Phase 5g, H-21.
- **Evidence.** The freeze rule; `src/app/setRevisionProposal.js` exists precisely because a session-truth selector may not live in the shell.

## 16. Shadow, fallback and legacy paths

This concept holds **two different things**. They are separated because grouping them once described a live browser dependency as off-path.

**16a. Observational shadows — `coachTurnPacketShadow`, `brainShadow`, `intentShadow`, `driftShadow`, `coachShadowSheet`, `coachResponseSheet`.**

- **Current live authority.** None — these observe rather than decide.
- **Intended sole authority.** None. Every one retires; no permanent shadow lane is allowed.
- **Status.** **TEST/OBSERVABILITY ONLY.**
- **Exact production consumer.** None on the product path — no shadow decides a visible answer. `coachTurnPacketShadow` assembles inside `res.on('finish')`, so it cannot serve a live answer. They **do** append telemetry rows when their flags are set (see concepts 6 and 11); observational is not the same as write-free.

**16b. `legacyBridge.js` — a LIVE browser bridge, not an observer.**

- **Current live authority.** It installs helper objects on `window` for live `app.js` consumers, and `src/app/atlasEntry.js:20` imports it on **every normal browser load**. Several client modules load transitively through it.
- **Intended sole authority.** None — it is a bridge, and it is deleted rather than promoted.
- **Status.** **TRANSITIONAL.** It is a live product dependency today.
- **Exact production consumer.** The browser client on every page load, via `atlasEntry.js`.
- **Sunset condition.** Delete `legacyBridge.js` when the last consumer of its exports is extracted from `app.js`. It is the same bridge named under concept 15, and Phase 5g cleanup must treat it as live wiring, not as an off-path shadow.

The remaining fields below apply to **16a**.

- **Competing authority.** By construction these observe rather than decide — but they do write telemetry rows.
- **Compatibility bridge.** The flags `ATLAS_INTENT_ROUTER`, `ATLAS_BRAIN_SHADOW_PERSIST`, `ATLAS_DRIFT_SHADOW`, `ATLAS_INTERACTION_TRACE`.
- **Sunset condition.** Delete each shadow lane and its flag when its phase closes: intent/brain/drift at Phase 5f. (`legacyBridge` has its own sunset condition under 16b — it is not a shadow lane.) A lane whose phase has closed and which is still present is a defect.
- **Phase 4 relevance.** The packet stays a **completed-turn observation**. The 2026-07-29 owner ruling (Option B) forbids moving assembly ahead of the response. `packet.session` is observational and never becomes a live dependency.
- **Evidence.** `services/coachQaShadow.js` registers `res.on('finish', …)`. Drift Guard 5 proves the shadow never claims a fact its contract does not validate.

## 17. Athlete context (profile, training level, equipment, readiness)

- **Current live authority.** Scattered, with no single owner. `profile_goal` comes from the `ATLAS_PROFILE_GOAL` environment variable via `services/profileGoal.js:14`. `training_level`, `population`, and `equipment_profile` have **no live source** — they are nullable, shape-only fields in the v1 contract. Readiness has no plumbed source. Durable rules live in the `Constraints` tab; session-scoped constraints with expiry do not exist yet.
- **Intended sole authority.** One layered `AthleteContext`: session-scoped constraints with expiry layered over durable rules, with training level, equipment profile, and readiness each plumbed from a defined source.
- **Competing authority.** None competing — the problem is **absence**, not duplication. `services/athleteContext.js` names and versions the shape but is required **only** by `services/coachTurnPacket.js` and `services/coachTurnPacketShadow.js`.
- **Status.** **CONTRACT ONLY.** The contract exists; no production route consumes it, and most of its fields have no live source at all.
- **Exact production consumer.** None. `profileGoal` is read directly by its own callers, not through the contract.
- **Compatibility bridge.** None.
- **Sunset condition.** Not a removal target — this is a **missing capability**, not an authority defect. It closes when the layered context is route-consumed and every field named above resolves from a defined source rather than from an environment variable or a null.
- **Phase 4 relevance.** Bounded. Phase 4 must not claim `packet.athlete` is authoritative beyond `profile_goal`, and Drift Guard 5 already fails an embedded-presence overclaim.
- **Later phase.** Phase 5e — "plumb training level, equipment profile, and readiness from their defined sources; close Issue #914. Finishes H-07."
- **Evidence.** `services/athleteContext.js:79-80` (nullable fields); `services/profileGoal.js:14` (the env-var source); the requirer list above.

---

## What this map does not claim

- It does not claim any TRANSITIONAL concept is finished.
- It does not claim a CONTRACT ONLY concept has production authority. Four canonical contracts — `safetyDecision`, `exerciseIdentity`, `closeoutTransaction`, `athleteContext` — are required only by `services/coachTurnPacket.js` (and, for `athleteContext`, its shadow) and decide nothing live today. `athleteContext` is tracked as concept 17 rather than only mentioned here, so a later Phase 5 closure test cannot read as satisfied while H-07 is still open.
- It does not claim any route is write-free. Several read-only coach routes append flag-gated telemetry after the response finishes; concept 6 states this precisely rather than calling them "never write Sheets".
- It does not authorize removing any competing authority. Phase 5 owns consolidation, and no part of this map starts it.
- It is not a roadmap, campaign, backlog, or capability manifest. The completion ladder (`config/coaching/manifests/capabilities.json`) remains the per-capability evidence record; this map is the per-concept authority record.

## Maintenance

Refresh the **current-as-of** date and the affected concept whenever authority moves — a flag flips, a competing path is deleted, a contract becomes route-consumed, or a bridge sunsets. A concept whose sunset condition has been met but whose loser is still present is an open loop, and the Closed-Loop Delivery Contract in `CLAUDE.md` governs how it closes.
