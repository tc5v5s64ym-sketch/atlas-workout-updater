# Atlas Documentation Index

This file explains which docs are active instructions, which are reference/spec docs, and which are historical plans. It exists so agents do not accidentally follow an old roadmap.

## Source of truth

- `BACKLOG.md` — the single source of truth for open and deferred work (priority-ordered). Read it first for "what is open."
- `BACKLOG_ARCHIVE.md` — closed/shipped backlog items moved out of `BACKLOG.md` to keep it focused on open work. Historical record only — never an execution queue, never a place to look for open work.
- `docs/ACTIVE_ROADMAP.md` — the detailed active execution queue: the in-depth sequence for the items currently being built, promoted from `BACKLOG.md`. Read it before selecting the next PR.

These two are **partners, not competitors**: `BACKLOG.md` is the full open/deferred list; `ACTIVE_ROADMAP.md` is the detailed sequence of the current top items. **When they disagree, stop and ask the owner before changing direction.**

**Current direction (2026-07 onward):** Atlas is building the **One-Brain coaching engine** (`docs/COACHING_ENGINE_ARCHITECTURE.md`; live build sequence in `BACKLOG.md` → "One-Brain Coaching Engine") under a **conversation-first** coach direction — *the conversation is the product; every screen supports it, none competes with it* (Invariant **I1**, `docs/INVARIANTS.md`). The direction is captured in `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md` and `docs/CONVERSATION_CONTRACT_V1.md` (see "Conversation-first coach direction" below). The One-Brain **engine** build is owner-promoted and active. The composer-first surface migration was **owner-adopted 2026-07-02** ("I like it, build it") and has fully shipped (Phases A, B, C1–C2 shadow, D) — design + phase plan in `docs/COMPOSER_FIRST_MIGRATION.md`; what remains evidence-gated is the C3 intent-routing promotion. The One-Brain engine is now in its **live hybrid observation window** (`ATLAS_COACH_ENGINE=hybrid`); promotion to primary is owner-reserved and governed by `docs/ONE_BRAIN_PROMOTION_CRITERIA.md`. **Phase sequence (2026-07-12):** the active build lane is the **required Soul work** (`docs/SOUL_PLAN_V1.md`), with One-Brain promotion running as the **parallel evidence clock**; the **Post-Soul V1 Finishing Plan** (`docs/POST_SOUL_V1_FINISHING_PLAN.md`) is adopted and **queued next**, auto-selected via document-driven work selection once Soul's required exit criteria are complete (see `docs/ACTIVE_ROADMAP.md` phase banner). This is one sequence, not a competing roadmap.

> **Warning for agents:** Do NOT use any historical or archived doc as an active execution queue. The sections below mark which docs are stale. Treating a stale doc as current will cause you to re-build completed work or diverge from the owner's direction. In particular, the old **"Step 371 / Coach Voice Polish"** and **"Trust-Critical Coach Interaction Layer (P0–P4)"** workstreams named in earlier versions of this index have **shipped** — they are not the current "now."

## Agent entry points

- `docs/GOVERNANCE.md` — **read first**. Defines how Dream, Vision, Constitution, Roadmap, and Backlog relate and where to file new ideas.
- `CLAUDE.md` — **canonical implementation-agent brief**. Defines Claude-led implementation, the deterministic hard gates + clean-context cold review, the risk-triggered ChatGPT Atlas Contract Review, routine merge authority, safety rules, and Dale's owner-reserved merge authority.
- `AGENTS.md` — compatibility pointer to `CLAUDE.md`; no independent role, review, branch, or merge rules.
- `CODEX.md` — compatibility pointer to `CLAUDE.md`; native Codex GitHub Review is retired (advisory only).
- `docs/AGENT_WORKFLOW.md` — Dale + ChatGPT + Claude + GitHub workflow.
- `docs/ACTIVE_ROADMAP.md` — current queue; read before selecting the next PR.
- `BACKLOG.md` — open/deferred work and owner decisions.

Agents should not start from old plan docs.

## Automation framework (active)

The automation-first contract. Read with `docs/AGENT_WORKFLOW.md`.

