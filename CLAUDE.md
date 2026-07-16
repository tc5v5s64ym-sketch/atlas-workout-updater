# Atlas — Canonical Agent Brief

This is the first file every implementation agent reads. It defines Atlas's operating, safety, branch, review, and merge rules.

The sole active execution campaign is:

- [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md)

`AGENTS.md` and `CODEX.md` are compatibility pointers only. No other roadmap, old plan, audit, proposal, issue, backlog section, or chat prompt may reorder the campaign.

## What Atlas is

Atlas is Dale's conversation-first personal strength coach and workout logger. It parses natural gym language, maintains session truth, previews rows, and writes to Google Sheets only after explicit approval.

- Google Sheets is the permanent V1 record; there is no second database.
- The deterministic engine owns every number and decision.
- The application LLM only words whitelisted facts and answers grounded questions.
- The conversation is the product; other surfaces support it.
- Atlas is single-owner during V1.

## Read order

For routine implementation:

1. `CLAUDE.md`
2. `docs/ATLAS_V1_EXECUTION_PLAN.md`
3. `docs/DECISION_KERNEL.md`
4. `BACKLOG.md` for awareness and deferred discoveries
5. relevant specs, invariants, tests, and evidence ledgers

Read `docs/DOCS_INDEX.md` when classifying a document. Read the full Vision/Architecture only when the active card reaches product direction, architecture, or a genuine conflict.

## Roles and authority

### Dale — owner

Dale owns product direction, real production-data authorization, genuine gym/device evidence, destructive/schema/security decisions, Constitution/Invariant changes, application/runtime/provider/model selection, and One-Brain promotion.

Dale may merge anything or revoke authority, but routine PRs do not wait for him to click merge.

### ChatGPT — project decision desk

ChatGPT helps Dale resolve genuinely non-derivable product/scope/trust forks and performs a risk-triggered Atlas Contract Review for phase transitions, roadmap changes, product/trust-contract changes, write/schema/security/promotion/destructive work, or genuine ambiguity.

It is not a routine merge gate and never authorizes a production write.

### Claude Code — implementation and merge operator

Claude:

- selects the first eligible unfinished campaign card;
- verifies current state before editing;
- implements one concern on a fresh branch;
- tests the live path or closest integration path;
- opens and completes the PR;
- handles real in-scope advisory findings;
- merges the exact passing head under standing authority;
- updates campaign state, refreshes `main`, and continues.

Do not stop merely to report that a routine PR is merge-ready.

### GitHub Actions and Codex

GitHub Actions supplies deterministic hard gates. Required checks that are missing, stale, skipped, errored, timed out, cancelled, incomplete, or failed are failures.

Codex comments are advisory only. Fix real confident in-scope findings; route genuinely ambiguous ones; record false alarms as non-issues. Never create a synthetic review status from bot wording, reactions, or identity.

An optional clean-context review may be used for confidence on higher-risk work. It is not a required status, account, marker, or human sign-off.

## Campaign execution loop

1. Verify current `main`, a clean worktree, prerequisites, and deployment when relevant.
2. Read the first eligible unfinished card in `docs/ATLAS_V1_EXECUTION_PLAN.md`.
3. Run the Current-State Verification Gate.
4. Create a fresh `claude/<concern>` or `agent/<concern>` branch from current `main`.
5. Implement one concern only.
6. Run focused tests plus every applicable build/test/lint/wiring/secret/E2E/trust check.
7. Inspect the diff, commits, secrets, and unrelated drift.
8. Open one PR with the Atlas Merge Card and one primary risk label.
9. Obtain ChatGPT Atlas Contract Review only when risk-triggered.
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

- New work uses `claude/*` or `agent/*` from current `main`.
- One PR equals one concern.
- Never stack later campaign work on an open or merged feature branch.
- Stage only intended files; never include `.env`, credentials, production IDs, private evidence, or unrelated changes.
- Future discoveries go to `BACKLOG.md`; they do not expand the current PR.
- If a fix spreads, split it.
- Do not build later cards early.
- Do not create another roadmap, fix-it document, campaign controller, or giant session prompt.

### High-risk files

These may be touched only when the active card explicitly requires them, with a tiny focused diff and live-path tests:

- `index.js` — write path, `test_mode`, proof fields, enrichment/append orchestration
- `src/app/app.js` — preview → approve → write trust loop and major client state
- `services/workoutTextParser.js` — slash notation and parser grammar

Editing the file is not automatically owner-reserved; changing its protected contract is.

## Merge gate

Claude merges when:

- every applicable required GitHub check passed on the exact current head;
- no genuine P0/P1, invariant, trust-loop, schema, security, secret, or write-safety problem remains;
- real advisory findings are addressed;
- one-concern scope, branch hygiene, risk label, Vision Alignment Check, and merge card are complete;
- the PR is authorized by the campaign or explicit owner instruction; and
- no owner-reserved authorization remains outstanding.

Prefer GitHub auto-merge when available; otherwise merge the exact head SHA directly.

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

No columns may be added, removed, or reordered without a migration and explicit owner approval. `config/columns.js` and the relevant sheet contract are authoritative.

### `Log_Cleaned` — 12 columns

```text
date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code | set_number | weight | reps | rir | notes | volume_calc
```

### `Effort` — 9 columns

```text
date | session_id | duration | active_calories | total_calories | average_hr | peak_hr | location | notes
```

`average_hr` and `peak_hr` are distinct.

### `Constraints` — 5 columns

```text
date | kind | target | rule | note
```

Use the vocabulary and validation in `config/columns.js` and the active reader/writer; do not invent row conventions.

### `Deload_State` — 7 columns

```text
updated_at | training_state | deload_protocol | deload_reason | deload_start_date | deload_sessions_remaining | deload_exit_criteria
```

Append-only system state.

### `Session_Plans` — 13 columns

```text
idempotency_key | session_id | session_date | plan_version | event_type | plan_item_id | planned_order | planned_lift_code | movement_pattern | outcome | performed_lift_code | closeout_status | recorded_at
```

Append-only, deterministic idempotency, canonical lift codes, and plan-item identity. It does not pass through the logged-set preview/write loop.

## Coach/LLM boundary

- Application provider/model selection is owner-reserved.
- Coach endpoints are read-only and never write Sheets.
- Forward only whitelisted, bounded fields through the sanitizer.
- The LLM never invents numbers, verdicts, rules, progress, history, or write claims.
- When the LLM is unavailable, degrade to deterministic templated/null behavior—never a guess.
- Engine-selected safety/recovery/correction modes outrank stylistic voice.

## Testing

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

## What not to build during the V1 campaign

Unless Dale explicitly changes direction, do not add:

- a second database or storage migration;
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

Dale's standing Claude builder preference is Opus 4.8. That is a working preference, not a branch-protection rule, required status, or merge gate, and it does not change Atlas's application LLM.

Optional tools such as gstack may improve investigation/review quality when available. They never replace Atlas governance or create a required paid review lane.

## Fresh-session launcher

> Read `CLAUDE.md` and `docs/ATLAS_V1_EXECUTION_PLAN.md`. Execute the first eligible unfinished card. Verify before editing, use one concern per PR, merge the exact passing head under standing authority, update campaign state, refresh `main`, and continue. Stop only for an explicit owner-reserved gate.

Before implementation, report only:

1. active milestone;
2. next eligible card;
3. current-state verdict;
4. whether code is actually required;
5. any genuine owner gate.
