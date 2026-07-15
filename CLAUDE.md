# Atlas — AI Agent Operating Brief

This file is the **canonical** implementation-agent brief for Atlas. It is the
first thing an AI agent (Claude Code or any other) should read before touching
this repository. `AGENTS.md` and `CODEX.md` are compatibility pointers to this
file and carry no independent role, review, branch, or merge rules.

---

## What this repo is

Atlas is a personal workout logging assistant for one owner (Dale). It parses
natural-language gym input, previews rows, and writes to Google Sheets on
explicit approval. There is no database — Google Sheets is the permanent record.

Read `docs/GOVERNANCE.md` to understand how Dream, Vision, Constitution,
Roadmap, and Backlog relate and where to file new ideas from owner
conversations.
Read `docs/CONSTITUTION.md` for mission and scope.
Read `docs/INVARIANTS.md` for rules that must never be broken.
Read `docs/DOCS_INDEX.md` to understand which docs are active, reference-only,
historical, or archived.
Read `docs/AGENT_WORKFLOW.md` for the full Dale + ChatGPT + Claude + GitHub
workflow.

---

## Merge authority (owner ruling)

Atlas runs an automation-first workflow. The governing owner ruling (updated by
Dale, 2026-07-15) is:

> Claude Code is the Atlas implementation agent and holds **standing merge
> authority**. Once the deterministic GitHub CI hard gates pass and any Codex
> advisory findings are addressed, Claude **merges its own PRs** — there is no
> owner merge step and no PR waits on Dale to click merge. Codex GitHub Review is
> **advisory**, and Claude auto-fixes what it flags. ChatGPT remains available as
> an **optional** Atlas Contract Review / decision desk for genuinely
> owner-reserved product, trust, schema, security, or roadmap questions — it is
> not a merge gate.

This authority is deliberately broad: **Claude decides and merges.** It is
bounded only by the absolute **data-safety** rules — Claude never authorizes a
real production Sheets write, a data migration/deletion, a credentials/security
change, or an INVARIANT/Constitution amendment without explicit owner approval,
because those touch Dale's real data irreversibly. That is a data-safety
confirmation, **not** a merge bottleneck: it is about protecting real data, never
about making Dale click merge on clean code. Dale can still merge anything himself
or revoke this authority at any time.

This ruling **supersedes** any conflicting merge-authority, cold-review, or
"owner must merge / stop for Dale to merge" language elsewhere in the docs
(`docs/AUTOMATION_PROTOCOL.md`, `docs/AGENT_WORKFLOW.md`,
`docs/OWNER_CHECKIN_RULES.md`, `.github/PULL_REQUEST_TEMPLATE.md`, etc.); those
are being reconciled to match (`BACKLOG.md`).

---

## Roles

### Dale — owner

- Owns product direction and real-data / production-write authorization.
- May request live app or gym validation and is the only authority that can
  resume an explicit owner hold.
- Can merge anything directly and can revoke Claude's merge authority at any
  time, but is **never required to click merge** on a routine PR.

### ChatGPT — Atlas Contract Review and decision desk

- Is Atlas's product decision desk with Dale.
- Performs the external **Atlas Contract Review** when risk-triggered: roadmap
  fit, product intent, one-concern scope, Atlas trust, live-path fit, and
  write/schema risk.
- Returns `BLOCKING`, `NON-BLOCKING`, or `READY FOR DALE MERGE`.
- Is required for owner-reserved, governance, roadmap/phase-transition, product
  scope, coaching-philosophy, trust-contract, write/schema,
  security/credentials, runtime/provider/model, promotion, destructive, and
  genuinely ambiguous changes. Routine settled implementation PRs do not require
  this lane.

### Claude — implementation agent and merge operator

- Runs the Current-State Verification Gate before editing.
- Implements one approved concern on a fresh `claude/<concern>` or
  `agent/<concern>` branch, tests it, opens the PR, completes the merge card, and
  addresses only in-scope blockers.
- **Merges its own PRs** once the CI hard gates pass and Codex advisory findings
  are addressed — preferring GitHub auto-merge, else a direct merge of the exact
  head SHA. No owner merge step.
- Gets explicit owner approval before a genuinely owner-reserved **data-safety**
  item (real production write, data migration/deletion, credentials/security,
  INVARIANT/Constitution amendment) — a data-safety confirmation, not a merge
  hand-off — and never starts adjacent work on the PR branch.

