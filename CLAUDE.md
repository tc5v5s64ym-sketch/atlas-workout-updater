# Atlas — AI Agent Operating Brief

This file is the first thing an AI agent (Claude Code, Codex, or any other) should read before touching this repository.

---

## What this repo is

Atlas is a personal workout logging assistant for one owner (Dale). It parses natural-language gym input, previews rows, and writes to Google Sheets on explicit approval. There is no database — Google Sheets is the permanent record.

Read `docs/GOVERNANCE.md` to understand how Dream, Vision, Constitution, Roadmap, and Backlog relate and where to file new ideas from owner conversations.
Read `docs/CONSTITUTION.md` for mission and scope.
Read `docs/INVARIANTS.md` for rules that must never be broken.
Read `docs/DOCS_INDEX.md` to understand which docs are active, reference-only, historical, or archived.
Read `docs/AGENT_WORKFLOW.md` to understand the Dale + ChatGPT + Claude Code + CODEX Review + GitHub workflow.

---

## Backlog discipline

`BACKLOG.md` (repo root) is the single source of truth for open and deferred work.

- At the start of any work session, read `BACKLOG.md`.
- If selecting or executing the next roadmap PR, also read `docs/ACTIVE_ROADMAP.md` before changing direction.
- Do not follow older plan docs as active execution queues unless `BACKLOG.md` or `docs/ACTIVE_ROADMAP.md` explicitly links that step.
- Whenever you defer a task, discover a follow-up, or decide something is out of scope, append it to `BACKLOG.md` in the same PR — never rely on memory or chat history to carry it.
- When an item ships, mark it done or remove it in the same PR.
- When the owner brainstorms a meaningful product, strategy, or build idea in conversation, consult `docs/GOVERNANCE.md` to identify the correct layer and place the idea there in the same PR — do not leave it only in chat history.

---

## Agent review workflow

Atlas uses GitHub as the handoff bus.

- Claude Code implements one concern per PR and opens the PR. Under the automation-first workflow (`docs/AUTOMATION_PROTOCOL.md`) it then proceeds autonomously — building, testing, running review, classifying risk, and producing the merge card — and stops for the owner only when an owner check-in criterion is met (`docs/OWNER_CHECKIN_RULES.md`).
- Claude Code Review checks code-level correctness when enabled.
- CODEX Review checks roadmap fit, scope creep, Atlas trust contract, live-path test coverage, write-path/schema safety, and accidental future-PR work.
- If CODEX Review returns `BLOCKING` and the finding is in scope for the current PR, Claude Code fixes only that finding, pushes updates, re-runs tests/review, and continues — it does not stop unless an owner check-in criterion applies (`docs/OWNER_CHECKIN_RULES.md`).
- If CODEX Review finds future-scope work, Claude Code must not build it inside the current PR; it files the item in `BACKLOG.md` or an issue and continues (filing future scope is not a stop).
- Merges happen once a PR is merge-ready (GitHub checks green, reviews passed, CODEX Review `READY FOR OWNER MERGE` or `NON-BLOCKING`). Under the automation-first workflow Claude Code holds full merge authority and merges merge-ready PRs (`docs/AUTOMATION_PROTOCOL.md`); Dale can merge directly or revoke that authority at any time.

See `docs/AGENT_WORKFLOW.md` for the full workflow.

---

## Decision routing — PM authority first, then Codex; the owner only for the reserved four

**Escalation Policy v3 (`docs/OWNER_CHECKIN_RULES.md`) is authoritative.** The owner is pulled in **only when human judgment or live testing is genuinely required.** Reduce escalations to the minimum; the default is to continue shipping. Do **not** escalate simply because a change touches the coach surface, coach wording, coach rendering, frontend, or UX — if the correct behavior is derivable from governance (Vision / Dream / `docs/ACTIVE_ROADMAP.md` / `docs/DECISION_KERNEL.md` / Constitution / Invariants / `docs/AUTOMATION_PROTOCOL.md`), decide autonomously and proceed.

