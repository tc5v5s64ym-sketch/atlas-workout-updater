<!--
  Atlas Merge Card.

  merge-card-check validates mechanical facts only: required rows are filled,
  the current-state verdict has a closed opening, and a required architecture
  review records PASS on this exact head. It does not interpret prose, scope,
  negation, findings, backlog disposition, or review quality.
-->

## 🟦 Atlas Merge Card

| Field | Value |
|---|---|
| **Canonical plan card** | <!-- card or recorded owner instruction --> |
| **Title** | <!-- one line --> |
| **Primary risk** | <!-- one primary label + low/medium/high --> |
| **Files / categories touched** | <!-- concise --> |
| **Current-state verdict** | <!-- OPEN with STILL BROKEN / ALREADY FIXED / PARTIALLY FIXED / FIXED BUT UNTESTED / STALE-SUPERSEDED / NEEDS OWNER APP-TEST; then current-main evidence --> |
| **Builder surface** | <!-- the tool this work ran on --> |
| **Primary builder model** | <!-- the exact displayed model name; if withheld, say so --> |
| **Supporting / explore models** | <!-- each other model and role, or None --> |
| **Architecture / dispatch authority** | <!-- normally ChatGPT --> |
| **Authority impact** | <!-- winner, loser, bridge/sunset; or none --> |
| **Tests / hard gates** | <!-- exact commands and results --> |
| **Advisory audit** | <!-- not run / one pass with dispositions / second pass with its high-severity or systemic reason --> |
| **Owner authorization required** | <!-- No, or exact reserved category and status --> |
| **Live validation** | <!-- evidence/script needed, or N/A --> |
| **Merge authority** | <!-- active builder merges exact passing head / blocked on owner authorization --> |

### Concern

<!-- One independently provable outcome. -->

### Current-state evidence

<!-- Source, duplicate/stale search, exact current-main evidence, and smallest allowed action. -->

### What changed

<!-- Focused summary. -->

### Product and trust safety

- [ ] No unrelated product behavior change
- [ ] No unapproved production-write behavior change
- [ ] No unapproved Supabase/Sheet schema, migration, cutover, or data rewrite
- [ ] No approval, proof, parser, deterministic-decision, or invariant change unless explicitly authorized
- [ ] No secret, `.env`, production ID, or private workout evidence
- [ ] One authority per concept; any bridge has an exact sunset
- [ ] One concern only

### Proof

<!--
  Exact deterministic commands and results. Include the closest integration or
  live-path proof required by the changed risk surface.
-->

### Reviewer guidance — scope and closure

<!--
  These are reviewer questions, not machine-parsed fields:

  - Is this one outcome with explicit non-goals?
  - Does one authority win, with any loser removed or given an exact sunset?
  - Is the live consumer named and is the proof level correct?
  - Is temporary machinery removed or tied to an exact retirement condition?

  Keep answers concise. Do not count review rounds or open loops.
-->

### Atlas Contract / Systems Review

<!--
  CLAUDE.md owns the narrow trigger list and review protocol.

  The blocking question is: Is this exact head unsafe or architecturally wrong
  to merge? Improvement ideas belong in the optional advisory audit.

  On follow-up, verify the named blocker fixes and the high-risk surface changed
  by those fixes. Do not reopen the whole artifact for unlimited new findings.

  Closed forms enforced by CI:
  - Required opens REQUIRED or NOT REQUIRED.
  - REQUIRED: exact current 40-character head, Reviewer ChatGPT, outcome PASS.
  - NOT REQUIRED: head, reviewer, and outcome are each N/A.
-->

- **Required**: <!-- REQUIRED — trigger; or NOT REQUIRED — why no high-risk trigger fired -->
- **Exact reviewed head**: <!-- 40-character SHA, or N/A -->
- **Reviewer**: <!-- ChatGPT, or N/A -->
- **Review outcome**: <!-- PASS, BLOCKING, or N/A -->
- **Findings and fix verification**: <!-- blockers and dispositions; follow-up verification; none; or N/A -->

### Additional findings

<!--
  Optional record. Fix a real in-scope safety/correctness defect. Route an
  adjacent improvement without widening this PR. If backlog membership changes,
  briefly name what entered and what left. CI does not parse this prose.
-->

### Non-goals and known uncertainty

<!-- What this does not do, what remains uncertain, and what would settle it. -->

### Post-merge

<!-- Main/deployment verification, plan update, and next eligible campaign item. -->
