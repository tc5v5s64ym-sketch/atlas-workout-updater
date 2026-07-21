# Atlas Knowledge Foundation — Repository Handoff & Gate Reconciliation

**Current as of:** 2026-07-21 · **Classification:** research / reference input only · **Selects work:** no.

This is the repository entry point for the completed **26-prompt Atlas Knowledge Foundation** research program (research cutoff 2026-07-18; 94 exact deliverables). It records where the authoritative package lives, and it reconciles the package's six P0 **production-runtime assurance gates** against what the repository *actually* contains today.

> **This document is research/reference material. It does not select the next PR, create a roadmap or campaign controller, reorder the Atlas Recovery Campaign, or authorize any production change.** The sole work-selection authority remains [`docs/ATLAS_V1_EXECUTION_PLAN.md`](../../ATLAS_V1_EXECUTION_PLAN.md) (the embedded **Atlas Recovery Campaign, Issue #1073**). Per [`docs/GOVERNANCE.md`](../../GOVERNANCE.md) / [`docs/DOCS_INDEX.md`](../../DOCS_INDEX.md) this is a category-4 (research/audit/reference) document.

Companion research folder: [`docs/research/coaching-intelligence/`](../coaching-intelligence/) — the Coach Intelligence Layer source archive + digest. The knowledge-foundation package is the later, broader research program; Phase 6 of the campaign is what converts *either* body of research into versioned runtime knowledge records.

---

## 1. What the foundation is (and is not)

The program defines what Atlas may **know**, what deterministic services must **decide**, what evidence may be **retrieved**, what athlete memory may **contain**, what the conversational model may **explain**, what validators must **block**, and where a qualified professional must **take over** — so Atlas can be knowledgeable without the conversational model inventing facts, numbers, verdicts, history, or write claims.

The research foundation is **complete and internally reconciled** (0 JSON parse errors across 53 local artifacts; 34 integration conflicts, 0 unresolved; identifier/reason/release aliases normalized). **Research completeness is not production certification** — production runtime remains blocked by six P0 assurance gates, mapped in §4 below.

Its canonical authority order (lower layers may never override higher ones):

1. emergency / professional / population constraints
2. authoritative athlete & session state
3. deterministic calculations & decision services
4. versioned curated knowledge
5. explicit editable athlete memory
6. conversational model (language only)
7. validator & committed-write receipt

This order already agrees with Atlas's live trust contract — the engine owns numbers/decisions; the LLM only words whitelisted facts (see [`docs/CONSTITUTION.md`](../../CONSTITUTION.md), [`docs/DECISION_KERNEL.md`](../../DECISION_KERNEL.md)).

## 2. Where the authoritative package lives

The **raw Markdown and JSON files are authoritative**; the Google Docs/Drive copies are operational indexes unless an exact-content validation note says otherwise. **Do not ingest predecessor machine files directly without the Prompt 26 normalization overlay** (five reason-code aliases, three Prompt-26 reason extensions, six source-policy tags that are *not* runtime reason codes, one prose-under-a-reason-key value, seven `REL-*`→`GATE-*` release aliases).

- **Final integration Drive folder (Prompt 26):** `https://drive.google.com/drive/folders/1w4yb42H9ljfGXTwU9cYd83dmgOVAK2by`
- **Research tracker (Google Sheet):** `https://docs.google.com/spreadsheets/d/1N6_PYpn8MRKN-80osU97wrgh-Hg2WNPPPbTTBQrg6gw/edit`

Per the campaign's "do not copy the package into Git" rule, the 94 deliverables are **not** vendored into the repository. The six canonical final deliverables were read and hash-verified at handoff (2026-07-21); recorded here so a future agent can confirm the exact artifacts:

| # | Deliverable | Bytes | SHA-256 |
|---|---|---:|---|
| 1 | `ATLAS_KNOWLEDGE_FOUNDATION_EXECUTIVE_SUMMARY.md` | 6151 | `3c5a3fbfcfa4f37d95da3fbfefcac0c135a4411db7a83d81de909c2e14f4f15a` |
| 2 | `ATLAS_CANONICAL_KNOWLEDGE_MANIFEST.md` | 24940 | `d7745e3e84bce2d59d04f49d5b39d9067e15e79a5a911b0e73c4e69a77823bb7` |
| 3 | `ATLAS_KNOWLEDGE_DEPENDENCY_GRAPH.md` | 4109 | `dbebdd89350721d05d06ebb767b0266e192a0b94248bc8018b8268952dc1a925` |
| 4 | `ATLAS_KNOWLEDGE_RELEASE_GATES.md` | 7941 | `a198b06eb3a03d0606111bfc39dea892103ce737351be8ee5955e4456138658f` |
| 5 | `canonical_knowledge_manifest.json` | 107936 | `75553ba5b255ea8458f642c549bc5c5fa31f344b0829746e9dea18ba03cb7b66` |
| 6 | `knowledge_conflict_resolution_log.json` | 24652 | `b73ace67565d9d577b50e841e20efacc35c8eca10218ff76f5734aa43a0d219e` |

(The 7th package file, `ATLAS_KNOWLEDGE_FOUNDATION_CLAUDE_HANDOFF.md`, is the instruction sheet that produced this document.)

Program scale (from the manifest): 26 prompts · 94 deliverables · 17 knowledge collections · 304 reason-code mappings · 28 decision tables / 112 rows · 54 validation rules · 84 question contracts · 22 population modules / 12 clinical release gates · 15 mock sessions / 274 audited claims · 36 backlog items / 6 P0 blockers.

## 3. Verification method

Following the handoff's required-verification rule ("Claude must not assume the research documents describe current code"), the six gates below were reconciled against the **actual repository** — real modules under `services/`, `routes/`, `config/coaching/`, `index.js`, `src/app/`, and `test/`, plus the ratified contracts charter [`docs/CANONICAL_CONTRACTS.md`](../../CANONICAL_CONTRACTS.md) and the completion ladder [`docs/CAPABILITY_COMPLETION_LADDER.md`](../../CAPABILITY_COMPLETION_LADDER.md) — not against the research prose. Current campaign position at reconciliation: **Phase 3 (shadow the packet and the trace) — build complete; awaiting the informational owner stop** (`CAMPAIGN STATE` in the execution plan). Phases 1–2 complete.

## 4. The six production gates mapped onto the repository

Legend — **COVERED**: already a campaign phase or shipped contract (no new work). **PARTIAL**: partly covered; the remainder is out-of-V1-scope or owner-reserved. **DEFERRED/OUT-OF-SCOPE**: not V1 campaign work by standing owner direction.

| Gate | Requirement | Repository reality (verified) | Campaign home | Verdict |
|---|---|---|---|---|
| **PG-001** Canonical vertical-slice knowledge package | Every released reason route resolves to an active record, source, applicability rule and validator | Reason codes exist **code-side** (`services/trainingKnowledge.js` `REASON_CODES` ~40; module enums in `recommendationConstraints.js`/`setEffortSignals.js`/`coachVoiceRenderer.js`). Knowledge = deterministic cards (`services/trainingSME.js`, `services/trainingKnowledgeCards.js`) — not a compiled record store. Source registry = `docs/research/coaching-intelligence/source-archive/MANIFEST.json` (sha256'd, docs-side). Versioned-record scheme = `config/coaching/schemas/provenance.schema.json` + `evidence-tiers.json`. Validators exist (§PG-005 row). No single compiled route binds reason→record→source→validator yet. | **Phase 6 — Wire in the research** | **COVERED.** This package is *added research input* to Phase 6, which builds exactly this route. No new backlog. |
| **PG-002** Corrected gold + negative fixtures | Correct weak/scope-sensitive claims; add the four missing nutrition/supplement fixture families (protein, workout-nutrition timing, hydration/electrolytes, supplements) | Golden Session fixture (`test/fixtures/goldenSession.js`) + ten behavior-scored Soul transcripts (`test/soulGoldenTranscripts.test.js`) exist and run through the real seam. **No nutrition/supplement fixtures exist.** | Phase 7 (Soul corpus as acceptance tests) + Phase 6 | **PARTIAL.** Corrected-gold fixtures ride Phase 7. The **four nutrition/supplement families are genuinely un-named**, but nutrition is on the explicit V1 do-not-build list ("nutrition tracking") — whether Atlas answers nutrition/supplement questions in V1 is an **owner scope decision** (§5). Recorded, not queued. |
| **PG-003** Approve-before-save | Preview + explicit approval + committed receipt for every plan / log / **memory** mutation | Preview→approve→write trust loop is shipped and load-bearing: `index.js` (dry-run vs live share one row-builder; strict `test_mode`; idempotent `write_id`; proof fields `sheet_written`/`no_write_confirmed`), ratified as `CloseoutTransaction` (W1–W3), hardened by cards F02/F03. Memory modules exist (`services/memoryModule.js`, `services/coachMemory.js`) but an *editable-athlete-memory-with-approval* path is not established. | Constitution/Invariants + F02/F03 (shipped) | **COVERED** for plan/log mutation (this is the untouchable trust loop). **Memory-mutation** approval = a future capability tied to editable athlete memory — new product scope, **owner-reserved**, not a current campaign card. |
| **PG-004** Multi-athlete isolation | Retrieval, caches, memory, logs, writes and traces cannot cross athletes | **Single-owner by design.** No `athlete_id`/`user_id` scoping in retrieval/caches/memory; `services/athleteIdentity.js` is the *one* owner's longitudinal record, not a tenancy key. `CLAUDE.md`, `docs/CONSTITUTION.md`, `docs/ATLAS_PRODUCT_VISION.md` all fix one owner (Dale) for V1. | — | **DEFERRED / OUT-OF-SCOPE.** Multi-user/public-product architecture is on the explicit V1 do-not-build list. Not campaign work; recorded only. |
| **PG-005** Reviewed symptom routing | Stop/modify/urgent/emergency routes professionally reviewed + adversarially tested + no diagnosis/clearance language; 12 clinical population gates enforced | `config/coaching/rules/safety.rules.json`, `services/safetyClassifierModule.js`, and the ratified `SafetyDecision` contract exist; `docs/SAFETY_RULES.md`. `config/coaching/populations/` holds **training-context** profiles (busy-parent, home-gym, youth, older-adult) — **not** the foundation's clinical release gates (`GATE-ADOLESCENT`, `GATE-PREGNANCY`, `GATE-CARDIAC-METABOLIC-RENAL`, …). | **Phase 5d** (one SafetyDecision consumed by route + Brain; retire duplicate classifiers; closes H-12) | **PARTIAL.** SafetyDecision consolidation is covered by Phase 5d. **Professional review, adversarial symptom tests, and the 12 clinical population release gates are genuinely missing AND owner-reserved** (professional evidence + product/safety scope). Recorded, not queued. |
| **PG-006** Flight Recorder replay | Every read, calculation, decision, retrieved evidence, validation, approval and write is replayable | Flight Recorder is real and **wired**: `services/flightRecorder.js` + client `src/app/flightRecorder.js` + ingest `POST /api/flight/ingest` + `Flight_Recorder` tab; `decision_summary_json` (PR #1007). `InteractionTrace` (10-stage spine) + shadow (`services/interactionTrace.js`, `interactionTraceShadow.js`) — Phase 3. Nightly divergence report (`services/coachTurnDivergence.js`). Replay = capture-then-read + divergence (no dedicated replay-engine module). Retrieved-evidence stage depends on Phase 6. | **Phases 3–4** (+ existing Flight Recorder) | **COVERED.** Phase 4 DONE-WHEN is "one reviewable trace spans first word to sealed write." The retrieved-evidence dimension rides Phase 6's knowledge records. Duplicate of existing/planned work. |

### Additional foundation conditions (context, not new campaign work)
Compiled global source registry (PG-007), signed content-addressed package (PG-008), outage behavior (PG-009), population-gate enforcement (PG-010), cross-surface consistency (PG-011), and ongoing curation operations (PG-012) are production-hardening conditions the foundation names. In the repository these correspond to Phase 6 (records/sources), Phase 4 (outage fallbacks / cross-surface consistency via the one packet), and future operations — none introduce a new roadmap.

## 5. Genuine-missing-work determination

After mapping every gate to verified repository truth, **no net-new work that is simultaneously (a) genuinely missing, (b) in V1 scope, (c) not owner-reserved, and (d) not already a campaign phase was found.** Every candidate falls into one of:

- **Already covered by a campaign phase** — PG-001 (Phase 6), PG-006 (Phases 3–4), corrected-gold PG-002 (Phase 7), SafetyDecision PG-005 (Phase 5d), plan/log PG-003 (shipped trust loop).
- **Out of V1 scope by standing owner direction** — PG-004 multi-athlete isolation; editable-athlete-memory writes (PG-003).
- **Owner-reserved (product scope and/or professional evidence)** — the four nutrition/supplement fixture families (PG-002); professional symptom-routing review + the 12 clinical population release gates (PG-005).

Consequently **`BACKLOG.md` is not modified by this handoff.** Queuing the owner-reserved / out-of-scope items would (1) imply campaign work the owner has not authorized — such work may enter the campaign only through an explicit owner instruction recorded in `docs/ATLAS_V1_EXECUTION_PLAN.md` — and (2) breach the shrink-only paper-weight cap (BACKLOG.md is at its 1263-line ceiling) without justification. They are recorded here for owner visibility instead.

## 6. The clear, small next owner decision

Consistent with the handoff's success criteria (the campaign stays the sole authority; no implementation begins merely because the research is complete; the next owner decision is small), the open owner question is narrow:

> **Scope call:** for the P0 items this reconciliation flags as owner-reserved — the four nutrition/supplement fixture families and the clinical population-gate + professional symptom-routing work — should any enter the V1 campaign now (recorded in the execution plan), or stay deferred until after V1 stabilization? Until an owner records that instruction in `docs/ATLAS_V1_EXECUTION_PLAN.md`, the campaign proceeds unchanged in its existing phase order — the current Phase 3 owner shadow/divergence step, **then** Phase 4, **then** Phase 5, **then** Phase 6, which is the *eventual* research-consumption phase. Phase 6 is not the next phase; the intervening Phase 3 owner stop, Phase 4, and Phase 5 remain mandatory and in order.

**Owner decision (2026-07-21):** both areas — the four nutrition/supplement fixture families and the clinical population-gate + professionally-reviewed symptom-routing work — are **intentionally deferred until after V1 stabilization**, recorded in [`docs/ATLAS_V1_EXECUTION_PLAN.md`](../../ATLAS_V1_EXECUTION_PLAN.md) §12 ("Explicitly outside this campaign"). They do not block V1 or the Recovery Campaign, reorder nothing, and authorize no implementation; they may be reconsidered only after V1 stabilization and another explicit owner decision. This package remains the canonical reference for that future work.