1. **Pre-authorized — decide and proceed (Atlas PM authority).** If the answer is derivable from `CLAUDE.md` / `docs/CONSTITUTION.md` / `docs/INVARIANTS.md` / `docs/ACTIVE_ROADMAP.md` / `docs/DECISION_ROUTING.md` / `docs/OWNER_CHECKIN_RULES.md` / previously accepted Atlas behavior / the trust-contract rules, you **make the call and keep going** — no owner, no Codex panel. This explicitly includes: root-cause analysis, implementation selection, PR sizing, test design, regression strategy, refactors, parser-routing clearly derivable from principles, and **whether to fix a bug whose behavior clearly violates an Atlas principle** (deterministically-loggable input must not route to the coach; valid gym language must be loggable; the trust path must not silently discard user intent).
2. **Decision Desk (not the owner)** — only a **genuinely non-derivable** fork the docs do not settle (and that is not owner-reserved). For an inline PR decision *panel*, post `## 🧭 Codex Decision Request`; for a standalone **owner-gated/ambiguous implementation decision**, open an **Atlas Decision Desk issue** (label `atlas-decision-desk` + `needs-pm-decision`, the "🧭 Atlas Decision Desk" template) — the desk answers `APPROVED` / `REJECTED` / `SPLIT` / `ESCALATE-TO-OWNER` from the docs and you proceed on the verdict (`docs/DECISION_ROUTING.md`). A panel whose answer is derivable is **not** a panel — resolve it under PM authority.
3. **Owner — only the four reserved categories** (`docs/OWNER_CHECKIN_RULES.md`, Escalation Policy v3): (1) a live test only the owner can perform (owner-initiated); (2) a change to product vision, **coaching philosophy**, or new product scope (new capability/workflow/logging model/trust contract, or app/runtime model selection); (3) destructive or irreversible operations (schema, migrations, deletion, credentials, security-sensitive infrastructure); (4) a genuine, unresolvable principle conflict with no precedent. Coach **wording/rendering/UX** is **not** reserved when derivable — that is PM authority. When uncertain, document the reasoning, cite the governing docs, make the smallest safe decision, and continue.

**Bug loop:** investigate → root cause → smallest safe fix → check Atlas principles → build → test → open PR → merge if automation rules authorize it; request only a **live validation test** afterward. Do not stop to ask unless a reserved category triggers.

This governs *who decides*. It does **not** relax the absolute data-safety rules: no real Sheets write without explicit owner approval, the preview→approve→write trust loop, and the proof fields are unchanged. PM authority never authorizes a real production write, a data migration, or an INVARIANT/Constitution amendment.

---

## Branch strategy

- Develop on the branch specified in your task brief (typically prefixed `claude/`).
- Never push directly to `main`.
- PRs must be tiny — one concern per PR (see Invariant PR1).

---

## Before you write any code

