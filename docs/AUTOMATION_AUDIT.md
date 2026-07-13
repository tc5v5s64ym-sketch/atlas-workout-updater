# Atlas Automation Audit

> **Status:** Historical snapshot of the pre-Codex-cutover automation framework. Not active authority. Current roles, checks, review lanes, and merge rules live in `AGENTS.md`, `docs/AUTOMATION_PROTOCOL.md`, and `docs/AGENT_WORKFLOW.md`.

This audit was taken while establishing the earlier Claude-era automation framework. Its workflow inventory and future-PR recommendations are preserved as history and are not current-state claims. PR #1000 replaced mandatory Claude review with native Codex GitHub Review; the active-governance cutover retired the Claude-backed decision desks.

---

## What exists today

### GitHub Actions workflows

| Workflow | Trigger | What it does | Enforcement |
|---|---|---|---|
| `.github/workflows/ci.yml` | PR, push to `main`, manual | `unit-tests` (lint + `npm test`), `secret-scan` (changed files vs `origin/main`), `e2e-tests` (Playwright, needs unit-tests), `render-smoke-test` (manual / `main` only, Mission Control) | Jobs fail the PR; E2E uploads traces on failure |
| `.github/workflows/claude-code-review.yml` | PR `opened`, `synchronize` | Runs Claude Code Review against the diff with Atlas rules (INVARIANTS, critical behaviours, 12-col/Effort contract, write-path idempotency, trust loop, security) | "Ensure the review actually ran" step **fails the job if the review errored** (bad/expired token, no credits, outage) — already encodes the "skip/error = fail" principle for this signal |
| `.github/workflows/monitoring.yml` | Daily cron (12:00 UTC), manual | Read-only Mission Control smoke test against production; opens/comments a `mission-control-alert` issue on failure | Read-only; alerts only |

### Reviewers / agents

- **Claude Code** — builder (`CLAUDE.md`).
- **Codex / CODEX Review** — contract guard (`CODEX.md`, `docs/AGENT_WORKFLOW.md`). Currently a human-invoked / prompt-driven review role, not a GitHub Action.
- **Claude Code Review** — automated per-PR review via the workflow above.

### Process docs already in place

- `docs/AGENT_WORKFLOW.md` — build loop, CODEX action rules, Current-State Verification Gate, merge gate.
- `CLAUDE.md` / `CODEX.md` — operating briefs and absolute safety rules.
- `docs/INVARIANTS.md`, `docs/CONSTITUTION.md`, `docs/GOVERNANCE.md` — the laws and layering.

### Labels

- Only `mission-control-alert` existed before this framework. The risk-classification labels (`docs/RISK_LABELS.md`, `.github/labels.yml`) are newly defined here as documentation + manifest.

### Branch protection

- Not represented in-repo (GitHub branch-protection settings live in repo config, not version control). The merge gate is currently enforced by convention (`docs/AGENT_WORKFLOW.md` "Merge gate") plus the failing CI/review jobs — **not** by an in-repo, machine-checkable required-status-check list.

---

## What this framework adds (this PR)

- `docs/AUTOMATION_PROTOCOL.md` — the automation contract (roles, pass/fail principle, merge eligibility).
- `docs/OWNER_CHECKIN_RULES.md` — exhaustive owner-required situations.
- `.github/PULL_REQUEST_TEMPLATE.md` — the one-screen merge card standard.
- `docs/RISK_LABELS.md` + `.github/labels.yml` — risk classification vocabulary + manifest.
- `docs/AGENT_WORKFLOW.md` — the Autonomous Build Loop section.
- `CLAUDE.md` — reconciled so the PR Execution Contract and Model Gate match the automation-first posture (no live contradiction with the build loop).

Working enforcement (GitHub Actions, infrastructure only — no app behavior change):

- `.github/workflows/labels.yml` — **Sync labels**: upserts the risk labels onto the repo from the manifest (github-script; no external action). Runs on `main`, on label/workflow change, on touching-PRs, and `workflow_dispatch`.
- `.github/workflows/labeler.yml` + `.github/labeler.yml` — **Auto-label by path**: applies category labels from touched paths (`actions/labeler@v5`, tolerant of not-yet-seeded labels).
- `.github/workflows/merge-card-check.yml` — **Merge card check**: fails a PR whose body is missing the Atlas Merge Card or still contains template placeholders, enforcing `AUTOMATION_PROTOCOL.md` §2.
- `.github/workflows/codex-decision-desk.yml` — **Codex Decision Desk**: when Claude posts a Codex Decision Request, answers every question so the owner is not asked (`docs/DECISION_ROUTING.md`). Reuses the existing `CLAUDE_CODE_OAUTH_TOKEN` subscription — **no new paid API** — with the agent in the Codex contract-guard role; a skipped/errored desk fails the job (not an implicit yes).

No production application behavior, model, prompt, write path, or Sheet schema changed.

---

## Identified gaps / remaining automation PRs

The three `auto-safe` enforcement items (label sync, auto-label by path, merge-card check) were folded into this framework PR and are now live (see above). The remaining items change **repo settings**, so they are **owner-decision** and left as future PRs, filed in `BACKLOG.md`:

1. **Branch-protection / required-checks as code** *(infrastructure, owner-decision)* — encode the merge gate as GitHub branch-protection required status checks (unit-tests, secret-scan, e2e, Claude review, merge-card-check) so "merge-ready" is machine-enforced, not convention. Changes repo settings → owner decision.

2. **CODEX Review as a check** *(infrastructure, owner-decision)* — if/when CODEX Review is automatable, surface its verdict as a required status check so a missing CODEX verdict blocks merge mechanically (today convention-enforced).

> The Sync labels workflow seeds the repo labels; the other workflows assume they exist, so it runs first (on `main` after merge, and on any PR — including this one — that touches the manifest).