- `docs/DECISION_KERNEL.md` — the operational distillation of Vision / Roadmap / Architecture / Constitution / Invariants: the durable principles + document precedence read FIRST for routine autonomous decisions (so the full north-star docs are not re-read every PR).
- `docs/AUTOMATION_PROTOCOL.md` — the automation contract: Claude implementation, the deterministic hard gates + clean-context cold review + risk-triggered ChatGPT contract-review lane, positive-evidence gates, routine merge authority, and Dale owner-reserved holds.
- `docs/OWNER_CHECKIN_RULES.md` — owner-reserved decisions, the unchanged production-verification amendment, and absolute data safety.
- `docs/AGENT_LIVE_TESTING.md` — **Active** — the agent self-serve live-testing playbook (standing owner authorization 2026-07-14): targets from the local `.env`, the mandatory synthetic `x-atlas-request-origin`, and the three test tiers (Tier 1 read-only + Tier 2 `test_mode` dry-run pre-authorized; Tier 3 real writes only on explicit per-test owner authorization). Narrows the owner-reserved "live testing" category to agent-run-by-default for agent-runnable tests; GATE A evidence stays owner-only by provenance. Not a merge gate; claims no sequencing authority over `BACKLOG.md`/`ACTIVE_ROADMAP.md`.
- `docs/ONE_BRAIN_PROMOTION_CRITERIA.md` — owner/governance: how any Brain (Brian v1 and every future version) earns promotion from hybrid shadow to primary coach — observation window, evidence sources, acceptance checklist, automatic blockers, owner review, rollback. Promotion is owner-reserved (`OWNER_CHECKIN_RULES.md` criterion 2); this defines the evidence standard for it.
- `docs/ENGINE_RECONCILIATION_NOTES.md` — active reference for the observation window: the two places legacy and the Brain use different accounting (volume credit models; deload decider vs advisory), which model is canonical today, and how to attribute shadow divergence as accounting-vs-judgment before scoring it against the promotion criteria.
- `docs/DECISION_ROUTING.md` — the external ChatGPT Atlas Decision Desk and Atlas Contract Review; no automated Claude responder or background trigger.
- `docs/RISK_LABELS.md` — risk classification labels and when each applies (manifest: `.github/labels.yml`).
- `docs/COLD_REVIEW_GATE.md` — CI enforcement of the exact-head cold-review rule (`AUTOMATION_PROTOCOL.md` §2/§4): the `cold-review/exact-head` commit status, the trusted `Cold review: PASS / Reviewed head: <sha> / P0/P1 findings: 0` marker format, the trivial-docs-only `N/A` exemption, and the one owner step (mark the status required in branch protection). Mechanism only, no new policy. Workflow: `.github/workflows/cold-review-gate.yml`; logic/tests: `scripts/cold-review-gate.js` + `test/cold-review-gate.test.js`.
- `docs/AUTOMATION_AUDIT.md` — **Historical snapshot** of the pre-Codex-cutover automation framework. Its Claude workflow inventory and proposed automation gaps are not active authority.
- `.github/PULL_REQUEST_TEMPLATE.md` — the one-screen merge card every PR must produce.

## Active roadmap / queue