---

## Review and merge model

### Hard gates (deterministic, always required)

Every PR must pass the applicable deterministic GitHub CI checks. A skipped,
errored, unavailable, timed-out, or incomplete required signal is a **failure**,
not a pass. The hard gates are:

- build (where applicable);
- tests;
- lint;
- wiring check;
- secret scan;
- merge-card check;
- applicable E2E; and
- required trust/write/schema tests.

### Review model (advisory, not a required human gate)

Code review is provided by (a) the **Codex GitHub advisory review**, which
comments on every PR and which Claude **auto-fixes** (fix confident/small/in-scope
findings, ask the owner on genuinely ambiguous or architectural ones, skip false
alarms), and (b) an **optional** independent clean-context review Claude may run
for its own confidence on higher-risk changes. Neither is a required human
sign-off, and neither blocks a merge once the CI hard gates have passed. There is
**no cold-review marker requirement**.

When Claude does run its own review and it surfaces a real `P0`/`P1`, Claude fixes
it before merging (the same way it acts on a Codex flag); genuine `P2`/`P3` items
go to `BACKLOG.md`.

> **Cold-review gate — being retired.** The `cold-review/exact-head` attestation
> gate was removed as a governance requirement here. Its workflow stays in the
> repo only until the owner removes `cold-review/exact-head` from the branch
> protection required-status-checks — a repo-admin action Claude cannot perform.
> Until then Claude records the pass marker itself (from its own passing review)
> so merges are never blocked, and deletes the workflow once the required-check
> rule is lifted.

### Native Codex GitHub Review is retired

Native Codex GitHub Review is **no longer a required gate**. `@codex review` is
not a delivery step, and an exact-head Codex review is not a merge-card
requirement. If Codex auto-comments, treat it as **advisory only**. Do not build
any synthetic workflow that parses bot comments, reactions, or wording into a
fake status check.

### Merge-authority gate

Claude merges a PR when all of the following hold:

- every applicable required GitHub check passed (the hard gates above);
- Codex advisory findings are addressed (fixed, or judged non-issues);
- the PR implements one concern authorized by the active roadmap or an explicit
  owner goal;
- one-concern scope, branch hygiene, the risk label, and the merge card are
  complete; and
- it is **not** a genuinely owner-reserved data-safety item (real production
  write, migration/deletion, credentials/security, INVARIANT/Constitution
  amendment) awaiting explicit owner approval.

Never merge when a required check is missing, stale, skipped, errored, or failed.
Prefer GitHub auto-merge; if it is unavailable, merge directly with the exact head
SHA. **Do not stop merely to report that a PR is merge-ready — merge it.** After
merging, verify `origin/main`, confirm deployment when applicable using read-only
evidence, cut a fresh branch from main, and continue the next approved concern.

---

## Escalation policy — PM authority first, then ChatGPT; the owner for reserved categories

**Escalation Policy v3 (`docs/OWNER_CHECKIN_RULES.md`) is authoritative.** The
owner is pulled in **only when human judgment or live testing is genuinely
required.** Reduce escalations to the minimum; the default is to keep shipping.
Do **not** escalate simply because a change touches the coach surface, coach
wording, coach rendering, frontend, or UX — if the correct behavior is derivable
from governance, decide autonomously and proceed.

1. **Pre-authorized — decide and proceed (Atlas PM authority).** If the answer
   is derivable from `CLAUDE.md` / `docs/CONSTITUTION.md` / `docs/INVARIANTS.md`
   / `docs/ACTIVE_ROADMAP.md` / `docs/DECISION_ROUTING.md` /
   `docs/OWNER_CHECKIN_RULES.md` / previously accepted Atlas behavior / the
   trust-contract rules, you **make the call and keep going.** This includes
   root-cause analysis, implementation selection, PR sizing, test design,
   regression strategy, refactors, principle-derivable parser routing, and
   **whether to fix a bug whose behavior clearly violates an Atlas principle.**
2. **Decision Desk (ChatGPT, not the owner)** — only a **genuinely
   non-derivable** product/scope/trust fork the docs do not settle and that is
   not owner-reserved (`docs/DECISION_ROUTING.md`). A fork whose answer is
   derivable is not a fork — resolve it under PM authority.
