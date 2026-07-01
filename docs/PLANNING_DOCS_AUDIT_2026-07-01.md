# Atlas Planning Docs Audit + Consolidation Plan — 2026-07-01

> **Status:** Audit report only. **No consolidation performed. No files moved / archived / deleted. No product code touched. Vision and Constitution not rewritten.**
> **Governance layer:** Housekeeping / meta — an input to a future consolidation PR sequence. It records findings so the direction does not live only in chat (GOVERNANCE curator rule).
> **Decision class:** The audit itself is PM-authority (docs-only). Several *recommended* actions below are **owner-gated** and are marked as such — this report does not execute them.
> **Trigger:** Owner brief — after the One-Brain work and the conversation-first coach direction, confirm Atlas has a clear, current planning structure and produce a safe, tiny-PR consolidation sequence.

---

## TL;DR

Atlas's planning structure is **fundamentally sound but drifting at the index layer**. The governance spine (Dream → Vision → Constitution → Roadmap → Backlog) is intact and the newest strategic direction is correctly *captured* (conversation-first review, Conversation Contract v1, Invariant I1, the One-Brain build sequence). The problem is **navigation and freshness**, not missing content:

1. **`docs/DOCS_INDEX.md` is stale and incomplete.** It advertises "Step 371 next" and a June-2026 "Trust-Critical Coach Interaction Layer" as the active workstream — both long since shipped. It does **not** list the two newest, most direction-setting docs (`CONVERSATION_FIRST_DESIGN_REVIEW.md`, `CONVERSATION_CONTRACT_V1.md`) and misses three root docs entirely (`COACH_PERSONALITY.md`, `EXPANSION_SUMMARY.md`, `API_REFERENCE.md`). An agent reading the index first is pointed at the wrong "now."
2. **`docs/ACTIVE_ROADMAP.md`'s queue is empty** (since 2026-06-26, self-declared) yet its header still names the stale June workstream, and it does **not** point to the One-Brain conversation-first work that git history shows is *actually* being built. The live One-Brain sequence lives only in `BACKLOG.md`. The active-queue layer and the real active work have diverged.
3. **`BACKLOG.md` is bloated (347 KB) and mis-ordered** — four simultaneous "TOP PRIORITY" lanes, no single ordered "Now" block, strategic/owner-gated items interleaved with tactical ones, status narrated in prose instead of structured, in violation of its own "one line per item" charter.
4. **Two competing coach roadmaps** (`COACH_INTELLIGENCE_ROADMAP.md`, `COACH_NEXT_LEVEL_BUILD_PLAN.md`) still read as execution queues parallel to `ACTIVE_ROADMAP.md`.
5. **Four shipped specs still carry "not built yet / next build step / awaiting approval" banners** that contradict their shipped status.

None of these are *direction* conflicts requiring a Vision/Constitution change. They are **hygiene**: re-point the index, refresh the roadmap header, re-section the backlog, and add subordination/status banners. The only genuine direction tension (the Vision doc still lists a "Progress Dashboard" pillar) is **owner-gated** and explicitly out of scope for autonomous edits.

---

## Method

Read directly: `CLAUDE.md`, `docs/GOVERNANCE.md`, `docs/DOCS_INDEX.md`, `docs/CONSTITUTION.md`, `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md`, `docs/CONVERSATION_CONTRACT_V1.md`, `docs/INVARIANTS.md` (I1), `docs/ACTIVE_ROADMAP.md`, `docs/ROADMAP.md`, `docs/AGENT_WORKFLOW.md` (north-star order), `docs/ATLAS_PRODUCT_VISION.md` (structure + status board), plus `git log` of recent docs/coach-engine commits. Classified the remaining ~40 planning/plan/strategy/architecture docs and the `BACKLOG.md`/`design/`/`docs/research/` trees via four parallel read-only sub-audits. Spec-banner staleness was spot-verified against `DOCS_INDEX.md` "shipped" claims and commit history.

Scope filter: this audit covers **roadmap / plan / strategy / architecture / vision / backlog** docs (the task scope). Pure ops/security/release runbooks (`SECRET_*`, `DEPLOYMENT_GUIDE`, `RELEASE_CHECKLIST`, `BACKUP_ROLLBACK`, `TROUBLESHOOTING`, `MISSION_CONTROL`, etc.) are noted but not deeply classified.

