# Atlas — Canonical Agent Brief

This is the first file every implementation agent reads. It defines Atlas's operating, safety, branch, review, and merge rules.

The sole active execution campaign is:

- [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md)

`AGENTS.md` and `CODEX.md` are compatibility pointers only. No roadmap, old plan, audit, proposal, backlog section, chat prompt, or standalone issue reorders the campaign on its own. An **owner instruction governs only once it is recorded in the canonical execution plan** — owner instructions must land in `docs/ATLAS_V1_EXECUTION_PLAN.md`, never live only in an issue. The Atlas Recovery Campaign (Issue #1073) is the current owner insertion, recorded inside that plan; the plan remains the sole work-selection authority.

## What Atlas is

Atlas is Dale's conversation-first personal strength coach and workout logger. It parses natural gym language, maintains session truth, previews rows, and writes to Google Sheets only after explicit approval.

- **Storage authority is transitional.** Google Sheets is the runtime and permanent record today, and it stays the sole live authority until an authorized cutover moves it. On 2026-08-07 the owner authorized migrating the **workout hot path** — sessions, logged sets, Effort, accepted plans, plan sets and revisions, item outcomes, closeout and write receipts — to Supabase, with Sheets becoming a human-readable export mirror for those concepts only. Every other tab stays Sheets-owned. The instruction is recorded in [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md) ("OWNER INSTRUCTION 2026-08-07 — SUPABASE HOT-PATH MIGRATION"); the current and intended authority per concept is [`docs/ATLAS_SYSTEM_AUTHORITY.md`](docs/ATLAS_SYSTEM_AUTHORITY.md) concept 18; the design is [`docs/SUPABASE_HOT_PATH_MIGRATION.md`](docs/SUPABASE_HOT_PATH_MIGRATION.md). Nothing has migrated yet.
- The deterministic engine owns every number and decision.
- The application LLM only words whitelisted facts and answers grounded questions.
- The conversation is the product; other surfaces support it.
- Atlas is single-owner during V1.

## Read order

For routine implementation:

1. `CLAUDE.md`
2. `docs/ATLAS_V1_EXECUTION_PLAN.md`
3. `docs/ATLAS_SYSTEM_AUTHORITY.md`
4. `docs/DECISION_KERNEL.md`
5. `docs/CONTROLLED_TECHNICAL_WRITING.md`
6. The GitHub Issues backlog (label `backlog`) for awareness and deferred discoveries (`BACKLOG.md` is a frozen pointer stub since 2026-10-28)
7. relevant specs, invariants, tests, and evidence ledgers

[`docs/ATLAS_SYSTEM_AUTHORITY.md`](docs/ATLAS_SYSTEM_AUTHORITY.md) is the **ownership authority**: for each major concept it records the current live authority, the intended sole authority, any competing authority, status, the exact production consumer, any compatibility bridge, and the exact sunset condition. Read it before changing who decides something. It records authority; it selects no work.

Read `docs/DOCS_INDEX.md` when classifying a document. Read the full Vision/Architecture only when the active card reaches product direction, architecture, or a genuine conflict.

## Writing standard

Every implementation agent reads [`docs/CONTROLLED_TECHNICAL_WRITING.md`](docs/CONTROLLED_TECHNICAL_WRITING.md) and follows it when writing plans, reviews, failure reports, handoffs, implementation summaries, PR bodies, commit messages, and documentation. It is **controlled technical writing inspired by ASD-STE100**; Atlas claims no formal ASD-STE100 compliance.

That document holds the rules. Do not restate them here or in any other file, and do not apply them to Atlas's user-facing coaching voice, which `docs/COACHING_NOTE_VOICE.md` governs. It is a writing standard only: it selects no work and changes no safety, branch, merge, or owner gate.

## Closed-Loop Delivery Contract

**Purpose → Authority → Integration → Proof → Cleanup → Closure.**

Work is finished when a loop is closed, not when code lands.

1. Every PR names the exact **parent product or phase outcome** it advances.
2. "Useful foundation", "future flexibility", and "might be needed later" are **not** sufficient purpose.
3. Every new module, contract, runner, adapter, flag, bridge, or framework names its **exact live consumer** and its **final closure condition**.
4. A module, contract, import, route registration, unit test, or passing suite is **not** proof of integration or completion.
5. Proof stays **level-correct**:
   - a unit test proves local logic;
   - an integration test proves wiring;
   - a browser or full-session test proves the complete product path;
   - real owner evidence proves owner operation;
   - owner acceptance proves completion where required.
6. A **foundation PR is progress, not completion**.
7. A migration stays **open** until the displaced authority and the obsolete code, tests, flags, adapters, fallbacks, shadow paths, and stale documentation are removed — or each carries an exact sunset condition.
8. **No-orphan rule.** A production building block may merge only when it is either (a) integrated in the same PR, or (b) an unavoidable slice of a complete named chain already recorded in `docs/ATLAS_V1_EXECUTION_PLAN.md`, with the immediately following consumer, the cleanup slice, and the final closure condition all identified.
9. Unrelated work may not **leapfrog** an eligible integration, cleanup, or proving slice needed to close the current parent loop, unless a documented dependency blocks that slice.
10. Reviewers use the loop model to ask whether the PR closes its named outcome and whether temporary machinery has an exact retirement condition.

This is reviewer guidance, not machine-parsed merge-card semantics. Do not count loops, require a net-loop calculation, or create a prose gate from it. It creates no new roadmap, ledger, campaign, capability manifest, or governance system, and it adds no CI guard.

### Architectural ruling — one winner per authority

For an **authority defect**, select one intended winner and **remove the loser**. When immediate removal is genuinely unsafe, name the compatibility bridge and its **exact** sunset condition. Do not add permanent reconciliation logic around competing authorities.

Classify an implementation defect before dispatching it:

- **local defect** — one owner behaves wrongly; fix it in place;
- **authority defect** — two or more things decide the same concept; pick a winner and delete the loser;
- **missing capability** — nothing owns it yet; build it with a named consumer.

Prefer replacement and deletion over parallel implementation. Record the classification in the merge card.

Recording a concept as `DUPLICATED` or `TRANSITIONAL` in [`docs/ATLAS_SYSTEM_AUTHORITY.md`](docs/ATLAS_SYSTEM_AUTHORITY.md) is honest bookkeeping — it does **not** authorize fixing it early. Phase 5 owns consolidation.

## Roles and authority

### Dale — owner

Dale owns product direction, real production-data authorization, genuine gym/device evidence, destructive/schema/security decisions, Constitution/Invariant changes, application/runtime/provider/model selection, and One-Brain promotion.

Dale may merge anything or revoke authority, but routine PRs do not wait for him to click merge.

### Project decision desk and the Atlas Contract / Systems Review

The desk does two separate things. ChatGPT helps Dale resolve genuinely non-derivable product, scope, and trust forks. Separately, the **Atlas Contract / Systems Review** is the one blocking architecture lane for every PR. There is no second lane.

**Peer-review model (effective 2026-11-01).** The two builder lanes review each other's work. The reviewer records the verdict as a GitHub comment and in the merge-card review block, on the exact reviewed head. The coordinator assigns the review, verifies the recorded PASS (exact head, green CI, mergeable), and merges; the coordinator does not review. The implementation agent may not satisfy its own architecture gate with a clean-context self-review. The review never authorizes a production write and is never a GitHub status, required check, reviewer account, or owner approval.

#### When the review is required

Every PR requires an exact-head peer review by the other builder lane. There is no high-risk-only trigger and no category of PR that may claim the review is not required. The high-risk surfaces below still matter: a PR touching one gets the blocking-architecture treatment in the review (see "Blocking protocol"), and the merge-card check still treats those paths as mechanically high-risk.

- the preview → approve → write path, `test_mode`, idempotency, or authoritative write proof;
- a Supabase or Google Sheets schema, migration, data rewrite, destructive operation, storage-authority cutover, compatibility bridge, or bridge sunset;
- credentials, secrets, access control, or other security-sensitive infrastructure;
- the deterministic engine's product decisions, numerical/invariant contract, trust verdict, or proof that can advance a phase or count;
- which component is the sole authority for a concept;
- a hard gate that directly protects one of the surfaces above;
- product direction, owner-reserved scope, or a genuine unresolved trust/architecture ambiguity.

#### Blocking protocol

The blocking question is: **Is this exact head unsafe or architecturally wrong to merge?**

- Report only a concrete P0/P1 safety, product-trust, authority, schema, security, write-path, invariant, or cutover blocker.
- Put non-blocking improvements, polish, and speculative hardening in the optional advisory audit.
- A `PASS` applies only to the exact reviewed 40-character head.
- If a blocker is fixed, the follow-up review verifies the named fix and the high-risk surface changed by that fix.
- A newly discovered, evidenced P0/P1 in the named categories blocks merge whenever discovered, with the failure path recorded; advisory scope does not reopen. (Late-P0/P1 exception, adopted 2026-11-05; Astra finding 5, disposition on issue #1650.)

The merge card records:

- **Required** — `REQUIRED` on every PR (exact head, reviewer, PASS); `NOT REQUIRED` is a retained mechanical form only — do not claim it;
- **Exact reviewed head** — the current full commit SHA, or `N/A`;
- **Reviewer** — the reviewing lane's name, or `N/A`;
- **Review outcome** — `PASS`, `BLOCKING`, or `N/A`;
- **Findings and fix verification** — blockers and their disposition, follow-up verification, `none`, or `N/A`.

No round count is required.

The merge-card check also has a small closed list of paths that are always
mechanically high-risk. The list only determines blocking-architecture
treatment — every PR is REQUIRED regardless of path, and no PR may claim
`NOT REQUIRED`. The check reads filenames only; it does not parse prose or
try to infer meaning.

### The approved active implementation agent — implementation agent

**Definition (canonical; every other document points here).** The **approved active implementation agent** is the one agent Dale has approved to implement Atlas work at a given time. It is a role, not a product name. The role is held by whichever agent the owner approves, on whichever surface it runs — Claude Code, Codex, Cursor, or another owner-approved implementation surface — and whichever model that surface runs.

The surface and the model change nothing. They do not change branch rules, one-concern discipline, the Current-State Verification Gate, testing requirements, trust contracts, owner-reserved stops, the exact-head Atlas Contract / Systems Review, or merge authority. Any agent that holds the role holds the same authority; no agent holds it because of its name.

Two agents never hold the role for the same concern at the same time.

The approved active implementation agent:

- selects the first eligible unfinished campaign card;
- verifies current state before editing;
- implements one concern on a fresh branch;
- tests the live path or closest integration path;
- opens the PR and addresses review findings;
- declares its builder surface and model in the merge card (see "Merge-card attribution");
- handles real in-scope advisory findings;
- hands the PR to the coordinator for merge once the peer review records PASS on the exact head and all hard gates pass — the builder never merges;
- updates campaign state, refreshes `main`, and continues.

Do not stop merely to report that a routine PR is merge-ready.

### GitHub Actions and optional improvement audit

GitHub Actions supplies deterministic hard gates. Required checks that are missing, stale, skipped, errored, timed out, cancelled, incomplete, or failed are failures.

The required peer review and the optional improvement audit are different things. The peer review — the Atlas Contract / Systems Review performed by the other builder lane — is required on every PR and is never advisory. The optional improvement audit is separate: an independent agent review performed as an advisory audit. The default is **one advisory pass**. A second pass runs only when the first pass found a high-severity/systemic issue or its fix materially changed a high-risk surface. It verifies that issue. It is not run until clean. Low-severity suggestions never require another pass and do not block merge. A real P0/P1 product, trust, security, schema, write-path, invariant, or authority defect remains a blocker regardless of which lane discovered it.

Never create a synthetic review status from bot wording, reactions, or identity. The optional audit is not a required status, account, marker, human sign-off, or substitute for the Atlas Contract / Systems Review.

### Drift guards (CI, evidence-retained)

Each drift guard is a deterministic CI check that fails the build. The list is defined in `docs/ATLAS_V1_EXECUTION_PLAN.md` ("Drift guards"); the built guards are published here.

- **Guard 1 — Authority consistency** (`scripts/check-authority-consistency.js`, `npm run check:authority`): the one declared active-campaign marker is present and consistent across `CLAUDE.md`, the execution plan, and the docs index, and both `CLAUDE.md` and the docs index name the plan as the sole authority (Part A; H-01). Part B — every open `owner-instruction` issue referenced in the plan — is a documented follow-up (needs the GitHub API).
- **Guard 2 — Banned patterns** (`scripts/check-banned-patterns.js`, `npm run check:banned`): a registry of retired findings' forbidden production-path patterns. Today it enforces H-02 — the contentless normal-path receipt (`On plan — logged.`), legal only inside the outage-only `templatedAckLine` (a data-grounded wrap line is not a receipt, per the 2026-07-20 owner ruling). Add a pattern only with a demonstrated regression and remove it only through the retirement protocol below.
- **Guard 3 — Wiring guard hardened** (`scripts/check-allowlist-ratchet.js`, `npm run check:allowlist`): the staged wiring allowlist is shrink-only — `modules` may never exceed `staged_modules_ceiling`. The ceiling ratchets down as contracts wire out in Phases 3–5; raising it to stage a new module requires an owner-gate note recorded in the plan. Per-entry expiry + roadmap and expiry-fails-red stay enforced by the wiring guard (`check:wiring`). Fully hard-enforced after Phase 5.
- **Guard 4 — Completion-ladder validator** (`scripts/check-completion-ladder.js`, `npm run check:ladder`): the capability completion ladder (`config/coaching/manifests/capabilities.json`; published table `docs/CAPABILITY_COMPLETION_LADDER.md`; H-05/H-15) stays honest — no capability may claim `route_consumed` or `live_proven` without a linked test or trace id in its `evidence`, and the ladder must be structurally valid (nine boolean rungs, monotonic, a named `consumer` at `route_consumed` or higher). A synthetic-violation self-test (`test/completionLadderGuard.test.js`) proves the guard actually fails on an unsubstantiated claim. `owner_accepted` is owner-gate-only.
- **Guard 5 — Packet & trace honesty** (`scripts/check-packet-trace.js`, `npm run check:packet-trace`): the CoachTurnPacket / InteractionTrace shadow can never claim a fact it cannot back with a validating canonical contract object (H-05/H-15). It runs the real `assembleShadowPacket` over a fixed input matrix and fails when (a) an `assembled.valid` of true disagrees with `validateCoachTurnPacket` (a silently-invalid packet reported valid), (b) any embedded-presence flag OVERCLAIMS — `embedded.<fact>` present while `packet.<fact>` does not validate under its own contract, or `embedded.exercises` exceeds the count of genuinely-valid ExerciseIdentity entries (an UNDERclaim is safe and never flagged), or (c) a representative InteractionTrace fails to validate or its `missing`-stage list is not exactly the canonical stages it did not record. It is the forward-looking tripwire as Phases 4–5 populate the embedded facts (session→H-08, decision→H-03, safety→H-12, exercises→H-11): each must be claimed present only when canonical. A synthetic-violation self-test (`test/packetTraceGuard.test.js`) proves the guard bites on an overclaim.
- **Guard 6 — Paper-weight, narrowed 2026-10-28** (`scripts/check-paper-weight.js`, `npm run check:paper-weight`): since the backlog moved to the GitHub Issues board (owner ruling 2026-10-28, recorded in the execution plan), `BACKLOG.md` is a frozen pointer stub and the guard no longer enforces backlog contents — the ledger size cap (`backlog_max_lines`) and the `[archive-ready]` staleness rule were retired with the migration. The narrowed guard fails when the stub grows past `config/paper-weight.json` `backlog_stub_max_lines` or loses its Issues-board pointer, so findings cannot quietly re-accumulate in the file. The marker-parsing helpers stay exported for the **auto-archive job** (`scripts/archive-backlog.js`, `npm run archive:backlog`), which remains the mechanical path for moving explicitly `[archive-ready: YYYY-MM-DD]`-tagged items to `BACKLOG_ARCHIVE.md`; the tag is still the ONLY archival signal — the job never guesses archivability from a free-text ✅/shipped/FIXED, because the 2026-07-20 reconciliation ([`docs/verification/BACKLOG_RECONCILIATION_2026-07-20.md`](docs/verification/BACKLOG_RECONCILIATION_2026-07-20.md)) proved a heuristic can't safely separate a fully-shipped item from a ✅-with-open-follow-up one. `backlog_max_lines` and `stale_after_days` remain in the config only as the archive job's historical ratchet record.
- **Guard 7 — Bounded backlog ledger — RETIRED 2026-10-28** (owner ruling recorded in the execution plan): the backlog moved to the GitHub Issues board, so the fixed-capacity counts this guard enforced no longer exist. `scripts/check-backlog-intake.js`, its self-tests (`test/backlogIntakeGuard.test.js`), the `check:backlog-intake` npm script, and its CI job were removed by the governance PR that recorded the retirement. Bounded, dispositioned intake survives in the new form: the finding-disposition rules below, the plan's Bounded Backlog Review protocol (now run against the Issues board, `label:backlog`), and Guard 6 as narrowed.

#### Governance-control retirement

Governance controls are not permanent by default. A focused governance PR may retire or narrow a control when it:

1. names the demonstrated failure the control originally protected;
2. shows that a surviving test, invariant, owner gate, or narrower control still protects that failure — or proves the failure is no longer reachable;
3. includes a synthetic failure test for any replacement mechanical check;
4. changes only the existing canonical governance home and its tests; and
5. passes the same deterministic product/trust gates as any other PR.

Do not retire a proven write-path, schema/Supabase, security/secret, deterministic invariant, one-authority, owner-reserved, or current-state gate merely because it creates work. Do not add a new governance framework to track retirement.

## Standing coordination rules (adopted 2026-11-03, issue #1650; amended 2026-11-05 per the Astra disposition on #1650)

Adopted by Dale on the coordinator's recommendation. These rules govern how the two builder lanes (Hammy, Sunny) and the coordinator work the queue. Issue #1650 is the adoption record; this section is the canonical home.

**Supersession (Astra review, adopted 2026-11-05; disposition on issue #1650, comment 6647810597).** The peer-review model in force since 2026-11-01 supersedes every earlier instruction in this brief and its companion documents that says the implementation agent merges under standing authority, that independent review is advisory, or that the required Atlas Contract / Systems Review is performed by ChatGPT or is triggered only by high-risk surfaces. Where this brief, `AGENTS.md`, or `docs/BUILDER_PORTABILITY.md` still carried such instructions, the Astra fold-in removed them; any surviving copy is superseded by this paragraph and must not be followed.

### Authorization and pace

- **Assignment is authorization.** A coordinator assignment in Slack, or direction from Dale anywhere, is the authorization to start. No lane waits for a separate go, a watch rule, or a confirmation in its own chat. A lane that believes an owner gate applies (deploys, spend, credentials, schema changes, S4 cutover, Phase 5 entry, the CIL ruling) names the gate in the Slack thread and keeps building anything not gated.
- **Handback authorization.** Assignment authorizes routine delivery communications (handbacks, verdicts, merge-card updates, merge reports) with no separate approval; content-bearing decisions reach Dale only across a named owner gate. (Astra finding 2, adopted verbatim 2026-11-05.)
- **Start-by and named blocker.** Every assignment carries an implicit start-by of the same working day. A lane that cannot start posts a named blocker instead. Silence is never a status. While an item is open, the lane posts a status at least every few hours during the day.
- **Peer-review start-by and verdict-due.** Peer reviews carry an explicit start-by, the same as build assignments. The coordinator's ack of a handback names the review start-by (default: same working day); a reviewer who cannot meet it posts a named blocker before it passes. Every review also names a verdict-due as well as a start-by. When a reviewer begins a peer review, they post "started" in the review thread the same working day, so review state is visible before its start-by passes.
- **Blockers and recovery.** A blocker names its resolution owner, next action, and next checkpoint. A missed deadline triggers a recorded recovery action at the next hourly check, not a repeated status.
- **Named queue chains.** Assignments name the chain and blast radius (for example, a checker PR before the PR it unblocks), so dependencies are visible before they bite.
- **Checker versus Dale's value.** When a checker rejects a value Dale set, the checker is fixed to accept it. Dale's value is never overridden or reverted to satisfy the checker. This is a narrow rule, not a blanket presumption that checkers are wrong.

### Review eligibility and merge practice

- **Review eligibility.** Anyone who implemented any part of a PR cannot supply its independent PASS. If no eligible independent reviewer exists, the coordinator records the capacity blocker and brings Dale a concrete recommendation. Self-review, role renaming, and coordinator code review remain prohibited. (Astra finding 3, adopted 2026-11-05.)
- **Head/base pair evidence.** After any merge, a remaining PASSed PR whose target base moved gets fresh CI on the updated head/base pair plus a peer delta-confirmation (affected surfaces only) before merge; eligibility expires when either SHA changes. This is coordinator merge practice, effective 2026-11-04. The merge-queue / branch-protection machinery is DEFERRED (it brushes Dale's recorded #1572 deferral of branch protection); revisit if lane volume grows. (Astra finding 4, adopted in principle 2026-11-05.)

### Lane mechanics

- **Standing authority for routine posts.** A lane may post routine status, named-blocker, and ack posts in its own threads without a per-post approval. Handbacks, verdicts, merge-card updates, and merge reports are authorized by the assignment itself (see "Handback authorization" above); content-bearing decisions reach Dale only across a named owner gate.
- **Design calls at kickoff.** Test-input design calls are settled at slice kickoff, or delegated to builder plus coordinator in-thread. They never stall a build mid-slice.
- **Automatic named-blocker status.** A named-blocker status is posted automatically whenever a decision pends.
- **Proven push path.** The push path is proven during lane setup, before the first build slice.
- **Persistent evidence paths.** Long-running evidence (E2E runs and similar) writes to a persistent path under `~/workspace/`, never `/tmp`.
- **Local-complete / PR-not-landed note.** When a build is complete locally but its Draft PR has not landed by the next queue check, the builder posts a one-line note naming the hold.
- **Parked-card surfacing.** A lane run parked on a pending approval card surfaces that card — what it asks and when it was requested — in the channel immediately, not at the next queue check. (Adopted 2026-11-05, issue #1650 comment 6667052401; companion to the local-complete / PR-not-landed note. Case in point: an orphaned card blocked the 06:00/08:00/10:00 queue checks for ~4 hours before the hold was named.)
- **Deflake probe-change rule.** When a deflake item survives two clean full-suite runs without reproducing, the next diagnosis step changes the probe (longer stress, tightened timing, or a different load shape) instead of repeating the same evidence run.

### Assignment, rulings, and direction

- **Assignment pre-check.** Before assigning any item, the coordinator reads the target issue's labels and gate text. If an owner gate exists, the assignment does not go out; the ruling question goes to Dale first, with the work sequenced behind the ruling.
- **Rulings live on the issue.** Every owner ruling is written onto its GitHub issue the same hour, and any owner-decision label it lifts is removed with the ruling. Lanes verify rulings from the record, never from a relay.
- **Direction rides fresh posts.** Coordinator direction goes in new top-level channel posts, not inside threads whose reads trip the platform safety screen (the flagged threads stay signal-only via channel/search surfaces).
- **Deploy notices.** After each production deploy, the coordinator posts a one-line top-level notice naming the live commit, so lane sessions do not run on a stale picture of production.

### Work in progress and record hygiene

- **WIP cap.** A lane does not open a third PR while two of its PRs await the peer lane's review. Peer reviews come before new builds.
- **Closing keywords and manual close.** Every PR body carries `Fixes #N` / `Closes #N` for each issue it completes. The keyword creates the link and the merge reference — but it does not auto-close the issue: GitHub fires closing keywords only on merges into the repository's default branch, and the live line is the non-default `s3-maintenance`. The coordinator closes each completed issue manually with a reconciliation note at merge. (Diagnosis 2026-11-05: PRs #1651–#1655 all carried valid keywords and merged into `s3-maintenance`; all five issues were closed manually by the coordinator, #1565/#1573/#1583 with an explicit "did not auto-close" note; the #1633/#1636 precedent matches. No template or placement change can make auto-close fire on this branch.)
- **Early draft visibility.** Within the first working session on an item, the lane pushes its branch and opens the Draft PR. Work in progress is visible on the GitHub record, not only on the lane's machine.

### Deploy practice

- Deploys go in small trains (1–3 PRs with product changes) on Dale's per-deploy approval. The coordinator brings the ask with the merge report instead of letting batches accumulate.

## Campaign execution loop

1. Verify current `main`, a clean worktree, prerequisites, and deployment when relevant.
2. Read the first eligible unfinished card in `docs/ATLAS_V1_EXECUTION_PLAN.md`.
3. Run the Current-State Verification Gate.
4. Create a fresh `agent/<concern>` branch from current `main`.
5. Implement one concern only.
6. Run focused tests plus every applicable build/test/lint/wiring/secret/E2E/trust check.
7. Inspect the diff, commits, secrets, and unrelated drift.
8. Open one PR with the Atlas Merge Card and one primary risk label.
9. Obtain the peer review (Atlas Contract / Systems Review) on the exact head, and record it in the merge card.
10. Address real in-scope blockers and use at most the bounded optional audit above.
11. Hand the PR to the coordinator for merge once every hard gate passes, the peer review records PASS on the exact head, and no owner authorization remains outstanding.
12. Verify `main` and deployment, update the campaign card/completion record, and continue from a fresh branch.

A conversation running out of context is not a project blocker. Start a new session and resume from repository state.

## Current-State Verification Gate

Before editing, report:

1. **Source:** canonical campaign card and supporting finding/issue.
2. **Duplicate/stale search:** current code, tests, backlog, recent PRs/issues, and deployed behavior where relevant.
3. **Verdict:** exactly one of:
   - `STILL BROKEN`
   - `ALREADY FIXED`
   - `PARTIALLY FIXED`
   - `FIXED BUT UNTESTED`
   - `STALE / SUPERSEDED`
   - `NEEDS OWNER APP-TEST`
4. **Evidence:** exact file/function/test/PR/issue and current failure/fix path.
5. **Allowed next action:** smallest implementation, proof-only, status-only, or stop.

If already fixed, do not manufacture code. If fixed but untested, prove it rather than refactoring it.

For a `BUG-…` item, check `docs/BUG_TRIAGE_LEDGER.md` before implementation because the Sheet itself does not identify resolved rows.

## Branch and scope rules

- New work uses `agent/<concern>` from current `main`. Existing `claude/*` branches stay valid historical branches; they are not the form for new work.
- One PR equals one concern.
- Never stack later campaign work on an open or merged feature branch.
- Stage only intended files; never include `.env`, credentials, production IDs, private evidence, or unrelated changes.
- Future discoveries take one disposition (below); they do not expand the current PR.
- If a fix spreads, split it.
- Do not build later cards early.
- Do not create another roadmap, fix-it document, campaign controller, or giant session prompt.

### Finding disposition (owner ruling 2026-07-30, final form 2026-07-31 — bounded backlog ledger; form superseded by owner ruling 2026-10-28 — GitHub Issues backlog)

The **GitHub Issues backlog** (label `backlog`) is the **bounded, actively consumed evidence ledger** of proven deferred work. It preserves findings; it never selects work, authorizes a PR, or competes with the execution plan. Issues are the backlog ledger itself — not a parallel backlog — and an issue alone never authorizes work; the execution plan remains the sole work-selection authority. Every new finding takes exactly one disposition:

1. **FIX NOW** — fix and test it in the current PR.
2. **REJECT** — record the rejection and a short rationale in the PR discussion.
3. **ADD TO BACKLOG** — open a GitHub Issue labelled `backlog` (plus its classification label) carrying the qualification detail below.
4. **OWNER DECISION REQUIRED** — stop and report it to the owner.

Advisory findings do not automatically become work.

**Qualification.** An item enters the backlog only when current-state verification proves it is real, it has concrete user or system impact, it is outside this PR's one concern or genuinely blocked, and it is not already tracked — search the board first; a duplicate is closed as a duplicate, not re-filed. Each new or materially reviewed item states compactly, in the issue body: classification (`trust-critical` / `correctness` / `polish` / `housekeeping`), status (`READY` / `BLOCKED` / `OWNER DECISION`), impact, evidence or reproduction, acceptance criteria, reason not fixed now, and a next review trigger (dependency, phase, or date). A few lines, not a template.

**Bounded intake.** The board is bounded by disposition and review, not by file capacity — the fixed-capacity mechanics of the 2026-07-30/31 form (`BACKLOG.md` item/line counts, `backlog_max_lines`, Drift Guard 7) ended with the 2026-10-28 migration. Every item carries one disposition, the qualification bar above, and a next review trigger, and the Bounded Backlog Review protocol works the board down: items leave the board only by being fixed, promoted into the plan, or closed as genuinely stale, duplicated, rejected, or superseded. **Never close a valuable item just to tidy the board.** When a PR changes backlog membership, record the opened and closed issues briefly for reviewer judgment; CI does not parse that prose.

**Consumption.** The plan's Bounded Backlog Review protocol runs against the Issues board (`label:backlog`) at every phase boundary, and before discretionary or overnight work when the recorded review is more than seven days old: up to 20 items, each given FIX NOW / PROMOTE / KEEP BLOCKED / ARCHIVE-REJECT, at most two fixes per cycle. The 2026-07-30 policy's four-cycle stability lock applied to the file form; the owner's 2026-10-28 direction superseded that form, recorded in the plan.

### High-risk files

`index.js`, `src/app/app.js`, and `services/workoutTextParser.js` carry extra rules, including the app.js session-state freeze. The full rule is in [`.claude/rules/high-risk-files.md`](.claude/rules/high-risk-files.md). That path is a retained filename, and the file auto-loads only on a surface that reads `.claude/rules`. The rule binds every approved active implementation agent: if your surface does not auto-load it, read it before you touch one of those three files.

## Merge-card attribution

Every PR declares who performed the work, in the existing Atlas Merge Card. The card is the sole attribution authority. Do not add a commit trailer, a model registry, a label taxonomy, or a tracking database beside it.

Four required fields:

- **Builder surface** — the tool the work ran on, for example `Claude Code`, `Codex`, or `Cursor`;
- **Primary builder model** — the exact model name the surface displays;
- **Supporting / explore models** — every other model used, with what it did, or `None`;
- **Architecture / dispatch authority** — who dispatched and architecturally owns the work, normally `ChatGPT`.

Record the exact displayed model name when it is known. Never guess a model identity: report what the surface shows, or state plainly that the surface withholds it. Attribution is **declared evidence**, not cryptographic proof, and it grants no authority — it records who acted.

The merge-card completeness check fails a PR when any of the four fields is absent, blank, or still a template placeholder. `None` is a valid value for **Supporting / explore models** only; the other three name a real surface, model, or authority.

## Merge gate

The coordinator merges a PR when:

- every applicable required GitHub check passed on the exact current head;
- no genuine P0/P1, invariant, trust-loop, schema, security, secret, or write-safety problem remains;
- no real high-severity/systemic defect found by an advisory audit remains unresolved;
- one-concern scope, branch hygiene, risk label, Vision Alignment Check, and merge card are complete;
- the peer review (Atlas Contract / Systems Review) is recorded in the merge card with PASS on the exact head — and, when the base moved after the PASS, fresh CI on the exact head/base pair plus a peer delta-confirmation (see "Standing coordination rules");
- the PR is authorized by the campaign or explicit owner instruction; and
- no owner-reserved authorization remains outstanding.

The builder never merges. No PR merges under standing authority, and no PR merges on green checks alone without the recorded peer PASS.

**Merge policy.** A PR merges only when the coordinator verifies the recorded peer PASS on the exact head, green CI on the exact head/base pair, and mergeability, and merges it. The owner never clicks approve on any PR, including a governance PR. Owner-reserved items are gates (live-test workouts, dictated rulings, production setting changes), never merge approvals. The runtime preview → approve → write loop is unchanged and remains the data safety net.

## Standing command — Atlas Recovery Campaign

When the owner says **"execute Atlas Recovery Plan"** — or any clear variant such as "run the recovery plan" or "continue the recovery" — read the campaign in `docs/ATLAS_V1_EXECUTION_PLAN.md`, find the `CAMPAIGN STATE` block, and execute the next eligible step(s) of the current phase:

- one concern per PR;
- hand each PR to the coordinator for merge on green checks plus a recorded peer PASS (no owner merge approval);
- advance the `CAMPAIGN STATE` tracker in the same PR;
- continue until an **OWNER GATE**.

At a gate, stop and ask the owner exactly one short question using that gate's script from the campaign specification. Never skip a gate; never proceed past one on inferred approval. The freeze holds: Phases 2–7 do not start until the Phase 1 owner gate passes, and `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0` until Phase 4 explicitly requires it.

## Owner-reserved stops

Stop for Dale only when required for:

1. genuine owner-only gym/device evidence;
2. real production-write authorization;
3. product vision, coaching philosophy, new capability/workflow/scope, or application/runtime/provider/model changes;
4. schema, migration, deletion, credentials, or security-sensitive infrastructure;
5. Constitution/Invariant amendments;
6. One-Brain or other promotion decisions;
7. a genuine unresolved principle conflict or explicit owner hold.

Routine code, tests, refactors, derivable UX/wording, advisory disposition, and clean merges are not owner stops.

## Absolute data safety

- No real Google Sheets write without explicit owner authorization.
- `test_mode` absent means live write. Dry-runs must pass `test_mode:true` explicitly.
- Dry-run proof requires `sheet_written:false` and `no_write_confirmed:true`.
- Live-write success requires authoritative proof such as `sheet_write:'success'` and positive row/range evidence.
- No manual Sheet edits by agents.
- No schema migration, historical rewrite, deletion of owner data, approval-gate weakening, proof-field change, or credentials/security change without Dale.
- Any production data-integrity anomaly freezes writes immediately.
- No secrets, `.env`, production Sheet IDs, private payloads, Render env values, screenshots, or workout data in commits/PRs.

## Critical behavior contracts

Never change these semantics without explicit owner approval:

| Contract | Authority |
|---|---|
| `225 5/2` = 225 lb × 5 reps @ RIR 2 | parser contract / `services/workoutTextParser.js` |
| Preview → approve → write | Constitution / Invariants |
| `test_mode` absent = live write | write route |
| Dry-run vs live-write proof fields | Invariants W1–W3 |
| Undo read-back must fail closed | undo route/invariants |
| Engine owns numbers; LLM only words facts | Constitution / Decision Kernel |
| Deload prescription is deterministic protocol | `docs/DELOAD_SPEC.md` |

## Sheet schemas

No columns may be added, removed, or reordered without a migration and explicit owner approval. `config/columns.js` and the relevant sheet contract are authoritative. The per-tab column layouts (`Log_Cleaned`, `Effort`, `Constraints`, `Deload_State`, `Session_Plans`) are in [`.claude/rules/sheet-schemas.md`](.claude/rules/sheet-schemas.md). That path is a retained filename, and the file auto-loads only on a surface that reads `.claude/rules`. If your surface does not auto-load it, read it before you define, write, or validate a Sheet row.

## Coach/LLM boundary

- Application provider/model selection is owner-reserved.
- Coach endpoints are read-only and never write Sheets.
- Forward only whitelisted, bounded fields through the sanitizer.
- The LLM never invents numbers, verdicts, rules, progress, history, or write claims.
- When the LLM is unavailable, degrade to deterministic templated/null behavior—never a guess.
- Engine-selected safety/recovery/correction modes outrank stylistic voice.

## Testing

> **Full catalogue of every test/CI/verification system, its exact command, and its write-safety class:** [`docs/TESTING_INDEX.md`](docs/TESTING_INDEX.md). Read it before hand-rolling a probe — the tool you need almost certainly exists.

Primary suite:

```bash
npm test
```

Also run applicable focused tests, build, lint, wiring, secret scan, E2E, and trust/write/schema checks.

Tests use `require.cache` injection to stub `sheets.js` before the Express application loads. Preserve that pattern unless a scoped architecture change explicitly replaces it.

A test should prove the historical failure cannot recur through the live path or closest integration seam, not only through a new helper.

## Live testing

Read `docs/AGENT_LIVE_TESTING.md` and local `.env` instead of asking Dale to repeat known setup.

- Tier 1 read-only and Tier 2 `test_mode` dry-run tests are pre-authorized.
- Tier 3 real writes require explicit per-test authorization.
- Mark synthetic traffic exactly as the testing playbook requires.
- Never fabricate genuine owner activity, LT evidence, or GATE A eligible events.

## Operational status (Control Tower)

To answer "where are we / is prod healthy / did the latest write+undo hold" without being handed Sheet IDs, tab names, session IDs, or doc paths, run `npm run atlas:status` (add `-- --json` for the machine schema). The same bounded, redacted document is served publicly (no API key) at `GET /.well-known/atlas-status.json`. The full schema, sources, redaction, and honesty rules are in [`docs/ATLAS_OPERATIONS_CONTRACT.md`](docs/ATLAS_OPERATIONS_CONTRACT.md). It is read-only and never fabricates health.

To answer "review my latest live app test", run `npm run atlas:review-live` (add `-- --json`). It auto-selects the newest genuine owner session, joins Flight Recorder / Intent Shadow / Brain Shadow / Session Plans / Log / Effort, detects a build change during the session, and reports PASS/FAIL/UNKNOWN per trust criterion (UNKNOWN = missing evidence, never a false green). Read-only; needs no Sheet ID/tab/session id. **`atlas:status` = general health/campaign status; `atlas:review-live` = the newest real app session.**

To answer "where does production bypass packet truth" (the Phase-3 shadow), run `npm run atlas:divergence -- <logfile>` (or pipe the log stream to it; add `--json`). It parses the deployment's `[coach-turn-shadow]` records — emitted with `ATLAS_INTERACTION_TRACE=shadow` — and lists every place production contradicted or bypassed the CoachTurnPacket (null embedded facts, bypassed spine stages, invalid packets, visible-reply-vs-null-decision). Read-only, deterministic; 0 records in ⇒ 0 turns reported (never a false green). It is the Phase-4 TODO list.

To answer "how much of the Soul corpus does the code actually coach yet", run `npm run atlas:corpus-baseline` (add `-- --json`, `-- --stdout`, or `-- --append --phase "Phase 4"`). It replays all fifteen Soul Corpus V2 sessions (`docs/reference/ATLAS_SOUL_CORPUS_V2_*`) turn-by-turn against the real read-only coach code with **synthetic athlete profiles in test mode** — sheets stubbed, **never a live write**, every turn tagged **corpus-synthetic**, fully **segregated** from the real `[coach-turn-shadow]`/divergence stream (the shadow flag is never set) — and scores each of the synthesis's **35 behavioral capabilities** pass/partial/absent, rounding down, with each absent capability mapped to the phase that builds it. Publishes [`docs/verification/CORPUS_BASELINE_SCOREBOARD.md`](docs/verification/CORPUS_BASELINE_SCOREBOARD.md). Owner side-instrument (recorded in the execution plan's `CAMPAIGN STATE`); reruns and appends at the close of Phases 4, 6, and 7. Read-only, deterministic; no observations ⇒ all absent (never a false green).

## What not to build during the V1 campaign

Unless Dale explicitly changes direction, do not add:

- a second database or storage migration, **other than** the owner-authorized Supabase hot-path migration recorded in the execution plan (2026-08-07). That migration is bounded to seven named concepts, and to four PRs plus the one narrowly scoped post-window schema-history cleanup PR the owner approved on 2026-08-07 (ruling D8, recorded in the plan); it authorizes no other store and no widening of its own scope;
- multi-user/public-product architecture;
- nutrition tracking;
- broad wearable support;
- native mobile app;
- frontend-framework rewrite;
- autonomous Atlas-agent mode or another orchestration platform;
- another coaching-intelligence roadmap;
- speculative UI redesign or broad cleanup.

Finish the campaign, prove V1, stabilize, then decide what observed use justifies.

## Builder model and optional tooling

Dale selects the builder surface and the builder model; that selection is owner-reserved. His standing preference names a Claude Opus 4.8 builder. A preference is not an authority grant: it is not a branch-protection rule, a required status, or a merge gate, it does not restrict which owner-approved agent may hold the implementation role, and it does not change Atlas's application LLM.

Optional tools such as gstack may improve investigation/review quality when available. They never replace Atlas governance or create a required paid review lane.

## Fresh-session launcher

[`AGENTS.md`](AGENTS.md) carries the one compact launcher for every surface. Do not write a second one.

Before implementation, report only:

1. active milestone;
2. next eligible card;
3. current-state verdict;
4. whether code is actually required;
5. any genuine owner gate.