3. **Owner — the reserved categories** (`docs/OWNER_CHECKIN_RULES.md`): (1) a
   live test only the owner can perform; (2) a change to product vision,
   **coaching philosophy**, or new product scope (new capability/workflow/logging
   model/trust contract, or app/runtime model selection); (3) destructive or
   irreversible operations (schema, migrations, deletion, credentials,
   security-sensitive infrastructure); (4) a genuine, unresolvable principle
   conflict with no precedent. Coach **wording/rendering/UX** is **not** reserved
   when derivable — that is PM authority.

This governs *who decides*. It does **not** relax the absolute data-safety
rules: no real Sheets write without explicit owner approval, the
preview→approve→write trust loop, and the proof fields are unchanged. PM
authority never authorizes a real production write, a data migration, or an
INVARIANT/Constitution amendment.

**Live testing — agent self-serve (standing authorization, 2026-07-14).** When
the owner asks to test the app, do not ask for URLs, keys, or sheet details —
read `docs/AGENT_LIVE_TESTING.md` and the local `.env`, then run the test
yourself. Tier 1 (read-only) and Tier 2 (`test_mode` dry-run) are pre-authorized;
Tier 3 (real sheet writes) only on explicit per-test owner authorization. Always
send a synthetic `x-atlas-request-origin`. This narrows the owner-reserved "live
testing" category: agent-runnable live tests are agent-run by default; only tests
genuinely requiring the owner's real device, real gym session, or first-use
confirmation remain owner-only. GATE A eligible evidence remains owner-only by
provenance design.

---

## Branch strategy

- Develop on the branch named in your task brief. New agent work uses a
  `claude/<concern>` or `agent/<concern>` branch cut from the latest verified
  `origin/main` on a clean worktree.
- Never push directly to `main`.
- One PR equals one concern (Invariant PR1). If a fix spreads, stop and split it.
- Do not stack new roadmap work on an open PR branch. After a PR merges, a later
  concern starts from newly fetched main.

---

## Before you write any code

Before implementing any roadmap, backlog, or GitHub issue fix, perform the
**Current-State Verification Gate** in `docs/AGENT_WORKFLOW.md`. Do not begin
implementation only because an item exists in `BACKLOG.md`,
`docs/ACTIVE_ROADMAP.md`, or GitHub. First verify whether the failure still
exists in the current repo and report exactly one verdict (`STILL BROKEN` /
`ALREADY FIXED` / `PARTIALLY FIXED` / `FIXED BUT UNTESTED` / `STALE / SUPERSEDED`
/ `NEEDS OWNER APP-TEST`) with evidence.

**If the task is a `Bug_Reports` row (a `BUG-…` id), read
`docs/BUG_TRIAGE_LEDGER.md` FIRST.** The Google Sheet has no resolved/open
column, so a fixed bug looks identical to an open one — the ledger is the shared
done-vs-open record. Confirm status there (and `git log --all --grep='BUG-…'`)
before touching code, then still run the verification gate. When you ship a fix,
cite the `BUG-…` id in the commit and update the ledger in the same PR.

1. Check `config/routes.js` — if you are adding a route, add it here too.
2. Check `docs/INVARIANTS.md` — if your change touches the parser, sheet writes,
   auth, or undo flow, re-read the relevant invariant group first.
3. Check existing tests in `test/api-smoke.test.js` — the stubs pattern matters
   (see Invariants T1–T3).

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

A task prompt names the file(s) you should work in. If a fix needs a small edit
to an ordinary file outside that list — e.g. wiring a new helper into its one
call site — you may make it without asking.

The high-risk files — `index.js` (log/write path, `test_mode` + proof fields,
row enrichment & append), `src/app/app.js` (the preview→approve→write trust
loop; committed source since PR-22 — `public/` is gitignored build output, see
`docs/ARCHITECTURE.md`), `services/workoutTextParser.js` (the slash-notation
parser) — may be worked **only when the active roadmap/backlog item explicitly
requires it** (owner standing instruction). When you do, treat them as
high-risk: a tiny PR, a focused diff, tests, and **stop if the change starts
spreading** beyond what the item names. Then report.

The deep behaviors on the "Critical behaviours" list are still owner-gated
regardless: do not change `test_mode`/proof-field semantics, the
preview→approve→write trust loop, the slash-notation contract, or the undo flow
without explicit owner approval. Editing these files to wire an item the roadmap
names is allowed under discipline; silently changing what they *do* on the
write/trust path is not.