---

## The recent direction (what we're auditing against)

From the owner brief and the captured governance docs:

- Conversation-first coach — "the conversation is the product; every screen supports it, none competes with it" (Invariant **I1**).
- One composer as the primary interface; **batch workout logging** is the owner-preferred hot path; set-by-set still supported (cadence inferred, no mode switch).
- Cards / charts / plans are **conversation artifacts**, not primary destinations.
- **One-Brain** architecture behind every surface (`COACHING_ENGINE_ARCHITECTURE.md`).
- Coach *communication* intelligence is filed as **research** (`docs/research/coaching-intelligence/`).
- Dashboard / tile drift is to be **consolidated, not expanded**.

Critical governance fact that bounds every recommendation: **the conversation-first Vision decision is owner-reserved and not yet approved.** It is captured (review + contract + I1 forward-filter) but demoting existing surfaces and amending Vision/Constitution await explicit owner approval (`CONVERSATION_FIRST_DESIGN_REVIEW.md` disposition; `OWNER_CHECKIN_RULES.md` cat. 2). The One-Brain *engine* build, by contrast, is already owner-promoted and in progress.

---

## Master table — planning docs found & status

Status legend: **SOT** = active source of truth · **SUP** = superseded / competing · **HIST** = historical/archive · **DUP** = duplicate · **OG** = owner-gated spec/direction · **UPD** = needs update · **OK** = current & correctly indexed.

### Governance / process spine (top of hierarchy)

| Doc | Purpose | Status | Conflict w/ direction? | Note |
|---|---|---|---|---|
| `docs/GOVERNANCE.md` | Dream→Vision→Constitution→Roadmap→Backlog map | SOT / OK | No | Read-first; accurate. Do not change without owner. |
| `docs/CONSTITUTION.md` | Mission, trust law, chat-first heartbeat | SOT / OG | No — already "chat-first, one save at end" | **Owner-gated.** Aligns with conversation-first. |
| `docs/ATLAS_PRODUCT_VISION.md` | Vision + Dream + pillars + status board | SOT / OG / UPD | **Partial** — still lists a "Progress Dashboard" pillar/deliverable (lines 354, 439, 474) | **Owner-gated.** Tension is real but must not be edited autonomously. |
| `docs/INVARIANTS.md` | Inviolable rules incl. **I1 "conversation is the product"** | SOT / OK | No — encodes the direction | I1 is a *forward filter*; current. |
| `CLAUDE.md` | Agent operating brief | SOT / OK | No | Current. |
| `docs/AGENT_WORKFLOW.md` | North-star read order, build loop, refill loop | SOT / OK | No | Correctly names ACTIVE_ROADMAP + BACKLOG as live sequence. |
| `docs/DECISION_KERNEL.md` | Operational distillation for routine decisions | SOT / OK | No | Read-first for autonomy. |
| `docs/AUTOMATION_PROTOCOL.md` / `OWNER_CHECKIN_RULES.md` / `DECISION_ROUTING.md` / `RISK_LABELS.md` | Automation contract + escalation + Codex desk | SOT / OK | No | Current framework. |
| `CODEX.md` | Codex operating brief | SOT / OK | No | Current. |

### Roadmap / execution-queue layer