- `docs/ACTIVE_ROADMAP.md` — the detailed active queue. **Freshness note:** the June-2026 trust-first refill (Steps 379–385) it details has **shipped**; its "Active queue" section now carries a banner pointing to the live sequence — the **One-Brain coaching engine** in `BACKLOG.md` → "One-Brain Coaching Engine" and the hybrid observation window (`docs/ONE_BRAIN_PROMOTION_CRITERIA.md`).
- `docs/REMEDIATION_PLAN_V2.md` — **Historical closed plan** (v2.2, 2026-07-08): remediation is **closed** — PR-21 (governance diet), PR-22 (frontend de-dup), and PR-23 (Flight-Recorder replay harness) are all ✅ shipped. PR-24's session-state scope is complete; PR-18 remains separately filed, PR-19 is dormant, PR-20 was cut, and GATE A / PR-12A/B moved to the product track. Its Claude-era execution prompts and model notes are history, not active authority.
- `docs/REMEDIATION_REVIEW_2026-07-08.md` — **Reference** — independent engineering assessment of the remediation trajectory (owner-requested, at commit `04597c6`): health score, risk analysis, Top-10 ranked next initiatives, and the M-CONSOLIDATE milestone that drove the plan's v2.2 re-scope.
- `docs/COMPOSER_FIRST_MIGRATION.md` — design + phase plan for the composer-first surface migration (owner-adopted 2026-07-02; Phases A, B, C1–C2 shadow, and D fully shipped). Reference for how the current surface came to be; the remaining C3 routing promotion is evidence-gated in `BACKLOG.md`.
- `docs/COACHING_ENGINE_ARCHITECTURE.md` — the canonical One-Brain blueprint the current build follows (also under "Product and architecture reference").
- `docs/COACH_INTERACTION_TRUST_INVESTIGATION.md` — diagnosis doc for the Trust-Critical P0/P1 coach-interaction work (active-session context, substitution-signal visibility). Reference when touching that area.
- `docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md` — campaign controller for the 2026-06-26 live gym + composer trust/UX findings. Use it to sequence the B1-B10 follow-up PRs; it is not an implementation PR by itself.
- `docs/SOUL_PLAN_V1.md` — **Active — the current active lane** — the executable Soul build queue and PR prompts (personality / voice / soul): one paste-ready PROMPT per PR in order (Part A "getting to soul-ready" → Part B "the soul build"). Companion to the planning brief `docs/ATLAS_SOUL_READINESS_PLAN.md`; voice/taste decisions are governed by `docs/ATLAS_VOICE_RATIFICATION_V1.md`. Docs-only governance — implements nothing; each PR runs from its own prompt. Hard gate: TEST_QUEUE `LT-007` must PASS before PR-B4 (**PASS** 2026-07-09). **Read the "Soul completion & Post-Soul handoff contract" section** for the required Soul exit criteria (S1–S7). As of 2026-07-12 **only S5** remains open (engine-granted voice + LT-010, profanity OFF); S2 was resolved via the owner-confirmed no-active-goals path and S7 is closed (LT-011 re-validated live to PASS). Also covers the document-driven handoff to the Post-Soul finishing plan.
- `docs/POST_SOUL_V1_FINISHING_PLAN.md` — **Adopted, queued next (not active)** — the current-main-reconciled Post-Soul V1 finishing lane (POST-01…POST-12): close remaining P0/P1 trust risks → cross-seam proving packs → five clean live sessions → declare V1 → two-week defect-only stabilization. Every proposed item is classified against current `main` (shipped / superseded / partial / still-current) with PR/file/test citations. **Queued behind Soul** — it becomes the governed next phase automatically (document-driven work selection, no trigger/reminder) once every required Soul exit criterion is recorded complete, per the handoff contract in `docs/SOUL_PLAN_V1.md`. Not a second roadmap: Soul (active) + this (next) are the ordered lanes; `BACKLOG.md` stays source of truth.
- `docs/ATLAS_SOUL_READINESS_PLAN.md` — **Active reference** — the companion planning brief behind `docs/SOUL_PLAN_V1.md`: the holistic where-Atlas-is snapshot, the Part A / Part B PR-level game plan, and the two-clocks (evidence vs build) sequencing. Reference for the plan's reasoning; the executable queue lives in `docs/SOUL_PLAN_V1.md`, not here.
- `docs/ATLAS_VOICE_RATIFICATION_V1.md` — **Active** — the owner voice/personality ratification: the persona core text (§1), the register decision menu D1–D8 (§2), and the Set C golden corpus (§3). **RATIFIED** — owner sign-off committed 2026-07-09 (v1.4); §1–§3 and D1–D8 are the owner-approved source of truth. Consumed by `docs/SOUL_PLAN_V1.md` PRs A2 / A3 / B2 / B6 / B7 / B8a (decisions recorded in `BACKLOG.md`).
- `docs/COACH_VOICE_ARCHITECTURE_REVIEW_2026-07-09.md` — **Active** — the pre-Soul-Plan architecture review committed by PR-A1. Documents the three-layer trust/personality/user-state analysis with exact `file:line` citations; identifies the two personas (`:48` wired/wrong vs `:1258` unwired/correct), five prompt builders with duplicated iron rules, and the missing `athlete_identity` forwarding. Foundation for all Part A and Part B Soul Plan PRs; do not re-litigate inside those PRs.

