# Atlas Risk Classification Labels

> **Status:** Active. Part of the automation contract (`docs/AUTOMATION_PROTOCOL.md`). Applied on every PR as part of the autonomous build loop (`docs/AGENT_WORKFLOW.md`).

Every PR carries **exactly one primary risk label** (the first table below) plus any number of **category labels** (the second table) describing what it touches. Risk classification is a merge-eligibility requirement — a PR with no risk label is not merge-ready.

The canonical machine-readable list lives in `.github/labels.yml`.

---

## Primary risk labels (exactly one per PR)

| Label | Meaning | When applied |
|---|---|---|
| **`auto-safe`** | Automation can take this all the way to merge-ready with no owner involvement. | No owner check-in criterion is met; no P0/P1; tests + reviews green. Docs, infra, test-only, pure-engine-with-coverage, housekeeping. |
| **`owner-live-test`** | Merge-ready in automation, but the owner must drive the live app before merge. | Owner check-in criterion 1 (live app testing) — UI/interaction change, hold point, anything only confirmable on the real app/sheet. Requires a live test script in the merge card. |
| **`owner-decision`** | A product/trust/roadmap/model judgment only the owner can make. | Owner check-in criteria 2–8 (write-path, approval-gate, coach, trust-contract, roadmap/vision, model recommendation, or "cannot determine safety"). |
| **`blocked`** | Not eligible to proceed — a required signal failed, errored, was skipped, or a contract violation is unresolved. | Any failed/errored/skipped required check or review (see `AUTOMATION_PROTOCOL.md` §2), or an open P0/P1 / contract violation. |

> `blocked` overrides the others: if a required signal failed or is missing, the PR is `blocked` regardless of what else is true.

---

## Category labels (zero or more, describe what's touched)

| Label | Meaning / when applied |
|---|---|
| **`trust-sensitive`** | Touches the Atlas trust contract or an `docs/INVARIANTS.md` rule (no blind writes, engine-owns-numbers, owner approves, phantom-set suppression). Implies owner involvement. |
| **`write-path`** | Touches how rows are written to Sheets, `test_mode`/live-write decision, row enrichment/append, or proof fields. `index.js` log/write path, `services/sheets.js` append. Owner-gated. |
| **`approval-path`** | Touches the preview → approve → write trust loop (`public/app.js`). Owner-gated. |
| **`coach-behavior`** | Touches what the coach says or how it decides to speak (`services/coach.js`, `services/vision.js`, prompts, sanitizers). Owner-gated. |
| **`parser-behavior`** | Touches `services/workoutTextParser.js` (slash-notation, set extraction, intent). Correctness-sensitive. |
| **`infrastructure`** | CI/workflows, templates, labels, scripts, automation, repo config. No production application behavior change. |

A single PR can carry several category labels (e.g. a deload-lifecycle wiring PR could be `write-path` + `approval-path` + `trust-sensitive`, with primary `owner-decision`). Category labels make the surface area visible at a glance; the primary label decides who must act.

---

## How classification is decided (builder, in the build loop)

1. Determine the surface touched → apply category labels.
2. Check `docs/OWNER_CHECKIN_RULES.md`:
   - Any criterion 1 met → primary `owner-live-test`.
   - Any criterion 2–8 met → primary `owner-decision`.
   - None met, all signals green → primary `auto-safe`.
3. If any required check/review failed, errored, was skipped, or a P0/P1 / contract violation is open → primary `blocked` (overrides step 2).
4. Record the primary label and reason on the merge card (`owner action required` field).

---

## Applying the labels to the repo

The labels are defined in `.github/labels.yml`. Creating/syncing them on GitHub is a small follow-up automation step (a label-sync workflow) — see `docs/AUTOMATION_AUDIT.md` "Identified gaps / next automation PRs". Until that lands, labels are applied manually or by the builder when opening the PR, using the names above verbatim.
