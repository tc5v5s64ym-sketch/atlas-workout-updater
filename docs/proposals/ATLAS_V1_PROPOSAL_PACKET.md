# ATLAS_V1_PROPOSAL_PACKET.md

**Version:** 1.1 — incorporates PM review (tiered checks with advisory text scans, backlog-default disposition, intake guard banner).
**Status:** INTAKE MATERIAL — not an execution queue, not a sequencing authority.
**Supersedes:** ATLAS_MASTER_PLAN_V1.md (scrapped before install; never committed).
**Governance:** `BACKLOG.md` and `docs/ACTIVE_ROADMAP.md` remain the source of truth. This packet must be filed through `docs/GOVERNANCE.md` into the correct layers. Where anything here conflicts with repo governance, **repo governance wins**.

This packet contains exactly two proposals and one intake prompt. Nothing here pauses, reorders, or replaces active Soul Plan work.

---

## Proposal A — Persona Harness Lite (testing layer)

**Intent:** Extend the *existing* replay/e2e test assets with named synthetic-lifter scripts, so the coach pipeline gets hammered by hundreds of simulated sessions between live gym tests. Live sessions then get spent validating feel, not discovering logic bugs.

**Default disposition:** Files to `BACKLOG.md` as a testing-layer proposal. It enters `docs/ACTIVE_ROADMAP.md` only if current sequencing already calls for it — this packet does not put it next.

**Explicit non-goals:** No new harness universe. No parallel test framework. No CI gate changes in Wave 1. No LLM judge as a blocking check at any point in this proposal. No text-scanning check may block anything in this proposal.

### Wave 1 — one PR

1. Add four synthetic-lifter script packs to the existing harness:
   - **SIM-DALE** — A/B/C rotation, RIR progression, bench/squat focus, hold-until-10-clean-reps-at-RIR-3. Owner reads generated sessions and confirms "yes, that's how I train" before this pack is considered valid.
   - **CHAOS** — the historical live-bug reproductions (stacked-exercise parse/merge, multiple lifts in one message, wrong units, grouped-vs-interleaved output, screenshot-completion) as named scripts. *If these already exist as replay fixtures, extend — do not duplicate.*
   - **TERSE** — minimal input ("bench 185x5x3" and nothing else).
   - **RAMBLER** — long, messy, dictation-style walls of text.

2. Checks run in two tiers, honoring the engine-owns-numbers doctrine (test the brain with blockers; sample the voice with reports):

   **Tier 1 — hard checks at the engine seam.** Deterministic; read engine outputs, events, and state — never freeform LLM text. These join the existing test suite in the normal way:
   - The facts payload handed to the voice references the lift(s) actually logged, with numbers matching engine state.
   - No write-confirmation event or saved-state transition occurs before the write is actually confirmed.
   - Anti-repetition window respected at the engine/ledger level, where such a ledger exists.
   - Session-completion state is correct at every point praise could be issued, where an engine-side praise gate exists.

   **Tier 2 — advisory text scans.** Report-only, never blocking within this proposal; allowed to be imperfect because they read coach output text:
   - Numbers or units in output not present in the facts payload (with an allowlist for harmless counting language — "one more," "second set").
   - Wrong-lift mentions; persistence wording before a confirmed write; completion praise while the planned session is incomplete.

   **Stub check first:** before building any Tier 2 scan, verify whether the harness runs coach output stubbed/captured or against a live model. Live output means Tier 2 results will vary run to run — they stay advisory. Even with captured output, Tier 2 remains report-only within this proposal; promotion to blocking is a separate owner-approved change, later, after the scans have proven non-flaky.

### Wave 2 — one PR, only after Wave 1 has caught or prevented at least one real defect

1. Add four more packs: **ROOKIE** (beginner, inconsistent naming), **GHOST** (comeback after layoff), **IRONCLAD** (heavy singles, PR edge cases), **VOLUME-V** (supersets/stacked entries).
2. Add an **advisory-only** voice-conformance report: an LLM grader anchored verbatim to the ratified voice contract, producing a scored report per run. It never blocks. Promotion to blocking is an owner decision, and only after calibration: owner reads 5 random graded transcripts and agrees with every grade. If owner and grader disagree, the grader is wrong.

