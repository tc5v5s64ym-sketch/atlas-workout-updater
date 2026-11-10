# Atlas Operating Rules

**The single home for the standing coordination rules of this build.**
Adopted 2026-11-03 (issue #1650; Dale, on the coordinator's recommendation).
Consolidated 2026-11-10 (issue #1698; Sunny, Hammy reviews).

Issue #1650 remains the adoption record. `CLAUDE.md` and `AGENTS.md` point here and
do not restate these rules. Future rule changes land as PRs to this file, plus a
one-line Slack pointer. After this file merges, the coordinator archives the flagged
Slack threads' role as rule homes (the governance #1650 thread and the review-model
thread stay signal-only; direction rides fresh top-level posts).

Consolidation only: no rule here is invented or re-decided. Each rule is stated once,
dated, with its source pointer. Where a later dated adoption supersedes an earlier
form, the current form is stated and the supersession is listed in
[Supersessions applied](#supersessions-applied) at the end. Product rules (merge gate,
safety, branch and scope, testing) live in `CLAUDE.md`; the execution plan selects
work; owner rulings on build scope live on their GitHub issues.

## Routing table

One read for who builds, who reviews, and who merges — per work type
(coordinator addition, 2026-11-09, issue #1698 comment 6757389470).
Most coordination stalls come from the same rule being read differently by
different agents; this table is the single read.

| Work type | Builder | Reviewer | Merger |
|---|---|---|---|
| Lane build | Assigned lane (Sunny lane 3 / Hammy lane 2) | The other builder lane | Coordinator |
| Campaign build | Assigned builder, per board #1714 | The other builder lane | Coordinator |
| Docs-only | Assigned lane | The other builder lane | Coordinator |
| Audit fix | Assigned lane, per chain | The other builder lane | Coordinator |
| Repair round | Lane owning the repair, named in the repair brief | The other builder lane | Coordinator |

Notes:

- The builder never merges. No PR merges on green checks alone without the recorded
  peer PASS on the exact head. Dale may merge anything, but routine PRs never wait
  for him to click merge. (Peer-review model, Dale 2026-11-01; `CLAUDE.md` "Merge gate".)
- Where the builder is a campaign surface rather than a lane, the reviewing lane is
  named in the assignment (precedent: PR #1703, Grok Build surface, reviewer Hammy).

## Authorization and pace

- **Assignment is authorization.** A coordinator assignment in Slack, or direction
  from Dale anywhere, is the authorization to start. No lane waits for a separate go,
  a watch rule, or a confirmation in its own chat. A lane that believes an owner gate
  applies (deploys, spend, credentials, schema changes, S4 cutover, Phase 5 entry,
  the CIL ruling) names the gate in the Slack thread and keeps building anything not
  gated. (Adopted 2026-11-03, issue #1650 rule 1.)
- **Handback authorization.** Assignment authorizes routine delivery communications
  (handbacks, verdicts, merge-card updates, merge reports) with no separate approval;
  content-bearing decisions reach Dale only across a named owner gate.
  (Astra finding 2, adopted verbatim 2026-11-05; disposition on issue #1650.)
- **Start-by and named blocker.** Every assignment carries an implicit start-by of the
  same working day. A lane that cannot start posts a named blocker instead. Silence
  is never a status. While an item is open, the lane posts a status at least every few
  hours during the day. (Adopted 2026-11-03, issue #1650 rule 2.)
- **Automatic named-blocker status.** A named-blocker status is posted automatically
  whenever a decision pends. (Adopted 2026-11-03, issue #1650 rule C.)
- **Named queue chains.** Assignments name the chain and blast radius (for example, a
  checker PR before the PR it unblocks), so dependencies are visible before they bite.
  (Adopted 2026-11-03, issue #1650 rule 3.)
- **Checker versus Dale's value.** When a checker rejects a value Dale set, the checker
  is fixed to accept it. Dale's value is never overridden or reverted to satisfy the
  checker. This is a narrow rule, not a blanket presumption that checkers are wrong.
  (Adopted 2026-11-03, issue #1650 rule 4.)
- **Assignment pre-check.** Before assigning any item, the coordinator reads the target
  issue's labels and gate text. If an owner gate exists, the assignment does not go
  out; the ruling question goes to Dale first, with the work sequenced behind the
  ruling. (Addendum 2, coordinator 2026-11-04, adopted by Dale the same day.)

## Review model and pace clocks

- **Peer-review model.** The two builder lanes review each other's work. The reviewer
  records the verdict as a GitHub comment and in the merge-card review block
  (Review outcome PASS or BLOCKING, Reviewer = the reviewing lane), on the exact
  reviewed head. The coordinator assigns the review, verifies the recorded PASS
  (exact head, green CI, mergeable), and merges; the coordinator does not review.
  (Effective 2026-11-01, Dale; `CLAUDE.md` "Peer-review model".)
- **Supersession.** The peer-review model in force since 2026-11-01 supersedes every
  earlier instruction in the brief and its companion documents that says the
  implementation agent merges under standing authority, that independent review is
  advisory, or that the required Atlas Contract / Systems Review is performed by
  ChatGPT or is triggered only by high-risk surfaces. Any surviving copy is
  superseded by this paragraph and must not be followed.
  (Astra review, adopted 2026-11-05; disposition on issue #1650.)
- **Review eligibility.** Anyone who implemented any part of a PR cannot supply its
  independent PASS. If no eligible independent reviewer exists, the coordinator
  records the capacity blocker and brings Dale a concrete recommendation. Self-review,
  role renaming, and coordinator code review remain prohibited.
  (Astra finding 3, adopted 2026-11-05; disposition on issue #1650.)
- **Review start-by.** Peer reviews carry an explicit start-by, the same as build
  assignments. The coordinator's ack of a handback names the review start-by
  (default: same working day); a reviewer who cannot meet it posts a named blocker
  before it passes. Per the pace-up directive, the review start-by is the reviewer's
  next queue check. When a reviewer begins a peer review, they post "started" in the
  review thread the same working day, so review state is visible before its start-by
  passes. (Addendum, coordinator 2026-11-04; reviewer started-post, practice addendum
  from the 2026-11-04 daily check-in, recorded 2026-11-05; pace-up, Dale 2026-11-06.)
- **Verdict-due.** Every review names a verdict-due as well as a start-by. The verdict
  is due 4 working hours (06:00–22:00 PT) after handback.
  (Astra finding 3, adopted 2026-11-05; pace-up, Dale 2026-11-06.)
- **Blockers and recovery.** A blocker names its resolution owner, next action, and
  next checkpoint. A missed deadline triggers a recorded recovery action at the next
  hourly check, not a repeated status.
  (Astra finding 3, adopted 2026-11-05; disposition on issue #1650.)
- **STUCK rule.** If blocked for more than 30 minutes, post `STUCK:` on the GitHub
  issue/PR. A stall watcher polls GitHub every 10 minutes for `STUCK:` comments and
  for PASSed-and-green PRs unmerged for more than 45 minutes; it surfaces only, never
  merges or acts. (Dale 2026-11-09 18:37 PT; location moved to the GitHub issue/PR by
  coordinator refinement 2026-11-09 18:58 PT.)
- **Late P0/P1 exception.** A newly discovered, evidenced P0/P1 in the named
  categories blocks merge whenever discovered, with the failure path recorded;
  advisory scope does not reopen.
  (Astra finding 5, adopted 2026-11-05; disposition on issue #1650.)
- **Merge within the hour; same-day deploy.** The coordinator merges within the hour
  a PASS lands. Deploys of green staged heads go same-day.
  (Pace-up, Dale 2026-11-06.)

## Head/base-pair evidence and merge routine

- **Single merger, sequential.** One merger (the coordinator) works ready PRs in
  sequence: update branch, diff-identical check, merge on green CI for the updated
  pair. (Merge routine amendment, Dale 2026-11-09.)
- **Diff-identical carry.** The check compares normalized added/removed lines per
  file; hunk positions and context shifts from base movement do not count as a
  changed diff. The review stands if the diff is identical and no conflict was
  hand-fixed. A changed diff or a hand-fixed conflict returns to the reviewer for
  delta-confirmation. (Merge routine amendment, Dale 2026-11-09; coordinator addition
  on issue #1698, 2026-11-09.)
- **Same-function glance guard.** A base move inside the same function a PR touches
  requires a reviewer one-line "glanced, carries" before merging. Different functions
  or no shared files: the diff-identical carry stands alone.
  (Coordinator refinement, 2026-11-09 18:58 PT.)
- **Auto-delta.** A PASSed PR whose base moved needs fresh CI on the new head/base
  pair. Peer delta-confirmation is needed only if the coordinator's overlap
  computation shows file overlap between the base delta and the PR's changed files.
  With zero overlap, the coordinator's overlap record replaces a human
  delta-confirmation. (Dale 2026-11-08 18:43 PT; first live use #1697, confirmed
  2026-11-08: no delta-confirmation was owed.)
- **Eligibility expires when either SHA changes.** A changed head needs a fresh review;
  the carry rules above are the only way a verdict survives a base move.
  (Head/base-pair practice, coordinator 2026-11-04, as amended 2026-11-08 and
  2026-11-09.)
- **Merge-queue / branch-protection machinery is deferred.** It brushes Dale's recorded
  #1572 deferral of branch protection ("not load-bearing now"); at two lanes the
  practice rules above cover the risk. Revisit if lane volume grows.
  (Astra finding 4, adopted in principle 2026-11-05; disposition on issue #1650.)

## Lane mechanics

- **Standing authority for routine posts.** A lane may post routine status,
  named-blocker, and ack posts in its own threads without a per-post approval.
  Handbacks, verdicts, merge-card updates, and merge reports are authorized by the
  assignment itself (see "Handback authorization" above); content-bearing decisions
  reach Dale only across a named owner gate.
  (Adopted 2026-11-03, issue #1650 rule A.)
- **Design calls at kickoff.** Test-input design calls are settled at slice kickoff,
  or delegated to builder plus coordinator in-thread. They never stall a build
  mid-slice. (Adopted 2026-11-03, issue #1650 rule B.)
- **Proven push path.** The push path is proven during lane setup, before the first
  build slice. (Adopted 2026-11-03, issue #1650 rule D.)
- **Persistent evidence paths.** Long-running evidence (E2E runs and similar) writes to
  a persistent path under `~/workspace/`, never `/tmp`.
  (Practice addendum from the 2026-11-04 daily check-in, recorded 2026-11-05.)
- **Local-complete / PR-not-landed note.** When a build is complete locally but its
  Draft PR has not landed by the next queue check, the builder posts a one-line note
  in its own thread naming the hold. This lets the reviewing lane distinguish "PR
  delayed, reason known" from "PR not started" without re-checking GitHub each cycle.
  (Practice addenda from the 2026-11-05 daily check-in, recorded 2026-11-05, and from
  the 2026-11-05 daily check-in, recorded 2026-11-06 — same rule, recorded twice;
  stated once here.)
- **Parked-card surfacing.** A lane run parked on a pending approval card surfaces
  that card — what it asks and when it was requested — in the channel immediately,
  not at the next queue check. The coordinator surfaces a parked card to Dale
  immediately — named card plus what it gates — instead of letting later runs queue
  silently behind it. (Addendum 5, Sunny's proposal adopted 2026-11-05, issue #1650
  comment 6667052401; coordinator form from the 2026-11-05 daily check-in, recorded
  2026-11-06.)
- **Deflake probe-change rule.** When a deflake item survives two clean full-suite runs
  without reproducing, the next diagnosis step changes the probe (longer stress,
  tightened timing, or a different load shape) instead of repeating the same evidence
  run. A third clean repeat adds no information.
  (Practice addenda from the 2026-11-05 daily check-in, recorded 2026-11-05, and from
  the 2026-11-05 daily check-in, recorded 2026-11-06 — same rule, recorded twice;
  stated once here.)
- **Collapse probe in adversarial pre-review.** For every normalization a fix
  introduces, add one test where the two collapsed inputs must produce different
  verdicts. (Practice addendum from the 2026-11-07 daily check-in cycle (2026-11-06 thread), recorded 2026-11-07.)
- **Refresh a moved base when the review starts.** Sequencing: review starts, then
  base-refresh CI runs in parallel, then delta-confirmation lands in the same check
  as the PASS when the verdict is PASS.
  (Practice addendum from the 2026-11-07 daily check-in cycle (2026-11-06 thread),
  recorded 2026-11-07.)
- **Merge-card Proof counts before handback.** The Proof section's exact-head counts
  must be filled before handback — no `[TO FILL]` placeholders left in Proof while
  counts live only in the Tests row or the Slack handback.
  (Practice addendum from the 2026-11-08 daily check-in, recorded 2026-11-08.)
- **Flake-red verdict names re-run owner and precondition.** When a review finds hosted
  E2E red on a classified unrelated flake, the verdict comment names the re-run owner
  and the exact precondition for merge (for example, green re-run, no code change),
  so merge sequencing does not stall ownerless.
  (Practice addendum from the 2026-11-08 daily check-in, recorded 2026-11-08.)
- **Docs-only PR filing check.** Docs-only PRs are filed with the standard merge card
  (Reviewer/outcome rows) and a primary risk label from the start.
  (Practice addendum from the 2026-11-09 daily check-in (collected from the 2026-11-08
  thread), recorded 2026-11-09.)
- **Split long local E2E runs by project up front.** For long local E2E runs, split by
  project up front rather than running the full suite in one process.
  (Practice tip, process check-in addendum 2026-11-10 (from the 2026-11-09 check-in
  thread); no gate, role, or schedule change.)

## Direction, rulings, and the board

- **Direction rides fresh posts.** Coordinator direction goes in new top-level channel
  posts, not inside threads whose reads trip the platform safety screen (the flagged
  threads stay signal-only via channel/search surfaces).
  (Addendum 2, coordinator 2026-11-04, adopted by Dale the same day.)
- **Rulings live on the issue.** Every owner ruling is written onto its GitHub issue
  the same hour, and any owner-decision label it lifts is removed with the ruling.
  Lanes verify rulings from the record, never from a relay.
  (Addendum 2, coordinator 2026-11-04, adopted by Dale the same day.)
- **Deploy notices.** After each production deploy, the coordinator posts a one-line
  top-level notice naming the live commit, so lane sessions do not run on a stale
  picture of production.
  (Addendum 2, coordinator 2026-11-04, adopted by Dale the same day.)
- **The board is the single source for campaign-builder assignments.** GitHub issue
  #1714 (coordinator-maintained) is the single source. If Slack, a chat relay, or an
  older brief disagrees with the board, the board wins. The coordinator updates the
  board first, then points anywhere else.
  (Coordinator rule, 2026-11-09, issue #1714 comment 6757624612.)
- **Claim convention.** When starting an item, post a comment on its issue (or on the
  board, naming the item) beginning `Taking: <item>`, so two builders never grab the
  same work. Handbacks stay on the item's own issue/PR as before. The lane also posts
  its claim in #atlas-workout-updater (a `started` post in the item's thread), per the
  standing queue-check job.
  (Coordinator rule, 2026-11-09, issue #1714 comment 6757624612; queue-check job set
  by Cheri, 2026-11-04.)

## Work in progress and record hygiene

- **WIP cap.** A lane does not open a third PR while two of its PRs await the peer
  lane's review. Peer reviews come before new builds.
  (Adopted 2026-11-03, issue #1650 rule 5.)
- **Closing keywords and manual close.** Every PR body carries `Fixes #N` /
  `Closes #N` for each issue it completes. The keyword creates the link and the
  merge reference — but it does not auto-close the issue: GitHub fires closing
  keywords only on merges into the repository's default branch, and the live line is
  the non-default `s3-maintenance`. The coordinator closes each completed issue
  manually with a reconciliation note at merge.
  (Rule 6, adopted 2026-11-03; manual-close diagnosis 2026-11-05: PRs #1651–#1655
  all carried valid keywords and merged into `s3-maintenance`; all five issues were
  closed manually by the coordinator. No template or placement change can make
  auto-close fire on this branch.)
- **Early draft visibility.** Within the first working session on an item, the lane
  pushes its branch and opens the Draft PR (WIP state is fine), so work-in-progress
  is visible on the GitHub record, not only on the lane's machine.
  (Adopted 2026-11-03, issue #1650 rule 7.)

## Deploy practice

- Deploys go in small trains (1–3 PRs with product changes) on Dale's per-deploy
  approval. The coordinator brings the ask with the merge report instead of letting
  batches accumulate. (Adopted 2026-11-03, issue #1650 rule 8.)

## Lane checks and heartbeat

- **Queue-check cadence.** Lane queue checks run every 2 hours on the 06:00–22:00 PT
  grid. Reviews come first: if any open PR names the lane as reviewer and no verdict
  is recorded on its exact current head, the review is performed before any build
  work. Every in-window check posts a short status (what was done, or the named
  blocker with its owner) and includes a stalls/roadblocks line naming any needed
  permission or approval and its owner, or explicitly stating none.
  (Standing job set by Cheri, 2026-11-04.)
- **Sweep watch.** A 20-minute watch reads Slack threads, lane PRs and CI, persona
  issues, and `s3-maintenance` head movement, and reports only actionable changes.
  (Dale, 2026-10-30.)
- **Heartbeat.** Every lane queue check posts one fixed line in-channel:
  `<Lane> check HH:MM: <state>: <item/PR + stage>`. Silence past a check window reads
  as session-down; the same item and stage twice reads as stuck.
  (Dale, 2026-11-08 18:43 PT; adopted from the 20:00 PT queue check.)
- **Daily process check-in.** Dale posts a daily check-in; both lanes reply in its
  thread with (1) current blockers, named and specific, or explicitly none, and
  (2) a process refinement only if something actually went wrong. "No refinement" is
  the expected answer on a clean day. (Check-in practice from 2026-11-05; narrowed
  by Dale 2026-11-08; confirmed in the 2026-11-09 practice addendum.)

## Supersessions applied

Dated adoptions that replace an earlier form. Each is applied in place above; this
list exists so a later reader can verify nothing was silently picked.

- **Head/base-pair evidence (2026-11-08 auto-delta, 2026-11-09 merge routine).**
  Replaces the 2026-11-04 practice "fresh CI plus a peer delta-confirmation after any
  base move". The `CLAUDE.md` standing-rules paragraph stating the 2026-11-04 form is
  now stale; this file is the current form.
- **STUCK location (2026-11-09 18:58 PT).** The coordinator refinement moves STUCK
  posts to the GitHub issue/PR, superseding Dale's 2026-11-09 18:37 PT top-level Slack
  location. The 30-minute trigger is unchanged.
- **Closing keywords (2026-11-05 diagnosis).** The 2026-11-03 rule as written implies
  auto-close; the diagnosis corrects it: keywords do not auto-close on
  `s3-maintenance`, so the coordinator closes manually.
- **Handback authorization (2026-11-05).** Assignment authorizes routine delivery
  communications, superseding rule A's "handbacks still ride the normal approval
  path" clause for handbacks, verdicts, merge-card updates, and merge reports.
- **Duplicate recordings stated once.** The deflake probe-change rule and the
  local-complete / PR-not-landed note were each recorded twice (2026-11-05 and
  2026-11-06 check-in addenda); each is stated once above with both sources.

Deliberately not in this file: per-issue build-scope rulings (for example the #1635
duration-only ruling, the #1565 build ruling, the CIL kill ruling) — those live on
their issues per "Rulings live on the issue" above. The 2026-11-09 E2E-failure
classification proposal (failing spec names in the check-run summary) was recorded
as a proposal, not adopted as a rule, and is not stated here.