Before implementing any roadmap, backlog, or GitHub issue fix, perform the `Current-State Verification Gate` in `docs/AGENT_WORKFLOW.md`. Do not begin implementation only because an item exists in `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, or GitHub. First verify whether the failure still exists in the current repo and report the required verdict/evidence.

**If the task is a `Bug_Reports` row (a `BUG-…` id), read `docs/BUG_TRIAGE_LEDGER.md` FIRST.** The Google Sheet has no resolved/open column, so a fixed bug looks identical to an open one — the ledger is the shared done-vs-open record that stops two sessions from re-fixing the same bug. Confirm status there (and `git log --all --grep='BUG-…'`) before touching code, then still run the verification gate. When you ship a fix, cite the `BUG-…` id in the commit and update the ledger in the same PR.

1. Check `config/routes.js` — if you are adding a route, add it here too.
2. Check `docs/INVARIANTS.md` — if your change touches the parser, sheet writes, auth, or undo flow, re-read the relevant invariant group first.
3. Check existing tests in `test/api-smoke.test.js` — the stubs pattern matters (see Invariants T1–T3).

---

## Critical behaviours — never change without owner approval

| Behaviour | Where |
|---|---|
| Slash notation: `225 5/2` = 225 lb × 5 reps @ RIR 2 | `services/workoutTextParser.js` |
| `test_mode` absent = live write | `index.js` log-workout handler |
| Dry-run proof fields: `sheet_written:false`, `no_write_confirmed:true` | `index.js` |
| Live-write proof fields: `sheet_write:'success'`, `log_rows_written>0` | `index.js` |
| Undo read-back: missing/empty row = 409 | `index.js` undo-last handler |
| Log tab restriction in undo | `index.js` undo-last handler |
| Deload = predefined protocol, not invented numbers; AI decides *if*, engine decides *what* | `docs/DELOAD_SPEC.md` |

---

## Scope discipline for agents
A task prompt names the file(s) you should work in. If a fix needs a small edit to an ordinary file outside that list — e.g. wiring a new helper into its one call site — you may make it without asking.

The high-risk files — index.js (log/write path, test_mode + proof fields, row enrichment & append), src/app/app.js (the preview→approve→write trust loop; committed source since PR-22 — `public/` is gitignored build output, see docs/ARCHITECTURE.md), services/workoutTextParser.js (the slash-notation parser) — may be worked **only when the active roadmap/backlog item explicitly requires it** (owner standing instruction). When you do, treat them as high-risk: a tiny PR, a focused diff, tests, and **stop if the change starts spreading** beyond what the item names. Then report.

The deep behaviors on the "Critical behaviours — never change without owner approval" list are still owner-gated regardless: do not change `test_mode`/proof-field semantics, the preview→approve→write trust loop, the slash-notation contract, or the undo flow without explicit owner approval (`docs/OWNER_CHECKIN_RULES.md` criteria 2/3). Editing these files to wire an item the roadmap names is allowed under discipline; silently changing what they *do* on the write/trust path is not.

---

## 12-column row contract

Every row written to `Log_Cleaned` must have exactly these columns in this order:

```
date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code | set_number | weight | reps | rir | notes | volume_calc
```

Do not add, remove, or reorder columns without a schema migration and explicit owner approval.

### Effort tab (9 columns)

Apple Watch / session effort rows written by `/api/complete-workout` go to the `Effort` tab in this order:

```
date | session_id | duration | active_calories | total_calories | average_hr | peak_hr | location | notes
```

`average_hr` and `peak_hr` are distinct metrics — never copy one into the other (see Invariant / the vision prompt in `services/vision.js`). These columns feed the recovery curve via `effortIntensityBySession()` in `services/analytics.js`.

### Constraints tab (5 columns)

Structured, approved training rules written by `POST /api/constraints` go to the `Constraints` tab in this order:

```
date | kind | target | rule | note
```

`kind` ∈ `injury | equipment | preference`; `rule` ∈ `avoid | limit | substitute`; `target` is the movement/pattern/equipment (≤100 chars); `note` is optional context (≤200 chars). This is a *typed* sibling of the free-text `Coaching_Notes` tab — both coexist. The vocabularies are pinned in `config/columns.js` (`constraintsColumns`) and validated in both the write route and `sanitizeConstraint()` (`services/coach.js`). The tab is optional (`config/sheetContract.js`); the write route returns 503 until it exists.

### Deload_State tab (7 columns)

The deload system's persisted training state (`docs/DELOAD_SPEC.md`, "DELOAD STATE") lives in the `Deload_State` tab in this order:

```
updated_at | training_state | deload_protocol | deload_reason | deload_start_date | deload_sessions_remaining | deload_exit_criteria
```

**Append-only**: each state change appends a row; the current state is the *last* row (keeps an audit trail). Read/written by `services/deloadState.js`, never by hand. These are **system-state writes, not logged sets** — they do NOT route through the preview→approve→write trust loop, carry no `write_id`, and never touch `Log_Cleaned`/`Effort`. Same schema-migration rule as the other tabs: do not add, remove, or reorder columns without explicit owner approval.

### Session_Plans tab (13 columns)

The durable, **event-sourced** record of accepted/final plan state (Decision Desk #952, owner-approved Option A) — the data layer that unblocks the drift detector's `skipped_pattern_streak` / `plan_deviation` kinds. Columns in this order:

```
idempotency_key | session_id | session_date | plan_version | event_type | plan_item_id | planned_order | planned_lift_code | movement_pattern | outcome | performed_lift_code | closeout_status | recorded_at
```

**Append-only, never mutated.** Three event types (`event_type`, frozen): `plan_accepted` (one row per accepted planned item, `outcome='planned'`), `item_outcome` (an item's final `outcome` ∈ `completed | skipped | substituted`; `performed_lift_code` set only when `substituted`), `session_closeout` (session-level `closeout_status`). `outcome` is frozen to `planned | completed | skipped | substituted`. The reader folds by `(session_id + plan_version + plan_item_id)`, last-wins. Every event carries a deterministic `idempotency_key` (a hash of the event's semantic identity, never the timestamp) so retries collapse. **Canonical lift CODES only** (`planned_lift_code` / `performed_lift_code`) — never free-text lift identity as the contract. **No loads, reps, target RIR, or progression data** in this version. Rows are built by `services/sessionPlanEvents.js` (pure); the writer (`services/sessionPlanStore.js`) and its live capture wiring land in later PRs. Like the other typed tabs it is **optional** (`config/sheetContract.js`) — the future write route returns 503 until the tab exists — and these are **system-state writes, not logged sets**: no `write_id`, never through the preview→approve→write trust loop, never touching `Log_Cleaned`/`Effort`. Same schema-migration rule: do not add, remove, or reorder columns without explicit owner approval.

---

## Coaching voice (LLM)

Atlas's deterministic engine owns every number; the LLM only ever *words* facts and *answers questions* — it never writes, and never invents numbers.

- **Provider selection** (`services/vision.js`, `getProviderConfig`): `ATLAS_LLM_PROVIDER` (`openai` default, or `gemini`) + `GEMINI_API_KEY` / `OPENAI_API_KEY` + optional `ATLAS_LLM_MODEL`. `gemini` with no key throws — never a silent fallback.
- **`services/coach.js`** — the Gemini coaching voice (separate `GEMINI_COACH_MODEL`, defaults to `gemini-2.5-flash-lite`). Three read-only voices: set reaction, plan "why today", and free-form chat. All degrade to `null`/templated copy when Gemini is down.
- **Read-only endpoints**: `POST /api/coach/message` (set/plan narration), `POST /api/coach/chat` (two-way Q&A grounded in a training snapshot). Neither touches Google Sheets. Both are `writeCapable:false` in `config/routes.js`.
- **Frontend**: `src/app/coach-conversation.js` types the replies (visual layer); `src/app/chat.js` paints user bubbles. Neither calls a write path — the trust loop stays in `src/app/app.js`.

When adding to the coach: forward only whitelisted fields to the model (see `sanitizeFacts` / `sanitizeChatContext`), never raw client objects.

---

## Test suite

```bash
npm test
```

Tests use `require.cache` injection to stub `sheets.js` before the Express app loads. Never replace this with a mocking library without reviewing the injection pattern first — the stub must capture the destructured function references that `index.js` grabs at load time.

---

## What not to build

Unless the owner explicitly requests it, do not add:

- Nutrition tracking
- Voice interface
- Multi-user support (not this phase — see "The Dream" in `docs/ATLAS_PRODUCT_VISION.md` for where Atlas may eventually grow)
- A secondary database (SQLite, Postgres, etc.)
- An "Atlas Brain" autonomous agent mode
- A Dashboard tab restoration
- Big refactors "to clean things up"

When in doubt, do less and ask.

---

## Atlas PR Execution Contract

Every PR must follow these rules without exception:

- **One concern per PR.** Tiny PRs only. If a fix expands into two concerns, split it.
- **Deterministic logic first.** Build the engine, data, or service layer before adding any LLM voice or coaching wording.
- **LLM wording second.** The LLM only words facts the engine already emits. It never invents numbers, verdicts, or rules.
- **Read existing code before changing it.** Understand what is there. Do not assume.
- **If a premise is wrong, stop and report with evidence.** Do not work around a false assumption. Surface it.
- **Do not build future roadmap steps early.** Implement only what the current PR scope names.
- **Do not refactor unrelated systems.** Fix only what is broken or in scope.
- **Future discoveries go to `BACKLOG.md`.** Never carry them in memory or chat history. Append them in the same PR.
- **Never self-author a PR from a review note.** A non-blocking review observation or follow-up idea becomes a backlog line **in the next authorized PR**, or a "want me to file this?" to the owner — it is **never** grounds to open a new unprompted PR. Agents do not spin up their own PRs from their own (or a reviewer's) notes; that is silent-momentum drift. Capture, then wait for an authorized scope to carry it.
- **Stop for the owner only when an owner check-in criterion is met** (`docs/OWNER_CHECKIN_RULES.md`). Atlas is automation-first (`docs/AUTOMATION_PROTOCOL.md`): open the PR, run tests and review, classify risk, and generate the merge card. If no check-in criterion applies and the PR is merge-ready, merge it and proceed to the next approved task without blocking on the owner. Claude Code holds **full merge authority** under this automation-first workflow (`docs/AUTOMATION_PROTOCOL.md`); keep going until the owner says stop.

---

## Investigation Reporting

When investigating bugs, reviewing code, or preparing a PR:

- **Investigate silently.** Read files, trace logic, grep for patterns.
- **Do not stream file-by-file narration.** Do not narrate speculative reasoning mid-investigation.
- **Report findings, evidence, blockers, and decisions.** Not the investigation process.

For debugging, code review, or prep work, the report must include only:

- root cause
- affected files
- fix
- tests
- deferred items
- blockers, if any

Architecture reviews, audits, roadmap planning, and owner-requested analysis may include higher-level tradeoffs.

---

## gstack Workflow

Atlas follows the gstack sprint philosophy: **Think → Plan → Build → Review → Test → Ship → Reflect**.

Install gstack once (if not already present):
```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
```

**Atlas governance always takes precedence.** In cases of conflict, follow `CLAUDE.md`, `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, owner decisions, and Atlas trust-first development principles. Use gstack to improve thinking and review quality — not to replace Atlas governance.

