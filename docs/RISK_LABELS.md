# Atlas Risk Classification Labels

> **Status:** Active. Part of the automation contract (`docs/AUTOMATION_PROTOCOL.md`). Applied on every PR as part of the autonomous build loop (`docs/AGENT_WORKFLOW.md`).

Every PR carries **exactly one primary risk label** (the first table below) plus any number of **category labels** (the second table) describing what it touches. Risk classification is a merge-eligibility requirement — a PR with no risk label is not merge-ready.

The canonical machine-readable list lives in `.github/labels.yml`.

---

## Primary risk labels (exactly one per PR)

| Label | Meaning | When applied |
|---|---|---|
| **`auto-safe`** | Claude can take this all the way through routine merge authority without an owner decision. | No owner check-in criterion is met; no P0/P1; required checks green; clean-context cold review green (non-trivial PRs); ChatGPT review not risk-triggered. Docs, infra, test-only, pure-engine-with-coverage, housekeeping. Claude may merge after every gate passes. |
| **`owner-live-test`** | A live app test would be valuable. **Advisory, not a halt** — the owner initiates app tests; the builder flags this and keeps going. | Owner check-in criterion 1 (live app testing) — UI/interaction change, hold point, anything only confirmable on the real app/sheet. Requires a live test script in the merge card. Does not block the loop; the owner calls the hold. |
| **`owner-decision`** | A product/trust/roadmap judgment only the owner can make. | Owner check-in criteria 2–8 (write-path, approval-gate, coach, trust-contract, roadmap/vision, app/runtime-model change, or "cannot determine safety"). |
| **`blocked`** | Not eligible to proceed — a required signal failed, errored, was skipped, or a contract violation is unresolved. | Any failed/errored/skipped required check or review (see `AUTOMATION_PROTOCOL.md` §2), or an open P0/P1 / contract violation. |

> `blocked` overrides the others: if a required signal failed or is missing, the PR is `blocked` regardless of what else is true.

---

## Category labels (zero or more, describe what's touched)

| Label | Meaning / when applied |
|---|---|
| **`trust-sensitive`** | Touches the Atlas trust contract or an `docs/INVARIANTS.md` rule (no blind writes, engine-owns-numbers, owner approves, phantom-set suppression). Implies owner involvement. |
| **`write-path`** | Touches how rows are written to Sheets, `test_mode`/live-write decision, row enrichment/append, or proof fields. `index.js` log/write path, `services/sheets.js` append. Owner-gated. |
| **`approval-path`** | Touches the preview → approve → write trust loop (`src/app/app.js`). Owner-gated. |
| **`coach-behavior`** | Touches what the coach says or how it decides to speak (`services/coach.js`, `services/vision.js`, prompts, sanitizers). Owner-gated. |
| **`parser-behavior`** | Touches `services/workoutTextParser.js` (slash-notation, set extraction, intent). Correctness-sensitive. |
| **`infrastructure`** | CI/workflows, templates, labels, scripts, automation, repo config. No production application behavior change. |

### Workflow label

| Label | Meaning / when applied |
|---|---|
| **`codex-decision`** | Legacy label retained for existing issues/PRs that carried a Claude-era Codex Decision Request. New decisions route to ChatGPT's Atlas Decision Desk (`docs/DECISION_ROUTING.md`) using `atlas-decision-desk` / `needs-pm-decision`. Not a risk classification. |
| **`atlas-decision-desk`** | Applied by the issue template to an evidence packet awaiting external ChatGPT Atlas Decision Desk review. It does not trigger an automated responder. |
| **`needs-pm-decision`** | Marks an Atlas Decision Desk issue as awaiting a ChatGPT/Dale verdict: `APPROVED`, `REJECTED`, `SPLIT`, or `ESCALATE-TO-DALE`. Removed manually when the decision is recorded. |

A single PR can carry several category labels (e.g. a deload-lifecycle wiring PR could be `write-path` + `approval-path` + `trust-sensitive`, with primary `owner-decision`). Category labels make the surface area visible at a glance; the primary label decides who must act.

---

## How classification is decided (builder, in the build loop)

1. Determine the surface touched → apply category labels.
2. Check `docs/OWNER_CHECKIN_RULES.md`:
   - Any criterion 1 met → primary `owner-live-test`.
   - Any criterion 2–8 met → primary `owner-decision`.
   - None met, all required signals green → primary `auto-safe`.
3. If any required check/review failed, errored, was skipped, or a P0/P1 / contract violation is open → primary `blocked` (overrides step 2).
4. Record the primary label and reason on the merge card (`owner action required` field).
5. If the primary label is `auto-safe` and every merge-authority gate passes,
   Claude may merge the routine PR. If the primary label is `owner-decision`,
   `owner-live-test` with an explicit hold, or `blocked`, Claude stops for the
   required owner or failed-signal resolution.

---

## Applying the labels to the repo

The labels are defined in `.github/labels.yml` (human-readable manifest) and created/updated on GitHub automatically by the **Sync labels** workflow (`.github/workflows/labels.yml`), which mirrors that manifest. It runs on `main`, whenever the manifest or workflow changes, on any PR touching them, and on manual dispatch — so the label set always exists.

Category labels are then applied automatically by path via the **Auto-label by path** workflow (`.github/workflows/labeler.yml` + `.github/labeler.yml`). The **primary** risk label stays a builder decision recorded on the merge card.

## Enforcement (CI)

The "exactly one primary risk label" rule (`docs/AUTOMATION_PROTOCOL.md` §2) is enforced by the **Risk label gate** (`.github/workflows/risk-label-gate.yml` + `scripts/risk-label-gate.js`). It publishes a **`risk-label/primary`** commit status on the PR head SHA, green iff exactly one of `auto-safe` / `owner-live-test` / `owner-decision` / `blocked` is applied, and re-runs whenever labels change. It is a **separate** blocking check: category auto-labeling (`labeler.yml`) stays non-blocking. Like the cold-review gate, it runs via `pull_request_target` and loads its decision logic only from the protected default branch (never PR-head code); it reads the PR as data (label names via the API). The status is published on `head.sha` (not the job conclusion) because under `pull_request_target` the job's `GITHUB_SHA` is the default-branch commit, so a job-conclusion check would never attach to the PR head that branch protection evaluates. `statuses: write` is its only write scope, and it fails closed. `blocked` counts as a valid single primary label here; whether a `blocked` PR may merge is a separate merge-authority concern, not this gate's. To make it binding, add the **`risk-label/primary`** status check to the `main` required status checks in branch protection (owner action).