## Proposals / intake material (NOT an execution queue)

Owner-supplied proposal packets, filed through `docs/GOVERNANCE.md` into `BACKLOG.md`. These are **intake material only** — they never select or sequence PRs; the disposition of every proposal lives in `BACKLOG.md`, and where a packet conflicts with repo governance, repo governance wins. Do not treat a packet as a roadmap.

- `docs/proposals/ATLAS_V1_PROPOSAL_PACKET.md` — **Intake material** (v1.1). Two proposals: **Persona Harness Lite** (extend the existing simulation / Flight-Recorder-replay test layer with named synthetic-lifter packs — default disposition is a testing-layer `BACKLOG.md` entry, not active-roadmap work) and the **V1 Proving Run** (a "5 consecutive clean live gym sessions" definition-of-done gate — genuinely new, its adoption owner-reserved, its LT-### mechanics reusing `docs/TEST_QUEUE.md`). Filed 2026-07-09; dispositions in `BACKLOG.md` → "ATLAS v1 proposal packet — intake". Supersedes the never-committed `ATLAS_MASTER_PLAN_V1.md`.

## Conversation-first coach direction (captured; surface adoption owner-gated)

The newest, most direction-setting docs — where the coach is going and how it should behave. The **engine** work they imply (One-Brain) is active; adopting the conversation-first **Vision** and demoting existing surfaces is **owner-reserved**.

- `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md` — the conversation-first product/architecture review: why the conversation is the product, what becomes a conversation artifact vs. a destination, and the aggressive counter-case. Owner-reserved direction.
- `docs/CONVERSATION_CONTRACT_V1.md` — the coach behavior/personality contract: **when Atlas speaks vs. stays quiet**, how firmly it challenges, always-acknowledge-a-log, close-the-loop, and the validation scenarios. Precedes the Intent Router in the One-Brain build. Owner-reserved direction.
- `CONVERSATION_DESIGN.md` — the de-facto on-message anchor for conversation-first: composer as the whole interface, batch brain-dumps, no tiles.
- `docs/product/conversation-suite/README.md` — Conversation acceptance-test suite (P-001–P-025 pressure, N-001–N-040 everyday) — the feel-spec for coach voice, logging, plan flow, session finish, substitutions, safety, and conversation UX.
- `COACH_PERSONALITY.md` — how the coach *feels* (earned reactions, tone). Active voice spec.
- The research grounding for **coach-note tone** and **"when Atlas should speak vs. stay quiet"** lives under **Research** (below): `docs/research/coaching-intelligence/` source `05-coach-communication-intelligence`.

## Product and architecture reference

These are reference docs. Use them when relevant, but do not treat them as the active build queue.

- `docs/ATLAS_PRODUCT_VISION.md`
- `docs/CONSTITUTION.md`
- `docs/ARCHITECTURE.md`
- `docs/COACHING_ENGINE_ARCHITECTURE.md` — the One-Brain coaching engine blueprint: six-layer pipeline (Intent Router → Orchestrator → State Assembly → Brain → Coaching Decision → LLM explanation), two non-coaching LLM boundaries, pure read-only Brain, capability audit (complete/partial/missing) with the two keystones (Scenario Classifier, Session Generator), `ATLAS_COACH_ENGINE=legacy|hybrid|brian` migration, and the `analytics.js` relationship. **Not active roadmap** — build sequence in `BACKLOG.md` → "One-Brain Coaching Engine"; two items owner-gated (input-LLM provider, proactivity policy).
- `docs/INVARIANTS.md`
- `docs/LLM_ARCHITECTURE.md` — LLM provider architecture: core principles (P1–P6), tier design, June 2026 provider scoring, error boundary spec, provider interface, implementation PR sequence. **Not active roadmap** — build trigger is after P0 workout reliability is stable in live use. See `BACKLOG.md` → Operational resilience → GitHub issue #586.
- `docs/SHEET_CONTRACT.md`
- `docs/SAFETY_RULES.md`
- `docs/MISSION_CONTROL.md`

## Current/valid specs

These describe specific systems or constraints. Use them when your PR touches that area.

- `SESSION_DESIGN.md`
- `CONVERSATION_DESIGN.md` — also listed under "Conversation-first coach direction" (the on-message anchor).
- `API_REFERENCE.md` — endpoint quick reference. Verify against `config/routes.js` (the route manifest is authoritative) when it looks out of date.
- `docs/COACHING_CONTRACTS_SPEC.md` — the three load-bearing coaching contracts (`IntentEnvelope`, `CapabilityManifest`, `CoachingDecision`): schemas, enums, validation rules, worked examples, file layout, tests-to-prove. Implements `docs/COACHING_ENGINE_ARCHITECTURE.md`. All three contracts shipped (PR-1/2/3); build sequence in `BACKLOG.md` → "One-Brain Coaching Engine".
- `docs/COACHING_STATE_ASSEMBLY_SPEC.md` — layer ③ spec: the read-only read-model hydration layer the manifest input keys draw from (injected-reader contract over `trainingStore`/`deloadState`, the snapshot shape, derived-vs-read keys, the `knownKeys` missing-info handshake, graceful degradation). Read-only, not owner-gated. Module shipped.
- `docs/COACHING_SESSION_GENERATOR_SPEC.md` — keystone #2 spec: the Brain-native replacement for `analytics.js::scoreIntents` — `buildSession(state, constraints)` composes the shipped modules (scenarioClassifier+progression per lift, volumeAssessment, safety, equipment/focus/duration filtering, deload) into a validated `workout` payload with per-block key-aware `explanation_inputs`. Pure. Module shipped. Building the pure engine is derivable; replacing the live "Today's Pick" surface (`scoreIntents`) is owner-gated.
- `docs/SUBSTITUTION_SPEC.md`
- `docs/DELOAD_SPEC.md`
- `docs/COACH_VOICE_VALIDATION.md`
- `docs/COACHING_NOTE_VOICE.md`
- `docs/COACH_MOMENTS_ENGINE.md` — **Active** — Coach Moments Engine design spec: seven moment types (M1–M7), three tiers, praise-economy budget rules, honesty contract, anti-repetition ledger, pipeline/contracts, and owner-reserved forks (§10); sequenced after One-Brain promotion (PR-12A).
- `docs/TODAY_SCREEN_SPEC.md`
- `docs/RECOMMENDATION_PIPELINE_V1_5.md`
- `docs/TRAINING_SME_LAYER.md`
- `docs/TRAINING_PROFILE_TAXONOMY.md` — planning spec for multi-style training support (five training profiles, profile-score model, modality schema, onboarding classifier, profile-aware stimulus governor). Owner-gated, not active roadmap; filed in `BACKLOG.md`.
- `docs/SESSION_PLANNING_ENGINE.md` — planning spec for the Session Planning Engine (daily objective scoring, supported session objectives, deterministic exercise order rules, fatigue-adjusted plans, a recovery/deload model — trigger convergence, profile-aware deload styles, the normal-routing→recovery_reload→deload→taper→maintenance→complete-rest boundary — and a golden-fixture proposal). Builds on the Training Profile Taxonomy; the deload section is planning-only and does not change `docs/DELOAD_SPEC.md`. Owner-gated, not active roadmap; filed in `BACKLOG.md`.
- `docs/EXERCISE_NAME_UNIFICATION_MIGRATION_PLAN.md` — **planning/audit only** — scopes the parser↔enrichment↔catalog exercise-name / lift-code unification deferred by PR-14/PR-15: the 5-source current-state map, the 32-residual divergence table, the `primary_muscles→Muscle_Group` and `exercise_id→lift_code` bridge proposals (not applied), the `--sync-sheet` plan, a 6-PR safe migration sequence, the test plan, and the owner-decision list. No behavior/write/sheet/data change. Owner-gated past PR-A/B; filed in `BACKLOG.md`.
- `docs/SESSION_PLANS_CAPTURE_SPEC.md` — architecture/implementation spec for the Session_Plans **live-capture** lane (owner-authorized **Option A**, 2026-07-10, after the STOP-&-REPORT finding that no authoritative server-side plan-lifecycle boundary exists). Maps the client lifecycle + authority classification, defines the client-held accepted-plan identity contract (`plan_version`/immutable `plan_item_id`), the three explicit feature-flagged sidecar endpoints (`/api/session-plans/accept|outcome|closeout`), acceptance/closeout semantics (explicit actions only — no inference), the PR-D→PR-I rollout, a threat/trust review, and the client-generated-deterministic-ID recommendation. Docs-only PR-D; **PR-E stops for owner approval**. `ATLAS_SESSION_PLANS_WRITE` stays OFF. Filed in `BACKLOG.md`.

## Research (preserved source knowledge)

Immutable source research + digests for the Coach Intelligence Layer. **Not an execution queue** and not edited by hand; the machine-usable config lives separately under `config/coaching/`.

- `docs/research/coaching-intelligence/README.md` — human entry point (source-archive + digest; the "engine owns numbers, LLM only words them" prime directive).
- `docs/research/coaching-intelligence/source-archive/` — immutable sources + `MANIFEST.json` (checksummed). Sources `01`–`07` (`01`–`05` PDFs, `06`–`07` markdown).
  - **`05-coach-communication-intelligence`** — the coaching **communication** research: coach communication policy, coach-note tone, autonomy-supportive language, praise/sandbagging/setback handling, **when Atlas should speak vs. stay quiet**, and conversation-first coaching behavior. This is the research grounding behind `docs/COACHING_NOTE_VOICE.md` (coach-note = verdict; engine owns numbers) and the "when to speak / how firm" rules in `docs/CONVERSATION_CONTRACT_V1.md`.
  - **`06-decade-relationship-coaching`** — "The Ten-Year Athlete": the **long-horizon relationship** research — relationship memory (decision vs personality stores), coach promises and receipts, trust creation/destruction, communication compression with tenure, return-after-layoff behavior, decision-outcome learning, and the distilled **Atlas Coaching Principles**. **Long-horizon research guidance only — not an execution queue and it creates no roadmap items.** Must be consulted (its Part V checklist) before designing work on coach memory, relationship intelligence, proactivity, coach promises, injury memory, return-after-layoff behavior, decision-outcome learning, personalization, long-term programming, or coach communication (including coachNoteTier evolution).
  - **`07-the-feel-of-atlas`** — "The Feel of Atlas": the **interaction-philosophy** research — why conversational AI feels effortless (grounding, interactive alignment, turn-taking), the inferred guided↔freestyle coaching spectrum, the conversational intent model (visible vs hidden intent), the rhythm of coaching (Wooden observation data + feedback literature), the 16-state athlete conversation-state model, complete workout conversation models, coaching-trust failure modes (sycophancy, nagging, abandonment research), the day-1→year-10 relationship arc, and the **100 interaction principles**. **Interaction-philosophy research guidance only — not an execution queue and it creates no roadmap items.** Must be consulted before designing, changing, or reviewing anything the athlete experiences in conversation (coach voice, verbosity, proactivity, silence rules, intent handling, celebration, challenge, error recovery). Companion to `06` (06 = the decade's memory/trust architecture; 07 = how each minute of it should feel).
- `docs/research/coaching-intelligence/digest/` — human-readable `coaching-knowledge-map.md` (Communication is domain **H**, deep-sourced from `05`), `open-debates.md`, `glossary.md`.

## Historical / archived plans

**DO NOT TREAT THESE AS THE ACTIVE EXECUTION QUEUE.** They are useful history but must not be used to select or sequence PRs. If any of these conflict with `BACKLOG.md` or `docs/ACTIVE_ROADMAP.md`, the latter two win.

- `FIX_PLAN.md` — archived; superseded by `BACKLOG.md`.
- `COACH_PLAN.md` — historical coach intelligence build plan; much has shipped.
- `COACH_INTELLIGENCE_PLAN.md` — historical PR 341–344 substitution/intelligence plan; much has shipped.
- `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN.md` — historical performance-intelligence plan; Steps 345–353 largely shipped; remaining wiring folded into `docs/ACTIVE_ROADMAP.md` Steps 362–370 (now ✅ complete).
- `docs/COACH_NEXT_LEVEL_BUILD_PLAN.md` — future/reference; do not execute ahead of active roadmap.
- `docs/ROADMAP.md` — historical milestone roadmap; not the active execution queue.
- `docs/PRODUCT_PLAN.md` — early product reference; **not the active PR queue.** ⚠️ Contains items Atlas explicitly does **not** build (Nutrition tracking; a secondary-database migration ADR) and a screen/tile-first MVP framing that predates the conversation-first direction — read as history, not direction.
- `docs/WORKFLOW.md` — historical workflow reference; current process lives in `docs/AGENT_WORKFLOW.md`.
- `docs/CODEX_SESSION_STARTER.md` — historical prompt starter; verify against active docs before reuse.
- `EXPANSION_SUMMARY.md` — historical record of a 12-endpoint backend expansion; a **completion record, not a plan.** Duplicates `COMPLETION_CHECKLIST.md`; its endpoint-proliferation framing predates "consolidate behind One-Brain."
- `COMPLETION_CHECKLIST.md` — historical checklist of that same backend expansion (re-filed here from Ops — it is a completion record, not a runbook).

## Operations / release / security docs

Use these for deployment, rollback, release, secret handling, and troubleshooting.

- `docs/BUG_TRIAGE_LEDGER.md` — active. Shared done-vs-open record for `Bug_Reports` rows (maps each sheet row → fix status → PR/commit → owner) so parallel sessions don't double-dip. Convention: every fix PR cites its `BUG-…` id and updates the ledger in the same PR.
- `DEPLOYMENT_GUIDE.md`
- `QUICKSTART.md`
- `docs/RELEASE_CHECKLIST.md`
- `docs/BACKUP_ROLLBACK.md`
- `docs/TROUBLESHOOTING.md`
- `docs/SECRET_HYGIENE_PLAN.md`
- `docs/SECRET_HYGIENE_CHECKLIST.md`
- `docs/SECRET_ROTATION_RUNBOOK.md`
- `docs/NO_WRITE_SAFETY.md`

## Audit / baseline docs

Useful for history and context. Do not use them as current task lists.

- `AUDIT.md`
- `docs/AUDIT_2026-06-12.md`
- `docs/AUDIT_TRIAGE_2026-06-20.md` — current-state triage of the AUDIT.md Medium/Low findings (ME-5/6/9/10/11/12, LO-1…LO-11), verified against `main` with file:line evidence.
- `docs/AUDIT_2026-07-07_DEEP_REVIEW.md` — adversarial deep-review of the five trust-critical surfaces (write path, client trust loop, parser, session state, infra); 29 findings with verdicts (empirical/code/plausible) + verified-clean inventory. Open items tracked in `BACKLOG.md` → "Deep-review audit — 2026-07-07 — open findings"; the four P0s are Phase 0.9 (PR-0D→0G) of `docs/REMEDIATION_PLAN_V2.md`.
- `docs/PHASE1_MINEFIELD_MAP.md` — **active reference for PR-09→11**: frozen app.js behavior contract at post-PR-08 HEAD (load order, 31-variable state inventory + slice assignments, the 10 `atlas:*` event payloads, persistence keys, bridge surface, §7 per-PR acceptance checklists). Behavior may be relocated, not changed; intentional changes need a named PR-body callout.
- `docs/API_AUDIT.md`
- `docs/FOUNDATION_AUDIT.md`
- `docs/BASELINE_POST_CUTOVER.md`
- `docs/COACH_LOOP_V1_QA.md`
- `docs/FIRST_REAL_WRITE.md`

## Rule for future docs

Before adding a new roadmap or plan doc, ask whether it belongs in:

1. `BACKLOG.md` as the source-of-truth queue,
2. `docs/ACTIVE_ROADMAP.md` as detailed current execution path, or
3. a narrow spec doc linked from one of those two.

Do not create a new competing roadmap.
