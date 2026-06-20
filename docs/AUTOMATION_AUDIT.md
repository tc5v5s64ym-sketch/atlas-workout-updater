# Atlas Automation Audit

> **Status:** Active reference. Snapshot of the automation that exists today, what it covers, and the gaps that warrant future automation PRs. Pairs with `docs/AUTOMATION_PROTOCOL.md`.

This audit was taken while establishing the automation framework. It reuses existing mechanisms wherever possible and only names new automation as **future** PRs — none of those are implemented here.

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

- `docs/AGENT_WORKFLOW.md` — build loop, CODEX action rules, Current-State Verification Gate, Model Recommendation Gate, merge gate.
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

All documentation / templates / labels. No production application behavior, model, prompt, workflow logic, or write path changed.

---

## Identified gaps / next automation PRs

Listed as **future** PRs only — not implemented here, per the one-PR scope. Filed in `BACKLOG.md`.

1. **Label sync workflow** *(infrastructure, auto-safe)* — a small Action (e.g. `crazy-max/ghaction-github-labeler` or a `gh label` script) that syncs `.github/labels.yml` to the repo so the risk labels actually exist on GitHub. Highest-leverage next step; everything else assumes the labels exist.

2. **Branch-protection / required-checks as code** *(infrastructure, owner-decision)* — encode the merge gate as GitHub branch-protection required status checks (unit-tests, secret-scan, e2e, Claude review) so "merge-ready" is machine-enforced, not convention. Owner decision because it changes repo settings.

3. **Merge-card completeness check** *(infrastructure, auto-safe)* — a lightweight Action that fails the PR if the merge-card template fields are left as placeholder comments / blank, enforcing `AUTOMATION_PROTOCOL.md` §2 ("empty field = failure").

4. **CODEX Review as a check** *(infrastructure, owner-decision)* — if/when CODEX Review is automatable, surface its verdict as a required status check so a missing CODEX verdict blocks merge mechanically (today it is convention-enforced).

5. **Auto-label by path** *(infrastructure, auto-safe)* — a `labeler`-style Action mapping touched paths to the category labels in `docs/RISK_LABELS.md` (e.g. `public/app.js` → `approval-path`, `services/coach.js` → `coach-behavior`). The primary risk label stays a builder decision.

> Recommended order: (1) label sync first — it unblocks the rest — then (3) merge-card check, (5) auto-label, and finally the owner-decision items (2) and (4).