**Installation location:** gstack is installed locally at `C:\Users\manda\.claude\skills\gstack` (Windows). In cloud/remote sessions the skills may not be available — check with `ls ~/.claude/skills/gstack` before invoking any skill. If unavailable, follow the gstack methodology manually and note "skills unavailable" in the merge card gstack section.

### Web browsing

**Always use the `/browse` skill from gstack for all web browsing.** Never use `mcp__claude-in-chrome__*` tools directly — they are superseded by `/browse`.

### Available gstack skills

| Skill | Purpose |
|---|---|
| `/browse` | Web browsing — open URLs, navigate pages, extract content |
| `/investigate` | Systematic root-cause debugging |
| `/plan-eng-review` | Architecture lock-in: data flow, edge cases, test planning |
| `/spec` | Turn vague intent into precise executable specs |
| `/review` | Pre-landing PR review |
| `/qa` | Systematic browser QA |
| `/ship` | Complete release workflow |
| `/careful` | Safety guardrails for irreversible operations |
| `/cso` | Infrastructure-first security audit |

### Command reference

The table below covers gstack commands applicable to the Atlas development workflow. Full documentation: https://github.com/garrytan/gstack

| Command | Official purpose | Typical use cases | Atlas-specific examples | Consider when | Generally skip when |
|---|---|---|---|---|---|
| `/investigate` | Systematic root-cause debugging. Iron law: no fixes without root cause first. 3-strike rule before escalating. | Unknown bugs, regressions, unexpected behavior | Parser routes valid gym input to coach; proof fields missing from response; undo returns 409 unexpectedly | Root cause is unclear; first hypothesis already failed | Cause is already known; fix is an obvious one-liner |
| `/plan-eng-review` | Architecture lock-in: data flow diagrams, edge cases, test planning, performance. Interactive walkthrough. | New service, new route, new data model, major refactor | New analytics endpoint; new tab in the sheet contract; multi-step deload state machine | Adding a new service, refactoring the write path, or touching the schema | Trivial single-file fix; docs-only PR |
| `/spec` | Turn vague intent into precise executable specs. Files GitHub issues. Completeness-scored. | Underspecified backlog items before implementation | Speccing a new constraint kind; speccing the session planning engine | Backlog item is ambiguous and needs design decisions before coding | Item already has a full spec |
| `/review` | Pre-landing PR review. Checks trust boundaries, race conditions, scope drift. Parallel specialist subagents. | Before opening any PR | Review `index.js` write-path changes; verify coach sanitization; check for proof-field drift | Before every non-trivial PR | Docs-only or single-line fix |
| `/qa` | Systematic browser QA: find bugs, atomic-commit fixes, auto-generate regression tests. Three tiers: quick / standard / exhaustive. | User-visible behavior after implementation | Testing the preview→approve→write flow; verifying log tab renders correctly | User-visible behavior changed; frontend touched | No frontend change; pure backend or service logic |
| `/ship` | Complete release workflow: merge base, run tests, bump version, generate changelog, push, open PR. | When ready to open a PR | End-to-end from final commit to PR open | PR involves multiple coordinated steps (test + lint + PR) | Atlas's own PR loop already covers the flow |
| `/careful` | Safety guardrails: warns before `rm -rf`, `DROP TABLE`, force-push, `kubectl delete`. Session-scoped. | Any work near irreversible operations | Schema migrations; sheet tab deletion; undo-flow edits; credential rotation | Any PR touching destructive or irreversible operations | Routine read-only or docs-only work |
| `/cso` | Infrastructure-first security audit: OWASP Top 10, secrets scanning, supply chain. Daily or comprehensive mode. | Security-sensitive PRs | Auth changes; `ATLAS_API_KEY` handling; new external API integration | Security-sensitive or credential-adjacent changes | No auth, security, or credential change |

