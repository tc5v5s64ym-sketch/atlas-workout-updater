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
deterministic CI alone. Record that exemption explicitly, and — like a PASS — it
must **cite the exact head** so a later non-trivial push invalidates it:

```
Cold review: N/A (trivial docs-only)
Reviewed head: <full-or-short head SHA>
```

This is not automatic from file paths — non-trivial governance/roadmap docs
still require a real cold review — so the exemption is a deliberate, auditable,
head-bound statement by a trusted reviewer. If any commit is pushed after the
exemption, the status goes red until a fresh `N/A` (or a real review) is recorded
for the new head.

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

## Limitations — this is an attestation gate

The gate mechanically enforces **freshness** (reviewed SHA == head), a **trusted
author** (`OWNER`/`MEMBER`/`COLLABORATOR`), and a **self-reported** `P0/P1
findings: 0`. It cannot, by itself, verify:

- **Reviewer independence / clean context.** `CLAUDE.md` requires the cold review
  to come from a fresh clean-context reviewer and forbids reviewing your own PR
  "from inside the same session/context that built it." A trusted *builder*
  identity could still post a `PASS` marker on its own PR — the gate would accept
  it. Independence remains a governance obligation on the reviewer. A follow-up
  (queued in `BACKLOG.md`) can add a reviewer-identity allowlist distinct from the
  builder identity to harden this.
- **Thread resolution.** `AUTOMATION_PROTOCOL.md` §2 also requires all actionable
  review conversations resolved; the gate does not read thread state.

It also assumes **same-repo PRs** (the Atlas norm — `claude/*` / `agent/*`
branches): the status is published on the PR head SHA, which must exist in this
repository.

Treat the marker as a trusted reviewer's **attestation**, backed by these
mechanical freshness/authorship checks — not as proof of the review's substance.

## Logic and tests

The decision logic is pure and I/O-free in `scripts/cold-review-gate.js`
(`evaluateColdReview`, `parseColdReviewMarker`, `selectLatestMarker`,
`shaMatches`) and unit-tested in `test/cold-review-gate.test.js` (stale review,
untrusted author, findings > 0, missing lines, N/A exemption, newest-marker
precedence, description length cap). The workflow only wires the GitHub API
(resolve head, list comments, publish status) around that module.