---

## Sheet schema contracts

Do not add, remove, or reorder columns without a schema migration and explicit
owner approval.

### `Log_Cleaned` (12 columns)

```
date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code | set_number | weight | reps | rir | notes | volume_calc
```

### `Effort` tab (9 columns)

Apple Watch / session effort rows written by `/api/complete-workout` go to the
`Effort` tab in this order:

```
date | session_id | duration | active_calories | total_calories | average_hr | peak_hr | location | notes
```

`average_hr` and `peak_hr` are distinct metrics — never copy one into the other.
These columns feed the recovery curve via `effortIntensityBySession()` in
`services/analytics.js`.

### `Constraints` tab (5 columns)

```
date | kind | target | rule | note
```

`kind` ∈ `injury | equipment | preference`; `rule` ∈ `avoid | limit |
substitute`; `target` is the movement/pattern/equipment (≤100 chars); `note` is
optional context (≤200 chars). A *typed* sibling of the free-text
`Coaching_Notes` tab — both coexist. Vocabularies are pinned in
`config/columns.js` (`constraintsColumns`) and validated in both the write route
and `sanitizeConstraint()` (`services/coach.js`). The tab is optional
(`config/sheetContract.js`); the write route returns 503 until it exists.

### `Deload_State` tab (7 columns)

```
updated_at | training_state | deload_protocol | deload_reason | deload_start_date | deload_sessions_remaining | deload_exit_criteria
```

**Append-only**: each state change appends a row; the current state is the *last*
row. Read/written by `services/deloadState.js`, never by hand. These are
**system-state writes, not logged sets** — they do NOT route through the
preview→approve→write trust loop, carry no `write_id`, and never touch
`Log_Cleaned`/`Effort`.

### `Session_Plans` tab (13 columns)

```
idempotency_key | session_id | session_date | plan_version | event_type | plan_item_id | planned_order | planned_lift_code | movement_pattern | outcome | performed_lift_code | closeout_status | recorded_at
```

