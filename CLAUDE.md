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
6. `BACKLOG.md` for awareness and deferred discoveries
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
10. Every PR reports **open loops closed**, **open loops created**, and **net open-loop change**.

**Normal requirement: net open-loop change is zero or negative.** A positive result requires an explicit owner-approved reason, a complete closure chain, and exact sunset conditions.

This is a delivery discipline recorded in the merge card. It creates no new roadmap, ledger, campaign, capability manifest, or governance system, and it adds no CI guard.

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

The desk does two separate things. ChatGPT helps Dale resolve genuinely non-derivable product, scope, and trust forks. Separately, one review lane — the **Atlas Contract / Systems Review** — reads a triggered PR.

**Use this one name everywhere.** The lane was formerly called the "ChatGPT Atlas Contract Review". Two names for one lane read as two lanes. There is one lane.

**ChatGPT performs the required review.** This is an authority boundary, not a preference (owner ruling 2026-08-03, recorded in the execution plan). The implementation agent may not satisfy its own architecture gate: a clean context is not an independent authority — it is still the implementation agent, and it reproduces the same model and system blind spots. Naming the performer creates observability, not separation of authority.

A clean-context review by the implementation agent stays **optional advisory confidence**. Record it under advisory findings. It never satisfies the required gate.

The merge card still records **who** performed the required review, so a review that did not come from the ChatGPT lane is visible as one.

The review never authorizes a production write, and it is never a GitHub status, a required check, or a reviewer account.

It is not a routine gate on every PR, but the trigger list below is deliberately wide, and most campaign work touches it. Treat "no trigger fired" as a claim that must survive reading the list, not as the default.

#### When the Atlas Contract / Systems Review is required

**Owner instruction 2026-08-03, recorded in [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md).** The existing review lane covers more triggers. This creates **no second review system**, no new account, no new marker, and no new CI check. It is the same manual lane, recorded in the merge card.

The review is required when a PR touches any of these:

- campaign gates;
- scorecards and counters;
- adjudicators;
- rehearsal and test runners;
- evidence collectors;
- identity and correlation machinery;
- phase or count advancement;
- trust-sensitive write, schema, security, promotion, or destructive changes.

The earlier triggers stay in force: phase transitions, roadmap changes, product or trust-contract changes, and genuine ambiguity.

The review reads the **exact head** in a clean context. A review of an earlier commit does not cover a later head.

#### What the review must ask

1. Does this hold in the next legitimate repository state, not only the current fixture?
2. Can missing, no-op, defaulted, circular, or hardcoded evidence produce a false green?
3. Does the proof establish identity, content, order, and authority — not cardinality alone?
4. Does it remain correct when historical records coexist with current state?
5. What authority wins, what loses, what bridge remains, and when is it removed?
6. Could this falsely advance a count or phase?
7. What temporary machinery must be deleted?

#### What the merge card must record

The merge card's **Atlas Contract / Systems Review** block records four fields:

- **required / not required** — with the trigger that fired, or the reason none fired;
- **exact reviewed head** — the full commit SHA the reviewer read;
- **reviewer** — who performed the required review;
- **findings and dispositions** — every finding, and fixed / non-issue / routed for each.

A review is a manual merge-card record. Never create a CI status, a required check, or a review account from it.

### The approved active implementation agent — implementation and merge operator

**Definition (canonical; every other document points here).** The **approved active implementation agent** is the one agent Dale has approved to implement Atlas work at a given time. It is a role, not a product name. The role is held by whichever agent the owner approves, on whichever surface it runs — Claude Code, Codex, Cursor, or another owner-approved implementation surface — and whichever model that surface runs.

The surface and the model change nothing. They do not change branch rules, one-concern discipline, the Current-State Verification Gate, testing requirements, trust contracts, owner-reserved stops, the exact-head Atlas Contract / Systems Review, or merge authority. Any agent that holds the role holds the same authority; no agent holds it because of its name.

Two agents never hold the role for the same concern at the same time.

The approved active implementation agent:

- selects the first eligible unfinished campaign card;
- verifies current state before editing;
- implements one concern on a fresh branch;
- tests the live path or closest integration path;
- opens and completes the PR;
- declares its builder surface and model in the merge card (see "Merge-card attribution");
- handles real in-scope advisory findings;
- merges the exact passing head under standing authority;
- updates campaign state, refreshes `main`, and continues.

Do not stop merely to report that a routine PR is merge-ready.

### GitHub Actions and independent agent review

GitHub Actions supplies deterministic hard gates. Required checks that are missing, stale, skipped, errored, timed out, cancelled, incomplete, or failed are failures.

Independent agent review — Codex, or any other agent that is not the active builder — is advisory only. Fix real confident in-scope findings; route genuinely ambiguous ones; record false alarms as non-issues. Never create a synthetic review status from bot wording, reactions, or identity.

An optional clean-context review may be used for confidence on higher-risk work. It is not a required status, account, marker, or human sign-off, and it never satisfies the Atlas Contract / Systems Review.

### Drift guards (CI, grow-only)

