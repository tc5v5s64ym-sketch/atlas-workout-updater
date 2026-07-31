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
| **ChatGPT Atlas Contract Review** | <!-- NON-BLOCKING / READY / BLOCKING / not risk-triggered --> |
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
Owner ruling 2026-07-30 (corrected 2026-07-31) — backlog intake is closed and GitHub Issues
are not a replacement backlog. Every finding discovered while doing this work gets exactly one
disposition. "Add to BACKLOG" and "file it as an issue" are not dispositions. Keep only the
lines that apply. OWNER DECISION REQUIRED means stop and report it to the owner — it creates
no issue, no backlog line, and no execution-plan entry unless the owner selects it.
-->

- None
- FIXED NOW:
- REJECTED:
- OWNER DECISION REQUIRED:

### Advisory disposition

<!-- List each real finding and fix, each false alarm and rationale, or “none.” -->

### Post-merge

<!-- Main/deploy verification, card update, and next eligible campaign item. -->
