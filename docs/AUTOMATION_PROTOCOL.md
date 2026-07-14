# Atlas Automation Protocol

> **Status:** Active governance contract. Read with
> `docs/AGENT_WORKFLOW.md`, `docs/OWNER_CHECKIN_RULES.md`, and
> `docs/RISK_LABELS.md`. `CLAUDE.md` is the canonical brief.

This protocol defines positive evidence, review separation, and merge authority.
It changes no Atlas application behavior, runtime model, prompt, schema, approval
gate, or write path.

## 1. Roles

### Claude — implementation agent and routine merge operator

- Implements one approved concern per PR after the Current-State Verification
  Gate.
- Uses a fresh `claude/*` or `agent/*` branch from current `origin/main`.
- Tests, classifies risk, opens the PR, completes the merge card, and fixes only
  in-scope blockers.
- Merges only routine PRs after every gate in section 4 passes. Prefer GitHub
  auto-merge when available; otherwise merge directly with the exact reviewed
  head SHA.
- Stops for Dale on owner-reserved PRs.

By owner standing instruction the builder runs on Opus 4.8. That is the standing
builder choice, not a merge gate and not a required CI status check. Atlas
application/runtime/provider/model changes remain separately owner-reserved.

### Cold review — clean-context correctness/safety lane

- Required before any **non-trivial** PR merges. Performed by a fresh Claude
  session, a clean-context reviewer, an isolated subagent, or gstack `/review`.
- The reviewer must not receive the builder conversation or implementation
  reasoning. It receives only the base SHA, the exact final head SHA, the PR
  description, the exact diff, the changed tests, the relevant current
  governance/invariants, and the CI results.
- Read-only review of the exact current PR head for correctness, security,
  regressions, invariants, schema and write safety, trust-loop safety, secrets,
  and live-path test coverage.
- `P0`/`P1` findings block; the builder fixes them. A push after a blocking
  finding requires one fresh cold review of the new head. A stale, missing,
  skipped, or incomplete cold review on a non-trivial PR is a failure.
- Native Codex GitHub Review is retired as a required gate. A Codex auto-comment
  is advisory only and never a substitute for the cold review.

### ChatGPT — product decision desk and risk-triggered Atlas Contract Review

- Reviews roadmap fit, product intent, one-concern scope, Atlas trust, live-path
  fit, write/schema risk, and accidental future work when a PR is
  owner-reserved, high-risk, phase-transitioning, roadmap/vision/coaching or
  trust-contract related, write/schema/security/runtime-model/promotion/
  destructive, or genuinely ambiguous.
- Returns `BLOCKING`, `NON-BLOCKING`, or `READY FOR DALE MERGE`.
- Answers genuinely non-derivable product/scope/trust decisions with Dale.
- Does not replace the cold review.

### GitHub Actions — deterministic CI (hard gates)

- Runs required build (where applicable), tests, lint, wiring check, secret
  scan, applicable E2E, required trust/write/schema tests, and merge-card
  validation.
- Does not parse, publish, or enforce any bot review result as a GitHub status
  check.
- A workflow conclusion is evidence; an agent's claim is not.

### Dale — owner-reserved merge authority

- Owns product direction, owner-reserved decisions, promotion, production-data
  authorization, and owner-reserved merge decisions.
- Is required for owner-only or gym evidence; new product direction, coaching
  philosophy, or scope; schema, migrations, deletion, credentials,
  security-sensitive infrastructure, or production-data risk;
  application/runtime/provider/model changes; One-Brain or other promotion
  decisions; unresolved governance conflicts; and explicit owner holds.

## 2. Pass/fail principle

> A required check or review that was skipped, errored, unavailable, timed out,
> stale, or incomplete is a failure, not a pass.

Positive evidence is required for every signal. Silence, an old-head review, a
cancelled job, a self-reported test result, or the absence of a finding is not a
substitute.

| Signal                        | Pass requirement                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Tests/lint/secret scan/E2E    | applicable required jobs conclude `success`                                                                                             |
| Cold review                   | completed clean-context review of the exact current head with no P0/P1 finding; all actionable review conversations resolved (trivial docs-only PRs are exempt) |
| ChatGPT Atlas Contract Review | explicit `NON-BLOCKING` or `READY FOR DALE MERGE` verdict when risk-triggered; not required for routine PRs settled by active governance |
| Risk classification           | exactly one primary risk label                                                                                                          |
| Merge card                    | present and fully completed                                                                                                             |

Any new push after a blocking cold-review finding invalidates the prior cold
review and requires one fresh cold review of the new head.

## 3. Review lanes are separate

The review lanes answer different questions:

| Lane                          | Primary question                                                                  | Authority                                            |
| ----------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Cold review                   | Is this exact head correct, safe, and trust-preserving?                           | clean-context Claude findings recorded on the PR     |
| ChatGPT Atlas Contract Review | Is this the right Atlas change, at the right scope, preserving roadmap and trust? | external product/contract verdict recorded in the PR |

