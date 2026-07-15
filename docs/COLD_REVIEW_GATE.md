# Cold Review Gate (exact-head)

> **Status:** Active. CI enforcement for the exact-head cold-review requirement
> already defined in `docs/AUTOMATION_PROTOCOL.md` §2/§4 and `CLAUDE.md`. This
> doc describes the *mechanism*; it introduces no new policy.

Atlas governance requires that **before any non-trivial PR merges, a fresh
clean-context reviewer reviews the exact current head**, with no unresolved
`P0`/`P1` finding. A review of an older head is **stale**, and a stale, missing,
skipped, or incomplete cold review is a **failure, not a pass**. Until this
workflow, that rule lived only in prose and on the merge card — nothing in CI
checked that the reviewed SHA equalled the head being merged.

The **Cold review gate** (`.github/workflows/cold-review-gate.yml` +
`scripts/cold-review-gate.js`) closes that hole. It maintains a commit status
named **`cold-review/exact-head`** on the PR head SHA.

## How a reviewer records a cold review

After completing a clean-context review of the **exact current head**, a trusted
reviewer posts a PR comment containing this marker:

```
Cold review: PASS
Reviewed head: <full-or-short head SHA>
P0/P1 findings: 0
```

- The three lines can appear anywhere in the comment; surrounding prose,
  blockquotes (`>`), and markdown emphasis (`**…**`) are tolerated.
- `Reviewed head` may be a short SHA (≥ 7 hex chars); it is matched as a prefix
  of the current head.
- **Trust:** only comments whose `author_association` is `OWNER`, `MEMBER`, or
  `COLLABORATOR` are counted. An arbitrary bot or outside comment cannot make the
  gate pass. (A Codex auto-comment is advisory only and never satisfies this
  gate — consistent with `AUTOMATION_PROTOCOL.md`.)
- The **newest** trusted marker wins, so a re-review after a push supersedes an
  earlier one.

### Trivial docs-only exemption

Governance lets **trivial docs-only** typo/status/index PRs merge on
deterministic CI alone. Record that exemption explicitly with:

```
Cold review: N/A (trivial docs-only)
```

This is not automatic from file paths — non-trivial governance/roadmap docs
still require a real cold review — so the exemption is a deliberate, auditable
statement by a trusted reviewer.

## What turns the status red

| Situation | `cold-review/exact-head` |
|---|---|
| No trusted marker on the PR | ❌ failure — "No cold review recorded" |
| Marker cites a SHA that is not the current head (a new commit was pushed) | ❌ failure — "Stale cold review … re-review the new head" |
| Marker reports `P0/P1 findings: N` with N > 0 | ❌ failure — findings must be fixed and re-reviewed |
| `PASS` marker missing the `Reviewed head` or `P0/P1 findings` line | ❌ failure |
| `PASS` marker whose SHA equals the head, 0 findings | ✅ success |
| `N/A (trivial docs-only)` from a trusted reviewer | ✅ success (exempt) |

Because the status is keyed to the head SHA, **pushing a new commit
automatically turns it red** until the new head is reviewed — the freshness
property the protocol requires.

## Why a commit status (not the job conclusion)

The workflow runs on both `pull_request` (to react to new commits) and
`issue_comment` (to react to a marker being posted). An `issue_comment`-triggered
run cannot update a `pull_request`-context check, so the gate is published with
`repos.createCommitStatus` on the head SHA under a fixed context name. The job
itself always succeeds — it succeeds at *maintaining the status*; the status is
the gate.

## Owner action required — make it required

Creating this workflow does **not** by itself block merges. To enforce the gate,
add **`cold-review/exact-head`** to the required status checks for `main` in the
repository's branch protection (owner/admin action). This is intentionally the
only manual step and is owner-reserved.

## Logic and tests

The decision logic is pure and I/O-free in `scripts/cold-review-gate.js`
(`evaluateColdReview`, `parseColdReviewMarker`, `selectLatestMarker`,
`shaMatches`) and unit-tested in `test/cold-review-gate.test.js` (stale review,
untrusted author, findings > 0, missing lines, N/A exemption, newest-marker
precedence, description length cap). The workflow only wires the GitHub API
(resolve head, list comments, publish status) around that module.