Each drift guard is a CI check that fails the build — a rule that lives only in a document is not a guard. The list is defined in `docs/ATLAS_V1_EXECUTION_PLAN.md` ("Drift guards") and grows there; the built ones are published here and are never removed or weakened without an owner instruction recorded in the plan.

- **Guard 1 — Authority consistency** (`scripts/check-authority-consistency.js`, `npm run check:authority`): the one declared active-campaign marker is present and consistent across `CLAUDE.md`, the execution plan, and the docs index, and both `CLAUDE.md` and the docs index name the plan as the sole authority (Part A; H-01). Part B — every open `owner-instruction` issue referenced in the plan — is a documented follow-up (needs the GitHub API).
- **Guard 2 — Banned patterns** (`scripts/check-banned-patterns.js`, `npm run check:banned`): a grow-only registry of retired findings' forbidden production-path patterns. Today it enforces H-02 — the contentless normal-path receipt (`On plan — logged.`), legal only inside the outage-only `templatedAckLine` (a data-grounded wrap line is not a receipt, per the 2026-07-20 owner ruling). Patterns are added only as their findings retire (packet-owned recomputation → Phase 4, duplicate safety classifiers → Phase 5d, …).
- **Guard 3 — Wiring guard hardened** (`scripts/check-allowlist-ratchet.js`, `npm run check:allowlist`): the staged wiring allowlist is shrink-only — `modules` may never exceed `staged_modules_ceiling`. The ceiling ratchets down as contracts wire out in Phases 3–5; raising it to stage a new module requires an owner-gate note recorded in the plan. Per-entry expiry + roadmap and expiry-fails-red stay enforced by the wiring guard (`check:wiring`). Fully hard-enforced after Phase 5.
- **Guard 4 — Completion-ladder validator** (`scripts/check-completion-ladder.js`, `npm run check:ladder`): the capability completion ladder (`config/coaching/manifests/capabilities.json`; published table `docs/CAPABILITY_COMPLETION_LADDER.md`; H-05/H-15) stays honest — no capability may claim `route_consumed` or `live_proven` without a linked test or trace id in its `evidence`, and the ladder must be structurally valid (nine boolean rungs, monotonic, a named `consumer` at `route_consumed` or higher). A synthetic-violation self-test (`test/completionLadderGuard.test.js`) proves the guard actually fails on an unsubstantiated claim. `owner_accepted` is owner-gate-only.
- **Guard 5 — Packet & trace honesty** (`scripts/check-packet-trace.js`, `npm run check:packet-trace`): the CoachTurnPacket / InteractionTrace shadow can never claim a fact it cannot back with a validating canonical contract object (H-05/H-15). It runs the real `assembleShadowPacket` over a fixed input matrix and fails when (a) an `assembled.valid` of true disagrees with `validateCoachTurnPacket` (a silently-invalid packet reported valid), (b) any embedded-presence flag OVERCLAIMS — `embedded.<fact>` present while `packet.<fact>` does not validate under its own contract, or `embedded.exercises` exceeds the count of genuinely-valid ExerciseIdentity entries (an UNDERclaim is safe and never flagged), or (c) a representative InteractionTrace fails to validate or its `missing`-stage list is not exactly the canonical stages it did not record. It is the forward-looking tripwire as Phases 4–5 populate the embedded facts (session→H-08, decision→H-03, safety→H-12, exercises→H-11): each must be claimed present only when canonical. A synthetic-violation self-test (`test/packetTraceGuard.test.js`) proves the guard bites on an overclaim.
- **Guard 6 — Paper-weight** (`scripts/check-paper-weight.js`, `npm run check:paper-weight`; auto-archive job `scripts/archive-backlog.js`, `npm run archive:backlog`): (1) `BACKLOG.md` may not exceed `config/paper-weight.json` `backlog_max_lines` — a shrink-only size cap that ratchets down as the file is trimmed. (2) **Staleness** — CI fails when an item explicitly tagged `[archive-ready: YYYY-MM-DD]` lingers more than `stale_after_days` (default 7) past that date. The tag is the ONLY archival signal — the guard never guesses archivability from a free-text ✅/shipped/FIXED, because the 2026-07-20 reconciliation ([`docs/verification/BACKLOG_RECONCILIATION_2026-07-20.md`](docs/verification/BACKLOG_RECONCILIATION_2026-07-20.md)) proved a heuristic can't safely separate a fully-shipped item from a ✅-with-open-follow-up one, so it never false-fails the many kept ✅-with-follow-up items. (3) The **auto-archive job** clears a staleness failure: `npm run archive:backlog -- --apply` moves tagged items (bullet + indented children) to `BACKLOG_ARCHIVE.md` and ratchets the cap down (default is a dry run). The deeper split-a-shipped-item's-prose-from-its-open-follow-up editorial pass stays deferred as owner-visible judgment work. The cap is **permanently non-increasing** under the 2026-07-30 intake ruling.
- **Guard 7 — Bounded backlog ledger** (`scripts/check-backlog-intake.js`, `npm run check:backlog-intake`): `BACKLOG.md` may never grow in top-level item count or line count, and `config/paper-weight.json` `backlog_max_lines` may never rise above the PR base. Mechanical — three counts, no prose classification, no similarity matching — so no justification text turns it green, and it fails closed when the base cannot be read. Removal, archival, deduplication, promotion, and in-place correction all pass. A NET-NEUTRAL REPLACEMENT is intended bounded intake, not a loophole: the guard cannot tell whether the removed content was genuinely fixed, stale, duplicated, rejected, or promoted, so exact-head review plus the merge card's added/removed/counts declaration carry that check. Self-tests: `test/backlogIntakeGuard.test.js`.

