<!--
Atlas Merge Card — complete every field. Missing, stale, skipped, errored,
unavailable, or incomplete required GitHub checks are failures. Independent agent
review comments are advisory; no separate review status, reviewer account, marker,
or owner merge click is required for a routine authorized PR.
-->

## 🟦 Atlas Merge Card

| Field | Value |
|---|---|
| **PR** | #<!-- number --> |
| **Canonical plan card** | <!-- F## or explicit owner instruction --> |
| **Title** | <!-- one line --> |
| **Primary risk** | <!-- one label + low/medium/high --> |
| **Files / categories touched** | <!-- concise --> |
| **Current-state verdict** | <!-- STILL BROKEN / ALREADY FIXED / PARTIALLY FIXED / FIXED BUT UNTESTED / STALE-SUPERSEDED / NEEDS OWNER APP-TEST --> |
| **Tests / hard gates** | <!-- exact commands/checks + results --> |
| **Advisory findings** | <!-- independent agent/optional clean review: fixed / non-issue / none --> |
| **Atlas Contract / Systems Review** | <!-- required (name the trigger) / not required (say why) — see the block below --> |
| **Owner authorization required** | <!-- No, or exact reserved category and status --> |
| **Live validation** | <!-- evidence/script needed, or n/a --> |
| **Merge authority** | <!-- active builder merges exact passing head / blocked on owner authorization --> |

---

### Concern

<!-- One sentence. One PR equals one concern. -->

### Current-state evidence

<!-- Source card/finding, duplicate/stale search, exact file/function/test/PR evidence, and smallest allowed action. -->

### Vision and trust alignment

<!-- Principle advanced · why this is the smallest safe step · invariants checked · user-facing trust effect. -->

### What changed

<!-- Focused summary. -->

### Trust / scope safety

- [ ] No unrelated product behavior change
- [ ] No unapproved production-write behavior change
- [ ] No unapproved Sheet schema/migration/data rewrite
- [ ] No approval-gate, proof-field, parser-contract, or invariant change unless explicitly authorized
- [ ] No secret, `.env`, production Sheet ID, or private workout evidence
- [ ] One concern only; adjacent discoveries filed without expanding this PR
- [ ] Canonical plan card and completion record updated where appropriate

### Tests and evidence

<!-- Commands, deterministic CI, live/closest-integration proof, and deployed validation when applicable. -->

### Additional findings

<!--
Owner ruling 2026-07-30, final form 2026-07-31 — bounded backlog ledger. Every finding
discovered while doing this work gets exactly one disposition. Keep only the lines that apply.
GitHub Issues are not a parallel backlog.

ADDED TO BOUNDED BACKLOG requires the three declaration lines below it: BACKLOG.md has fixed
capacity, so an added item must be paid for by removing, archiving, or promoting existing
content. Name what went in, what came out, and the resulting counts — the guard checks the
numbers, review checks that the removal was honest. Fill "counts:" in the form
`items 282 → 282 · lines 787 → 787 · cap 787 → 787`.
-->

- None
- FIXED NOW:
- REJECTED:
- ADDED TO BOUNDED BACKLOG:
  - added:
  - removed/archived/promoted:
  - counts:
- OWNER DECISION REQUIRED:

### Architecture and closed-loop impact

<!--
Closed-Loop Delivery Contract (CLAUDE.md): Purpose → Authority → Integration → Proof →
Cleanup → Closure. Current authority per concept is in docs/ATLAS_SYSTEM_AUTHORITY.md.
A foundation PR is progress, not completion. Net open-loop change is normally zero or
negative; a positive result needs an explicit owner-approved reason and a closure chain.
Write "n/a" on a line that genuinely does not apply.
-->

- Defect classification: <!-- local defect / authority defect / missing capability -->
- Parent product/phase outcome:
- Loop this PR closes:
- Current live authority:
- Intended sole authority:
- Competing authority removed:
- Exact live consumer:
- Integration proof: <!-- unit / integration / browser-full-session / owner evidence -->
- Temporary artifacts introduced:
- Compatibility bridge:
- Sunset/removal condition:
- Production branches added:
- Production branches removed:
- Displaced code/tests/docs removed:
- Open loops closed:
- Open loops created:
- Net open-loop change:
- Parent status after PR: <!-- foundation / integrated / proven / closed -->
- Why the parent is or is not fully closed:
- Owner-approved reason if complexity or open loops increase:

### Atlas Contract / Systems Review

<!--
Owner instruction 2026-08-03, recorded in docs/ATLAS_V1_EXECUTION_PLAN.md. The ONE existing
review lane — no second review system, no CI status, no reviewer account, no marker.

Required when this PR touches: campaign gates · scorecards and counters · adjudicators ·
rehearsal or test runners · evidence collectors · identity and correlation machinery · phase or
count advancement · trust-sensitive write, schema, security, promotion, or destructive changes.
Also required for phase transitions, roadmap changes, product/trust-contract changes, and genuine
ambiguity. ChatGPT performs this review (owner ruling 2026-08-03) — an implementation agent may
not satisfy its own architecture gate, so a clean-context agent review goes under "Advisory
disposition" and never here. The reviewer reads the EXACT head; an earlier commit does not count,
so a push after the review means the review must be repeated.

The review asks: (1) does this hold in the next legitimate repository state, not only the current
fixture? (2) can missing, no-op, defaulted, circular, or hardcoded evidence produce a false green?
(3) does the proof establish identity, content, order, and authority — not cardinality alone?
(4) does it remain correct when historical records coexist with current state? (5) what authority
wins, what loses, what bridge remains, and when is it removed? (6) could this falsely advance a
count or phase? (7) what temporary machinery must be deleted?
-->

- Required: <!-- required (name the trigger) / not required (say why no trigger fired) -->
- Exact reviewed head: <!-- full 40-character commit SHA, or n/a -->
- Reviewer: <!-- who performed the required review, or n/a -->
- Findings and dispositions: <!-- each finding + fixed / non-issue / routed, or "none", or n/a -->

### Advisory disposition

<!-- List each real finding and fix, each false alarm and rationale, or “none.” -->

### Post-merge

<!-- Main/deploy verification, card update, and next eligible campaign item. -->
