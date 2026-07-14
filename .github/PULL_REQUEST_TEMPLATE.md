<!--
Atlas Merge Card — fill every field. Empty, stale, skipped, errored, unavailable,
or incomplete required signals are failures. Routine PRs are merge-authorized
only after every hard gate passes and the cold review clears; owner-reserved PRs
stop for Dale.
-->

## 🟦 Atlas Merge Card

| Field                             | Value                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| **PR**                            | #<!-- number, filled after open -->                                                |
| **Title**                         | <!-- one line -->                                                                  |
| **Risk level**                    | <!-- low / medium / high -->                                                       |
| **Files / categories touched**    | <!-- e.g. docs-only · governance -->                                               |
| **Tests / checks**                | <!-- command/check + result; not-run = FAIL when required -->                      |
| **Cold review**                   | <!-- clean-context reviewer + exact head SHA + no P0/P1 / findings resolved; trivial-docs-only = n/a --> |
| **ChatGPT Atlas Contract Review** | <!-- risk-triggered: READY FOR DALE MERGE / NON-BLOCKING / BLOCKING / not required for routine --> |
| **Owner action required**         | <!-- No (routine) · or Yes + reserved criterion -->                                |
| **Live test script**              | <!-- steps for Dale if needed, else n/a -->                                        |
| **Merge authority**               | <!-- Claude may routine-merge / fix-then-review / hold-for-Dale -->                |

<!--
Cold-review rule: before any non-trivial PR merges, a fresh clean-context Claude
reviewer reviews the exact final diff (base SHA, final head SHA, PR description,
diff, changed tests, relevant governance, CI results). Any push after a blocking
finding requires one fresh cold review of the new head. Native Codex GitHub Review
is retired as a gate; a Codex auto-comment is advisory only. The cold review and
the ChatGPT Atlas Contract Review are distinct; the ChatGPT review is
risk-triggered. Never merge when required checks or the current-head cold review
are missing, stale, skipped, errored, failed, or incomplete.
-->

---

### Concern (one per PR)

<!-- One sentence: the single concern this PR addresses. If it grew, split it. -->

### Current-state verdict

<!-- STILL BROKEN / ALREADY FIXED / PARTIALLY FIXED / FIXED BUT UNTESTED / STALE-SUPERSEDED / NEEDS OWNER APP-TEST -->

### Vision alignment

<!-- Principle advanced · smallest safe step · invariant protected · user-facing trust change yes/no -->

### Trust / scope safety

- [ ] No product behavior change (or explicitly scoped and approved)
- [ ] No write-path change (or explicitly scoped and approved)
- [ ] No Sheet schema change (12-col Log_Cleaned / 9-col Effort / 5-col Constraints / 7-col Deload_State / 13-col Session_Plans)
- [ ] No approval-gate / trust-contract change (or explicitly scoped and approved)
- [ ] No roadmap/vision reorder (or explicitly scoped and approved)
- [ ] One concern only; no future roadmap work bundled
- [ ] Routine merge authority applies only if every gate passes; owner-reserved
      changes stop for Dale

### Tests run

<!-- command/check + result; include live path or closest integration evidence -->
