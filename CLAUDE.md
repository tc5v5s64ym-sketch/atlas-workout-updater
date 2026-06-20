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
- If CODEX Review returns `BLOCKING` and the finding is in scope for the current PR, Claude Code fixes only that finding, pushes updates, and stops again.
- If CODEX Review finds future-scope work, Claude Code must not build it inside the current PR; add it to `BACKLOG.md` or an issue and stop.
- Merges happen once a PR is merge-ready (GitHub checks green, reviews passed, CODEX Review `READY FOR OWNER MERGE` or `NON-BLOCKING`). Under the automation-first workflow Claude Code holds full merge authority and merges merge-ready PRs (`docs/AUTOMATION_PROTOCOL.md`); Dale can merge directly or revoke that authority at any time.

See `docs/AGENT_WORKFLOW.md` for the full workflow.

---

## Branch strategy

- Develop on the branch specified in your task brief (typically prefixed `claude/`).
- Never push directly to `main`.
- PRs must be tiny — one concern per PR (see Invariant PR1).

---

## Before you write any code

Before implementing any roadmap, backlog, or GitHub issue fix, perform the `Current-State Verification Gate` in `docs/AGENT_WORKFLOW.md`. Do not begin implementation only because an item exists in `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, or GitHub. First verify whether the failure still exists in the current repo and report the required verdict/evidence.

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

But if the fix needs you to edit a write-path or critical file that your named scope did NOT include — index.js (log/write path, test_mode + proof fields, row enrichment & append), public/app.js (the preview→approve→write trust loop), services/workoutTextParser.js (the slash-notation parser), or anything on the "Critical behaviours — never change without owner approval" list — STOP and flag it as a question before editing. Do not proceed and report afterward, even if the change looks safe. If a task is meant to touch one of these files, it will be named in your scope.

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

---

## Coaching voice (LLM)

Atlas's deterministic engine owns every number; the LLM only ever *words* facts and *answers questions* — it never writes, and never invents numbers.

- **Provider selection** (`services/vision.js`, `getProviderConfig`): `ATLAS_LLM_PROVIDER` (`openai` default, or `gemini`) + `GEMINI_API_KEY` / `OPENAI_API_KEY` + optional `ATLAS_LLM_MODEL`. `gemini` with no key throws — never a silent fallback.
- **`services/coach.js`** — the Gemini coaching voice (separate `GEMINI_COACH_MODEL`, defaults to `gemini-2.5-flash-lite`). Three read-only voices: set reaction, plan "why today", and free-form chat. All degrade to `null`/templated copy when Gemini is down.
- **Read-only endpoints**: `POST /api/coach/message` (set/plan narration), `POST /api/coach/chat` (two-way Q&A grounded in a training snapshot). Neither touches Google Sheets. Both are `writeCapable:false` in `config/routes.js`.
- **Frontend**: `public/coach-conversation.js` types the replies (visual layer); `public/chat.js` paints user bubbles. Neither calls a write path — the trust loop stays in `public/app.js`.

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

## Model Recommendation Gate

Before implementing any PR, the pre-coding report must include:

- **Recommended model** — Sonnet 4.6 or Opus 4.8
- **One-line reason**
- **Risk level** — low / medium / high

| Model | Use when |
|---|---|
| Sonnet 4.6 | Mechanical, docs-only, pure-data, low-risk refactor, isolated tests, no behavior change |
| Opus 4.8 | Behavior-changing, correctness-sensitive, trust-path, parser / session-state / write-path / recommendation logic, or anything that could silently corrupt workout data |

**The model recommendation is required on every PR's merge card.** Stop for owner confirmation of the model only when the work meets an owner check-in criterion (`docs/OWNER_CHECKIN_RULES.md`) — in particular a model-recommendation change, or trust / write-path / approval-gate / coach / roadmap-sensitive work. For automation-safe work (no check-in criterion met), report the recommendation on the merge card and proceed.

This is a workflow gate only. Do not change any app model, LLM behavior, API model, prompt model, or runtime model.