**Append-only, never mutated.** Three frozen event types (`plan_accepted`,
`item_outcome`, `session_closeout`); `outcome` is frozen to `planned | completed
| skipped | substituted`. The reader folds by `(session_id + plan_version +
plan_item_id)`, last-wins. Every event carries a deterministic `idempotency_key`
(a hash of the event's semantic identity, never the timestamp). **Canonical lift
CODES only** (`planned_lift_code` / `performed_lift_code`). Rows are built by
`services/sessionPlanEvents.js` (pure); the writer (`services/sessionPlanStore.js`)
and its live capture wiring land in later PRs. Optional
(`config/sheetContract.js`); system-state writes, not logged sets — no
`write_id`, never through the trust loop, never touching `Log_Cleaned`/`Effort`.

---

## Coaching voice (LLM)

Atlas's deterministic engine owns every number; the LLM only ever *words* facts
and *answers questions* — it never writes, and never invents numbers.

- **Provider selection** (`services/vision.js`, `getProviderConfig`):
  `ATLAS_LLM_PROVIDER` (`openai` default, or `gemini`) + `GEMINI_API_KEY` /
  `OPENAI_API_KEY` + optional `ATLAS_LLM_MODEL`. `gemini` with no key throws —
  never a silent fallback.
- **`services/coach.js`** — the Gemini coaching voice (separate
  `GEMINI_COACH_MODEL`). Three read-only voices: set reaction, plan "why today",
  and free-form chat. All degrade to `null`/templated copy when Gemini is down.
- **Read-only endpoints**: `POST /api/coach/message`, `POST /api/coach/chat`.
  Neither touches Google Sheets. Both are `writeCapable:false` in
  `config/routes.js`.
- **Frontend**: `src/app/coach-conversation.js` types the replies;
  `src/app/chat.js` paints user bubbles. Neither calls a write path — the trust
  loop stays in `src/app/app.js`.

When adding to the coach: forward only whitelisted fields to the model (see
`sanitizeFacts` / `sanitizeChatContext`), never raw client objects.
Application/runtime/provider/model changes remain owner-reserved.

---

## Test suite

```bash
npm test
```

Tests use `require.cache` injection to stub `sheets.js` before the Express app
loads. Never replace this with a mocking library without reviewing the injection
pattern first — the stub must capture the destructured function references that
`index.js` grabs at load time.

---

## Backlog and roadmap discipline

`BACKLOG.md` (repo root) is the single source of truth for open and deferred
work.

- At the start of any work session, read `BACKLOG.md`.
- While `docs/ACTIVE_ROADMAP.md` has eligible work, select from it; do not use
  older plans or backlog entries to jump the queue.
- Whenever you defer a task, discover a follow-up, or decide something is out of
  scope, append it to `BACKLOG.md` in the same PR — never rely on memory or chat
  history to carry it.
- When an item ships, mark it done or remove it in the same PR.
- Do not build future roadmap steps early. If a premise is wrong, stop and
  report with evidence; do not manufacture work.

---

## What not to build

Unless the owner explicitly requests it, do not add:

- Nutrition tracking
- Voice interface
- Multi-user support (not this phase)
- A secondary database (SQLite, Postgres, etc.)
- An "Atlas Brain" autonomous agent mode
- A Dashboard tab restoration
- Big refactors "to clean things up"

When in doubt, do less and ask.

---

## Atlas PR Execution Contract

Every PR must follow these rules without exception:

- **One concern per PR.** Tiny PRs only. If a fix expands into two concerns,
  split it.
- **Deterministic logic first.** Build the engine, data, or service layer before
  adding any LLM voice or coaching wording.
- **LLM wording second.** The LLM only words facts the engine already emits. It
  never invents numbers, verdicts, or rules.
- **Read existing code before changing it.** Understand what is there. Do not
  assume.
- **If a premise is wrong, stop and report with evidence.** Do not work around a
  false assumption. Surface it.
- **Do not build future roadmap steps early.** Implement only what the current
  PR scope names.
- **Do not refactor unrelated systems.**
- **Future discoveries go to `BACKLOG.md`.** Append them in the same PR.
- **Never self-author a PR from a review note.** A non-blocking review
  observation or follow-up idea becomes a backlog line in the next authorized
  PR, or a "want me to file this?" to the owner — it is never grounds to open a
  new unprompted PR.
- **Stop for the owner only when a data-safety reserved category applies** (real
  production write, migration/deletion, credentials/security,
  INVARIANT/Constitution amendment — see the escalation policy above). Otherwise,
  open the PR, run the hard gates, address Codex advisory findings, apply the risk
  label, complete the merge card, and **merge it yourself** without blocking on
  the owner.

---

## Investigation Reporting

When investigating bugs, reviewing code, or preparing a PR:

- **Investigate silently.** Read files, trace logic, grep for patterns.
- **Do not stream file-by-file narration.**
- **Report findings, evidence, blockers, and decisions.** Not the investigation
  process.

For debugging, code review, or prep work, the report must include only: root
cause, affected files, fix, tests, deferred items, and blockers if any.
Architecture reviews, audits, roadmap planning, and owner-requested analysis may
include higher-level tradeoffs.

---

## gstack Workflow

Atlas follows the gstack sprint philosophy: **Think → Plan → Build → Review →
Test → Ship → Reflect**. Use gstack to improve thinking and review quality — not
to replace Atlas governance. **Atlas governance always takes precedence:** in any
conflict, follow `CLAUDE.md`, `BACKLOG.md`, `docs/ACTIVE_ROADMAP.md`, owner
decisions, and Atlas trust-first principles.

In cloud/remote sessions the skills may be unavailable — check with
`ls ~/.claude/skills/gstack` before invoking any skill. If unavailable, follow
the gstack methodology manually and note "skills unavailable" in the merge card
gstack section. `/review` is the gstack cold-review entry point; the cold
reviewer must still run clean-context against the exact final head.

Every implementation PR records a short `gstack` section in the merge card or PR
body listing the commands considered, the commands used (or `None`), and one
line per command on why it was or was not used.

---

## Model: Opus 4.8 is Dale's standing Claude builder choice

By owner standing instruction, the builder runs on **Opus 4.8** for all work.
There is no model-selection decision and no owner stop for model: the merge card
records `Opus 4.8` and proceeds. Opus 4.8 is the standing *builder* choice — it
is **not** a GitHub branch-protection rule or a required CI status check, and it
must not be encoded as one.

This concerns the *builder's* model only. It does **not** change any app model,
LLM behavior, API model, prompt model, or runtime model — `services/vision.js` /
`services/coach.js` provider and model selection are unchanged and remain
owner-gated.