---

## Proposal B — V1 Proving Run (definition of done)

**Intent:** Make "v1 done" a falsifiable claim instead of a feeling.

**The gate:** v1 is declared only after **5 consecutive clean live gym sessions**.

**Clean means all of the following, per session:**
- Zero fabricated numbers or units anywhere in coach output (owner spot-checks against the sheet).
- Zero wrong-lift addressing.
- Zero repeated coach moments inside the anti-repetition window.
- Every naturally occurring coach moment judged correct by the owner (no staged firings).
- No white screens, broken updates, or failed writes.
- Post-session checklist filed within 24 hours.

**Reset rule:** Any dirty session resets the count to zero. Three consecutive resets triggers an owner review of root causes rather than continued grinding.

**Mechanics:** Live-test cards continue the existing LT-### series (append-only) and map to the owner's real A/B/C training week — the proving run is normal training, observed honestly, not a staged demo. Results are logged in a proving log placed wherever `docs/GOVERNANCE.md` says run-evidence belongs.

**Rationale:** Simulations catch logic. Only the gym proves feel.

---

## Owner cadence note (not agent stops)

Escalation Policy v3 stands: agents do not add check-ins beyond the four reserved categories. The owner's own review rhythm — reading merge cards, BACKLOG deltas, and (once Wave 2 exists) 5 random graded transcripts roughly every 10 merged PRs — is owner-initiated and requires no agent-side changes.

---

## Intake prompt (paste into Claude Code)

```
IMPORTANT — READ FIRST: This packet is proposal intake only. Do not create a new
master plan, interrupt ledger, sequencing authority, or execution queue. Do not
start Persona Harness work unless current BACKLOG.md / docs/ACTIVE_ROADMAP.md
already says it is next. File proposals through existing governance only.

Task: Intake of ATLAS_V1_PROPOSAL_PACKET.md. Docs/backlog filing only — no build
work in this session, no reordering of active roadmap work.

1. Read CLAUDE.md, docs/GOVERNANCE.md, BACKLOG.md, docs/ACTIVE_ROADMAP.md, and
   docs/DOCS_INDEX.md.
2. Run the Current-State Verification Gate (docs/AGENT_WORKFLOW.md) on this
   packet's premises before filing anything. Verify and report with evidence:
   a. What replay/e2e harness assets currently exist (location, fixture list),
      and whether the historical live-bug reproductions already exist as fixtures.
   b. Current Soul Plan position (A-series / B-series status) and LT-007 status.
   c. Whether an anti-repetition window/ledger exists in the engine today.
   d. Whether any existing doc already defines a v1 proof gate.
   e. Whether the harness/coach test path runs against stubbed or captured coach
      output vs a live model (this decides Tier 2 handling per Proposal A).
3. Adjust the two proposals to current state: extend what exists, delete any
   packet item that is already built or already covered by an existing doc, and
   say so explicitly in the PR body.
4. File through the front door: place each proposal at the correct governance
   layer per docs/GOVERNANCE.md and add BACKLOG.md entries. Default disposition
   for Persona Harness Lite is a BACKLOG.md testing-layer entry — do NOT insert
   it into docs/ACTIVE_ROADMAP.md unless current sequencing already calls for it.
   Deferred or rejected pieces get a one-line BACKLOG.md entry with the reason.
5. Update docs/DOCS_INDEX.md for any file added. Do not mark any existing doc
   superseded unless current governance already says so.
6. One concern per PR. Where this packet conflicts with repo governance, repo
   governance wins — note each conflict in the PR body.
7. The PR body must answer, in order: (1) what already exists, (2) what in this
   packet is genuinely new, (3) where the V1 Proving Run belongs per governance,
   (4) what was deferred and why, (5) confirmation that no active-roadmap
   reorder occurred.
```