### Before implementation

1. Evaluate whether one or more gstack commands would improve the task.
2. If appropriate, invoke the command(s).
3. If none are appropriate, decide that explicitly and continue normally.
4. Record the decision using the PR reporting format below.

### PR reporting format

Every implementation PR must include a `gstack` section in the merge card or PR body. This creates an evidence trail showing the decision was made consciously and helps Atlas learn which workflows consistently add value.

**Example A — commands used:**

```
gstack

Commands considered:
* /investigate
* /review

Commands used:
* /investigate
* /review

Why each command was or was not used:
/investigate — root cause was not yet proven; ran first to confirm before writing any fix.
/review — pre-landing review to catch trust-boundary and scope-drift issues before opening.

Key findings:
* Parser ambiguity was confirmed before implementation.
* Added one regression test for an uncovered edge case.

Changes made because of those findings:
* Narrowed fix to the ambiguous token path only.
* Regression test added to test/api-smoke.test.js.
```

**Example B — no commands used:**

```
gstack

Commands considered:
* /review

Commands used:
* None

Why each command was or was not used:
/review — documentation-only change; no implementation, architecture, QA, or production risk.
```

Fields:
- **Commands considered** — every command evaluated, even if rejected.
- **Commands used** — commands actually invoked; `None` if none.
- **Why each command was or was not used** — one line per command: name + reason it was included or skipped.
- **Key findings** — only when a command produced findings worth carrying into the PR; omit if none.
- **Changes made because of those findings** — only when key findings drove concrete changes; omit if none.

---

## Model: Opus 4.8, always — no model check-in

By owner standing instruction, the builder runs on **Opus 4.8 for all work**. There is no model-selection decision and **no owner stop for model**: the merge card records `Opus 4.8` and proceeds. Do not escalate model choice to the owner or to Codex.

(The merge card's "Risk level" field is still filled. The old Sonnet-vs-Opus recommendation gate is retired — Opus is the default for everything.)

This concerns the *builder's* model only. It does **not** change any app model, LLM behavior, API model, prompt model, or runtime model — `services/vision.js` / `services/coach.js` provider and model selection are unchanged and remain owner-gated.