Neither lane may impersonate or satisfy the other. The implementing session's
own build-time reasoning does not count as a cold review — the cold review must
be clean-context. A clean cold review does not count as Atlas Contract Review.
The cold review is required for every non-trivial PR. ChatGPT Atlas Contract
Review is required only when the risk triggers it.

## 4. Merge authority

A routine PR may be merged by Claude only when all of the following hold:

1. Every applicable required GitHub check passed.
2. The cold review passed for the exact current head (clean-context, no P0/P1,
   all actionable threads resolved) — required for every non-trivial PR; trivial
   docs-only typo/status/index PRs may merge on deterministic CI alone.
3. No P0/P1 finding or unresolved invariant, trust-loop, schema, security, or
   write-safety violation remains.
4. One primary risk label is applied.
5. The merge card and Vision Alignment Check are complete.
6. The branch is one concern, current with `main`, mergeable, and contains no
   unrelated or prior-session commits.
7. The PR matches the active roadmap or an explicit owner instruction.
8. No owner-reserved decision is involved.

Never merge when a required check or the exact-head cold review is missing,
stale, skipped, errored, failed, or incomplete.

When all routine gates pass, Claude must prefer GitHub auto-merge when available.
If auto-merge is unavailable, Claude may merge directly with the exact reviewed
head SHA. After a routine merge, Claude verifies main, confirms deployment when
applicable using read-only evidence, creates a fresh branch, and continues the
next approved concern.

Owner-reserved PRs stop for Dale after the non-owner gates pass. ChatGPT Atlas
Contract Review remains required for those PRs.

### Severity ladder

| Severity | Meaning                                                                                                    | Effect                         |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P0       | data/trust corruption, write/schema/invariant break, critical security or secret exposure                  | blocks                         |
| P1       | user-visible correctness, broken live path, material security issue, missing live-path regression coverage | blocks                         |
| P2       | safe non-blocking correctness/polish                                                                       | defer without expanding the PR |
| P3       | housekeeping/wording                                                                                       | defer without expanding the PR |

No finding may be labeled P2/P3 merely to avoid blocking an actual invariant,
safety, trust, privacy, or acceptance failure. Genuine P2/P3 findings are
recorded in `BACKLOG.md` when authorized and do not force a re-review treadmill.

## 5. Decision boundary

Claude may decide implementation details already derivable from governance:
root cause, smallest safe fix, PR sizing, test design, regression strategy, and
governance-settled wording/rendering. A genuine non-derivable product/scope/trust
fork goes to ChatGPT's Atlas Decision Desk.

Dale is required for:

1. owner-only or gym evidence;
2. product vision, coaching philosophy, new product scope, or application/runtime
   provider/model changes;
3. destructive or irreversible operations, including schema, migrations,
   deletion, credentials, security-sensitive infrastructure, or production-data
   risk;
4. One-Brain or other promotion decisions;
5. a genuine unresolvable conflict between governing principles; and
6. any explicit owner hold.

No decision lane authorizes a real production write, weakens the
preview-to-approve-to-write trust loop, changes proof-field semantics, amends an
invariant/constitution, or grants owner-reserved merge authority.

## 6. Safety and scope remain unchanged

- No real Sheets write without explicit owner approval; dry-runs use
  `test_mode=true` and must prove `sheet_written:false` plus
  `no_write_confirmed:true`.
- No manual Sheet writes by agents; no secrets, production Sheet IDs, private
  evidence, `.env`, credentials, screenshots, or workout data in commits/PRs.
- No schema, approval-gate, parser grammar, progression math, write behavior,
  Render env, or application model change unless explicitly scoped and approved.
- Tests cover the live path or closest integration path.
- One concern per PR. Future work never expands the current PR.

The 2026-07-10 production-verification amendment in
`docs/OWNER_CHECKIN_RULES.md` remains unchanged and narrow: read-only/dry-run by
default; a test-marked, same-session-reverted write only as a last resort; any
data-integrity anomaly stops work and returns control to Dale.

## 7. Relationship to active docs

- `CLAUDE.md` — canonical implementation-agent and safety brief.
- `docs/AGENT_WORKFLOW.md` — current-state, branch, build, review, and handoff
  process.
- `docs/OWNER_CHECKIN_RULES.md` — owner-reserved decisions and data safety.
- `docs/DECISION_ROUTING.md` — ChatGPT Atlas Decision Desk.
- `docs/INVARIANTS.md` and `docs/CONSTITUTION.md` — rules no workflow may relax.
- `.github/PULL_REQUEST_TEMPLATE.md` — merge-card evidence format.

If active governance conflicts, stop and reconcile it in a focused governance
PR. Historical records are not rewritten merely because they describe an older
Codex-era or Claude-era workflow.