## Campaign execution loop

1. Verify current `main`, a clean worktree, prerequisites, and deployment when relevant.
2. Read the first eligible unfinished card in `docs/ATLAS_V1_EXECUTION_PLAN.md`.
3. Run the Current-State Verification Gate.
4. Create a fresh `agent/<concern>` branch from current `main`.
5. Implement one concern only.
6. Run focused tests plus every applicable build/test/lint/wiring/secret/E2E/trust check.
7. Inspect the diff, commits, secrets, and unrelated drift.
8. Open one PR with the Atlas Merge Card and one primary risk label.
9. Obtain the Atlas Contract / Systems Review when a trigger fires, and record it in the merge card.
10. Address real in-scope advisory findings without expanding the PR.
11. Merge the exact head after every hard gate passes and no owner authorization remains outstanding.
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

### Finding disposition (owner ruling 2026-07-30, final form 2026-07-31 — bounded backlog ledger)

`BACKLOG.md` is a **bounded, actively consumed evidence ledger** of proven deferred work. It preserves findings; it never selects work, authorizes a PR, or competes with the execution plan, and GitHub Issues are not a parallel backlog. Every new finding takes exactly one disposition:

1. **FIX NOW** — fix and test it in the current PR.
2. **REJECT** — record the rejection and a short rationale in the PR discussion.
3. **ADD TO BOUNDED BACKLOG** — record it in `BACKLOG.md` under the fixed-capacity rule below.
4. **OWNER DECISION REQUIRED** — stop and report it to the owner.

Advisory findings do not automatically become work.

**Qualification.** An item enters the backlog only when current-state verification proves it is real, it has concrete user or system impact, it is outside this PR's one concern or genuinely blocked, and preserving it beats preserving at least one older item. Each new or materially reviewed item states compactly: classification (`trust-critical` / `correctness` / `polish` / `housekeeping`), status (`READY` / `BLOCKED` / `OWNER DECISION`), impact, evidence or reproduction, acceptance criteria, reason not fixed now, and a next review trigger (dependency, phase, or date). A few lines, not a template.

**Fixed capacity.** `BACKLOG.md` may never grow in top-level item count, total line count, or `backlog_max_lines`. Adding an item means archiving, rejecting, resolving, deduplicating, or promoting enough existing content to keep all three flat or falling — and the removed content must genuinely be fixed, stale, duplicated, rejected, archived, or promoted into the plan. **Never delete a valuable item just to make room**, and never raise the cap. A net-neutral replacement is the intended operation, not a loophole: Drift Guard 7 checks the counts, while review and the merge card check that the removal was honest. A PR adding an item names the added item, the removed one, and the resulting counts.

**Consumption.** The plan's Bounded Backlog Review protocol runs at every phase boundary, and before discretionary or overnight work when the recorded review is more than seven days old: up to 20 items, each given FIX NOW / PROMOTE / KEEP BLOCKED / ARCHIVE-REJECT, at most two fixes per cycle. This policy is locked for four completed review cycles.

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

The approved active implementation agent merges when:

- every applicable required GitHub check passed on the exact current head;
- no genuine P0/P1, invariant, trust-loop, schema, security, secret, or write-safety problem remains;
- real advisory findings are addressed;
- one-concern scope, branch hygiene, risk label, Vision Alignment Check, and merge card are complete;
- the Atlas Contract / Systems Review is recorded in the merge card when a trigger above fires, and it read the exact merged head;
- the PR is authorized by the campaign or explicit owner instruction; and
- no owner-reserved authorization remains outstanding.

Prefer GitHub auto-merge when available; otherwise merge the exact head SHA directly.

**Merge policy.** Every PR merges automatically under standing authority once all GitHub checks are green — the owner never clicks approve on any PR, including a governance PR. Owner-reserved items are gates (live-test workouts, dictated rulings, production setting changes), never merge approvals. The runtime preview → approve → write loop is unchanged and remains the data safety net.

## Standing command — Atlas Recovery Campaign

When the owner says **"execute Atlas Recovery Plan"** — or any clear variant such as "run the recovery plan" or "continue the recovery" — read the campaign in `docs/ATLAS_V1_EXECUTION_PLAN.md`, find the `CAMPAIGN STATE` block, and execute the next eligible step(s) of the current phase:

- one concern per PR;
- merge on green checks (no owner merge approval);
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

- a second database or storage migration, **other than** the owner-authorized Supabase hot-path migration recorded in the execution plan (2026-08-07). That migration is bounded to seven named concepts and four PRs; it authorizes no other store and no widening of its own scope;
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