| Doc | Purpose | Status | Conflict? | Note |
|---|---|---|---|---|
| `BACKLOG.md` | Single source of truth for open/deferred work | **SOT / UPD** | No (content) — but **cards-as-artifacts untracked** | Bloated, mis-ordered, four "TOP PRIORITY" lanes; needs re-sectioning (below). |
| `BACKLOG_ARCHIVE.md` | Completed/cancelled items (moved 2026-06-29) | HIST / OK | No | Healthy. Purely historical, correctly banner'd. |
| `docs/ACTIVE_ROADMAP.md` | Detailed active queue | **SOT / UPD** | No — but **stale header + empty queue, doesn't point to One-Brain** | Header names June "Trust-Critical" workstream; queue self-declared empty 2026-06-26. |
| `docs/ROADMAP.md` | Directional milestones (reference) | HIST / OK | No | Correctly banner'd "not the active queue." |
| `docs/COACH_INTELLIGENCE_ROADMAP.md` | 24-PR / 6-phase coach roadmap + live ledger | **SUP / UPD** | **Structural** — competes with ACTIVE_ROADMAP; PR 21 "communication layer" is now research | Needs subordination banner; reclassify PR 21. |
| `docs/COACH_NEXT_LEVEL_BUILD_PLAN.md` | Older 6-upgrade coach plan w/ Sonnet→Opus phases | HIST / SUP | Mild — model-switch contradicts "Opus 4.8 always" | Move to historical; annotate model guidance obsolete. |
| `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN.md` | Perf-intelligence PRs 345–355 | HIST / OK | No — PR 345 *supports* one-voice consolidation | Banner'd + indexed. Stale process notes only. |
| `COACH_PLAN.md` | PR 1.1 coach-intelligence build sequence | HIST / OK | No | Banner'd + indexed. |
| `COACH_INTELLIGENCE_PLAN.md` | PR 341–344 substitution/consolidation plan | HIST / OK | No — endpoint = current direction | Banner'd + indexed. |
| `FIX_PLAN.md` | 2026-06-15 repo-wide fix plan | HIST / OK | No | Banner'd "ARCHIVED — superseded by BACKLOG." |
| `docs/PRODUCT_PLAN.md` | Early product plan (MVP screens) | HIST / UPD | **Latent** — screen/tile-first MVP; lists **Nutrition** + **DB-migration ADR** (both "what not to build") | Banner'd reference; strengthen index note flagging out-of-scope items. |

### One-Brain architecture + coaching specs

| Doc | Purpose | Status | Conflict? | Note |
|---|---|---|---|---|
| `docs/COACHING_ENGINE_ARCHITECTURE.md` | **Canonical One-Brain blueprint** (6-layer pipeline) | **SOT** | No — origin of the One-Brain language | Should be the anchor other coach specs/roadmaps point to. |
| `docs/COACHING_CONTRACTS_SPEC.md` | IntentEnvelope / CapabilityManifest / CoachingDecision | SOT / UPD | No | **Stale banner:** "No implementation has been built yet" — all three shipped (PR-1/2/3). |
| `docs/COACHING_STATE_ASSEMBLY_SPEC.md` | Layer ③ read-model hydration | SOT / UPD | No | **Stale banner:** "module is the next build step" — module shipped. |
| `docs/COACHING_SESSION_GENERATOR_SPEC.md` | Keystone #2 `buildSession()` | OG / UPD | No | **Stale banner:** "module is the next build step" — module shipped & wired (commits #759/#760). Replacing live "Today's Pick" stays owner-gated. |
| `docs/SUBSTITUTION_SPEC.md` | What a substitution is / how judged | OG / UPD | No | **Stale banner:** "PROPOSED… no classifier code ships until approved" — substitution modules shipped. |
| `docs/SESSION_PLANNING_ENGINE.md` | Daily objective scoring + order + recovery model | OG | No | Owner-gated planning spec. Overlaps Session Generator — cross-link. |
| `docs/TRAINING_PROFILE_TAXONOMY.md` | Multi-style profiles (Dream-tier) | OG | No | Owner-gated, deferred. Correct. |
| `docs/RECOMMENDATION_PIPELINE_V1_5.md` | Deterministic rulebook extension | SOT | No | Engine reference. |
| `docs/TRAINING_SME_LAYER.md` | On-demand depth (log_only→…→deep_dive) | SOT | No — reinforces conversation-first | Pairs with composer-as-primary. |
| `docs/ARCHITECTURE.md` | Top-level system boundary | SOT / UPD | No — but pre-Brain; doesn't mention One-Brain | Add cross-link to COACHING_ENGINE_ARCHITECTURE. |
| `docs/LLM_ARCHITECTURE.md` | LLM provider architecture (P1–P6) | SOT | No — reinforces engine-decides | Reference; build deferred (#586). |

### Coach voice / UX / design specs

| Doc | Purpose | Status | Conflict? | Note |
|---|---|---|---|---|
| `CONVERSATION_DESIGN.md` | "Composer is the whole interface; no tiles"; batch brain-dumps | **SOT** | No — **de-facto anchor** for conversation-first | Strongest existing on-message doc. Cite as canonical in index. |
| `SESSION_DESIGN.md` | How the engine builds a workout | SOT / UPD | No | Overlaps newer session specs — add "which is canonical" note. |
| `COACH_PERSONALITY.md` | How the coach *feels* (earned reactions) | SOT | No | **Not in DOCS_INDEX.** Active voice spec — add it. |
| `docs/COACHING_NOTE_VOICE.md` | Note = verdict, engine owns numbers | SOT | No | Canonical note-voice spec. |
| `docs/COACH_VOICE_VALIDATION.md` | Owner-reviewed voice corpus | OG | No | Reference for deferred verbosity tiers. |
| `docs/TODAY_SCREEN_SPEC.md` | Redesign Today tab (hero + folded cards) | UPD | **Partial** — Today-*tab*-as-destination framing | *Consolidation* intent aligns; add banner: composer is now primary, Today is secondary/glance. |
| `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md` | The conversation-first review (governance) | **SOT / OG** | No — *is* the direction | **Not in DOCS_INDEX.** Add it (owner-reserved direction). |
| `docs/CONVERSATION_CONTRACT_V1.md` | Coach behavior/personality contract | **SOT / OG** | No — *is* the direction | **Not in DOCS_INDEX.** Add it (precedes Intent Router). |
| `design/README.md` + `design/mockups/` | Composer-first visual spec (9 mockups) | SOT / reference | No — composer-first, conversation-thread | Already on-direction. |

### Investigation / QA / diagnosis (active but not roadmaps)

| Doc | Purpose | Status | Note |
|---|---|---|---|
| `docs/COACH_INTERACTION_TRUST_INVESTIGATION.md` | P0/P1 trust-failure diagnosis | SOT (active diagnosis) | Supports conversation-first. |
| `docs/ACTIVE_SESSION_STATE_DIAGNOSIS.md` | P0 active-state canonical model | SOT (design direction) | Owner-approved lane. |
| `docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md` | B1–B10 campaign controller | SOT (campaign) | Sequences fixes, not itself a PR. |
| `docs/UX_PLAYTEST_2026-06-26_…SESSION.md` | Live-gym bug + product findings | SOT (owner-gated findings) | Composer-first insights captured. |
| `docs/ONBOARDING_WORKING_WEIGHT_SPEC.md` | Onboarding design pack (B8) | OG (design only) | Awaiting approval before build. |
| `docs/COACH_LOOP_V1_QA.md` | Coach Loop v1 UX review | HIST | Mine open findings into BACKLOG, then mark historical. |
| `AUDIT.md` / `docs/AUDIT_2026-06-12.md` / `docs/AUDIT_TRIAGE_2026-06-20.md` / `docs/API_AUDIT.md` / `docs/FOUNDATION_AUDIT.md` | Point-in-time audits | HIST | Correctly indexed under Audit/baseline. |

### Duplicate / completion records

| Doc | Purpose | Status | Note |
|---|---|---|---|
| `EXPANSION_SUMMARY.md` | 12-endpoint backend expansion summary | HIST / DUP | **Not in DOCS_INDEX; no banner.** Duplicates COMPLETION_CHECKLIST. Endpoint-proliferation tone runs against "consolidate behind One-Brain" (tonal, not directional). |
| `COMPLETION_CHECKLIST.md` | Checklist of the same expansion | HIST / DUP | No banner; **miscategorized** under Ops/release in index. Merge candidate w/ EXPANSION_SUMMARY. |
| `API_REFERENCE.md` | Endpoint quick reference | SOT / UPD | **Not in DOCS_INDEX.** Drift-check against `config/routes.js`. |

### Research (correctly filed)

| Doc | Purpose | Status | Note |
|---|---|---|---|
| `docs/research/coaching-intelligence/**` (README, digest/open-debates, coaching-knowledge-map, glossary, source-archive) | Immutable coaching-science source + digest | Research/reference | Confirms "coach communication intelligence filed as research." Healthy. |

---

## Answers to the 10 audit questions

1. **Current sources of truth.** Governance spine (`GOVERNANCE`, `CONSTITUTION`, `ATLAS_PRODUCT_VISION`, `INVARIANTS`, `CLAUDE.md`, `AGENT_WORKFLOW`, `DECISION_KERNEL`, `AUTOMATION_PROTOCOL`, `OWNER_CHECKIN_RULES`, `DECISION_ROUTING`); execution layer (`BACKLOG.md` + `docs/ACTIVE_ROADMAP.md`); architecture (`COACHING_ENGINE_ARCHITECTURE` = One-Brain canonical, `ARCHITECTURE`, `LLM_ARCHITECTURE`); direction (`CONVERSATION_FIRST_DESIGN_REVIEW`, `CONVERSATION_CONTRACT_V1`, `CONVERSATION_DESIGN`); the shipped coaching specs and voice specs. Active diagnoses/campaigns as listed.
2. **Historical context only.** `ROADMAP`, `PRODUCT_PLAN`, `WORKFLOW`, `CODEX_SESSION_STARTER`, `FIX_PLAN`, `COACH_PLAN`, `COACH_INTELLIGENCE_PLAN`, `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN`, `COACH_NEXT_LEVEL_BUILD_PLAN`, `COACH_LOOP_V1_QA`, `EXPANSION_SUMMARY`, `COMPLETION_CHECKLIST`, the audit snapshots, `BACKLOG_ARCHIVE`.
3. **Conflicts with conversation-first / One-Brain.** Only two material: `docs/PRODUCT_PLAN.md` (screen/tile-first MVP + nutrition + DB-ADR, all out-of-scope) and `docs/TODAY_SCREEN_SPEC.md` (Today-tab-as-destination). Plus the **owner-gated** Vision-doc tension (still lists a Progress Dashboard pillar). `COACH_INTELLIGENCE_ROADMAP.md` PR 21 (communication layer) conflicts with "communication = research." Everything else is aligned or cleanly gated/historical.
4. **Duplicates.** (a) Coach build-plans: `COACH_PLAN` / `COACH_INTELLIGENCE_PLAN` / `ATLAS_PERFORMANCE_INTELLIGENCE_PLAN` (all banner'd historical — fine). (b) `EXPANSION_SUMMARY` ⇄ `COMPLETION_CHECKLIST` (merge candidate). (c) Session-building: `SESSION_DESIGN` ⇄ `SESSION_PLANNING_ENGINE` ⇄ `COACHING_SESSION_GENERATOR_SPEC` (cross-link, not merge). (d) Roadmaps: `COACH_INTELLIGENCE_ROADMAP` / `COACH_NEXT_LEVEL_BUILD_PLAN` compete with `ACTIVE_ROADMAP`.
5. **Archive / rename / link from index.** Link (currently missing): `CONVERSATION_FIRST_DESIGN_REVIEW`, `CONVERSATION_CONTRACT_V1`, `COACH_PERSONALITY`, `EXPANSION_SUMMARY`, `API_REFERENCE`. Add banners: `COACH_NEXT_LEVEL_BUILD_PLAN` (historical), `EXPANSION_SUMMARY`/`COMPLETION_CHECKLIST` (historical), the four stale specs. Re-file `COMPLETION_CHECKLIST` out of Ops in the index. No renames needed.
6. **Do-not-touch (governance/constitutional).** `CONSTITUTION`, `ATLAS_PRODUCT_VISION`, `GOVERNANCE`, `INVARIANTS` (incl. I1 scope), and the trust/proof/parser/undo behaviors in `CLAUDE.md`. Also `CONVERSATION_FIRST_DESIGN_REVIEW` / `CONVERSATION_CONTRACT_V1` as *captured owner-reserved direction* (adding an index link is fine; changing their disposition is not).
7. **Where active execution should live.** Unchanged: `docs/ACTIVE_ROADMAP.md` = detailed active queue, `BACKLOG.md` = source of truth. The fix is to **make the roadmap reflect reality** — refresh its stale header and either promote the One-Brain build sequence from `BACKLOG.md` into the active queue or have the header explicitly point there. (Promoting the *conversation-first surface* work is owner-gated; the *One-Brain engine* build is already owner-promoted.)
8. **Where strategic owner-gated ideas should live.** `BACKLOG.md` → "Strategic direction — deferred brainstorms" (bottom) for captured brainstorms; the true north-star layers for adopted direction (Dream/Vision/Constitution). This is already working (the conversation-first entry is correctly filed there).
9. **Does BACKLOG.md need cleanup / re-sectioning?** Yes. Add one ordered **"Active / Now"** block at top; collapse the four "TOP PRIORITY" lanes into it with a real 1-2-3 order; move all owner-gated/PLANNING/strategic sections below a hard divider; convert paragraph items to one-line + link (its own charter); reconcile week-old investigation sections against `BUG_TRIAGE_LEDGER.md`; add a tracked line (or explicit "subsumed by Conversation Contract") for **cards/charts-as-conversation-artifacts**, currently untracked.
10. **Does DOCS_INDEX.md point agents correctly?** **No — it is the highest-priority fix.** Stale "Step 371 next" + stale "Trust-Critical" active workstream; missing the two newest direction docs and three root docs; `COMPLETION_CHECKLIST` miscategorized; no pointer to the One-Brain conversation-first "now." An agent that reads the index first is misdirected.

---

## Recommended consolidation plan (what, not yet how)

**Principle:** re-point and refresh; do not delete. Every step is additive or a banner/section edit. No file is moved/removed in this plan without an explicit later owner approval. No product code. Vision/Constitution untouched.

- **A. Fix the index (highest value).** Refresh `DOCS_INDEX.md` "Source of truth" + "Active roadmap/queue" to current reality (One-Brain conversation-first era), add the 5 missing docs, re-file `COMPLETION_CHECKLIST`, and add the out-of-scope callout to `PRODUCT_PLAN`.
- **B. Refresh the active roadmap.** Update `ACTIVE_ROADMAP.md`'s header/"current workstream" to stop naming the shipped June workstream, and point the empty queue at the `BACKLOG.md` One-Brain sequence (or promote it). Keep completed-steps history.
- **C. Subordinate the competing roadmaps.** Add a "progress-ledger, not an execution queue; subordinate to ACTIVE_ROADMAP/BACKLOG" banner to `COACH_INTELLIGENCE_ROADMAP.md`; reclassify its PR 21 (communication layer) as research. Add a historical banner to `COACH_NEXT_LEVEL_BUILD_PLAN.md`.
- **D. Resync stale spec banners.** Flip `COACHING_CONTRACTS_SPEC`, `COACHING_STATE_ASSEMBLY_SPEC`, `COACHING_SESSION_GENERATOR_SPEC`, `SUBSTITUTION_SPEC` banners from "not built / proposed" to "shipped" (keeping the owner-gated *live-surface-replacement* caveats).
- **E. Cross-link the session-building trio + top-level architecture.** Add "which is canonical" notes linking `SESSION_DESIGN` ⇄ `SESSION_PLANNING_ENGINE` ⇄ `COACHING_SESSION_GENERATOR_SPEC`; add a One-Brain cross-link from `ARCHITECTURE.md`.
- **F. Re-section BACKLOG.md** per Q9 (structural pass; content preserved).
- **G. Historical banners for completion records.** Banner `EXPANSION_SUMMARY` + `COMPLETION_CHECKLIST`; note the merge candidate (defer the actual merge).
- **H. (Owner-gated, do not execute) Vision reconciliation.** The "Progress Dashboard" pillar vs. conversation-first is a Vision edit — leave for the owner's conversation-first approval. File a one-line pointer only.

---

## Exact tiny PR sequence (one concern per PR, docs-only)

Ordered by value and safety. Each is small, additive, and independently mergeable. **PR-8 is owner-gated and is *not* to be opened autonomously.**

1. **PR-1 — DOCS_INDEX freshness.** Rewrite the "Source of truth" + "Active roadmap/queue" sections to the current One-Brain conversation-first state; add `CONVERSATION_FIRST_DESIGN_REVIEW`, `CONVERSATION_CONTRACT_V1`, `COACH_PERSONALITY`, `EXPANSION_SUMMARY`, `API_REFERENCE`; move `COMPLETION_CHECKLIST` out of Ops; add the `PRODUCT_PLAN` out-of-scope callout. *(Docs-only; highest value.)*
2. **PR-2 — ACTIVE_ROADMAP header refresh.** Replace the stale "current active workstream" text; point the empty queue at the `BACKLOG.md` One-Brain sequence; note the conversation-first surface work is owner-gated. *(No step re-execution; header + pointer only.)*
3. **PR-3 — Competing-roadmap subordination banners.** `COACH_INTELLIGENCE_ROADMAP.md` (progress-ledger banner + PR 21 → research) and `COACH_NEXT_LEVEL_BUILD_PLAN.md` (historical banner).
4. **PR-4 — Stale spec-banner resync.** The four shipped specs (C-Contracts, State-Assembly, Session-Generator, Substitution) — flip status lines to "shipped," preserving owner-gated live-surface caveats.
5. **PR-5 — Architecture cross-links.** `ARCHITECTURE.md` → One-Brain; session-building trio "which is canonical" notes.
6. **PR-6 — Completion-record banners.** Historical banners on `EXPANSION_SUMMARY` + `COMPLETION_CHECKLIST`; record the merge candidate in BACKLOG (defer the merge itself).
7. **PR-7 — BACKLOG.md re-section (structural).** Add the ordered "Active / Now" block, hard strategic divider, and the untracked "cards-as-artifacts" line; reconcile stale investigation sections vs. `BUG_TRIAGE_LEDGER.md`. Content preserved; ordering/structure only. *(Largest of the docs PRs — keep it structural, not a rewrite.)*
8. **PR-8 — (OWNER-GATED, do not open autonomously) Vision reconciliation.** Reconcile the "Progress Dashboard" pillar with conversation-first — only after the owner approves the conversation-first Vision decision.

Sequencing note: PR-1 and PR-2 first (they fix "what is now"). PR-3/4/5/6 are independent and can land in any order. PR-7 is the heaviest; do it once the index/roadmap are correct so the backlog references resolve. PR-8 waits on the owner.

---

## Docs that must not change without owner approval

- **`docs/CONSTITUTION.md`** — mission, trust law, chat-first heartbeat, source-of-truth, ownership.
- **`docs/ATLAS_PRODUCT_VISION.md`** — Vision, Dream, pillars, status board (incl. the Progress Dashboard tension → PR-8).
- **`docs/GOVERNANCE.md`** — the hierarchy map.
- **`docs/INVARIANTS.md`** — all invariants; **I1's binding scope** is explicitly owner-reserved.
- **The trust/proof/parser/undo behaviors** enumerated in `CLAUDE.md` ("Critical behaviours") — index/banner edits must never restate or alter these.
- **`docs/CONVERSATION_FIRST_DESIGN_REVIEW.md` / `docs/CONVERSATION_CONTRACT_V1.md`** — captured owner-reserved *direction*; indexing/linking is fine, changing their disposition or adopting them as binding is the owner's call.
- **Owner-gated specs** (`COACHING_SESSION_GENERATOR_SPEC` live-surface replacement, `SESSION_PLANNING_ENGINE`, `TRAINING_PROFILE_TAXONOMY`, `SUBSTITUTION_SPEC` behavior, `ONBOARDING_WORKING_WEIGHT_SPEC`) — banner/status resync is fine; promoting them to active build is owner-gated.

---

## Stop point

Per the brief: **audit only.** No consolidation performed; no files moved/archived/deleted; no product code touched; Vision/Constitution not rewritten. The PR sequence above is a recommendation awaiting authorization — PRs 1–7 are docs-only PM-authority housekeeping; PR-8 is owner-gated.

---

## gstack

Commands considered:
* /investigate
* /review
* /plan-eng-review

Commands used:
* None (skills unavailable in this cloud session — `~/.claude/skills/gstack` not present; methodology applied manually)

Why each command was or was not used:
/investigate — this is a documentation/governance audit, not a code-bug root-cause; no runtime failure to diagnose.
/review — no code change, no write-path/trust-loop/proof-field/parser/schema touch; nothing for a pre-landing code review to guard. This report is the review artifact.
/plan-eng-review — no new service/route/data-model or architecture lock-in; the deliverable is a consolidation plan, not an implementation design.
</content>
</invoke>
